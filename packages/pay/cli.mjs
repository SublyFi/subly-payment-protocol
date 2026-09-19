#!/usr/bin/env node
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
const here = dirname(fileURLToPath(import.meta.url));
const manifest = existsSync(join(here, "package.json")) ? join(here, "package.json") : join(here, "..", "package.json");
const version = JSON.parse(readFileSync(manifest, "utf8")).version;
const command = `npx -y @subly_fi/pay@${version}`;
const TARGETS = {
  mcp: "mcp-server.js", fetch: "pay.js", deposit: "deposit.js", withdraw: "withdraw.js",
  "setup-link": "setup-link.js", "setup-status": "setup-status.js",
  "owner-link": "owner.js", "owner-status": "owner.js",
  "recovery-start": "owner.js", "recovery-status": "owner.js",
  doctor: "doctor.js", budget: "budget.js", vaults: "vaults.js", status: "status.js"
};
const HELP = `Subly — x402 payments from Kamino USDC vault yield

Usage: ${command} <command> [arguments]
  doctor                         Check configuration, relayer and mainnet RPC (no signing)
  vaults                         Print the locally trusted vault catalogue (offline)
  setup-link [options]           Create a human owner approval link
  setup-status <sessionId|URL>   Read setup completion
  owner-link [options]           Review policy, reactivate, revoke or cancel recovery with the current owner
  owner-status <sessionId>       Read owner management completion
  recovery-start                 Start lost-owner recovery (72-hour wait; owner can cancel)
  recovery-status                Read current owner policy and recovery status
  deposit <rawUSDC> [approvalId] Deposit into the selected vault (real funds)
  budget                         Refresh and read the selected vault's yield budget
  withdraw <rawUSDC> [approvalId] Withdraw to the agent wallet (real funds)
  status <dep_...|wdr_...>        Check the original deposit/withdrawal (no new transaction)
  fetch <URL>                    Pay a compatible x402 API within the configured cap
  mcp                            Start the stdio MCP server
  --version                      Print package version

Amounts: 1000000 raw USDC = 1 USDC. Requires Node.js 24+.
Set SUBLY_RELAYER_URL, SOLANA_RPC_URL and a wallet signer before use.
Local signer: SUBLY_DEMO_AGENT_KEYPAIR_PATH=/absolute/path/agent.json
Payment cap: SUBLY_MCP_MAX_AMOUNT_RAW_USDC (default 10000 = 0.01 USDC).
Run ${command} setup-link --help for policy options.
Guide: https://github.com/SublyFi/subly-payment-protocol/tree/main/packages/pay
`;
const [sub, ...rest] = process.argv.slice(2);
if (sub === "--version" || sub === "-v") {
  console.log(version);
} else if (!sub || sub === "--help" || sub === "-h" || sub === "help" || rest.includes("--help") || rest.includes("-h")) {
  console.log(HELP);
  if (sub === "setup-link") console.log("Policy options: --initial-deposit <rawUSDC> --approval-threshold <rawUSDC> --per-payment-cap <rawUSDC> --daily-api-cap <rawUSDC> --daily-deposit-cap <rawUSDC> --ttl-days <days>");
  if (sub === "owner-link") console.log("Policy options (omitted values are preserved): --approval-threshold <rawUSDC|none> --per-payment-cap <rawUSDC> --daily-api-cap <rawUSDC|none> --monthly-api-cap <rawUSDC|none> --daily-deposit-cap <rawUSDC|none> --allowed-payees <address,address|any> --deposit-policy <agent_allowed|owner_approval_required> --withdrawal-policy <agent_allowed|owner_approval_required> --ttl-days <days>. Threshold 0 requires approval for every payment; none disables that check and any removes the payee restriction. The owner reviews every proposal.");
} else if (!Object.hasOwn(TARGETS, sub)) {
  console.error(`Unknown command: ${sub}\nRun ${command} --help.`);
  process.exitCode = 1;
} else {
  process.argv = [process.argv[0], join(here, TARGETS[sub]), ...(TARGETS[sub] === "owner.js" ? [sub] : []), ...rest];
  try { await import(`./${TARGETS[sub]}`); }
  catch (error) { console.error(error instanceof Error ? error.message : "Command failed"); process.exitCode = 1; }
}
