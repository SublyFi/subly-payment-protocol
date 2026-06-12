import { describe, expect, it } from "vitest";
import { RATE_SCALE, SUBLY_VAULT } from "../src/config/constants.js";
import {
  computeBudgetSnapshot,
  computePositionValueRawUsdc,
  evaluatePaymentBudget,
  sharesToRedeemRaw
} from "../src/domain/budget.js";
import type { WalletPosition } from "../src/domain/models.js";

describe("budget accounting", () => {
  it("rounds position value down", () => {
    expect(computePositionValueRawUsdc(100n, RATE_SCALE + 1n)).toBe(100n);
  });

  it("rounds share redemption up", () => {
    expect(sharesToRedeemRaw(3n, 2n * RATE_SCALE)).toBe(2n);
  });

  it("subtracts reservations, fee debt, and safety buffer from spendable yield", () => {
    const budget = computeBudgetSnapshot(
      position({
        totalSharesRaw: 101_000_000n,
        principalBasisRawUsdc: 100_000_000n,
        reservedRawUsdc: 100_000n,
        feeDebtRawUsdc: 50_000n,
        safetyBufferRawUsdc: 250_000n
      })
    );

    expect(budget.positionValueRawUsdc).toBe(101_000_000n);
    expect(budget.grossYieldRawUsdc).toBe(1_000_000n);
    expect(budget.spendableYieldRawUsdc).toBe(600_000n);
  });

  it("accepts a payment only when yield and instant liquidity are both sufficient", () => {
    const result = evaluatePaymentBudget({
      position: position({
        totalSharesRaw: 101_000_000n,
        principalBasisRawUsdc: 100_000_000n,
        instantRedeemCapacityRawUsdc: 1_000_000n
      }),
      sellerAmountRawUsdc: 500_000n,
      estimatedFeeDebtRawUsdc: 100_000n
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.reservationRawUsdc).toBe(600_000n);
      expect(result.postPositionValueRawUsdc).toBe(100_500_000n);
    }
  });

  it("budgets and reserves against the gross withdraw including the penalty", () => {
    // Spendable yield 1_000_000 covers seller(500k) + fee(100k) but not the
    // gross withdraw incl. penalty (950k) + fee(100k) = 1_050_000.
    const insufficient = evaluatePaymentBudget({
      position: position({
        totalSharesRaw: 101_000_000n,
        principalBasisRawUsdc: 100_000_000n,
        instantRedeemCapacityRawUsdc: 2_000_000n
      }),
      sellerAmountRawUsdc: 500_000n,
      estimatedFeeDebtRawUsdc: 100_000n,
      requiredWithdrawRawUsdc: 950_000n
    });
    expect(insufficient.ok).toBe(false);
    if (!insufficient.ok) {
      expect(insufficient.code).toBe("insufficient_yield");
      expect(insufficient.details.requiredBudgetRawUsdc).toBe("1050000");
      expect(insufficient.details.requiredWithdrawRawUsdc).toBe("950000");
      expect(insufficient.details.sellerAmountRawUsdc).toBe("500000");
      expect(insufficient.details.estimatedFeeDebtRawUsdc).toBe("100000");
    }

    // With enough yield the reservation covers gross + fee, not seller + fee.
    const accepted = evaluatePaymentBudget({
      position: position({
        totalSharesRaw: 102_000_000n,
        principalBasisRawUsdc: 100_000_000n,
        instantRedeemCapacityRawUsdc: 2_000_000n
      }),
      sellerAmountRawUsdc: 500_000n,
      estimatedFeeDebtRawUsdc: 100_000n,
      requiredWithdrawRawUsdc: 950_000n
    });
    expect(accepted.ok).toBe(true);
    if (accepted.ok) {
      expect(accepted.requiredBudgetRawUsdc).toBe(1_050_000n);
      expect(accepted.reservationRawUsdc).toBe(1_050_000n);
    }
  });

  it("rejects insufficient spendable yield", () => {
    const result = evaluatePaymentBudget({
      position: position({
        totalSharesRaw: 100_100_000n,
        principalBasisRawUsdc: 100_000_000n,
        instantRedeemCapacityRawUsdc: 1_000_000n
      }),
      sellerAmountRawUsdc: 100_000n,
      estimatedFeeDebtRawUsdc: 1n
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("insufficient_yield");
    }
  });

  it("rejects illiquid yield even when budget is sufficient", () => {
    const result = evaluatePaymentBudget({
      position: position({
        totalSharesRaw: 101_000_000n,
        principalBasisRawUsdc: 100_000_000n,
        instantRedeemCapacityRawUsdc: 499_999n
      }),
      sellerAmountRawUsdc: 500_000n,
      estimatedFeeDebtRawUsdc: 100_000n
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("budget_illiquid");
    }
  });

  it("rejects instant liquidity overbooking from active withdrawal reservations", () => {
    const result = evaluatePaymentBudget({
      position: position({
        totalSharesRaw: 102_000_000n,
        principalBasisRawUsdc: 100_000_000n,
        instantRedeemCapacityRawUsdc: 750_000n
      }),
      sellerAmountRawUsdc: 300_000n,
      estimatedFeeDebtRawUsdc: 100_000n,
      activeWithdrawReservedRawUsdc: 500_000n
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("budget_illiquid");
      expect(result.details.requiredInstantRedeemCapacityRawUsdc).toBe("800000");
    }
  });
});

function position(overrides: Partial<WalletPosition>): WalletPosition {
  return {
    wallet: "wallet",
    vault: SUBLY_VAULT.address,
    signingPolicyId: "policy",
    signingMode: "non_interactive",
    signerValidationMode: "structured_intent_transaction",
    signerProvider: "test",
    stakedSharesRaw: 0n,
    unstakedSharesRaw: overrides.totalSharesRaw ?? 0n,
    totalSharesRaw: 0n,
    exchangeRateScaled: RATE_SCALE,
    instantRedeemCapacityRawUsdc: 0n,
    principalBasisRawUsdc: 0n,
    principalBasisSource: "manual_trusted_seed",
    reservedRawUsdc: 0n,
    feeDebtRawUsdc: 0n,
    safetyBufferRawUsdc: 0n,
    kaminoPositionSnapshot: [],
    kaminoPnlSnapshot: [],
    lastSyncedSlot: null,
    version: 1,
    status: "active",
    ...overrides
  };
}
