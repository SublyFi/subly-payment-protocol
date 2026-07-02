/**
 * Demo withdraw CLI: moves USDC from the Subly vault back to the agent
 * wallet's USDC ATA through the Subly relayer prepare/sign/submit flow
 * (VaultFlowClient; instant-only normal withdraw; the beta exit path).
 *
 * Flow: /v1/withdrawals/prepare -> structured-intent validation + local
 * signing -> /v1/withdrawals/submit (sponsor co-signs and broadcasts)
 * -> terminal status (polling the reconciling GET endpoint).
 *
 * Usage:
 *   npm run demo:withdraw -- <amountRawUsdc>   (e.g. 1000000 = 1 USDC)
 *
 * Required env:
 *   SOLANA_RPC_URL              RPC for the agent's own lookup-table view
 *                               (optional; defaults to the public mainnet RPC)
 *   SUBLY_DEMO_AGENT_KEYPAIR or SUBLY_DEMO_AGENT_KEYPAIR_PATH
 * Optional env:
 *   SUBLY_RELAYER_URL           Subly relayer API; default https://api.demo.sublyfi.com
 */
import { LocalKeypairAgentWalletSigner } from "../src/client/agent-wallet-signer.js";
import { VaultFlowClient, VaultFlowClientError } from "../src/client/vault-flows.js";
import { loadKeyPairSigner } from "../src/solana/keys.js";
import { createRpc } from "../src/solana/rpc.js";
import { fail, formatRawUsdc } from "./shared.js";

const relayerBaseUrl =
  process.env.SUBLY_RELAYER_URL ??
  process.env.SUBLY_FACILITATOR_URL ??
  "https://api.demo.sublyfi.com";

const amountRawUsdc = process.argv[2];
if (amountRawUsdc === undefined || !/^[1-9]\d*$/.test(amountRawUsdc)) {
  fail(
    "Usage: npm run demo:withdraw -- <amountRawUsdc>  " +
      "(positive integer, e.g. 1000000 = 1 USDC)"
  );
}

const keyPairSigner = await loadKeyPairSigner({
  base58Secret: process.env.SUBLY_DEMO_AGENT_KEYPAIR,
  jsonFilePath: process.env.SUBLY_DEMO_AGENT_KEYPAIR_PATH,
  label: "SUBLY_DEMO_AGENT_KEYPAIR"
});
const signer = new LocalKeypairAgentWalletSigner(keyPairSigner);
const rpc = createRpc(
  process.env.SOLANA_RPC_URL ?? "https://api.mainnet-beta.solana.com"
);
const vaultFlows = new VaultFlowClient({
  facilitatorBaseUrl: relayerBaseUrl,
  signer,
  rpc
});

console.log(`[withdraw] agent wallet: ${signer.walletAddress}`);
console.log(`[withdraw] relayer:  ${relayerBaseUrl}`);
console.log(
  `\n[withdraw] step 1: withdraw ${formatRawUsdc(amountRawUsdc)} USDC ` +
    "(prepare -> validate intent + sign locally -> sponsor submits)"
);
let submitted;
try {
  submitted = await vaultFlows.withdraw({
    amountRawUsdc: BigInt(amountRawUsdc)
  });
} catch (error) {
  if (error instanceof VaultFlowClientError) {
    fail(`[withdraw] ${error.step} failed: ${error.message}`);
  }
  throw error;
}

console.log(`[withdraw] withdrawalId: ${submitted.withdrawalId}`);
console.log(`[withdraw] status: ${submitted.status}`);
console.log(`[withdraw] destination USDC ATA: ${submitted.destinationUsdcAta}`);
if (submitted.txSignature !== null) {
  console.log(
    `[withdraw] transaction: https://solscan.io/tx/${submitted.txSignature}`
  );
}
if (submitted.status === "submitted") {
  fail(
    "[withdraw] broadcast but not yet confirmed — it may still land. Do NOT " +
      `resubmit; check GET /v1/withdrawals/${submitted.withdrawalId} (or the tx link above) first`
  );
}
if (submitted.status !== "confirmed") {
  fail(
    `[withdraw] not confirmed (errorCode=${submitted.errorCode}); ` +
      `check GET /v1/withdrawals/${submitted.withdrawalId} and the relayer logs`
  );
}
console.log(
  `[withdraw] confirmed: ${formatRawUsdc(submitted.actualWithdrawRawUsdc ?? "0")} USDC ` +
    `withdrawn (${submitted.actualSharesBurnedRaw ?? "0"} raw shares burned)`
);
