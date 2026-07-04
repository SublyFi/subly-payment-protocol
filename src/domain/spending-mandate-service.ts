import { randomUUID } from "node:crypto";
import { rawUnitsToString } from "../lib/raw-units.js";
import { badRequest, conflict, forbidden, notFound } from "./errors.js";
import type { Ledger } from "./ledger.js";
import type {
  PaymentBindingWire,
  SpendingApproval,
  SpendingMandateEventType,
  SpendingMandateRecord,
  WithdrawalIntent
} from "./models.js";
import {
  approvalSigningMessage,
  assertFreshSignedAt,
  bindingHashOf,
  DEFAULT_RELAYER_POLICY,
  mandateSigningMessage,
  parseMandatePolicy,
  recoveryCancelSigningMessage,
  revokeSigningMessage,
  validateMandateDocument,
  verifyEd25519Message,
  type ApprovalBinding,
  type MandateEnforcementLevel,
  type MandatePolicy,
  type SpendingMandateDocument
} from "./spending-mandate.js";

const DAY_MS = 24 * 60 * 60 * 1000;
const ROLLING_MONTH_MS = 30 * DAY_MS;
const APPROVAL_TTL_MS = 15 * 60 * 1000;
const RECOVERY_GRACE_MS = 72 * 60 * 60 * 1000;

export interface SpendingMandateServiceConfig {
  /** SUBLY_MANDATE_ENFORCEMENT staged rollout: off | warn (default) | on. */
  enforcementLevel: MandateEnforcementLevel;
  /** Base for human approve links pasted into chat; approvalId is appended. */
  approveUrlBase: string;
  /** Violation sink for warn mode (defaults to console.warn). */
  onWarn?: ((message: string, detail: unknown) => void) | undefined;
  /** Injectable clock for tests. */
  nowMs?: (() => number) | undefined;
}

const DEFAULT_CONFIG: SpendingMandateServiceConfig = {
  enforcementLevel: "warn",
  approveUrlBase: "https://app.subly.fi/approve/"
};

/** How a wallet's effective policy was resolved for one authorization. */
interface EffectivePolicy {
  policy: MandatePolicy;
  policySource: string; // "default" | "mandate:<hash>"
  mandate: SpendingMandateRecord | null;
  /** True only while an unexpired, unrevoked mandate applies (owner exists). */
  ownerAvailable: boolean;
  /** Kill switch: an explicitly revoked mandate blocks everything. */
  revoked: boolean;
}

export interface RealizeAuthorization {
  policySource: string;
  mandateHash: string | null;
  policyDecision: string;
  approvalId: string | null;
}

export interface DepositAuthorization {
  policySource: string;
  mandateHash: string | null;
}

/**
 * Server-side enforcement of spending mandates and the relayer default
 * policy (docs/spending-mandate-design.md). Layered ON TOP of the existing
 * yield-only guard: this service decides whether a realize/deposit is within
 * the human-delegated scope; the budget guard still decides whether the
 * yield can cover it.
 *
 * Callers must invoke the authorize* methods inside the wallet-vault lock
 * (VaultFlowService does) so window sums and approval state cannot race.
 */
export class SpendingMandateService {
  private readonly ledger: Ledger;
  private readonly config: SpendingMandateServiceConfig;

  constructor(params: {
    ledger: Ledger;
    config?: Partial<SpendingMandateServiceConfig>;
  }) {
    this.ledger = params.ledger;
    this.config = { ...DEFAULT_CONFIG, ...params.config };
  }

  get enforcementLevel(): MandateEnforcementLevel {
    return this.config.enforcementLevel;
  }

  // ---------------------------------------------------------------- mandate

  async registerMandate(input: {
    wallet: string;
    vault: string;
    document: SpendingMandateDocument;
  }) {
    const nowMs = this.now();
    const { document } = input;
    const validated = validateMandateDocument({
      document,
      wallet: input.wallet,
      vault: input.vault,
      nowMs
    });

    return this.ledger.withWalletVaultLock(input.wallet, input.vault, async () => {
      const existing = await this.ledger.getSpendingMandate(input.wallet);
      const isFirstRegistration = existing === null;

      if (existing !== null) {
        // Monotonic issuedAtMs stops replaying an older (looser) mandate.
        if (document.issuedAtMs <= existing.issuedAtMs) {
          throw conflict(
            "mandate_replay_rejected",
            "a mandate with an equal or newer issuedAtMs is already registered",
            { registeredIssuedAtMs: existing.issuedAtMs }
          );
        }
        this.assertReplaceAuthorized(existing, document, validated.mandateHash, nowMs);
      }

      const record: SpendingMandateRecord = {
        wallet: input.wallet,
        vault: input.vault,
        documentJson: document,
        mandateHash: validated.mandateHash,
        ownerAuth: document.ownerAuth,
        ownerCredential: {
          publicKey: document.ownerCredential.publicKey,
          ...(document.ownerCredential.credentialId === undefined
            ? {}
            : { credentialId: document.ownerCredential.credentialId })
        },
        enforcementMode: document.enforcementMode,
        issuedAtMs: document.issuedAtMs,
        expiresAtMs: document.expiresAtMs,
        status: "active",
        recoveryAtMs: null,
        revokedAtMs: null,
        revokeJson: null
      };
      await this.ledger.saveSpendingMandate(record);
      await this.recordEvent(
        input.wallet,
        isFirstRegistration ? "registered" : "replaced",
        validated.mandateHash,
        document
      );

      // The mandate's owner signature + agent co-sign double as the approval
      // for the FIRST deposit (one Face ID covers both). Replacements never
      // re-issue it — initialDeposit is onboarding-only.
      let initialDepositApproval: SpendingApproval | null = null;
      if (isFirstRegistration && document.initialDeposit !== undefined) {
        initialDepositApproval = await this.issueApprovedApproval({
          wallet: input.wallet,
          mandateHash: validated.mandateHash,
          binding: {
            kind: "deposit",
            amountRawUsdc: document.initialDeposit.amountRawUsdc
          },
          decisionJson: {
            source: "mandate_initial_deposit",
            mandateHash: validated.mandateHash
          },
          nowMs
        });
      }

      return {
        wallet: input.wallet,
        mandateHash: validated.mandateHash,
        status: record.status,
        issuedAtMs: record.issuedAtMs,
        expiresAtMs: record.expiresAtMs,
        policySource: `mandate:${validated.mandateHash}`,
        initialDepositApproval:
          initialDepositApproval === null
            ? null
            : {
                approvalId: initialDepositApproval.approvalId,
                expiresAtMs: initialDepositApproval.expiresAtMs
              }
      };
    });
  }

  async getMandate(wallet: string, vault: string) {
    const record = await this.ledger.getSpendingMandate(wallet);
    if (record === null) {
      throw notFound("mandate_not_found", "No spending mandate is registered for this wallet");
    }
    const nowMs = this.now();
    return {
      wallet: record.wallet,
      mandate: record.documentJson,
      mandateHash: record.mandateHash,
      status: record.status,
      effectiveStatus: this.effectiveStatus(record, nowMs),
      recoveryAtMs: record.recoveryAtMs,
      revokedAtMs: record.revokedAtMs,
      usage: {
        dailyApiSpendRawUsdc: rawUnitsToString(
          await this.confirmedRealizeSum(wallet, vault, nowMs - DAY_MS)
        ),
        dailyDepositRawUsdc: rawUnitsToString(
          await this.confirmedDepositSum(wallet, vault, nowMs - DAY_MS)
        )
      }
    };
  }

  async revokeMandate(input: {
    wallet: string;
    mandateHash: string;
    signedAtMs: number;
    signature: string;
  }) {
    const nowMs = this.now();
    const record = await this.requireMandate(input.wallet);
    if (record.mandateHash !== input.mandateHash) {
      throw conflict(
        "mandate_hash_mismatch",
        "mandateHash does not match the registered mandate"
      );
    }
    if (record.status === "revoked") {
      return { wallet: input.wallet, mandateHash: record.mandateHash, status: "revoked" };
    }
    assertFreshSignedAt(input.signedAtMs, nowMs);
    this.assertOwnerSignature(record, {
      message: revokeSigningMessage(input.mandateHash, input.signedAtMs),
      signature: input.signature,
      code: "revoke_signature_invalid"
    });

    const revoked: SpendingMandateRecord = {
      ...record,
      status: "revoked",
      recoveryAtMs: null,
      revokedAtMs: nowMs,
      revokeJson: {
        mandateHash: input.mandateHash,
        signedAtMs: input.signedAtMs,
        signature: input.signature
      }
    };
    await this.ledger.saveSpendingMandate(revoked);
    await this.recordEvent(input.wallet, "revoked", record.mandateHash, revoked.revokeJson);

    return { wallet: input.wallet, mandateHash: record.mandateHash, status: "revoked" };
  }

  /**
   * Dead-man switch for a lost owner credential: the AGENT key schedules a
   * revoke that only takes effect after a 72h grace window, during which the
   * real owner can veto it. Exposed in mandate reads so the owner can see it.
   */
  async scheduleRecoveryRevoke(wallet: string) {
    const nowMs = this.now();
    const record = await this.requireMandate(wallet);
    if (record.status === "revoked") {
      throw conflict("mandate_revoked", "the mandate is already revoked");
    }
    if (record.status === "recovery_pending" && record.recoveryAtMs !== null) {
      return {
        wallet,
        mandateHash: record.mandateHash,
        status: record.status,
        recoveryAtMs: record.recoveryAtMs
      };
    }

    const recoveryAtMs = nowMs + RECOVERY_GRACE_MS;
    const updated: SpendingMandateRecord = {
      ...record,
      status: "recovery_pending",
      recoveryAtMs
    };
    await this.ledger.saveSpendingMandate(updated);
    await this.recordEvent(wallet, "recovery_scheduled", record.mandateHash, {
      recoveryAtMs
    });

    return {
      wallet,
      mandateHash: record.mandateHash,
      status: updated.status,
      recoveryAtMs
    };
  }

  async cancelRecoveryRevoke(input: {
    wallet: string;
    mandateHash: string;
    signedAtMs: number;
    signature: string;
  }) {
    const nowMs = this.now();
    const record = await this.requireMandate(input.wallet);
    if (record.status !== "recovery_pending" || record.recoveryAtMs === null) {
      throw conflict(
        "recovery_not_pending",
        "no recovery-revoke is pending for this mandate"
      );
    }
    if (record.recoveryAtMs <= nowMs) {
      throw conflict(
        "recovery_elapsed",
        "the recovery grace window has already elapsed"
      );
    }
    if (record.mandateHash !== input.mandateHash) {
      throw conflict(
        "mandate_hash_mismatch",
        "mandateHash does not match the registered mandate"
      );
    }
    assertFreshSignedAt(input.signedAtMs, nowMs);
    this.assertOwnerSignature(record, {
      message: recoveryCancelSigningMessage(input.mandateHash, input.signedAtMs),
      signature: input.signature,
      code: "recovery_cancel_signature_invalid"
    });

    const restored: SpendingMandateRecord = {
      ...record,
      status: "active",
      recoveryAtMs: null
    };
    await this.ledger.saveSpendingMandate(restored);
    await this.recordEvent(input.wallet, "recovery_cancelled", record.mandateHash, {
      cancelledAtMs: nowMs
    });

    return { wallet: input.wallet, mandateHash: record.mandateHash, status: "active" };
  }

  // -------------------------------------------------------------- approvals

  async decideApproval(input: {
    approvalId: string;
    decision: "approve" | "deny";
    signedAtMs: number;
    signature: string;
  }) {
    const nowMs = this.now();
    const approval = await this.ledger.getSpendingApproval(input.approvalId);
    if (approval === null) {
      throw notFound("approval_not_found", "Approval does not exist");
    }
    const current = await this.expireIfStale(approval, nowMs);
    if (current.status === "expired") {
      throw conflict("approval_expired", "the approval TTL has elapsed; retry the operation to get a new one");
    }
    if (current.status !== "pending") {
      throw conflict(
        "approval_already_decided",
        `the approval is already ${current.status}`
      );
    }

    // Decisions are verified against the CURRENT owner credential, not the
    // one that existed when the approval was created.
    const record = await this.requireMandate(current.wallet);
    if (this.effectiveStatus(record, nowMs) !== "active" &&
        this.effectiveStatus(record, nowMs) !== "recovery_pending") {
      throw conflict(
        "mandate_not_active",
        "approvals require an active mandate owner"
      );
    }
    assertFreshSignedAt(input.signedAtMs, nowMs);
    this.assertOwnerSignature(record, {
      message: approvalSigningMessage({
        approvalId: input.approvalId,
        decision: input.decision,
        bindingHash: current.bindingHash,
        signedAtMs: input.signedAtMs
      }),
      signature: input.signature,
      code: "approval_signature_invalid"
    });

    const decided: SpendingApproval = {
      ...current,
      status: input.decision === "approve" ? "approved" : "denied",
      decidedAtMs: nowMs,
      decisionJson: {
        decision: input.decision,
        signedAtMs: input.signedAtMs,
        signature: input.signature,
        mandateHash: record.mandateHash
      }
    };
    await this.ledger.saveSpendingApproval(decided);

    return serializeApproval(decided);
  }

  async listApprovals(wallet: string, status?: string) {
    const nowMs = this.now();
    const approvals = await this.ledger.listSpendingApprovalsForWallet(wallet);
    const current = await Promise.all(
      approvals.map((approval) => this.expireIfStale(approval, nowMs))
    );
    return current
      .filter((approval) => status === undefined || approval.status === status)
      .map(serializeApproval);
  }

  /**
   * Marks an approval consumed once the realize/deposit it authorized reached
   * confirmed on-chain. Until then the same approvalId may re-prepare within
   * its TTL (chain hiccups must not send the human back to Face ID).
   */
  async consumeApproval(approvalId: string, consumedByWithdrawalId: string) {
    const approval = await this.ledger.getSpendingApproval(approvalId);
    if (approval === null || approval.status !== "approved") {
      return;
    }
    await this.ledger.saveSpendingApproval({
      ...approval,
      status: "consumed",
      consumedAtMs: this.now(),
      consumedByWithdrawalId
    });
  }

  // ------------------------------------------------------------ enforcement

  /**
   * Mandate/default-policy gate for a yield-realize withdrawal, evaluated
   * BEFORE the yield-only budget guard. Returns the audit decision to stamp
   * on the intent, or throws the design's error codes in "on" mode.
   */
  async authorizeRealize(input: {
    wallet: string;
    vault: string;
    amountRawUsdc: bigint;
    payment: PaymentBindingWire | null;
    approvalId: string | null;
  }): Promise<RealizeAuthorization> {
    if (this.config.enforcementLevel === "off") {
      return {
        policySource: "default",
        mandateHash: null,
        policyDecision: "unenforced",
        approvalId: null
      };
    }

    const nowMs = this.now();
    const effective = await this.resolvePolicy(input.wallet, nowMs);
    const base: RealizeAuthorization = {
      policySource: effective.policySource,
      mandateHash: effective.mandate?.mandateHash ?? null,
      policyDecision: "auto_within_policy",
      approvalId: null
    };

    // 1. Kill switch: an explicitly revoked mandate blocks all payments.
    if (effective.revoked) {
      this.violation(
        conflict("mandate_revoked", "the spending mandate was revoked by the owner; all payments are blocked")
      );
      return base;
    }

    const payment = input.payment;
    if (payment === null) {
      this.violation(
        badRequest(
          "payment_binding_required",
          "yield_realize withdrawals must declare the payment they fund " +
            "({ payTo, amountRawUsdc, resourceUrlHash, method })"
        )
      );
    } else if (BigInt(payment.amountRawUsdc) !== input.amountRawUsdc) {
      this.violation(
        badRequest(
          "payment_binding_mismatch",
          "payment.amountRawUsdc must equal the realize amountRawUsdc"
        )
      );
    }

    const { policy } = effective;
    const amount = input.amountRawUsdc;

    // 2. Payee allowlist.
    if (
      payment !== null &&
      policy.allowedPayToAddresses !== null &&
      !policy.allowedPayToAddresses.includes(payment.payTo)
    ) {
      this.violation(
        conflict("payee_not_allowed", "payTo is not in the mandate's allowed payee list", {
          payTo: payment.payTo
        })
      );
    }

    // 3. Absolute per-payment cap — approval never lifts it.
    if (amount > policy.perPaymentCapRawUsdc) {
      this.violation(
        conflict(
          "per_payment_cap_exceeded",
          "the payment exceeds the absolute per-payment cap",
          {
            amountRawUsdc: amount.toString(),
            perPaymentCapRawUsdc: policy.perPaymentCapRawUsdc.toString()
          }
        )
      );
      return base;
    }

    // 4. Rolling daily/monthly spend windows (confirmed realizes count,
    //    approved payments included — approval waives the threshold, not caps).
    if (policy.dailyApiSpendCapRawUsdc !== null) {
      const spent = await this.confirmedRealizeSum(input.wallet, input.vault, nowMs - DAY_MS);
      if (spent + amount > policy.dailyApiSpendCapRawUsdc) {
        this.violation(
          conflict("daily_cap_exceeded", "the rolling 24h API spend cap is exhausted", {
            spentRawUsdc: spent.toString(),
            amountRawUsdc: amount.toString(),
            dailyApiSpendCapRawUsdc: policy.dailyApiSpendCapRawUsdc.toString()
          })
        );
      }
    }
    if (policy.monthlyApiSpendCapRawUsdc !== null) {
      const spent = await this.confirmedRealizeSum(
        input.wallet,
        input.vault,
        nowMs - ROLLING_MONTH_MS
      );
      if (spent + amount > policy.monthlyApiSpendCapRawUsdc) {
        this.violation(
          conflict("monthly_cap_exceeded", "the rolling 30d API spend cap is exhausted", {
            spentRawUsdc: spent.toString(),
            amountRawUsdc: amount.toString(),
            monthlyApiSpendCapRawUsdc: policy.monthlyApiSpendCapRawUsdc.toString()
          })
        );
      }
    }

    // 5. Threshold escalation: above the threshold a valid owner approval is
    //    required (or, with no owner registered, the payment is refused).
    if (
      policy.approvalThresholdRawUsdc !== null &&
      amount > policy.approvalThresholdRawUsdc
    ) {
      if (!effective.ownerAvailable) {
        this.violation(
          conflict(
            "mandate_required_for_larger_payments",
            "payments above the default approval threshold require a registered " +
              "spending mandate so an owner can approve them; run Subly setup first",
            {
              amountRawUsdc: amount.toString(),
              approvalThresholdRawUsdc: policy.approvalThresholdRawUsdc.toString()
            }
          )
        );
        return base;
      }
      if (payment !== null && this.config.enforcementLevel === "on") {
        const approval = await this.requirePaymentApproval({
          wallet: input.wallet,
          vault: input.vault,
          mandateHash: effective.mandate!.mandateHash,
          payment,
          approvalId: input.approvalId,
          nowMs
        });
        return {
          ...base,
          policyDecision: `owner_approved:${approval.approvalId}`,
          approvalId: approval.approvalId
        };
      }
      if (this.config.enforcementLevel === "warn") {
        this.warn("approval_required would fire for this payment", {
          wallet: input.wallet,
          amountRawUsdc: amount.toString()
        });
      }
    }

    return base;
  }

  /** Daily-deposit-cap gate (Phase 1; depositPolicy approval lands with the
   *  web approve page in Phase 2). Revoked mandates block deposits too. */
  async authorizeDeposit(input: {
    wallet: string;
    vault: string;
    amountRawUsdc: bigint;
  }): Promise<DepositAuthorization> {
    if (this.config.enforcementLevel === "off") {
      return { policySource: "default", mandateHash: null };
    }

    const nowMs = this.now();
    const effective = await this.resolvePolicy(input.wallet, nowMs);
    if (effective.revoked) {
      this.violation(
        conflict("mandate_revoked", "the spending mandate was revoked by the owner; deposits are blocked")
      );
    }

    if (effective.policy.dailyDepositCapRawUsdc !== null) {
      const deposited = await this.confirmedDepositSum(
        input.wallet,
        input.vault,
        nowMs - DAY_MS
      );
      if (deposited + input.amountRawUsdc > effective.policy.dailyDepositCapRawUsdc) {
        this.violation(
          conflict(
            "daily_deposit_cap_exceeded",
            "the rolling 24h deposit cap is exhausted; it is an absolute ceiling",
            {
              depositedRawUsdc: deposited.toString(),
              amountRawUsdc: input.amountRawUsdc.toString(),
              dailyDepositCapRawUsdc:
                effective.policy.dailyDepositCapRawUsdc.toString()
            }
          )
        );
      }
    }

    return {
      policySource: effective.policySource,
      mandateHash: effective.mandate?.mandateHash ?? null
    };
  }

  // ----------------------------------------------------------- spending log

  /**
   * Human-readable payment history: one row per confirmed yield-realize,
   * the AP2-style delegation → decision → execution-tx correspondence.
   */
  async spendingLog(wallet: string, vault: string, limit = 100) {
    const withdrawals = await this.ledger.listWithdrawalsForPosition(wallet, vault);
    const entries = withdrawals
      .filter(
        (intent) => intent.purpose === "yield_realize" && intent.status === "confirmed"
      )
      .sort((a, b) => terminalMs(b) - terminalMs(a))
      .slice(0, limit)
      .map((intent) => ({
        paidAtMs: terminalMs(intent),
        payTo: intent.paymentBinding?.payTo ?? null,
        amountRawUsdc: rawUnitsToString(intent.requestedWithdrawRawUsdc),
        resourceUrlHash: intent.paymentBinding?.resourceUrlHash ?? null,
        method: intent.paymentBinding?.method ?? null,
        realizeTxSignature: intent.txSignature,
        paymentTxSignature: intent.paymentTxSignature,
        paymentVerification: intent.paymentVerification ?? "unreported",
        decision: intent.policyDecision ?? "auto_within_policy",
        mandateHash: intent.mandateHash,
        policySource: intent.policySource ?? "default"
      }));

    return { wallet, vault, entries };
  }

  // ---------------------------------------------------------------- private

  private async requirePaymentApproval(input: {
    wallet: string;
    vault: string;
    mandateHash: string;
    payment: PaymentBindingWire;
    approvalId: string | null;
    nowMs: number;
  }): Promise<SpendingApproval> {
    const binding: ApprovalBinding = {
      kind: "payment",
      payTo: input.payment.payTo,
      amountRawUsdc: input.payment.amountRawUsdc,
      resourceUrlHash: input.payment.resourceUrlHash,
      method: input.payment.method
    };
    const bindingHash = bindingHashOf(binding);

    if (input.approvalId !== null) {
      const provided = await this.ledger.getSpendingApproval(input.approvalId);
      if (provided !== null && provided.wallet === input.wallet) {
        const current = await this.expireIfStale(provided, input.nowMs);
        if (
          current.status === "approved" &&
          current.bindingHash === bindingHash &&
          !(await this.approvalInFlight(current.approvalId, input.wallet, input.vault))
        ) {
          return current;
        }
      }
    }

    // Invalid/missing approval: surface (or reuse) a pending approval and
    // refuse. Nothing has been realized, so the same call can be retried
    // with the approvalId once the owner has signed.
    const pending = await this.findReusablePending(input.wallet, bindingHash, input.nowMs);
    const approval =
      pending ??
      (await this.ledger.saveSpendingApproval({
        approvalId: newApprovalId(),
        wallet: input.wallet,
        bindingHash,
        bindingJson: binding,
        mandateHash: input.mandateHash,
        status: "pending",
        decisionJson: null,
        requestedAtMs: input.nowMs,
        expiresAtMs: input.nowMs + APPROVAL_TTL_MS,
        decidedAtMs: null,
        consumedAtMs: null,
        consumedByWithdrawalId: null
      }));

    throw conflict(
      "approval_required",
      `この支払いは承認閾値を超えています。owner の承認後、同じ呼び出しを approvalId 付きで再試行してください。`,
      {
        approvalId: approval.approvalId,
        expiresAtMs: approval.expiresAtMs,
        approveUrl: `${this.config.approveUrlBase}${approval.approvalId}`,
        approveCommand: `subly-pay approve ${approval.approvalId}`
      }
    );
  }

  /** One in-flight realize per approval: binding-bound + TTL + this. */
  private async approvalInFlight(
    approvalId: string,
    wallet: string,
    vault: string
  ): Promise<boolean> {
    const withdrawals = await this.ledger.listWithdrawalsForPosition(wallet, vault);
    return withdrawals.some(
      (intent) =>
        intent.approvalId === approvalId &&
        (intent.status === "submitted" ||
          (intent.status === "prepared" && !intentExpired(intent)))
    );
  }

  private async findReusablePending(
    wallet: string,
    bindingHash: string,
    nowMs: number
  ): Promise<SpendingApproval | null> {
    const approvals = await this.ledger.listSpendingApprovalsForWallet(wallet);
    for (const approval of approvals) {
      if (
        approval.bindingHash === bindingHash &&
        approval.status === "pending" &&
        approval.expiresAtMs > nowMs
      ) {
        return approval;
      }
    }
    return null;
  }

  private async issueApprovedApproval(input: {
    wallet: string;
    mandateHash: string;
    binding: ApprovalBinding;
    decisionJson: unknown;
    nowMs: number;
  }): Promise<SpendingApproval> {
    return this.ledger.saveSpendingApproval({
      approvalId: newApprovalId(),
      wallet: input.wallet,
      bindingHash: bindingHashOf(input.binding),
      bindingJson: input.binding,
      mandateHash: input.mandateHash,
      status: "approved",
      decisionJson: input.decisionJson,
      requestedAtMs: input.nowMs,
      expiresAtMs: input.nowMs + APPROVAL_TTL_MS,
      decidedAtMs: input.nowMs,
      consumedAtMs: null,
      consumedByWithdrawalId: null
    });
  }

  private async expireIfStale(
    approval: SpendingApproval,
    nowMs: number
  ): Promise<SpendingApproval> {
    if (
      (approval.status === "pending" || approval.status === "approved") &&
      approval.expiresAtMs <= nowMs
    ) {
      return this.ledger.saveSpendingApproval({ ...approval, status: "expired" });
    }
    return approval;
  }

  private async resolvePolicy(
    wallet: string,
    nowMs: number
  ): Promise<EffectivePolicy> {
    const record = await this.ledger.getSpendingMandate(wallet);
    if (record === null) {
      return {
        policy: DEFAULT_RELAYER_POLICY,
        policySource: "default",
        mandate: null,
        ownerAvailable: false,
        revoked: false
      };
    }

    const status = this.effectiveStatus(record, nowMs);
    if (status === "revoked") {
      return {
        policy: DEFAULT_RELAYER_POLICY,
        policySource: "default",
        mandate: record,
        ownerAvailable: false,
        revoked: true
      };
    }
    if (status === "expired" || status === "recovery_elapsed") {
      // Back to the relayer default policy, as if unregistered.
      return {
        policy: DEFAULT_RELAYER_POLICY,
        policySource: "default",
        mandate: null,
        ownerAvailable: false,
        revoked: false
      };
    }

    const document = record.documentJson as SpendingMandateDocument;
    return {
      policy: parseMandatePolicy(document.policy),
      policySource: `mandate:${record.mandateHash}`,
      mandate: record,
      ownerAvailable: true,
      revoked: false
    };
  }

  private effectiveStatus(
    record: SpendingMandateRecord,
    nowMs: number
  ): "active" | "expired" | "revoked" | "recovery_pending" | "recovery_elapsed" {
    if (record.status === "revoked") {
      return "revoked";
    }
    if (record.status === "recovery_pending") {
      return record.recoveryAtMs !== null && record.recoveryAtMs <= nowMs
        ? "recovery_elapsed"
        : "recovery_pending";
    }
    return record.expiresAtMs <= nowMs ? "expired" : "active";
  }

  private async confirmedRealizeSum(
    wallet: string,
    vault: string,
    sinceMs: number
  ): Promise<bigint> {
    const withdrawals = await this.ledger.listWithdrawalsForPosition(wallet, vault);
    let sum = 0n;
    for (const intent of withdrawals) {
      if (
        intent.purpose === "yield_realize" &&
        intent.status === "confirmed" &&
        terminalMs(intent) >= sinceMs
      ) {
        sum += intent.requestedWithdrawRawUsdc;
      }
    }
    return sum;
  }

  private async confirmedDepositSum(
    wallet: string,
    vault: string,
    sinceMs: number
  ): Promise<bigint> {
    const deposits = await this.ledger.listDepositsForPosition(wallet, vault);
    let sum = 0n;
    for (const intent of deposits) {
      if (intent.status === "confirmed" && terminalMs(intent) >= sinceMs) {
        sum += intent.actualDepositRawUsdc ?? intent.amountRawUsdc;
      }
    }
    return sum;
  }

  private assertReplaceAuthorized(
    existing: SpendingMandateRecord,
    document: SpendingMandateDocument,
    newMandateHash: string,
    nowMs: number
  ): void {
    const status = this.effectiveStatus(existing, nowMs);
    // An expired or recovery-elapsed mandate behaves like "unregistered":
    // anyone holding the agent key may set up a fresh owner.
    if (status === "expired" || status === "recovery_elapsed") {
      return;
    }
    const sameOwner =
      existing.ownerCredential.publicKey === document.ownerCredential.publicKey;
    if (sameOwner) {
      return;
    }
    if (status === "revoked") {
      // Revocation is permanent for everyone except the same owner.
      throw forbidden(
        "mandate_revoked",
        "a revoked mandate can only be replaced by the same owner credential"
      );
    }
    // Live mandate, different owner: credential rotation needs the CURRENT
    // owner to co-sign the new mandate — the agent key alone cannot swap
    // the human out from under the delegation.
    if (
      document.currentOwnerSignature === undefined ||
      !verifyEd25519Message({
        message: mandateSigningMessage(newMandateHash),
        signatureBase58: document.currentOwnerSignature,
        publicKeyBase58: existing.ownerCredential.publicKey
      })
    ) {
      throw forbidden(
        "owner_rotation_requires_current_owner",
        "replacing the owner credential requires currentOwnerSignature by the registered owner"
      );
    }
  }

  private assertOwnerSignature(
    record: SpendingMandateRecord,
    input: { message: string; signature: string; code: string }
  ): void {
    if (record.ownerAuth !== "ed25519") {
      throw badRequest(
        "owner_auth_unsupported",
        "passkey owner verification is not yet supported"
      );
    }
    if (
      !verifyEd25519Message({
        message: input.message,
        signatureBase58: input.signature,
        publicKeyBase58: record.ownerCredential.publicKey
      })
    ) {
      throw forbidden(
        input.code,
        "the signature does not verify against the registered owner credential"
      );
    }
  }

  private async requireMandate(wallet: string): Promise<SpendingMandateRecord> {
    const record = await this.ledger.getSpendingMandate(wallet);
    if (record === null) {
      throw notFound(
        "mandate_not_found",
        "No spending mandate is registered for this wallet"
      );
    }
    return record;
  }

  private async recordEvent(
    wallet: string,
    eventType: SpendingMandateEventType,
    mandateHash: string,
    documentJson: unknown
  ): Promise<void> {
    await this.ledger.saveSpendingMandateEvent({
      eventId: `mev_${randomUUID().replaceAll("-", "")}`,
      wallet,
      eventType,
      mandateHash,
      documentJson,
      createdAtMs: this.now()
    });
  }

  /** In "on" mode a violation blocks; in "warn" mode it is only logged. */
  private violation(error: Error & { code?: string; details?: unknown }): void {
    if (this.config.enforcementLevel === "on") {
      throw error;
    }
    this.warn(`mandate violation (not enforced): ${error.message}`, {
      code: (error as { code?: string }).code,
      details: (error as { details?: unknown }).details
    });
  }

  private warn(message: string, detail: unknown): void {
    const sink =
      this.config.onWarn ??
      ((msg: string, det: unknown) => console.warn(`[subly-mandate] ${msg}`, det));
    sink(message, detail);
  }

  private now(): number {
    return this.config.nowMs === undefined ? Date.now() : this.config.nowMs();
  }
}

function newApprovalId(): string {
  return `apr_${randomUUID().replaceAll("-", "")}`;
}

function terminalMs(intent: { terminalAt: string | null }): number {
  const parsed = intent.terminalAt === null ? NaN : new Date(intent.terminalAt).getTime();
  return Number.isFinite(parsed) ? parsed : 0;
}

function intentExpired(intent: WithdrawalIntent): boolean {
  const expiresAtMs = new Date(intent.expiresAt).getTime();
  return !Number.isFinite(expiresAtMs) || expiresAtMs <= Date.now();
}

export function serializeApproval(approval: SpendingApproval) {
  return {
    approvalId: approval.approvalId,
    wallet: approval.wallet,
    bindingHash: approval.bindingHash,
    binding: approval.bindingJson,
    mandateHash: approval.mandateHash,
    status: approval.status,
    requestedAtMs: approval.requestedAtMs,
    expiresAtMs: approval.expiresAtMs,
    decidedAtMs: approval.decidedAtMs,
    consumedAtMs: approval.consumedAtMs,
    consumedByWithdrawalId: approval.consumedByWithdrawalId
  };
}
