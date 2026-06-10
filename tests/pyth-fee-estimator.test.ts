import { afterEach, describe, expect, it, vi } from "vitest";
import {
  PythHermesFeeEstimator,
  scalePythPrice
} from "../src/domain/pyth-fee-estimator.js";

function stubHermes(params: {
  price?: string;
  expo?: number;
  publishTime?: number;
  status?: number;
}) {
  const publishTime = params.publishTime ?? Math.floor(Date.now() / 1000);
  vi.stubGlobal(
    "fetch",
    vi.fn(async () =>
      new Response(
        JSON.stringify({
          parsed: [
            {
              price: {
                price: params.price ?? "6500000000",
                expo: params.expo ?? -8,
                publish_time: publishTime
              }
            }
          ]
        }),
        { status: params.status ?? 200 }
      )
    )
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("scalePythPrice", () => {
  it("scales a negative exponent price to 1e9", () => {
    // 65.00 USD with expo -8 -> 65 * 1e9
    expect(scalePythPrice("6500000000", -8)).toBe(65_000_000_000n);
  });

  it("scales a positive exponent price", () => {
    expect(scalePythPrice("65", 0)).toBe(65_000_000_000n);
  });
});

describe("PythHermesFeeEstimator", () => {
  it("computes fee debt from the live price", async () => {
    stubHermes({});
    const estimator = new PythHermesFeeEstimator({
      estimatedFeeLamports: 120_000n
    });
    const estimate = await estimator.estimatePaymentFee({
      wallet: "w",
      seller: "s",
      amountRawUsdc: 1n
    });
    // 120000 lamports * 65 USD/SOL = 0.0078 USD -> 7800 raw USDC
    expect(estimate.estimatedFeeDebtRawUsdc).toBe(7_800n);
    expect(estimate.estimatedFeeLamports).toBe(120_000n);
  });

  it("rejects stale prices", async () => {
    stubHermes({ publishTime: Math.floor(Date.now() / 1000) - 600 });
    const estimator = new PythHermesFeeEstimator();
    await expect(
      estimator.estimatePaymentFee({ wallet: "w", seller: "s", amountRawUsdc: 1n })
    ).rejects.toMatchObject({ code: "stale_oracle" });
  });

  it("rejects when the fee debt exceeds the policy cap", async () => {
    stubHermes({});
    const estimator = new PythHermesFeeEstimator({
      estimatedFeeLamports: 1_000_000n,
      maxFeeDebtRawUsdcPerPayment: 10_000n
    });
    await expect(
      estimator.estimatePaymentFee({ wallet: "w", seller: "s", amountRawUsdc: 1n })
    ).rejects.toMatchObject({ code: "fee_cap_exceeded" });
  });

  it("surfaces oracle fetch failures as stale_oracle", async () => {
    stubHermes({ status: 503 });
    const estimator = new PythHermesFeeEstimator();
    await expect(
      estimator.estimatePaymentFee({ wallet: "w", seller: "s", amountRawUsdc: 1n })
    ).rejects.toMatchObject({ code: "stale_oracle" });
  });

  it("converts actual landed fees with the same price", async () => {
    stubHermes({});
    const estimator = new PythHermesFeeEstimator();
    expect(await estimator.convertFeeLamportsToUsdc(15_000n)).toBe(975n);
  });
});
