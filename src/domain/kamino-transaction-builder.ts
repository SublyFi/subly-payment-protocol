import {
  getSetComputeUnitLimitInstruction,
  getSetComputeUnitPriceInstruction
} from "@solana-program/compute-budget";
import { getAddMemoInstruction } from "@solana-program/memo";
import { getCreateAccountInstruction } from "@solana-program/system";
import {
  getCloseAccountInstruction,
  getInitializeAccount3Instruction,
  getTransferCheckedInstruction,
  TOKEN_PROGRAM_ADDRESS
} from "@solana-program/token";
import {
  address,
  createNoopSigner,
  generateKeyPairSigner,
  lamports,
  type Address,
  type Base64EncodedWireTransaction,
  type Instruction
} from "@solana/kit";
import { RATE_SCALE, SUBLY_VAULT, USDC_DECIMALS } from "../config/constants.js";
import {
  KaminoVaultAdapter,
  VaultLiquidityError,
  type UserSharesRaw,
  type VaultContext
} from "../kamino/vault-adapter.js";
import { ceilDiv, maxBigInt } from "../lib/raw-units.js";
import type { SolanaRpc } from "../solana/rpc.js";
import {
  buildVersionedTransaction,
  signatureBase58ForSigner
} from "../solana/tx.js";
import { conflict, SublyError, unavailable } from "./errors.js";
import type {
  CanonicalPaymentSettlementInput,
  CanonicalTransactionBuilder,
  PreparedSettlementTransaction,
  SettlementQuote,
  SettlementWithdrawQuoteInput
} from "./transaction-builder.js";

const TOKEN_ACCOUNT_SIZE = 165n;
/**
 * Extra shares the signer may approve above the exact quote so the probe loop
 * can absorb sub-unit exchange-rate movement between quote and prepare.
 */
const SHARES_TO_REDEEM_MARGIN = 4n;

export interface KaminoTransactionBuilderConfig {
  computeUnitLimit: number;
  computeUnitPriceMicroLamports: bigint;
  /** Cached vault context lifetime; quote and prepare must observe one state. */
  contextTtlMs: number;
}

const DEFAULT_CONFIG: KaminoTransactionBuilderConfig = {
  computeUnitLimit: 1_000_000,
  computeUnitPriceMicroLamports: 1n,
  contextTtlMs: 5_000
};

interface CachedContext {
  context: VaultContext;
  userShares: Map<string, UserSharesRaw>;
  loadedAtMs: number;
}

export class KaminoCanonicalTransactionBuilder
  implements CanonicalTransactionBuilder
{
  private readonly rpc: SolanaRpc;
  private readonly adapter: KaminoVaultAdapter;
  private readonly config: KaminoTransactionBuilderConfig;
  private cached: CachedContext | null = null;
  private rentLamportsForTokenAccount: bigint | null = null;

  constructor(params: {
    rpc: SolanaRpc;
    adapter: KaminoVaultAdapter;
    config?: Partial<KaminoTransactionBuilderConfig>;
  }) {
    this.rpc = params.rpc;
    this.adapter = params.adapter;
    this.config = { ...DEFAULT_CONFIG, ...params.config };
  }

  async quoteSettlementWithdraw(
    input: SettlementWithdrawQuoteInput
  ): Promise<SettlementQuote> {
    if (input.vault !== SUBLY_VAULT.address) {
      throw conflict("unsupported_vault", "Unsupported Kamino vault");
    }

    const { context, userShares } = await this.loadFreshContext(input.wallet);

    let quote;
    try {
      quote = this.adapter.quoteSettlementWithdraw(input.amountRawUsdc, context);
    } catch (error) {
      throw mapLiquidityError(error);
    }

    return {
      requiredWithdrawRawUsdc: quote.requiredWithdrawRawUsdc,
      // The signer-approved maximum includes a small margin for the probe
      // loop; the canonical transaction burns the smallest amount that covers
      // the seller payment at the prepare-time exchange rate.
      sharesToRedeemRaw: quote.sharesToRedeemRaw + SHARES_TO_REDEEM_MARGIN,
      withdrawalPenaltyRawUsdc: quote.withdrawalPenaltyRawUsdc,
      exchangeRateScaled: context.exchangeRateScaled,
      instantRedeemCapacityRawUsdc: context.instantRedeemCapacityRawUsdc,
      userStakedSharesRaw: userShares.stakedSharesRaw,
      userUnstakedSharesRaw: userShares.unstakedSharesRaw,
      userTotalSharesRaw: userShares.totalSharesRaw,
      observedSlot: Number(context.slot)
    };
  }

  async preparePaymentSettlement(
    input: CanonicalPaymentSettlementInput
  ): Promise<PreparedSettlementTransaction> {
    if (input.feePayer === null) {
      throw unavailable(
        "sponsor_fee_payer_not_configured",
        "The Subly sponsor fee payer must be configured to build settlement transactions"
      );
    }

    const sponsor = address(input.feePayer);
    const agent = address(input.wallet);
    const usdcMint = address(input.usdcMint);
    const sellerUsdcAta = address(input.sellerUsdcAta);
    const dustRecipientUsdcAta = address(input.dustRecipientUsdcAta);

    const { context, userShares } = await this.loadFreshContext(input.wallet);
    await this.assertSettlementAccountsExist({
      sellerUsdcAta,
      dustRecipientUsdcAta,
      userShares
    });

    const temp = await generateKeyPairSigner();
    const rentLamports = await this.tokenAccountRent();
    const lookupTables = await this.adapter.loadLookupTables(context);

    // The signer approves at most input.sharesToRedeemRaw; the canonical
    // transaction burns the smallest share amount whose simulated output
    // covers the seller amount so the dust sweep stays minimal (usually 0).
    let exactQuote;
    try {
      exactQuote = this.adapter.quoteSettlementWithdraw(
        input.amountRawUsdc,
        context
      );
    } catch (error) {
      throw mapLiquidityError(error);
    }
    let sharesToRedeemRaw =
      exactQuote.sharesToRedeemRaw < input.sharesToRedeemRaw
        ? exactQuote.sharesToRedeemRaw
        : input.sharesToRedeemRaw;

    let sharedPrefixInstructions: Instruction[] | null = null;
    let withdrawOutputRawUsdc: bigint | null = null;
    let lastProbeFailure: { err: unknown; logs: readonly string[] | null } | null =
      null;
    for (let attempt = 0; attempt < 4; attempt += 1) {
      let withdrawInstructions;
      try {
        withdrawInstructions =
          await this.adapter.buildSettlementWithdrawInstructions({
            wallet: input.wallet,
            settlementTokenAccount: temp.address,
            sharesToRedeemRaw,
            grossWithdrawRawUsdc: input.requiredWithdrawRawUsdc,
            userShares,
            context
          });
      } catch (error) {
        throw mapLiquidityError(error);
      }

      const candidatePrefix: Instruction[] = [
        getSetComputeUnitLimitInstruction({ units: this.config.computeUnitLimit }),
        getSetComputeUnitPriceInstruction({
          microLamports: this.config.computeUnitPriceMicroLamports
        }),
        getCreateAccountInstruction({
          payer: createNoopSigner(sponsor),
          newAccount: temp,
          lamports: lamports(rentLamports),
          space: TOKEN_ACCOUNT_SIZE,
          programAddress: TOKEN_PROGRAM_ADDRESS
        }),
        getInitializeAccount3Instruction({
          account: temp.address,
          mint: usdcMint,
          owner: agent
        }),
        ...withdrawInstructions.unstakeIxs,
        withdrawInstructions.withdrawIx
      ];

      // Probe simulation: measure the exact withdraw output that lands in the
      // temporary account at the current slot so the dust sweep amount can be
      // fixed in the canonical message.
      const probe = await buildVersionedTransaction({
        feePayer: sponsor,
        blockhash: context.blockhash,
        lastValidBlockHeight: context.lastValidBlockHeight,
        instructions: candidatePrefix,
        lookupTables
      });
      const probeResult = await this.simulate(probe.serializedBase64, [
        temp.address
      ]);
      if (probeResult.err !== null) {
        lastProbeFailure = { err: probeResult.err, logs: probeResult.logs };
        break;
      }
      const output = probeResult.tokenAmounts.get(temp.address) ?? null;
      if (output === null) {
        throw conflict(
          "simulation_failed",
          "Settlement probe simulation did not return the temporary account state"
        );
      }
      if (output >= input.amountRawUsdc) {
        sharedPrefixInstructions = candidatePrefix;
        withdrawOutputRawUsdc = output;
        break;
      }

      const deficit = input.amountRawUsdc - output;
      const bump = maxBigInt(
        1n,
        ceilDiv(deficit * RATE_SCALE, context.exchangeRateScaled)
      );
      if (sharesToRedeemRaw + bump > input.sharesToRedeemRaw) {
        break;
      }
      sharesToRedeemRaw += bump;
    }

    if (lastProbeFailure !== null) {
      throw conflict(
        "simulation_failed",
        "Settlement withdraw probe simulation failed",
        {
          err: JSON.stringify(lastProbeFailure.err),
          logs: lastProbeFailure.logs?.slice(-12) ?? []
        }
      );
    }
    if (sharedPrefixInstructions === null || withdrawOutputRawUsdc === null) {
      throw conflict(
        "simulation_failed",
        "Settlement withdraw output does not cover the seller amount within the approved share maximum",
        {
          sharesToRedeemRaw: sharesToRedeemRaw.toString(),
          maxSharesToRedeemRaw: input.sharesToRedeemRaw.toString(),
          amountRawUsdc: input.amountRawUsdc.toString()
        }
      );
    }

    const dustRawUsdc = withdrawOutputRawUsdc - input.amountRawUsdc;
    const agentNoop = createNoopSigner(agent);
    const instructions: Instruction[] = [
      ...sharedPrefixInstructions,
      getTransferCheckedInstruction({
        source: temp.address,
        mint: usdcMint,
        destination: sellerUsdcAta,
        authority: agentNoop,
        amount: input.amountRawUsdc,
        decimals: USDC_DECIMALS
      })
    ];
    if (dustRawUsdc > 0n) {
      instructions.push(
        getTransferCheckedInstruction({
          source: temp.address,
          mint: usdcMint,
          destination: dustRecipientUsdcAta,
          authority: agentNoop,
          amount: dustRawUsdc,
          decimals: USDC_DECIMALS
        })
      );
    }
    instructions.push(
      getCloseAccountInstruction({
        account: temp.address,
        destination: sponsor,
        owner: agentNoop
      }),
      getAddMemoInstruction({ memo: input.memo })
    );

    const finalTransaction = await buildVersionedTransaction({
      feePayer: sponsor,
      blockhash: context.blockhash,
      lastValidBlockHeight: context.lastValidBlockHeight,
      instructions,
      lookupTables,
      partialSigners: [temp.keyPair]
    });

    const finalSimulation = await this.simulate(
      finalTransaction.serializedBase64,
      [temp.address, sellerUsdcAta]
    );
    if (finalSimulation.err !== null) {
      throw conflict(
        "simulation_failed",
        "Canonical settlement transaction simulation failed",
        {
          err: JSON.stringify(finalSimulation.err),
          logs: finalSimulation.logs?.slice(-12) ?? []
        }
      );
    }
    if (finalSimulation.accountsExisting.get(temp.address) === true) {
      throw conflict(
        "simulation_failed",
        "Temporary settlement account was not closed by the settlement transaction"
      );
    }

    const temporarySettlementSignature = signatureBase58ForSigner(
      finalTransaction.transaction,
      temp.address
    );
    if (temporarySettlementSignature === null) {
      throw unavailable(
        "transaction_builder_invalid",
        "Temporary settlement account signature is missing from the prepared transaction"
      );
    }

    return {
      preparedMessageHash: finalTransaction.messageHash,
      recentBlockhash: context.blockhash,
      lastValidBlockHeight: Number(context.lastValidBlockHeight),
      temporarySettlementTokenAccount: temp.address,
      temporarySettlementSignature,
      serializedTransaction: finalTransaction.serializedBase64,
      sharesToRedeemRaw
    };
  }

  private async loadFreshContext(
    wallet: string
  ): Promise<{ context: VaultContext; userShares: UserSharesRaw }> {
    const now = Date.now();
    if (this.cached === null || now - this.cached.loadedAtMs > this.config.contextTtlMs) {
      this.cached = {
        context: await this.adapter.loadContext(),
        userShares: new Map(),
        loadedAtMs: now
      };
    }

    let userShares = this.cached.userShares.get(wallet);
    if (userShares === undefined) {
      userShares = await this.adapter.getUserSharesRaw(wallet, this.cached.context);
      this.cached.userShares.set(wallet, userShares);
    }

    return { context: this.cached.context, userShares };
  }

  private async tokenAccountRent(): Promise<bigint> {
    this.rentLamportsForTokenAccount ??= await this.rpc
      .getMinimumBalanceForRentExemption(TOKEN_ACCOUNT_SIZE)
      .send();
    return this.rentLamportsForTokenAccount;
  }

  private async assertSettlementAccountsExist(params: {
    sellerUsdcAta: Address;
    dustRecipientUsdcAta: Address;
    userShares: UserSharesRaw;
  }): Promise<void> {
    const accounts = await this.rpc
      .getMultipleAccounts(
        [params.sellerUsdcAta, params.dustRecipientUsdcAta],
        { encoding: "base64" }
      )
      .send();
    if (accounts.value[0] === null) {
      throw conflict(
        "seller_ata_missing",
        "Seller USDC associated token account does not exist; settlement never creates it"
      );
    }
    if (accounts.value[1] === null) {
      throw conflict(
        "agent_usdc_ata_missing",
        "Agent USDC associated token account does not exist; settlement never creates it"
      );
    }
    if (!params.userShares.sharesAtaExists) {
      throw conflict(
        "agent_shares_ata_missing",
        "Agent vault share associated token account does not exist"
      );
    }
  }

  private async simulate(
    serializedBase64: string,
    watchedAccounts: Address[]
  ): Promise<{
    err: unknown;
    logs: readonly string[] | null;
    tokenAmounts: Map<Address, bigint>;
    accountsExisting: Map<Address, boolean>;
  }> {
    const result = await this.rpc
      .simulateTransaction(serializedBase64 as Base64EncodedWireTransaction, {
        encoding: "base64",
        sigVerify: false,
        replaceRecentBlockhash: false,
        commitment: "confirmed",
        accounts: {
          encoding: "base64",
          addresses: watchedAccounts
        }
      })
      .send();

    const tokenAmounts = new Map<Address, bigint>();
    const accountsExisting = new Map<Address, boolean>();
    const accounts = result.value.accounts ?? [];
    watchedAccounts.forEach((watched, index) => {
      const account = accounts[index] ?? null;
      // Live RPCs report accounts closed during simulation as a zero-lamport
      // system-owned stub rather than null.
      accountsExisting.set(watched, account !== null && account.lamports > 0n);
      if (account !== null && account.owner === TOKEN_PROGRAM_ADDRESS) {
        const data = Buffer.from(String(account.data[0]), "base64");
        if (data.length >= 72) {
          tokenAmounts.set(watched, data.readBigUInt64LE(64));
        }
      }
    });

    return {
      err: result.value.err,
      logs: result.value.logs,
      tokenAmounts,
      accountsExisting
    };
  }
}

function mapLiquidityError(error: unknown): SublyError | unknown {
  if (error instanceof VaultLiquidityError) {
    return conflict("budget_illiquid", error.message);
  }
  if (error instanceof SublyError) {
    return error;
  }
  return error;
}
