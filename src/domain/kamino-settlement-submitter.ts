import type { KeyPairSigner } from "@solana/kit";
import type { TransactionSubmissionEngine, ConfirmedTransactionSummary } from "../solana/submission.js";
import {
  addSignaturesToSerializedTransaction,
  signatureBase58ForSigner
} from "../solana/tx.js";
import type { PaymentIntent } from "./models.js";
import {
  SettlementSubmissionError,
  type PreparedSettlementSubmission,
  type SettlementReconciliationInput,
  type SettlementReconciliationResult,
  type SettlementSubmissionInput,
  type SettlementSubmissionPreparationInput,
  type SettlementSubmissionResult,
  type SettlementSubmitter
} from "./settlement-submitter.js";

export type FeeLamportsToUsdcConverter = (
  feeLamports: bigint
) => Promise<bigint>;

export class KaminoSettlementSubmitter implements SettlementSubmitter {
  readonly ready = true;
  private readonly engine: TransactionSubmissionEngine;
  private readonly sponsor: KeyPairSigner;
  private readonly feeLamportsToUsdc: FeeLamportsToUsdcConverter | null;

  constructor(params: {
    engine: TransactionSubmissionEngine;
    sponsor: KeyPairSigner;
    feeLamportsToUsdc?: FeeLamportsToUsdcConverter;
  }) {
    this.engine = params.engine;
    this.sponsor = params.sponsor;
    this.feeLamportsToUsdc = params.feeLamportsToUsdc ?? null;
  }

  async preparePaymentSettlementSubmission(
    input: SettlementSubmissionPreparationInput
  ): Promise<PreparedSettlementSubmission> {
    if (input.sponsorFeePayer !== this.sponsor.address) {
      throw new SettlementSubmissionError({
        outcome: "failed_not_submitted",
        errorCode: "sponsor_mismatch",
        message:
          "Configured sponsor signer does not match the service sponsor fee payer"
      });
    }

    const { serializedBase64, transaction } =
      await addSignaturesToSerializedTransaction({
        serializedBase64: input.serializedTransaction,
        signers: [this.sponsor.keyPair]
      });

    const txSignature = signatureBase58ForSigner(transaction, this.sponsor.address);
    if (txSignature === null) {
      throw new SettlementSubmissionError({
        outcome: "failed_not_submitted",
        errorCode: "sponsor_signature_missing",
        message: "Sponsor signature could not be applied to the settlement transaction"
      });
    }

    return {
      txSignature,
      serializedSignedTransaction: serializedBase64
    };
  }

  async submitPaymentSettlement(
    input: SettlementSubmissionInput
  ): Promise<SettlementSubmissionResult> {
    // A retried submission may already be on-chain (crash after a previous
    // send). The landed transaction is the source of truth; re-simulating it
    // would misclassify the settlement as failed_not_submitted.
    const existing = await this.engine.lookupTransaction(input.txSignature);
    if (existing.found) {
      return this.mapConfirmedTransaction(
        input.intent,
        input.txSignature,
        existing
      );
    }

    const simulation = await this.engine.simulateSignedTransaction(
      input.serializedSignedTransaction
    );
    if (simulation.err !== null) {
      return {
        status: "failed_not_submitted",
        errorCode: "simulation_failed",
        errorMessage: `Settlement simulation failed before submission: ${JSON.stringify(simulation.err)}`
      };
    }

    // The intent must be durably marked submitted before the first broadcast;
    // from this point on, retries reconcile by stored signature instead of
    // re-simulating, because the transaction may land at any time.
    await input.onBeforeSend?.();

    try {
      await this.engine.sendSignedTransaction(input.serializedSignedTransaction);
    } catch (error) {
      // The RPC node may have accepted the transaction before the transport
      // failed, so a send error is ambiguous rather than failed_not_submitted.
      throw new SettlementSubmissionError({
        outcome: "ambiguous",
        errorCode: "send_failed",
        message:
          error instanceof Error
            ? `Settlement send failed: ${error.message}`
            : "Settlement send failed",
        txSignature: input.txSignature
      });
    }

    const confirmation = await this.engine.waitForConfirmation({
      txSignature: input.txSignature,
      lastValidBlockHeight: input.intent.lastValidBlockHeight
    });
    if (confirmation.status === "expired") {
      return {
        status: "failed_not_submitted",
        errorCode: "blockhash_expired",
        errorMessage:
          "Settlement transaction expired without landing before its last valid block height"
      };
    }
    if (confirmation.status === "timeout") {
      throw new SettlementSubmissionError({
        outcome: "ambiguous",
        errorCode: "confirmation_timeout",
        message: "Settlement confirmation timed out; reconcile by stored signature",
        txSignature: input.txSignature
      });
    }

    return this.finalizeFromChain(input.intent, input.txSignature);
  }

  async reconcilePaymentSettlement(
    input: SettlementReconciliationInput
  ): Promise<SettlementReconciliationResult> {
    const txSignature = input.intent.txSignature;
    const storedTransaction = input.intent.submittedSerializedTransaction;
    if (txSignature === null || storedTransaction === null) {
      return {
        status: "failed_not_submitted",
        errorCode: "submission_record_missing",
        errorMessage:
          "No stored settlement submission record exists for reconciliation"
      };
    }

    const lookup = await this.engine.lookupTransaction(txSignature);
    if (lookup.found) {
      return this.mapConfirmedTransaction(input.intent, txSignature, lookup);
    }

    if (await this.engine.isBlockhashExpired(input.intent.lastValidBlockHeight)) {
      return {
        status: "failed_not_submitted",
        errorCode: "blockhash_expired",
        errorMessage:
          "Settlement transaction expired without landing before its last valid block height"
      };
    }

    // Still within the blockhash window: resend the exact stored bytes (same
    // signature, never a new transaction) and stay in submitted state.
    try {
      await this.engine.sendSignedTransaction(storedTransaction);
    } catch {
      // Resend is best effort; the recovery worker will retry.
    }

    return { status: "submitted", txSignature };
  }

  private async finalizeFromChain(
    intent: PaymentIntent,
    txSignature: string
  ): Promise<SettlementSubmissionResult> {
    const lookup = await this.engine.lookupTransaction(txSignature);
    if (!lookup.found) {
      throw new SettlementSubmissionError({
        outcome: "ambiguous",
        errorCode: "confirmed_transaction_not_found",
        message:
          "Settlement was confirmed but the transaction could not be loaded yet",
        txSignature
      });
    }

    return this.mapConfirmedTransaction(intent, txSignature, lookup);
  }

  private async mapConfirmedTransaction(
    intent: PaymentIntent,
    txSignature: string,
    summary: ConfirmedTransactionSummary
  ): Promise<SettlementSubmissionResult> {
    const actualFeeDebtRawUsdc = await this.tryConvertFee(summary.feeLamports);

    if (summary.err !== null) {
      return {
        status: "failed",
        txSignature,
        errorCode: "landed_failed",
        errorMessage: `Settlement transaction landed but failed on-chain: ${JSON.stringify(summary.err)}`,
        actualFeeLamports: summary.feeLamports,
        ...(actualFeeDebtRawUsdc === null ? {} : { actualFeeDebtRawUsdc })
      };
    }

    const sellerDelta =
      summary.tokenBalanceDeltas.get(intent.sellerUsdcAta) ?? 0n;
    // Prepare rejects self-payments, so these accounts differ; the guard
    // keeps a same-account payload from double-counting the withdraw output.
    const dustDelta =
      intent.dustRecipientUsdcAta === intent.sellerUsdcAta
        ? undefined
        : summary.tokenBalanceDeltas.get(intent.dustRecipientUsdcAta);
    const withdrawOutputRawUsdc =
      sellerDelta + (dustDelta !== undefined && dustDelta > 0n ? dustDelta : 0n);

    return {
      status: "settled",
      txSignature,
      actualFeeLamports: summary.feeLamports,
      ...(actualFeeDebtRawUsdc === null ? {} : { actualFeeDebtRawUsdc }),
      actualSharesRedeemedRaw: intent.sharesToRedeemRaw,
      sellerTransferRawUsdc: sellerDelta,
      withdrawOutputRawUsdc,
      ...(dustDelta !== undefined && dustDelta > 0n
        ? { dustTransferRawUsdc: dustDelta }
        : { dustTransferRawUsdc: 0n })
    };
  }

  private async tryConvertFee(feeLamports: bigint): Promise<bigint | null> {
    if (this.feeLamportsToUsdc === null) {
      return null;
    }

    try {
      return await this.feeLamportsToUsdc(feeLamports);
    } catch {
      // Fall back to the reserved estimate when the oracle is unavailable at
      // finalization time; the service applies estimated fee debt instead.
      return null;
    }
  }
}
