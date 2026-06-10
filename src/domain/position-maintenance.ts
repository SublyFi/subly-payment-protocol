import { clampToZero } from "../lib/raw-units.js";
import type { Ledger } from "./ledger.js";
import type { PaymentIntent, WalletPosition } from "./models.js";

export function paymentIntentExpired(intent: PaymentIntent): boolean {
  const expiresAtMs = new Date(intent.expiresAt).getTime();
  return !Number.isFinite(expiresAtMs) || expiresAtMs <= Date.now();
}

export function expiredPaymentResponse(paymentId: string) {
  return {
    isValid: false,
    invalidReason: "expired",
    paymentId,
    success: false,
    error: {
      code: "expired",
      message: "Payment intent has expired"
    }
  };
}

/**
 * Expires prepared-but-unsubmitted payment intents and releases their
 * reservations. Must be called while holding the (wallet, vault) lock.
 */
export async function expirePreparedPaymentsForLockedPosition(
  ledger: Ledger,
  wallet: string,
  vault: string
): Promise<WalletPosition | null> {
  const position = await ledger.getPosition(wallet, vault);
  if (position === null) {
    return null;
  }

  const payments = await ledger.listPaymentsForPosition(wallet, vault);
  const expiredPreparedPayments = payments.filter(
    (payment) => payment.status === "prepared" && paymentIntentExpired(payment)
  );
  if (expiredPreparedPayments.length === 0) {
    return position;
  }

  const now = new Date().toISOString();
  let releasedReservationRawUsdc = 0n;
  for (const payment of expiredPreparedPayments) {
    releasedReservationRawUsdc += payment.reservationRawUsdc;
    await ledger.savePayment({
      ...payment,
      status: "expired",
      terminalAt: now,
      settlementResponse: expiredPaymentResponse(payment.paymentId)
    });
  }

  return ledger.savePosition({
    ...position,
    reservedRawUsdc: clampToZero(
      position.reservedRawUsdc - releasedReservationRawUsdc
    ),
    version: position.version + 1
  });
}

/**
 * Payments holding a settlement reservation or awaiting terminal settlement.
 * While any of these exist the wallet position must stay locked for normal
 * withdrawals and baseline resets.
 */
export function activeSubmittedPayments(
  payments: PaymentIntent[]
): PaymentIntent[] {
  return payments.filter(
    (payment) =>
      payment.status === "submission_prepared" || payment.status === "submitted"
  );
}
