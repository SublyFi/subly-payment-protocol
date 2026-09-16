#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
const here = dirname(fileURLToPath(import.meta.url));
const TARGETS = {
  mcp: "mcp-server.js", fetch: "pay.js", deposit: "deposit.js", withdraw: "withdraw.js",
  "setup-link": "setup-link.js", "setup-status": "setup-status.js",
  doctor: "doctor.js", budget: "budget.js", vaults: "vaults.js"
};
const HELP = `Subly — x402 payments from Kamino USDC vault yield

Usage: pay <command> [arguments]
  doctor                         Check configuration, relayer and mainnet RPC (no signing)
  vaults                         Print the locally trusted vault catalogue (offline)
  setup-link [options]           Create a human owner approval link
  setup-status <sessionId|URL>   Read setup completion
  deposit <rawUSDC> [approvalId] Deposit into the selected vault (real funds)
  budget                         Refresh and read the selected vault's yield budget
  withdraw <rawUSDC> [approvalId] Withdraw to the agent wallet (real funds)
  fetch <URL>                    Pay a compatible x402 API within the configured cap
  mcp                            Start the stdio MCP server
  --version                      Print package version

Amounts: 1000000 raw USDC = 1 USDC. Requires Node.js 24+.
Set SUBLY_RELAYER_URL, SOLANA_RPC_URL and a wallet signer before use.
Local signer: SUBLY_DEMO_AGENT_KEYPAIR_PATH=/absolute/path/agent.json
Payment cap: SUBLY_MCP_MAX_AMOUNT_RAW_USDC (default 10000 = 0.01 USDC).
Run pay setup-link --help for policy options.
Guide: https://github.com/SublyFi/subly-payment-protocol/tree/main/packages/pay
`;
const [sub, ...rest] = process.argv.slice(2);
if (sub === "--version" || sub === "-v") {
  console.log(JSON.parse(readFileSync(join(here, "..", "package.json"), "utf8")).version);
} else if (!sub || sub === "--help" || sub === "-h" || sub === "help" || rest.includes("--help") || rest.includes("-h")) {
  console.log(HELP);
  if (sub === "setup-link") console.log("Policy options: --initial-deposit <rawUSDC> --approval-threshold <rawUSDC> --per-payment-cap <rawUSDC> --daily-api-cap <rawUSDC> --daily-deposit-cap <rawUSDC> --ttl-days <days>");
} else if (!Object.hasOwn(TARGETS, sub)) {
  console.error(`Unknown command: ${sub}\nRun pay --help.`);
  process.exitCode = 1;
} else {
  process.argv = [process.argv[0], join(here, TARGETS[sub]), ...rest];
  try { await import(`./${TARGETS[sub]}`); }
  catch (error) { console.error(error instanceof Error ? error.message : "Command failed"); process.exitCode = 1; }
}
