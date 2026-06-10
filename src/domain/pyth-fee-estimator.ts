import { ceilDiv } from "../lib/raw-units.js";
import { conflict } from "./errors.js";
import type { FeeEstimate, FeeEstimateInput, FeeEstimator } from "./fee-estimator.js";

const LAMPORTS_PER_SOL = 1_000_000_000n;
/** Pyth SOL/USD price feed id (hex, without 0x prefix). */
export const PYTH_SOL_USD_FEED_ID =
  "ef0d8b6fda2ceba41da15d4095d1da392a0d2f8ed0c6c7bc0f4cfac8c280b56d";

export interface PythHermesFeeEstimatorConfig {
  hermesBaseUrl: string;
  priceFeedId: string;
  /** Total estimated fee: base signatures fee + priority fee + safety buffer. */
  estimatedFeeLamports: bigint;
  maxEstimatedFeeLamports: bigint;
  maxFeeDebtRawUsdcPerPayment: bigint;
  maxPriceAgeMs: number;
  priceCacheTtlMs: number;
}

export const DEFAULT_PYTH_FEE_CONFIG: Omit<
  PythHermesFeeEstimatorConfig,
  "hermesBaseUrl"
> = {
  priceFeedId: PYTH_SOL_USD_FEED_ID,
  // 3 signatures (sponsor, agent, temporary account) * 5000 base fee
  // + compute-budget priority fee + buffer.
  estimatedFeeLamports: 120_000n,
  maxEstimatedFeeLamports: 2_000_000n,
  maxFeeDebtRawUsdcPerPayment: 50_000n,
  maxPriceAgeMs: 60_000,
  priceCacheTtlMs: 10_000
};

interface CachedPrice {
  /** SOL/USD price scaled by 1e9. */
  priceScaled: bigint;
  publishTimeMs: number;
  fetchedAtMs: number;
}

const PRICE_SCALE = 1_000_000_000n;

/**
 * Live SOL/USDC fee oracle backed by the Pyth Hermes REST API. Treats the
 * Pyth SOL/USD price as SOL/USDC, which is acceptable within the configured
 * fee caps. Enforces freshness and per-payment fee caps per the design.
 */
export class PythHermesFeeEstimator implements FeeEstimator {
  private readonly config: PythHermesFeeEstimatorConfig;
  private cached: CachedPrice | null = null;

  constructor(config?: Partial<PythHermesFeeEstimatorConfig>) {
    this.config = {
      hermesBaseUrl: "https://hermes.pyth.network",
      ...DEFAULT_PYTH_FEE_CONFIG,
      ...config
    };
  }

  async estimatePaymentFee(_input: FeeEstimateInput): Promise<FeeEstimate> {
    if (this.config.estimatedFeeLamports > this.config.maxEstimatedFeeLamports) {
      throw conflict("fee_cap_exceeded", "Estimated lamports exceed policy cap");
    }

    const price = await this.freshPrice();
    const estimatedFeeDebtRawUsdc = await this.feeLamportsToUsdc(
      this.config.estimatedFeeLamports,
      price
    );
    if (estimatedFeeDebtRawUsdc > this.config.maxFeeDebtRawUsdcPerPayment) {
      throw conflict("fee_cap_exceeded", "Estimated fee debt exceeds policy cap");
    }

    return {
      estimatedFeeLamports: this.config.estimatedFeeLamports,
      estimatedFeeDebtRawUsdc,
      source: `pyth_hermes:${this.config.priceFeedId.slice(0, 8)}`,
      observedAt: new Date(price.publishTimeMs).toISOString()
    };
  }

  /** Converts an actual landed fee into raw USDC using the fresh oracle price. */
  async convertFeeLamportsToUsdc(feeLamports: bigint): Promise<bigint> {
    const price = await this.freshPrice();
    return this.feeLamportsToUsdc(feeLamports, price);
  }

  private async feeLamportsToUsdc(
    feeLamports: bigint,
    price: CachedPrice
  ): Promise<bigint> {
    // fee_debt = ceil(lamports * priceScaled / (LAMPORTS_PER_SOL * PRICE_SCALE) * 1e6)
    // where priceScaled is USD per SOL scaled by 1e9 and USDC has 6 decimals.
    return ceilDiv(
      feeLamports * price.priceScaled * 1_000_000n,
      LAMPORTS_PER_SOL * PRICE_SCALE
    );
  }

  private async freshPrice(): Promise<CachedPrice> {
    const now = Date.now();
    if (
      this.cached !== null &&
      now - this.cached.fetchedAtMs <= this.config.priceCacheTtlMs
    ) {
      this.assertFresh(this.cached, now);
      return this.cached;
    }

    const url = `${this.config.hermesBaseUrl}/v2/updates/price/latest?ids[]=${this.config.priceFeedId}&parsed=true`;
    let parsed: { price: string; expo: number; publishTime: number };
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(5_000) });
      if (!response.ok) {
        throw new Error(`Hermes responded with HTTP ${response.status}`);
      }
      const body = (await response.json()) as {
        parsed?: Array<{
          price?: { price?: string; expo?: number; publish_time?: number };
        }>;
      };
      const entry = body.parsed?.[0]?.price;
      if (
        entry?.price === undefined ||
        entry.expo === undefined ||
        entry.publish_time === undefined
      ) {
        throw new Error("Hermes response is missing the parsed price");
      }
      parsed = {
        price: entry.price,
        expo: entry.expo,
        publishTime: entry.publish_time
      };
    } catch (error) {
      throw conflict(
        "stale_oracle",
        error instanceof Error
          ? `SOL/USDC oracle fetch failed: ${error.message}`
          : "SOL/USDC oracle fetch failed"
      );
    }

    const priceScaled = scalePythPrice(parsed.price, parsed.expo);
    if (priceScaled <= 0n) {
      throw conflict("stale_oracle", "SOL/USDC oracle returned a non-positive price");
    }

    const next: CachedPrice = {
      priceScaled,
      publishTimeMs: parsed.publishTime * 1000,
      fetchedAtMs: now
    };
    this.assertFresh(next, now);
    this.cached = next;
    return next;
  }

  private assertFresh(price: CachedPrice, nowMs: number): void {
    if (nowMs - price.publishTimeMs > this.config.maxPriceAgeMs) {
      throw conflict("stale_oracle", "SOL/USDC oracle price is stale");
    }
    if (price.publishTimeMs > nowMs + 60_000) {
      throw conflict("stale_oracle", "SOL/USDC oracle timestamp is in the future");
    }
  }
}

/** Converts a Pyth integer price with exponent into a 1e9-scaled bigint. */
export function scalePythPrice(price: string, expo: number): bigint {
  if (!/^-?\d+$/.test(price)) {
    throw conflict("stale_oracle", "SOL/USDC oracle price is not an integer string");
  }
  const value = BigInt(price);
  const targetExpo = expo + 9;
  if (targetExpo >= 0) {
    return value * 10n ** BigInt(targetExpo);
  }

  return value / 10n ** BigInt(-targetExpo);
}
