import { describe, expect, it } from "vitest";
import { SUBLY_VAULT } from "../src/config/constants.js";
import { InMemoryLedger } from "../src/domain/ledger.js";
import { SublyError } from "../src/domain/errors.js";
import { SpendingMandateService } from "../src/domain/spending-mandate-service.js";
import {
  approvalSigningMessage,
  mandateHashOf,
  mandateSigningMessage,
  revokeSigningMessage,
  recoveryCancelSigningMessage,
  type MandatePolicyWire,
  type SpendingMandateDocument,
  type SpendingMandatePayload
} from "../src/domain/spending-mandate.js";
import {
  AGENT_PUB,
  createTestPasskey,
  NOW_MS
} from "./helpers/mandate-fixtures.js";

const VAULT = SUBLY_VAULT.address;

function buildService(level: "off" | "warn" | "on" = "on") {
  const ledger = new InMemoryLedger();
  let now = NOW_MS;
  const service = new SpendingMandateService({
    ledger,
    config: {
      enforcementLevel: level,
      nowMs: () => now,
      onWarn: () => undefined
    }
  });
  return { service, ledger, advance: (ms: number) => (now += ms) };
}

async function expectCode(promise: Promise<unknown>, code: string) {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(SublyError);
    expect((error as SublyError).code).toBe(code);
    return error as SublyError;
  }
  throw new Error(`expected rejection with code ${code}`);
}

interface PendingSessionView {
  sessionId: string;
  wallet: string;
  vault: string;
  policy: MandatePolicyWire;
  enforcementMode: "subly" | "wallet_infra";
  mandateExpiresAtMs: number;
  initialDepositRawUsdc: string | null;
  existingMandate: { status: string; ownerAuth: string } | null;
}

/** Builds + signs the mandate exactly the way the setup page does. */
function signSetupDocument(
  session: PendingSessionView,
  passkey: ReturnType<typeof createTestPasskey>,
  issuedAtMs: number,
  mutate?: (payload: SpendingMandatePayload) => SpendingMandatePayload
): SpendingMandateDocument {
  let payload: SpendingMandatePayload = {
    version: 1,
    ownerAuth: "passkey",
    ownerCredential: passkey.credential,
    enforcementMode: session.enforcementMode,
    agentWallet: session.wallet,
    vault: session.vault,
    issuedAtMs,
    expiresAtMs: session.mandateExpiresAtMs,
    policy: session.policy,
    ...(session.initialDepositRawUsdc === null
      ? {}
      : { initialDeposit: { amountRawUsdc: session.initialDepositRawUsdc } })
  };
  payload = mutate === undefined ? payload : mutate(payload);
  const message = mandateSigningMessage(mandateHashOf(payload));
  return { ...payload, ownerSignature: passkey.signAssertion(message) };
}

describe("setup sessions", () => {
  it("runs the full passkey onboarding: link → confirm-only sign → active mandate + pre-approved first deposit", async () => {
    const { service } = buildService();
    const passkey = createTestPasskey();

    const created = await service.createSetupSession({
      wallet: AGENT_PUB,
      vault: VAULT,
      initialDepositRawUsdc: "500000000",
      agentAuth: { signature: "agent-wallet-auth-sig" }
    });
    expect(created.setupUrl).toContain(created.sessionId);
    expect(created.expiresAtMs).toBe(NOW_MS + 10 * 60 * 1000);

    const view = await service.getSetupSession(created.sessionId);
    expect(view.status).toBe("pending");
    const pending = view as unknown as PendingSessionView & {
      webauthn: { rpId: string };
    };
    expect(pending.webauthn.rpId).toBe("app.subly.fi");
    expect(pending.initialDepositRawUsdc).toBe("500000000");

    // The page never sends an agent co-sign — the session stands in for it.
    const document = signSetupDocument(pending, passkey, NOW_MS + 1_000);
    expect(document.agentWalletSignature).toBeUndefined();
    const completed = await service.completeSetupSession({
      sessionId: created.sessionId,
      document
    });
    expect(completed.status).toBe("active");
    expect(completed.initialDepositApproval).not.toBeNull();
    const approvalId = completed.initialDepositApproval!.approvalId;

    // The single Face ID covers the first deposit too.
    const deposit = await service.authorizeDeposit({
      wallet: AGENT_PUB,
      vault: VAULT,
      amountRawUsdc: 500_000_000n,
      approvalId
    });
    expect(deposit.policyDecision).toBe(`owner_approved:${approvalId}`);

    // The completion (and the approval id) is visible to the agent's poll.
    const after = await service.getSetupSession(created.sessionId);
    expect(after.status).toBe("completed");
    expect(after).toMatchObject({
      mandateHash: completed.mandateHash,
      initialDepositApproval: { approvalId }
    });

    // Single-use: a second completion (any credential) is refused.
    await expectCode(
      service.completeSetupSession({
        sessionId: created.sessionId,
        document: signSetupDocument(pending, createTestPasskey(), NOW_MS + 2_000)
      }),
      "setup_session_used"
    );
  });

  it("warns a second link about the existing mandate before any Face ID", async () => {
    const { service } = buildService();
    const passkey = createTestPasskey();
    const first = await service.createSetupSession({
      wallet: AGENT_PUB,
      vault: VAULT
    });
    const firstPending = (await service.getSetupSession(
      first.sessionId
    )) as unknown as PendingSessionView;
    expect(firstPending.existingMandate).toBeNull();
    await service.completeSetupSession({
      sessionId: first.sessionId,
      document: signSetupDocument(firstPending, passkey, NOW_MS + 1_000)
    });

    // The page reads this and disables the passkey path up front — a fresh
    // passkey can never satisfy owner rotation on a live mandate.
    const second = await service.createSetupSession({
      wallet: AGENT_PUB,
      vault: VAULT
    });
    const secondPending = (await service.getSetupSession(
      second.sessionId
    )) as unknown as PendingSessionView;
    expect(secondPending.existingMandate).toEqual({
      status: "active",
      ownerAuth: "passkey"
    });

    // And the server refuses it even if a client signs anyway.
    await expectCode(
      service.completeSetupSession({
        sessionId: second.sessionId,
        document: signSetupDocument(
          secondPending,
          createTestPasskey(),
          NOW_MS + 2_000
        )
      }),
      "owner_rotation_requires_current_owner"
    );
  });

  it("expires the link after 10 minutes", async () => {
    const { service, advance } = buildService();
    const passkey = createTestPasskey();
    const created = await service.createSetupSession({
      wallet: AGENT_PUB,
      vault: VAULT
    });
    const pending = (await service.getSetupSession(
      created.sessionId
    )) as unknown as PendingSessionView;

    advance(10 * 60 * 1000 + 1);
    expect((await service.getSetupSession(created.sessionId)).status).toBe(
      "expired"
    );
    await expectCode(
      service.completeSetupSession({
        sessionId: created.sessionId,
        document: signSetupDocument(pending, passkey, NOW_MS + 10 * 60 * 1000)
      }),
      "setup_session_expired"
    );
  });

  it("is confirm-only: any drift from the session prefill is refused", async () => {
    const { service } = buildService();
    const passkey = createTestPasskey();
    const created = await service.createSetupSession({
      wallet: AGENT_PUB,
      vault: VAULT,
      initialDepositRawUsdc: "500000000"
    });
    const pending = (await service.getSetupSession(
      created.sessionId
    )) as unknown as PendingSessionView;

    const looserCap = await expectCode(
      service.completeSetupSession({
        sessionId: created.sessionId,
        document: signSetupDocument(pending, passkey, NOW_MS + 1_000, (payload) => ({
          ...payload,
          policy: { ...payload.policy, perPaymentCapRawUsdc: "999000000" }
        }))
      }),
      "setup_session_mismatch"
    );
    expect((looserCap.details as { mismatches: string[] }).mismatches).toContain(
      "policy"
    );

    await expectCode(
      service.completeSetupSession({
        sessionId: created.sessionId,
        document: signSetupDocument(pending, passkey, NOW_MS + 1_000, (payload) => {
          const { initialDeposit: _dropped, ...rest } = payload;
          return rest as SpendingMandatePayload;
        })
      }),
      "setup_session_mismatch"
    );

    // The session is still pending after refused attempts (retry within TTL).
    expect((await service.getSetupSession(created.sessionId)).status).toBe(
      "pending"
    );
  });

  it("validates the prefill at link creation, before any Face ID", async () => {
    const { service } = buildService();
    await expectCode(
      service.createSetupSession({
        wallet: AGENT_PUB,
        vault: VAULT,
        policy: {
          approvalThresholdRawUsdc: "10000000" // == per-payment cap
        }
      }),
      "invalid_policy_thresholds"
    );
    await expectCode(
      service.createSetupSession({
        wallet: AGENT_PUB,
        vault: VAULT,
        initialDepositRawUsdc: "3000000001" // above the daily deposit cap
      }),
      "initial_deposit_exceeds_daily_cap"
    );
  });

  it("lets the passkey owner decide approvals and pull the kill switch", async () => {
    const { service } = buildService();
    const passkey = createTestPasskey();
    const created = await service.createSetupSession({
      wallet: AGENT_PUB,
      vault: VAULT
    });
    const pending = (await service.getSetupSession(
      created.sessionId
    )) as unknown as PendingSessionView;
    const completed = await service.completeSetupSession({
      sessionId: created.sessionId,
      document: signSetupDocument(pending, passkey, NOW_MS + 1_000)
    });

    // Above-threshold payment escalates; the passkey signs the decision.
    const required = await expectCode(
      service.authorizeRealize({
        wallet: AGENT_PUB,
        vault: VAULT,
        amountRawUsdc: 2_000_000n,
        payment: {
          payTo: AGENT_PUB,
          amountRawUsdc: "2000000",
          resourceUrlHash: "cd".repeat(32),
          method: "GET"
        },
        approvalId: null
      }),
      "approval_required"
    );
    const approvalId = (required.details as { approvalId: string }).approvalId;
    const approvalView = await service.getApprovalView(approvalId);
    expect(approvalView.owner).toEqual({
      ownerAuth: "passkey",
      credentialId: passkey.credential.credentialId
    });

    const signedAtMs = NOW_MS + 2_000;
    await service.decideApproval({
      approvalId,
      decision: "approve",
      signedAtMs,
      signature: passkey.signAssertion(
        approvalSigningMessage({
          approvalId,
          decision: "approve",
          bindingHash: approvalView.bindingHash,
          signedAtMs
        })
      )
    });
    const authorized = await service.authorizeRealize({
      wallet: AGENT_PUB,
      vault: VAULT,
      amountRawUsdc: 2_000_000n,
      payment: {
        payTo: AGENT_PUB,
        amountRawUsdc: "2000000",
        resourceUrlHash: "cd".repeat(32),
        method: "GET"
      },
      approvalId
    });
    expect(authorized.policyDecision).toBe(`owner_approved:${approvalId}`);

    // Kill switch via the revoke page's message, signed by the passkey.
    const summary = await service.getMandateSummary(AGENT_PUB);
    expect(summary.mandateHash).toBe(completed.mandateHash);
    const revokeAtMs = NOW_MS + 3_000;
    await service.revokeMandate({
      wallet: AGENT_PUB,
      mandateHash: summary.mandateHash,
      signedAtMs: revokeAtMs,
      signature: passkey.signAssertion(
        revokeSigningMessage(summary.mandateHash, revokeAtMs)
      )
    });
    await expectCode(
      service.authorizeDeposit({
        wallet: AGENT_PUB,
        vault: VAULT,
        amountRawUsdc: 1_000_000n,
        approvalId: null
      }),
      "mandate_revoked"
    );
  });

  it("rejects a foreign passkey's decision signature", async () => {
    const { service } = buildService();
    const passkey = createTestPasskey();
    const created = await service.createSetupSession({
      wallet: AGENT_PUB,
      vault: VAULT
    });
    const pending = (await service.getSetupSession(
      created.sessionId
    )) as unknown as PendingSessionView;
    await service.completeSetupSession({
      sessionId: created.sessionId,
      document: signSetupDocument(pending, passkey, NOW_MS + 1_000)
    });

    const required = await expectCode(
      service.authorizeRealize({
        wallet: AGENT_PUB,
        vault: VAULT,
        amountRawUsdc: 2_000_000n,
        payment: {
          payTo: AGENT_PUB,
          amountRawUsdc: "2000000",
          resourceUrlHash: "cd".repeat(32),
          method: "GET"
        },
        approvalId: null
      }),
      "approval_required"
    );
    const approvalId = (required.details as { approvalId: string }).approvalId;
    const view = await service.getApprovalView(approvalId);

    const intruder = createTestPasskey();
    const signedAtMs = NOW_MS + 2_000;
    await expectCode(
      service.decideApproval({
        approvalId,
        decision: "approve",
        signedAtMs,
        signature: intruder.signAssertion(
          approvalSigningMessage({
            approvalId,
            decision: "approve",
            bindingHash: view.bindingHash,
            signedAtMs
          })
        )
      }),
      "approval_signature_invalid"
    );
  });
});

describe("owner management sessions", () => {
  async function onboard() {
    const state = buildService();
    const passkey = createTestPasskey();
    const created = await state.service.createSetupSession({
      wallet: AGENT_PUB, vault: VAULT,
      policy: { dailyApiSpendCapRawUsdc: "70000000", withdrawalPolicy: "owner_approval_required" },
      initialDepositRawUsdc: "1000000"
    });
    const view = await state.service.getSetupSession(created.sessionId) as PendingSessionView;
    const registered = await state.service.completeSetupSession({
      sessionId: created.sessionId, document: signSetupDocument(view, passkey, NOW_MS)
    });
    state.advance(1_000);
    return { ...state, passkey, registered };
  }

  it("updates with the existing passkey, preserves omitted policy and expiry, and never issues another deposit approval", async () => {
    const { service, passkey, registered } = await onboard();
    const link = await service.createOwnerSession({ wallet: AGENT_PUB, vault: VAULT,
      policy: { monthlyApiSpendCapRawUsdc: "90000000" } });
    expect(link.ownerUrl).toBe(`https://app.subly.fi/owner/${link.sessionId}`);
    const view = await service.getOwnerSession(link.sessionId);
    expect(view).toMatchObject({ wallet: AGENT_PUB, vault: VAULT, initialDepositRawUsdc: null,
      mandateExpiresAtMs: registered.expiresAtMs,
      policy: { dailyApiSpendCapRawUsdc: "70000000", monthlyApiSpendCapRawUsdc: "90000000", withdrawalPolicy: "owner_approval_required" },
      currentMandate: { ownerCredential: passkey.credential } });
    const result = await service.completeOwnerSession({ sessionId: link.sessionId,
      document: signSetupDocument(view as PendingSessionView, passkey, NOW_MS + 1_000) });
    expect(result.initialDepositApproval).toBeNull();
    expect(result.mandateHash).not.toBe(registered.mandateHash);
    expect(await service.getOwnerSession(link.sessionId)).toMatchObject({
      wallet: AGENT_PUB, vault: VAULT, status: "completed", action: "update" });
    await expectCode(service.completeOwnerSession({ sessionId: link.sessionId,
      document: signSetupDocument(view as PendingSessionView, passkey, NOW_MS + 2_000) }), "setup_session_used");
  });

  it("rejects another credential, tampered policy, stale state and expired links", async () => {
    const { service, passkey, registered, advance } = await onboard();
    const link = await service.createOwnerSession({ wallet: AGENT_PUB, vault: VAULT });
    const view = await service.getOwnerSession(link.sessionId) as PendingSessionView;
    await expectCode(service.completeOwnerSession({ sessionId: link.sessionId,
      document: signSetupDocument(view, createTestPasskey(), NOW_MS + 1_000) }), "owner_session_credential_mismatch");
    await expectCode(service.completeOwnerSession({ sessionId: link.sessionId,
      document: signSetupDocument(view, passkey, NOW_MS + 1_000, payload => ({ ...payload,
        policy: { ...payload.policy, dailyApiSpendCapRawUsdc: "80000000" } })) }), "setup_session_mismatch");
    await service.revokeMandate({ wallet: AGENT_PUB, mandateHash: registered.mandateHash,
      signedAtMs: NOW_MS + 1_000,
      signature: passkey.signAssertion(revokeSigningMessage(registered.mandateHash, NOW_MS + 1_000)) });
    await expectCode(service.completeOwnerSession({ sessionId: link.sessionId,
      document: signSetupDocument(view, passkey, NOW_MS + 1_000) }), "owner_session_stale");
    const fresh = await service.createOwnerSession({ wallet: AGENT_PUB, vault: VAULT });
    const freshView = await service.getOwnerSession(fresh.sessionId) as PendingSessionView;
    advance(10 * 60_000);
    expect(await service.getOwnerSession(fresh.sessionId)).toMatchObject({
      status: "expired", wallet: AGENT_PUB, vault: VAULT });
    await expectCode(service.completeOwnerSession({ sessionId: fresh.sessionId,
      document: signSetupDocument(freshView, passkey, NOW_MS + 1_001) }), "setup_session_expired");
  });

  it("revokes and restores only with the same owner; recovery cannot bypass revocation", async () => {
    const { service, passkey, registered, advance } = await onboard();
    const link = await service.createOwnerSession({ wallet: AGENT_PUB, vault: VAULT });
    const action = { sessionId: link.sessionId, action: "revoke" as const,
      mandateHash: registered.mandateHash, signedAtMs: NOW_MS + 1_000 };
    await expectCode(service.completeOwnerAction({ ...action, signature: createTestPasskey().signAssertion(
      revokeSigningMessage(action.mandateHash, action.signedAtMs)) }), "revoke_signature_invalid");
    await service.completeOwnerAction({ ...action, signature: passkey.signAssertion(
      revokeSigningMessage(action.mandateHash, action.signedAtMs)) });
    expect(await service.getOwnerSession(link.sessionId)).toMatchObject({ status: "completed", action: "revoke" });
    await expectCode(service.scheduleRecoveryRevoke(AGENT_PUB, VAULT), "mandate_revoked");
    advance(1_000);
    const restore = await service.createOwnerSession({ wallet: AGENT_PUB, vault: VAULT });
    const view = await service.getOwnerSession(restore.sessionId) as PendingSessionView;
    await expectCode(service.completeOwnerSession({ sessionId: restore.sessionId,
      document: signSetupDocument(view, createTestPasskey(), NOW_MS + 2_000) }), "owner_session_credential_mismatch");
    await service.completeOwnerSession({ sessionId: restore.sessionId,
      document: signSetupDocument(view, passkey, NOW_MS + 2_000) });
    expect((await service.getMandate(AGENT_PUB, VAULT)).effectiveStatus).toBe("active");
  });

  it("lets the current owner cancel recovery and retains the full 72-hour wait before new-owner setup", async () => {
    const { service, passkey, registered, advance } = await onboard();
    const scheduled = await service.scheduleRecoveryRevoke(AGENT_PUB, VAULT);
    expect(scheduled.recoveryAtMs).toBe(NOW_MS + 1_000 + 72 * 60 * 60_000);
    const link = await service.createOwnerSession({ wallet: AGENT_PUB, vault: VAULT });
    await service.completeOwnerAction({ sessionId: link.sessionId, action: "cancel_recovery",
      mandateHash: registered.mandateHash, signedAtMs: NOW_MS + 1_000,
      signature: passkey.signAssertion(recoveryCancelSigningMessage(registered.mandateHash, NOW_MS + 1_000)) });
    expect((await service.getMandate(AGENT_PUB, VAULT)).effectiveStatus).toBe("active");
    expect(await service.getOwnerSession(link.sessionId)).toMatchObject({ action: "cancel_recovery" });
    await service.scheduleRecoveryRevoke(AGENT_PUB, VAULT);
    const newOwner = createTestPasskey();
    const early = await service.createSetupSession({ wallet: AGENT_PUB, vault: VAULT });
    await expectCode(service.completeSetupSession({ sessionId: early.sessionId,
      document: signSetupDocument(await service.getSetupSession(early.sessionId) as PendingSessionView,
        newOwner, NOW_MS + 1_000) }), "owner_rotation_requires_current_owner");
    advance(72 * 60 * 60_000);
    expect((await service.getMandate(AGENT_PUB, VAULT)).effectiveStatus).toBe("recovery_elapsed");
    const ready = await service.createSetupSession({ wallet: AGENT_PUB, vault: VAULT });
    await service.completeSetupSession({ sessionId: ready.sessionId,
      document: signSetupDocument(await service.getSetupSession(ready.sessionId) as PendingSessionView,
        newOwner, scheduled.recoveryAtMs) });
    expect((await service.getMandate(AGENT_PUB, VAULT)).effectiveStatus).toBe("active");
  });
});
