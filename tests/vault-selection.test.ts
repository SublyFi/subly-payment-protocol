import { afterEach, describe, expect, it, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { DEFAULT_VAULT_CONFIG } from "../src/config/vault.js";
import { SOLANA_MAINNET_NETWORK } from "../src/config/constants.js";
import { StandardX402Payer } from "../src/client/standard-x402-payer.js";
import { McpVaultSelection, type McpVaultSession } from "../src/client/vault-selection.js";
import { createMcpPaymentServer } from "../src/client/mcp-payment-server.js";
import { ensureWalletOnboarded } from "../src/client/onboarding.js";

vi.mock("../src/client/onboarding.js", () => ({ ensureWalletOnboarded: vi.fn(async () => undefined) }));
const A = DEFAULT_VAULT_CONFIG;
const B = { ...A, address: "HDsayqAsDWy3QvANGqh2yNraqcD8Fnjgh73Mhb3WRS5E", name: "Another vault" };
const response = (vaults: unknown[]) => new Response(JSON.stringify({ vaults }));
function session(vault: typeof A): McpVaultSession {
  return { vault,
    signer: { vault, walletAddress: "agent" },
    payer: { pay: vi.fn(async () => ({ paid: false, body: vault.address, status: 200 })) },
    vaultFlows: {
      vault,
      getBudget: vi.fn(async () => ({ wallet: "agent", vault: vault.address,
        principalBasisRawUsdc: "1000000", positionValueRawUsdc: "1000100", spendableYieldRawUsdc: "100" })),
      createSetupLink: vi.fn(), deposit: vi.fn(), withdraw: vi.fn()
    }
  } as unknown as McpVaultSession;
}
afterEach(() => { vi.unstubAllGlobals(); vi.clearAllMocks(); });

describe("MCP vault selection", () => {
  it.each([[A, B], [B, A]])("shares a purchase across a vault switch even when the first vault's onboarding is slower (%s)", async (firstVault, nextVault) => {
    const first = session(firstVault); const next = session(nextVault);
    const firstRealize = vi.fn(async () => ({ realizedRawUsdc: 10000n, txSignature: "first-realize" }));
    const nextRealize = vi.fn(async () => ({ realizedRawUsdc: 10000n, txSignature: "next-realize" }));
    const firstRealizer = { vault: firstVault.address, ensureUsdcAvailable: firstRealize };
    const nextRealizer = { vault: nextVault.address, ensureUsdcAvailable: nextRealize };
    const merchant = vi.fn(async () => new Response("delivered"));
    const payer = new StandardX402Payer({ realizer: firstRealizer, x402Fetch: merchant,
      defaultMaxAmountRawUsdc: 10000n,
      probeFetch: async () => new Response(JSON.stringify({ x402Version: 2, accepts: [{
        scheme: "exact", network: SOLANA_MAINNET_NETWORK, asset: A.usdcMint,
        amount: "10000", payTo: A.address, maxTimeoutSeconds: 300, extra: { feePayer: A.address }
      }] }), { status: 402 }) });
    first.payer = { pay: input => payer.pay(input, firstRealizer) };
    next.payer = { pay: input => payer.pay(input, nextRealizer) };
    let release!: () => void;
    let entered!: () => void;
    const started = new Promise<void>(resolve => { entered = resolve; });
    const onboarding = new Promise<void>(resolve => { release = resolve; });
    vi.mocked(ensureWalletOnboarded).mockImplementationOnce(async () => { entered(); await onboarding; });
    vi.stubGlobal("fetch", vi.fn(async () => response([A, B])));
    const selection = new McpVaultSelection([first, next], firstVault.address);
    const server = createMcpPaymentServer({ ...first, relayerBaseUrl: "https://relayer.test",
      defaultMaxAmountRawUsdc: 10000n, vaultSelection: selection });
    const client = new Client({ name: "cross-vault-onboarding-test", version: "1" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport); await client.connect(clientTransport);
    const parse = (result: Awaited<ReturnType<typeof client.callTool>>) => JSON.parse((result.content as Array<{ text: string }>)[0]!.text);
    const url = "https://seller.invalid/resource";
    try {
      const firstRequest = client.callTool({ name: "fetch_with_subly_payment", arguments: { url, method: "get" } });
      await started;
      await client.callTool({ name: "select_subly_vault", arguments: { vaultAddress: nextVault.address } });
      // Uppercase/default method and absent/empty body use the payer's same key.
      const secondRequest = client.callTool({ name: "fetch_with_subly_payment", arguments: { url, body: "" } });
      await new Promise<void>(resolve => setImmediate(resolve));
      expect(merchant).not.toHaveBeenCalled(); expect(nextRealize).not.toHaveBeenCalled();
      release();
      const results = await Promise.all([firstRequest, secondRequest]);
      expect(results.map(result => parse(result).fundingVault)).toEqual([firstVault.address, firstVault.address]);
      expect(firstRealize).toHaveBeenCalledTimes(1); expect(nextRealize).not.toHaveBeenCalled();
      expect(merchant).toHaveBeenCalledTimes(1);
      expect(selection.current().vault.address).toBe(nextVault.address);
      // A completed shared purchase is removed, so a later explicit call uses
      // the currently selected vault and its own onboarding.
      expect(parse(await client.callTool({ name: "fetch_with_subly_payment", arguments: { url } })).fundingVault).toBe(nextVault.address);
      expect(nextRealize).toHaveBeenCalledTimes(1); expect(merchant).toHaveBeenCalledTimes(2);
    } finally { release(); await client.close(); await server.close(); }
  });

  it("allows a new request after a shared payment fails", async () => {
    const a = session(A);
    vi.mocked(a.payer.pay).mockRejectedValueOnce(new Error("budget unavailable"));
    const server = createMcpPaymentServer({ ...a, relayerBaseUrl: "https://relayer.test", defaultMaxAmountRawUsdc: 100n });
    const client = new Client({ name: "retry-after-payment-failure-test", version: "1" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport); await client.connect(clientTransport);
    try {
      const request = { name: "fetch_with_subly_payment", arguments: { url: "https://seller.invalid/resource" } };
      expect((await client.callTool(request)).isError).toBe(true);
      expect((await client.callTool(request)).isError).not.toBe(true);
      expect(a.payer.pay).toHaveBeenCalledTimes(2);
    } finally { await client.close(); await server.close(); }
  });

  it("retains the captured funding vault while onboarding awaits across a selection change", async () => {
    const a = session(A); const b = session(B);
    let release!: () => void;
    let entered!: () => void;
    const started = new Promise<void>(resolve => { entered = resolve; });
    const onboarding = new Promise<void>(resolve => { release = resolve; });
    vi.mocked(ensureWalletOnboarded).mockImplementationOnce(async () => { entered(); await onboarding; });
    vi.stubGlobal("fetch", vi.fn(async () => response([A, B])));
    const selection = new McpVaultSelection([a, b], A.address);
    const server = createMcpPaymentServer({ ...a, relayerBaseUrl: "https://relayer.test",
      defaultMaxAmountRawUsdc: 100n, vaultSelection: selection });
    const client = new Client({ name: "selection-during-onboarding-test", version: "1" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport); await client.connect(clientTransport);
    try {
      const pending = client.callTool({ name: "fetch_with_subly_payment", arguments: { url: "https://seller.invalid/resource" } });
      await started;
      await client.callTool({ name: "select_subly_vault", arguments: { vaultAddress: B.address } });
      expect(a.payer.pay).not.toHaveBeenCalled(); expect(b.payer.pay).not.toHaveBeenCalled();
      release();
      const result = await pending;
      expect(JSON.parse((result.content as Array<{ text: string }>)[0]!.text).body).toBe(A.address);
      expect(a.payer.pay).toHaveBeenCalledTimes(1); expect(b.payer.pay).not.toHaveBeenCalled();
      expect(ensureWalletOnboarded).toHaveBeenCalledWith(expect.objectContaining({ signer: a.signer }));
      expect(selection.current().vault.address).toBe(B.address);
    } finally { release(); await client.close(); await server.close(); }
  });

  it("validates pinned metadata and leaves selection unchanged on every failed switch", async () => {
    const selection = new McpVaultSelection([session(A), session(B)], A.address);
    const fetcher = vi.fn(async () => response([A, B]));
    await expect(selection.select(A.shareMint, "https://relayer.test", fetcher)).rejects.toThrow("local catalog");
    expect(fetcher).not.toHaveBeenCalled();
    await expect(selection.select(B.address, "https://relayer.test", async () => response([A]))).rejects.toThrow("not configured");
    for (const field of ["shareMint", "farm", "programId", "usdcMint"] as const) {
      await expect(selection.select(B.address, "https://relayer.test", async () => response([{ ...B, [field]: "untrusted" }]))).rejects.toThrow(field);
      expect(selection.current().vault.address).toBe(A.address);
    }
    await selection.select(B.address, "https://relayer.test", fetcher);
    expect(selection.list().selectedVault).toBe(B.address);
  });

  it("exposes discovery and selection over MCP, routes subsequent tools, and captures in-flight sessions", async () => {
    const a = session(A); const b = session(B);
    let release!: (value: Awaited<ReturnType<typeof a.vaultFlows.getBudget>>) => void;
    let entered!: () => void;
    const started = new Promise<void>((resolve) => { entered = resolve; });
    vi.mocked(a.vaultFlows.getBudget).mockImplementationOnce(() => {
      entered(); return new Promise((resolve) => { release = resolve; });
    });
    vi.stubGlobal("fetch", vi.fn(async () => response([A, B])));
    const selection = new McpVaultSelection([a, b], A.address);
    const server = createMcpPaymentServer({ ...a, relayerBaseUrl: "https://relayer.test",
      defaultMaxAmountRawUsdc: 100n, vaultSelection: selection });
    const client = new Client({ name: "test", version: "1" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    const parse = (result: any) => JSON.parse(result.content[0].text);
    try {
      expect((await client.listTools()).tools.map((t) => t.name)).toContain("select_subly_vault");
      expect(parse(await client.callTool({ name: "list_subly_vaults" })).selectedVault).toBe(A.address);
      const pending = client.callTool({ name: "get_subly_yield_budget" });
      await started;
      expect(parse(await client.callTool({ name: "select_subly_vault", arguments: { vaultAddress: B.address } })).selectedVault).toBe(B.address);
      release({ wallet: "agent", vault: A.address, principalBasisRawUsdc: "1", positionValueRawUsdc: "2", grossYieldRawUsdc: "1", spendableYieldRawUsdc: "1" });
      expect(parse(await pending).vault).toBe(A.address);
      expect(parse(await client.callTool({ name: "get_subly_yield_budget" })).vault).toBe(B.address);
      expect(ensureWalletOnboarded).toHaveBeenLastCalledWith(expect.objectContaining({ signer: b.signer }));
      expect(a.vaultFlows.getBudget).toHaveBeenCalledTimes(1);
      expect(b.vaultFlows.getBudget).toHaveBeenCalledTimes(1);
    } finally { await client.close(); await server.close(); }
  });
});
