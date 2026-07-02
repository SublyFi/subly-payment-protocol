/**
 * Subly MCP server (published @subly_fi/pay build). Same tool surface as the
 * repo demo, but the x402 payment is built by the OFFICIAL x402 Foundation
 * Solana client (@x402/svm + @x402/fetch, kit v5) instead of PayAI's
 * x402-solana — so off-curve (PDA) seller payTo addresses are handled correctly.
 * The realize (Kamino vault yield -> agent USDC ATA) still runs through the
 * Subly relayer, so the agent needs only its own key and no SOL.
 *
 * Env: same as the repo demo (SUBLY_DEMO_AGENT_KEYPAIR[_PATH],
 * SUBLY_RELAYER_URL as the Subly relayer API, SOLANA_RPC_URL,
 * SUBLY_MCP_MAX_AMOUNT_RAW_USDC).
 */
import { homedir } from "node:os";
import { join } from "node:path";
import { LocalKeypairAgentWalletSigner } from "../../../src/client/agent-wallet-signer.js";
import { runMcpPaymentServer } from "../../../src/client/mcp-payment-server.js";
import { createRelayerX402Payer } from "../../../src/client/relayer-payer.js";
import { fileStandardX402StateStore } from "../../../src/client/standard-x402-state-store.js";
import { loadKeyPairSigner, loadSecretKeyBytes } from "../../../src/solana/keys.js";
import { createRpc } from "../../../src/solana/rpc.js";
import { createSvmX402Fetch } from "./svm-x402-fetch.js";

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

await runMcpPaymentServer({
  payer,
  signer,
  facilitatorBaseUrl: relayerBaseUrl,
  defaultMaxAmountRawUsdc
});
