import { address, type KeyPairSigner } from "@solana/kit";
import { SUBLY_VAULT } from "../config/constants.js";
import { deriveAssociatedTokenAddress } from "../lib/associated-token-account.js";
import { evaluatePaymentBudget } from "../domain/budget.js";
import type { WalletPosition } from "../domain/models.js";
import type { KaminoVaultAdapter } from "../kamino/vault-adapter.js";
import type { SolanaRpc } from "../solana/rpc.js";
import type { TransactionSubmissionEngine } from "../solana/submission.js";
import { buildVersionedTransaction } from "../solana/tx.js";
import type { YieldRealizer } from "./standard-x402-payer.js";

/**
 * Local, backend-free yield realizer for the standard-x402 buyer path. When
 * the agent's USDC ATA cannot cover a payment, it redeems just enough Kamino
 * vault YIELD (never principal) into that ATA as a standalone transaction the
 * sponsor pays the fee for — so the agent still needs no SOL.
 *
 * This is intentionally NOT the atomic redeem+transfer of the retired
 * `subly-yield-exact` scheme: PayAI's `exact` verifier forbids extra
 * instructions, so realize must be its own transaction (see
 * standard-x402-payer.ts).
 *
 * Reuses the existing chain layer: KaminoVaultAdapter (quote + withdraw
 * instructions), evaluatePaymentBudget (principal invariant + spendable
 * yield), buildVersionedTransaction, and TransactionSubmissionEngine.
 */

/**
 * The accounting state the buyer cannot read from chain alone. Principal basis
 * (how much was deposited) is what separates spendable yield from principal;
 * it must come from a local ledger, the deposit record, or config.
 */
export interface PositionBasis {
  principalBasisRawUsdc: bigint;
  reservedRawUsdc?: bigint;
  feeDebtRawUsdc?: bigint;
  safetyBufferRawUsdc?: bigint;
}

export class YieldRealizeError extends Error {
  constructor(
    readonly code:
      | "insufficient_yield"
      | "budget_illiquid"
      | "invalid_exchange_rate"
      | "post_state_principal_invariant_failed"
      | "realize_not_landed",
    message: string,
    readonly detail: unknown = null
  ) {
    super(message);
    this.name = "YieldRealizeError";
  }
}

export interface LocalSponsorYieldRealizerConfig {
  rpc: SolanaRpc;
  vaultAdapter: KaminoVaultAdapter;
  engine: TransactionSubmissionEngine;
  /** Owner of the vault shares and USDC ATA; signs the withdraw. */
  agent: KeyPairSigner;
  /** Fee payer + rent payer for the realize transaction (no agent SOL needed). */
  sponsor: KeyPairSigner;
  /** Supplies principal basis and any reservations for budget evaluation. */
  loadBasis: () => Promise<PositionBasis>;
  /** Overhead reserved on top of the shortfall (fee debt). Default 0.0025 USDC. */
  overheadRawUsdc?: bigint;
  usdcMint?: string;
}

const DEFAULT_OVERHEAD_RAW_USDC = 2_500n;

export class LocalSponsorYieldRealizer implements YieldRealizer {
  private readonly config: LocalSponsorYieldRealizerConfig;
  private readonly usdcMint: string;
  private readonly overheadRawUsdc: bigint;

  constructor(config: LocalSponsorYieldRealizerConfig) {
    this.config = config;
    this.usdcMint = config.usdcMint ?? SUBLY_VAULT.usdcMint;
    this.overheadRawUsdc = config.overheadRawUsdc ?? DEFAULT_OVERHEAD_RAW_USDC;
  }

  async ensureUsdcAvailable(input: {
    amountRawUsdc: bigint;
  }): Promise<{ realizedRawUsdc: bigint; txSignature: string | null }> {
    const agentAta = deriveAssociatedTokenAddress({
      owner: this.config.agent.address,
      mint: this.usdcMint
    });

    const currentBalance = await this.readTokenBalance(agentAta);
    if (currentBalance >= input.amountRawUsdc) {
      return { realizedRawUsdc: 0n, txSignature: null };
    }
    const shortfallRawUsdc = input.amountRawUsdc - currentBalance;

    const context = await this.config.vaultAdapter.loadContext();
    const userShares = await this.config.vaultAdapter.getUserSharesRaw(
      this.config.agent.address,
      context
    );
    const quote = this.config.vaultAdapter.quoteSettlementWithdraw(
      shortfallRawUsdc,
      context
    );

    const basis = await this.config.loadBasis();
    const position = this.buildPosition(context, userShares, basis);
    const evaluation = evaluatePaymentBudget({
      position,
      sellerAmountRawUsdc: shortfallRawUsdc,
      estimatedFeeDebtRawUsdc: this.overheadRawUsdc,
      requiredWithdrawRawUsdc: quote.requiredWithdrawRawUsdc
    });
    if (!evaluation.ok) {
      throw new YieldRealizeError(
        evaluation.code,
        `cannot realize ${shortfallRawUsdc} raw USDC from yield: ${evaluation.code}`,
        evaluation.details
      );
    }

    const instructions =
      await this.config.vaultAdapter.buildNormalWithdrawInstructions({
        wallet: this.config.agent.address,
        sharesToRedeemRaw: quote.sharesToRedeemRaw,
        context,
        rentPayer: this.config.sponsor.address
      });

    const built = await buildVersionedTransaction({
      feePayer: this.config.sponsor.address,
      blockhash: context.blockhash,
      lastValidBlockHeight: context.lastValidBlockHeight,
      instructions,
      lookupTables: await this.config.vaultAdapter.loadLookupTables(context),
      partialSigners: [
        this.config.agent.keyPair,
        this.config.sponsor.keyPair
      ]
    });

    const txSignature = await this.submitAndConfirm(built.serializedBase64, {
      lastValidBlockHeight: Number(context.lastValidBlockHeight)
    });

    const landed = await this.config.engine.lookupTransaction(txSignature);
    if (!landed.found || landed.err !== null) {
      throw new YieldRealizeError(
        "realize_not_landed",
        `yield realize transaction ${txSignature} did not land successfully`,
        landed
      );
    }
    const realizedRawUsdc = landed.tokenBalanceDeltas.get(agentAta) ?? 0n;

    return { realizedRawUsdc, txSignature };
  }

  private async submitAndConfirm(
    serializedBase64: string,
    params: { lastValidBlockHeight: number }
  ): Promise<string> {
    const simulation =
      await this.config.engine.simulateSignedTransaction(serializedBase64);
    if (simulation.err !== null) {
      throw new YieldRealizeError(
        "realize_not_landed",
        `yield realize simulation failed: ${JSON.stringify(simulation.err)}`,
        simulation
      );
    }
    const txSignature =
      await this.config.engine.sendSignedTransaction(serializedBase64);
    const confirmation = await this.config.engine.waitForConfirmation({
      txSignature,
      lastValidBlockHeight: params.lastValidBlockHeight
    });
    if (confirmation.status !== "confirmed") {
      throw new YieldRealizeError(
        "realize_not_landed",
        `yield realize did not confirm (${confirmation.status})`,
        confirmation
      );
    }
    return txSignature;
  }

  private buildPosition(
    context: Awaited<ReturnType<KaminoVaultAdapter["loadContext"]>>,
    userShares: Awaited<ReturnType<KaminoVaultAdapter["getUserSharesRaw"]>>,
    basis: PositionBasis
  ): WalletPosition {
    // evaluatePaymentBudget only reads the numeric position fields below; the
    // rest are filled to satisfy the type without a full ledger record.
    return {
      wallet: this.config.agent.address,
      vault: this.config.vaultAdapter.vaultAddress,
      signingPolicyId: null,
      signingMode: "non_interactive",
      signerValidationMode: "structured_intent_transaction",
      signerProvider: "local",
      stakedSharesRaw: userShares.stakedSharesRaw,
      unstakedSharesRaw: userShares.unstakedSharesRaw,
      totalSharesRaw: userShares.totalSharesRaw,
      exchangeRateScaled: context.exchangeRateScaled,
      instantRedeemCapacityRawUsdc: context.instantRedeemCapacityRawUsdc,
      principalBasisRawUsdc: basis.principalBasisRawUsdc,
      principalBasisSource: "manual_trusted_seed",
      reservedRawUsdc: basis.reservedRawUsdc ?? 0n,
      feeDebtRawUsdc: basis.feeDebtRawUsdc ?? 0n,
      safetyBufferRawUsdc: basis.safetyBufferRawUsdc ?? 0n,
      kaminoPositionSnapshot: [],
      kaminoPnlSnapshot: [],
      lastSyncedSlot: null,
      version: 0,
      status: "active"
    } as WalletPosition;
  }

  private async readTokenBalance(ata: string): Promise<bigint> {
    try {
      const response = await this.config.rpc
        .getTokenAccountBalance(address(ata), { commitment: "confirmed" })
        .send();
      return BigInt(response.value.amount);
    } catch {
      // Missing/uninitialized ATA reads as zero available balance.
      return 0n;
    }
  }
}
