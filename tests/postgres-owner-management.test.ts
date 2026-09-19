import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { describe, expect, it, vi } from "vitest";
import { DEFAULT_VAULT_CONFIG } from "../src/config/vault.js";
import { PostgresLedger } from "../src/domain/postgres-ledger.js";
import { SpendingMandateService } from "../src/domain/spending-mandate-service.js";
import { mandateHashOf, mandatePayloadOf, mandateSigningMessage, revokeSigningMessage } from "../src/domain/spending-mandate.js";
import { AGENT_PUB, OWNER, NOW_MS, buildDocument, sign } from "./helpers/mandate-fixtures.js";

const connectionString = process.env.SUBLY_TEST_POSTGRES_URL;

describe.skipIf(!connectionString)("Postgres owner management", () => {
  it("persists management links and atomically commits owner mutations with single-use completion", async () => {
    const schema = `subly_test_${randomUUID().replaceAll("-", "")}`;
    const admin = new Pool({ connectionString });
    await admin.query(`create schema ${schema}`);
    const config = { connectionString, options: `-c search_path=${schema}` };
    let ledger = new PostgresLedger(config);
    const vault = DEFAULT_VAULT_CONFIG.address;
    const makeService = () => new SpendingMandateService({ ledger, config: { nowMs: () => NOW_MS } });
    try {
      let service = makeService();
      const document = buildDocument();
      const original = await service.registerMandate({ wallet: AGENT_PUB, vault, document });
      const link = await service.createOwnerSession({ wallet: AGENT_PUB, vault,
        policy: { dailyApiSpendCapRawUsdc: "70000000" } });
      await ledger.close();
      ledger = new PostgresLedger(config);
      service = makeService();
      const view = await service.getOwnerSession(link.sessionId);
      expect(view).toMatchObject({ status: "pending", wallet: AGENT_PUB, vault,
        currentMandate: { mandateHash: original.mandateHash } });
      const payload = { ...mandatePayloadOf(document), issuedAtMs: NOW_MS,
        policy: { ...document.policy, dailyApiSpendCapRawUsdc: "70000000" } };
      const signed = { ...payload, ownerSignature: sign(mandateSigningMessage(mandateHashOf(payload)), OWNER.secretKey) };
      const saveFailure = vi.spyOn(ledger, "saveSetupSession").mockRejectedValueOnce(new Error("completion write failed"));
      await expect(service.completeOwnerSession({ sessionId: link.sessionId, document: signed })).rejects.toThrow("completion write failed");
      saveFailure.mockRestore();
      expect((await ledger.getSpendingMandate(AGENT_PUB, vault))?.mandateHash).toBe(original.mandateHash);
      expect((await ledger.getSetupSession(link.sessionId))?.status).toBe("pending");
      const updated = await service.completeOwnerSession({ sessionId: link.sessionId, document: signed });
      expect(updated.initialDepositApproval).toBeNull();
      await ledger.close();
      ledger = new PostgresLedger(config);
      service = makeService();
      expect(await service.getOwnerSession(link.sessionId)).toMatchObject({ status: "completed", action: "update", vault });
      expect((await ledger.getSpendingMandate(AGENT_PUB, vault))?.mandateHash).toBe(updated.mandateHash);

      const revokeLink = await service.createOwnerSession({ wallet: AGENT_PUB, vault });
      const action = { sessionId: revokeLink.sessionId, action: "revoke" as const,
        mandateHash: updated.mandateHash, signedAtMs: NOW_MS,
        signature: sign(revokeSigningMessage(updated.mandateHash, NOW_MS), OWNER.secretKey) };
      const actionFailure = vi.spyOn(ledger, "saveSetupSession").mockRejectedValueOnce(new Error("action write failed"));
      await expect(service.completeOwnerAction(action)).rejects.toThrow("action write failed");
      actionFailure.mockRestore();
      expect((await ledger.getSpendingMandate(AGENT_PUB, vault))?.status).toBe("active");
      await service.completeOwnerAction(action);
      expect((await ledger.getSpendingMandate(AGENT_PUB, vault))?.status).toBe("revoked");
      expect(await service.getOwnerSession(revokeLink.sessionId)).toMatchObject({ status: "completed", action: "revoke" });
      await expect(service.completeOwnerAction(action)).rejects.toMatchObject({ code: "setup_session_used" });
    } finally {
      await ledger.close();
      await admin.query(`drop schema ${schema} cascade`);
      await admin.end();
    }
  });
});
