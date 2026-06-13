/**
 * Demo withdraw CLI: moves USDC from the Subly vault back to the agent
 * wallet's USDC ATA through the facilitator's prepare/sign/submit flow
 * (instant-only normal withdraw; the beta exit path).
 *
 * Flow: /v1/withdrawals/prepare -> structured-intent validation + local
 * signing -> /v1/withdrawals/submit (sponsor co-signs and broadcasts).
 *
 * Usage:
 *   npm run demo:withdraw -- <amountRawUsdc>   (e.g. 1000000 = 1 USDC)
 *
 * Required env:
 *   SOLANA_RPC_URL              RPC for the agent's own lookup-table view
 *                               (optional; defaults to the public mainnet RPC)
 *   SUBLY_DEMO_AGENT_KEYPAIR or SUBLY_DEMO_AGENT_KEYPAIR_PATH
 * Optional env:
 *   SUBLY_FACILITATOR_URL       default http://localhost:3000
 */
import { LocalKeypairAgentWalletSigner } from "../src/client/agent-wallet-signer.js";
import { walletAuthHeaders } from "../src/client/wallet-auth-headers.js";
import { fetchLookupTablesForTransaction } from "../src/client/lookup-tables.js";
import { loadKeyPairSigner } from "../src/solana/keys.js";
import { createRpc } from "../src/solana/rpc.js";
import { fail, formatRawUsdc } from "./shared.js";

const facilitatorBaseUrl =
  process.env.SUBLY_FACILITATOR_URL ?? "https://api.demo.sublyfi.com";

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

async function postJson(path: string, body: unknown): Promise<unknown> {
  const url = `${facilitatorBaseUrl}${path}`;
  const serialized = JSON.stringify(body);
  const response = await fetch(url, {
    method: "POST",
    headers: {
      ...(await walletAuthHeaders({
        signer,
        method: "POST",
        url,
        body: serialized
      })),
      "content-type": "application/json"
    },
    body: serialized
  });
  const text = await response.text();
  if (response.status !== 200) {
    fail(`[withdraw] ${path} failed with ${response.status}: ${text}`);
  }
  return JSON.parse(text);
}

console.log(`[withdraw] agent wallet: ${signer.walletAddress}`);
console.log(`[withdraw] facilitator:  ${facilitatorBaseUrl}`);
console.log(
  `\n[withdraw] step 1: prepare withdraw of ${formatRawUsdc(amountRawUsdc)} USDC`
);
const prepared = (await postJson("/v1/withdrawals/prepare", {
  wallet: signer.walletAddress,
  amountRawUsdc
})) as {
  withdrawalId: string;
  serializedTransaction: string;
  destinationUsdcAta: string;
  signingIntent: Parameters<typeof signer.signWithdrawal>[0]["intent"];
};
console.log(`[withdraw] prepared (withdrawalId=${prepared.withdrawalId})`);
console.log(`[withdraw] destination USDC ATA: ${prepared.destinationUsdcAta}`);

console.log(
  "\n[withdraw] step 2: validate the signing intent against the transaction, sign locally"
);
const signed = await signer.signWithdrawal({
  intent: prepared.signingIntent,
  serializedTransaction: prepared.serializedTransaction,
  lookupTables: await fetchLookupTablesForTransaction(
    rpc,
    prepared.serializedTransaction
  )
});
console.log("[withdraw] agent signature attached");

console.log("\n[withdraw] step 3: submit (sponsor co-signs and broadcasts)");
const submitted = (await postJson("/v1/withdrawals/submit", {
  withdrawalId: prepared.withdrawalId,
  serializedTransaction: signed.serializedTransaction,
  agentSignature: signed.agentSignature
})) as {
  status: string;
  txSignature: string | null;
  actualWithdrawRawUsdc: string | null;
  actualSharesBurnedRaw: string | null;
  errorCode: string | null;
};

console.log(`[withdraw] status: ${submitted.status}`);
if (submitted.txSignature !== null) {
  console.log(
    `[withdraw] transaction: https://solscan.io/tx/${submitted.txSignature}`
  );
}
if (submitted.status !== "confirmed") {
  fail(
    `[withdraw] not confirmed (errorCode=${submitted.errorCode}); ` +
      `check GET /v1/withdrawals/${prepared.withdrawalId} and the facilitator logs`
  );
}
console.log(
  `[withdraw] confirmed: ${formatRawUsdc(submitted.actualWithdrawRawUsdc ?? "0")} USDC ` +
    `withdrawn (${submitted.actualSharesBurnedRaw ?? "0"} raw shares burned)`
);
