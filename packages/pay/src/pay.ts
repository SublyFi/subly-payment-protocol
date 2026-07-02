/**
 * One-shot standard-x402 pay CLI for the published @subly_fi/pay package.
 * GET/POST any x402-compatible paid API, paying from the agent wallet's Kamino
 * vault yield via the Subly relayer. Payment uses the official @x402/svm client.
 *
 * Usage:
 *   pay fetch <url> [maxAmountRawUsdc]
 * Env:
 *   SUBLY_DEMO_AGENT_KEYPAIR or SUBLY_DEMO_AGENT_KEYPAIR_PATH   (required)
 *   SUBLY_RELAYER_URL       Subly relayer API; default https://api.demo.sublyfi.com
 *   SOLANA_RPC_URL          default public mainnet RPC
 *   SUBLY_MCP_MAX_AMOUNT_RAW_USDC   default cap (10000 = 0.01 USDC)
 *   SUBLY_PAY_METHOD / SUBLY_PAY_BODY   for POST-body sellers
 */
import { homedir } from "node:os";
import { join } from "node:path";
import { LocalKeypairAgentWalletSigner } from "../../../src/client/agent-wallet-signer.js";
import { ensureWalletOnboarded } from "../../../src/client/onboarding.js";
import { createRelayerX402Payer } from "../../../src/client/relayer-payer.js";
import { StandardX402PayError } from "../../../src/client/standard-x402-payer.js";
import { fileStandardX402StateStore } from "../../../src/client/standard-x402-state-store.js";
import { loadKeyPairSigner, loadSecretKeyBytes } from "../../../src/solana/keys.js";
import { createRpc } from "../../../src/solana/rpc.js";
import { createSvmX402Fetch } from "./svm-x402-fetch.js";

function fail(message: string): never {
  process.stderr.write(`${message}\n`);
  process.exit(1);
}

const url = process.argv[2];
if (url === undefined || !/^https?:\/\//.test(url)) {
  fail("Usage: pay fetch <url> [maxAmountRawUsdc]");
}
const maxAmountArg = process.argv[3];

const relayerBaseUrl =
  process.env.SUBLY_RELAYER_URL ??
  process.env.SUBLY_FACILITATOR_URL ??
  "https://api.demo.sublyfi.com";
const rpcUrl =
  process.env.SOLANA_RPC_URL ?? "https://api.mainnet-beta.solana.com";
const defaultMaxAmountRawUsdc =
  process.env.SUBLY_MCP_MAX_AMOUNT_RAW_USDC === undefined
    ? 10_000n
    : BigInt(process.env.SUBLY_MCP_MAX_AMOUNT_RAW_USDC);
const pendingStatePath =
  process.env.SUBLY_MCP_STATE_PATH ??
  join(homedir(), ".subly", "standard-x402-pending.json");

const keyPairSigner = await loadKeyPairSigner({
  base58Secret: process.env.SUBLY_DEMO_AGENT_KEYPAIR,
  jsonFilePath: process.env.SUBLY_DEMO_AGENT_KEYPAIR_PATH,
  label: "SUBLY_DEMO_AGENT_KEYPAIR"
});
const agentSecretKey = loadSecretKeyBytes({
  base58Secret: process.env.SUBLY_DEMO_AGENT_KEYPAIR,
  jsonFilePath: process.env.SUBLY_DEMO_AGENT_KEYPAIR_PATH,
  label: "SUBLY_DEMO_AGENT_KEYPAIR"
});
const signer = new LocalKeypairAgentWalletSigner(keyPairSigner);
const rpc = createRpc(rpcUrl);

const payer = createRelayerX402Payer({
  facilitatorBaseUrl: relayerBaseUrl,
  signer,
  rpc,
  x402Fetch: await createSvmX402Fetch({ agentSecretKey, rpcUrl }),
  defaultMaxAmountRawUsdc,
  stateStore: fileStandardX402StateStore(pendingStatePath)
});

const method = process.env.SUBLY_PAY_METHOD;
const body = process.env.SUBLY_PAY_BODY;

console.error(`[pay] agent ${signer.walletAddress} -> ${url}`);
try {
  await ensureWalletOnboarded({ facilitatorBaseUrl: relayerBaseUrl, signer });
} catch (error) {
  console.error(
    `[pay] onboarding skipped: ${
      error instanceof Error ? error.message : String(error)
    }`
  );
}

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
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  if (!result.paid) {
    process.exit(1);
  }
} catch (error) {
  if (error instanceof StandardX402PayError) {
    process.stdout.write(
      `${JSON.stringify(
        { paid: false, reason: error.reason, message: error.message },
        null,
        2
      )}\n`
    );
    process.exit(1);
  }
  fail(`[pay] ${error instanceof Error ? error.message : String(error)}`);
}
