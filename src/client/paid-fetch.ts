/**
 * LEGACY buyer-side paid fetch for the old subly-yield-exact Seller flow.
 * Current standard x402 payment code lives in standard-x402-payer.ts and
 * packages/pay/src/pay.ts.
 *
 * Double-payment protection (the calling agent is assumed to retry blindly):
 *
 * - Once a payment is signed, it is tracked per URL. While the seller's
 *   challenge is still live, another call for the same URL retries delivery
 *   with the SAME signature (the seller's /settle is idempotent) instead of
 *   preparing a second payment. forceNewPayment is deliberately ignored in
 *   this state — retrying the existing signature is strictly safer.
 * - When the outcome becomes unknown (the seller stopped accepting the
 *   signature, or the challenge TTL passed without a confirmed delivery),
 *   the tracked entry is kept as a refusal marker. When a paymentStatusFor
 *   probe is configured it resolves the marker: a definitively unsettled
 *   payment is discarded and the purchase proceeds; a settled one keeps
 *   blocking with `payment_already_settled`. Otherwise further calls fail
 *   with `payment_outcome_unknown` until forceNewPayment is set.
 * - Tracked entries are removed on confirmed delivery. The map is capped;
 *   when full, the oldest entry is evicted (a dropped unresolved marker
 *   weakens the refusal gate for that URL, so the cap is generous).
 *
 * Concurrent calls for the same URL are coalesced into one flow; both callers
 * receive the same result, so parallel tool calls cannot double-pay. Note the
 * coalesced caller's own per-call options (cap, forceNewPayment) are not
 * applied — the first caller's flow wins.
 */
import {
  decodePaymentRequiredHeader,
  decodeX402Header,
  PAYMENT_REQUIRED_HEADER,
  PAYMENT_RESPONSE_HEADER,
  PAYMENT_SIGNATURE_HEADER
} from "../x402/headers.js";

export type PaidFetchLike = (
  url: string,
  init?: { headers?: Record<string, string> }
) => Promise<{
  status: number;
  headers: { get(name: string): string | null };
  text(): Promise<string>;
}>;

export interface PaymentSignatureBuilder {
  buildPaymentSignatureHeader(input: {
    paymentRequiredHeader: string;
    httpMethod: string;
    url: string;
  }): Promise<{ headerValue: string; paymentId: string }>;
}

export interface BudgetSnapshot {
  positionValueUsdc: string;
  spendableYieldUsdc: string;
}

/**
 * Probe result for a payment whose delivery was lost. "not_settled" must be
 * returned only for terminal states (expired / failed before submission);
 * anything that may still settle must be "indeterminate".
 */
export type PaymentOutcomeProbe = "settled" | "not_settled" | "indeterminate";

export interface PaidFetchServiceConfig {
  signatureBuilder: PaymentSignatureBuilder;
  /** Client-side cap applied when a call passes no maxAmountRawUsdc. */
  defaultMaxAmountRawUsdc: bigint;
  fetchImpl?: PaidFetchLike;
  /** Informational; failures must be swallowed by the implementation. */
  fetchBudget?: () => Promise<BudgetSnapshot | null>;
  /**
   * Resolves lost-delivery payments by asking the facilitator for the
   * payment status. Optional; without it unknown outcomes always require
   * forceNewPayment. Must return "indeterminate" on any doubt or failure.
   */
  paymentStatusFor?: (paymentId: string) => Promise<PaymentOutcomeProbe>;
  /**
   * How long a signed payment is considered retryable, measured from the
   * challenge fetch. Defaults slightly under the demo seller's 120s
   * challenge TTL.
   */
  pendingTtlMs?: number;
  maxTrackedUrls?: number;
  maxBodyChars?: number;
  nowMs?: () => number;
  /**
   * Optional persistence for pending-payment markers, so a process restart
   * cannot forget a signed payment with an unconfirmed delivery.
   */
  stateStore?: PendingStateStore;
}

export interface PaidFetchResult {
  paid: boolean;
  status: number;
  body: string;
  retriedPendingPayment?: boolean;
  payment?: {
    amountUsdc: string;
    payTo: string;
    paymentId: string;
    transaction: string | null;
    solscanUrl: string | null;
    budgetBefore: BudgetSnapshot | null;
    budgetAfter: BudgetSnapshot | null;
  };
}

/** Tool-level failure with a machine-readable reason for the calling agent. */
export class PaidFetchError extends Error {
  constructor(
    readonly reason:
      | "invalid_challenge"
      | "amount_exceeds_client_cap"
      | "state_persist_failed"
      | "delivery_failed_payment_pending"
      | "payment_outcome_unknown"
      | "payment_already_settled",
    message: string,
    readonly detail: unknown = null
  ) {
    super(message);
    this.name = "PaidFetchError";
  }
}

/** A signed payment whose delivery has not been confirmed yet. */
export interface PendingPayment {
  headerValue: string;
  paymentId: string;
  amountUsdc: string;
  payTo: string;
  /** TTL anchor: when the challenge was fetched, not when it was signed. */
  challengeAtMs: number;
  /** Set when the signature can no longer settle; gates re-purchase. */
  unresolved: boolean;
}

export interface PendingPaymentRecord extends PendingPayment {
  url: string;
}

/**
 * Persists pending-payment markers across process restarts so a restarted
 * server still refuses to blindly re-pay a lost delivery. Implementations
 * may return [] when no state exists, and should throw on save() when
 * persistence is not durable.
 */
export interface PendingStateStore {
  load(): PendingPaymentRecord[];
  save(records: PendingPaymentRecord[]): void;
}

const DEFAULT_PENDING_TTL_MS = 110_000;
const DEFAULT_MAX_TRACKED_URLS = 1_000;
const DEFAULT_MAX_BODY_CHARS = 20_000;

export function formatRawUsdcAmount(raw: bigint | string): string {
  const value = BigInt(raw);
  const negative = value < 0n;
  const abs = negative ? -value : value;
  const whole = abs / 1_000_000n;
  const frac = (abs % 1_000_000n).toString().padStart(6, "0");
  return `${negative ? "-" : ""}${whole}.${frac}`;
}

export class PaidFetchService {
  private readonly signatureBuilder: PaymentSignatureBuilder;
  private readonly fetchImpl: PaidFetchLike;
  private readonly fetchBudget: () => Promise<BudgetSnapshot | null>;
  private readonly paymentStatusFor: (
    paymentId: string
  ) => Promise<PaymentOutcomeProbe>;
  private readonly defaultMaxAmountRawUsdc: bigint;
  private readonly pendingTtlMs: number;
  private readonly maxTrackedUrls: number;
  private readonly maxBodyChars: number;
  private readonly nowMs: () => number;
  private readonly stateStore: PendingStateStore | null;
  private readonly pending = new Map<string, PendingPayment>();
  private readonly inFlight = new Map<string, Promise<PaidFetchResult>>();

  constructor(config: PaidFetchServiceConfig) {
    this.signatureBuilder = config.signatureBuilder;
    this.fetchImpl =
      config.fetchImpl ?? (fetch as unknown as PaidFetchLike);
    this.fetchBudget = config.fetchBudget ?? (async () => null);
    this.paymentStatusFor =
      config.paymentStatusFor ?? (async () => "indeterminate");
    this.defaultMaxAmountRawUsdc = config.defaultMaxAmountRawUsdc;
    this.pendingTtlMs = config.pendingTtlMs ?? DEFAULT_PENDING_TTL_MS;
    this.maxTrackedUrls = config.maxTrackedUrls ?? DEFAULT_MAX_TRACKED_URLS;
    this.maxBodyChars = config.maxBodyChars ?? DEFAULT_MAX_BODY_CHARS;
    this.nowMs = config.nowMs ?? (() => Date.now());
    this.stateStore = config.stateStore ?? null;
    if (this.stateStore !== null) {
      for (const record of this.stateStore.load()) {
        const { url, ...entry } = record;
        this.pending.set(url, entry);
      }
    }
  }

  /**
   * GET the URL, paying a 402 challenge when needed. Concurrent calls for the
   * same URL share one flow and one result.
   */
  paidFetch(params: {
    url: string;
    maxAmountRawUsdc?: bigint;
    forceNewPayment?: boolean;
  }): Promise<PaidFetchResult> {
    const existing = this.inFlight.get(params.url);
    if (existing !== undefined) {
      return existing;
    }
    const flow = this.run(params).finally(() => {
      this.inFlight.delete(params.url);
    });
    this.inFlight.set(params.url, flow);
    return flow;
  }

  private async run(params: {
    url: string;
    maxAmountRawUsdc?: bigint;
    forceNewPayment?: boolean;
  }): Promise<PaidFetchResult> {
    const { url } = params;
    const pending = this.pending.get(url);
    if (pending !== undefined) {
      const expired =
        this.nowMs() - pending.challengeAtMs > this.pendingTtlMs;
      if (pending.unresolved || expired) {
        if (params.forceNewPayment === true) {
          this.untrack(url);
        } else {
          const outcome = await this.paymentStatusFor(pending.paymentId);
          if (outcome === "not_settled") {
            // The facilitator confirmed the payment never settled; it is
            // safe to purchase fresh.
            this.untrack(url);
          } else if (outcome === "settled") {
            throw new PaidFetchError(
              "payment_already_settled",
              `the previous payment for this URL settled (paymentId=${pending.paymentId}) ` +
                "but the content delivery was lost, and the signature can no " +
                "longer be retried. Calling again with forceNewPayment=true " +
                "will PAY A SECOND TIME for the same resource.",
              { paymentId: pending.paymentId }
            );
          } else {
            throw new PaidFetchError(
              "payment_outcome_unknown",
              `a previously signed payment for this URL (paymentId=${pending.paymentId}) ` +
                "has an unknown outcome. Verify whether it settled before " +
                "purchasing again; to pay again anyway, call this tool with " +
                "forceNewPayment=true.",
              { paymentId: pending.paymentId }
            );
          }
        }
      } else {
        // Live and retryable: always retry the same signature. A new payment
        // here could double-pay, so forceNewPayment is intentionally ignored.
        return this.deliver(url, pending, {
          retried: true,
          budgetBefore: null
        });
      }
    }

    const challengeAtMs = this.nowMs();
    const first = await this.fetchImpl(url);
    const firstText = await first.text();
    if (first.status !== 402) {
      return {
        paid: false,
        status: first.status,
        body: this.truncated(firstText)
      };
    }

    const challengeHeader = first.headers.get(PAYMENT_REQUIRED_HEADER);
    if (challengeHeader === null) {
      throw new PaidFetchError(
        "invalid_challenge",
        "402 response is missing the PAYMENT-REQUIRED header"
      );
    }
    const requirement =
      decodePaymentRequiredHeader(challengeHeader).sublyRequirements[0];
    if (requirement === undefined) {
      throw new PaidFetchError(
        "invalid_challenge",
        "402 challenge contains no subly-yield-exact requirement"
      );
    }

    const amountRawUsdc = BigInt(requirement.amountRawUsdc);
    const maxAmountRawUsdc =
      params.maxAmountRawUsdc ?? this.defaultMaxAmountRawUsdc;
    if (amountRawUsdc > maxAmountRawUsdc) {
      throw new PaidFetchError(
        "amount_exceeds_client_cap",
        `the challenge demands ${formatRawUsdcAmount(amountRawUsdc)} USDC, above ` +
          `this tool call's cap of ${formatRawUsdcAmount(maxAmountRawUsdc)} USDC; ` +
          "nothing was paid. Raise maxAmountRawUsdc only if this price is expected.",
        {
          amountRawUsdc: requirement.amountRawUsdc,
          maxAmountRawUsdc: maxAmountRawUsdc.toString(),
          payTo: requirement.payTo
        }
      );
    }

    const budgetBefore = await this.fetchBudget();
    const { headerValue, paymentId } =
      await this.signatureBuilder.buildPaymentSignatureHeader({
        paymentRequiredHeader: challengeHeader,
        httpMethod: "GET",
        url
      });
    const entry: PendingPayment = {
      headerValue,
      paymentId,
      amountUsdc: formatRawUsdcAmount(amountRawUsdc),
      payTo: requirement.payTo,
      challengeAtMs,
      unresolved: false
    };
    this.track(url, entry);

    return this.deliver(url, entry, { retried: false, budgetBefore });
  }

  /**
   * Sends the signed PAYMENT-SIGNATURE retry. The tracked entry is removed
   * only on confirmed delivery (200). A fresh 402 proves the signature can no
   * longer settle, so the entry is kept as an unresolved marker; every other
   * failure keeps it retryable so the next call reuses the same signature.
   */
  private async deliver(
    url: string,
    entry: PendingPayment,
    params: { retried: boolean; budgetBefore: BudgetSnapshot | null }
  ): Promise<PaidFetchResult> {
    let second: Awaited<ReturnType<PaidFetchLike>>;
    let secondText: string;
    try {
      second = await this.fetchImpl(url, {
        headers: { [PAYMENT_SIGNATURE_HEADER]: entry.headerValue }
      });
      secondText = await second.text();
    } catch (error) {
      throw new PaidFetchError(
        "delivery_failed_payment_pending",
        `delivery request failed in flight (${
          error instanceof Error ? error.message : String(error)
        }); the payment (paymentId=${entry.paymentId}) is already signed and ` +
          "may settle. Call this tool again with the same URL to retry " +
          "delivery with the same payment signature — do NOT treat this as " +
          "unpaid.",
        { paymentId: entry.paymentId }
      );
    }

    if (second.status === 200) {
      this.clearDelivered(url);
      const transaction = receiptTransaction(second.headers);
      return {
        paid: true,
        status: second.status,
        body: this.truncated(secondText),
        ...(params.retried ? { retriedPendingPayment: true } : {}),
        payment: {
          amountUsdc: entry.amountUsdc,
          payTo: entry.payTo,
          paymentId: entry.paymentId,
          transaction,
          solscanUrl:
            transaction === null
              ? null
              : `https://solscan.io/tx/${transaction}`,
          budgetBefore: params.budgetBefore,
          budgetAfter: await this.fetchBudget()
        }
      };
    }

    if (second.status === 402) {
      // The seller no longer accepts this signature (challenge expired or the
      // seller restarted). Whether the payment settled is unknown; keep the
      // entry so plain re-calls are refused until forceNewPayment.
      entry.unresolved = true;
      try {
        this.persist();
      } catch (error) {
        entry.unresolved = false;
        throw new PaidFetchError(
          "payment_outcome_unknown",
          `the seller no longer accepts the signed payment (paymentId=${entry.paymentId}); ` +
            "it may or may not have settled, and the unresolved marker could " +
            "not be persisted. Verify the payment before purchasing again.",
          { paymentId: entry.paymentId, persistError: error }
        );
      }
      throw new PaidFetchError(
        "payment_outcome_unknown",
        `the seller no longer accepts the signed payment (paymentId=${entry.paymentId}); ` +
          "it may or may not have settled. Verify the payment before " +
          "purchasing again; to pay again anyway, call this tool with " +
          "forceNewPayment=true.",
        { paymentId: entry.paymentId }
      );
    }

    throw new PaidFetchError(
      "delivery_failed_payment_pending",
      `paid delivery failed with ${second.status} (paymentId=${entry.paymentId}); ` +
        "the payment may already have settled. Call this tool again with the " +
        "same URL to retry delivery with the same payment signature — do NOT " +
        "treat this as unpaid.",
      {
        paymentId: entry.paymentId,
        status: second.status,
        body: this.truncated(secondText)
      }
    );
  }

  private track(url: string, entry: PendingPayment): void {
    const previous = new Map(this.pending);
    if (!this.pending.has(url) && this.pending.size >= this.maxTrackedUrls) {
      const oldest = this.pending.keys().next();
      if (!oldest.done) {
        this.pending.delete(oldest.value);
      }
    }
    this.pending.set(url, entry);
    try {
      this.persist();
    } catch (error) {
      this.pending.clear();
      for (const [previousUrl, previousEntry] of previous.entries()) {
        this.pending.set(previousUrl, previousEntry);
      }
      throw new PaidFetchError(
        "state_persist_failed",
        `could not persist the signed payment marker (paymentId=${entry.paymentId}); ` +
          "refusing to deliver it because a restart would not be double-payment safe",
        { paymentId: entry.paymentId, error }
      );
    }
  }

  private untrack(url: string): void {
    const previous = new Map(this.pending);
    this.pending.delete(url);
    try {
      this.persist();
    } catch (error) {
      this.pending.clear();
      for (const [previousUrl, previousEntry] of previous.entries()) {
        this.pending.set(previousUrl, previousEntry);
      }
      throw new PaidFetchError(
        "state_persist_failed",
        "could not persist pending-payment marker removal",
        error
      );
    }
  }

  private clearDelivered(url: string): void {
    const previous = new Map(this.pending);
    this.pending.delete(url);
    try {
      this.persist();
    } catch (error) {
      this.pending.clear();
      for (const [previousUrl, previousEntry] of previous.entries()) {
        this.pending.set(previousUrl, previousEntry);
      }
      console.error(
        `[subly-pay] payment delivered but pending marker could not be ` +
          `cleared: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  private persist(): void {
    if (this.stateStore === null) {
      return;
    }
    this.stateStore.save(
      [...this.pending.entries()].map(([url, entry]) => ({ url, ...entry }))
    );
  }

  private truncated(text: string): string {
    return text.length > this.maxBodyChars
      ? `${text.slice(0, this.maxBodyChars)}\n... (truncated)`
      : text;
  }
}

function receiptTransaction(headers: {
  get(name: string): string | null;
}): string | null {
  // The receipt header is informational; a malformed header must not fail a
  // payment that already settled.
  try {
    const receiptHeader = headers.get(PAYMENT_RESPONSE_HEADER);
    if (receiptHeader === null) {
      return null;
    }
    const receipt = decodeX402Header(receiptHeader) as {
      transaction?: unknown;
    };
    return typeof receipt.transaction === "string" &&
      receipt.transaction.length > 0
      ? receipt.transaction
      : null;
  } catch {
    return null;
  }
}
