import type { ConfiguredVault } from "../config/vault-catalog.js";
import type { AgentWalletSigner } from "./agent-wallet-signer.js";
import type { StandardX402Payer } from "./standard-x402-payer.js";
import type { VaultFlowClient } from "./vault-flows.js";

export interface McpVaultSession {
  vault: Readonly<ConfiguredVault>;
  signer: AgentWalletSigner;
  payer: Pick<StandardX402Payer, "pay">;
  vaultFlows: VaultFlowClient;
}

/** Selection affects the next tool call; in-flight calls retain their own session. */
export class McpVaultSelection {
  private selectedAddress: string;
  private readonly sessions: ReadonlyMap<string, McpVaultSession>;

  constructor(sessions: readonly McpVaultSession[], defaultVault: string) {
    this.sessions = new Map(sessions.map((session) => [session.vault.address, session]));
    if (this.sessions.size !== sessions.length || !this.sessions.has(defaultVault)) {
      throw new Error("MCP vault sessions must be unique and include the default vault");
    }
    this.selectedAddress = defaultVault;
  }

  current(): McpVaultSession { return this.sessions.get(this.selectedAddress)!; }

  list() {
    return {
      selectedVault: this.selectedAddress,
      vaults: [...this.sessions.values()].map(({ vault }) => vault)
    };
  }

  /** The relayer only confirms support; addresses/mints are always pinned locally. */
  async select(address: string, relayerBaseUrl: string, fetchImpl: typeof fetch = fetch) {
    const session = this.sessions.get(address);
    if (!session) throw new Error("Vault is not in this MCP client's local catalog");
    const response = await fetchImpl(`${relayerBaseUrl.replace(/\/$/, "")}/v1/vaults`, {
      signal: AbortSignal.timeout(10_000)
    });
    if (!response.ok) throw new Error(`Relayer vault list returned ${response.status}`);
    const body = await response.json() as { vaults?: Record<string, unknown>[] };
    const remote = Array.isArray(body.vaults)
      ? body.vaults.find((vault) => vault?.address === address) : undefined;
    if (!remote) throw new Error("Vault is not configured on this relayer");
    for (const field of ["programId", "usdcMint", "shareMint", "farm"] as const) {
      if (remote[field] !== session.vault[field]) {
        throw new Error(`Relayer ${field} differs from the local vault catalog`);
      }
    }
    this.selectedAddress = address;
    return {
      selectedVault: address,
      name: session.vault.name ?? null,
      depositsEnabled: session.vault.depositsEnabled !== false && remote.depositsEnabled !== false,
      instructions: "Subsequent tools use this vault. Existing funds stay in their original vault. Each vault needs its own owner setup and spending limits. Selection lasts until changed or this MCP process restarts."
    };
  }
}
