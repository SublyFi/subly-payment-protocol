/**
 * Standard-x402 paid fetch CLI: GET/POST any x402-compatible paid API (Nansen
 * via PayAI, etc.) paying from Kamino vault YIELD. The seller needs NO Subly
 * integration — Subly realizes yield to the agent's USDC ATA (sponsored by the
 * relayer) and then pays the seller's standard x402 `exact` challenge.
 *
 * Usage:
 *   npm run demo:pay-x402 -- <url> [maxAmountRawUsdc]
 *   # e.g. https://api.nansen.ai/api/v1/token-screener  (0.01 USDC)
 *
 * Required env:
 *   SUBLY_DEMO_AGENT_KEYPAIR or SUBLY_DEMO_AGENT_KEYPAIR_PATH
 * Optional env:
 *   SUBLY_FACILITATOR_URL   default https://api.demo.sublyfi.com (realize relayer)
 *   SOLANA_RPC_URL          default the public mainnet RPC
 *   SUBLY_MCP_MAX_AMOUNT_RAW_USDC  default per-call cap (10000 = 0.01 USDC)
 */
import { LocalKeypairAgentWalletSigner } from "../src/client/agent-wallet-signer.js";
import { ensureWalletOnboarded } from "../src/client/onboarding.js";
import { createStandardX402Payer } from "../src/client/standard-x402-factory.js";
import { StandardX402PayError } from "../src/client/standard-x402-payer.js";
import { loadKeyPairSigner, loadSecretKeyBytes } from "../src/solana/keys.js";
import { createRpc } from "../src/solana/rpc.js";
import { fail } from "./shared.js";

const url = process.argv[2];
if (url === undefined || !/^https?:\/\//.test(url)) {
  fail("Usage: npm run demo:pay-x402 -- <url> [maxAmountRawUsdc]");
}
const maxAmountArg = process.argv[3];

const facilitatorBaseUrl =
  process.env.SUBLY_FACILITATOR_URL ?? "https://api.demo.sublyfi.com";
const rpcUrl =
  process.env.SOLANA_RPC_URL ?? "https://api.mainnet-beta.solana.com";
const defaultMaxAmountRawUsdc =
  process.env.SUBLY_MCP_MAX_AMOUNT_RAW_USDC === undefined
    ? 10_000n
    : BigInt(process.env.SUBLY_MCP_MAX_AMOUNT_RAW_USDC);

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

// Demo/experience mode: realize the full price from vault yield every call so
// each payment is a visible Kamino redeem, instead of reusing leftover ATA
// balance. Set SUBLY_DEMO_FORCE_REALIZE=1 to focus on the Subly flow.
const forceRealizeFullAmount = process.env.SUBLY_DEMO_FORCE_REALIZE === "1";

const payer = createStandardX402Payer({
  facilitatorBaseUrl,
  signer,
  agentSecretKey,
  rpc,
  rpcUrl,
  defaultMaxAmountRawUsdc,
  forceRealizeFullAmount
});

console.error(`[pay-x402] agent ${signer.walletAddress} -> ${url}`);
try {
  await ensureWalletOnboarded({ facilitatorBaseUrl, signer });
} catch (error) {
  console.error(
    `[pay-x402] onboarding skipped: ${
      error instanceof Error ? error.message : String(error)
    }`
  );
}

try {
  const result = await payer.pay({
    url,
    ...(maxAmountArg === undefined
      ? {}
      : { maxAmountRawUsdc: BigInt(maxAmountArg) })
  });
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  if (!result.paid) {
    process.exit(1);
  }
} catch (error) {
  if (error instanceof StandardX402PayError) {
    process.stdout.write(
      `${JSON.stringify(
        { paid: false, reason: error.reason, message: error.message, detail: error.detail },
        null,
        2
      )}\n`
    );
    process.exit(1);
  }
  fail(`[pay-x402] ${error instanceof Error ? error.message : String(error)}`);
}
