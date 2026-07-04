export type PrincipalBasisSource =
  | "empty"
  | "kamino_pnl_current"
  | "subly_receipts"
  | "conservative_activation_reset"
  | "manual_trusted_seed";

export type WalletPositionStatus =
  | "active"
  | "needs_baseline_reset"
  | "observed_only";

export type SigningMode = "non_interactive" | "observed_only";
export type SignerValidationMode =
  | "unverified"
  | "structured_intent_transaction";

export type PaymentStatus =
  | "prepared"
  | "submission_prepared"
  | "submitted"
  | "settled"
  | "failed"
  | "expired"
  | "failed_not_submitted";

export interface ProvenancedRawValue {
  sourceEndpoint: string;
  fieldPath: string;
  observedAt?: string;
  observedSlot?: number;
  rawValue: string;
  unitKind:
    | "raw_usdc"
    | "raw_vault_shares"
    | "decimal_usdc"
    | "decimal_vault_shares"
    | "exchange_rate_scaled";
  normalizedRawUnits: bigint;
}

export interface WalletPosition {
  wallet: string;
  vault: string;
  signingPolicyId: string | null;
  signingMode: SigningMode;
  signerValidationMode: SignerValidationMode;
  signerProvider: string;
  stakedSharesRaw: bigint;
  unstakedSharesRaw: bigint;
  totalSharesRaw: bigint;
  exchangeRateScaled: bigint;
  instantRedeemCapacityRawUsdc: bigint;
  principalBasisRawUsdc: bigint;
  principalBasisSource: PrincipalBasisSource;
  reservedRawUsdc: bigint;
  feeDebtRawUsdc: bigint;
  safetyBufferRawUsdc: bigint;
  kaminoPositionSnapshot: ProvenancedRawValue[];
  kaminoPnlSnapshot: ProvenancedRawValue[];
  lastSyncedSlot: number | null;
  version: number;
  status: WalletPositionStatus;
}

export type VaultFlowStatus =
  | "prepared"
  | "submitted"
  | "confirmed"
  | "failed"
  | "expired"
  | "failed_not_submitted";

export interface DepositIntent {
  depositId: string;
  wallet: string;
  vault: string;
  amountRawUsdc: bigint;
  preparedMessageHash: string;
  recentBlockhash: string | null;
  lastValidBlockHeight: number | null;
  serializedTransaction: string;
  txSignature: string | null;
  submittedSerializedTransaction: string | null;
  actualDepositRawUsdc: bigint | null;
  sharesMintedRaw: bigint | null;
  principalBasisBeforeRawUsdc: bigint;
  principalBasisAfterRawUsdc: bigint | null;
  status: VaultFlowStatus;
  expiresAt: string;
  submittedAt: string | null;
  terminalAt: string | null;
  errorCode: string | null;
}

/**
 * Payment binding attached to a yield-realize withdrawal: the declared
 * "what is being paid" that spending caps and the audit log key off.
 * Amounts stay strings here so the JSONB round-trip is lossless.
 */
export interface PaymentBindingWire {
  payTo: string;
  amountRawUsdc: string;
  resourceUrlHash: string;
  method: string;
}

export type PaymentVerification = "verified_onchain" | "reported" | "unreported";

export interface WithdrawalIntent {
  withdrawalId: string;
  wallet: string;
  vault: string;
  /** "yield_realize" funds an x402 payment; "normal" is a principal exit. */
  purpose: "normal" | "yield_realize";
  paymentBinding: PaymentBindingWire | null;
  /** Policy that authorized this realize: "default" or "mandate:<hash>". */
  policySource: string | null;
  mandateHash: string | null;
  /** "auto_within_policy" | "owner_approved:<approvalId>" | "unenforced". */
  policyDecision: string | null;
  approvalId: string | null;
  /** Report-back of the client-side x402 payment tx (best-effort audit link). */
  paymentTxSignature: string | null;
  paymentVerification: PaymentVerification | null;
  requestedWithdrawRawUsdc: bigint;
  requestedSharesRaw: bigint;
  maxSharesToRedeemRaw: bigint;
  destinationUsdcAta: string;
  preparedMessageHash: string;
  recentBlockhash: string | null;
  lastValidBlockHeight: number | null;
  serializedTransaction: string;
  txSignature: string | null;
  submittedSerializedTransaction: string | null;
  actualSharesBurnedRaw: bigint | null;
  actualWithdrawRawUsdc: bigint | null;
  principalBasisBeforeRawUsdc: bigint;
  principalBasisAfterRawUsdc: bigint | null;
  status: VaultFlowStatus;
  expiresAt: string;
  submittedAt: string | null;
  terminalAt: string | null;
  errorCode: string | null;
  liquidityRejectionReason: string | null;
}

export type SyncEventType =
  | "wallet_sync"
  | "deposit_confirmed"
  | "withdrawal_confirmed"
  | "payment_settled"
  | "payment_landed_failed"
  | "external_share_movement";

export interface SyncEvent {
  eventId: string;
  wallet: string;
  vault: string;
  eventType: SyncEventType;
  txSignature: string | null;
  /** Signed share delta observed for the event (may be negative). */
  deltaSharesRaw: bigint;
  /** Signed principal-basis delta applied by the event (may be negative). */
  deltaPrincipalRawUsdc: bigint;
  classification: string;
  sourceEndpoint: string;
  rawSnapshot: unknown;
  slot: number | null;
  observedAt: string;
}

export type SpendingMandateStatus = "active" | "revoked" | "recovery_pending";

/**
 * Registered spending mandate (docs/spending-mandate-design.md). The raw
 * signed document is kept verbatim for third-party re-verification; all
 * fields here are JSON-safe (no bigints) so persistence is lossless.
 */
export interface SpendingMandateRecord {
  wallet: string;
  vault: string;
  /** The full submitted document, signatures included. */
  documentJson: unknown;
  mandateHash: string;
  ownerAuth: "ed25519" | "passkey";
  ownerCredential: { publicKey: string; credentialId?: string | undefined };
  enforcementMode: "subly" | "wallet_infra";
  issuedAtMs: number;
  expiresAtMs: number;
  status: SpendingMandateStatus;
  /** When a pending recovery-revoke (dead-man switch) takes effect. */
  recoveryAtMs: number | null;
  revokedAtMs: number | null;
  revokeJson: unknown | null;
}

export type SpendingMandateEventType =
  | "registered"
  | "replaced"
  | "revoked"
  | "recovery_scheduled"
  | "recovery_cancelled";

/** Append-only history of mandate lifecycle transitions (audit trail). */
export interface SpendingMandateEvent {
  eventId: string;
  wallet: string;
  eventType: SpendingMandateEventType;
  mandateHash: string;
  documentJson: unknown;
  createdAtMs: number;
}

export type SpendingApprovalStatus =
  | "pending"
  | "approved"
  | "denied"
  | "expired"
  | "consumed";

/**
 * Owner approval for one operation above the mandate threshold. Single-use,
 * bound to the exact operation content (bindingHash), 15 min TTL. Shared by
 * payment / deposit / withdrawal escalations.
 */
export interface SpendingApproval {
  approvalId: string;
  wallet: string;
  bindingHash: string;
  bindingJson: unknown;
  mandateHash: string;
  status: SpendingApprovalStatus;
  decisionJson: unknown | null;
  requestedAtMs: number;
  expiresAtMs: number;
  decidedAtMs: number | null;
  consumedAtMs: number | null;
  consumedByWithdrawalId: string | null;
}

export interface SellerLiquidityPolicy {
  sellerClass: string;
  vault: string;
  expectedPaymentSizeRawUsdc: bigint;
  minInstantLiquidityRawUsdc: bigint;
  targetBudgetIlliquidRate: number;
  status: "active" | "disabled";
}

export interface PaymentIntent {
  paymentId: string;
  wallet: string;
  vault: string;
  seller: string;
  sellerRequestId: string;
  httpMethod: string;
  canonicalResourceUrl: string;
  requestBodyHash: string;
  requestBindingHash: string;
  asset: string;
  amountRawUsdc: bigint;
  payTo: string;
  sellerUsdcAta: string;
  dustRecipientUsdcAta: string;
  signingPolicyId: string;
  preparedMessageHash: string;
  recentBlockhash: string | null;
  lastValidBlockHeight: number | null;
  temporarySettlementTokenAccount: string;
  temporarySettlementSignature: string;
  sharesToRedeemRaw: bigint;
  requiredWithdrawRawUsdc: bigint;
  estimatedFeeLamports: bigint;
  estimatedFeeDebtRawUsdc: bigint;
  principalBasisBeforeRawUsdc: bigint;
  grossYieldBeforeRawUsdc: bigint;
  spendableYieldBeforeRawUsdc: bigint;
  postPositionValueRawUsdc: bigint;
  reservationRawUsdc: bigint;
  status: PaymentStatus;
  expiresAt: string;
  submittedAt: string | null;
  terminalAt: string | null;
  txSignature: string | null;
  submittedSerializedTransaction: string | null;
  settlementResponse: unknown | null;
  intentJson: unknown;
}
