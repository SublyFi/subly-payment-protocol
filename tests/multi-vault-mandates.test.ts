import { describe, expect, it } from "vitest";
import { SUBLY_VAULT } from "../src/config/constants.js";
import { InMemoryLedger } from "../src/domain/ledger.js";
import { SpendingMandateService } from "../src/domain/spending-mandate-service.js";
import { revokeSigningMessage } from "../src/domain/spending-mandate.js";
import { AGENT_PUB, buildDocument, NOW_MS, OWNER, sign } from "./helpers/mandate-fixtures.js";

const A = SUBLY_VAULT.address;
const B = "HDsayqAsDWy3QvANGqh2yNraqcD8Fnjgh73Mhb3WRS5E";
function setup() {
  const ledger = new InMemoryLedger();
  const service = new SpendingMandateService({ ledger, config: { nowMs: () => NOW_MS } });
  const register = (vault: string, initial = false) => service.registerMandate({
    wallet: AGENT_PUB, vault,
    document: buildDocument({ payload: { vault,
      ...(initial ? { initialDeposit: { amountRawUsdc: "2000000" } } : {}) } })
  });
  const deposit = (vault: string, approvalId: string | null = null) => service.authorizeDeposit({
    wallet: AGENT_PUB, vault, amountRawUsdc: 2_000_000n, approvalId
  });
  return { ledger, service, register, deposit };
}

describe("mandates across vaults", () => {
  it("keeps owner contracts and revocations independent for the same wallet", async () => {
    const { ledger, service, register } = setup();
    const a = await register(A);
    const b = await register(B);
    expect(a.mandateHash).not.toBe(b.mandateHash);
    expect((await ledger.getSpendingMandate(AGENT_PUB, A))?.mandateHash).toBe(a.mandateHash);
    expect((await ledger.getSpendingMandate(AGENT_PUB, B))?.mandateHash).toBe(b.mandateHash);
    await service.revokeMandate({ wallet: AGENT_PUB, mandateHash: a.mandateHash,
      signedAtMs: NOW_MS, signature: sign(revokeSigningMessage(a.mandateHash, NOW_MS), OWNER.secretKey) });
    const input = { wallet: AGENT_PUB, amountRawUsdc: 1n, approvalId: null };
    await expect(service.authorizeWithdrawal({ ...input, vault: A })).rejects.toMatchObject({ code: "mandate_revoked" });
    await expect(service.authorizeWithdrawal({ ...input, vault: B })).resolves.toMatchObject({ mandateHash: b.mandateHash });
    expect((await service.getMandateSummary(AGENT_PUB, B)).vault).toBe(B);
  });

  it("rejects an approved initial deposit from another vault, even for the same amount", async () => {
    const { service, register, deposit } = setup();
    const a = await register(A, true);
    await register(B);
    const id = a.initialDepositApproval!.approvalId;
    await expect(deposit(A, id)).resolves.toMatchObject({ approvalId: id });
    await expect(deposit(B, id)).rejects.toMatchObject({ code: "deposit_approval_required" });
    expect((await service.listApprovals(AGENT_PUB, "approved", B))).toEqual([]);
    expect((await service.listApprovals(AGENT_PUB, "approved", A))[0]?.approvalId).toBe(id);
  });

  it("does not reuse a pending approval in another vault or after mandate replacement", async () => {
    const { service, register, deposit } = setup();
    await register(A);
    await register(B);
    const first = await deposit(A).catch((e) => e);
    const repeated = await deposit(A).catch((e) => e);
    const other = await deposit(B).catch((e) => e);
    expect(repeated.details.approvalId).toBe(first.details.approvalId);
    expect(other.details.approvalId).not.toBe(first.details.approvalId);
    await service.registerMandate({ wallet: AGENT_PUB, vault: A,
      document: buildDocument({ payload: { issuedAtMs: NOW_MS, vault: A } }) });
    const replaced = await deposit(A).catch((e) => e);
    expect(replaced.details.approvalId).not.toBe(first.details.approvalId);
  });
});
