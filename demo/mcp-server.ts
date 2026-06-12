/**
 * Subly MCP server: exposes the buyer-side x402 flow as one MCP tool so agent
 * harnesses (Claude Code, OpenClaw, Cursor, ...) can pay for Subly-gated APIs
 * from Kamino vault yield in a single tool call.
 *
 * Tool: fetch_with_subly_payment(url)
 *   GET the URL. On a 402 challenge: prepare at the facilitator, validate the
 *   structured signing intent, sign locally, retry with PAYMENT-SIGNATURE,
 *   and return the delivered body plus the settlement receipt. Non-402
 *   responses are returned as-is (nothing is paid).
 *
 * Env (same as demo/buyer.ts):
 *   SUBLY_CLIENT_API_TOKEN      facilitator client token
 *   SOLANA_RPC_URL              RPC for the agent's own lookup-table view
 *   SUBLY_DEMO_AGENT_KEYPAIR or SUBLY_DEMO_AGENT_KEYPAIR_PATH
 * Optional env:
 *   SUBLY_FACILITATOR_URL       default http://localhost:3000
 *   SUBLY_ADMIN_API_TOKEN       if set, the result includes the yield budget
 *                               before/after the payment
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

const clientApiToken = requireEnv("SUBLY_CLIENT_API_TOKEN");
requireEnv("SOLANA_RPC_URL");
const facilitatorBaseUrl =
  process.env.SUBLY_FACILITATOR_URL ?? "http://localhost:3000";
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

async function paidFetch(url: string): Promise<PaidFetchResult> {
  const first = await fetch(url);
  const firstText = await first.text();
  if (first.status !== 402) {
    return { paid: false, status: first.status, body: truncatedBody(firstText) };
  }

  const challengeHeader = first.headers.get(PAYMENT_REQUIRED_HEADER);
  if (challengeHeader === null) {
    throw new Error("402 response is missing the PAYMENT-REQUIRED header");
  }
  const requirement =
    decodePaymentRequiredHeader(challengeHeader).sublyRequirements[0];
  if (requirement === undefined) {
    throw new Error(
      "402 challenge contains no subly-yield-exact requirement"
    );
  }

  const budgetBefore = await fetchBudget();
  const { headerValue, paymentId } = await client.buildPaymentSignatureHeader({
    paymentRequiredHeader: challengeHeader,
    httpMethod: "GET",
    url
  });

  const second = await fetch(url, {
    headers: { [PAYMENT_SIGNATURE_HEADER]: headerValue }
  });
  const secondText = await second.text();
  if (second.status !== 200) {
    throw new Error(
      `paid retry failed with ${second.status}: ${truncatedBody(secondText)}`
    );
  }

  let transaction: string | null = null;
  // The receipt header is informational; a malformed header must not fail a
  // payment that already settled.
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
        transaction = receipt.transaction;
      }
    }
  } catch {
    transaction = null;
  }

  return {
    paid: true,
    status: second.status,
    body: truncatedBody(secondText),
    payment: {
      amountUsdc: formatRawUsdc(requirement.amountRawUsdc),
      payTo: requirement.payTo,
      paymentId,
      transaction,
      solscanUrl:
        transaction === null ? null : `https://solscan.io/tx/${transaction}`,
      budgetBefore,
      budgetAfter: await fetchBudget()
    }
  };
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
        "Payments are refused by the facilitator when the spendable yield " +
        "budget cannot cover them — the principal is never spent. Use only " +
        "for URLs you intend to purchase access to.",
      inputSchema: {
        type: "object",
        properties: {
          url: {
            type: "string",
            description: "URL to fetch (GET). Must match the seller's resource URL exactly."
          }
        },
        required: ["url"]
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
  const url = request.params.arguments?.url;
  if (typeof url !== "string" || url.length === 0) {
    return {
      content: [{ type: "text", text: "missing required argument: url" }],
      isError: true
    };
  }
  try {
    const result = await paidFetch(url);
    return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
  } catch (error) {
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
  `[subly-mcp] ready: agent wallet ${signer.walletAddress}, facilitator ${facilitatorBaseUrl}`
);
