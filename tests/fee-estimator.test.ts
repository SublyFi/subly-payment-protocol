import { describe, expect, it } from "vitest";
import { feeEstimatorFromEnv } from "../src/domain/fee-estimator.js";

describe("feeEstimatorFromEnv", () => {
  it("rejects invalid max-age configuration instead of disabling stale checks", () => {
    expect(() =>
      feeEstimatorFromEnv({
        ...baseFeeEnv(),
        SUBLY_FEE_MAX_AGE_MS: "not-a-number"
      })
    ).toThrowError(
      expect.objectContaining({
        code: "invalid_fee_oracle_config"
      })
    );
  });

  it("rejects stale oracle observations", async () => {
    const estimator = feeEstimatorFromEnv({
      ...baseFeeEnv(),
      SUBLY_FEE_OBSERVED_AT: new Date(Date.now() - 120_000).toISOString(),
      SUBLY_FEE_MAX_AGE_MS: "1000"
    });

    await expect(
      estimator.estimatePaymentFee({
        wallet: "wallet",
        seller: "seller",
        amountRawUsdc: 1n
      })
    ).rejects.toMatchObject({
      code: "stale_oracle"
    });
  });
});

function baseFeeEnv(): NodeJS.ProcessEnv {
  return {
    SUBLY_ESTIMATED_FEE_LAMPORTS: "5000",
    SUBLY_SOL_USDC_PRICE_SCALED: "150000000",
    SUBLY_PRICE_SCALE: "1000000",
    SUBLY_FEE_OBSERVED_AT: new Date().toISOString()
  };
}
