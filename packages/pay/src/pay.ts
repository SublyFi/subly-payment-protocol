/**
 * One-shot standard-x402 pay CLI for the published @subly_fi/pay package.
 * GET/POST a compatible x402 paid API, paying from the agent wallet's Kamino
 * vault yield via the Subly relayer. Payment uses the official @x402/svm client
 * and currently requires a Solana USDC exact rail with facilitator feePayer.
 *
 * Usage:
 *   pay fetch <url> [maxAmountRawUsdc]
 * Env:
 *   SUBLY_SIGNER_PROVIDER   local (default) | circle | privy; credentials
 *                           per provider — see src/client/signer-env.ts
 *   SUBLY_RELAYER_URL       Subly relayer API; default https://api.demo.sublyfi.com
 *   SOLANA_RPC_URL          default public mainnet RPC
 *   SUBLY_MCP_MAX_AMOUNT_RAW_USDC   default cap (10000 = 0.01 USDC)
 *   SUBLY_PAY_METHOD / SUBLY_PAY_BODY   for POST-body sellers
 */
import { homedir } from "node:os";
import { join } from "node:path";
import { ensureWalletOnboarded } from "../../../src/client/onboarding.js";
import { createRelayerX402Payer } from "../../../src/client/relayer-payer.js";
import { agentWalletSignerFromEnv } from "../../../src/client/signer-env.js";
import { StandardX402PayError } from "../../../src/client/standard-x402-payer.js";
import { fileStandardX402StateStore } from "../../../src/client/standard-x402-state-store.js";
import { createRpc } from "../../../src/solana/rpc.js";
import { svmTransactionSignerFromBundle } from "./svm-signer.js";
import { createSvmX402Fetch } from "./svm-x402-fetch.js";

function fail(message: string): never {
  process.stderr.write(`${message}\n`);
  process.exit(1);
}

const url = process.argv[2];
if (url === undefined || !/^https?:\/\//.test(url)) {
  fail("Usage: pay fetch <url> [maxAmountRawUsdc] [apr_<approvalId>]");
}
// Trailing args in any order: digits = client cap, apr_... = the owner
// approval from a previous approval_required refusal (retry the SAME url).
let maxAmountArg: string | undefined;
let approvalId: string | undefined;
for (const arg of process.argv.slice(3)) {
  if (/^apr_[0-9a-f]+$/i.test(arg)) {
    approvalId = arg;
  } else if (/^\d+$/.test(arg)) {
    maxAmountArg = arg;
  } else {
    fail(`unrecognized argument: ${arg}\nUsage: pay fetch <url> [maxAmountRawUsdc] [apr_<approvalId>]`);
  }
}

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

const bundle = await agentWalletSignerFromEnv();
const signer = bundle.signer;
const rpc = createRpc(rpcUrl);

const payer = createRelayerX402Payer({
  relayerBaseUrl,
  signer,
  rpc,
  x402Fetch: await createSvmX402Fetch({
    signer: await svmTransactionSignerFromBundle(bundle),
    rpcUrl
  }),
  defaultMaxAmountRawUsdc,
  stateStore: fileStandardX402StateStore(pendingStatePath)
});

const method = process.env.SUBLY_PAY_METHOD;
const body = process.env.SUBLY_PAY_BODY;

console.error(`[pay] agent ${signer.walletAddress} -> ${url}`);
try {
  await ensureWalletOnboarded({ relayerBaseUrl, signer });
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
    ...(approvalId === undefined ? {} : { approvalId }),
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
    // detail carries the next step on approval_required refusals
    // (approvalId / approveUrl / expiresAtMs): paste approveUrl to the
    // owner, then rerun the printed retry command. It must repeat the SAME
    // client cap — approval-needing prices exceed the default cap, so
    // dropping it would refuse with amount_exceeds_client_cap instead.
    const refusalApprovalId =
      error.reason === "approval_required"
        ? (error.detail as { approvalId?: string } | null)?.approvalId
        : undefined;
    process.stdout.write(
      `${JSON.stringify(
        {
          paid: false,
          reason: error.reason,
          message: error.message,
          detail: error.detail ?? null,
          ...(refusalApprovalId === undefined
            ? {}
            : {
                retry: `pay fetch "${url}"${
                  maxAmountArg === undefined ? "" : ` ${maxAmountArg}`
                } ${refusalApprovalId}`
              })
        },
        null,
        2
      )}\n`
    );
    process.exit(1);
  }
  fail(`[pay] ${error instanceof Error ? error.message : String(error)}`);
}
