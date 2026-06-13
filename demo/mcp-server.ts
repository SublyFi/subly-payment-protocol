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
 *   SOLANA_RPC_URL              RPC for the agent's own lookup-table view
 *                               (optional; defaults to the public mainnet RPC)
 *   SUBLY_DEMO_AGENT_KEYPAIR or SUBLY_DEMO_AGENT_KEYPAIR_PATH
 * Optional env:
 *   SUBLY_FACILITATOR_URL       default http://localhost:3000
 *   SUBLY_MCP_MAX_AMOUNT_RAW_USDC  default client-side payment cap when the
 *                               tool call has no maxAmountRawUsdc (default
 *                               10000 = 0.01 USDC)
 *
 * No API token: requests authenticate with the wallet's own signature, and
 * the wallet self-registers at the facilitator on boot.
 *
 * stdout is the MCP transport; all diagnostics must go to stderr.
 */
import { readFileSync, writeFileSync } from "node:fs";
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
  type BudgetSnapshot,
  type PaymentOutcomeProbe,
  type PendingPaymentRecord,
  type PendingStateStore
} from "../src/client/paid-fetch.js";
import { ensureWalletOnboarded } from "../src/client/onboarding.js";
import { walletAuthHeaders } from "../src/client/wallet-auth-headers.js";
import { loadKeyPairSigner } from "../src/solana/keys.js";
import { createRpc } from "../src/solana/rpc.js";
import { SublyX402Client, X402ClientError } from "../src/x402/client.js";

const TOOL_NAME = "fetch_with_subly_payment";
const DEFAULT_MAX_AMOUNT_RAW_USDC = 10_000n; // 0.01 USDC

const facilitatorBaseUrl =
  process.env.SUBLY_FACILITATOR_URL ?? "https://api.demo.sublyfi.com";
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
const rpc = createRpc(
  process.env.SOLANA_RPC_URL ?? "https://api.mainnet-beta.solana.com"
);

async function fetchBudget(): Promise<BudgetSnapshot | null> {
  try {
    const url = `${facilitatorBaseUrl}/v1/wallets/${signer.walletAddress}/budget`;
    const response = await fetch(url, {
      headers: await walletAuthHeaders({ signer, method: "GET", url })
    });
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

/**
 * Resolves lost deliveries via GET /v1/payments/:paymentId (the wallet may
 * read its own payments). "not_settled" only for terminal pre-submission
 * states; a payment that is prepared/submitted may still land and stays
 * indeterminate.
 */
async function paymentStatusFor(
  paymentId: string
): Promise<PaymentOutcomeProbe> {
  try {
    const url = `${facilitatorBaseUrl}/v1/payments/${paymentId}`;
    const response = await fetch(url, {
      headers: await walletAuthHeaders({ signer, method: "GET", url })
    });
    if (response.status !== 200) {
      return "indeterminate";
    }
    const body = (await response.json()) as { status?: string };
    if (body.status === "settled") {
      return "settled";
    }
    // Terminal failures (payment-service isTerminalFailedPaymentStatus):
    // "failed" landed on-chain but did not pay the seller.
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

/**
 * Persists pending-payment markers so a server restart cannot forget a signed
 * payment with an unconfirmed delivery (the file holds signed payment headers
 * for this agent; keep it next to the gitignored env files).
 */
function fileStateStore(path: string): PendingStateStore {
  return {
    load(): PendingPaymentRecord[] {
      try {
        const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
        return Array.isArray(parsed) ? (parsed as PendingPaymentRecord[]) : [];
      } catch {
        return [];
      }
    },
    save(records: PendingPaymentRecord[]): void {
      try {
        writeFileSync(path, JSON.stringify(records));
      } catch (error) {
        console.error(
          `[subly-mcp] failed to persist pending payments: ${
            error instanceof Error ? error.message : String(error)
          }`
        );
      }
    }
  };
}

const pendingStatePath =
  process.env.SUBLY_MCP_STATE_PATH ?? "demo/env/mcp-pending-payments.json";

const paidFetchService = new PaidFetchService({
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

const SERVER_INSTRUCTIONS = `Subly lets an agent pay for HTTP 402 (subly-yield-exact) resources from \
its wallet's Kamino vault YIELD — the deposited principal is never spent.

Before payments can succeed the operator of this server must have, once:
1. A Solana keypair for the agent wallet. Subly does NOT create wallets; \
make one with \`solana-keygen new -o agent.json\` (or export a keypair from \
an existing wallet) and point SUBLY_DEMO_AGENT_KEYPAIR_PATH at it. The \
private key never leaves that file; this server only signs locally with it.
2. Funded that wallet with USDC on Solana mainnet (no SOL needed — fees are \
sponsored) and deposited into the vault (see the project's deposit command). \
The vault minimum deposit is 1 USDC.
3. Waited for yield to accrue; a payment needs the price plus a fixed \
overhead (~0.0024 USDC) of spendable yield.

Then use fetch_with_subly_payment(url) to GET a paid resource: it pays the \
402 from yield and returns the body plus an on-chain receipt. If it returns \
insufficient_yield, that is expected — wait for yield, do not loop. If it \
returns delivery_failed_payment_pending, call the SAME url again (it retries \
the same payment, never double-pays).`;

const server = new Server(
  { name: "subly-payments", version: "0.1.1" },
  { capabilities: { tools: {} }, instructions: SERVER_INSTRUCTIONS }
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
              "Pay again even though a previous payment for this URL settled " +
              "or has an unknown outcome. Only set deliberately: combined " +
              "with payment_already_settled this means paying twice for the " +
              "same resource. Ignored while the previous payment is still " +
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
    const raw = args.maxAmountRawUsdc;
    try {
      if (typeof raw !== "string" && typeof raw !== "number") {
        throw new TypeError("not a string or number");
      }
      maxAmountRawUsdc = BigInt(raw);
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

// Self-serve onboarding: register + activate + chain-sync this wallet so
// no operator step is needed before the first deposit or payment.
try {
  await ensureWalletOnboarded({ facilitatorBaseUrl, signer });
  console.error("[subly-mcp] wallet registered and synced at the facilitator");
} catch (error) {
  console.error(
    `[subly-mcp] wallet onboarding failed (will still serve tools): ${
      error instanceof Error ? error.message : String(error)
    }`
  );
}

const transport = new StdioServerTransport();
await server.connect(transport);
console.error(
  `[subly-mcp] ready: agent wallet ${signer.walletAddress}, facilitator ${facilitatorBaseUrl}, ` +
    `default cap ${formatRawUsdcAmount(defaultMaxAmountRawUsdc)} USDC`
);
