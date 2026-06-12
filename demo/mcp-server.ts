/**
 * Subly MCP server: exposes the buyer-side x402 flow as one MCP tool so agent
 * harnesses (Claude Code, OpenClaw, Cursor, ...) can pay for Subly-gated APIs
 * from Kamino vault yield in a single tool call.
 *
 * Tool: fetch_with_subly_payment(url, maxAmountRawUsdc?, forceNewPayment?)
 *   GET the URL. On a 402 challenge: prepare at the facilitator, validate the
 *   structured signing intent, sign locally, retry with PAYMENT-SIGNATURE,
 *   and return the delivered body plus the settlement receipt. Non-402
 *   responses are returned as-is (nothing is paid).
 *
 * Double-payment protection: once a payment is signed, the signed header is
 * remembered per URL for the seller challenge TTL. If delivery fails after
 * signing, calling the tool again with the same URL retries delivery with the
 * SAME signature (the seller's /settle is idempotent and re-delivers the same
 * receipt) instead of preparing a second payment. If the outcome is still
 * unknown when the challenge TTL has passed, the tool refuses to pay again
 * for that URL until forceNewPayment is set.
 *
 * Env (same as demo/buyer.ts):
 *   SUBLY_CLIENT_API_TOKEN      facilitator client token
 *   SOLANA_RPC_URL              RPC for the agent's own lookup-table view
 *   SUBLY_DEMO_AGENT_KEYPAIR or SUBLY_DEMO_AGENT_KEYPAIR_PATH
 * Optional env:
 *   SUBLY_FACILITATOR_URL       default http://localhost:3000
 *   SUBLY_ADMIN_API_TOKEN       if set, the result includes the yield budget
 *                               before/after the payment
 *   SUBLY_MCP_MAX_AMOUNT_RAW_USDC  default client-side payment cap when the
 *                               tool call has no maxAmountRawUsdc (default
 *                               10000 = 0.01 USDC)
 *
 * stdout is the MCP transport; all diagnostics must go to stderr.
 */
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema
} from "@modelcontextprotocol/sdk/types.js";
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
import { formatRawUsdc, requireEnv } from "./shared.js";

const TOOL_NAME = "fetch_with_subly_payment";
const MAX_BODY_CHARS = 20_000;
/** Slightly under the seller's 120s challenge TTL (demo/README.md). */
const PENDING_PAYMENT_TTL_MS = 110_000;
const DEFAULT_MAX_AMOUNT_RAW_USDC = 10_000n; // 0.01 USDC

const clientApiToken = requireEnv("SUBLY_CLIENT_API_TOKEN");
requireEnv("SOLANA_RPC_URL");
const facilitatorBaseUrl =
  process.env.SUBLY_FACILITATOR_URL ?? "http://localhost:3000";
const adminApiToken = process.env.SUBLY_ADMIN_API_TOKEN ?? null;
const defaultMaxAmountRawUsdc =
  process.env.SUBLY_MCP_MAX_AMOUNT_RAW_USDC === undefined
    ? DEFAULT_MAX_AMOUNT_RAW_USDC
    : BigInt(process.env.SUBLY_MCP_MAX_AMOUNT_RAW_USDC);

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

/** A signed payment whose delivery has not been confirmed yet. */
interface PendingPayment {
  headerValue: string;
  paymentId: string;
  amountUsdc: string;
  payTo: string;
  signedAtMs: number;
}

const pendingPayments = new Map<string, PendingPayment>();

/** Tool failure with a machine-readable reason for the calling agent. */
class PaidFetchError extends Error {
  constructor(
    readonly reason: string,
    message: string,
    readonly detail: unknown = null
  ) {
    super(message);
  }
}

interface BudgetSnapshot {
  positionValueUsdc: string;
  spendableYieldUsdc: string;
}

async function fetchBudget(): Promise<BudgetSnapshot | null> {
  if (adminApiToken === null) {
    return null;
  }
  try {
    const response = await fetch(
      `${facilitatorBaseUrl}/v1/wallets/${signer.walletAddress}/budget`,
      { headers: { authorization: `Bearer ${adminApiToken}` } }
    );
    if (response.status !== 200) {
      return null;
    }
    const body = (await response.json()) as {
      budget?: { positionValueRawUsdc: string; spendableYieldRawUsdc: string };
    };
    if (body.budget === undefined) {
      return null;
    }
    return {
      positionValueUsdc: formatRawUsdc(body.budget.positionValueRawUsdc),
      spendableYieldUsdc: formatRawUsdc(body.budget.spendableYieldRawUsdc)
    };
  } catch {
    return null;
  }
}

function truncatedBody(text: string): string {
  return text.length > MAX_BODY_CHARS
    ? `${text.slice(0, MAX_BODY_CHARS)}\n... (truncated)`
    : text;
}

interface PaidFetchResult {
  paid: boolean;
  status: number;
  body: string;
  retriedPendingPayment?: boolean;
  payment?: {
    amountUsdc: string;
    payTo: string;
    paymentId: string;
    transaction: string | null;
    solscanUrl: string | null;
    budgetBefore: BudgetSnapshot | null;
    budgetAfter: BudgetSnapshot | null;
  };
}

function receiptTransaction(response: Response): string | null {
  // The receipt header is informational; a malformed header must not fail a
  // payment that already settled.
  try {
    const receiptHeader = response.headers.get(PAYMENT_RESPONSE_HEADER);
    if (receiptHeader === null) {
      return null;
    }
    const receipt = decodeX402Header(receiptHeader) as {
      transaction?: unknown;
    };
    return typeof receipt.transaction === "string" &&
      receipt.transaction.length > 0
      ? receipt.transaction
      : null;
  } catch {
    return null;
  }
}

/**
 * Sends the signed PAYMENT-SIGNATURE retry. The pending entry is removed only
 * on confirmed delivery (200) or when the seller proves the signature can no
 * longer settle (a fresh 402); every other failure keeps it so the next call
 * for the same URL retries the SAME signature instead of paying again.
 */
async function deliverPendingPayment(
  url: string,
  pending: PendingPayment,
  params: { retried: boolean; budgetBefore: BudgetSnapshot | null }
): Promise<PaidFetchResult> {
  let second: Response;
  let secondText: string;
  try {
    second = await fetch(url, {
      headers: { [PAYMENT_SIGNATURE_HEADER]: pending.headerValue }
    });
    secondText = await second.text();
  } catch (error) {
    throw new PaidFetchError(
      "delivery_failed_payment_pending",
      `delivery request failed in flight (${
        error instanceof Error ? error.message : String(error)
      }); the payment (paymentId=${pending.paymentId}) is already signed and ` +
        "may settle. Call this tool again with the same URL to retry delivery " +
        "with the same payment signature — do NOT treat this as unpaid.",
      { paymentId: pending.paymentId }
    );
  }

  if (second.status === 200) {
    pendingPayments.delete(url);
    const transaction = receiptTransaction(second);
    return {
      paid: true,
      status: second.status,
      body: truncatedBody(secondText),
      ...(params.retried ? { retriedPendingPayment: true } : {}),
      payment: {
        amountUsdc: pending.amountUsdc,
        payTo: pending.payTo,
        paymentId: pending.paymentId,
        transaction,
        solscanUrl:
          transaction === null ? null : `https://solscan.io/tx/${transaction}`,
        budgetBefore: params.budgetBefore,
        budgetAfter: await fetchBudget()
      }
    };
  }

  if (second.status === 402) {
    // The seller no longer accepts this signature (challenge expired or the
    // seller restarted). Whether the payment settled is unknown.
    pendingPayments.delete(url);
    throw new PaidFetchError(
      "payment_outcome_unknown",
      `the seller no longer accepts the signed payment (paymentId=${pending.paymentId}); ` +
        "it may or may not have settled. Verify the payment before purchasing " +
        "again; to pay again anyway, call this tool with forceNewPayment=true.",
      { paymentId: pending.paymentId }
    );
  }

  throw new PaidFetchError(
    "delivery_failed_payment_pending",
    `paid delivery failed with ${second.status} (paymentId=${pending.paymentId}); ` +
      "the payment may already have settled. Call this tool again with the " +
      "same URL to retry delivery with the same payment signature — do NOT " +
      "treat this as unpaid.",
    { paymentId: pending.paymentId, status: second.status, body: truncatedBody(secondText) }
  );
}

async function paidFetch(params: {
  url: string;
  maxAmountRawUsdc: bigint;
  forceNewPayment: boolean;
}): Promise<PaidFetchResult> {
  const { url } = params;
  const pending = pendingPayments.get(url);
  if (pending !== undefined) {
    if (params.forceNewPayment) {
      pendingPayments.delete(url);
    } else if (Date.now() - pending.signedAtMs > PENDING_PAYMENT_TTL_MS) {
      throw new PaidFetchError(
        "payment_outcome_unknown",
        `a previously signed payment for this URL (paymentId=${pending.paymentId}) ` +
          "expired with an unknown outcome. Verify the payment before " +
          "purchasing again; to pay again anyway, call this tool with " +
          "forceNewPayment=true.",
        { paymentId: pending.paymentId }
      );
    } else {
      return deliverPendingPayment(url, pending, {
        retried: true,
        budgetBefore: null
      });
    }
  }

  const first = await fetch(url);
  const firstText = await first.text();
  if (first.status !== 402) {
    return { paid: false, status: first.status, body: truncatedBody(firstText) };
  }

  const challengeHeader = first.headers.get(PAYMENT_REQUIRED_HEADER);
  if (challengeHeader === null) {
    throw new PaidFetchError(
      "invalid_challenge",
      "402 response is missing the PAYMENT-REQUIRED header"
    );
  }
  const requirement =
    decodePaymentRequiredHeader(challengeHeader).sublyRequirements[0];
  if (requirement === undefined) {
    throw new PaidFetchError(
      "invalid_challenge",
      "402 challenge contains no subly-yield-exact requirement"
    );
  }

  const amountRawUsdc = BigInt(requirement.amountRawUsdc);
  if (amountRawUsdc > params.maxAmountRawUsdc) {
    throw new PaidFetchError(
      "amount_exceeds_client_cap",
      `the challenge demands ${formatRawUsdc(requirement.amountRawUsdc)} USDC, ` +
        `above this tool call's cap of ${formatRawUsdc(
          params.maxAmountRawUsdc.toString()
        )} USDC; nothing was paid. Raise maxAmountRawUsdc only if this price ` +
        "is expected.",
      {
        amountRawUsdc: requirement.amountRawUsdc,
        maxAmountRawUsdc: params.maxAmountRawUsdc.toString(),
        payTo: requirement.payTo
      }
    );
  }

  const budgetBefore = await fetchBudget();
  const { headerValue, paymentId } = await client.buildPaymentSignatureHeader({
    paymentRequiredHeader: challengeHeader,
    httpMethod: "GET",
    url
  });
  const entry: PendingPayment = {
    headerValue,
    paymentId,
    amountUsdc: formatRawUsdc(requirement.amountRawUsdc),
    payTo: requirement.payTo,
    signedAtMs: Date.now()
  };
  pendingPayments.set(url, entry);

  return deliverPendingPayment(url, entry, { retried: false, budgetBefore });
}

const server = new Server(
  { name: "subly-payments", version: "0.1.0" },
  { capabilities: { tools: {} } }
);

server.setRequestHandler(ListToolsRequestSchema, () => ({
  tools: [
    {
      name: TOOL_NAME,
      description:
        "GET a URL, automatically paying a Subly x402 (subly-yield-exact) " +
        "402 challenge from the agent wallet's Kamino vault yield. Returns " +
        "the response body; when a payment was made, also returns the " +
        "settlement receipt (amount, payee, paymentId, Solscan link). " +
        "Challenges above maxAmountRawUsdc (default " +
        `${defaultMaxAmountRawUsdc} raw = ${formatRawUsdc(
          defaultMaxAmountRawUsdc.toString()
        )} USDC) are refused without paying. ` +
        "If delivery fails after the payment was signed, the signature is " +
        "kept and calling again with the same URL retries the same payment " +
        "instead of paying twice. Payments are refused by the facilitator " +
        "when the spendable yield budget cannot cover them — the principal " +
        "is never spent. Use only for URLs you intend to purchase access to.",
      inputSchema: {
        type: "object",
        properties: {
          url: {
            type: "string",
            description:
              "URL to fetch (GET). Must match the seller's resource URL exactly."
          },
          maxAmountRawUsdc: {
            type: "string",
            description:
              "Refuse (without paying) any challenge above this amount in raw " +
              "USDC units (6 decimals, e.g. \"10000\" = 0.01 USDC). Defaults " +
              "to the server-side cap."
          },
          forceNewPayment: {
            type: "boolean",
            description:
              "Pay again even though a previous payment for this URL has an " +
              "unknown outcome. Only set after verifying the previous payment " +
              "did not settle."
          }
        },
        required: ["url"]
      },
      annotations: {
        title: "Fetch with Subly payment",
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: true
      }
    }
  ]
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  if (request.params.name !== TOOL_NAME) {
    return {
      content: [
        { type: "text", text: `unknown tool: ${request.params.name}` }
      ],
      isError: true
    };
  }
  const args = request.params.arguments ?? {};
  const url = args.url;
  if (typeof url !== "string" || url.length === 0) {
    return {
      content: [{ type: "text", text: "missing required argument: url" }],
      isError: true
    };
  }
  let maxAmountRawUsdc = defaultMaxAmountRawUsdc;
  if (args.maxAmountRawUsdc !== undefined) {
    try {
      maxAmountRawUsdc = BigInt(args.maxAmountRawUsdc as string | number);
    } catch {
      return {
        content: [
          {
            type: "text",
            text: "maxAmountRawUsdc must be an integer raw USDC amount"
          }
        ],
        isError: true
      };
    }
  }

  try {
    const result = await paidFetch({
      url,
      maxAmountRawUsdc,
      forceNewPayment: args.forceNewPayment === true
    });
    return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
  } catch (error) {
    if (error instanceof PaidFetchError) {
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              {
                paid: false,
                refused: true,
                reason: error.reason,
                message: error.message,
                detail: error.detail
              },
              null,
              2
            )
          }
        ],
        isError: true
      };
    }
    if (error instanceof X402ClientError) {
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              {
                paid: false,
                refused: true,
                reason: error.reason,
                detail: error.detail ?? null
              },
              null,
              2
            )
          }
        ],
        isError: true
      };
    }
    return {
      content: [
        {
          type: "text",
          text: error instanceof Error ? error.message : String(error)
        }
      ],
      isError: true
    };
  }
});

const transport = new StdioServerTransport();
await server.connect(transport);
console.error(
  `[subly-mcp] ready: agent wallet ${signer.walletAddress}, facilitator ${facilitatorBaseUrl}, ` +
    `default cap ${formatRawUsdc(defaultMaxAmountRawUsdc.toString())} USDC`
);
