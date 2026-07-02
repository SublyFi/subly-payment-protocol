/**
 * Subly MCP server (repo demo build): exposes the buyer-side x402 flow as one
 * MCP tool so an agent can pay ANY standard x402-compatible paid API from its
 * Kamino vault yield in a single tool call. Payment uses PayAI's x402-solana
 * (kit v2). The published @subly_fi/pay package ships the same tool built on the
 * official @x402/svm client (see packages/pay/src/mcp-server.ts); both reuse
 * runMcpPaymentServer.
 *
 * Env:
 *   SUBLY_DEMO_AGENT_KEYPAIR or SUBLY_DEMO_AGENT_KEYPAIR_PATH   (required)
 *   SUBLY_RELAYER_URL       Subly relayer API; default https://api.demo.sublyfi.com
 *   SOLANA_RPC_URL          default public mainnet RPC
 *   SUBLY_MCP_MAX_AMOUNT_RAW_USDC   default per-call cap (10000 = 0.01 USDC)
 */
import { LocalKeypairAgentWalletSigner } from "../src/client/agent-wallet-signer.js";
import { runMcpPaymentServer } from "../src/client/mcp-payment-server.js";
import { createStandardX402Payer } from "../src/client/standard-x402-factory.js";
import { fileStandardX402StateStore } from "../src/client/standard-x402-state-store.js";
import { VaultFlowClient } from "../src/client/vault-flows.js";
import { loadKeyPairSigner, loadSecretKeyBytes } from "../src/solana/keys.js";
import { createRpc } from "../src/solana/rpc.js";

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
  process.env.SUBLY_MCP_STATE_PATH ?? "demo/env/standard-x402-pending.json";

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

const payer = createStandardX402Payer({
  facilitatorBaseUrl: relayerBaseUrl,
  signer,
  agentSecretKey,
  rpc,
  rpcUrl,
  defaultMaxAmountRawUsdc,
  stateStore: fileStandardX402StateStore(pendingStatePath)
});

await runMcpPaymentServer({
  payer,
  signer,
  facilitatorBaseUrl: relayerBaseUrl,
  defaultMaxAmountRawUsdc,
  vaultFlows: new VaultFlowClient({
    facilitatorBaseUrl: relayerBaseUrl,
    signer,
    rpc
  })
});
