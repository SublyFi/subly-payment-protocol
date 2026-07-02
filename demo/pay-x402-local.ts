/**
 * Standard-x402 paid fetch, LOCAL realize path: demonstrates the Subly payment
 * EXPERIENCE end-to-end on mainnet WITHOUT the hosted relayer/postgres. It
 * redeems just enough Kamino vault YIELD (never principal) into the agent's
 * USDC ATA as a sponsor-paid transaction, then pays any standard x402 seller
 * (Nansen is just an example). Uses the local sponsor keypair as fee payer, so
 * the agent still needs no SOL.
 *
 * Usage:
 *   npm run demo:pay-x402-local -- <url> [maxAmountRawUsdc]
 *
 * Required env:
 *   SUBLY_DEMO_AGENT_KEYPAIR_PATH    agent (vault owner) keypair
 *   SUBLY_SPONSOR_KEYPAIR_PATH       sponsor (fee payer) keypair
 *   SOLANA_RPC_URL                   mainnet RPC
 * Optional env:
 *   SUBLY_EXTRA_LOOKUP_TABLES        settlement LUT (keeps the redeem tx < 1232B)
 *   SUBLY_DEMO_PRINCIPAL_BASIS_RAW   principal basis for spendable-yield calc
 *   SUBLY_MCP_MAX_AMOUNT_RAW_USDC    client cap (default 10000 = 0.01 USDC)
 */
import { createX402Client } from "x402-solana/client";
import { LocalSponsorYieldRealizer } from "../src/client/yield-realizer.js";
import {
  StandardX402Payer,
  type StandardX402FetchLike,
  type FetchResponseLike
} from "../src/client/standard-x402-payer.js";
import { createX402WalletAdapter } from "../src/client/web3-wallet-adapter.js";
import { guardedFetchForExpectedRequirement } from "../src/client/standard-x402-factory.js";
import { fileStandardX402StateStore } from "../src/client/standard-x402-state-store.js";
import { SUBLY_VAULT } from "../src/config/constants.js";
import { KaminoVaultAdapter } from "../src/kamino/vault-adapter.js";
import { loadKeyPairSigner, loadSecretKeyBytes } from "../src/solana/keys.js";
import { createRpc } from "../src/solana/rpc.js";
import { TransactionSubmissionEngine } from "../src/solana/submission.js";
import { fail } from "./shared.js";

const url = process.argv[2];
if (url === undefined || !/^https?:\/\//.test(url)) {
  fail("Usage: npm run demo:pay-x402-local -- <url> [maxAmountRawUsdc]");
}
const maxAmountArg = process.argv[3];

const rpcUrl =
  process.env.SOLANA_RPC_URL ?? "https://api.mainnet-beta.solana.com";
const defaultMaxAmountRawUsdc =
  process.env.SUBLY_MCP_MAX_AMOUNT_RAW_USDC === undefined
    ? 10_000n
    : BigInt(process.env.SUBLY_MCP_MAX_AMOUNT_RAW_USDC);
const pendingStatePath =
  process.env.SUBLY_MCP_STATE_PATH ?? "demo/env/standard-x402-local-pending.json";
const principalBasisRawUsdc =
  process.env.SUBLY_DEMO_PRINCIPAL_BASIS_RAW === undefined
    ? 59_545_396n
    : BigInt(process.env.SUBLY_DEMO_PRINCIPAL_BASIS_RAW);

const rpc = createRpc(rpcUrl);
const agent = await loadKeyPairSigner({
  jsonFilePath: process.env.SUBLY_DEMO_AGENT_KEYPAIR_PATH,
  label: "SUBLY_DEMO_AGENT_KEYPAIR"
});
const agentSecretKey = loadSecretKeyBytes({
  jsonFilePath: process.env.SUBLY_DEMO_AGENT_KEYPAIR_PATH,
  label: "SUBLY_DEMO_AGENT_KEYPAIR"
});
const sponsor = await loadKeyPairSigner({
  jsonFilePath: process.env.SUBLY_SPONSOR_KEYPAIR_PATH,
  label: "SUBLY_SPONSOR_KEYPAIR"
});

const extraLookupTables = (process.env.SUBLY_EXTRA_LOOKUP_TABLES ?? "")
  .split(",")
  .map((v) => v.trim())
  .filter((v) => v.length > 0);

const adapter = new KaminoVaultAdapter({
  rpc,
  vaultAddress: SUBLY_VAULT.address,
  ...(extraLookupTables.length === 0 ? {} : { extraLookupTables })
});
const engine = new TransactionSubmissionEngine(rpc);

const realizer = new LocalSponsorYieldRealizer({
  rpc,
  vaultAdapter: adapter,
  engine,
  agent,
  sponsor,
  loadBasis: async () => ({ principalBasisRawUsdc })
});

const wallet = createX402WalletAdapter(agentSecretKey);
const x402Fetch: StandardX402FetchLike = (u, init, expected) => {
  const client = createX402Client({
    wallet,
    network: "solana",
    rpcUrl,
    amount: expected.amountRawUsdc,
    customFetch: guardedFetchForExpectedRequirement(expected)
  });
  return client.fetch(u, init as RequestInit) as Promise<FetchResponseLike>;
};

const payer = new StandardX402Payer({
  realizer,
  x402Fetch,
  defaultMaxAmountRawUsdc,
  stateStore: fileStandardX402StateStore(pendingStatePath)
});

console.error(
  `[pay-x402-local] agent ${agent.address} sponsor ${sponsor.address} -> ${url}`
);
console.error(`[pay-x402-local] basis=${principalBasisRawUsdc} raw`);

// Some x402 sellers deliver the paid resource over POST with a JSON query body
// (Nansen token-screener is one). The payer passes method/body straight through
// to both the probe and the x402-solana payment retry.
const method = process.env.SUBLY_DEMO_METHOD;
const body = process.env.SUBLY_DEMO_BODY;

try {
  const result = await payer.pay({
    url,
    ...(method === undefined ? {} : { method }),
    ...(body === undefined
      ? {}
      : { body, headers: { "content-type": "application/json" } }),
    ...(maxAmountArg === undefined
      ? {}
      : { maxAmountRawUsdc: BigInt(maxAmountArg) }),
    ...(process.env.SUBLY_PAY_FORCE_NEW_PAYMENT === "1"
      ? { forceNewPayment: true }
      : {})
  });
  const preview =
    result.body.length > 600 ? `${result.body.slice(0, 600)}…` : result.body;
  process.stdout.write(
    `${JSON.stringify({ ...result, body: preview }, null, 2)}\n`
  );
  if (!result.paid) {
    process.exit(1);
  }
} catch (error) {
  fail(
    `[pay-x402-local] ${error instanceof Error ? error.message : String(error)}`
  );
}
