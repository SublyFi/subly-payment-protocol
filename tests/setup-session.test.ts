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
