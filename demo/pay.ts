/**
 * One-shot Subly paid fetch CLI: GET a URL, paying a subly-yield-exact 402
 * challenge from the agent wallet's Kamino vault yield, and print the result
 * as JSON. This is the command the OpenClaw skill (skills/subly-pay) invokes;
 * it is the same engine as the MCP server (src/client/paid-fetch.ts).
 *
 * Usage:
 *   npm run demo:pay -- <url> [maxAmountRawUsdc]
 *
 * Required env:
 *   SUBLY_DEMO_AGENT_KEYPAIR or SUBLY_DEMO_AGENT_KEYPAIR_PATH
 * Optional env:
 *   SUBLY_FACILITATOR_URL       default https://api.demo.sublyfi.com
 *   SOLANA_RPC_URL              default the public mainnet RPC
 *   SUBLY_MCP_MAX_AMOUNT_RAW_USDC  default per-call cap (10000 = 0.01 USDC)
 *   SUBLY_MCP_STATE_PATH        pending-payment store (double-pay protection)
 *
 * Prints a single JSON object on stdout; diagnostics go to stderr. Exit code
 * is non-zero when nothing was delivered (refused or errored).
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { LocalKeypairAgentWalletSigner } from "../src/client/agent-wallet-signer.js";
import { fetchLookupTablesForTransaction } from "../src/client/lookup-tables.js";
import { ensureWalletOnboarded } from "../src/client/onboarding.js";
import {
  PaidFetchError,
  PaidFetchService,
  formatRawUsdcAmount,
  type BudgetSnapshot,
  type PaymentOutcomeProbe,
  type PendingPaymentRecord,
  type PendingStateStore
} from "../src/client/paid-fetch.js";
import { walletAuthHeaders } from "../src/client/wallet-auth-headers.js";
import { loadKeyPairSigner } from "../src/solana/keys.js";
import { createRpc } from "../src/solana/rpc.js";
import { SublyX402Client } from "../src/x402/client.js";
import { fail } from "./shared.js";

const url = process.argv[2];
if (url === undefined || !/^https?:\/\//.test(url)) {
  fail("Usage: npm run demo:pay -- <url> [maxAmountRawUsdc]");
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
const pendingStatePath =
  process.env.SUBLY_MCP_STATE_PATH ?? "demo/env/mcp-pending-payments.json";

const keyPairSigner = await loadKeyPairSigner({
  base58Secret: process.env.SUBLY_DEMO_AGENT_KEYPAIR,
  jsonFilePath: process.env.SUBLY_DEMO_AGENT_KEYPAIR_PATH,
  label: "SUBLY_DEMO_AGENT_KEYPAIR"
});
const signer = new LocalKeypairAgentWalletSigner(keyPairSigner);
const rpc = createRpc(rpcUrl);

async function fetchBudget(): Promise<BudgetSnapshot | null> {
  try {
    const budgetUrl = `${facilitatorBaseUrl}/v1/wallets/${signer.walletAddress}/budget`;
    const response = await fetch(budgetUrl, {
      headers: await walletAuthHeaders({ signer, method: "GET", url: budgetUrl })
    });
    if (response.status !== 200) {
      return null;
    }
    const body = (await response.json()) as {
      budget?: { positionValueRawUsdc: string; spendableYieldRawUsdc: string };
    };
    return body.budget === undefined
      ? null
      : {
          positionValueUsdc: formatRawUsdcAmount(body.budget.positionValueRawUsdc),
          spendableYieldUsdc: formatRawUsdcAmount(
            body.budget.spendableYieldRawUsdc
          )
        };
  } catch {
    return null;
  }
}

async function paymentStatusFor(
  paymentId: string
): Promise<PaymentOutcomeProbe> {
  try {
    const statusUrl = `${facilitatorBaseUrl}/v1/payments/${paymentId}`;
    const response = await fetch(statusUrl, {
      headers: await walletAuthHeaders({ signer, method: "GET", url: statusUrl })
    });
    if (response.status !== 200) {
      return "indeterminate";
    }
    const body = (await response.json()) as { status?: string };
    if (body.status === "settled") {
      return "settled";
    }
    if (
      body.status === "expired" ||
      body.status === "failed" ||
      body.status === "failed_not_submitted"
    ) {
      return "not_settled";
    }
    return "indeterminate";
  } catch {
    return "indeterminate";
  }
}

function fileStateStore(path: string): PendingStateStore {
  return {
    load(): PendingPaymentRecord[] {
      let text: string;
      try {
        text = readFileSync(path, "utf8");
      } catch (error) {
        if (isMissingFileError(error)) {
          return [];
        }
        throw error;
      }

      const parsed: unknown = JSON.parse(text);
      if (!Array.isArray(parsed)) {
        throw new Error(`pending payment state is not an array: ${path}`);
      }
      for (const [index, record] of parsed.entries()) {
        if (!isPendingPaymentRecord(record)) {
          throw new Error(
            `pending payment state has an invalid record at index ${index}: ${path}`
          );
        }
      }
      return parsed as PendingPaymentRecord[];
    },
    save(records: PendingPaymentRecord[]): void {
      const directory = dirname(path);
      mkdirSync(directory, { recursive: true });
      const tempPath = join(
        directory,
        `.${basename(path)}.${process.pid}.${Date.now()}.tmp`
      );
      writeFileSync(tempPath, JSON.stringify(records, null, 2));
      renameSync(tempPath, path);
    }
  };
}

function isMissingFileError(error: unknown): boolean {
  return (
    error !== null &&
    typeof error === "object" &&
    "code" in error &&
    error.code === "ENOENT"
  );
}

function isPendingPaymentRecord(value: unknown): value is PendingPaymentRecord {
  if (value === null || typeof value !== "object") {
    return false;
  }
  const record = value as Record<string, unknown>;
  return (
    typeof record.url === "string" &&
    typeof record.headerValue === "string" &&
    typeof record.paymentId === "string" &&
    typeof record.amountUsdc === "string" &&
    typeof record.payTo === "string" &&
    typeof record.challengeAtMs === "number" &&
    typeof record.unresolved === "boolean"
  );
}

const service = new PaidFetchService({
  signatureBuilder: new SublyX402Client({
    facilitatorBaseUrl,
    signer,
    lookupTablesFor: (serializedTransaction) =>
      fetchLookupTablesForTransaction(rpc, serializedTransaction)
  }),
  defaultMaxAmountRawUsdc,
  fetchBudget,
  paymentStatusFor,
  stateStore: fileStateStore(pendingStatePath)
});

console.error(`[subly-pay] agent ${signer.walletAddress} -> ${facilitatorBaseUrl}`);
try {
  await ensureWalletOnboarded({ facilitatorBaseUrl, signer });
} catch (error) {
  console.error(
    `[subly-pay] onboarding skipped: ${
      error instanceof Error ? error.message : String(error)
    }`
  );
}

try {
  const result = await service.paidFetch({
    url,
    ...(maxAmountArg === undefined
      ? {}
      : { maxAmountRawUsdc: BigInt(maxAmountArg) })
  });
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
} catch (error) {
  if (error instanceof PaidFetchError) {
    process.stdout.write(
      `${JSON.stringify(
        { paid: false, refused: true, reason: error.reason, message: error.message, detail: error.detail },
        null,
        2
      )}\n`
    );
    process.exit(1);
  }
  fail(`[subly-pay] ${error instanceof Error ? error.message : String(error)}`);
}
