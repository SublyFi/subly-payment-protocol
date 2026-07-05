import { timingSafeEqual } from "node:crypto";
import Fastify from "fastify";
import type { FastifyReply, FastifyRequest } from "fastify";
import {
  verifyWalletAuth,
  WALLET_AUTH_SIGNED_AT_HEADER,
  WALLET_AUTH_SIGNATURE_HEADER,
  WALLET_AUTH_WALLET_HEADER
} from "./wallet-auth.js";
import { TokenBucketRateLimiter } from "../x402/rate-limit.js";
import { ZodError } from "zod";
import {
  PAYMENT_SCHEME,
  SOLANA_MAINNET_NETWORK,
  SUBLY_VAULT
} from "../config/constants.js";
import {
  defaultSublyService,
  isSublyError,
  type SublyService
} from "../domain/payment-service.js";
import { forbidden, notFound, unavailable } from "../domain/errors.js";
import type { ChainWalletSyncService } from "../domain/chain-wallet-sync.js";
import { OperationalMetrics, TRACKED_ERROR_CODES } from "../domain/metrics.js";
import type { VaultFlowService } from "../domain/vault-flow-service.js";
import type { SpendingMandateService } from "../domain/spending-mandate-service.js";
import {
  approvalDecisionSchema,
  chainSyncWalletPositionSchema,
  completeSetupSessionSchema,
  createSetupSessionSchema,
  liquidityPolicySchema,
  ownerSignedActionSchema,
  prepareDepositSchema,
  preparePaymentSchema,
  prepareWithdrawalSchema,
  recoverSettlementsSchema,
  registerAgentWalletSchema,
  registerMandateSchema,
  reportPaymentSchema,
  submitDepositSchema,
  submitWithdrawalSchema,
  syncWalletPositionSchema,
  verifyPaymentPayloadSchema
} from "./schemas.js";
import {
  approvePageHtml,
  revokePageHtml,
  setupPageHtml
} from "./owner-pages.js";

export interface SponsorMonitoring {
  sponsorAddress: string;
  getSponsorBalanceLamports: () => Promise<bigint>;
  minSponsorBalanceLamports: bigint;
}

export interface ServerOptions {
  sellerApiToken?: string | null;
  adminApiToken?: string | null;
  vaultFlowService?: VaultFlowService | null;
  chainWalletSync?: ChainWalletSyncService | null;
  sponsorMonitoring?: SponsorMonitoring | null;
  mandateService?: SpendingMandateService | null;
  metrics?: OperationalMetrics | undefined;
  /** Per-IP request rate (per minute) for non-health endpoints; 0 disables. */
  apiRatePerMinute?: number | undefined;
  trustProxy?: boolean | undefined;
  /**
   * Serves the RETIRED seller-side `subly-yield-exact` endpoints
   * (/v1/x402/supported|verify|settle). The Subly relayer is a buyer-side
   * vault/budget/yield-realize API — it is NOT an x402 facilitator (sellers
   * choose their own, e.g. PayAI/CDP) — so these stay off unless explicitly
   * re-enabled for legacy experiments (env SUBLY_ENABLE_LEGACY_X402=1).
   */
  enableLegacySellerApi?: boolean | undefined;
}

declare module "fastify" {
  interface FastifyRequest {
    /** Raw request body bytes as received; basis for wallet-auth signatures. */
    rawBodyString?: string;
    /** Wallet authenticated via x-subly-* signature headers, when present. */
    authedWallet?: string;
    /** True when the request authenticated with the admin bearer token. */
    authedAsAdmin?: boolean;
  }
}

export function buildServer(
  service: SublyService = defaultSublyService(),
  options: ServerOptions = {}
) {
  const vaultFlowService = options.vaultFlowService ?? null;
  const chainWalletSync = options.chainWalletSync ?? null;
  const sponsorMonitoring = options.sponsorMonitoring ?? null;
  const mandateService = options.mandateService ?? null;
  const metrics = options.metrics ?? new OperationalMetrics();
  const server = Fastify({
    logger: true,
    trustProxy:
      options.trustProxy ?? process.env.SUBLY_TRUST_PROXY === "1"
  });

  // Keep the raw body bytes: wallet-auth signatures cover the exact bytes
  // sent, so re-serializing the parsed body would not be sound.
  server.addContentTypeParser(
    "application/json",
    { parseAs: "string" },
    (request, body, done) => {
      request.rawBodyString = typeof body === "string" ? body : "";
      if (request.rawBodyString.length === 0) {
        done(null, null);
        return;
      }
      try {
        done(null, JSON.parse(request.rawBodyString));
      } catch {
        done(new Error("invalid JSON body"), undefined);
      }
    }
  );

  const sellerToken =
    options.sellerApiToken ?? process.env.SUBLY_SELLER_API_TOKEN ?? null;
  const adminToken =
    options.adminApiToken ?? process.env.SUBLY_ADMIN_API_TOKEN ?? null;
  assertDistinctRoleTokens({
    seller: sellerToken,
    admin: adminToken
  });
  const requireSellerAuth = bearerAuthPreHandler(
    [sellerToken],
    "seller",
    "SUBLY_SELLER_API_TOKEN"
  );
  const requireAdminAuth = bearerAuthPreHandler(
    [adminToken],
    "admin",
    "SUBLY_ADMIN_API_TOKEN"
  );

  const isAdminRequest = (request: FastifyRequest): boolean => {
    const authorization = request.headers.authorization;
    if (adminToken === null || adminToken.length === 0) {
      return false;
    }
    const provided = authorization?.startsWith("Bearer ")
      ? authorization.slice("Bearer ".length)
      : "";
    return constantTimeTokenEqual(provided, adminToken);
  };

  /**
   * Buyer-facing auth: a wallet-signature over (method, path, body, time),
   * or the admin bearer token for operator tooling. Sets request.authedWallet
   * / request.authedAsAdmin for ownership checks in handlers.
   */
  const requireWalletOrAdminAuth = async (
    request: FastifyRequest,
    reply: FastifyReply
  ) => {
    if (isAdminRequest(request)) {
      request.authedAsAdmin = true;
      return;
    }
    const result = verifyWalletAuth({
      wallet: headerValue(request, WALLET_AUTH_WALLET_HEADER),
      signedAt: headerValue(request, WALLET_AUTH_SIGNED_AT_HEADER),
      signature: headerValue(request, WALLET_AUTH_SIGNATURE_HEADER),
      method: request.method,
      path: new URL(request.url, "http://localhost").pathname,
      rawBody: request.rawBodyString ?? ""
    });
    if (!result.ok) {
      reply.status(401).send({
        success: false,
        error: { code: "unauthorized", message: result.reason }
      });
      return;
    }
    request.authedWallet = result.wallet;
  };

  /** Wallet-authed requests may only act on their own wallet. */
  const assertOwnWallet = (request: FastifyRequest, wallet: string): void => {
    if (request.authedAsAdmin === true) {
      return;
    }
    if (request.authedWallet !== wallet) {
      throw forbiddenWalletMismatch();
    }
  };

  const apiRatePerMinute =
    options.apiRatePerMinute ??
    Number(process.env.SUBLY_API_RATE_PER_MIN ?? "240");
  if (apiRatePerMinute > 0) {
    const apiLimiter = new TokenBucketRateLimiter({
      capacity: apiRatePerMinute,
      refillPerSecond: apiRatePerMinute / 60
    });
    server.addHook("onRequest", async (request, reply) => {
      if (request.url === "/healthz") {
        return;
      }
      if (!apiLimiter.tryTake(request.ip)) {
        reply
          .status(429)
          .header(
            "retry-after",
            String(Math.max(1, apiLimiter.retryAfterSeconds(request.ip)))
          )
          .send({
            success: false,
            error: {
              code: "rate_limited",
              message: "Too many requests; retry shortly"
            }
          });
      }
    });
  }

  server.setErrorHandler((error, _request, reply) => {
    if (isSublyError(error)) {
      if (TRACKED_ERROR_CODES.has(error.code)) {
        metrics.increment(`error_${error.code}`);
      }
      reply.status(error.httpStatus).send({
        success: false,
        error: {
          code: error.code,
          message: error.message,
          details: error.details
        }
      });
      return;
    }

    if (error instanceof ZodError) {
      reply.status(400).send({
        success: false,
        error: {
          code: "invalid_request",
          message: "Request validation failed",
          details: error.issues
        }
      });
      return;
    }

    server.log.error(error);
    reply.status(500).send({
      success: false,
      error: {
        code: "internal_error",
        message: "Internal server error"
      }
    });
  });

  server.get("/healthz", async () => ({
    ok: true
  }));

  const enableLegacySellerApi =
    options.enableLegacySellerApi ??
    process.env.SUBLY_ENABLE_LEGACY_X402 === "1";
  if (enableLegacySellerApi) {
    server.get("/v1/x402/supported", async () => ({
      accepts: [
        {
          scheme: PAYMENT_SCHEME,
          network: SOLANA_MAINNET_NETWORK,
          asset: SUBLY_VAULT.usdcMint,
          vault: SUBLY_VAULT.address,
          shareMint: SUBLY_VAULT.shareMint,
          maxTimeoutSeconds: 120
        }
      ]
    }));

    server.post(
      "/v1/x402/verify",
      { preHandler: requireSellerAuth },
      async (request) => {
        const body = verifyPaymentPayloadSchema.parse(request.body);
        return service.verifyPaymentPayload(body);
      }
    );

    server.post(
      "/v1/x402/settle",
      { preHandler: requireSellerAuth },
      async (request) => {
        const body = verifyPaymentPayloadSchema.parse(request.body);
        const startedAtMs = Date.now();
        try {
          const response = await service.settlePaymentPayload(body);
          metrics.observeSettlementLatencyMs(Date.now() - startedAtMs);
          metrics.increment(
            isSuccessfulSettlement(response)
              ? "settlement_settled"
              : "settlement_not_settled"
          );
          return response;
        } catch (error) {
          metrics.observeSettlementLatencyMs(Date.now() - startedAtMs);
          metrics.increment("settlement_error");
          throw error;
        }
      }
    );
  }

  // Self-serve: a wallet registers (and activates) itself by signing the
  // request with its own key — no operator allowlisting.
  server.post(
    "/v1/wallets/agent",
    { preHandler: requireWalletOrAdminAuth },
    async (request) => {
      const body = registerAgentWalletSchema.parse(request.body);
      assertOwnWallet(request, body.wallet);
      return service.registerAgentWallet(body);
    }
  );

  server.post<{
    Params: { wallet: string };
  }>(
    "/v1/wallets/:wallet/signing-policy",
    { preHandler: requireAdminAuth },
    async (request) => {
      const body = registerAgentWalletSchema
        .omit({ wallet: true })
        .parse(request.body);
      return service.registerAgentWallet({
        wallet: request.params.wallet,
        ...body
      });
    }
  );

  server.post<{
    Params: { wallet: string };
  }>(
    "/v1/wallets/:wallet/sync",
    { preHandler: requireWalletOrAdminAuth },
    async (request) => {
      assertOwnWallet(request, request.params.wallet);
      const chainSyncRequest = chainSyncWalletPositionSchema.safeParse(
        request.body
      );
      if (chainSyncRequest.success) {
        if (chainWalletSync === null) {
          throw unavailable(
            "chain_sync_unavailable",
            "On-chain wallet sync requires SOLANA_RPC_URL to be configured"
          );
        }
        return chainWalletSync.syncFromChain({
          wallet: request.params.wallet,
          forceConservativeReset: chainSyncRequest.data.forceConservativeReset
        });
      }

      // Manual syncs assert arbitrary position numbers (shares, exchange
      // rate, basis); a wallet attesting its own yield is exactly what the
      // budget model must prevent, so only the operator may do this.
      if (request.authedAsAdmin !== true) {
        throw forbidden(
          "admin_required",
          "Manual position sync is operator-only; use {\"source\":\"chain\"}"
        );
      }
      const body = syncWalletPositionSchema.parse(request.body);
      return service.syncWalletPosition({
        wallet: request.params.wallet,
        ...body
      });
    }
  );

  server.post(
    "/v1/admin/liquidity-policies",
    { preHandler: requireAdminAuth },
    async (request) => {
      const body = liquidityPolicySchema.parse(request.body);
      return service.upsertLiquidityPolicy(body);
    }
  );

  server.get(
    "/v1/admin/liquidity-policies",
    { preHandler: requireAdminAuth },
    async () => service.listLiquidityPolicies()
  );

  server.get<{
    Params: { wallet: string };
    Querystring: { vault?: string };
  }>(
    "/v1/wallets/:wallet/budget",
    { preHandler: requireWalletOrAdminAuth },
    async (request) => {
      assertOwnWallet(request, request.params.wallet);
      return service.getBudget(request.params.wallet, request.query.vault);
    }
  );

  server.post(
    "/v1/payments/prepare",
    { preHandler: requireWalletOrAdminAuth },
    async (request) => {
      const body = preparePaymentSchema.parse(request.body);
      assertOwnWallet(request, body.wallet);
      return service.preparePayment(body);
    }
  );

  server.get<{
    Params: { paymentId: string };
  }>(
    "/v1/payments/:paymentId",
    { preHandler: requireWalletOrAdminAuth },
    async (request) => {
      const payment = (await service.getPayment(
        request.params.paymentId
      )) as { wallet?: string };
      // Wallet-authed callers may only see their own payments; report
      // not-found rather than confirming foreign payment ids exist.
      if (
        request.authedAsAdmin !== true &&
        payment.wallet !== request.authedWallet
      ) {
        throw notFound("payment_not_found", "Payment intent does not exist");
      }
      return payment;
    }
  );

  server.post(
    "/v1/admin/settlements/recover",
    { preHandler: requireAdminAuth },
    async (request) => {
      const body = recoverSettlementsSchema.parse(request.body ?? {});
      return service.recoverPendingSettlements(body.limit);
    }
  );

  server.get<{
    Params: { wallet: string };
    Querystring: { vault?: string; limit?: string };
  }>(
    "/v1/wallets/:wallet/sync-events",
    { preHandler: requireAdminAuth },
    async (request) => {
      const limit = request.query.limit === undefined
        ? undefined
        : Number.parseInt(request.query.limit, 10);
      return service.listSyncEvents(
        request.params.wallet,
        request.query.vault,
        limit !== undefined && Number.isSafeInteger(limit) && limit > 0
          ? Math.min(limit, 1000)
          : undefined
      );
    }
  );

  server.get(
    "/v1/admin/monitoring",
    { preHandler: requireAdminAuth },
    async () => {
      let sponsor: {
        address: string;
        balanceLamports: string;
        minBalanceLamports: string;
        belowMinimum: boolean;
      } | null = null;
      if (sponsorMonitoring !== null) {
        const balanceLamports =
          await sponsorMonitoring.getSponsorBalanceLamports();
        const belowMinimum =
          balanceLamports < sponsorMonitoring.minSponsorBalanceLamports;
        if (belowMinimum) {
          server.log.error(
            {
              sponsor: sponsorMonitoring.sponsorAddress,
              balanceLamports: balanceLamports.toString(),
              minBalanceLamports:
                sponsorMonitoring.minSponsorBalanceLamports.toString()
            },
            "Sponsor SOL balance is below the configured minimum"
          );
        }
        sponsor = {
          address: sponsorMonitoring.sponsorAddress,
          balanceLamports: balanceLamports.toString(),
          minBalanceLamports:
            sponsorMonitoring.minSponsorBalanceLamports.toString(),
          belowMinimum
        };
      }

      return {
        metrics: metrics.snapshot(),
        sponsor
      };
    }
  );

  const requireVaultFlows = (): VaultFlowService => {
    if (vaultFlowService === null) {
      throw unavailable(
        "vault_flows_unavailable",
        "Deposit and withdrawal flows require Solana RPC and sponsor signer configuration"
      );
    }
    return vaultFlowService;
  };

  server.post(
    "/v1/deposits/prepare",
    { preHandler: requireWalletOrAdminAuth },
    async (request) => {
      const body = prepareDepositSchema.parse(request.body);
      assertOwnWallet(request, body.wallet);
      return requireVaultFlows().prepareDeposit(body);
    }
  );

  // Submit ownership is enforced by the flow itself: the transaction must
  // carry a valid signature from the intent's wallet, so the wallet-auth
  // here only gates abuse, not ownership.
  server.post(
    "/v1/deposits/submit",
    { preHandler: requireWalletOrAdminAuth },
    async (request) => {
      const body = submitDepositSchema.parse(request.body);
      return requireVaultFlows().submitDeposit(body);
    }
  );

  server.get<{
    Params: { depositId: string };
  }>(
    "/v1/deposits/:depositId",
    { preHandler: requireWalletOrAdminAuth },
    async (request) => {
      const deposit = (await requireVaultFlows().getDeposit(
        request.params.depositId
      )) as { wallet?: string };
      if (
        request.authedAsAdmin !== true &&
        deposit.wallet !== request.authedWallet
      ) {
        throw notFound("deposit_not_found", "Deposit intent does not exist");
      }
      return deposit;
    }
  );

  server.post(
    "/v1/withdrawals/prepare",
    { preHandler: requireWalletOrAdminAuth },
    async (request) => {
      const body = prepareWithdrawalSchema.parse(request.body);
      assertOwnWallet(request, body.wallet);
      return requireVaultFlows().prepareWithdrawal(body);
    }
  );

  server.post(
    "/v1/withdrawals/submit",
    { preHandler: requireWalletOrAdminAuth },
    async (request) => {
      const body = submitWithdrawalSchema.parse(request.body);
      return requireVaultFlows().submitWithdrawal(body);
    }
  );

  server.get<{
    Params: { withdrawalId: string };
  }>(
    "/v1/withdrawals/:withdrawalId",
    { preHandler: requireWalletOrAdminAuth },
    async (request) => {
      const withdrawal = (await requireVaultFlows().getWithdrawal(
        request.params.withdrawalId
      )) as { wallet?: string };
      if (
        request.authedAsAdmin !== true &&
        withdrawal.wallet !== request.authedWallet
      ) {
        throw notFound(
          "withdrawal_not_found",
          "Withdrawal intent does not exist"
        );
      }
      return withdrawal;
    }
  );

  // ------------------------------------------------------- spending mandate
  //
  // Registration, revocation, and approval decisions are authorized by the
  // SIGNATURES INSIDE the submitted documents (the owner credential), not by
  // transport auth — the owner signs on their own device and the document can
  // arrive over any channel (web page, CLI). Reads stay wallet/admin-authed.

  const requireMandates = (): SpendingMandateService => {
    if (mandateService === null) {
      throw unavailable(
        "mandate_unavailable",
        "Spending-mandate endpoints are not configured on this server"
      );
    }
    return mandateService;
  };

  server.put<{
    Params: { wallet: string };
  }>("/v1/wallets/:wallet/mandate", async (request) => {
    const document = registerMandateSchema.parse(request.body);
    return requireMandates().registerMandate({
      wallet: request.params.wallet,
      vault: SUBLY_VAULT.address,
      document
    });
  });

  server.get<{
    Params: { wallet: string };
  }>(
    "/v1/wallets/:wallet/mandate",
    { preHandler: requireWalletOrAdminAuth },
    async (request) => {
      assertOwnWallet(request, request.params.wallet);
      return requireMandates().getMandate(
        request.params.wallet,
        SUBLY_VAULT.address
      );
    }
  );

  server.post<{
    Params: { wallet: string };
  }>("/v1/wallets/:wallet/mandate/revoke", async (request) => {
    const body = ownerSignedActionSchema.parse(request.body);
    return requireMandates().revokeMandate({
      wallet: request.params.wallet,
      ...body
    });
  });

  // Owner-loss dead-man switch: the AGENT key (wallet-auth) schedules a
  // revoke that only takes effect after the grace window the owner can veto.
  server.post<{
    Params: { wallet: string };
  }>(
    "/v1/wallets/:wallet/mandate/recovery-revoke",
    { preHandler: requireWalletOrAdminAuth },
    async (request) => {
      assertOwnWallet(request, request.params.wallet);
      return requireMandates().scheduleRecoveryRevoke(request.params.wallet);
    }
  );

  server.post<{
    Params: { wallet: string };
  }>("/v1/wallets/:wallet/mandate/recovery-cancel", async (request) => {
    const body = ownerSignedActionSchema.parse(request.body);
    return requireMandates().cancelRecoveryRevoke({
      wallet: request.params.wallet,
      ...body
    });
  });

  server.get<{
    Params: { wallet: string };
    Querystring: { status?: string };
  }>(
    "/v1/wallets/:wallet/approvals",
    { preHandler: requireWalletOrAdminAuth },
    async (request) => {
      assertOwnWallet(request, request.params.wallet);
      return {
        approvals: await requireMandates().listApprovals(
          request.params.wallet,
          request.query.status
        )
      };
    }
  );

  server.post<{
    Params: { approvalId: string };
  }>("/v1/approvals/:approvalId/decision", async (request) => {
    const body = approvalDecisionSchema.parse(request.body);
    return requireMandates().decideApproval({
      approvalId: request.params.approvalId,
      ...body
    });
  });

  server.get<{
    Params: { wallet: string };
    Querystring: { limit?: string };
  }>(
    "/v1/wallets/:wallet/spending-log",
    { preHandler: requireWalletOrAdminAuth },
    async (request) => {
      assertOwnWallet(request, request.params.wallet);
      const limit =
        request.query.limit === undefined
          ? undefined
          : Number.parseInt(request.query.limit, 10);
      return requireMandates().spendingLog(
        request.params.wallet,
        SUBLY_VAULT.address,
        limit !== undefined && Number.isSafeInteger(limit) && limit > 0
          ? Math.min(limit, 1000)
          : undefined
      );
    }
  );

  server.post(
    "/v1/payments/report",
    { preHandler: requireWalletOrAdminAuth },
    async (request) => {
      const body = reportPaymentSchema.parse(request.body);
      assertOwnWallet(request, body.wallet);
      return requireVaultFlows().reportPayment(body);
    }
  );

  // --------------------------------------------------------- setup sessions
  //
  // The AGENT creates a session under wallet-auth (its signature pins the
  // chat-agreed policy + initial deposit) and pastes the returned capability
  // URL into chat. The session endpoints themselves are public: the URL is
  // the authorization, the human's device has no wallet-auth key, and the
  // completion is authorized by the owner signature INSIDE the document.

  server.post<{
    Params: { wallet: string };
  }>(
    "/v1/wallets/:wallet/setup-sessions",
    { preHandler: requireWalletOrAdminAuth },
    async (request) => {
      assertOwnWallet(request, request.params.wallet);
      const body = createSetupSessionSchema.parse(request.body ?? {});
      return requireMandates().createSetupSession({
        wallet: request.params.wallet,
        vault: SUBLY_VAULT.address,
        ...(body.policy === undefined ? {} : { policy: body.policy }),
        ...(body.enforcementMode === undefined
          ? {}
          : { enforcementMode: body.enforcementMode }),
        ...(body.mandateTtlDays === undefined
          ? {}
          : { mandateTtlMs: body.mandateTtlDays * 24 * 60 * 60 * 1000 }),
        ...(body.initialDepositRawUsdc === undefined
          ? {}
          : { initialDepositRawUsdc: body.initialDepositRawUsdc }),
        agentAuth: {
          wallet: headerValue(request, WALLET_AUTH_WALLET_HEADER) ?? null,
          signedAt: headerValue(request, WALLET_AUTH_SIGNED_AT_HEADER) ?? null,
          signature: headerValue(request, WALLET_AUTH_SIGNATURE_HEADER) ?? null,
          admin: request.authedAsAdmin === true
        }
      });
    }
  );

  server.get<{
    Params: { sessionId: string };
  }>("/v1/setup-sessions/:sessionId", async (request) =>
    requireMandates().getSetupSession(request.params.sessionId)
  );

  server.post<{
    Params: { sessionId: string };
  }>("/v1/setup-sessions/:sessionId/complete", async (request) => {
    const body = completeSetupSessionSchema.parse(request.body);
    return requireMandates().completeSetupSession({
      sessionId: request.params.sessionId,
      document: body.document
    });
  });

  // Public capability reads backing the owner pages: the approval id / the
  // wallet address in the link is the authorization to see the summary.
  server.get<{
    Params: { approvalId: string };
  }>("/v1/approvals/:approvalId", async (request) =>
    requireMandates().getApprovalView(request.params.approvalId)
  );

  server.get<{
    Params: { wallet: string };
  }>("/v1/wallets/:wallet/mandate/summary", async (request) =>
    requireMandates().getMandateSummary(request.params.wallet)
  );

  // ------------------------------------------------------------ owner pages
  //
  // Self-contained HTML (no external assets) served by the relayer itself.
  // The pages read their ids from the URL path and talk to the same-origin
  // /v1 API; signing happens on the owner's device (passkey or Phantom).

  const servePage = (reply: FastifyReply, html: string) =>
    reply
      .header("content-type", "text/html; charset=utf-8")
      .header("cache-control", "no-store")
      .send(html);

  server.get("/setup/:sessionId", async (_request, reply) =>
    servePage(reply, setupPageHtml())
  );
  server.get("/approve/:approvalId", async (_request, reply) =>
    servePage(reply, approvePageHtml())
  );
  server.get("/revoke/:wallet", async (_request, reply) =>
    servePage(reply, revokePageHtml())
  );

  return server;
}

function headerValue(
  request: FastifyRequest,
  name: string
): string | undefined {
  const value = request.headers[name];
  return typeof value === "string" ? value : undefined;
}

function forbiddenWalletMismatch() {
  return forbidden(
    "wallet_mismatch",
    "The wallet-auth signature does not belong to the wallet this request acts on"
  );
}

function bearerAuthPreHandler(
  acceptedTokens: Array<string | null>,
  scope: "seller" | "admin",
  envVarName: string
) {
  const configuredTokens = acceptedTokens.filter(
    (token): token is string => token !== null && token.length > 0
  );

  return async (request: FastifyRequest, reply: FastifyReply) => {
    if (configuredTokens.length === 0) {
      reply.status(503).send({
        success: false,
        error: {
          code: `${scope}_auth_not_configured`,
          message: `${envVarName} must be configured for ${scope} endpoints`
        }
      });
      return;
    }

    const authorization = request.headers.authorization;
    const providedToken = authorization?.startsWith("Bearer ")
      ? authorization.slice("Bearer ".length)
      : "";

    // Compare against every configured token so timing does not reveal
    // which role token matched.
    let matched = false;
    for (const expectedToken of configuredTokens) {
      matched = constantTimeTokenEqual(providedToken, expectedToken) || matched;
    }
    if (!matched) {
      reply.status(401).send({
        success: false,
        error: {
          code: "unauthorized",
          message: `Missing or invalid ${scope} bearer token`
        }
      });
      return;
    }
  };
}

/**
 * Role tokens are not interchangeable; configuring the same secret for two
 * scopes silently collapses the scope separation, so it fails closed here.
 */
function assertDistinctRoleTokens(tokens: {
  seller: string | null;
  admin: string | null;
}): void {
  const configured = Object.entries(tokens).filter(
    (entry): entry is [string, string] =>
      entry[1] !== null && entry[1].length > 0
  );
  for (let i = 0; i < configured.length; i += 1) {
    for (let j = i + 1; j < configured.length; j += 1) {
      if (configured[i]![1] === configured[j]![1]) {
        throw new Error(
          `${configured[i]![0]} and ${configured[j]![0]} API tokens must not share the same value`
        );
      }
    }
  }
}

function isSuccessfulSettlement(response: unknown): boolean {
  return (
    typeof response === "object" &&
    response !== null &&
    (response as { success?: unknown }).success === true
  );
}

function constantTimeTokenEqual(provided: string, expected: string): boolean {
  const providedBuffer = Buffer.from(provided);
  const expectedBuffer = Buffer.from(expected);

  return (
    providedBuffer.length === expectedBuffer.length &&
    timingSafeEqual(providedBuffer, expectedBuffer)
  );
}
