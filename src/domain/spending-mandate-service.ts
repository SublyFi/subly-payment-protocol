import { randomUUID } from "node:crypto";
import { canonicalJson } from "../lib/canonical-json.js";
import { rawUnitsToString } from "../lib/raw-units.js";
import {
  badRequest,
  conflict,
  forbidden,
  notFound,
  type SublyError
} from "./errors.js";
import type { Ledger } from "./ledger.js";
import type {
  PaymentBindingWire,
  SetupSession,
  SpendingApproval,
  SpendingMandateEventType,
  SpendingMandateRecord
} from "./models.js";
import {
  approvalSigningMessage,
  assertFreshSignedAt,
  bindingHashOf,
  DEFAULT_RELAYER_POLICY,
  defaultMandatePolicyWire,
  mandateSigningMessage,
  parseMandatePolicy,
  recoveryCancelSigningMessage,
  revokeSigningMessage,
  validateMandateDocument,
  verifyOwnerMessageSignature,
  type ApprovalBinding,
  type MandateEnforcementLevel,
  type MandateEnforcementMode,
  type MandatePolicy,
  type MandatePolicyWire,
  type SpendingMandateDocument
} from "./spending-mandate.js";
import type { WebAuthnOwnerConfig } from "./webauthn-owner.js";

const DAY_MS = 24 * 60 * 60 * 1000;
const ROLLING_MONTH_MS = 30 * DAY_MS;
const APPROVAL_TTL_MS = 15 * 60 * 1000;
const APPROVAL_RETENTION_MS = 7 * DAY_MS;
const MAX_PENDING_APPROVALS_PER_WALLET = 20;
const RECOVERY_GRACE_MS = 72 * 60 * 60 * 1000;
const SETUP_SESSION_TTL_MS = 10 * 60 * 1000;
const DEFAULT_MANDATE_TTL_MS = 365 * DAY_MS;

export interface SpendingMandateServiceConfig {
  /** SUBLY_MANDATE_ENFORCEMENT: off | warn | on (secure default: on). */
  enforcementLevel: MandateEnforcementLevel;
  /** Base for human approve links pasted into chat; approvalId is appended. */
  approveUrlBase: string;
  /** Base for owner setup links pasted into chat; sessionId is appended. */
  setupUrlBase: string;
  /** Relying party + accepted origins for passkey (WebAuthn) owners. */
  webauthn: WebAuthnOwnerConfig;
  /** Violation sink for warn mode (defaults to console.warn). */
  onWarn?: ((message: string, detail: unknown) => void) | undefined;
  /** Injectable clock for tests. */
  nowMs?: (() => number) | undefined;
}

const DEFAULT_CONFIG: SpendingMandateServiceConfig = {
  enforcementLevel: "on",
  approveUrlBase: "https://app.subly.fi/approve/",
  setupUrlBase: "https://app.subly.fi/setup/",
  webauthn: {
    rpId: "app.subly.fi",
    origins: ["https://app.subly.fi"]
  }
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
  policyDecision: string;
  approvalId: string | null;
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
    /**
     * "setup_session" replaces the agentWalletSignature check with the
     * session's wallet-auth provenance (completeSetupSession enforces the
     * document matches the session prefill before getting here).
     */
    agentCosign?: "document" | "setup_session";
    /** Extra audit context merged into the registration event. */
    provenance?: unknown;
  }) {
    const nowMs = this.now();
    const { document } = input;
    const validated = validateMandateDocument({
      document,
      wallet: input.wallet,
      vault: input.vault,
      nowMs,
      webauthn: this.config.webauthn,
      agentCosign: input.agentCosign ?? "document"
    });

    return this.ledger.withSpendingMandateLock(input.wallet, async () =>
      this.ledger.withWalletVaultLock(input.wallet, input.vault, async () => {
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
              : { credentialId: document.ownerCredential.credentialId }),
            ...(document.ownerCredential.algorithm === undefined
              ? {}
              : { algorithm: document.ownerCredential.algorithm })
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
          input.provenance === undefined
            ? document
            : { document, provenance: input.provenance }
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
      })
    );
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
    return this.withCurrentMandateMutationLock(input.wallet, async (record) => {
      const nowMs = this.now();
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
    });
  }

  /**
   * Dead-man switch for a lost owner credential: the AGENT key schedules a
   * revoke that only takes effect after a 72h grace window, during which the
   * real owner can veto it. Exposed in mandate reads so the owner can see it.
   */
  async scheduleRecoveryRevoke(wallet: string) {
    return this.withCurrentMandateMutationLock(wallet, async (record) => {
      const nowMs = this.now();
      if (record.status === "revoked") {
        throw conflict("mandate_revoked", "the mandate is already revoked");
      }
      if (this.effectiveStatus(record, nowMs) === "expired") {
        // An expired mandate already behaves like "unregistered": the agent
        // key can simply register a fresh one, no dead-man switch needed.
        throw conflict(
          "mandate_expired",
          "the mandate has expired; register a new mandate instead"
        );
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
    });
  }

  async cancelRecoveryRevoke(input: {
    wallet: string;
    mandateHash: string;
    signedAtMs: number;
    signature: string;
  }) {
    return this.withCurrentMandateMutationLock(input.wallet, async (record) => {
      const nowMs = this.now();
      if (this.effectiveStatus(record, nowMs) === "expired") {
        throw conflict(
          "mandate_expired",
          "the mandate has expired; there is nothing to restore"
        );
      }
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
    });
  }

  // -------------------------------------------------------------- approvals

  async decideApproval(input: {
    approvalId: string;
    decision: "approve" | "deny";
    signedAtMs: number;
    signature: string;
  }) {
    const located = await this.ledger.getSpendingApproval(input.approvalId);
    if (located === null) {
      throw notFound("approval_not_found", "Approval does not exist");
    }
    const lockVault = (await this.requireMandate(located.wallet)).vault;

    // Same wallet-vault lock as prepareWithdrawal: decisions must not
    // interleave with the prepare-side approval reads and expiry writes.
    return this.ledger.withWalletVaultLock(located.wallet, lockVault, async () => {
      const nowMs = this.now();
      // Re-read under the lock: a concurrent replace/revoke may have changed
      // the owner credential the decision must verify against.
      const record = await this.requireMandate(located.wallet);
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
      const status = this.effectiveStatus(record, nowMs);
      if (status !== "active" && status !== "recovery_pending") {
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
    });
  }

  async listApprovals(wallet: string, status?: string) {
    const nowMs = this.now();
    const approvals = await this.ledger.listSpendingApprovalsForWallet(wallet);
    // Read-only expiry view: GETs never write. Persistent expiry happens on
    // the state-transition paths (decideApproval / requirePaymentApproval),
    // which run under the wallet-vault lock.
    return approvals
      .map((approval) => expiredView(approval, nowMs))
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

  // ---------------------------------------------------------- setup sessions

  /**
   * Creates the owner-onboarding capability link the agent pastes into chat
   * (wallet-auth on the route = the agent key signs the exact prefill).
   * Values agreed in chat are pinned here; the page is confirm-only.
   */
  async createSetupSession(input: {
    wallet: string;
    vault: string;
    policy?:
      | { [K in keyof MandatePolicyWire]?: MandatePolicyWire[K] | undefined }
      | undefined;
    enforcementMode?: MandateEnforcementMode | undefined;
    mandateTtlMs?: number | undefined;
    initialDepositRawUsdc?: string | undefined;
    /** Wallet-auth headers of the creating request (audit provenance). */
    agentAuth?: unknown;
  }) {
    const nowMs = this.now();
    const overrides = Object.fromEntries(
      Object.entries(input.policy ?? {}).filter(([, value]) => value !== undefined)
    );
    const policyWire: MandatePolicyWire = {
      ...defaultMandatePolicyWire(),
      ...overrides
    };
    // Same validation a mandate registration would apply (3-band invariant).
    const policy = parseMandatePolicy(policyWire);

    const initialDepositRawUsdc = input.initialDepositRawUsdc ?? null;
    if (initialDepositRawUsdc !== null) {
      const amount = BigInt(initialDepositRawUsdc);
      if (
        policy.dailyDepositCapRawUsdc !== null &&
        amount > policy.dailyDepositCapRawUsdc
      ) {
        // The daily deposit cap is absolute — an initial deposit above it
        // could never execute, so refuse at link creation, not at Face ID.
        throw badRequest(
          "initial_deposit_exceeds_daily_cap",
          "initialDeposit cannot exceed dailyDepositCapRawUsdc",
          {
            initialDepositRawUsdc,
            dailyDepositCapRawUsdc: policy.dailyDepositCapRawUsdc.toString()
          }
        );
      }
    }

    const session: SetupSession = {
      sessionId: `st_${randomUUID().replaceAll("-", "")}`,
      wallet: input.wallet,
      vault: input.vault,
      policyWire,
      enforcementMode: input.enforcementMode ?? "subly",
      mandateExpiresAtMs: nowMs + (input.mandateTtlMs ?? DEFAULT_MANDATE_TTL_MS),
      initialDepositRawUsdc,
      status: "pending",
      createdAtMs: nowMs,
      expiresAtMs: nowMs + SETUP_SESSION_TTL_MS,
      completedAtMs: null,
      mandateHash: null,
      initialDepositApprovalId: null,
      agentAuth: input.agentAuth ?? null
    };
    await this.ledger.saveSetupSession(session);

    return {
      sessionId: session.sessionId,
      setupUrl: appendToUrlBase(this.config.setupUrlBase, session.sessionId),
      expiresAtMs: session.expiresAtMs,
      wallet: session.wallet,
      vault: session.vault,
      policy: policyWire,
      enforcementMode: session.enforcementMode,
      mandateExpiresAtMs: session.mandateExpiresAtMs,
      initialDepositRawUsdc
    };
  }

  /**
   * Public view for the setup page AND the agent's completion poll. The URL
   * is a capability: reloading before completion is fine, and after
   * completion only the outcome summary (incl. the initial-deposit approval)
   * is returned — never the signable prefill again.
   */
  async getSetupSession(sessionId: string) {
    const session = await this.ledger.getSetupSession(sessionId);
    if (session === null) {
      throw notFound("setup_session_not_found", "Setup session does not exist");
    }
    const nowMs = this.now();

    if (session.status === "completed") {
      let initialDepositApproval: {
        approvalId: string;
        expiresAtMs: number;
        status: string;
      } | null = null;
      if (session.initialDepositApprovalId !== null) {
        const approval = await this.ledger.getSpendingApproval(
          session.initialDepositApprovalId
        );
        if (approval !== null) {
          const viewed = expiredView(approval, nowMs);
          initialDepositApproval = {
            approvalId: viewed.approvalId,
            expiresAtMs: viewed.expiresAtMs,
            status: viewed.status
          };
        }
      }
      return {
        sessionId: session.sessionId,
        status: "completed" as const,
        wallet: session.wallet,
        mandateHash: session.mandateHash,
        completedAtMs: session.completedAtMs,
        initialDepositApproval
      };
    }

    if (session.expiresAtMs <= nowMs) {
      return {
        sessionId: session.sessionId,
        status: "expired" as const,
        wallet: session.wallet
      };
    }

    // A live/revoked mandate can only be replaced by its CURRENT owner
    // credential; the page uses this to explain (and disable the passkey
    // path) BEFORE the human signs anything that would be refused.
    const existing = await this.ledger.getSpendingMandate(session.wallet);
    return {
      sessionId: session.sessionId,
      status: "pending" as const,
      wallet: session.wallet,
      vault: session.vault,
      policy: session.policyWire as MandatePolicyWire,
      enforcementMode: session.enforcementMode,
      mandateExpiresAtMs: session.mandateExpiresAtMs,
      initialDepositRawUsdc: session.initialDepositRawUsdc,
      expiresAtMs: session.expiresAtMs,
      webauthn: { rpId: this.config.webauthn.rpId },
      existingMandate:
        existing === null
          ? null
          : {
              status: this.effectiveStatus(existing, nowMs),
              ownerAuth: existing.ownerAuth
            }
    };
  }

  /**
   * Owner submits the signed mandate from the setup page. Single-use: the
   * first successful completion wins the session. The document must equal
   * the session prefill (confirm-only) because the session's wallet-auth is
   * what stands in for the agent mandate co-sign.
   */
  async completeSetupSession(input: {
    sessionId: string;
    document: SpendingMandateDocument;
  }) {
    // Keyed lock so two racing completes cannot both pass the pending check;
    // the generic seller-request lock doubles as a namespaced mutex here.
    return this.ledger.withSellerRequestLock(
      "setup_session",
      input.sessionId,
      async () => {
        const session = await this.ledger.getSetupSession(input.sessionId);
        if (session === null) {
          throw notFound("setup_session_not_found", "Setup session does not exist");
        }
        const nowMs = this.now();
        if (session.status === "completed") {
          throw conflict(
            "setup_session_used",
            "this setup link was already completed; ask the agent for a new one"
          );
        }
        if (session.expiresAtMs <= nowMs) {
          throw conflict(
            "setup_session_expired",
            "this setup link has expired (10 min TTL); ask the agent for a new one"
          );
        }

        this.assertDocumentMatchesSession(input.document, session);

        const registered = await this.registerMandate({
          wallet: session.wallet,
          vault: session.vault,
          document: input.document,
          agentCosign: "setup_session",
          provenance: {
            via: "setup_session",
            sessionId: session.sessionId,
            agentAuth: session.agentAuth
          }
        });

        await this.ledger.saveSetupSession({
          ...session,
          status: "completed",
          completedAtMs: nowMs,
          mandateHash: registered.mandateHash,
          initialDepositApprovalId:
            registered.initialDepositApproval?.approvalId ?? null
        });

        return {
          sessionId: session.sessionId,
          wallet: session.wallet,
          mandateHash: registered.mandateHash,
          status: registered.status,
          expiresAtMs: registered.expiresAtMs,
          initialDepositApproval: registered.initialDepositApproval
        };
      }
    );
  }

  /** Public capability view for the approve page (link = authorization to see). */
  async getApprovalView(approvalId: string) {
    const approval = await this.ledger.getSpendingApproval(approvalId);
    if (approval === null) {
      throw notFound("approval_not_found", "Approval does not exist");
    }
    const record = await this.ledger.getSpendingMandate(approval.wallet);
    const viewed = expiredView(approval, this.now());
    return {
      approvalId: viewed.approvalId,
      wallet: viewed.wallet,
      binding: viewed.bindingJson,
      bindingHash: viewed.bindingHash,
      mandateHash: viewed.mandateHash,
      status: viewed.status,
      requestedAtMs: viewed.requestedAtMs,
      expiresAtMs: viewed.expiresAtMs,
      decidedAtMs: viewed.decidedAtMs,
      owner:
        record === null
          ? null
          : {
              ownerAuth: record.ownerAuth,
              credentialId: record.ownerCredential.credentialId ?? null
            }
    };
  }

  /**
   * Public summary for the revoke (kill switch) page: just enough to build
   * and sign the revoke message. No policy contents are exposed.
   */
  async getMandateSummary(wallet: string) {
    const record = await this.requireMandate(wallet);
    return {
      wallet: record.wallet,
      mandateHash: record.mandateHash,
      status: this.effectiveStatus(record, this.now()),
      ownerAuth: record.ownerAuth,
      credentialId: record.ownerCredential.credentialId ?? null,
      expiresAtMs: record.expiresAtMs,
      recoveryAtMs: record.recoveryAtMs
    };
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

    // 1. Kill switch: enforced even in "warn" mode. Warn exists so legacy
    //    binding-less clients keep working during rollout; a revocation only
    //    exists after an explicit owner action on a registered mandate, so
    //    honoring it can never break a client that predates the layer.
    if (effective.revoked) {
      throw conflict(
        "mandate_revoked",
        "the spending mandate was revoked by the owner; all payments are blocked"
      );
    }

    // In warn mode the FIRST violation code is stamped on the intent, so the
    // spending log never shows a policy-violating payment as clean.
    let warnedCode: string | null = null;
    const decided = (): RealizeAuthorization => ({
      policySource: effective.policySource,
      mandateHash: effective.mandate?.mandateHash ?? null,
      policyDecision:
        warnedCode === null ? "auto_within_policy" : `warned:${warnedCode}`,
      approvalId: null
    });

    const payment = input.payment;
    if (payment === null) {
      warnedCode ??= this.violation(
        badRequest(
          "payment_binding_required",
          "yield_realize withdrawals must declare the payment they fund " +
            "({ payTo, amountRawUsdc, resourceUrlHash, method })"
        )
      );
    } else if (BigInt(payment.amountRawUsdc) !== input.amountRawUsdc) {
      warnedCode ??= this.violation(
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
      warnedCode ??= this.violation(
        conflict("payee_not_allowed", "payTo is not in the mandate's allowed payee list", {
          payTo: payment.payTo
        })
      );
    }

    // 3. Absolute per-payment cap — approval never lifts it.
    if (amount > policy.perPaymentCapRawUsdc) {
      warnedCode ??= this.violation(
        conflict(
          "per_payment_cap_exceeded",
          "the payment exceeds the absolute per-payment cap",
          {
            amountRawUsdc: amount.toString(),
            perPaymentCapRawUsdc: policy.perPaymentCapRawUsdc.toString()
          }
        )
      );
      return decided();
    }

    // 4. Rolling daily/monthly spend windows (confirmed realizes count,
    //    approved payments included — approval waives the threshold, not caps).
    if (policy.dailyApiSpendCapRawUsdc !== null) {
      const spent = await this.confirmedRealizeSum(input.wallet, input.vault, nowMs - DAY_MS);
      if (spent + amount > policy.dailyApiSpendCapRawUsdc) {
        warnedCode ??= this.violation(
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
        warnedCode ??= this.violation(
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
        warnedCode ??= this.violation(
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
        return decided();
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
          ...decided(),
          policyDecision: `owner_approved:${approval.approvalId}`,
          approvalId: approval.approvalId
        };
      }
      if (this.config.enforcementLevel === "warn") {
        warnedCode ??= "approval_required";
        this.warn("approval_required would fire for this payment", {
          wallet: input.wallet,
          amountRawUsdc: amount.toString()
        });
      }
    }

    return decided();
  }

  /**
   * Deposit gate: kill switch, rolling daily deposit cap (an absolute
   * ceiling — approval never lifts it), and the depositPolicy owner-approval
   * requirement. Principal enters DeFi risk only after a human Face ID:
   * with no registered owner there is nobody who could approve, so deposits
   * are refused outright (`mandate_required_for_deposit`) and setup becomes
   * the de-facto prerequisite. The first deposit rides the approval issued
   * with the mandate's initialDeposit.
   */
  async authorizeDeposit(input: {
    wallet: string;
    vault: string;
    amountRawUsdc: bigint;
    approvalId: string | null;
  }): Promise<DepositAuthorization> {
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
    // Kill switch — enforced even in "warn" (see authorizeRealize).
    if (effective.revoked) {
      throw conflict(
        "mandate_revoked",
        "the spending mandate was revoked by the owner; deposits are blocked"
      );
    }

    let warnedCode: string | null = null;
    const decided = (): DepositAuthorization => ({
      policySource: effective.policySource,
      mandateHash: effective.mandate?.mandateHash ?? null,
      policyDecision:
        warnedCode === null ? "auto_within_policy" : `warned:${warnedCode}`,
      approvalId: null
    });

    if (effective.policy.dailyDepositCapRawUsdc !== null) {
      const deposited = await this.confirmedDepositSum(
        input.wallet,
        input.vault,
        nowMs - DAY_MS
      );
      if (deposited + input.amountRawUsdc > effective.policy.dailyDepositCapRawUsdc) {
        warnedCode ??= this.violation(
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

    if (effective.policy.depositPolicy === "owner_approval_required") {
      if (!effective.ownerAvailable) {
        warnedCode ??= this.violation(
          conflict(
            "mandate_required_for_deposit",
            "deposits move principal into DeFi risk and require owner (Face ID) " +
              "approval; register a spending mandate first — its initialDeposit " +
              "covers the first deposit with the same single approval",
            { amountRawUsdc: input.amountRawUsdc.toString() }
          )
        );
        return decided();
      }
      if (this.config.enforcementLevel === "on") {
        const approval = await this.requireOperationApproval({
          wallet: input.wallet,
          vault: input.vault,
          mandateHash: effective.mandate!.mandateHash,
          binding: {
            kind: "deposit",
            amountRawUsdc: input.amountRawUsdc.toString()
          },
          requiredCode: "deposit_approval_required",
          requiredMessage:
            "deposits require the owner's approval (Face ID); after the " +
            "owner approves (approveUrl), retry the same deposit with the approvalId",
          approvalId: input.approvalId,
          nowMs
        });
        return {
          ...decided(),
          policyDecision: `owner_approved:${approval.approvalId}`,
          approvalId: approval.approvalId
        };
      }
      warnedCode ??= "deposit_approval_required";
      this.warn("deposit_approval_required would fire for this deposit", {
        wallet: input.wallet,
        amountRawUsdc: input.amountRawUsdc.toString()
      });
    }

    return decided();
  }

  /**
   * Normal-withdrawal gate (NOT yield_realize — that runs authorizeRealize).
   * Withdrawals exit DeFi risk back to the agent's own wallet, so they are
   * agent-allowed by default; a mandate's `withdrawalPolicy:
   * "owner_approval_required"` opts into the same escalation as deposits
   * (binding `{kind: "withdrawal", amountRawUsdc}`). The kill switch blocks
   * withdrawals too — once the owner distrusts the agent key, letting it
   * pull the principal out would defeat the revocation; the same owner can
   * re-register to unblock.
   */
  async authorizeWithdrawal(input: {
    wallet: string;
    vault: string;
    amountRawUsdc: bigint;
    approvalId: string | null;
  }): Promise<DepositAuthorization> {
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
    // Kill switch — enforced even in "warn" (see authorizeRealize).
    if (effective.revoked) {
      throw conflict(
        "mandate_revoked",
        "the spending mandate was revoked by the owner; withdrawals are blocked " +
          "until the same owner registers a new mandate"
      );
    }

    let warnedCode: string | null = null;
    const decided = (): DepositAuthorization => ({
      policySource: effective.policySource,
      mandateHash: effective.mandate?.mandateHash ?? null,
      policyDecision:
        warnedCode === null ? "auto_within_policy" : `warned:${warnedCode}`,
      approvalId: null
    });

    // Only a mandate can set this (the relayer default is agent_allowed),
    // so an owner credential to approve with always exists here.
    if (effective.policy.withdrawalPolicy === "owner_approval_required") {
      if (this.config.enforcementLevel === "on") {
        const approval = await this.requireOperationApproval({
          wallet: input.wallet,
          vault: input.vault,
          mandateHash: effective.mandate!.mandateHash,
          binding: {
            kind: "withdrawal",
            amountRawUsdc: input.amountRawUsdc.toString()
          },
          requiredCode: "withdrawal_approval_required",
          requiredMessage:
            "this mandate requires the owner's approval for withdrawals; " +
            "after the owner approves (approveUrl), retry the same withdrawal " +
            "with the approvalId",
          approvalId: input.approvalId,
          nowMs
        });
        return {
          ...decided(),
          policyDecision: `owner_approved:${approval.approvalId}`,
          approvalId: approval.approvalId
        };
      }
      warnedCode = "withdrawal_approval_required";
      this.warn("withdrawal_approval_required would fire for this withdrawal", {
        wallet: input.wallet,
        amountRawUsdc: input.amountRawUsdc.toString()
      });
    }

    return decided();
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
        // null = the mandate layer was not active when this intent ran;
        // never present that as a clean policy pass.
        decision: intent.policyDecision ?? "unenforced",
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
    return this.requireOperationApproval({
      wallet: input.wallet,
      vault: input.vault,
      mandateHash: input.mandateHash,
      binding: {
        kind: "payment",
        payTo: input.payment.payTo,
        amountRawUsdc: input.payment.amountRawUsdc,
        resourceUrlHash: input.payment.resourceUrlHash,
        method: input.payment.method
      },
      requiredCode: "approval_required",
      requiredMessage:
        "this payment exceeds the owner's approval threshold; after the " +
        "owner approves (approveUrl), retry the same call with the approvalId",
      approvalId: input.approvalId,
      nowMs: input.nowMs
    });
  }

  /**
   * Shared escalation for payment and deposit bindings: a provided approval
   * is honored when approved + binding-bound + unexpired + not already
   * driving an in-flight intent; otherwise a pending approval is surfaced
   * (or reused) and the operation is refused with `requiredCode`. Nothing
   * has been prepared at that point, so the same call retries safely.
   */
  private async requireOperationApproval(input: {
    wallet: string;
    vault: string;
    mandateHash: string;
    binding: ApprovalBinding;
    requiredCode: string;
    requiredMessage: string;
    approvalId: string | null;
    nowMs: number;
  }): Promise<SpendingApproval> {
    const bindingHash = bindingHashOf(input.binding);

    // Keep capability rows bounded even when an agent repeatedly asks for
    // distinct approvals. This runs under the caller's wallet-vault lock.
    await this.ledger.pruneSpendingApprovals(
      input.wallet,
      input.nowMs - APPROVAL_RETENTION_MS
    );

    if (input.approvalId !== null) {
      const provided = await this.ledger.getSpendingApproval(input.approvalId);
      if (provided !== null && provided.wallet === input.wallet) {
        const current = await this.expireIfStale(provided, input.nowMs);
        if (
          current.status === "approved" &&
          current.bindingHash === bindingHash &&
          !(await this.approvalInFlight(
            current.approvalId,
            input.wallet,
            input.vault,
            input.binding.kind,
            input.nowMs
          ))
        ) {
          return current;
        }
      }
    }

    const pending = await this.findReusablePending(input.wallet, bindingHash, input.nowMs);
    if (pending === null) {
      const outstanding = (await this.ledger.listSpendingApprovalsForWallet(
        input.wallet
      )).filter(
        (approval) =>
          approval.status === "pending" && approval.expiresAtMs > input.nowMs
      );
      if (outstanding.length >= MAX_PENDING_APPROVALS_PER_WALLET) {
        throw conflict(
          "too_many_pending_approvals",
          `This wallet already has ${MAX_PENDING_APPROVALS_PER_WALLET} pending approvals; decide or wait for existing approvals to expire`
        );
      }
    }
    const approval =
      pending ??
      (await this.ledger.saveSpendingApproval({
        approvalId: newApprovalId(),
        wallet: input.wallet,
        bindingHash,
        bindingJson: input.binding,
        mandateHash: input.mandateHash,
        status: "pending",
        decisionJson: null,
        requestedAtMs: input.nowMs,
        expiresAtMs: input.nowMs + APPROVAL_TTL_MS,
        decidedAtMs: null,
        consumedAtMs: null,
        consumedByWithdrawalId: null
      }));

    throw conflict(input.requiredCode, input.requiredMessage, {
      approvalId: approval.approvalId,
      expiresAtMs: approval.expiresAtMs,
      approveUrl: this.approveUrl(approval.approvalId),
      approveCommand: `subly-pay approve ${approval.approvalId}`
    });
  }

  private approveUrl(approvalId: string): string {
    return appendToUrlBase(this.config.approveUrlBase, approvalId);
  }

  /**
   * Confirm-only guard: the mandate the owner signed must carry exactly the
   * values the agent key pinned when creating the session. Only issuedAtMs
   * (signing time) and the owner credential are the page's to choose.
   */
  private assertDocumentMatchesSession(
    document: SpendingMandateDocument,
    session: SetupSession
  ): void {
    const sessionPolicy = session.policyWire as MandatePolicyWire;
    const mismatches: string[] = [];
    if (document.agentWallet !== session.wallet) {
      mismatches.push("agentWallet");
    }
    if (document.vault !== session.vault) {
      mismatches.push("vault");
    }
    if (document.enforcementMode !== session.enforcementMode) {
      mismatches.push("enforcementMode");
    }
    if (document.expiresAtMs !== session.mandateExpiresAtMs) {
      mismatches.push("expiresAtMs");
    }
    if (canonicalJson(document.policy) !== canonicalJson(sessionPolicy)) {
      mismatches.push("policy");
    }
    const documentInitial = document.initialDeposit?.amountRawUsdc ?? null;
    if (documentInitial !== session.initialDepositRawUsdc) {
      mismatches.push("initialDeposit");
    }
    if (mismatches.length > 0) {
      throw badRequest(
        "setup_session_mismatch",
        "the submitted mandate does not match the session prefill; setup is " +
          "confirm-only — agree on new values in chat and create a new link",
        { mismatches }
      );
    }
  }

  /** One in-flight realize/deposit per approval: binding-bound + TTL + this. */
  private async approvalInFlight(
    approvalId: string,
    wallet: string,
    vault: string,
    kind: ApprovalBinding["kind"],
    nowMs: number
  ): Promise<boolean> {
    const intents =
      kind === "deposit"
        ? await this.ledger.listDepositsForPosition(wallet, vault)
        : await this.ledger.listWithdrawalsForPosition(wallet, vault);
    return intents.some(
      (intent) =>
        intent.approvalId === approvalId &&
        (intent.status === "submitted" ||
          (intent.status === "prepared" && !intentExpired(intent, nowMs)))
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

  /** Persist lazy expiry; call only under the wallet-vault lock. */
  private async expireIfStale(
    approval: SpendingApproval,
    nowMs: number
  ): Promise<SpendingApproval> {
    const viewed = expiredView(approval, nowMs);
    if (viewed !== approval) {
      return this.ledger.saveSpendingApproval(viewed);
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
    // Mandate expiry applies in every non-revoked state — a recovery-pending
    // mandate must not outlive its own expiresAtMs.
    if (record.expiresAtMs <= nowMs) {
      return "expired";
    }
    if (record.status === "recovery_pending") {
      return record.recoveryAtMs !== null && record.recoveryAtMs <= nowMs
        ? "recovery_elapsed"
        : "recovery_pending";
    }
    return "active";
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
      !verifyOwnerMessageSignature({
        ownerAuth: existing.ownerAuth,
        credential: existing.ownerCredential,
        message: mandateSigningMessage(newMandateHash),
        signature: document.currentOwnerSignature,
        webauthn: this.config.webauthn
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
    if (
      !verifyOwnerMessageSignature({
        ownerAuth: record.ownerAuth,
        credential: record.ownerCredential,
        message: input.message,
        signature: input.signature,
        webauthn: this.config.webauthn
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

  /**
   * Serialize every mandate mutation under a stable wallet lock, then take
   * the same wallet-vault lock used by vault flows. The first lock prevents a
   * stale mandate snapshot from overwriting a concurrent registration; the
   * second keeps mandate changes ordered with approval and position updates.
   */
  private async withCurrentMandateMutationLock<T>(
    wallet: string,
    callback: (record: SpendingMandateRecord) => Promise<T>
  ): Promise<T> {
    return this.ledger.withSpendingMandateLock(wallet, async () => {
      const record = await this.requireMandate(wallet);
      return this.ledger.withWalletVaultLock(wallet, record.vault, () =>
        callback(record)
      );
    });
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

  /**
   * In "on" mode a violation blocks; in "warn" mode it is only logged and the
   * code is returned so callers can stamp it on the audit record instead of
   * recording the operation as clean.
   */
  private violation(error: SublyError): string {
    if (this.config.enforcementLevel === "on") {
      throw error;
    }
    this.warn(`mandate violation (not enforced): ${error.message}`, {
      code: error.code,
      details: error.details
    });
    return error.code;
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

function appendToUrlBase(base: string, id: string): string {
  return base.endsWith("/") ? `${base}${id}` : `${base}/${id}`;
}

function terminalMs(intent: { terminalAt: string | null }): number {
  const parsed = intent.terminalAt === null ? NaN : new Date(intent.terminalAt).getTime();
  return Number.isFinite(parsed) ? parsed : 0;
}

function intentExpired(intent: { expiresAt: string }, nowMs: number): boolean {
  const expiresAtMs = new Date(intent.expiresAt).getTime();
  return !Number.isFinite(expiresAtMs) || expiresAtMs <= nowMs;
}

/** Pure TTL view of an approval; returns the same object when unexpired. */
function expiredView(
  approval: SpendingApproval,
  nowMs: number
): SpendingApproval {
  if (
    (approval.status === "pending" || approval.status === "approved") &&
    approval.expiresAtMs <= nowMs
  ) {
    return { ...approval, status: "expired" };
  }
  return approval;
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
