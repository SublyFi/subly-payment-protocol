/**
 * Demo deposit CLI: moves USDC from the agent wallet into the Subly vault
 * through the Subly relayer prepare/sign/submit flow.
 *
 * Flow: /v1/deposits/prepare -> structured-intent validation + local signing
 * -> /v1/deposits/submit (sponsor co-signs and broadcasts) -> terminal status.
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
import { walletAuthHeaders } from "../src/client/wallet-auth-headers.js";
import { fetchLookupTablesForTransaction } from "../src/client/lookup-tables.js";
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

async function postJson(path: string, body: unknown): Promise<unknown> {
  const url = `${relayerBaseUrl}${path}`;
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
    fail(`[deposit] ${path} failed with ${response.status}: ${text}`);
  }
  return JSON.parse(text);
}

console.log(`[deposit] agent wallet: ${signer.walletAddress}`);
console.log(`[deposit] relayer:  ${relayerBaseUrl}`);
console.log("\n[deposit] step 0: ensure the wallet is registered (self-serve)");
await ensureWalletOnboarded({ facilitatorBaseUrl: relayerBaseUrl, signer });
console.log("[deposit] wallet registered and synced");

console.log(
  `\n[deposit] step 1: prepare deposit of ${formatRawUsdc(amountRawUsdc)} USDC`
);
const prepared = (await postJson("/v1/deposits/prepare", {
  wallet: signer.walletAddress,
  amountRawUsdc
})) as {
  depositId: string;
  serializedTransaction: string;
  signingIntent: Parameters<typeof signer.signDeposit>[0]["intent"];
};
console.log(`[deposit] prepared (depositId=${prepared.depositId})`);

console.log(
  "\n[deposit] step 2: validate the signing intent against the transaction, sign locally"
);
const signed = await signer.signDeposit({
  intent: prepared.signingIntent,
  serializedTransaction: prepared.serializedTransaction,
  lookupTables: await fetchLookupTablesForTransaction(
    rpc,
    prepared.serializedTransaction
  )
});
console.log("[deposit] agent signature attached");

console.log("\n[deposit] step 3: submit (sponsor co-signs and broadcasts)");
const submitted = (await postJson("/v1/deposits/submit", {
  depositId: prepared.depositId,
  serializedTransaction: signed.serializedTransaction,
  agentSignature: signed.agentSignature
})) as {
  status: string;
  txSignature: string | null;
  actualDepositRawUsdc: string | null;
  sharesMintedRaw: string | null;
  errorCode: string | null;
};

console.log(`[deposit] status: ${submitted.status}`);
if (submitted.txSignature !== null) {
  console.log(
    `[deposit] transaction: https://solscan.io/tx/${submitted.txSignature}`
  );
}
if (submitted.status !== "confirmed") {
  fail(
    `[deposit] not confirmed (errorCode=${submitted.errorCode}); ` +
      `check GET /v1/deposits/${prepared.depositId} and the relayer logs`
  );
}
console.log(
  `[deposit] confirmed: ${formatRawUsdc(submitted.actualDepositRawUsdc ?? "0")} USDC ` +
    `deposited, ${submitted.sharesMintedRaw ?? "0"} raw shares minted`
);
