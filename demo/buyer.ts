/**
 * Demo buyer: an agent that pays for a Subly-gated API from Kamino vault
 * yield and calls it.
 *
 * Flow: request -> 402 challenge -> prepare at facilitator -> structured-
 * intent validation + local signing -> retry with PAYMENT-SIGNATURE ->
 * premium response + settlement receipt.
 *
 * Required env:
 *   SUBLY_CLIENT_API_TOKEN      facilitator client token
 *   SOLANA_RPC_URL              RPC for the agent's own lookup-table view
 *   SUBLY_DEMO_AGENT_KEYPAIR or SUBLY_DEMO_AGENT_KEYPAIR_PATH
 *                               agent wallet key (base58 secret or JSON file)
 * Optional env:
 *   SUBLY_FACILITATOR_URL       default http://localhost:3000
 *   SUBLY_DEMO_RESOURCE_URL     default http://localhost:4021/api/premium/alpha
 *   SUBLY_ADMIN_API_TOKEN       if set, shows the yield budget before/after
 */
import { LocalKeypairAgentWalletSigner } from "../src/client/agent-wallet-signer.js";
import { fetchLookupTablesForTransaction } from "../src/client/lookup-tables.js";
import { loadKeyPairSigner } from "../src/solana/keys.js";
import { createRpcFromEnv } from "../src/solana/rpc.js";
import { SublyX402Client, X402ClientError } from "../src/x402/client.js";
import {
  decodePaymentRequiredHeader,
  decodeX402Header,
  PAYMENT_REQUIRED_HEADER,
  PAYMENT_RESPONSE_HEADER,
  PAYMENT_SIGNATURE_HEADER
} from "../src/x402/headers.js";
import { fail, formatRawUsdc, requireEnv } from "./shared.js";

const clientApiToken = requireEnv("SUBLY_CLIENT_API_TOKEN");
requireEnv("SOLANA_RPC_URL");
const facilitatorBaseUrl =
  process.env.SUBLY_FACILITATOR_URL ?? "http://localhost:3000";
const resourceUrl =
  process.env.SUBLY_DEMO_RESOURCE_URL ??
  "http://localhost:4021/api/premium/alpha";
const adminApiToken = process.env.SUBLY_ADMIN_API_TOKEN ?? null;

const keyPairSigner = await loadKeyPairSigner({
  base58Secret: process.env.SUBLY_DEMO_AGENT_KEYPAIR,
  jsonFilePath: process.env.SUBLY_DEMO_AGENT_KEYPAIR_PATH,
  label: "SUBLY_DEMO_AGENT_KEYPAIR"
});
const signer = new LocalKeypairAgentWalletSigner(keyPairSigner);
const rpc = createRpcFromEnv();
const client = new SublyX402Client({
  facilitatorBaseUrl,
  clientApiToken,
  signer,
  lookupTablesFor: (serializedTransaction) =>
    fetchLookupTablesForTransaction(rpc, serializedTransaction)
});

console.log(`[buyer] agent wallet: ${signer.walletAddress}`);
console.log(`[buyer] facilitator:  ${facilitatorBaseUrl}`);

/** Budget display is informational; it must never fail the demo itself. */
async function showBudget(label: string): Promise<void> {
  if (adminApiToken === null) {
    return;
  }
  try {
    const response = await fetch(
      `${facilitatorBaseUrl}/v1/wallets/${signer.walletAddress}/budget`,
      { headers: { authorization: `Bearer ${adminApiToken}` } }
    );
    if (response.status !== 200) {
      console.log(`[buyer] budget ${label}: unavailable (${response.status})`);
      return;
    }
    const body = (await response.json()) as {
      budget?: {
        positionValueRawUsdc: string;
        grossYieldRawUsdc: string;
        spendableYieldRawUsdc: string;
      };
    };
    if (body.budget === undefined) {
      console.log(`[buyer] budget ${label}: unavailable (unexpected response)`);
      return;
    }
    console.log(
      `[buyer] budget ${label}: position ${formatRawUsdc(body.budget.positionValueRawUsdc)} USDC, ` +
        `spendable yield ${formatRawUsdc(body.budget.spendableYieldRawUsdc)} USDC`
    );
  } catch (error) {
    console.log(
      `[buyer] budget ${label}: unavailable (${
        error instanceof Error ? error.message : String(error)
      })`
    );
  }
}

await showBudget("before payment");

console.log(`\n[buyer] step 1: GET ${resourceUrl} (no payment attached)`);
const first = await fetch(resourceUrl);
if (first.status !== 402) {
  fail(
    `[buyer] expected a 402 challenge but got ${first.status}; is the demo seller running?`
  );
}
const challengeHeader = first.headers.get(PAYMENT_REQUIRED_HEADER);
if (challengeHeader === null) {
  fail("[buyer] 402 response is missing the PAYMENT-REQUIRED header");
}
const requirement =
  decodePaymentRequiredHeader(challengeHeader).sublyRequirements[0];
if (requirement === undefined) {
  fail(
    "[buyer] challenge contains no subly-yield-exact requirement " +
      "(check the seller's SUBLY_DEMO_PRICE_RAW_USDC and vault configuration)"
  );
}
console.log(
  `[buyer] received 402: ${formatRawUsdc(requirement.amountRawUsdc)} USDC ` +
    `to ${requirement.payTo} (scheme=${requirement.scheme})`
);

console.log(
  "\n[buyer] step 2: prepare payment at facilitator, validate the signing " +
    "intent against the transaction, sign locally"
);
let headerValue: string;
let paymentId: string;
try {
  ({ headerValue, paymentId } = await client.buildPaymentSignatureHeader({
    paymentRequiredHeader: challengeHeader,
    httpMethod: "GET",
    url: resourceUrl
  }));
} catch (error) {
  if (error instanceof X402ClientError) {
    console.error(`[buyer] payment refused: ${error.reason}`);
    if (error.detail !== undefined) {
      console.error(JSON.stringify(error.detail, null, 2));
    }
    if (error.reason === "invalid_canonical_resource_url") {
      console.error(
        "[buyer] hint: http resource URLs are only accepted when the " +
          "facilitator itself runs with NODE_ENV=development (see demo/README.md)"
      );
    }
    process.exit(1);
  }
  throw error;
}
console.log(`[buyer] payment signed (paymentId=${paymentId})`);

console.log("\n[buyer] step 3: retry the request with PAYMENT-SIGNATURE");
let second: Awaited<ReturnType<typeof fetch>>;
let secondText: string;
try {
  second = await fetch(resourceUrl, {
    headers: { [PAYMENT_SIGNATURE_HEADER]: headerValue }
  });
  secondText = await second.text();
} catch (error) {
  fail(
    `[buyer] paid retry failed in flight (${
      error instanceof Error ? error.message : String(error)
    }); the payment may already have settled — check the seller logs before ` +
      "rerunning (a rerun prepares a NEW payment)"
  );
}
if (second.status !== 200) {
  fail(`[buyer] paid retry failed with ${second.status}: ${secondText}`);
}
let responseBody: unknown;
try {
  responseBody = JSON.parse(secondText);
} catch {
  fail(
    `[buyer] paid retry returned a non-JSON 200 response: ${secondText.slice(0, 200)}`
  );
}

console.log("[buyer] premium response delivered:");
console.log(JSON.stringify(responseBody, null, 2));
console.log(
  `\n[buyer] settlement receipt: paid ${formatRawUsdc(requirement.amountRawUsdc)} USDC`
);

// The receipt header is informational here (the amount above comes from the
// validated requirement); never let a malformed header fail a paid demo run.
try {
  const receiptHeader = second.headers.get(PAYMENT_RESPONSE_HEADER);
  if (receiptHeader !== null) {
    const receipt = decodeX402Header(receiptHeader) as {
      transaction?: unknown;
    };
    if (
      typeof receipt.transaction === "string" &&
      receipt.transaction.length > 0
    ) {
      console.log(
        `[buyer] on-chain transaction: https://solscan.io/tx/${receipt.transaction}`
      );
    }
  }
} catch {
  console.log(
    "[buyer] settlement receipt header could not be decoded; see the seller logs for the transaction signature"
  );
}

await showBudget("after payment");
