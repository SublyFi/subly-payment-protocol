import { describe, expect, it } from "vitest";
import { Decimal } from "decimal.js";
import {
  decimalToBigInt,
  grossWithdrawForNetTarget,
  rawToSharesDecimal,
  rawToUsdcDecimal,
  sharesDecimalToRaw,
  withdrawalPenaltyFor
} from "../src/kamino/vault-adapter.js";

describe("withdrawalPenaltyFor", () => {
  it("applies the bps penalty rounded up", () => {
    // 1 bps of 1_000_000 = 100
    expect(withdrawalPenaltyFor(1_000_000n, 1n, 0n)).toBe(100n);
    // ceil rounding: 1 bps of 10_001 = 1.0001 -> 2
    expect(withdrawalPenaltyFor(10_001n, 1n, 0n)).toBe(2n);
  });

  it("applies the lamports floor when larger than the bps penalty", () => {
    expect(withdrawalPenaltyFor(10_000n, 1n, 1_000n)).toBe(1_000n);
  });

  it("returns zero penalty for zero gross", () => {
    expect(withdrawalPenaltyFor(0n, 1n, 1_000n)).toBe(0n);
  });
});

describe("grossWithdrawForNetTarget", () => {
  it("finds the smallest gross whose net covers the target", () => {
    const gross = grossWithdrawForNetTarget({
      targetNetRawUsdc: 10_000n,
      penaltyBps: 1n,
      penaltyLamports: 1_000n
    });
    const penalty = withdrawalPenaltyFor(gross, 1n, 1_000n);
    expect(gross - penalty >= 10_000n).toBe(true);
    // Minimality: one unit less must not cover the target.
    const prevPenalty = withdrawalPenaltyFor(gross - 1n, 1n, 1_000n);
    expect(gross - 1n - prevPenalty < 10_000n).toBe(true);
  });

  it("is exact for floor-penalty-dominated quotes", () => {
    // penalty = max(ceil(g*1/10000), 1000) = 1000 around g=11000
    expect(
      grossWithdrawForNetTarget({
        targetNetRawUsdc: 10_000n,
        penaltyBps: 1n,
        penaltyLamports: 1_000n
      })
    ).toBe(11_000n);
  });

  it("handles pure bps penalties", () => {
    const gross = grossWithdrawForNetTarget({
      targetNetRawUsdc: 1_000_000n,
      penaltyBps: 10n,
      penaltyLamports: 0n
    });
    expect(gross - withdrawalPenaltyFor(gross, 10n, 0n)).toBeGreaterThanOrEqual(
      1_000_000n
    );
  });

  it("rejects a penalty that consumes the entire withdraw", () => {
    expect(() =>
      grossWithdrawForNetTarget({
        targetNetRawUsdc: 1_000n,
        penaltyBps: 10_000n,
        penaltyLamports: 0n
      })
    ).toThrow();
  });
});

describe("unit conversions", () => {
  it("converts decimals to raw integers exactly", () => {
    expect(decimalToBigInt(new Decimal("1.999999"))).toBe(1n);
    expect(sharesDecimalToRaw(new Decimal("1.234567"))).toBe(1_234_567n);
    expect(rawToSharesDecimal(1_234_567n).toString()).toBe("1.234567");
    expect(rawToUsdcDecimal(10_000n).toString()).toBe("0.01");
  });

  it("keeps precision for large share balances", () => {
    const raw = 123_456_789_012_345n;
    expect(sharesDecimalToRaw(rawToSharesDecimal(raw))).toBe(raw);
  });
});
