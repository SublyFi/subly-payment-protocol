import { describe, expect, it, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { SUBLY_VAULT } from "../src/config/constants.js";
import { VaultFlowClient } from "../src/client/vault-flows.js";
import { createMcpPaymentServer } from "../src/client/mcp-payment-server.js";
import type { AgentWalletSigner } from "../src/client/agent-wallet-signer.js";
import type { SolanaRpc } from "../src/solana/rpc.js";
import { ensureWalletOnboarded } from "../src/client/onboarding.js";

vi.mock("../src/client/onboarding.js", () => ({ ensureWalletOnboarded: vi.fn() }));
const WALLET = "GPqt7ksu6LoKAx7PXEDb54bjrN5fs9R61TkzyL5X3H1M";
const SESSION = `st_${"a".repeat(32)}`;
const base = { wallet: WALLET, vault: SUBLY_VAULT.address };
const mandate = { wallet: WALLET, mandateHash: "hash", status: "recovery_pending",
  effectiveStatus: "recovery_pending", recoveryAtMs: 2000000000000, revokedAtMs: null,
  mandate: { vault: SUBLY_VAULT.address, expiresAtMs: 2100000000000, policy: { perPaymentCapRawUsdc: "10000" },
    ownerSignature: "private-signature", ownerCredential: { publicKey: "private-prefill" } } };

function fixture(responses: unknown[]) {
  const fetchImpl = vi.fn(async (_url: string, _init?: RequestInit) => new Response(JSON.stringify(responses.shift())));
  const signer = { walletAddress: WALLET, validationMode: "structured_intent_transaction",
    signApiMessage: vi.fn(async () => "auth-signature"), signDeposit: vi.fn(), signWithdrawal: vi.fn(), signPayment: vi.fn()
  } satisfies AgentWalletSigner;
  const rpc = { simulateTransaction: vi.fn() };
  const vaultFlows = new VaultFlowClient({ signer, rpc: rpc as unknown as SolanaRpc,
    relayerBaseUrl: "https://relayer.invalid", fetchImpl: fetchImpl as typeof fetch });
  return { signer, rpc, fetchImpl, vaultFlows };
}

describe("owner management client", () => {
  it("binds owner changes and recovery to authenticated requests for the selected vault, without transaction signing", async () => {
    const f = fixture([{ ...base, sessionId: SESSION, ownerUrl: `https://relayer.invalid/owner/${SESSION}` },
      { wallet: WALLET, status: "recovery_pending", recoveryAtMs: 2000000000000 }, mandate]);
    await f.vaultFlows.createOwnerSession({ policy: { perPaymentCapRawUsdc: "10000" } });
    const recovery = await f.vaultFlows.startOwnerRecovery();
    expect(recovery.instructions).toContain("72 hours");
    const viewed = await f.vaultFlows.getOwnerStatus();
    expect(viewed).toMatchObject({ ...base, recoveryAtMs: 2000000000000 });
    expect(JSON.stringify(viewed)).not.toContain("private-");
    const calls = f.fetchImpl.mock.calls;
    expect(calls[0]![0]).toBe(`https://relayer.invalid/v1/wallets/${WALLET}/owner-sessions`);
    expect(JSON.parse(calls[0]![1]!.body as string)).toEqual({ vault: base.vault, policy: { perPaymentCapRawUsdc: "10000" } });
    expect(calls[1]![0]).toBe(`https://relayer.invalid/v1/wallets/${WALLET}/mandate/recovery-revoke?vault=${base.vault}`);
    expect(calls[2]![0]).toBe(`https://relayer.invalid/v1/wallets/${WALLET}/mandate?vault=${base.vault}`);
    for (const [, init] of calls) expect(init!.headers).toMatchObject({ "x-subly-wallet": WALLET, "x-subly-signature": "auth-signature" });
    expect(f.signer.signDeposit).not.toHaveBeenCalled(); expect(f.signer.signWithdrawal).not.toHaveBeenCalled();
    expect(f.signer.signPayment).not.toHaveBeenCalled(); expect(f.rpc.simulateTransaction).not.toHaveBeenCalled();
  });

  it("returns only the management session outcome, not owner signing material", async () => {
    const f = fixture([{ ...base, sessionId: SESSION, status: "pending", ownerCredential: "secret-prefill", document: "secret-document" }]);
    expect(await f.vaultFlows.getOwnerSession(SESSION)).toMatchObject({ ...base, status: "pending" });
    await expect(f.vaultFlows.getOwnerSession("st_../../other")).rejects.toThrow("sessionId");
    expect(f.fetchImpl).toHaveBeenCalledTimes(1);
  });

  it.each([{ wallet: "other-wallet" }, { vault: "other-vault" }])("refuses a management link in another context: %j", async changes => {
    const f = fixture([{ ...base, ...changes }]);
    await expect(f.vaultFlows.createOwnerSession()).rejects.toThrow("different wallet or vault");
  });

  it("exposes owner operations through MCP without onboarding, chain sync, or paying", async () => {
    vi.mocked(ensureWalletOnboarded).mockClear();
    const f = fixture([mandate, { ...base, sessionId: SESSION },
      { ...base, sessionId: SESSION, status: "completed", action: "update" },
      { wallet: WALLET, status: "recovery_pending", recoveryAtMs: 2000000000000 }]);
    const payer = { pay: vi.fn() };
    const server = createMcpPaymentServer({ ...f, payer, relayerBaseUrl: "https://relayer.invalid", defaultMaxAmountRawUsdc: 10000n });
    const client = new Client({ name: "owner-test", version: "1" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport); await client.connect(clientTransport);
    try {
      for (const [name, args] of [
        ["get_subly_owner_status", {}], ["create_subly_owner_link", { policy: { perPaymentCapRawUsdc: "10000" } }],
        ["check_subly_owner_session", { sessionId: SESSION }], ["start_subly_owner_recovery", {}]
      ] as const) {
        const result = await client.callTool({ name, arguments: args });
        expect(result.isError).not.toBe(true);
        expect(JSON.stringify(result)).not.toContain("private-");
      }
      expect(ensureWalletOnboarded).not.toHaveBeenCalled(); expect(payer.pay).not.toHaveBeenCalled();
      expect(f.signer.signWithdrawal).not.toHaveBeenCalled(); expect(f.fetchImpl).toHaveBeenCalledTimes(4);
      const invalid = await client.callTool({ name: "create_subly_owner_link", arguments: { policy: [] } });
      expect(invalid.isError).toBe(true); expect(f.fetchImpl).toHaveBeenCalledTimes(4);
    } finally { await client.close(); await server.close(); }
  });
});
