import { timingSafeEqual } from "node:crypto";
import Fastify from "fastify";
import type { FastifyReply, FastifyRequest } from "fastify";
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
import { unavailable } from "../domain/errors.js";
import type { ChainWalletSyncService } from "../domain/chain-wallet-sync.js";
import { OperationalMetrics, TRACKED_ERROR_CODES } from "../domain/metrics.js";
import type { VaultFlowService } from "../domain/vault-flow-service.js";
import {
  chainSyncWalletPositionSchema,
  liquidityPolicySchema,
  prepareDepositSchema,
  preparePaymentSchema,
  prepareWithdrawalSchema,
  recoverSettlementsSchema,
  registerAgentWalletSchema,
  submitDepositSchema,
  submitWithdrawalSchema,
  syncWalletPositionSchema,
  verifyPaymentPayloadSchema
} from "./schemas.js";

export interface SponsorMonitoring {
  sponsorAddress: string;
  getSponsorBalanceLamports: () => Promise<bigint>;
  minSponsorBalanceLamports: bigint;
}

export interface ServerOptions {
  sellerApiToken?: string | null;
  clientApiToken?: string | null;
  adminApiToken?: string | null;
  vaultFlowService?: VaultFlowService | null;
  chainWalletSync?: ChainWalletSyncService | null;
  sponsorMonitoring?: SponsorMonitoring | null;
  metrics?: OperationalMetrics | undefined;
}

export function buildServer(
  service: SublyService = defaultSublyService(),
  options: ServerOptions = {}
) {
  const vaultFlowService = options.vaultFlowService ?? null;
  const chainWalletSync = options.chainWalletSync ?? null;
  const sponsorMonitoring = options.sponsorMonitoring ?? null;
  const metrics = options.metrics ?? new OperationalMetrics();
  const server = Fastify({
    logger: true
  });
  const sellerToken =
    options.sellerApiToken ?? process.env.SUBLY_SELLER_API_TOKEN ?? null;
  const clientToken =
    options.clientApiToken ?? process.env.SUBLY_CLIENT_API_TOKEN ?? null;
  const adminToken =
    options.adminApiToken ?? process.env.SUBLY_ADMIN_API_TOKEN ?? null;
  assertDistinctRoleTokens({
    seller: sellerToken,
    client: clientToken,
    admin: adminToken
  });
  const requireSellerAuth = bearerAuthPreHandler(
    [sellerToken],
    "seller",
    "SUBLY_SELLER_API_TOKEN"
  );
  const requireClientAuth = bearerAuthPreHandler(
    [clientToken],
    "client",
    "SUBLY_CLIENT_API_TOKEN"
  );
  const requireAdminAuth = bearerAuthPreHandler(
    [adminToken],
    "admin",
    "SUBLY_ADMIN_API_TOKEN"
  );
  // Flow status polling is part of the agent's own deposit/withdraw flow.
  const requireClientOrAdminAuth = bearerAuthPreHandler(
    [clientToken, adminToken],
    "client",
    "SUBLY_CLIENT_API_TOKEN"
  );

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

  server.post(
    "/v1/wallets/agent",
    { preHandler: requireAdminAuth },
    async (request) => {
      const body = registerAgentWalletSchema.parse(request.body);
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
    { preHandler: requireAdminAuth },
    async (request) => {
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
    { preHandler: requireAdminAuth },
    async (request) =>
      service.getBudget(request.params.wallet, request.query.vault)
  );

  server.post(
    "/v1/payments/prepare",
    { preHandler: requireClientAuth },
    async (request) => {
      const body = preparePaymentSchema.parse(request.body);
      return service.preparePayment(body);
    }
  );

  server.get<{
    Params: { paymentId: string };
  }>(
    "/v1/payments/:paymentId",
    { preHandler: requireAdminAuth },
    async (request) => service.getPayment(request.params.paymentId)
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
    { preHandler: requireClientAuth },
    async (request) => {
      const body = prepareDepositSchema.parse(request.body);
      return requireVaultFlows().prepareDeposit(body);
    }
  );

  server.post(
    "/v1/deposits/submit",
    { preHandler: requireClientAuth },
    async (request) => {
      const body = submitDepositSchema.parse(request.body);
      return requireVaultFlows().submitDeposit(body);
    }
  );

  server.get<{
    Params: { depositId: string };
  }>(
    "/v1/deposits/:depositId",
    { preHandler: requireClientOrAdminAuth },
    async (request) => requireVaultFlows().getDeposit(request.params.depositId)
  );

  server.post(
    "/v1/withdrawals/prepare",
    { preHandler: requireClientAuth },
    async (request) => {
      const body = prepareWithdrawalSchema.parse(request.body);
      return requireVaultFlows().prepareWithdrawal(body);
    }
  );

  server.post(
    "/v1/withdrawals/submit",
    { preHandler: requireClientAuth },
    async (request) => {
      const body = submitWithdrawalSchema.parse(request.body);
      return requireVaultFlows().submitWithdrawal(body);
    }
  );

  server.get<{
    Params: { withdrawalId: string };
  }>(
    "/v1/withdrawals/:withdrawalId",
    { preHandler: requireClientOrAdminAuth },
    async (request) =>
      requireVaultFlows().getWithdrawal(request.params.withdrawalId)
  );

  return server;
}

function bearerAuthPreHandler(
  acceptedTokens: Array<string | null>,
  scope: "seller" | "client" | "admin",
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
  client: string | null;
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
