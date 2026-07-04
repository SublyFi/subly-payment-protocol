import { describe, expect, it } from "vitest";
import { buildServer } from "../src/api/server.js";
import { SublyService } from "../src/domain/payment-service.js";
import { SpendingMandateService } from "../src/domain/spending-mandate-service.js";
import { revokeSigningMessage } from "../src/domain/spending-mandate.js";
import {
  AGENT_PUB,
  buildDocument,
  OWNER,
  sign
} from "./helpers/mandate-fixtures.js";

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
