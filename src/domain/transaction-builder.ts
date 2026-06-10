import { unavailable } from "./errors.js";

export interface CanonicalPaymentSettlementInput {
  paymentId: string;
  wallet: string;
  vault: string;
  shareMint: string;
  usdcMint: string;
  feePayer: string | null;
  seller: string;
  sellerRequestId: string;
  requestBindingHash: string;
  httpMethod: string;
  canonicalResourceUrl: string;
  requestBodyHash: string;
  amountRawUsdc: bigint;
  payTo: string;
  sellerUsdcAta: string;
  dustRecipientUsdcAta: string;
  sharesToRedeemRaw: bigint;
  requiredWithdrawRawUsdc: bigint;
  memo: string;
  expiresAt: string;
}

export interface PreparedSettlementTransaction {
  preparedMessageHash: string;
  recentBlockhash: string | null;
  lastValidBlockHeight: number | null;
  temporarySettlementTokenAccount: string;
  temporarySettlementSignature: string;
  serializedTransaction: string;
  /**
   * Exact share amount burned by the canonical transaction's withdraw
   * instruction. May be below the signer-approved maximum passed to the
   * builder; the ledger must track this value, not the maximum.
   */
  sharesToRedeemRaw?: bigint;
}

export interface SettlementWithdrawQuoteInput {
  wallet: string;
  vault: string;
  amountRawUsdc: bigint;
}

/**
 * Payment-critical current state quoted from on-chain data immediately before
 * budget evaluation. All values are raw integers.
 */
export interface SettlementQuote {
  requiredWithdrawRawUsdc: bigint;
  sharesToRedeemRaw: bigint;
  withdrawalPenaltyRawUsdc: bigint;
  exchangeRateScaled: bigint;
  instantRedeemCapacityRawUsdc: bigint;
  userStakedSharesRaw: bigint;
  userUnstakedSharesRaw: bigint;
  userTotalSharesRaw: bigint;
  observedSlot: number;
}

export interface CanonicalTransactionBuilder {
  preparePaymentSettlement(
    input: CanonicalPaymentSettlementInput
  ): Promise<PreparedSettlementTransaction>;
  /**
   * Quotes the gross withdraw, share burn, and fresh on-chain position state
   * for a seller payment. When implemented, the payment service must use this
   * quote as the source of truth for budget evaluation instead of the last
   * synced ledger snapshot.
   */
  quoteSettlementWithdraw?(
    input: SettlementWithdrawQuoteInput
  ): Promise<SettlementQuote>;
}

export class UnsupportedCanonicalTransactionBuilder
  implements CanonicalTransactionBuilder
{
  async preparePaymentSettlement(): Promise<PreparedSettlementTransaction> {
    throw unavailable(
      "transaction_builder_unavailable",
      "Kamino low-level settlement transaction builder is not connected yet; no payment reservation was created"
    );
  }
}
