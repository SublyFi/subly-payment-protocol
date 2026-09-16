import { afterEach, describe, expect, it, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { DEFAULT_VAULT_CONFIG } from "../src/config/vault.js";
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
      getBudget: vi.fn(async () => ({ wallet: "agent", vault: vault.address,
        principalBasisRawUsdc: "1000000", positionValueRawUsdc: "1000100", spendableYieldRawUsdc: "100" })),
      createSetupLink: vi.fn(), deposit: vi.fn(), withdraw: vi.fn()
    }
  } as unknown as McpVaultSession;
}
afterEach(() => { vi.unstubAllGlobals(); vi.clearAllMocks(); });

describe("MCP vault selection", () => {
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
