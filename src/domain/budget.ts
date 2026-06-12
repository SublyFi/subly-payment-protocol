import { RATE_SCALE } from "../config/constants.js";
import {
  ceilDiv,
  clampToZero,
  mulDivFloor
} from "../lib/raw-units.js";
import type { WalletPosition } from "./models.js";

export interface BudgetSnapshot {
  positionValueRawUsdc: bigint;
  grossYieldRawUsdc: bigint;
  spendableYieldRawUsdc: bigint;
}

export interface PaymentBudgetEvaluation {
  ok: true;
  budget: BudgetSnapshot;
  requiredBudgetRawUsdc: bigint;
  requiredWithdrawRawUsdc: bigint;
  sharesToRedeemRaw: bigint;
  postPositionValueRawUsdc: bigint;
  reservationRawUsdc: bigint;
}

export interface PaymentBudgetRejection {
  ok: false;
  code:
    | "insufficient_yield"
    | "budget_illiquid"
    | "invalid_exchange_rate"
    | "post_state_principal_invariant_failed";
  budget: BudgetSnapshot;
  details: Record<string, string>;
}

export function computePositionValueRawUsdc(
  totalSharesRaw: bigint,
  exchangeRateScaled: bigint
): bigint {
  if (exchangeRateScaled <= 0n) {
    throw new Error("exchangeRateScaled must be positive");
  }

  return mulDivFloor(totalSharesRaw, exchangeRateScaled, RATE_SCALE);
}

export function computeBudgetSnapshot(position: WalletPosition): BudgetSnapshot {
  const positionValueRawUsdc = computePositionValueRawUsdc(
    position.totalSharesRaw,
    position.exchangeRateScaled
  );
  const grossYieldRawUsdc = clampToZero(
    positionValueRawUsdc - position.principalBasisRawUsdc
  );
  const spendableYieldRawUsdc = clampToZero(
    grossYieldRawUsdc -
      position.reservedRawUsdc -
      position.feeDebtRawUsdc -
      position.safetyBufferRawUsdc
  );

  return {
    positionValueRawUsdc,
    grossYieldRawUsdc,
    spendableYieldRawUsdc
  };
}

export function sharesToRedeemRaw(
  requiredWithdrawRawUsdc: bigint,
  exchangeRateScaled: bigint
): bigint {
  if (exchangeRateScaled <= 0n) {
    throw new Error("exchangeRateScaled must be positive");
  }

  return ceilDiv(requiredWithdrawRawUsdc * RATE_SCALE, exchangeRateScaled);
}

export function evaluatePaymentBudget(params: {
  position: WalletPosition;
  sellerAmountRawUsdc: bigint;
  estimatedFeeDebtRawUsdc: bigint;
  requiredWithdrawRawUsdc?: bigint;
  activeWithdrawReservedRawUsdc?: bigint;
}): PaymentBudgetEvaluation | PaymentBudgetRejection {
  const budget = computeBudgetSnapshot(params.position);
  const requiredWithdrawRawUsdc =
    params.requiredWithdrawRawUsdc ?? params.sellerAmountRawUsdc;
  // Budget against the gross withdraw (seller amount + vault withdrawal
  // penalty), not the seller amount: the settlement removes the gross from
  // the position, so anything less under-reserves and lets the precheck
  // pass payments the post-state principal invariant must then reject.
  const requiredBudgetRawUsdc =
    requiredWithdrawRawUsdc + params.estimatedFeeDebtRawUsdc;
  const activeWithdrawReservedRawUsdc =
    params.activeWithdrawReservedRawUsdc ?? 0n;

  if (params.position.exchangeRateScaled <= 0n) {
    return {
      ok: false,
      code: "invalid_exchange_rate",
      budget,
      details: {
        exchangeRateScaled: params.position.exchangeRateScaled.toString()
      }
    };
  }

  if (budget.spendableYieldRawUsdc < requiredBudgetRawUsdc) {
    return {
      ok: false,
      code: "insufficient_yield",
      budget,
      details: {
        spendableYieldRawUsdc: budget.spendableYieldRawUsdc.toString(),
        requiredBudgetRawUsdc: requiredBudgetRawUsdc.toString(),
        sellerAmountRawUsdc: params.sellerAmountRawUsdc.toString(),
        // Gross withdraw including the vault withdrawal penalty.
        requiredWithdrawRawUsdc: requiredWithdrawRawUsdc.toString(),
        estimatedFeeDebtRawUsdc: params.estimatedFeeDebtRawUsdc.toString()
      }
    };
  }

  const requiredInstantRedeemCapacityRawUsdc =
    activeWithdrawReservedRawUsdc + requiredWithdrawRawUsdc;
  if (
    params.position.instantRedeemCapacityRawUsdc <
    requiredInstantRedeemCapacityRawUsdc
  ) {
    return {
      ok: false,
      code: "budget_illiquid",
      budget,
      details: {
        instantRedeemCapacityRawUsdc:
          params.position.instantRedeemCapacityRawUsdc.toString(),
        activeWithdrawReservedRawUsdc:
          activeWithdrawReservedRawUsdc.toString(),
        requiredWithdrawRawUsdc: requiredWithdrawRawUsdc.toString(),
        requiredInstantRedeemCapacityRawUsdc:
          requiredInstantRedeemCapacityRawUsdc.toString()
      }
    };
  }

  const postPositionValueRawUsdc =
    budget.positionValueRawUsdc - requiredWithdrawRawUsdc;
  const invariantLeft =
    postPositionValueRawUsdc -
    params.position.reservedRawUsdc -
    params.position.feeDebtRawUsdc -
    params.estimatedFeeDebtRawUsdc;
  const invariantRight =
    params.position.principalBasisRawUsdc +
    params.position.safetyBufferRawUsdc;

  if (invariantLeft < invariantRight) {
    return {
      ok: false,
      code: "post_state_principal_invariant_failed",
      budget,
      details: {
        invariantLeft: invariantLeft.toString(),
        invariantRight: invariantRight.toString()
      }
    };
  }

  return {
    ok: true,
    budget,
    requiredBudgetRawUsdc,
    requiredWithdrawRawUsdc,
    sharesToRedeemRaw: sharesToRedeemRaw(
      requiredWithdrawRawUsdc,
      params.position.exchangeRateScaled
    ),
    postPositionValueRawUsdc,
    reservationRawUsdc: requiredBudgetRawUsdc
  };
}
