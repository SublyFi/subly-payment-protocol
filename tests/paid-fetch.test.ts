import { describe, expect, it, vi } from "vitest";
import { PAYMENT_SCHEME } from "../src/config/constants.js";
import {
  PaidFetchError,
  PaidFetchService,
  formatRawUsdcAmount,
  type PaidFetchLike,
  type PaymentOutcomeProbe,
  type PaymentSignatureBuilder
} from "../src/client/paid-fetch.js";
import {
  encodeX402Header,
  PAYMENT_REQUIRED_HEADER,
  PAYMENT_RESPONSE_HEADER,
  PAYMENT_SIGNATURE_HEADER
} from "../src/x402/headers.js";

const URL_A = "http://seller.test/api/premium";
const ADDRESS = "A".repeat(40);

function challengeHeaderFor(url: string, amountRawUsdc = "100"): string {
  return encodeX402Header({
    x402Version: 2,
    accepts: [
      {
        scheme: PAYMENT_SCHEME,
        network: "solana:test",
        asset: ADDRESS,
        amountRawUsdc,
        resource: url,
        payTo: ADDRESS,
        maxTimeoutSeconds: 120,
        extra: {
          sellerRequestId: "seller_req_1",
          seller: ADDRESS,
          sellerUsdcAta: ADDRESS,
          vault: ADDRESS,
          shareMint: ADDRESS
        }
      }
    ]
  });
}

type FakeResponse = Awaited<ReturnType<PaidFetchLike>>;

function response(
  status: number,
  body: string,
  headers: Record<string, string> = {}
): FakeResponse {
  return {
    status,
    headers: { get: (name: string) => headers[name] ?? null },
    text: async () => body
  };
}

function challengeResponse(url: string, amountRawUsdc = "100"): FakeResponse {
  return response(402, "payment required", {
    [PAYMENT_REQUIRED_HEADER]: challengeHeaderFor(url, amountRawUsdc)
  });
}

function deliveredResponse(transaction: string | null = "tx_sig_1"): FakeResponse {
  return response(
    200,
    JSON.stringify({ premium: true }),
    transaction === null
      ? {}
      : { [PAYMENT_RESPONSE_HEADER]: encodeX402Header({ transaction }) }
  );
}

/** Scripted fetch: each call consumes the next handler in the queue. */
function scriptedFetch() {
  const queue: Array<
    (url: string, init?: { headers?: Record<string, string> }) => Promise<FakeResponse>
  > = [];
  const calls: Array<{ url: string; init?: { headers?: Record<string, string> } }> = [];
  const fetchImpl: PaidFetchLike = (url, init) => {
    calls.push({ url, ...(init === undefined ? {} : { init }) });
    const handler = queue.shift();
    if (handler === undefined) {
      throw new Error("scripted fetch queue exhausted");
    }
    return handler(url, init);
  };
  return { fetchImpl, queue, calls };
}

function builderStub(): PaymentSignatureBuilder & {
  buildPaymentSignatureHeader: ReturnType<typeof vi.fn>;
} {
  let counter = 0;
  return {
    buildPaymentSignatureHeader: vi.fn(async () => {
      counter += 1;
      return { headerValue: `sig-${counter}`, paymentId: `pay_${counter}` };
    })
  };
}

function serviceWith(params: {
  fetchImpl: PaidFetchLike;
  builder?: PaymentSignatureBuilder;
  nowMs?: () => number;
  maxTrackedUrls?: number;
  paymentStatusFor?: (paymentId: string) => Promise<PaymentOutcomeProbe>;
}) {
  return new PaidFetchService({
    signatureBuilder: params.builder ?? builderStub(),
    defaultMaxAmountRawUsdc: 10_000n,
    fetchImpl: params.fetchImpl,
    ...(params.nowMs === undefined ? {} : { nowMs: params.nowMs }),
    ...(params.maxTrackedUrls === undefined
      ? {}
      : { maxTrackedUrls: params.maxTrackedUrls }),
    ...(params.paymentStatusFor === undefined
      ? {}
      : { paymentStatusFor: params.paymentStatusFor })
  });
}

/** Drives a service into the unresolved state for URL_A (retry hit a 402). */
async function intoUnresolved(
  service: PaidFetchService,
  s: ReturnType<typeof scriptedFetch>
): Promise<void> {
  s.queue.push(async (url) => challengeResponse(url));
  s.queue.push(async () => response(502, "unreachable"));
  await expect(service.paidFetch({ url: URL_A })).rejects.toMatchObject({
    reason: "delivery_failed_payment_pending"
  });
  s.queue.push(async (url) => challengeResponse(url));
  await expect(service.paidFetch({ url: URL_A })).rejects.toMatchObject({
    reason: "payment_outcome_unknown"
  });
}

describe("PaidFetchService", () => {
  it("passes non-402 responses through without paying", async () => {
    const { fetchImpl } = (() => {
      const s = scriptedFetch();
      s.queue.push(async () => response(200, "free content"));
      return s;
    })();
    const builder = builderStub();
    const service = serviceWith({ fetchImpl, builder });

    const result = await service.paidFetch({ url: URL_A });
    expect(result).toEqual({ paid: false, status: 200, body: "free content" });
    expect(builder.buildPaymentSignatureHeader).not.toHaveBeenCalled();
  });

  it("refuses challenges above the default cap before preparing", async () => {
    const s = scriptedFetch();
    s.queue.push(async (url) => challengeResponse(url, "20000"));
    const builder = builderStub();
    const service = serviceWith({ fetchImpl: s.fetchImpl, builder });

    await expect(service.paidFetch({ url: URL_A })).rejects.toMatchObject({
      reason: "amount_exceeds_client_cap"
    });
    expect(builder.buildPaymentSignatureHeader).not.toHaveBeenCalled();
  });

  it("applies a per-call cap override", async () => {
    const s = scriptedFetch();
    s.queue.push(async (url) => challengeResponse(url, "100"));
    const service = serviceWith({ fetchImpl: s.fetchImpl });

    await expect(
      service.paidFetch({ url: URL_A, maxAmountRawUsdc: 50n })
    ).rejects.toMatchObject({ reason: "amount_exceeds_client_cap" });
  });

  it("pays a challenge and reports the receipt", async () => {
    const s = scriptedFetch();
    s.queue.push(async (url) => challengeResponse(url));
    s.queue.push(async () => deliveredResponse("tx_sig_1"));
    const builder = builderStub();
    const service = serviceWith({ fetchImpl: s.fetchImpl, builder });

    const result = await service.paidFetch({ url: URL_A });
    expect(result.paid).toBe(true);
    expect(result.retriedPendingPayment).toBeUndefined();
    expect(result.payment).toMatchObject({
      amountUsdc: "0.000100",
      paymentId: "pay_1",
      transaction: "tx_sig_1",
      solscanUrl: "https://solscan.io/tx/tx_sig_1"
    });
    expect(
      s.calls[1]?.init?.headers?.[PAYMENT_SIGNATURE_HEADER]
    ).toBe("sig-1");

    // A delivered payment is settled state, not pending: the next call for
    // the same URL is a fresh purchase.
    s.queue.push(async (url) => challengeResponse(url));
    s.queue.push(async () => deliveredResponse("tx_sig_2"));
    const second = await service.paidFetch({ url: URL_A });
    expect(second.payment?.paymentId).toBe("pay_2");
    expect(builder.buildPaymentSignatureHeader).toHaveBeenCalledTimes(2);
  });

  it("retries the same signature after an in-flight delivery failure", async () => {
    const s = scriptedFetch();
    s.queue.push(async (url) => challengeResponse(url));
    s.queue.push(async () => {
      throw new Error("socket hang up");
    });
    const builder = builderStub();
    const service = serviceWith({ fetchImpl: s.fetchImpl, builder });

    await expect(service.paidFetch({ url: URL_A })).rejects.toMatchObject({
      reason: "delivery_failed_payment_pending",
      detail: { paymentId: "pay_1" }
    });

    // Re-call: no new challenge fetch, the SAME signature is retried.
    s.queue.push(async () => deliveredResponse("tx_sig_1"));
    const result = await service.paidFetch({ url: URL_A });
    expect(result.paid).toBe(true);
    expect(result.retriedPendingPayment).toBe(true);
    expect(result.payment?.paymentId).toBe("pay_1");
    expect(builder.buildPaymentSignatureHeader).toHaveBeenCalledTimes(1);
    expect(
      s.calls[2]?.init?.headers?.[PAYMENT_SIGNATURE_HEADER]
    ).toBe("sig-1");
  });

  it("keeps the signature retryable after a non-200 delivery status", async () => {
    const s = scriptedFetch();
    s.queue.push(async (url) => challengeResponse(url));
    s.queue.push(async () => response(502, "facilitator_unreachable"));
    const builder = builderStub();
    const service = serviceWith({ fetchImpl: s.fetchImpl, builder });

    await expect(service.paidFetch({ url: URL_A })).rejects.toMatchObject({
      reason: "delivery_failed_payment_pending",
      detail: { paymentId: "pay_1", status: 502 }
    });

    s.queue.push(async () => deliveredResponse());
    const result = await service.paidFetch({ url: URL_A });
    expect(result.retriedPendingPayment).toBe(true);
    expect(builder.buildPaymentSignatureHeader).toHaveBeenCalledTimes(1);
  });

  it("gates re-purchase after the seller stops accepting the signature", async () => {
    const s = scriptedFetch();
    s.queue.push(async (url) => challengeResponse(url));
    s.queue.push(async () => response(502, "unreachable"));
    const builder = builderStub();
    const service = serviceWith({ fetchImpl: s.fetchImpl, builder });

    await expect(service.paidFetch({ url: URL_A })).rejects.toMatchObject({
      reason: "delivery_failed_payment_pending"
    });

    // Retry hits a fresh 402: the signature can no longer settle.
    s.queue.push(async (url) => challengeResponse(url));
    await expect(service.paidFetch({ url: URL_A })).rejects.toMatchObject({
      reason: "payment_outcome_unknown"
    });

    // The refusal gate must hold for plain re-calls (no new payment).
    await expect(service.paidFetch({ url: URL_A })).rejects.toMatchObject({
      reason: "payment_outcome_unknown"
    });
    expect(builder.buildPaymentSignatureHeader).toHaveBeenCalledTimes(1);

    // forceNewPayment explicitly authorizes a fresh purchase.
    s.queue.push(async (url) => challengeResponse(url));
    s.queue.push(async () => deliveredResponse());
    const result = await service.paidFetch({
      url: URL_A,
      forceNewPayment: true
    });
    expect(result.paid).toBe(true);
    expect(result.payment?.paymentId).toBe("pay_2");
    expect(builder.buildPaymentSignatureHeader).toHaveBeenCalledTimes(2);
  });

  it("treats an expired pending payment as unknown outcome", async () => {
    let now = 0;
    const s = scriptedFetch();
    s.queue.push(async (url) => challengeResponse(url));
    s.queue.push(async () => {
      throw new Error("socket hang up");
    });
    const builder = builderStub();
    const service = serviceWith({
      fetchImpl: s.fetchImpl,
      builder,
      nowMs: () => now
    });

    await expect(service.paidFetch({ url: URL_A })).rejects.toMatchObject({
      reason: "delivery_failed_payment_pending"
    });

    now = 120_000; // beyond the 110s pending TTL
    await expect(service.paidFetch({ url: URL_A })).rejects.toMatchObject({
      reason: "payment_outcome_unknown"
    });
    expect(builder.buildPaymentSignatureHeader).toHaveBeenCalledTimes(1);

    s.queue.push(async (url) => challengeResponse(url));
    s.queue.push(async () => deliveredResponse());
    const result = await service.paidFetch({
      url: URL_A,
      forceNewPayment: true
    });
    expect(result.payment?.paymentId).toBe("pay_2");
  });

  it("ignores forceNewPayment while the signature is still retryable", async () => {
    const s = scriptedFetch();
    s.queue.push(async (url) => challengeResponse(url));
    s.queue.push(async () => response(502, "unreachable"));
    const builder = builderStub();
    const service = serviceWith({ fetchImpl: s.fetchImpl, builder });

    await expect(service.paidFetch({ url: URL_A })).rejects.toMatchObject({
      reason: "delivery_failed_payment_pending"
    });

    s.queue.push(async () => deliveredResponse());
    const result = await service.paidFetch({
      url: URL_A,
      forceNewPayment: true
    });
    expect(result.retriedPendingPayment).toBe(true);
    expect(result.payment?.paymentId).toBe("pay_1");
    expect(builder.buildPaymentSignatureHeader).toHaveBeenCalledTimes(1);
  });

  it("auto-resolves an unresolved payment the facilitator reports as not settled", async () => {
    const s = scriptedFetch();
    const builder = builderStub();
    const probe = vi.fn(async () => "not_settled" as const);
    const service = serviceWith({
      fetchImpl: s.fetchImpl,
      builder,
      paymentStatusFor: probe
    });
    await intoUnresolved(service, s);

    // The probe proves pay_1 never settled, so a plain re-call purchases
    // fresh without forceNewPayment.
    s.queue.push(async (url) => challengeResponse(url));
    s.queue.push(async () => deliveredResponse());
    const result = await service.paidFetch({ url: URL_A });
    expect(result.payment?.paymentId).toBe("pay_2");
    expect(probe).toHaveBeenCalledWith("pay_1");
  });

  it("blocks re-purchase when the facilitator reports the payment settled", async () => {
    const s = scriptedFetch();
    const builder = builderStub();
    const service = serviceWith({
      fetchImpl: s.fetchImpl,
      builder,
      paymentStatusFor: async () => "settled"
    });
    await intoUnresolved(service, s);

    await expect(service.paidFetch({ url: URL_A })).rejects.toMatchObject({
      reason: "payment_already_settled",
      detail: { paymentId: "pay_1" }
    });
    expect(builder.buildPaymentSignatureHeader).toHaveBeenCalledTimes(1);

    // Paying twice for the same resource stays possible, but only
    // deliberately.
    s.queue.push(async (url) => challengeResponse(url));
    s.queue.push(async () => deliveredResponse());
    const result = await service.paidFetch({
      url: URL_A,
      forceNewPayment: true
    });
    expect(result.payment?.paymentId).toBe("pay_2");
  });

  it("keeps refusing when the payment status probe is indeterminate", async () => {
    const s = scriptedFetch();
    const builder = builderStub();
    const service = serviceWith({
      fetchImpl: s.fetchImpl,
      builder,
      paymentStatusFor: async () => "indeterminate"
    });
    await intoUnresolved(service, s);

    await expect(service.paidFetch({ url: URL_A })).rejects.toMatchObject({
      reason: "payment_outcome_unknown"
    });
    expect(builder.buildPaymentSignatureHeader).toHaveBeenCalledTimes(1);
  });

  it("coalesces concurrent calls for the same URL into one payment", async () => {
    const s = scriptedFetch();
    let releaseChallenge: (() => void) | null = null;
    s.queue.push(
      (url) =>
        new Promise((resolve) => {
          releaseChallenge = () => resolve(challengeResponse(url));
        })
    );
    s.queue.push(async () => deliveredResponse());
    const builder = builderStub();
    const service = serviceWith({ fetchImpl: s.fetchImpl, builder });

    const callA = service.paidFetch({ url: URL_A });
    const callB = service.paidFetch({ url: URL_A });
    expect(releaseChallenge).not.toBeNull();
    releaseChallenge!();

    const [resultA, resultB] = await Promise.all([callA, callB]);
    expect(resultA).toBe(resultB);
    expect(builder.buildPaymentSignatureHeader).toHaveBeenCalledTimes(1);
  });

  it("evicts the oldest tracked entry when the map is full", async () => {
    const URL_B = "http://seller.test/api/other";
    const s = scriptedFetch();
    const builder = builderStub();
    const service = serviceWith({
      fetchImpl: s.fetchImpl,
      builder,
      maxTrackedUrls: 1
    });

    s.queue.push(async (url) => challengeResponse(url));
    s.queue.push(async () => response(502, "unreachable"));
    await expect(service.paidFetch({ url: URL_A })).rejects.toMatchObject({
      reason: "delivery_failed_payment_pending"
    });

    s.queue.push(async (url) => challengeResponse(url));
    s.queue.push(async () => response(502, "unreachable"));
    await expect(service.paidFetch({ url: URL_B })).rejects.toMatchObject({
      reason: "delivery_failed_payment_pending"
    });

    // URL_A's entry was evicted, so a re-call starts a fresh purchase
    // instead of retrying pay_1.
    s.queue.push(async (url) => challengeResponse(url));
    s.queue.push(async () => deliveredResponse());
    const result = await service.paidFetch({ url: URL_A });
    expect(result.payment?.paymentId).toBe("pay_3");
  });
});

describe("formatRawUsdcAmount", () => {
  it("formats raw USDC with 6 decimals", () => {
    expect(formatRawUsdcAmount(100n)).toBe("0.000100");
    expect(formatRawUsdcAmount("60011062")).toBe("60.011062");
    expect(formatRawUsdcAmount(0n)).toBe("0.000000");
  });
});
