/**
 * Demo deposit CLI: moves USDC from the agent wallet into the Subly vault
 * through the Subly relayer prepare/sign/submit flow (VaultFlowClient).
 *
 * Flow: /v1/deposits/prepare -> structured-intent validation + local signing
 * -> /v1/deposits/submit (sponsor co-signs and broadcasts) -> terminal status
 * (polling the reconciling GET endpoint while the tx confirms).
 *
 * Usage:
 *   npm run demo:deposit -- <amountRawUsdc>   (e.g. 60000000 = 60 USDC)
 *
 * Required env:
 *   SOLANA_RPC_URL              RPC for the agent's own lookup-table view
 *                               (optional; defaults to the public mainnet RPC)
 *   SUBLY_DEMO_AGENT_KEYPAIR or SUBLY_DEMO_AGENT_KEYPAIR_PATH
 * Optional env:
 *   SUBLY_RELAYER_URL           Subly relayer API; default https://api.demo.sublyfi.com
 */
import { LocalKeypairAgentWalletSigner } from "../src/client/agent-wallet-signer.js";
import { ensureWalletOnboarded } from "../src/client/onboarding.js";
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
    "Usage: npm run demo:deposit -- <amountRawUsdc>  " +
      "(positive integer, e.g. 60000000 = 60 USDC)"
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

console.log(`[deposit] agent wallet: ${signer.walletAddress}`);
console.log(`[deposit] relayer:  ${relayerBaseUrl}`);
console.log("\n[deposit] step 0: ensure the wallet is registered (self-serve)");
await ensureWalletOnboarded({ facilitatorBaseUrl: relayerBaseUrl, signer });
console.log("[deposit] wallet registered and synced");

console.log(
  `\n[deposit] step 1: deposit ${formatRawUsdc(amountRawUsdc)} USDC ` +
    "(prepare -> validate intent + sign locally -> sponsor submits)"
);
let submitted;
try {
  submitted = await vaultFlows.deposit({ amountRawUsdc: BigInt(amountRawUsdc) });
} catch (error) {
  if (error instanceof VaultFlowClientError) {
    fail(`[deposit] ${error.step} failed: ${error.message}`);
  }
  throw error;
}

console.log(`[deposit] depositId: ${submitted.depositId}`);
console.log(`[deposit] status: ${submitted.status}`);
if (submitted.txSignature !== null) {
  console.log(
    `[deposit] transaction: https://solscan.io/tx/${submitted.txSignature}`
  );
}
if (submitted.status === "submitted") {
  fail(
    "[deposit] broadcast but not yet confirmed — it may still land. Do NOT " +
      `resubmit; check GET /v1/deposits/${submitted.depositId} (or the tx link above) first`
  );
}
if (submitted.status !== "confirmed") {
  fail(
    `[deposit] not confirmed (errorCode=${submitted.errorCode}); ` +
      `check GET /v1/deposits/${submitted.depositId} and the relayer logs`
  );
}
console.log(
  `[deposit] confirmed: ${formatRawUsdc(submitted.actualDepositRawUsdc ?? "0")} USDC ` +
    `deposited, ${submitted.sharesMintedRaw ?? "0"} raw shares minted`
);
