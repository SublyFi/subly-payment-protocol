import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema
} from "@modelcontextprotocol/sdk/types.js";
import type { AgentWalletSigner } from "./agent-wallet-signer.js";
import { ensureWalletOnboarded } from "./onboarding.js";
import { formatRawUsdcAmount } from "./paid-fetch.js";
import {
  StandardX402PayError,
  type StandardX402Payer
} from "./standard-x402-payer.js";

/**
 * The Subly MCP payment server, decoupled from any concrete x402 payment
 * library: the caller injects a fully-built StandardX402Payer. Both the repo
 * demo (PayAI x402-solana, kit v2) and the published client (@x402/svm, kit v5)
 * reuse this exact tool surface + onboarding + stdio wiring.
 */
const TOOL_NAME = "fetch_with_subly_payment";

const SERVER_INSTRUCTIONS = `Subly lets an agent pay for ANY standard x402 \
(HTTP 402) paid API from its wallet's Kamino vault YIELD — the deposited \
principal is never spent, and the seller needs no Subly integration.

Before payments can succeed the operator of this server must have, once:
1. A Solana keypair for the agent wallet. Subly does NOT create wallets; \
make one with \`solana-keygen new -o agent.json\` (or export a keypair from \
an existing wallet) and point SUBLY_DEMO_AGENT_KEYPAIR_PATH at it. The \
private key never leaves that file; this server only signs locally with it.
2. Funded that wallet with USDC on Solana mainnet (no SOL needed — realize \
fees are sponsored) and deposited into the vault (see the project's deposit \
command). The vault minimum deposit is 1 USDC.
3. Waited for yield to accrue; a payment needs the seller's price of \
spendable yield.

Then use fetch_with_subly_payment(url) to GET or POST a paid resource from \
any x402 seller (e.g. Nansen): it realizes just enough yield to the agent's \
USDC ATA and pays the seller's standard x402 challenge, returning the body \
plus the payment details. If it returns insufficient_yield, that is expected \
— wait for yield, do not loop.`;

export interface McpPaymentServerConfig {
  payer: StandardX402Payer;
  signer: AgentWalletSigner;
  /** Subly relayer API base URL. Kept as facilitatorBaseUrl for env compatibility. */
  facilitatorBaseUrl: string;
  defaultMaxAmountRawUsdc: bigint;
  serverVersion?: string;
}

export async function runMcpPaymentServer(
  config: McpPaymentServerConfig
): Promise<void> {
  const { payer, signer, facilitatorBaseUrl, defaultMaxAmountRawUsdc } = config;

  const server = new Server(
    { name: "subly-payments", version: config.serverVersion ?? "0.3.0" },
    { capabilities: { tools: {} }, instructions: SERVER_INSTRUCTIONS }
  );

  server.setRequestHandler(ListToolsRequestSchema, () => ({
    tools: [
      {
        name: TOOL_NAME,
        description:
          "Fetch a URL (GET or POST), automatically paying a standard x402 " +
          "(HTTP 402) challenge from any x402-compatible seller (Nansen, etc.) " +
          "out of the agent wallet's Kamino vault yield. Subly realizes just " +
          "enough yield to the agent's USDC ATA (sponsored) and pays the " +
          "seller's Solana USDC `exact` challenge; the seller needs no Subly " +
          "integration. Returns the response body and, when a payment was " +
          "made, the payment details (amount, payee, realize tx). Challenges " +
          `above maxAmountRawUsdc (default ${defaultMaxAmountRawUsdc} raw = ${formatRawUsdcAmount(
            defaultMaxAmountRawUsdc
          )} USDC) are refused without paying. Payments are refused when the ` +
          "spendable yield budget cannot cover them — the principal is never " +
          "spent. Use only for URLs you intend to purchase access to.",
        inputSchema: {
          type: "object",
          properties: {
            url: {
              type: "string",
              description:
                "URL to fetch. Must match the seller's resource URL exactly."
            },
            method: {
              type: "string",
              description:
                "HTTP method (default GET). Some x402 sellers deliver the " +
                "paid resource over POST (e.g. an API that takes a JSON body)."
            },
            body: {
              type: "string",
              description:
                "Request body sent on both the probe and the paid retry. " +
                "Provide a JSON string for POST sellers; sent as content-type " +
                "application/json unless headers override it."
            },
            headers: {
              type: "object",
              description:
                "Extra request headers (object of string values), merged into " +
                "both the probe and the paid retry.",
              additionalProperties: { type: "string" }
            },
            maxAmountRawUsdc: {
              type: "string",
              description:
                "Refuse (without paying) any challenge above this amount in " +
                "raw USDC units (6 decimals, e.g. \"10000\" = 0.01 USDC). " +
                "Defaults to the server-side cap."
            },
            forceNewPayment: {
              type: "boolean",
              description:
                "Pay again even if a previous external x402 attempt for the " +
                "same URL/method/body has an unknown outcome. This may pay " +
                "twice for the same resource."
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
        content: [{ type: "text", text: `unknown tool: ${request.params.name}` }],
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

    const method = typeof args.method === "string" ? args.method : undefined;
    const body = typeof args.body === "string" ? args.body : undefined;
    const forceNewPayment = args.forceNewPayment === true;
    const headers =
      args.headers !== null &&
      typeof args.headers === "object" &&
      !Array.isArray(args.headers)
        ? Object.fromEntries(
            Object.entries(args.headers as Record<string, unknown>)
              .filter(([, v]) => typeof v === "string")
              .map(([k, v]) => [k, v as string])
          )
        : undefined;
    const mergedHeaders =
      body === undefined
        ? headers
        : { "content-type": "application/json", ...(headers ?? {}) };

    try {
      const result = await payer.pay({
        url,
        ...(method === undefined ? {} : { method }),
        ...(body === undefined ? {} : { body }),
        ...(mergedHeaders === undefined ? {} : { headers: mergedHeaders }),
        ...(maxAmountRawUsdc === undefined ? {} : { maxAmountRawUsdc }),
        ...(forceNewPayment ? { forceNewPayment } : {})
      });
      return {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }]
      };
    } catch (error) {
      if (error instanceof StandardX402PayError) {
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

  // Self-serve onboarding: register + activate + chain-sync this wallet so the
  // realize relayer can serve budget reads and sponsored withdrawals.
  try {
    await ensureWalletOnboarded({ facilitatorBaseUrl, signer });
    console.error("[subly-mcp] wallet registered and synced at the relayer");
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
    `[subly-mcp] ready: agent wallet ${signer.walletAddress}, relayer ${facilitatorBaseUrl}, ` +
      `default cap ${formatRawUsdcAmount(defaultMaxAmountRawUsdc)} USDC`
  );
}
