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
import { VaultFlowClientError, type VaultFlowClient } from "./vault-flows.js";

/**
 * The Subly MCP payment server, decoupled from any concrete x402 payment
 * library: the caller injects a fully-built StandardX402Payer. The published
 * client supplies a payer backed by the official @x402/svm implementation.
 */
const TOOL_NAME = "fetch_with_subly_payment";
const DEPOSIT_TOOL_NAME = "deposit_to_subly_vault";
const WITHDRAW_TOOL_NAME = "withdraw_from_subly_vault";
const BUDGET_TOOL_NAME = "get_subly_yield_budget";
const SETUP_TOOL_NAME = "create_subly_setup_link";
const SETUP_STATUS_TOOL_NAME = "check_subly_setup";

const SERVER_INSTRUCTIONS = `Subly lets an agent pay standard x402 (HTTP 402) \
paid APIs that offer a Solana USDC exact rail with facilitator feePayer support \
from its wallet's Kamino vault YIELD — the deposited principal is never spent, \
and the seller needs no Subly integration.

One-time setup: the operator needs a Solana keypair for the agent wallet. \
Subly does NOT create wallets; make one with \`solana-keygen new -o \
agent.json\` (or export a keypair from an existing wallet) and point \
SUBLY_DEMO_AGENT_KEYPAIR_PATH at it. The private key never leaves that \
file; this server only signs locally with it. Then fund the wallet with \
USDC on Solana mainnet — no SOL is ever needed, all vault transaction fees \
are sponsored.

Owner (human) onboarding: deposits require the human owner's approval \
(Face ID / wallet signature). During the first deposit conversation, agree \
the spending limits and the first deposit amount in chat, then call \
create_subly_setup_link and paste the returned setupUrl to the user AS IS \
(it expires in 10 minutes). The human opens it on their phone, reviews, and \
confirms once — that single confirmation activates the spending mandate AND \
pre-approves the first deposit. Poll check_subly_setup(sessionId) after the \
user says they finished, then call deposit_to_subly_vault (the pre-approved \
first deposit is picked up automatically).

From there the agent can do everything with these tools:
1. deposit_to_subly_vault(amountRawUsdc) puts wallet USDC into the vault \
(minimum just over 1 USDC, e.g. 1010000 raw) so it starts earning yield. \
If it returns approvalRequired, paste the approveUrl to the user and retry \
with the approvalId after they approve; if it returns setupRequired, run \
the owner onboarding above first.
2. get_subly_yield_budget() shows the principal, position value, and the \
spendable yield a payment can use right now.
3. fetch_with_subly_payment(url) GETs or POSTs a paid resource from a compatible \
x402 seller (e.g. Nansen): it realizes just enough yield to the agent's USDC \
ATA and pays the seller's Solana USDC exact challenge, returning the body plus \
the payment details. If it returns insufficient_yield, that is expected — yield \
accrues over time; wait, do not loop. If it returns approvalRequired (payment \
above the owner's threshold; NOTHING was paid), paste the approveUrl to the \
user, and once they say they approved, repeat the SAME call adding the \
approvalId.
4. withdraw_from_subly_vault(amountRawUsdc) exits: moves vault funds \
(principal included) back to the agent wallet's USDC account. If the owner's \
mandate requires withdrawal approval it returns approvalRequired — same \
paste-approveUrl-then-retry flow as deposits.`;

export interface McpPaymentServerConfig {
  payer: StandardX402Payer;
  signer: AgentWalletSigner;
  /** Subly relayer API base URL; `SUBLY_FACILITATOR_URL` remains a legacy env fallback. */
  relayerBaseUrl: string;
  defaultMaxAmountRawUsdc: bigint;
  /**
   * Sponsored vault flows (deposit / withdraw / budget). When provided, the
   * server exposes them as tools so an agent can complete the whole
   * lifecycle — fund, check yield, pay, exit — without leaving MCP.
   */
  vaultFlows?: VaultFlowClient;
  serverVersion?: string;
}

export async function runMcpPaymentServer(
  config: McpPaymentServerConfig
): Promise<void> {
  const { payer, signer, relayerBaseUrl, defaultMaxAmountRawUsdc } = config;
  const vaultFlows = config.vaultFlows ?? null;

  const server = new Server(
    { name: "subly-payments", version: config.serverVersion ?? "0.3.0" },
    { capabilities: { tools: {} }, instructions: SERVER_INSTRUCTIONS }
  );

  const vaultTools =
    vaultFlows === null
      ? []
      : [
          {
            name: SETUP_TOOL_NAME,
            description:
              "Create the one-time owner setup link for this agent wallet's " +
              "Subly spending mandate. Use during onboarding (the first " +
              "deposit conversation): agree the limits and first deposit in " +
              "chat, call this, and paste the returned setupUrl to the user " +
              "verbatim — it expires in 10 minutes and works once. The human " +
              "opens it on their phone and confirms with Face ID (passkey) " +
              "or a Solana wallet signature; that single confirmation " +
              "activates the mandate AND pre-approves the initial deposit. " +
              "The page is confirm-only: to change values, agree in chat " +
              "and create a new link.",
            inputSchema: {
              type: "object",
              properties: {
                initialDepositRawUsdc: {
                  type: "string",
                  description:
                    "First deposit bundled into the owner's single Face ID " +
                    "(raw USDC, 6 decimals; just over 1 USDC minimum, e.g. " +
                    "\"1010000\"). Strongly recommended: without it the " +
                    "first deposit needs a separate approval."
                },
                approvalThresholdRawUsdc: {
                  type: "string",
                  description:
                    "Payments at or below this run without asking (raw " +
                    "USDC). Default \"1000000\" (1 USDC)."
                },
                perPaymentCapRawUsdc: {
                  type: "string",
                  description:
                    "Absolute per-payment cap even with approval (raw " +
                    "USDC). Default \"10000000\" (10 USDC)."
                },
                dailyApiSpendCapRawUsdc: {
                  type: "string",
                  description:
                    "Rolling 24h API spend cap (raw USDC). Default " +
                    "\"100000000\" (100 USDC)."
                },
                dailyDepositCapRawUsdc: {
                  type: "string",
                  description:
                    "Rolling 24h deposit cap (raw USDC). Default " +
                    "\"3000000000\" (3,000 USDC)."
                },
                mandateTtlDays: {
                  type: "number",
                  description: "Mandate lifetime in days (default 365)."
                }
              }
            },
            annotations: {
              title: "Create Subly owner setup link",
              readOnlyHint: false,
              destructiveHint: false,
              idempotentHint: false,
              openWorldHint: false
            }
          },
          {
            name: SETUP_STATUS_TOOL_NAME,
            description:
              "Check whether the human completed a Subly setup link. Call " +
              "after the user says they finished (or to verify before " +
              "depositing). Returns pending / completed / expired; on " +
              "completed it includes the mandateHash and, when an initial " +
              "deposit was bundled, its pre-approved approvalId (valid ~15 " +
              "minutes — deposit promptly).",
            inputSchema: {
              type: "object",
              properties: {
                sessionId: {
                  type: "string",
                  description: "The sessionId returned by create_subly_setup_link."
                }
              },
              required: ["sessionId"]
            },
            annotations: {
              title: "Check Subly setup status",
              readOnlyHint: true,
              destructiveHint: false,
              idempotentHint: true,
              openWorldHint: false
            }
          },
          {
            name: DEPOSIT_TOOL_NAME,
            description:
              "Deposit USDC from the agent wallet into the Subly/Kamino vault " +
              "so it starts earning the yield that funds x402 payments. The " +
              "transaction fee is sponsored — the agent wallet needs USDC " +
              "only, never SOL. The vault minimum is just over 1 USDC: " +
              "share rounding refuses exactly 1000000 raw, so deposit e.g. " +
              "1010000 (1.01 USDC) or more. The deposited amount becomes " +
              "protected principal: payments can only ever spend the yield " +
              "on top of it. Deposits require the human owner's approval: " +
              "a pre-approved amount (e.g. the setup link's initial deposit) " +
              "is used automatically; otherwise the result contains an " +
              "approveUrl — paste it to the user and retry with the " +
              "approvalId once they approve. setupRequired means the owner " +
              "onboarding (create_subly_setup_link) must happen first.",
            inputSchema: {
              type: "object",
              properties: {
                amountRawUsdc: {
                  type: "string",
                  description:
                    "Amount to deposit in raw USDC units (6 decimals, e.g. " +
                    "\"1010000\" = 1.01 USDC). Must exceed the 1 USDC vault " +
                    "minimum by a small rounding margin."
                },
                approvalId: {
                  type: "string",
                  description:
                    "Owner approval id (apr_...) from a previous " +
                    "approvalRequired result or check_subly_setup, after " +
                    "the human approved."
                }
              },
              required: ["amountRawUsdc"]
            },
            annotations: {
              title: "Deposit into the Subly vault",
              readOnlyHint: false,
              destructiveHint: false,
              idempotentHint: false,
              openWorldHint: false
            }
          },
          {
            name: WITHDRAW_TOOL_NAME,
            description:
              "Withdraw USDC from the Subly/Kamino vault back to the agent " +
              "wallet's USDC account (fee sponsored, no SOL needed). This is " +
              "the exit path and may spend PRINCIPAL — it reduces the " +
              "deposit that earns yield. Limited to the vault's instant " +
              "liquidity. If the owner's mandate requires withdrawal " +
              "approval, the result contains an approveUrl — paste it to " +
              "the user and retry with the approvalId once they approve.",
            inputSchema: {
              type: "object",
              properties: {
                amountRawUsdc: {
                  type: "string",
                  description:
                    "Amount to withdraw in raw USDC units (6 decimals, e.g. " +
                    "\"1000000\" = 1 USDC)."
                },
                approvalId: {
                  type: "string",
                  description:
                    "Owner approval id (apr_...) from a previous " +
                    "approvalRequired result, after the human approved."
                }
              },
              required: ["amountRawUsdc"]
            },
            annotations: {
              title: "Withdraw from the Subly vault",
              readOnlyHint: false,
              destructiveHint: true,
              idempotentHint: false,
              openWorldHint: false
            }
          },
          {
            name: BUDGET_TOOL_NAME,
            description:
              "Show the agent wallet's Subly vault budget: protected " +
              "principal, current position value, and the spendable yield " +
              "available for x402 payments right now. Syncs the position " +
              "from chain first, so newly accrued yield is included.",
            inputSchema: { type: "object", properties: {} },
            annotations: {
              title: "Get Subly yield budget",
              readOnlyHint: true,
              destructiveHint: false,
              idempotentHint: true,
              openWorldHint: false
            }
          }
        ];

  server.setRequestHandler(ListToolsRequestSchema, () => ({
    tools: [
      ...vaultTools,
      {
        name: TOOL_NAME,
        description:
          "Fetch a URL (GET or POST), automatically paying a standard x402 " +
          "(HTTP 402) challenge from a seller that offers Solana USDC `exact` " +
          "with `extra.feePayer` (Nansen, etc.) out of the agent wallet's " +
          "Kamino vault yield. Subly realizes just enough yield to the agent's " +
          "USDC ATA (sponsored) and pays the seller's challenge; the seller needs no Subly " +
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
            },
            approvalId: {
              type: "string",
              description:
                "Owner approval id (apr_...) from a previous approvalRequired " +
                "result. After the human approves via the approveUrl, repeat " +
                "the SAME call with this added."
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

  const textResult = (value: unknown, isError = false) => ({
    content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }],
    ...(isError ? { isError: true } : {})
  });

  const vaultFlowFailure = (error: unknown) => {
    if (error instanceof VaultFlowClientError) {
      return textResult(
        { ok: false, step: error.step, message: error.message },
        true
      );
    }
    return {
      content: [
        {
          type: "text" as const,
          text: error instanceof Error ? error.message : String(error)
        }
      ],
      isError: true
    };
  };

  const parseRawAmount = (value: unknown): bigint | null => {
    if (typeof value !== "string" && typeof value !== "number") {
      return null;
    }
    try {
      const amount = BigInt(value);
      return amount > 0n ? amount : null;
    } catch {
      return null;
    }
  };

  /**
   * Presents a deposit/withdrawal outcome to the agent. "submitted" means the
   * transaction may still confirm — the message must steer the agent away
   * from resubmitting (which would move funds twice once the first confirms).
   */
  const vaultFlowOutcome = (
    outcome: { status: string; txSignature: string | null },
    amountField: Record<string, string>
  ) => {
    const solscanUrl =
      outcome.txSignature === null
        ? null
        : `https://solscan.io/tx/${outcome.txSignature}`;
    if (outcome.status === "submitted") {
      return textResult(
        {
          ...outcome,
          ...amountField,
          solscanUrl,
          stillConfirming: true,
          warning:
            "the transaction was broadcast but had not confirmed before the " +
            "poll timeout. Do NOT submit this deposit/withdrawal again — it " +
            "may still confirm and moving the funds twice is not what the " +
            "user asked for. Check get_subly_yield_budget in a minute, or " +
            "the solscanUrl."
        },
        true
      );
    }
    return textResult(
      { ...outcome, ...amountField, solscanUrl },
      outcome.status !== "confirmed"
    );
  };

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const vaultToolNames: string[] = [
      BUDGET_TOOL_NAME,
      DEPOSIT_TOOL_NAME,
      WITHDRAW_TOOL_NAME,
      SETUP_TOOL_NAME,
      SETUP_STATUS_TOOL_NAME
    ];
    if (vaultFlows !== null && vaultToolNames.includes(request.params.name)) {
      // Registration + chain sync are idempotent, and any MONEY-MOVING tool
      // may be the wallet's first relayer interaction (best-effort: the flow
      // itself reports wallet_not_registered if this fails). The setup tools
      // only talk to the relayer's mandate layer — no RPC round trip needed,
      // and check_subly_setup is polled.
      const needsChainSync =
        request.params.name !== SETUP_TOOL_NAME &&
        request.params.name !== SETUP_STATUS_TOOL_NAME;
      if (needsChainSync) {
        try {
          await ensureWalletOnboarded({ relayerBaseUrl, signer });
        } catch {
          // fall through to the flow's own error reporting
        }
      }
      const args = request.params.arguments ?? {};

      if (request.params.name === BUDGET_TOOL_NAME) {
        try {
          const budget = await vaultFlows.getBudget();
          return textResult({
            ...budget,
            principalUsdc: formatRawUsdcAmount(
              BigInt(budget.principalBasisRawUsdc)
            ),
            positionValueUsdc: formatRawUsdcAmount(
              BigInt(budget.positionValueRawUsdc)
            ),
            spendableYieldUsdc: formatRawUsdcAmount(
              BigInt(budget.spendableYieldRawUsdc)
            )
          });
        } catch (error) {
          return vaultFlowFailure(error);
        }
      }

      if (request.params.name === SETUP_TOOL_NAME) {
        try {
          const policy: Record<string, string> = {};
          for (const key of [
            "approvalThresholdRawUsdc",
            "perPaymentCapRawUsdc",
            "dailyApiSpendCapRawUsdc",
            "dailyDepositCapRawUsdc"
          ] as const) {
            const value = args[key];
            if (typeof value === "string" && value.length > 0) {
              policy[key] = value;
            }
          }
          const created = await vaultFlows.createSetupSession({
            ...(Object.keys(policy).length === 0 ? {} : { policy }),
            ...(typeof args.mandateTtlDays === "number"
              ? { mandateTtlDays: args.mandateTtlDays }
              : {}),
            ...(typeof args.initialDepositRawUsdc === "string"
              ? { initialDepositRawUsdc: args.initialDepositRawUsdc }
              : {})
          });
          return textResult({
            ...created,
            instructions:
              "Paste setupUrl to the user verbatim (expires in 10 minutes, " +
              "single-use). After they confirm on their device, call " +
              `${SETUP_STATUS_TOOL_NAME} with this sessionId; when completed, ` +
              "run the first deposit — its approval is picked up automatically."
          });
        } catch (error) {
          return vaultFlowFailure(error);
        }
      }

      if (request.params.name === SETUP_STATUS_TOOL_NAME) {
        const sessionId = args.sessionId;
        if (typeof sessionId !== "string" || sessionId.length === 0) {
          return textResult(
            { ok: false, message: "missing required argument: sessionId" },
            true
          );
        }
        try {
          return textResult(await vaultFlows.getSetupSession(sessionId));
        } catch (error) {
          return vaultFlowFailure(error);
        }
      }

      const amountRawUsdc = parseRawAmount(args.amountRawUsdc);
      if (amountRawUsdc === null) {
        return textResult(
          {
            ok: false,
            message:
              "amountRawUsdc must be a positive integer raw USDC amount " +
              "(6 decimals, e.g. \"1000000\" = 1 USDC)"
          },
          true
        );
      }
      const flowApprovalId =
        typeof args.approvalId === "string" && args.approvalId.length > 0
          ? args.approvalId
          : undefined;
      try {
        if (request.params.name === DEPOSIT_TOOL_NAME) {
          const outcome = await vaultFlows.deposit({
            amountRawUsdc,
            ...(flowApprovalId === undefined ? {} : { approvalId: flowApprovalId })
          });
          return vaultFlowOutcome(outcome, {
            depositedUsdc: formatRawUsdcAmount(
              BigInt(outcome.actualDepositRawUsdc ?? "0")
            )
          });
        }
        const outcome = await vaultFlows.withdraw({
          amountRawUsdc,
          ...(flowApprovalId === undefined ? {} : { approvalId: flowApprovalId })
        });
        return vaultFlowOutcome(outcome, {
          withdrawnUsdc: formatRawUsdcAmount(
            BigInt(outcome.actualWithdrawRawUsdc ?? "0")
          )
        });
      } catch (error) {
        // Owner-approval escalations are protocol steps, not failures: hand
        // the agent a structured next action (paste link -> retry with id).
        if (error instanceof VaultFlowClientError) {
          const details = (error.errorDetails ?? {}) as {
            approvalId?: string;
            approveUrl?: string;
            expiresAtMs?: number;
          };
          if (
            error.code === "deposit_approval_required" ||
            error.code === "withdrawal_approval_required"
          ) {
            const op =
              error.code === "deposit_approval_required" ? "deposit" : "withdrawal";
            return textResult({
              ok: false,
              approvalRequired: true,
              approvalId: details.approvalId ?? null,
              approveUrl: details.approveUrl ?? null,
              expiresAtMs: details.expiresAtMs ?? null,
              message:
                `This ${op} needs the owner's approval. Paste approveUrl ` +
                "to the user; once they approve (Face ID / wallet sign), " +
                `retry the same ${op} adding the approvalId.`
            });
          }
          if (error.code === "mandate_required_for_deposit") {
            return textResult({
              ok: false,
              setupRequired: true,
              message:
                "Deposits require a registered owner. Run the onboarding: " +
                `agree limits + first deposit in chat, call ${SETUP_TOOL_NAME}, ` +
                "and paste the setupUrl to the user. The setup's initial " +
                "deposit is pre-approved with the same single Face ID."
            });
          }
        }
        return vaultFlowFailure(error);
      }
    }

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
    const approvalId =
      typeof args.approvalId === "string" && args.approvalId.length > 0
        ? args.approvalId
        : undefined;
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
        ...(forceNewPayment ? { forceNewPayment } : {}),
        ...(approvalId === undefined ? {} : { approvalId })
      });
      return {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }]
      };
    } catch (error) {
      // Above-threshold payments are a protocol step, not a failure: nothing
      // was paid; the agent pastes the link and retries with the approvalId.
      if (
        error instanceof StandardX402PayError &&
        error.reason === "approval_required"
      ) {
        const details = (error.detail ?? {}) as {
          approvalId?: string;
          approveUrl?: string;
          expiresAtMs?: number;
        };
        return textResult({
          paid: false,
          approvalRequired: true,
          approvalId: details.approvalId ?? null,
          approveUrl: details.approveUrl ?? null,
          expiresAtMs: details.expiresAtMs ?? null,
          message:
            "This payment exceeds the owner's approval threshold — NOTHING " +
            "was paid. Paste approveUrl to the user; once they approve, " +
            "repeat the SAME call adding the approvalId."
        });
      }
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
    await ensureWalletOnboarded({ relayerBaseUrl, signer });
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
    `[subly-mcp] ready: agent wallet ${signer.walletAddress}, relayer ${relayerBaseUrl}, ` +
      `default cap ${formatRawUsdcAmount(defaultMaxAmountRawUsdc)} USDC`
  );
}
