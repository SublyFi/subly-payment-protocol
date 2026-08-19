import { describe, expect, it } from "vitest";
import { buildServer } from "../src/api/server.js";
import { SublyService } from "../src/domain/payment-service.js";
import { SpendingMandateService } from "../src/domain/spending-mandate-service.js";
import { revokeSigningMessage } from "../src/domain/spending-mandate.js";
import {
  AGENT_PUB,
  buildDocument,
  createTestPasskey,
  OWNER,
  sign
} from "./helpers/mandate-fixtures.js";
import {
  mandateHashOf,
  mandateSigningMessage,
  type SpendingMandatePayload
} from "../src/domain/spending-mandate.js";

const ADMIN = "admin-secret";

function buildMandateServer() {
  const service = new SublyService();
  const mandateService = new SpendingMandateService({
    ledger: service.ledger,
    config: { enforcementLevel: "on", onWarn: () => undefined }
  });
  const server = buildServer(service, {
    adminApiToken: ADMIN,
    mandateService
  });
  return { server, mandateService };
}

const adminHeaders = { authorization: `Bearer ${ADMIN}` };

describe("mandate API", () => {
  it("registers a mandate via its internal signatures, then serves it to the wallet", async () => {
    const { server } = buildMandateServer();
    const document = buildDocument();

    // Registration transport is unauthenticated: the owner + agent
    // signatures INSIDE the document are the authorization.
    const put = await server.inject({
      method: "PUT",
      url: `/v1/wallets/${AGENT_PUB}/mandate`,
      payload: document
    });
    expect(put.statusCode).toBe(200);
    const { mandateHash } = put.json() as { mandateHash: string };

    const get = await server.inject({
      method: "GET",
      url: `/v1/wallets/${AGENT_PUB}/mandate`,
      headers: adminHeaders
    });
    expect(get.statusCode).toBe(200);
    expect(get.json()).toMatchObject({
      mandateHash,
      status: "active",
      effectiveStatus: "active"
    });
    await server.close();
  });

  it("rejects tampered documents and unknown fields", async () => {
    const { server } = buildMandateServer();
    const document = buildDocument();

    const tampered = await server.inject({
      method: "PUT",
      url: `/v1/wallets/${AGENT_PUB}/mandate`,
      payload: {
        ...document,
        policy: { ...document.policy, perPaymentCapRawUsdc: "999000000" }
      }
    });
    expect(tampered.statusCode).toBe(400);
    expect(tampered.json().error.code).toBe("owner_signature_invalid");

    // Unknown fields would silently fall out of the hash -> strict reject.
    const extraField = await server.inject({
      method: "PUT",
      url: `/v1/wallets/${AGENT_PUB}/mandate`,
      payload: { ...document, note: "surprise" }
    });
    expect(extraField.statusCode).toBe(400);
    expect(extraField.json().error.code).toBe("invalid_request");
    await server.close();
  });

  it("revokes with an owner-signed document (kill switch)", async () => {
    const { server } = buildMandateServer();
    const document = buildDocument();
    const put = await server.inject({
      method: "PUT",
      url: `/v1/wallets/${AGENT_PUB}/mandate`,
      payload: document
    });
    const { mandateHash } = put.json() as { mandateHash: string };

    const signedAtMs = Date.now();
    const revoke = await server.inject({
      method: "POST",
      url: `/v1/wallets/${AGENT_PUB}/mandate/revoke`,
      payload: {
        mandateHash,
        signedAtMs,
        signature: sign(
          revokeSigningMessage(mandateHash, signedAtMs),
          OWNER.secretKey
        )
      }
    });
    expect(revoke.statusCode).toBe(200);
    expect(revoke.json().status).toBe("revoked");

    const get = await server.inject({
      method: "GET",
      url: `/v1/wallets/${AGENT_PUB}/mandate`,
      headers: adminHeaders
    });
    expect(get.json().effectiveStatus).toBe("revoked");
    await server.close();
  });

  it("serves approvals and the spending log to authed callers only", async () => {
    const { server } = buildMandateServer();

    const unauthed = await server.inject({
      method: "GET",
      url: `/v1/wallets/${AGENT_PUB}/approvals`
    });
    expect(unauthed.statusCode).toBe(401);

    const approvals = await server.inject({
      method: "GET",
      url: `/v1/wallets/${AGENT_PUB}/approvals`,
      headers: adminHeaders
    });
    expect(approvals.statusCode).toBe(200);
    expect(approvals.json().approvals).toEqual([]);

    const log = await server.inject({
      method: "GET",
      url: `/v1/wallets/${AGENT_PUB}/spending-log`,
      headers: adminHeaders
    });
    expect(log.statusCode).toBe(200);
    expect(log.json().entries).toEqual([]);
    await server.close();
  });

  it("returns 501 when the mandate layer is not configured", async () => {
    const server = buildServer(new SublyService(), { adminApiToken: ADMIN });
    const response = await server.inject({
      method: "GET",
      url: `/v1/wallets/${AGENT_PUB}/mandate`,
      headers: adminHeaders
    });
    expect(response.statusCode).toBe(501);
    expect(response.json().error.code).toBe("mandate_unavailable");
    await server.close();
  });

  it("404s a wallet with no mandate", async () => {
    const { server } = buildMandateServer();
    const response = await server.inject({
      method: "GET",
      url: `/v1/wallets/${AGENT_PUB}/mandate`,
      headers: adminHeaders
    });
    expect(response.statusCode).toBe(404);
    expect(response.json().error.code).toBe("mandate_not_found");
    await server.close();
  });
});

describe("setup-session API and owner pages", () => {
  it("runs the whole web onboarding over HTTP: authed create, public confirm-only complete", async () => {
    const { server } = buildMandateServer();
    const passkey = createTestPasskey();

    // Creating the link is an AGENT action: unauthenticated calls bounce.
    const unauthed = await server.inject({
      method: "POST",
      url: `/v1/wallets/${AGENT_PUB}/setup-sessions`,
      payload: { initialDepositRawUsdc: "500000000" }
    });
    expect(unauthed.statusCode).toBe(401);

    const created = await server.inject({
      method: "POST",
      url: `/v1/wallets/${AGENT_PUB}/setup-sessions`,
      headers: adminHeaders,
      payload: { initialDepositRawUsdc: "500000000" }
    });
    expect(created.statusCode).toBe(200);
    const session = created.json() as {
      sessionId: string;
      setupUrl: string;
    };
    expect(session.setupUrl).toContain(session.sessionId);

    // The capability URL itself is the read authorization (owner's phone).
    const view = await server.inject({
      method: "GET",
      url: `/v1/setup-sessions/${session.sessionId}`
    });
    expect(view.statusCode).toBe(200);
    const pending = view.json() as {
      status: string;
      wallet: string;
      vault: string;
      policy: SpendingMandatePayload["policy"];
      enforcementMode: "subly" | "wallet_infra";
      mandateExpiresAtMs: number;
      initialDepositRawUsdc: string;
      webauthn: { rpId: string };
    };
    expect(pending.status).toBe("pending");
    expect(pending.webauthn.rpId).toBe("app.subly.fi");

    // Sign exactly what the page signs (no agent co-sign in the document).
    const payload: SpendingMandatePayload = {
      version: 1,
      ownerAuth: "passkey",
      ownerCredential: passkey.credential,
      enforcementMode: pending.enforcementMode,
      agentWallet: pending.wallet,
      vault: pending.vault,
      issuedAtMs: Date.now(),
      expiresAtMs: pending.mandateExpiresAtMs,
      policy: pending.policy,
      initialDeposit: { amountRawUsdc: pending.initialDepositRawUsdc }
    };
    const message = mandateSigningMessage(mandateHashOf(payload));
    const completed = await server.inject({
      method: "POST",
      url: `/v1/setup-sessions/${session.sessionId}/complete`,
      payload: {
        document: { ...payload, ownerSignature: passkey.signAssertion(message) }
      }
    });
    expect(completed.statusCode).toBe(200);
    const outcome = completed.json() as {
      status: string;
      mandateHash: string;
      initialDepositApproval: { approvalId: string } | null;
    };
    expect(outcome.status).toBe("active");
    expect(outcome.initialDepositApproval).not.toBeNull();

    // The agent's poll sees the completion and the pre-approved deposit.
    const after = await server.inject({
      method: "GET",
      url: `/v1/setup-sessions/${session.sessionId}`
    });
    expect(after.json()).toMatchObject({
      status: "completed",
      mandateHash: outcome.mandateHash
    });

    // Single-use.
    const again = await server.inject({
      method: "POST",
      url: `/v1/setup-sessions/${session.sessionId}/complete`,
      payload: {
        document: { ...payload, ownerSignature: passkey.signAssertion(message) }
      }
    });
    expect(again.statusCode).toBe(409);
    expect(again.json().error.code).toBe("setup_session_used");

    // Public revoke-page summary exposes only signing essentials.
    const summary = await server.inject({
      method: "GET",
      url: `/v1/wallets/${AGENT_PUB}/mandate/summary`
    });
    expect(summary.statusCode).toBe(200);
    expect(summary.json()).toMatchObject({
      mandateHash: outcome.mandateHash,
      ownerAuth: "passkey",
      credentialId: passkey.credential.credentialId
    });
    expect(summary.json().mandate).toBeUndefined();
    await server.close();
  });

  it("serves the approval capability view and the owner pages", async () => {
    const { server } = buildMandateServer();

    const missing = await server.inject({
      method: "GET",
      url: "/v1/approvals/apr_nonexistent"
    });
    expect(missing.statusCode).toBe(404);

    for (const path of [
      "/setup/st_test",
      "/approve/apr_test",
      `/revoke/${AGENT_PUB}`
    ]) {
      const page = await server.inject({ method: "GET", url: path });
      expect(page.statusCode).toBe(200);
      expect(page.headers["content-type"]).toContain("text/html");
      expect(page.headers["x-frame-options"]).toBe("DENY");
      expect(page.headers["content-security-policy"]).toContain(
        "frame-ancestors 'none'"
      );
      expect(page.body).toContain("<!doctype html>");
      // Self-contained: nothing loads from external hosts, and the CSP
      // forbids external scripts/exfil even if markup ever slipped through.
      expect(page.body).not.toMatch(/src="http|href="http/);
      expect(page.body).toContain("Content-Security-Policy");
    }
    await server.close();
  });
});
