import { ceilDiv, parsePositiveRawUnits, parseRawUnits } from "../lib/raw-units.js";
import { badRequest, conflict } from "./errors.js";

export interface FeeEstimate {
  estimatedFeeLamports: bigint;
  estimatedFeeDebtRawUsdc: bigint;
  source: string;
  observedAt: string;
}

export interface FeeEstimateInput {
  wallet: string;
  seller: string;
  amountRawUsdc: bigint;
}

export interface FeeEstimator {
  estimatePaymentFee(input: FeeEstimateInput): Promise<FeeEstimate>;
}

export interface StaticFeeEstimatorConfig {
  estimatedFeeLamports: bigint;
  estimatedFeeDebtRawUsdc: bigint;
}

export class StaticFeeEstimator implements FeeEstimator {
  constructor(private readonly config: StaticFeeEstimatorConfig) {}

  async estimatePaymentFee(): Promise<FeeEstimate> {
    return {
      estimatedFeeLamports: this.config.estimatedFeeLamports,
      estimatedFeeDebtRawUsdc: this.config.estimatedFeeDebtRawUsdc,
      source: "static_dev_config",
      observedAt: new Date().toISOString()
    };
  }
}

export interface PolicyFeeEstimatorConfig {
  estimatedFeeLamports: bigint;
  solUsdcPriceScaled: bigint;
  priceScale: bigint;
  observedAt: Date;
  maxAgeMs: number;
  maxEstimatedFeeLamports: bigint;
  maxFeeDebtRawUsdcPerPayment: bigint;
  source: string;
}

export class PolicyFeeEstimator implements FeeEstimator {
  constructor(private readonly config: PolicyFeeEstimatorConfig) {}

  async estimatePaymentFee(): Promise<FeeEstimate> {
    const now = Date.now();
    const observedAtMs = this.config.observedAt.getTime();
    if (!Number.isFinite(observedAtMs)) {
      throw conflict("stale_oracle", "Fee oracle observation timestamp is invalid");
    }
    if (observedAtMs > now + 60_000) {
      throw conflict("stale_oracle", "Fee oracle observation timestamp is in the future");
    }
    if (now - observedAtMs > this.config.maxAgeMs) {
      throw conflict("stale_oracle", "Fee oracle observation is stale");
    }
    if (this.config.estimatedFeeLamports > this.config.maxEstimatedFeeLamports) {
      throw conflict("fee_cap_exceeded", "Estimated lamports exceed policy cap");
    }

    const estimatedFeeDebtRawUsdc = ceilDiv(
      this.config.estimatedFeeLamports * this.config.solUsdcPriceScaled,
      1_000_000_000n * this.config.priceScale
    );
    if (estimatedFeeDebtRawUsdc > this.config.maxFeeDebtRawUsdcPerPayment) {
      throw conflict("fee_cap_exceeded", "Estimated fee debt exceeds policy cap");
    }

    return {
      estimatedFeeLamports: this.config.estimatedFeeLamports,
      estimatedFeeDebtRawUsdc,
      source: this.config.source,
      observedAt: this.config.observedAt.toISOString()
    };
  }
}

export function feeEstimatorFromEnv(env: NodeJS.ProcessEnv): FeeEstimator {
  const estimatedFeeLamports = parseFeeRawUnits(
    env.SUBLY_ESTIMATED_FEE_LAMPORTS,
    "SUBLY_ESTIMATED_FEE_LAMPORTS"
  );
  const solUsdcPriceScaled = parseFeeRawUnits(
    env.SUBLY_SOL_USDC_PRICE_SCALED,
    "SUBLY_SOL_USDC_PRICE_SCALED",
    { positive: true }
  );
  const priceScale = parseFeeRawUnits(
    env.SUBLY_PRICE_SCALE,
    "SUBLY_PRICE_SCALE",
    { positive: true }
  );
  const observedAt = env.SUBLY_FEE_OBSERVED_AT;
  if (observedAt === undefined) {
    throw badRequest(
      "fee_oracle_not_configured",
      "SUBLY_FEE_OBSERVED_AT must be configured"
    );
  }

  return new PolicyFeeEstimator({
    estimatedFeeLamports,
    solUsdcPriceScaled,
    priceScale,
    observedAt: new Date(observedAt),
    maxAgeMs: parseNonNegativeSafeInteger(
      env.SUBLY_FEE_MAX_AGE_MS ?? "60000",
      "SUBLY_FEE_MAX_AGE_MS"
    ),
    maxEstimatedFeeLamports: parseFeeRawUnits(
      env.SUBLY_MAX_ESTIMATED_FEE_LAMPORTS ?? estimatedFeeLamports.toString(),
      "SUBLY_MAX_ESTIMATED_FEE_LAMPORTS"
    ),
    maxFeeDebtRawUsdcPerPayment: parseFeeRawUnits(
      env.SUBLY_MAX_FEE_DEBT_RAW_USDC_PER_PAYMENT ?? "10000",
      "SUBLY_MAX_FEE_DEBT_RAW_USDC_PER_PAYMENT"
    ),
    source: env.SUBLY_FEE_SOURCE ?? "env_policy_fee_estimator"
  });
}

function parseFeeRawUnits(
  value: unknown,
  fieldName: string,
  options: { positive?: boolean } = {}
): bigint {
  try {
    return options.positive === true
      ? parsePositiveRawUnits(value, fieldName)
      : parseRawUnits(value, fieldName);
  } catch (error) {
    throw badRequest(
      "invalid_fee_oracle_config",
      error instanceof Error ? error.message : `${fieldName} is invalid`
    );
  }
}

function parseNonNegativeSafeInteger(value: string, fieldName: string): number {
  if (!/^(0|[1-9]\d*)$/.test(value)) {
    throw badRequest(
      "invalid_fee_oracle_config",
      `${fieldName} must be a non-negative integer`
    );
  }

  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) {
    throw badRequest(
      "invalid_fee_oracle_config",
      `${fieldName} must be a safe integer`
    );
  }

  return parsed;
}
