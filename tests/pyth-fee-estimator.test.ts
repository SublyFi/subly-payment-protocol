import { afterEach, describe, expect, it, vi } from "vitest";
import {
  PythHermesFeeEstimator,
  pythHermesConnectionFromEnv,
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
  it("authenticates hosted Hermes requests without putting the key in the URL", async () => {
    stubHermes({});
    const estimator = new PythHermesFeeEstimator(pythHermesConnectionFromEnv({
      SUBLY_HERMES_API_KEY: "test-hermes-secret"
    }));
    await estimator.estimatePaymentFee({ wallet: "w", seller: "s", amountRawUsdc: 1n });
    const [url, init] = vi.mocked(fetch).mock.calls[0]!;
    expect(String(url)).toMatch(/^https:\/\/pyth\.dourolabs\.app\/hermes\/v2\/updates\/price\/latest\?/);
    expect(String(url)).not.toContain("test-hermes-secret");
    expect(init?.headers).toEqual({ Authorization: "Bearer test-hermes-secret" });
    expect(init?.redirect).toBe("error");
  });

  it("supports an explicitly selected provider and the standard PYTH_API_KEY variable", async () => {
    stubHermes({});
    const estimator = new PythHermesFeeEstimator(pythHermesConnectionFromEnv({
      SUBLY_HERMES_BASE_URL: "https://oracle.example.test/hermes/",
      PYTH_API_KEY: "test-provider-secret"
    }));
    await estimator.convertFeeLamportsToUsdc(15_000n);
    const [url, init] = vi.mocked(fetch).mock.calls[0]!;
    expect(String(url)).toMatch(/^https:\/\/oracle\.example\.test\/hermes\/v2\//);
    expect(init?.headers).toEqual({ Authorization: "Bearer test-provider-secret" });
  });

  it("prefers the operator-specific key and permits credential-free custom Hermes", () => {
    expect(pythHermesConnectionFromEnv({ SUBLY_HERMES_API_KEY: "specific", PYTH_API_KEY: "fallback" }))
      .toEqual({ apiKey: "specific" });
    expect(pythHermesConnectionFromEnv({})).toEqual({});
  });

  it("refuses sending API credentials over plaintext HTTP", () => {
    expect(() => new PythHermesFeeEstimator({
      hermesBaseUrl: "http://oracle.example.test", apiKey: "test-secret"
    })).toThrow("must use HTTPS");
  });

  it.each([401, 403])("fails closed with an actionable authentication error on HTTP %s", async (status) => {
    stubHermes({ status });
    const estimator = new PythHermesFeeEstimator({ apiKey: "test-hermes-secret" });
    await expect(estimator.convertFeeLamportsToUsdc(15_000n)).rejects.toMatchObject({
      code: "stale_oracle", message: expect.stringContaining("SUBLY_HERMES_API_KEY")
    });
    await expect(estimator.convertFeeLamportsToUsdc(15_000n)).rejects.not.toThrow("test-hermes-secret");
  });

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
