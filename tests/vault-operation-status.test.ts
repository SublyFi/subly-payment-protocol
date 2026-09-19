import { describe, expect, it, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { SUBLY_VAULT, SOLANA_MAINNET_NETWORK } from "../src/config/constants.js";
import { StandardX402Payer } from "../src/client/standard-x402-payer.js";
import { VaultFlowClient } from "../src/client/vault-flows.js";
import { createMcpPaymentServer } from "../src/client/mcp-payment-server.js";
import type { AgentWalletSigner } from "../src/client/agent-wallet-signer.js";
import type { SolanaRpc } from "../src/solana/rpc.js";
import { ensureWalletOnboarded } from "../src/client/onboarding.js";

vi.mock("../src/client/onboarding.js", () => ({ ensureWalletOnboarded: vi.fn(async () => undefined) }));
const WALLET = "GPqt7ksu6LoKAx7PXEDb54bjrN5fs9R61TkzyL5X3H1M";
const DEP = `dep_${"1".repeat(32)}`;
const WDR = `wdr_${"2".repeat(32)}`;
function record(kind: "deposit" | "withdrawal", status = "submitted") {
  return { [kind === "deposit" ? "depositId" : "withdrawalId"]: kind === "deposit" ? DEP : WDR,
    wallet: WALLET, vault: SUBLY_VAULT.address, status,
    amountRawUsdc: "50000", requestedWithdrawRawUsdc: "50000",
    actualDepositRawUsdc: status === "confirmed" ? "50000" : null,
    actualWithdrawRawUsdc: status === "confirmed" ? "50000" : null,
    txSignature: "original-signature", errorCode: null,
    serializedTransaction: "private-transaction-bytes", submittedSerializedTransaction: "private-signed-bytes",
    signingIntent: { hidden: "signing material" }, approvalId: "private-approval" };
}
function fixture(records: unknown[]) {
  let cursor = 0;
  const fetchImpl = vi.fn(async () => new Response(JSON.stringify(records[cursor++])));
  const signer = { walletAddress: WALLET, validationMode: "structured_intent_transaction",
    signApiMessage: vi.fn(async (_message: Uint8Array) => "wallet-auth-signature"),
    signDeposit: vi.fn(), signWithdrawal: vi.fn(), signPayment: vi.fn()
  } satisfies AgentWalletSigner;
  const rpc = { simulateTransaction: vi.fn() };
  const vaultFlows = new VaultFlowClient({ relayerBaseUrl: "https://relayer.invalid", signer,
    rpc: rpc as unknown as SolanaRpc, fetchImpl: fetchImpl as unknown as typeof fetch });
  return { vaultFlows, signer, rpc, fetchImpl };
}

describe("vault operation status", () => {
  it("makes concurrent payments share onboarding and the payer's single purchase", async () => {
    vi.mocked(ensureWalletOnboarded).mockClear();
    let release!: () => void;
    let entered!: () => void;
    const started = new Promise<void>(resolve => { entered = resolve; });
    const onboarding = new Promise<void>(resolve => { release = resolve; });
    vi.mocked(ensureWalletOnboarded).mockImplementationOnce(async () => { entered(); await onboarding; });
    const f = fixture([]);
    const realize = vi.fn(async () => ({ realizedRawUsdc: 10000n, txSignature: "original-realize" }));
    const merchant = vi.fn(async () => new Response("delivered"));
    const payer = new StandardX402Payer({ realizer: { ensureUsdcAvailable: realize }, x402Fetch: merchant,
      defaultMaxAmountRawUsdc: 10000n,
      probeFetch: async () => new Response(JSON.stringify({ x402Version: 2, accepts: [{
        scheme: "exact", network: SOLANA_MAINNET_NETWORK, asset: SUBLY_VAULT.usdcMint,
        amount: "10000", payTo: WALLET, maxTimeoutSeconds: 300, extra: { feePayer: WALLET }
      }] }), { status: 402 }) });
    const server = createMcpPaymentServer({ ...f, payer, relayerBaseUrl: "https://relayer.invalid", defaultMaxAmountRawUsdc: 10000n });
    const client = new Client({ name: "concurrent-payment-test", version: "1" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport); await client.connect(clientTransport);
    try {
      const request = { name: "fetch_with_subly_payment", arguments: { url: "https://seller.invalid/resource" } };
      const first = client.callTool(request);
      await started;
      const second = client.callTool(request);
      // Process the second MCP request while the first one's onboarding is held.
      await new Promise<void>(resolve => setImmediate(resolve));
      expect(realize).not.toHaveBeenCalled(); expect(merchant).not.toHaveBeenCalled();
      release();
      const results = await Promise.all([first, second]);
      expect(results.every(result => !result.isError)).toBe(true);
      expect(ensureWalletOnboarded).toHaveBeenCalledTimes(1);
      expect(realize).toHaveBeenCalledTimes(1); expect(merchant).toHaveBeenCalledTimes(1);
    } finally { release(); await client.close(); await server.close(); }
  });

  it.each(["deposit", "withdrawal"] as const)("reconciles the same %s via authenticated GET and returns only public outcome fields", async kind => {
    const f = fixture([record(kind), record(kind, "confirmed")]);
    const id = kind === "deposit" ? DEP : WDR;
    expect(await f.vaultFlows.getOperationStatus(id)).toMatchObject({ intentId: id, kind,
      status: "submitted", stillConfirming: true, nextAction: "check_again" });
    const confirmed = await f.vaultFlows.getOperationStatus(id);
    expect(confirmed).toMatchObject({ intentId: id, kind, status: "confirmed", requestedAmountRawUsdc: "50000",
      actualAmountRawUsdc: "50000", txSignature: "original-signature", nextAction: "done" });
    expect(JSON.stringify(confirmed)).not.toContain("private");
    expect(JSON.stringify(confirmed)).not.toContain("serializedTransaction");
    expect(JSON.stringify(confirmed)).not.toContain("signingIntent");
    for (const call of vi.mocked(f.fetchImpl).mock.calls as unknown as [string, RequestInit][]) {
      expect(call[0]).toBe(`https://relayer.invalid/v1/${kind === "deposit" ? "deposits" : "withdrawals"}/${id}?resubmit=false`);
      expect(call[1].method ?? "GET").toBe("GET");
      expect(call[1].body).toBeUndefined();
      expect(call[1].headers).toMatchObject({ "x-subly-wallet": WALLET, "x-subly-signature": "wallet-auth-signature" });
    }
    expect(Buffer.from(f.signer.signApiMessage.mock.calls[0]![0]).toString()).toContain(`subly-api:GET:/v1/${kind === "deposit" ? "deposits" : "withdrawals"}/${id}?resubmit=false:`);
    expect(f.signer.signWithdrawal).not.toHaveBeenCalled(); expect(f.signer.signDeposit).not.toHaveBeenCalled();
    expect(f.rpc.simulateTransaction).not.toHaveBeenCalled();
  });

  it.each(["../withdrawals/x", "dep_short", "wdr_../../prepare", `dep_${"a".repeat(33)}`, "pay_123"])("refuses invalid IDs before any API message is signed: %s", async id => {
    const f = fixture([]);
    await expect(f.vaultFlows.getOperationStatus(id)).rejects.toThrow("intentId");
    expect(f.fetchImpl).not.toHaveBeenCalled(); expect(f.signer.signApiMessage).not.toHaveBeenCalled();
  });

  it.each([{ depositId: `dep_${"3".repeat(32)}` }, { wallet: "another-wallet" }, { vault: "another-vault" }])(
    "refuses an operation in another context: %j", async changed => {
      const f = fixture([{ ...record("deposit"), ...changed }]);
      await expect(f.vaultFlows.getOperationStatus(DEP)).rejects.toThrow("current wallet or selected vault");
    });

  it.each([{ status: "unrecognized" }, { amountRawUsdc: "NaN" },
    { actualDepositRawUsdc: undefined }, { status: "confirmed", actualDepositRawUsdc: null },
    { status: "confirmed", actualDepositRawUsdc: "50000", txSignature: null }])(
    "refuses incomplete or malformed outcome fields: %j", async changed => {
      const f = fixture([{ ...record("deposit"), ...changed }]);
      await expect(f.vaultFlows.getOperationStatus(DEP)).rejects.toThrow("invalid operation status fields");
    });

  it.each(["prepared", "failed", "expired", "failed_not_submitted"])("reports %s without authorizing an automatic repeat", async status => {
    const f = fixture([record("withdrawal", status)]);
    const result = await f.vaultFlows.getOperationStatus(WDR);
    expect(result.status).toBe(status);
    expect(result.nextAction).toBe(status === "prepared" ? "check_again" : "reconcile_with_operator");
    expect(result.message).toContain("before starting another operation");
  });

  it("exposes status through MCP without registration, budget sync or a transaction", async () => {
    vi.mocked(ensureWalletOnboarded).mockClear();
    const f = fixture([record("withdrawal", "confirmed")]);
    const payer = { pay: vi.fn(async () => ({ paid: false, status: 200, body: "free" })) };
    const server = createMcpPaymentServer({ ...f, payer, relayerBaseUrl: "https://relayer.invalid", defaultMaxAmountRawUsdc: 10000n });
    const client = new Client({ name: "status-test", version: "1" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport); await client.connect(clientTransport);
    try {
      const tool = (await client.listTools()).tools.find(tool => tool.name === "check_subly_vault_operation");
      expect(tool?.annotations).toMatchObject({ readOnlyHint: true, idempotentHint: true });
      const result = await client.callTool({ name: "check_subly_vault_operation", arguments: { intentId: WDR } });
      const content = result.content as Array<{ type: string; text: string }>;
      expect(JSON.parse(content[0]!.text)).toMatchObject({ intentId: WDR, status: "confirmed" });
      expect(content[0]!.text).not.toContain("private");
      expect(ensureWalletOnboarded).not.toHaveBeenCalled(); expect(payer.pay).not.toHaveBeenCalled();
      expect(f.fetchImpl).toHaveBeenCalledTimes(1); expect(f.signer.signWithdrawal).not.toHaveBeenCalled();
      // Deferring process startup onboarding must preserve the payment path.
      await client.callTool({ name: "fetch_with_subly_payment", arguments: { url: "https://seller.invalid/resource" } });
      await client.callTool({ name: "fetch_with_subly_payment", arguments: { url: "https://seller.invalid/resource" } });
      expect(ensureWalletOnboarded).toHaveBeenCalledTimes(1);
      expect(payer.pay).toHaveBeenCalledTimes(2);
    } finally { await client.close(); await server.close(); }
  });
});
