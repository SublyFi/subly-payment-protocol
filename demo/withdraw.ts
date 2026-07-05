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
 *   SUBLY_SIGNER_PROVIDER       local (default) | circle | privy;
 *                               credentials per provider — see
 *                               src/client/signer-env.ts
 * Optional env:
 *   SUBLY_RELAYER_URL           Subly relayer API; default https://api.demo.sublyfi.com
 */
import { agentWalletSignerFromEnv } from "../src/client/signer-env.js";
import { VaultFlowClient, VaultFlowClientError } from "../src/client/vault-flows.js";
import { createRpc } from "../src/solana/rpc.js";
import { fail, formatRawUsdc } from "./shared.js";

const relayerBaseUrl =
  process.env.SUBLY_RELAYER_URL ??
  process.env.SUBLY_FACILITATOR_URL ??
  "https://api.demo.sublyfi.com";

const amountRawUsdc = process.argv[2];
if (amountRawUsdc === undefined || !/^[1-9]\d*$/.test(amountRawUsdc)) {
  fail(
    "Usage: pay withdraw <amountRawUsdc> [apr_<approvalId>]  " +
      "(positive integer, e.g. 1000000 = 1 USDC)"
  );
}
// Owner approval id, only needed when the mandate's withdrawalPolicy is
// "owner_approval_required" (a previous run printed the approveUrl).
const approvalId = process.argv[3];
if (approvalId !== undefined && !/^apr_[0-9a-f]+$/i.test(approvalId)) {
  fail(`unrecognized argument: ${approvalId} (expected apr_<approvalId>)`);
}

const { signer } = await agentWalletSignerFromEnv();
const rpc = createRpc(
  process.env.SOLANA_RPC_URL ?? "https://api.mainnet-beta.solana.com"
);
const vaultFlows = new VaultFlowClient({
  relayerBaseUrl,
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
    amountRawUsdc: BigInt(amountRawUsdc),
    ...(approvalId === undefined ? {} : { approvalId })
  });
} catch (error) {
  if (error instanceof VaultFlowClientError) {
    // Owner-approval escalation: not a failure — print the next action so a
    // chat agent can paste the link and retry with the approval id.
    if (error.code === "withdrawal_approval_required") {
      const details = (error.errorDetails ?? {}) as {
        approvalId?: string;
        approveUrl?: string;
        expiresAtMs?: number;
      };
      process.stdout.write(
        `${JSON.stringify(
          {
            ok: false,
            approvalRequired: true,
            approvalId: details.approvalId ?? null,
            approveUrl: details.approveUrl ?? null,
            expiresAtMs: details.expiresAtMs ?? null,
            message:
              "This withdrawal needs the owner's approval. Paste approveUrl " +
              "to the user; once they approve, retry: " +
              `pay withdraw ${amountRawUsdc} ${details.approvalId ?? "<approvalId>"}`
          },
          null,
          2
        )}\n`
      );
      process.exit(1);
    }
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
