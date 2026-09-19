import bs58 from "bs58";
import nacl from "tweetnacl";
import { describe, expect, it } from "vitest";
import { buildServer } from "../src/api/server.js";
import { walletAuthMessage } from "../src/api/wallet-auth.js";
import { SublyService } from "../src/domain/payment-service.js";
import { SpendingMandateService } from "../src/domain/spending-mandate-service.js";
import { mandateHashOf, mandatePayloadOf, mandateSigningMessage, revokeSigningMessage } from "../src/domain/spending-mandate.js";
import { AGENT, AGENT_PUB, OWNER, buildDocument, sign } from "./helpers/mandate-fixtures.js";

describe("owner management HTTP boundary", () => {
  it("requires the agent's authenticated proposal and the registered owner's approval", async () => {
    const service = new SublyService();
    const mandates = new SpendingMandateService({ ledger: service.ledger });
    const server = buildServer(service, { mandateService: mandates, apiRatePerMinute: 0 });
    try {
      const initial = buildDocument();
      await mandates.registerMandate({ wallet: AGENT_PUB, vault: service.vault.address, document: initial });
      const url = `/v1/wallets/${AGENT_PUB}/owner-sessions`;
      const rawBody = JSON.stringify({ vault: service.vault.address, policy: { dailyApiSpendCapRawUsdc: "70000000" } });
      const signedAtMs = String(Date.now());
      const headersFor = (key: typeof AGENT) => ({
        "content-type": "application/json",
        "x-subly-wallet": bs58.encode(key.publicKey),
        "x-subly-signed-at": signedAtMs,
        "x-subly-signature": bs58.encode(nacl.sign.detached(walletAuthMessage({
          method: "POST", path: url, rawBody, signedAtMs
        }), key.secretKey))
      });
      const anonymous = await server.inject({ method: "POST", url, payload: rawBody,
        headers: { "content-type": "application/json" } });
      expect(anonymous.statusCode).toBe(401);
      const foreign = await server.inject({ method: "POST", url, payload: rawBody, headers: headersFor(OWNER) });
      expect(foreign.statusCode).toBe(403);
      const created = await server.inject({ method: "POST", url, payload: rawBody, headers: headersFor(AGENT) });
      expect(created.statusCode).toBe(200);
      const sessionId = created.json().sessionId as string;
      const view = await server.inject({ method: "GET", url: `/v1/owner-sessions/${sessionId}` });
      expect(view.headers["cache-control"]).toBe("no-store");
      const pending = view.json();
      expect(pending.currentMandate.ownerCredential).toEqual(initial.ownerCredential);
      expect(pending.mandateExpiresAtMs).toBe(initial.expiresAtMs);
      const payload = { ...mandatePayloadOf(initial), policy: pending.policy,
        issuedAtMs: Math.max(Date.now(), initial.issuedAtMs + 1) };
      const message = mandateSigningMessage(mandateHashOf(payload));
      const rejected = await server.inject({ method: "POST", url: `/v1/owner-sessions/${sessionId}/complete`,
        payload: { document: { ...payload, ownerSignature: sign(message, AGENT.secretKey) } } });
      expect(rejected.statusCode).toBe(400);
      expect(rejected.json().error.code).toBe("owner_signature_invalid");
      const updated = await server.inject({ method: "POST", url: `/v1/owner-sessions/${sessionId}/complete`,
        payload: { document: { ...payload, ownerSignature: sign(message, OWNER.secretKey) } } });
      expect(updated.statusCode).toBe(200);
      expect(updated.json().initialDepositApproval).toBeNull();
      const after = await server.inject({ method: "GET", url: `/v1/owner-sessions/${sessionId}` });
      expect(after.json()).toMatchObject({ wallet: AGENT_PUB, vault: service.vault.address,
        status: "completed", action: "update" });

      // A capability URL alone grants no mutation; even revocation still needs
      // the existing owner signature and a mandate bound to that session.
      const revokeLink = await mandates.createOwnerSession({ wallet: AGENT_PUB, vault: service.vault.address });
      const action = { action: "revoke", mandateHash: updated.json().mandateHash,
        signedAtMs: Date.now() };
      const rejectedRevoke = await server.inject({ method: "POST", url: `/v1/owner-sessions/${revokeLink.sessionId}/action`,
        payload: { ...action, signature: sign(revokeSigningMessage(action.mandateHash, action.signedAtMs), AGENT.secretKey) } });
      expect(rejectedRevoke.statusCode).toBe(403);
      const revoked = await server.inject({ method: "POST", url: `/v1/owner-sessions/${revokeLink.sessionId}/action`,
        payload: { ...action, signature: sign(revokeSigningMessage(action.mandateHash, action.signedAtMs), OWNER.secretKey) } });
      expect(revoked.statusCode).toBe(200);
      expect(revoked.json().status).toBe("revoked");
      const page = await server.inject({ method: "GET", url: `/owner/${revokeLink.sessionId}` });
      expect(page.statusCode).toBe(200);
      expect(page.headers["x-frame-options"]).toBe("DENY");
      expect(page.headers["cache-control"]).toBe("no-store");
      expect(page.body).toContain("Manage your agent's spending");
    } finally {
      await server.close();
    }
  });
});
