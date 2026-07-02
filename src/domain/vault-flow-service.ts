import { randomUUID } from "node:crypto";
import {
  getSetComputeUnitLimitInstruction,
  getSetComputeUnitPriceInstruction
} from "@solana-program/compute-budget";
import { isProductionEnv } from "../config/env.js";
import type { Instruction, KeyPairSigner } from "@solana/kit";
import { SUBLY_VAULT } from "../config/constants.js";
import {
  grossWithdrawForNetTarget,
  KaminoVaultAdapter,
  VaultLiquidityError,
  type UserSharesRaw,
  type VaultContext
} from "../kamino/vault-adapter.js";
import { deriveAssociatedTokenAddress } from "../lib/associated-token-account.js";
import {
  ceilDiv,
  clampToZero,
  minBigInt,
  parsePositiveRawUnits,
  rawUnitsToString
} from "../lib/raw-units.js";
import { assertSolanaAddress } from "../lib/solana-address.js";
import { RATE_SCALE } from "../config/constants.js";
import type { TransactionSubmissionEngine } from "../solana/submission.js";
import {
  addSignaturesToSerializedTransaction,
  buildVersionedTransaction,
  signatureBase58ForSigner
} from "../solana/tx.js";
import { computePositionValueRawUsdc, evaluatePaymentBudget } from "./budget.js";
import { badRequest, conflict, notFound } from "./errors.js";
import type { Ledger } from "./ledger.js";
import type {
  DepositIntent,
  SyncEvent,
  SyncEventType,
  VaultFlowStatus,
  WalletPosition,
  WithdrawalIntent
} from "./models.js";
import type { FeeLamportsToUsdcConverter } from "./kamino-settlement-submitter.js";
import {
  extractValidRequiredSignerSignature,
  preparedMessageHashFromSerializedTransaction
} from "./payment-payload-verifier.js";
import {
  activeSubmittedPayments,
  expirePreparedPaymentsForLockedPosition
} from "./position-maintenance.js";

export interface VaultFlowServiceConfig {
  flowExpirySeconds: number;
  computeUnitLimit: number;
  computeUnitPriceMicroLamports: bigint;
  /**
   * Fee-debt headroom a yield-realize withdrawal must leave in the spendable
   * yield on top of the gross withdraw, covering the sponsored realize fee
   * that is charged to the position only after confirmation.
   */
  realizeOverheadRawUsdc: bigint;
}

const DEFAULT_FLOW_CONFIG: VaultFlowServiceConfig = {
  flowExpirySeconds: 120,
  computeUnitLimit: 1_000_000,
  computeUnitPriceMicroLamports: 1n,
  realizeOverheadRawUsdc: 2_500n
};

/**
 * kvault issues whole shares and rounds the effective deposited tokens down,
 * shaving up to ~tokens-per-share (a few raw units while the exchange rate
 * is near 1.0) off the requested amount. 10 raw (0.00001 USDC) comfortably
 * covers that so a minimum-sized deposit cannot land below the on-chain
 * minimum after rounding.
 */
const DEPOSIT_SHARE_ROUNDING_MARGIN_RAW = 10n;

export interface SubmitFlowInput {
  serializedTransaction: string;
  agentSignature: string;
}

/**
 * HTTP deposit and instant-only normal withdrawal flows. The agent wallet
 * signs the prepared transaction off-service; the sponsor co-signs as fee
 * payer and submits. Principal basis changes only after confirmed on-chain
 * deltas prove the actual movement.
 */
export class VaultFlowService {
  private readonly ledger: Ledger;
  private readonly adapter: KaminoVaultAdapter;
  private readonly engine: TransactionSubmissionEngine;
  private readonly sponsor: KeyPairSigner;
  private readonly config: VaultFlowServiceConfig;
  private readonly feeLamportsToUsdc: FeeLamportsToUsdcConverter | null;

  constructor(params: {
    ledger: Ledger;
    adapter: KaminoVaultAdapter;
    engine: TransactionSubmissionEngine;
    sponsor: KeyPairSigner;
    config?: Partial<VaultFlowServiceConfig>;
    feeLamportsToUsdc?: FeeLamportsToUsdcConverter;
  }) {
    this.ledger = params.ledger;
    this.adapter = params.adapter;
    this.engine = params.engine;
    this.sponsor = params.sponsor;
    this.config = { ...DEFAULT_FLOW_CONFIG, ...params.config };
    this.feeLamportsToUsdc = params.feeLamportsToUsdc ?? null;
  }

  async prepareDeposit(input: { wallet: string; amountRawUsdc: string }) {
    const wallet = requireAddress(input.wallet, "wallet");
    const amountRawUsdc = parsePositiveRawUnits(
      input.amountRawUsdc,
      "amountRawUsdc"
    );
    const vault = SUBLY_VAULT.address;

    return this.ledger.withWalletVaultLock(wallet, vault, async () => {
      const position = await this.requireSignerReadyPosition(wallet, vault);
      await this.expireStaleFlows(wallet, vault);
      await this.assertNoPendingFlow(wallet, vault);

      const context = await this.adapter.loadContext();
      // The kvault program rejects DepositAmountBelowMinimum at execution;
      // failing here turns an opaque simulation failure into a clear error.
      // The margin exists because kvault rounds the effective deposit DOWN
      // by a few raw units to whole shares (observed: 1_000_000 requested ->
      // 999_997 effective), so depositing exactly the minimum fails on-chain.
      const effectiveMinDepositRaw =
        context.minDepositAmountRaw + DEPOSIT_SHARE_ROUNDING_MARGIN_RAW;
      if (amountRawUsdc < effectiveMinDepositRaw) {
        throw badRequest(
          "deposit_below_minimum",
          `Deposit at least ${effectiveMinDepositRaw} raw USDC: the vault ` +
            `minimum is ${context.minDepositAmountRaw} and share rounding ` +
            `can shave a few raw units off the effective deposit`,
          {
            amountRawUsdc: amountRawUsdc.toString(),
            minDepositAmountRaw: context.minDepositAmountRaw.toString(),
            effectiveMinDepositRaw: effectiveMinDepositRaw.toString()
          }
        );
      }
      // Confirmed deltas are attributed against the ledger baseline, so the
      // ledger must match the chain before a new deposit is prepared.
      const userShares = await this.adapter.getUserSharesRaw(wallet, context);
      if (userShares.totalSharesRaw !== position.totalSharesRaw) {
        await this.ledger.savePosition({
          ...position,
          status: "needs_baseline_reset",
          version: position.version + 1
        });
        await this.recordSyncEvent({
          wallet,
          vault,
          eventType: "external_share_movement",
          txSignature: null,
          deltaSharesRaw: userShares.totalSharesRaw - position.totalSharesRaw,
          deltaPrincipalRawUsdc: 0n,
          classification: "needs_baseline_reset",
          slot: Number(context.slot)
        });
        throw conflict(
          "needs_baseline_reset",
          "On-chain share balance does not match the Subly ledger; run wallet sync before depositing"
        );
      }

      const instructions: Instruction[] = [
        ...this.computeBudgetInstructions(),
        ...(await this.adapter.buildDepositInstructions({
          wallet,
          amountRawUsdc,
          context,
          rentPayer: this.sponsor.address
        }))
      ];
      const lookupTables = await this.adapter.loadLookupTables(context);
      const built = await buildVersionedTransaction({
        feePayer: this.sponsor.address,
        blockhash: context.blockhash,
        lastValidBlockHeight: context.lastValidBlockHeight,
        instructions,
        lookupTables
      });

      const intent: DepositIntent = {
        depositId: `dep_${randomUUID().replaceAll("-", "")}`,
        wallet,
        vault,
        amountRawUsdc,
        preparedMessageHash: built.messageHash,
        recentBlockhash: context.blockhash,
        lastValidBlockHeight: Number(context.lastValidBlockHeight),
        serializedTransaction: built.serializedBase64,
        txSignature: null,
        submittedSerializedTransaction: null,
        actualDepositRawUsdc: null,
        sharesMintedRaw: null,
        principalBasisBeforeRawUsdc: position.principalBasisRawUsdc,
        principalBasisAfterRawUsdc: null,
        status: "prepared",
        expiresAt: this.flowExpiry(),
        submittedAt: null,
        terminalAt: null,
        errorCode: null
      };

      const saved = await this.ledger.saveDeposit(intent);
      return {
        ...serializeDepositIntent(saved),
        signingIntent: {
          wallet,
          vault,
          shareMint: SUBLY_VAULT.shareMint,
          asset: SUBLY_VAULT.usdcMint,
          amountRawUsdc: rawUnitsToString(amountRawUsdc),
          feePayer: this.sponsor.address,
          expiresAt: saved.expiresAt,
          preparedMessageHash: saved.preparedMessageHash
        }
      };
    });
  }

  async submitDeposit(input: SubmitFlowInput & { depositId: string }) {
    const first = await this.ledger.getDeposit(input.depositId);
    if (first === null) {
      throw notFound("deposit_not_found", "Deposit intent does not exist");
    }

    const submission = await this.ledger.withWalletVaultLock(
      first.wallet,
      first.vault,
      async () => {
        const intent = await this.ledger.getDeposit(input.depositId);
        if (intent === null) {
          throw notFound("deposit_not_found", "Deposit intent does not exist");
        }
        if (intent.status !== "prepared") {
          return { kind: "existing" as const, intent };
        }
        if (flowExpired(intent.expiresAt)) {
          return {
            kind: "existing" as const,
            intent: await this.ledger.saveDeposit(
              terminalFlow(intent, "expired", "expired")
            )
          };
        }

        this.verifyAgentSignedFlowTransaction({
          expectedMessageHash: intent.preparedMessageHash,
          wallet: intent.wallet,
          serializedTransaction: input.serializedTransaction,
          agentSignature: input.agentSignature
        });

        const { serializedBase64, transaction } =
          await addSignaturesToSerializedTransaction({
            serializedBase64: input.serializedTransaction,
            signers: [this.sponsor.keyPair]
          });
        const txSignature = signatureBase58ForSigner(
          transaction,
          this.sponsor.address
        );
        if (txSignature === null) {
          throw conflict(
            "sponsor_signature_missing",
            "Sponsor signature could not be applied to the deposit transaction"
          );
        }

        return {
          kind: "submit" as const,
          intent: await this.ledger.saveDeposit({
            ...intent,
            status: "submitted",
            txSignature,
            submittedSerializedTransaction: serializedBase64,
            submittedAt: new Date().toISOString()
          })
        };
      }
    );

    if (submission.kind === "existing") {
      return serializeDepositIntent(
        submission.intent.status === "submitted"
          ? await this.reconcileDeposit(submission.intent)
          : submission.intent
      );
    }

    return serializeDepositIntent(
      await this.sendAndFinalizeDeposit(submission.intent)
    );
  }

  async getDeposit(depositId: string) {
    const intent = await this.ledger.getDeposit(depositId);
    if (intent === null) {
      throw notFound("deposit_not_found", "Deposit intent does not exist");
    }

    if (intent.status === "submitted") {
      return serializeDepositIntent(await this.reconcileDeposit(intent));
    }
    if (intent.status === "prepared" && flowExpired(intent.expiresAt)) {
      return serializeDepositIntent(
        await this.ledger.saveDeposit(terminalFlow(intent, "expired", "expired"))
      );
    }

    return serializeDepositIntent(intent);
  }

  async prepareWithdrawal(input: {
    wallet: string;
    amountRawUsdc: string;
    purpose?: "yield_realize" | undefined;
  }) {
    const wallet = requireAddress(input.wallet, "wallet");
    const amountRawUsdc = parsePositiveRawUnits(
      input.amountRawUsdc,
      "amountRawUsdc"
    );
    const vault = SUBLY_VAULT.address;

    return this.ledger.withWalletVaultLock(wallet, vault, async () => {
      const position = await this.requireSignerReadyPosition(wallet, vault);
      // Prepared-but-unsubmitted payment intents expire before normal
      // withdraw preparation; submitted payments keep the wallet locked.
      await expirePreparedPaymentsForLockedPosition(this.ledger, wallet, vault);
      const payments = await this.ledger.listPaymentsForPosition(wallet, vault);
      const submitted = activeSubmittedPayments(payments);
      if (submitted.length > 0) {
        throw conflict(
          "wallet_locked_by_payment",
          "Submitted payments must reach terminal settlement before a normal withdraw",
          { paymentIds: submitted.map((payment) => payment.paymentId) }
        );
      }
      const preparedPayments = payments.filter(
        (payment) => payment.status === "prepared"
      );
      if (preparedPayments.length > 0) {
        throw conflict(
          "payment_reservation_active",
          "Prepared payment intents must expire or settle before a normal withdraw",
          { paymentIds: preparedPayments.map((payment) => payment.paymentId) }
        );
      }
      await this.expireStaleFlows(wallet, vault);
      await this.assertNoPendingFlow(wallet, vault);

      const context = await this.adapter.loadContext();
      const userShares = await this.adapter.getUserSharesRaw(wallet, context);
      if (userShares.totalSharesRaw !== position.totalSharesRaw) {
        await this.ledger.savePosition({
          ...position,
          status: "needs_baseline_reset",
          version: position.version + 1
        });
        await this.recordSyncEvent({
          wallet,
          vault,
          eventType: "external_share_movement",
          txSignature: null,
          deltaSharesRaw: userShares.totalSharesRaw - position.totalSharesRaw,
          deltaPrincipalRawUsdc: 0n,
          classification: "needs_baseline_reset",
          slot: Number(context.slot)
        });
        throw conflict(
          "needs_baseline_reset",
          "On-chain share balance does not match the Subly ledger; run wallet sync before withdrawing"
        );
      }

      let grossWithdrawRawUsdc: bigint;
      try {
        grossWithdrawRawUsdc = grossWithdrawForNetTarget({
          targetNetRawUsdc: amountRawUsdc,
          penaltyBps: context.withdrawalPenaltyBps,
          penaltyLamports: context.withdrawalPenaltyLamports
        });
      } catch (error) {
        if (error instanceof VaultLiquidityError) {
          throw conflict("withdraw_illiquid", error.message);
        }
        throw error;
      }
      if (grossWithdrawRawUsdc > context.instantRedeemCapacityRawUsdc) {
        throw conflict(
          "withdraw_illiquid",
          "Instant redeem capacity cannot serve this withdrawal without queueing",
          {
            grossWithdrawRawUsdc: grossWithdrawRawUsdc.toString(),
            instantRedeemCapacityRawUsdc:
              context.instantRedeemCapacityRawUsdc.toString()
          }
        );
      }

      // Yield-realize withdrawals fund x402 payments; unlike a normal exit
      // withdrawal they must never dig into the deposited principal, so the
      // gross withdraw (incl. the vault penalty) plus the sponsored-fee
      // headroom must fit in the spendable yield — enforced HERE, server-side,
      // against the fresh chain exchange rate, not just by the client.
      if (input.purpose === "yield_realize") {
        const evaluation = evaluatePaymentBudget({
          position: {
            ...position,
            stakedSharesRaw: userShares.stakedSharesRaw,
            unstakedSharesRaw: userShares.unstakedSharesRaw,
            totalSharesRaw: userShares.totalSharesRaw,
            exchangeRateScaled: context.exchangeRateScaled,
            instantRedeemCapacityRawUsdc: context.instantRedeemCapacityRawUsdc
          },
          sellerAmountRawUsdc: amountRawUsdc,
          estimatedFeeDebtRawUsdc: this.config.realizeOverheadRawUsdc,
          requiredWithdrawRawUsdc: grossWithdrawRawUsdc
        });
        if (!evaluation.ok) {
          throw conflict(
            evaluation.code,
            "Yield-realize withdrawals are limited to the spendable yield; the deposited principal is never spent",
            {
              ...evaluation.details,
              spendableYieldRawUsdc:
                evaluation.budget.spendableYieldRawUsdc.toString()
            }
          );
        }
      }

      const requestedSharesRaw = minBigInt(
        ceilDiv(grossWithdrawRawUsdc * RATE_SCALE, context.exchangeRateScaled),
        userShares.totalSharesRaw
      );
      const maxSharesToRedeemRaw =
        requestedSharesRaw >= userShares.totalSharesRaw
          ? userShares.totalSharesRaw
          : requestedSharesRaw;
      const destinationUsdcAta = deriveAssociatedTokenAddress({
        owner: wallet,
        mint: SUBLY_VAULT.usdcMint
      });

      const instructions: Instruction[] = [
        ...this.computeBudgetInstructions(),
        ...(await this.adapter.buildNormalWithdrawInstructions({
          wallet,
          sharesToRedeemRaw: requestedSharesRaw,
          context,
          rentPayer: this.sponsor.address
        }))
      ];
      const lookupTables = await this.adapter.loadLookupTables(context);
      const built = await buildVersionedTransaction({
        feePayer: this.sponsor.address,
        blockhash: context.blockhash,
        lastValidBlockHeight: context.lastValidBlockHeight,
        instructions,
        lookupTables
      });

      const intent: WithdrawalIntent = {
        withdrawalId: `wdr_${randomUUID().replaceAll("-", "")}`,
        wallet,
        vault,
        requestedWithdrawRawUsdc: amountRawUsdc,
        requestedSharesRaw,
        maxSharesToRedeemRaw,
        destinationUsdcAta,
        preparedMessageHash: built.messageHash,
        recentBlockhash: context.blockhash,
        lastValidBlockHeight: Number(context.lastValidBlockHeight),
        serializedTransaction: built.serializedBase64,
        txSignature: null,
        submittedSerializedTransaction: null,
        actualSharesBurnedRaw: null,
        actualWithdrawRawUsdc: null,
        principalBasisBeforeRawUsdc: position.principalBasisRawUsdc,
        principalBasisAfterRawUsdc: null,
        status: "prepared",
        expiresAt: this.flowExpiry(),
        submittedAt: null,
        terminalAt: null,
        errorCode: null,
        liquidityRejectionReason: null
      };

      const saved = await this.ledger.saveWithdrawal(intent);
      return {
        ...serializeWithdrawalIntent(saved),
        signingIntent: {
          wallet,
          vault,
          shareMint: SUBLY_VAULT.shareMint,
          asset: SUBLY_VAULT.usdcMint,
          destinationUsdcAta,
          maxSharesToRedeemRaw: rawUnitsToString(saved.maxSharesToRedeemRaw),
          allowFullExit: requestedSharesRaw >= userShares.totalSharesRaw,
          feePayer: this.sponsor.address,
          expiresAt: saved.expiresAt,
          preparedMessageHash: saved.preparedMessageHash
        }
      };
    });
  }

  async submitWithdrawal(input: SubmitFlowInput & { withdrawalId: string }) {
    const first = await this.ledger.getWithdrawal(input.withdrawalId);
    if (first === null) {
      throw notFound("withdrawal_not_found", "Withdrawal intent does not exist");
    }

    const submission = await this.ledger.withWalletVaultLock(
      first.wallet,
      first.vault,
      async () => {
        const intent = await this.ledger.getWithdrawal(input.withdrawalId);
        if (intent === null) {
          throw notFound(
            "withdrawal_not_found",
            "Withdrawal intent does not exist"
          );
        }
        if (intent.status !== "prepared") {
          return { kind: "existing" as const, intent };
        }
        if (flowExpired(intent.expiresAt)) {
          return {
            kind: "existing" as const,
            intent: await this.ledger.saveWithdrawal(
              terminalFlow(intent, "expired", "expired")
            )
          };
        }

        this.verifyAgentSignedFlowTransaction({
          expectedMessageHash: intent.preparedMessageHash,
          wallet: intent.wallet,
          serializedTransaction: input.serializedTransaction,
          agentSignature: input.agentSignature
        });

        const { serializedBase64, transaction } =
          await addSignaturesToSerializedTransaction({
            serializedBase64: input.serializedTransaction,
            signers: [this.sponsor.keyPair]
          });
        const txSignature = signatureBase58ForSigner(
          transaction,
          this.sponsor.address
        );
        if (txSignature === null) {
          throw conflict(
            "sponsor_signature_missing",
            "Sponsor signature could not be applied to the withdrawal transaction"
          );
        }

        return {
          kind: "submit" as const,
          intent: await this.ledger.saveWithdrawal({
            ...intent,
            status: "submitted",
            txSignature,
            submittedSerializedTransaction: serializedBase64,
            submittedAt: new Date().toISOString()
          })
        };
      }
    );

    if (submission.kind === "existing") {
      return serializeWithdrawalIntent(
        submission.intent.status === "submitted"
          ? await this.reconcileWithdrawal(submission.intent)
          : submission.intent
      );
    }

    return serializeWithdrawalIntent(
      await this.sendAndFinalizeWithdrawal(submission.intent)
    );
  }

  async getWithdrawal(withdrawalId: string) {
    const intent = await this.ledger.getWithdrawal(withdrawalId);
    if (intent === null) {
      throw notFound("withdrawal_not_found", "Withdrawal intent does not exist");
    }

    if (intent.status === "submitted") {
      return serializeWithdrawalIntent(await this.reconcileWithdrawal(intent));
    }
    if (intent.status === "prepared" && flowExpired(intent.expiresAt)) {
      return serializeWithdrawalIntent(
        await this.ledger.saveWithdrawal(
          terminalFlow(intent, "expired", "expired")
        )
      );
    }

    return serializeWithdrawalIntent(intent);
  }

  private async sendAndFinalizeDeposit(
    intent: DepositIntent
  ): Promise<DepositIntent> {
    const outcome = await this.sendAndConfirmFlow(intent);
    if (outcome.kind === "not_submitted") {
      return this.ledger.withWalletVaultLock(intent.wallet, intent.vault, async () =>
        this.ledger.saveDeposit(
          terminalFlow(intent, "failed_not_submitted", outcome.errorCode)
        )
      );
    }
    if (outcome.kind === "pending") {
      return intent;
    }

    return this.finalizeDepositFromChain(intent, outcome);
  }

  private async reconcileDeposit(intent: DepositIntent): Promise<DepositIntent> {
    const outcome = await this.reconcileFlow(intent);
    if (outcome.kind === "pending") {
      return intent;
    }
    if (outcome.kind === "not_submitted") {
      return this.ledger.withWalletVaultLock(intent.wallet, intent.vault, async () =>
        this.ledger.saveDeposit(
          terminalFlow(intent, "failed_not_submitted", outcome.errorCode)
        )
      );
    }

    return this.finalizeDepositFromChain(intent, outcome);
  }

  private async finalizeDepositFromChain(
    intent: DepositIntent,
    outcome: ConfirmedFlowOutcome
  ): Promise<DepositIntent> {
    return this.ledger.withWalletVaultLock(intent.wallet, intent.vault, async () => {
      const latest = await this.ledger.getDeposit(intent.depositId);
      if (latest === null || latest.status !== "submitted") {
        return latest ?? intent;
      }

      if (outcome.err !== null) {
        await this.applyFlowFeeDebt(intent.wallet, intent.vault, outcome.feeLamports);
        return this.ledger.saveDeposit(
          terminalFlow(latest, "failed", "landed_failed")
        );
      }

      const agentUsdcAta = deriveAssociatedTokenAddress({
        owner: intent.wallet,
        mint: SUBLY_VAULT.usdcMint
      });
      const usdcDelta = outcome.tokenBalanceDeltas.get(agentUsdcAta) ?? 0n;
      const actualDepositRawUsdc = usdcDelta < 0n ? -usdcDelta : 0n;

      const refreshed = await this.refreshPositionFromChain(intent.wallet, intent.vault);
      if (refreshed === null || actualDepositRawUsdc === 0n) {
        await this.flagBaselineReset(intent.wallet, intent.vault);
        return this.ledger.saveDeposit(
          terminalFlow(latest, "failed", "deposit_classification_failed")
        );
      }

      const sharesMintedRaw = clampToZero(
        refreshed.after.totalSharesRaw - refreshed.before.totalSharesRaw
      );

      const basisAfter =
        refreshed.position.principalBasisRawUsdc + actualDepositRawUsdc;
      await this.ledger.savePosition({
        ...refreshed.position,
        stakedSharesRaw: refreshed.after.stakedSharesRaw,
        unstakedSharesRaw: refreshed.after.unstakedSharesRaw,
        totalSharesRaw: refreshed.after.totalSharesRaw,
        exchangeRateScaled: refreshed.exchangeRateScaled,
        instantRedeemCapacityRawUsdc: refreshed.instantRedeemCapacityRawUsdc,
        principalBasisRawUsdc: basisAfter,
        principalBasisSource: "subly_receipts",
        lastSyncedSlot: refreshed.observedSlot,
        version: refreshed.position.version + 1
      });
      await this.applyFlowFeeDebt(intent.wallet, intent.vault, outcome.feeLamports);
      await this.recordSyncEvent({
        wallet: intent.wallet,
        vault: intent.vault,
        eventType: "deposit_confirmed",
        txSignature: latest.txSignature,
        deltaSharesRaw: sharesMintedRaw,
        deltaPrincipalRawUsdc: actualDepositRawUsdc,
        classification: "subly_deposit_receipt",
        slot: refreshed.observedSlot
      });

      return this.ledger.saveDeposit({
        ...latest,
        status: "confirmed",
        actualDepositRawUsdc,
        sharesMintedRaw,
        principalBasisAfterRawUsdc: basisAfter,
        terminalAt: new Date().toISOString()
      });
    });
  }

  private async sendAndFinalizeWithdrawal(
    intent: WithdrawalIntent
  ): Promise<WithdrawalIntent> {
    const outcome = await this.sendAndConfirmFlow(intent);
    if (outcome.kind === "not_submitted") {
      return this.ledger.withWalletVaultLock(intent.wallet, intent.vault, async () =>
        this.ledger.saveWithdrawal(
          terminalFlow(intent, "failed_not_submitted", outcome.errorCode)
        )
      );
    }
    if (outcome.kind === "pending") {
      return intent;
    }

    return this.finalizeWithdrawalFromChain(intent, outcome);
  }

  private async reconcileWithdrawal(
    intent: WithdrawalIntent
  ): Promise<WithdrawalIntent> {
    const outcome = await this.reconcileFlow(intent);
    if (outcome.kind === "pending") {
      return intent;
    }
    if (outcome.kind === "not_submitted") {
      return this.ledger.withWalletVaultLock(intent.wallet, intent.vault, async () =>
        this.ledger.saveWithdrawal(
          terminalFlow(intent, "failed_not_submitted", outcome.errorCode)
        )
      );
    }

    return this.finalizeWithdrawalFromChain(intent, outcome);
  }

  private async finalizeWithdrawalFromChain(
    intent: WithdrawalIntent,
    outcome: ConfirmedFlowOutcome
  ): Promise<WithdrawalIntent> {
    return this.ledger.withWalletVaultLock(intent.wallet, intent.vault, async () => {
      const latest = await this.ledger.getWithdrawal(intent.withdrawalId);
      if (latest === null || latest.status !== "submitted") {
        return latest ?? intent;
      }

      if (outcome.err !== null) {
        await this.applyFlowFeeDebt(intent.wallet, intent.vault, outcome.feeLamports);
        return this.ledger.saveWithdrawal(
          terminalFlow(latest, "failed", "landed_failed")
        );
      }

      const usdcDelta =
        outcome.tokenBalanceDeltas.get(intent.destinationUsdcAta) ?? 0n;
      const actualWithdrawRawUsdc = usdcDelta > 0n ? usdcDelta : 0n;

      const refreshed = await this.refreshPositionFromChain(intent.wallet, intent.vault);
      if (refreshed === null || actualWithdrawRawUsdc === 0n) {
        await this.flagBaselineReset(intent.wallet, intent.vault);
        return this.ledger.saveWithdrawal(
          terminalFlow(latest, "failed", "withdrawal_classification_failed")
        );
      }

      const actualSharesBurnedRaw = clampToZero(
        refreshed.before.totalSharesRaw - refreshed.after.totalSharesRaw
      );
      const newPositionValue = computePositionValueRawUsdc(
        refreshed.after.totalSharesRaw,
        refreshed.exchangeRateScaled
      );
      // Confirmed normal withdraw reduces the position; principal basis is
      // clamped so remaining yield is never inflated by the withdrawal.
      const basisAfter = minBigInt(
        refreshed.position.principalBasisRawUsdc,
        newPositionValue
      );
      await this.ledger.savePosition({
        ...refreshed.position,
        stakedSharesRaw: refreshed.after.stakedSharesRaw,
        unstakedSharesRaw: refreshed.after.unstakedSharesRaw,
        totalSharesRaw: refreshed.after.totalSharesRaw,
        exchangeRateScaled: refreshed.exchangeRateScaled,
        instantRedeemCapacityRawUsdc: refreshed.instantRedeemCapacityRawUsdc,
        principalBasisRawUsdc: basisAfter,
        principalBasisSource: "subly_receipts",
        lastSyncedSlot: refreshed.observedSlot,
        version: refreshed.position.version + 1
      });
      await this.applyFlowFeeDebt(intent.wallet, intent.vault, outcome.feeLamports);
      await this.recordSyncEvent({
        wallet: intent.wallet,
        vault: intent.vault,
        eventType: "withdrawal_confirmed",
        txSignature: latest.txSignature,
        deltaSharesRaw: -actualSharesBurnedRaw,
        deltaPrincipalRawUsdc:
          basisAfter - refreshed.position.principalBasisRawUsdc,
        classification: "subly_withdrawal_receipt",
        slot: refreshed.observedSlot
      });

      return this.ledger.saveWithdrawal({
        ...latest,
        status: "confirmed",
        actualSharesBurnedRaw,
        actualWithdrawRawUsdc,
        principalBasisAfterRawUsdc: basisAfter,
        terminalAt: new Date().toISOString()
      });
    });
  }

  private async sendAndConfirmFlow(intent: {
    txSignature: string | null;
    submittedSerializedTransaction: string | null;
    lastValidBlockHeight: number | null;
  }): Promise<FlowOutcome> {
    if (
      intent.txSignature === null ||
      intent.submittedSerializedTransaction === null
    ) {
      return { kind: "not_submitted", errorCode: "submission_record_missing" };
    }

    const simulation = await this.engine.simulateSignedTransaction(
      intent.submittedSerializedTransaction
    );
    if (simulation.err !== null) {
      return { kind: "not_submitted", errorCode: "simulation_failed" };
    }

    try {
      await this.engine.sendSignedTransaction(
        intent.submittedSerializedTransaction
      );
    } catch {
      // Possibly accepted before the transport failed; reconcile by signature.
      return { kind: "pending" };
    }

    const confirmation = await this.engine.waitForConfirmation({
      txSignature: intent.txSignature,
      lastValidBlockHeight: intent.lastValidBlockHeight
    });
    if (confirmation.status === "expired") {
      return { kind: "not_submitted", errorCode: "blockhash_expired" };
    }
    if (confirmation.status === "timeout") {
      return { kind: "pending" };
    }

    return this.lookupConfirmedFlow(intent.txSignature);
  }

  private async reconcileFlow(intent: {
    txSignature: string | null;
    submittedSerializedTransaction: string | null;
    lastValidBlockHeight: number | null;
  }): Promise<FlowOutcome> {
    if (
      intent.txSignature === null ||
      intent.submittedSerializedTransaction === null
    ) {
      return { kind: "not_submitted", errorCode: "submission_record_missing" };
    }

    const lookup = await this.engine.lookupTransaction(intent.txSignature);
    if (lookup.found) {
      return {
        kind: "confirmed",
        err: lookup.err,
        feeLamports: lookup.feeLamports,
        tokenBalanceDeltas: lookup.tokenBalanceDeltas
      };
    }

    if (await this.engine.isBlockhashExpired(intent.lastValidBlockHeight)) {
      return { kind: "not_submitted", errorCode: "blockhash_expired" };
    }

    try {
      await this.engine.sendSignedTransaction(
        intent.submittedSerializedTransaction
      );
    } catch {
      // Best effort resend of the stored bytes; never a new transaction.
    }

    return { kind: "pending" };
  }

  private async lookupConfirmedFlow(txSignature: string): Promise<FlowOutcome> {
    const lookup = await this.engine.lookupTransaction(txSignature);
    if (!lookup.found) {
      return { kind: "pending" };
    }

    return {
      kind: "confirmed",
      err: lookup.err,
      feeLamports: lookup.feeLamports,
      tokenBalanceDeltas: lookup.tokenBalanceDeltas
    };
  }

  private async refreshPositionFromChain(
    wallet: string,
    vault: string
  ): Promise<{
    position: WalletPosition;
    before: { totalSharesRaw: bigint };
    after: UserSharesRaw;
    exchangeRateScaled: bigint;
    instantRedeemCapacityRawUsdc: bigint;
    observedSlot: number;
  } | null> {
    const position = await this.ledger.getPosition(wallet, vault);
    if (position === null) {
      return null;
    }

    let context: VaultContext;
    let after: UserSharesRaw;
    try {
      context = await this.adapter.loadContext();
      after = await this.adapter.getUserSharesRaw(wallet, context);
    } catch {
      return null;
    }

    return {
      position,
      before: { totalSharesRaw: position.totalSharesRaw },
      after,
      exchangeRateScaled: context.exchangeRateScaled,
      instantRedeemCapacityRawUsdc: context.instantRedeemCapacityRawUsdc,
      observedSlot: Number(context.slot)
    };
  }

  private async flagBaselineReset(wallet: string, vault: string): Promise<void> {
    const position = await this.ledger.getPosition(wallet, vault);
    if (position !== null) {
      await this.ledger.savePosition({
        ...position,
        status: "needs_baseline_reset",
        version: position.version + 1
      });
      await this.recordSyncEvent({
        wallet,
        vault,
        eventType: "external_share_movement",
        txSignature: null,
        deltaSharesRaw: 0n,
        deltaPrincipalRawUsdc: 0n,
        classification: "needs_baseline_reset",
        slot: null
      });
    }
  }

  private async recordSyncEvent(input: {
    wallet: string;
    vault: string;
    eventType: SyncEventType;
    txSignature: string | null;
    deltaSharesRaw: bigint;
    deltaPrincipalRawUsdc: bigint;
    classification: string;
    slot: number | null;
  }): Promise<void> {
    const event: SyncEvent = {
      eventId: `evt_${randomUUID().replaceAll("-", "")}`,
      wallet: input.wallet,
      vault: input.vault,
      eventType: input.eventType,
      txSignature: input.txSignature,
      deltaSharesRaw: input.deltaSharesRaw,
      deltaPrincipalRawUsdc: input.deltaPrincipalRawUsdc,
      classification: input.classification,
      sourceEndpoint: "chain_rpc",
      rawSnapshot: null,
      slot: input.slot,
      observedAt: new Date().toISOString()
    };
    await this.ledger.saveSyncEvent(event);
  }

  private async applyFlowFeeDebt(
    wallet: string,
    vault: string,
    feeLamports: bigint
  ): Promise<void> {
    if (this.feeLamportsToUsdc === null) {
      return;
    }

    let feeDebtRawUsdc: bigint;
    try {
      feeDebtRawUsdc = await this.feeLamportsToUsdc(feeLamports);
    } catch {
      return;
    }

    const position = await this.ledger.getPosition(wallet, vault);
    if (position !== null) {
      await this.ledger.savePosition({
        ...position,
        feeDebtRawUsdc: position.feeDebtRawUsdc + feeDebtRawUsdc,
        version: position.version + 1
      });
    }
  }

  private verifyAgentSignedFlowTransaction(params: {
    expectedMessageHash: string;
    wallet: string;
    serializedTransaction: string;
    agentSignature: string;
  }): void {
    const messageHash = preparedMessageHashFromSerializedTransaction(
      params.serializedTransaction
    );
    if (messageHash === null) {
      throw badRequest(
        "invalid_transaction_encoding",
        "serializedTransaction is not a valid Solana transaction"
      );
    }
    if (messageHash !== params.expectedMessageHash) {
      throw conflict(
        "message_hash_mismatch",
        "Submitted transaction does not match the prepared message"
      );
    }

    const agentSignature = extractValidRequiredSignerSignature({
      serializedTransaction: params.serializedTransaction,
      signerPublicKey: params.wallet
    });
    if (!agentSignature.ok) {
      throw conflict(
        "agent_signature_invalid",
        `Agent wallet signature is invalid: ${agentSignature.reason}`
      );
    }
    if (agentSignature.signature !== params.agentSignature) {
      throw conflict(
        "agent_signature_invalid",
        "agentSignature does not match the signature inside the transaction"
      );
    }
  }

  private async requireSignerReadyPosition(
    wallet: string,
    vault: string
  ): Promise<WalletPosition> {
    const position = await this.ledger.getPosition(wallet, vault);
    if (position === null) {
      throw notFound(
        "wallet_not_registered",
        "Register the agent wallet before vault flows"
      );
    }
    if (position.signingMode !== "non_interactive") {
      throw conflict(
        "observed_only",
        "Vault flows require a non-interactive agent signer"
      );
    }
    if (position.signerProvider === "unconfigured") {
      throw conflict(
        "signer_provider_missing",
        "Wallet has no configured signer provider"
      );
    }
    if (
      isProductionEnv() &&
      position.signerValidationMode !== "structured_intent_transaction"
    ) {
      throw conflict(
        "signer_policy_validation_missing",
        "Production vault flows require a signer policy that validates structured intent and transaction contents before signing"
      );
    }

    return position;
  }

  private async assertNoPendingFlow(wallet: string, vault: string): Promise<void> {
    const pending = await pendingVaultFlows(this.ledger, wallet, vault);
    if (pending > 0) {
      throw conflict(
        "vault_flow_pending",
        "Another deposit or withdrawal for this wallet is still pending"
      );
    }
  }

  private async expireStaleFlows(wallet: string, vault: string): Promise<void> {
    const deposits = await this.ledger.listDepositsForPosition(wallet, vault);
    for (const deposit of deposits) {
      if (deposit.status === "prepared" && flowExpired(deposit.expiresAt)) {
        await this.ledger.saveDeposit(terminalFlow(deposit, "expired", "expired"));
      }
    }
    const withdrawals = await this.ledger.listWithdrawalsForPosition(wallet, vault);
    for (const withdrawal of withdrawals) {
      if (withdrawal.status === "prepared" && flowExpired(withdrawal.expiresAt)) {
        await this.ledger.saveWithdrawal(
          terminalFlow(withdrawal, "expired", "expired")
        );
      }
    }
  }

  private computeBudgetInstructions(): Instruction[] {
    return [
      getSetComputeUnitLimitInstruction({ units: this.config.computeUnitLimit }),
      getSetComputeUnitPriceInstruction({
        microLamports: this.config.computeUnitPriceMicroLamports
      })
    ];
  }

  private flowExpiry(): string {
    return new Date(
      Date.now() + this.config.flowExpirySeconds * 1000
    ).toISOString();
  }
}

type FlowOutcome =
  | { kind: "pending" }
  | { kind: "not_submitted"; errorCode: string }
  | ConfirmedFlowOutcome;

interface ConfirmedFlowOutcome {
  kind: "confirmed";
  err: unknown;
  feeLamports: bigint;
  tokenBalanceDeltas: Map<string, bigint>;
}

export async function pendingVaultFlows(
  ledger: Ledger,
  wallet: string,
  vault: string
): Promise<number> {
  const deposits = await ledger.listDepositsForPosition(wallet, vault);
  const withdrawals = await ledger.listWithdrawalsForPosition(wallet, vault);
  const pendingDeposits = deposits.filter(
    (intent) =>
      intent.status === "submitted" ||
      (intent.status === "prepared" && !flowExpired(intent.expiresAt))
  );
  const pendingWithdrawals = withdrawals.filter(
    (intent) =>
      intent.status === "submitted" ||
      (intent.status === "prepared" && !flowExpired(intent.expiresAt))
  );

  return pendingDeposits.length + pendingWithdrawals.length;
}

function flowExpired(expiresAt: string): boolean {
  const expiresAtMs = new Date(expiresAt).getTime();
  return !Number.isFinite(expiresAtMs) || expiresAtMs <= Date.now();
}

function terminalFlow<
  T extends { status: VaultFlowStatus; terminalAt: string | null; errorCode: string | null }
>(intent: T, status: VaultFlowStatus, errorCode: string): T {
  return {
    ...intent,
    status,
    errorCode,
    terminalAt: new Date().toISOString()
  };
}

function requireAddress(value: string, fieldName: string): string {
  try {
    return assertSolanaAddress(value, fieldName);
  } catch {
    throw badRequest(
      "invalid_solana_address",
      `${fieldName} must be a valid Solana public key`
    );
  }
}

export function serializeDepositIntent(intent: DepositIntent) {
  return {
    depositId: intent.depositId,
    wallet: intent.wallet,
    vault: intent.vault,
    amountRawUsdc: rawUnitsToString(intent.amountRawUsdc),
    preparedMessageHash: intent.preparedMessageHash,
    recentBlockhash: intent.recentBlockhash,
    lastValidBlockHeight: intent.lastValidBlockHeight,
    serializedTransaction: intent.serializedTransaction,
    txSignature: intent.txSignature,
    actualDepositRawUsdc:
      intent.actualDepositRawUsdc === null
        ? null
        : rawUnitsToString(intent.actualDepositRawUsdc),
    sharesMintedRaw:
      intent.sharesMintedRaw === null
        ? null
        : rawUnitsToString(intent.sharesMintedRaw),
    principalBasisBeforeRawUsdc: rawUnitsToString(
      intent.principalBasisBeforeRawUsdc
    ),
    principalBasisAfterRawUsdc:
      intent.principalBasisAfterRawUsdc === null
        ? null
        : rawUnitsToString(intent.principalBasisAfterRawUsdc),
    status: intent.status,
    expiresAt: intent.expiresAt,
    submittedAt: intent.submittedAt,
    terminalAt: intent.terminalAt,
    errorCode: intent.errorCode
  };
}

export function serializeWithdrawalIntent(intent: WithdrawalIntent) {
  return {
    withdrawalId: intent.withdrawalId,
    wallet: intent.wallet,
    vault: intent.vault,
    requestedWithdrawRawUsdc: rawUnitsToString(intent.requestedWithdrawRawUsdc),
    requestedSharesRaw: rawUnitsToString(intent.requestedSharesRaw),
    maxSharesToRedeemRaw: rawUnitsToString(intent.maxSharesToRedeemRaw),
    destinationUsdcAta: intent.destinationUsdcAta,
    preparedMessageHash: intent.preparedMessageHash,
    recentBlockhash: intent.recentBlockhash,
    lastValidBlockHeight: intent.lastValidBlockHeight,
    serializedTransaction: intent.serializedTransaction,
    txSignature: intent.txSignature,
    actualSharesBurnedRaw:
      intent.actualSharesBurnedRaw === null
        ? null
        : rawUnitsToString(intent.actualSharesBurnedRaw),
    actualWithdrawRawUsdc:
      intent.actualWithdrawRawUsdc === null
        ? null
        : rawUnitsToString(intent.actualWithdrawRawUsdc),
    principalBasisBeforeRawUsdc: rawUnitsToString(
      intent.principalBasisBeforeRawUsdc
    ),
    principalBasisAfterRawUsdc:
      intent.principalBasisAfterRawUsdc === null
        ? null
        : rawUnitsToString(intent.principalBasisAfterRawUsdc),
    status: intent.status,
    expiresAt: intent.expiresAt,
    submittedAt: intent.submittedAt,
    terminalAt: intent.terminalAt,
    errorCode: intent.errorCode,
    liquidityRejectionReason: intent.liquidityRejectionReason
  };
}
