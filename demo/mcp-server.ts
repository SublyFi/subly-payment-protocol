/**
 * Subly MCP server: exposes the buyer-side x402 flow as one MCP tool so agent
 * harnesses (Claude Code, OpenClaw, Cursor, ...) can pay for Subly-gated APIs
 * from Kamino vault yield in a single tool call.
 *
 * This file is only env wiring and MCP transport; the payment flow itself
 * (including double-payment protection and the client-side amount cap) lives
 * in src/client/paid-fetch.ts and is unit-tested there.
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
import {
  PaidFetchError,
  PaidFetchService,
  formatRawUsdcAmount,
  type BudgetSnapshot
} from "../src/client/paid-fetch.js";
import { loadKeyPairSigner } from "../src/solana/keys.js";
import { createRpcFromEnv } from "../src/solana/rpc.js";
import { SublyX402Client, X402ClientError } from "../src/x402/client.js";
import { requireEnv } from "./shared.js";

const TOOL_NAME = "fetch_with_subly_payment";
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
      positionValueUsdc: formatRawUsdcAmount(body.budget.positionValueRawUsdc),
      spendableYieldUsdc: formatRawUsdcAmount(
        body.budget.spendableYieldRawUsdc
      )
    };
  } catch {
    return null;
  }
}

const paidFetchService = new PaidFetchService({
  signatureBuilder: new SublyX402Client({
    facilitatorBaseUrl,
    clientApiToken,
    signer,
    lookupTablesFor: (serializedTransaction) =>
      fetchLookupTablesForTransaction(rpc, serializedTransaction)
  }),
  defaultMaxAmountRawUsdc,
  fetchBudget
});

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
        `${defaultMaxAmountRawUsdc} raw = ${formatRawUsdcAmount(
          defaultMaxAmountRawUsdc
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
              "did not settle. Ignored while the previous payment is still " +
              "retryable (the same signature is retried instead)."
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
  let maxAmountRawUsdc: bigint | undefined;
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
    const result = await paidFetchService.paidFetch({
      url,
      ...(maxAmountRawUsdc === undefined ? {} : { maxAmountRawUsdc }),
      forceNewPayment: args.forceNewPayment === true
    });
    return {
      content: [{ type: "text", text: JSON.stringify(result, null, 2) }]
    };
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
    `default cap ${formatRawUsdcAmount(defaultMaxAmountRawUsdc)} USDC`
);
