import { describe, expect, it, vi } from "vitest";
import {
  StandardX402Payer,
  type StandardX402PendingPaymentRecord,
  type StandardX402StateStore
} from "../src/client/standard-x402-payer.js";
import { SOLANA_MAINNET_NETWORK, SUBLY_VAULT } from "../src/config/constants.js";
import { encodeX402Header } from "../src/x402/headers.js";

const request = { url: "https://seller.example/jobs", method: "POST", body: "{}" };

function paymentFixture(status: number, receipt: string | null) {
  let records: StandardX402PendingPaymentRecord[] = [];
  const stateStore: StandardX402StateStore = {
    load: () => records,
    save: (next) => { records = next; }
  };
  const realizer = {
    ensureUsdcAvailable: vi.fn(async () => ({
      realizedRawUsdc: 10_000n,
      txSignature: "realize-tx",
      withdrawalId: "withdrawal-1"
    })),
    reportPayment: vi.fn(async () => {})
  };
  const x402Fetch = vi.fn(async () => ({
    status,
    headers: { get: (name: string) => name.toLowerCase() === "payment-response" ? receipt : null },
    text: async () => status === 204 ? "" : '{"id":"job-1"}',
    json: async () => ({ id: "job-1" })
  }));
  const config = {
    realizer, x402Fetch, stateStore, defaultMaxAmountRawUsdc: 10_000n,
    probeFetch: async () => ({
      status: 402,
      headers: { get: () => null },
      text: async () => "",
      json: async () => ({
        x402Version: 2,
        accepts: [{
          scheme: "exact", network: SOLANA_MAINNET_NETWORK, asset: SUBLY_VAULT.usdcMint,
          amount: "10000", payTo: "J7ZvJEspvwP1oRxQZ7mYmNmT22NTm3GWq3t7HEbvPZYx",
          maxTimeoutSeconds: 300,
          extra: { feePayer: "2wKupLR9q6wXYppw8Gr2NvWxKBUqm4PPJKkQfoxHDBg4" }
        }]
      })
    })
  };
  return { config, realizer, x402Fetch, records: () => records };
}

describe("standard x402 response handling", () => {
  it.each([200, 201, 202, 204])("delivers HTTP %i, clears pending state and reports the successful receipt", async (status) => {
    const fixture = paymentFixture(status, encodeX402Header({
      success: true, transaction: "payment-tx", network: SOLANA_MAINNET_NETWORK
    }));
    const result = await new StandardX402Payer(fixture.config).pay(request);
    expect(result).toMatchObject({ paid: true, status, payment: { paymentTxSignature: "payment-tx" } });
    expect(result.body).toBe(status === 204 ? "" : '{"id":"job-1"}');
    expect(fixture.records()).toEqual([]);
    expect(fixture.realizer.reportPayment).toHaveBeenCalledExactlyOnceWith({
      withdrawalId: "withdrawal-1", paymentTxSignature: "payment-tx"
    });
    expect(fixture.x402Fetch).toHaveBeenCalledTimes(1);
  });

  it.each([201, 204])("preserves HTTP %i delivery compatibility when no receipt is exposed", async (status) => {
    const fixture = paymentFixture(status, null);
    const result = await new StandardX402Payer(fixture.config).pay(request);
    expect(result).toMatchObject({ paid: true, status, payment: { paymentTxSignature: null } });
    expect(fixture.records()).toEqual([]);
    expect(fixture.realizer.reportPayment).not.toHaveBeenCalled();
  });

  it.each([
    [200, encodeX402Header({ success: false, transaction: "failed-tx", errorReason: "settlement_failed" })],
    [201, encodeX402Header({ success: false, transaction: "failed-tx" })],
    [200, "not-a-receipt"],
    [201, encodeX402Header(null)],
    [202, encodeX402Header({ success: "true", transaction: "payment-tx" })],
    [200, encodeX402Header({ success: true })],
    [201, encodeX402Header({ success: true, transaction: "" })],
    [202, encodeX402Header({ success: true, transaction: 42 })],
    [500, encodeX402Header({ success: true, transaction: "payment-tx" })],
    [402, null]
  ] as const)("retains retry protection for status %i and an unsuccessful/invalid response", async (status, receipt) => {
    const fixture = paymentFixture(status, receipt);
    await expect(new StandardX402Payer(fixture.config).pay(request)).rejects.toMatchObject({
      reason: "payment_outcome_unknown"
    });
    expect(fixture.records()[0]?.status).toBe("external_outcome_unknown");
    await expect(new StandardX402Payer(fixture.config).pay(request)).rejects.toMatchObject({
      reason: "payment_outcome_unknown"
    });
    expect(fixture.realizer.ensureUsdcAvailable).toHaveBeenCalledTimes(1);
    expect(fixture.x402Fetch).toHaveBeenCalledTimes(1);
    expect(fixture.realizer.reportPayment).not.toHaveBeenCalled();
  });
});
