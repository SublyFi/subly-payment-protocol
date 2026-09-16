import { accessSync, constants } from "node:fs";
import { vaultCatalogFromEnv, defaultCatalogVault } from "../../../src/config/vault-catalog.js";
type Check = { name: string; ok: boolean; message: string };
const checks: Check[] = [];
async function check(name: string, action: () => string | Promise<string>) {
  try { checks.push({ name, ok: true, message: await action() }); }
  catch (error) { checks.push({ name, ok: false, message: error instanceof Error ? error.message : "Check failed" }); }
}
const env = process.env;
await check("node", () => { if (Number(process.versions.node.split(".")[0]) < 24) throw new Error("Install Node.js 24 or later"); return process.versions.node; });
await check("signer configuration", () => {
  const provider = env.SUBLY_SIGNER_PROVIDER?.trim().toLowerCase() || "local";
  if (provider === "local") {
    if (env.SUBLY_DEMO_AGENT_KEYPAIR) return "Base58 key configured (contents not inspected)";
    if (!env.SUBLY_DEMO_AGENT_KEYPAIR_PATH) throw new Error("Set SUBLY_DEMO_AGENT_KEYPAIR_PATH to an agent keypair JSON file");
    try { accessSync(env.SUBLY_DEMO_AGENT_KEYPAIR_PATH, constants.R_OK); } catch { throw new Error("Agent keypair file is not readable"); }
    return "Agent keypair file readable (contents not inspected)";
  }
  const required = provider === "circle" ? ["CIRCLE_API_KEY", "CIRCLE_ENTITY_SECRET", "CIRCLE_WALLET_ID"] : provider === "privy" ? ["PRIVY_APP_ID", "PRIVY_APP_SECRET", "PRIVY_WALLET_ID"] : null;
  if (!required) throw new Error("SUBLY_SIGNER_PROVIDER must be local, circle or privy");
  const missing = required.filter(key => !(env[`SUBLY_${key}`] || env[key]));
  if (missing.length) throw new Error(`Missing ${missing.join(", ")}`);
  return `${provider} credentials configured (provider not contacted)`;
});
await check("relayer and vault", async () => {
  if (!env.SUBLY_RELAYER_URL) throw new Error("Set SUBLY_RELAYER_URL to your chosen operator's URL");
  const url = new URL(env.SUBLY_RELAYER_URL);
  if (url.protocol !== "https:" && !(url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname))) throw new Error("Use HTTPS (HTTP is allowed only for local development)");
  const catalog = vaultCatalogFromEnv(); const local = defaultCatalogVault(catalog);
  const health = await fetch(`${url.toString().replace(/\/$/, "")}/healthz`, { signal: AbortSignal.timeout(10000) });
  if (!health.ok || (await health.json() as {ok?:boolean}).ok !== true) throw new Error("Relayer health check failed");
  const response = await fetch(`${url.toString().replace(/\/$/, "")}/v1/vaults`, { signal: AbortSignal.timeout(10000) });
  if (!response.ok) throw new Error("Relayer vault catalogue unavailable");
  const remote = (await response.json() as {vaults?: Record<string, unknown>[]}).vaults?.find(v => v.address === local.address);
  if (!remote || ["programId", "usdcMint", "shareMint", "farm"].some(key => remote[key] !== local[key as keyof typeof local])) throw new Error("Selected local vault trust anchors differ from the relayer; review the operator catalogue before changing configuration");
  return `Healthy; selected vault ${local.address} matches local trust anchors`;
});
await check("Solana RPC", async () => {
  const response = await fetch(env.SOLANA_RPC_URL ?? "https://api.mainnet-beta.solana.com", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({jsonrpc:"2.0",id:1,method:"getGenesisHash"}), signal: AbortSignal.timeout(10000) });
  const body = await response.json() as {result?:string};
  if (!response.ok || body.result !== "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp") throw new Error("RPC is unavailable or is not Solana mainnet-beta");
  return "Mainnet-beta RPC reachable";
});
const ok = checks.every(c => c.ok);
console.log(JSON.stringify({ok, checks, note:"Read-only diagnostics. No key was loaded, signature produced, or transaction sent. This does not verify balances, vault safety or transaction simulation support."}, null, 2));
if (!ok) process.exitCode = 1;
