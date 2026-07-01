/**
 * Subly MCP server: exposes the buyer-side x402 flow as one MCP tool so agent
 * harnesses (Claude Code, OpenClaw, Cursor, ...) can pay for ANY standard
 * x402-compatible paid API from Kamino vault yield in a single tool call. The
 * seller needs no Subly integration.
 *
 * This file is env wiring and MCP transport; the payment flow itself lives in
 * src/client/standard-x402-payer.ts (probe -> cap -> realize yield -> pay) and
 * src/client/relayer-yield-realizer.ts (sponsored withdraw of yield), both
 * unit-tested there.
 *
 * Env (same as demo/pay-x402.ts):
 *   SOLANA_RPC_URL              RPC for the agent's own view
 *                               (optional; defaults to the public mainnet RPC)
 *   SUBLY_DEMO_AGENT_KEYPAIR or SUBLY_DEMO_AGENT_KEYPAIR_PATH
 * Optional env:
 *   SUBLY_FACILITATOR_URL       realize relayer; default https://api.demo.sublyfi.com
 *   SUBLY_MCP_MAX_AMOUNT_RAW_USDC  default client-side payment cap when the
 *                               tool call has no maxAmountRawUsdc (default
 *                               10000 = 0.01 USDC)
 *
 * No API token: the agent wallet signs its own realize withdrawals; the
 * seller's x402 payment is fee-sponsored by the seller's facilitator.
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
import { ensureWalletOnboarded } from "../src/client/onboarding.js";
import { createStandardX402Payer } from "../src/client/standard-x402-factory.js";
import { StandardX402PayError } from "../src/client/standard-x402-payer.js";
import { formatRawUsdcAmount } from "../src/client/paid-fetch.js";
import { loadKeyPairSigner, loadSecretKeyBytes } from "../src/solana/keys.js";
import { createRpc } from "../src/solana/rpc.js";

const TOOL_NAME = "fetch_with_subly_payment";
const DEFAULT_MAX_AMOUNT_RAW_USDC = 10_000n; // 0.01 USDC

const facilitatorBaseUrl =
  process.env.SUBLY_FACILITATOR_URL ?? "https://api.demo.sublyfi.com";
const rpcUrl =
  process.env.SOLANA_RPC_URL ?? "https://api.mainnet-beta.solana.com";
const defaultMaxAmountRawUsdc =
  process.env.SUBLY_MCP_MAX_AMOUNT_RAW_USDC === undefined
    ? DEFAULT_MAX_AMOUNT_RAW_USDC
    : BigInt(process.env.SUBLY_MCP_MAX_AMOUNT_RAW_USDC);

const keyPairSigner = await loadKeyPairSigner({
  base58Secret: process.env.SUBLY_DEMO_AGENT_KEYPAIR,
  jsonFilePath: process.env.SUBLY_DEMO_AGENT_KEYPAIR_PATH,
  label: "SUBLY_DEMO_AGENT_KEYPAIR"
});
const agentSecretKey = loadSecretKeyBytes({
  base58Secret: process.env.SUBLY_DEMO_AGENT_KEYPAIR,
  jsonFilePath: process.env.SUBLY_DEMO_AGENT_KEYPAIR_PATH,
  label: "SUBLY_DEMO_AGENT_KEYPAIR"
});
const signer = new LocalKeypairAgentWalletSigner(keyPairSigner);
const rpc = createRpc(rpcUrl);

const payer = createStandardX402Payer({
  facilitatorBaseUrl,
  signer,
  agentSecretKey,
  rpc,
  rpcUrl,
  defaultMaxAmountRawUsdc
});

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

Then use fetch_with_subly_payment(url) to GET a paid resource from any x402 \
seller (e.g. Nansen): it realizes just enough yield to the agent's USDC ATA \
and pays the seller's standard x402 challenge, returning the body plus the \
payment details. If it returns insufficient_yield, that is expected — wait \
for yield, do not loop.`;

const server = new Server(
  { name: "subly-payments", version: "0.2.0" },
  { capabilities: { tools: {} }, instructions: SERVER_INSTRUCTIONS }
);

server.setRequestHandler(ListToolsRequestSchema, () => ({
  tools: [
    {
      name: TOOL_NAME,
      description:
        "Fetch a URL (GET or POST), automatically paying a standard x402 " +
        "(HTTP 402) challenge " +
        "from any x402-compatible seller (Nansen, etc.) out of the agent " +
        "wallet's Kamino vault yield. Subly realizes just enough yield to the " +
        "agent's USDC ATA (sponsored) and pays the seller's Solana USDC " +
        "`exact` challenge; the seller needs no Subly integration. Returns the " +
        "response body and, when a payment was made, the payment details " +
        "(amount, payee, realize tx). Challenges above maxAmountRawUsdc " +
        `(default ${defaultMaxAmountRawUsdc} raw = ${formatRawUsdcAmount(
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
              "HTTP method (default GET). Some x402 sellers deliver the paid " +
              "resource over POST (e.g. an API that takes a JSON query body)."
          },
          body: {
            type: "string",
            description:
              "Request body sent on both the probe and the paid retry. Provide " +
              "a JSON string for POST sellers; sent as content-type " +
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
              "Refuse (without paying) any challenge above this amount in raw " +
              "USDC units (6 decimals, e.g. \"10000\" = 0.01 USDC). Defaults " +
              "to the server-side cap."
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

  const method = typeof args.method === "string" ? args.method : undefined;
  const body = typeof args.body === "string" ? args.body : undefined;
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
      ...(maxAmountRawUsdc === undefined ? {} : { maxAmountRawUsdc })
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
