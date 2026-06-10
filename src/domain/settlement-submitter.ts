import { unavailable } from "./errors.js";
import type { PaymentIntent } from "./models.js";
import type { SignedPaymentPayload } from "./payment-payload-verifier.js";

export interface SettlementSubmissionPreparationInput extends SignedPaymentPayload {
  intent: PaymentIntent;
  sponsorFeePayer: string | null;
}

export interface SettlementSubmissionInput {
  intent: PaymentIntent;
  sponsorFeePayer: string | null;
  txSignature: string;
  serializedSignedTransaction: string;
  /**
   * Invoked after pre-send checks succeed and immediately before the first
   * network broadcast. The service persists the payment as `submitted` here so
   * a crash between broadcast and confirmation can never be retried down a
   * path that re-simulates and misclassifies a possibly-landed transaction as
   * `failed_not_submitted`. If this callback throws, the transaction must not
   * be sent.
   */
  onBeforeSend?: () => Promise<void>;
}

export interface SettlementReconciliationInput {
  intent: PaymentIntent;
  sponsorFeePayer: string | null;
}

export interface PreparedSettlementSubmission {
  txSignature: string;
  serializedSignedTransaction: string;
}

export type SettlementSubmissionResult =
  | {
      status: "settled";
      txSignature: string;
      actualFeeLamports?: bigint;
      actualFeeDebtRawUsdc?: bigint;
      actualSharesRedeemedRaw?: bigint;
      sellerTransferRawUsdc?: bigint;
      withdrawOutputRawUsdc?: bigint;
      dustTransferRawUsdc?: bigint;
      settlementResponse?: unknown;
    }
  | {
      status: "failed";
      txSignature: string;
      errorCode: string;
      errorMessage: string;
      actualFeeLamports?: bigint;
      actualFeeDebtRawUsdc?: bigint;
      settlementResponse?: unknown;
    }
  | {
      status: "failed_not_submitted";
      errorCode: string;
      errorMessage: string;
      settlementResponse?: unknown;
    };

export type SettlementReconciliationResult =
  | SettlementSubmissionResult
  | {
      status: "submitted";
      txSignature?: string;
      settlementResponse?: unknown;
    };

export interface SettlementSubmitter {
  readonly ready: boolean;
  preparePaymentSettlementSubmission?(
    input: SettlementSubmissionPreparationInput
  ): Promise<PreparedSettlementSubmission>;
  submitPaymentSettlement(
    input: SettlementSubmissionInput
  ): Promise<SettlementSubmissionResult>;
  reconcilePaymentSettlement?(
    input: SettlementReconciliationInput
  ): Promise<SettlementReconciliationResult>;
}

export class UnsupportedSettlementSubmitter implements SettlementSubmitter {
  readonly ready = false;

  async submitPaymentSettlement(): Promise<SettlementSubmissionResult> {
    throw unavailable(
      "settlement_submitter_unavailable",
      "Settlement submission is not connected yet"
    );
  }
}

export class SettlementSubmissionError extends Error {
  readonly outcome: "failed_not_submitted" | "ambiguous";
  readonly errorCode: string;
  readonly txSignature: string | null;

  constructor(params: {
    outcome: "failed_not_submitted" | "ambiguous";
    errorCode: string;
    message: string;
    txSignature?: string | null;
  }) {
    super(params.message);
    this.name = "SettlementSubmissionError";
    this.outcome = params.outcome;
    this.errorCode = params.errorCode;
    this.txSignature = params.txSignature ?? null;
  }
}

export function isSettlementSubmissionError(
  error: unknown
): error is SettlementSubmissionError {
  return error instanceof SettlementSubmissionError;
}
