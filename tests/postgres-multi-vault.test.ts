import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { describe, expect, it, vi } from "vitest";
import { PostgresLedger } from "../src/domain/postgres-ledger.js";
import { InMemoryLedger } from "../src/domain/ledger.js";
import { SpendingMandateService } from "../src/domain/spending-mandate-service.js";
import { DEFAULT_VAULT_CONFIG } from "../src/config/vault.js";
import { AGENT_PUB, buildDocument, NOW_MS } from "./helpers/mandate-fixtures.js";

const connectionString = process.env.SUBLY_TEST_POSTGRES_URL;
const A = DEFAULT_VAULT_CONFIG.address;
const B = "HDsayqAsDWy3QvANGqh2yNraqcD8Fnjgh73Mhb3WRS5E";

// Opt in with a disposable PostgreSQL instance. Each test owns an isolated schema.
describe.skipIf(!connectionString)("Postgres vault mandate migration", () => {
  it("survives a terminated idle backend and reconnects without losing stored mandates", async () => {
    const schema = `subly_test_${randomUUID().replaceAll("-", "")}`;
    const admin = new Pool({ connectionString });
    await admin.query(`create schema ${schema}`);
    const ledger = new PostgresLedger({
      connectionString, options: `-c search_path=${schema}`, application_name: schema
    });
    const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const service = new SpendingMandateService({ ledger, config: { nowMs: () => NOW_MS } });
      const saved = await service.registerMandate({ wallet: AGENT_PUB, vault: A, document: buildDocument() });
      const before = await admin.query("select pid from pg_stat_activity where application_name = $1 and state = 'idle'", [schema]);
      expect(before.rowCount).toBe(1);
      const pid = before.rows[0].pid;
      await admin.query("select pg_terminate_backend($1)", [pid]);
      await expect.poll(() => warning.mock.calls.length).toBe(1);
      expect(warning).toHaveBeenCalledWith("PostgreSQL idle connection lost; the next query will reconnect.");
      await ledger.checkHealth();
      expect((await ledger.getSpendingMandate(AGENT_PUB, A))?.mandateHash).toBe(saved.mandateHash);
      const after = await admin.query("select pid from pg_stat_activity where application_name = $1", [schema]);
      expect(after.rows[0].pid).not.toBe(pid);
    } finally {
      warning.mockRestore();
      await ledger.close();
      await admin.query(`drop schema ${schema} cascade`);
      await admin.end();
    }
  });

  it.each([false, true])("preserves isolated mandates across restarts (legacy data: %s)", async (legacy) => {
    const schema = `subly_test_${randomUUID().replaceAll("-", "")}`;
    const admin = new Pool({ connectionString });
    await admin.query(`create schema ${schema}`);
    const config = { connectionString, options: `-c search_path=${schema}` };
    const pool = new Pool(config);
    let ledger = new PostgresLedger(config);
    try {
      if (legacy) {
        const memory = new InMemoryLedger();
        const oldService = new SpendingMandateService({ ledger: memory, config: { nowMs: () => NOW_MS } });
        await oldService.registerMandate({ wallet: AGENT_PUB, vault: A, document: buildDocument() });
        const old = await memory.getSpendingMandate(AGENT_PUB, A);
        await pool.query(`create table spending_mandates (
          wallet text primary key, status text not null, mandate_hash text not null, data jsonb not null,
          created_at timestamptz not null default now(), updated_at timestamptz not null default now())`);
        await pool.query("insert into spending_mandates (wallet, status, mandate_hash, data) values ($1,$2,$3,$4)",
          [AGENT_PUB, old!.status, old!.mandateHash, JSON.stringify(old)]);
        expect(await ledger.getSpendingMandate(AGENT_PUB, A)).toEqual(old);
      }
      const service = new SpendingMandateService({ ledger, config: { nowMs: () => NOW_MS } });
      const a = await service.registerMandate({ wallet: AGENT_PUB, vault: A,
        document: buildDocument({ payload: { issuedAtMs: NOW_MS } }) });
      const b = await service.registerMandate({ wallet: AGENT_PUB, vault: B,
        document: buildDocument({ payload: { vault: B } }) });
      expect((await ledger.getSpendingMandateByHash(AGENT_PUB, b.mandateHash))?.vault).toBe(B);
      await ledger.close();
      ledger = new PostgresLedger(config); // reruns idempotent schema/backfill
      expect((await ledger.getSpendingMandate(AGENT_PUB, A))?.mandateHash).toBe(a.mandateHash);
      expect((await ledger.getSpendingMandate(AGENT_PUB, B))?.mandateHash).toBe(b.mandateHash);
      expect((await pool.query("select * from vault_spending_mandates")).rowCount).toBe(2);
      expect((await pool.query("select * from spending_mandates")).rowCount).toBe(legacy ? 1 : 0);
    } finally {
      await ledger.close(); await pool.end();
      await admin.query(`drop schema ${schema} cascade`); await admin.end();
    }
  });
  it("commits owner approval challenges but rolls back unexpected failures", async () => {
    const schema = `subly_test_${randomUUID().replaceAll("-", "")}`;
    const admin = new Pool({ connectionString });
    await admin.query(`create schema ${schema}`);
    const ledger = new PostgresLedger({ connectionString, options: `-c search_path=${schema}` });
    try {
      const service = new SpendingMandateService({ ledger, config: { nowMs: () => NOW_MS, enforcementLevel: "on" } });
      await service.registerMandate({ wallet: AGENT_PUB, vault: A, document: buildDocument() });
      await expect(ledger.withWalletVaultLock(AGENT_PUB, A, () => service.authorizeDeposit({
        wallet: AGENT_PUB, vault: A, amountRawUsdc: 1_010_000n, approvalId: null
      }))).rejects.toMatchObject({ code: "deposit_approval_required" });
      const approvals = await ledger.listSpendingApprovalsForWallet(AGENT_PUB);
      expect(approvals).toHaveLength(1);
      expect((await service.getApprovalView(approvals[0]!.approvalId)).status).toBe("pending");
      await expect(ledger.withWalletVaultLock(AGENT_PUB, A, async () => {
        await ledger.saveSpendingApproval({ ...approvals[0]!, status: "denied" });
        throw new Error("unexpected failure");
      })).rejects.toThrow("unexpected failure");
      expect((await ledger.getSpendingApproval(approvals[0]!.approvalId))?.status).toBe("pending");
    } finally {
      await ledger.close(); await admin.query(`drop schema ${schema} cascade`); await admin.end();
    }
  });

});
