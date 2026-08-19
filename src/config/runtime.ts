import type { FastifyBaseLogger } from "fastify";
import type { ServerOptions } from "../api/server.js";
import { isProductionEnv } from "./env.js";
import { ChainWalletSyncService } from "../domain/chain-wallet-sync.js";
import type { Ledger } from "../domain/ledger.js";
import { feeEstimatorFromEnv, type FeeEstimator } from "../domain/fee-estimator.js";
import { KaminoCanonicalTransactionBuilder } from "../domain/kamino-transaction-builder.js";
import { KaminoSettlementSubmitter } from "../domain/kamino-settlement-submitter.js";
import {
  defaultSublyService,
  SublyService
} from "../domain/payment-service.js";
import { PythHermesFeeEstimator } from "../domain/pyth-fee-estimator.js";
import { SpendingMandateService } from "../domain/spending-mandate-service.js";
import { parseMandateEnforcementLevel } from "../domain/spending-mandate.js";
import { VaultFlowService } from "../domain/vault-flow-service.js";
import { KaminoApiClient } from "../kamino/api-client.js";
import { KaminoVaultAdapter } from "../kamino/vault-adapter.js";
import { loadKeyPairSigner } from "../solana/keys.js";
import { createRpcFromEnv } from "../solana/rpc.js";
import { TransactionSubmissionEngine } from "../solana/submission.js";
import { SUBLY_VAULT } from "./constants.js";

export interface SublyRuntime {
  service: SublyService;
  serverOptions: ServerOptions;
  mode: "mainnet" | "detached";
}

/**
 * Builds the full mainnet runtime when Solana RPC and the sponsor keypair are
 * configured; otherwise returns the detached domain-only service (development
 * and unit tests). Production refuses to start detached via the service's own
 * fail-closed checks.
 */
export async function createSublyRuntime(
  env: NodeJS.ProcessEnv = process.env,
  logger?: FastifyBaseLogger
): Promise<SublyRuntime> {
  const hasRpc = env.SOLANA_RPC_URL !== undefined && env.SOLANA_RPC_URL.length > 0;
  const hasSponsor =
    (env.SUBLY_SPONSOR_KEYPAIR !== undefined &&
      env.SUBLY_SPONSOR_KEYPAIR.length > 0) ||
    (env.SUBLY_SPONSOR_KEYPAIR_PATH !== undefined &&
      env.SUBLY_SPONSOR_KEYPAIR_PATH.length > 0);

  if (!hasRpc || !hasSponsor) {
    if (isProductionEnv()) {
      throw new Error(
        "SOLANA_RPC_URL and SUBLY_SPONSOR_KEYPAIR(_PATH) must be configured in production"
      );
    }
    logger?.warn(
      "Starting in detached mode: settlement, deposits, and withdrawals are unavailable until SOLANA_RPC_URL and SUBLY_SPONSOR_KEYPAIR(_PATH) are configured"
    );
    const detachedService = defaultSublyService();
    return {
      service: detachedService,
      serverOptions: {
        mandateService: buildMandateService(detachedService.ledger, env, logger)
      },
      mode: "detached"
    };
  }

  const rpc = createRpcFromEnv(env);
  const sponsor = await loadKeyPairSigner({
    base58Secret: env.SUBLY_SPONSOR_KEYPAIR,
    jsonFilePath: env.SUBLY_SPONSOR_KEYPAIR_PATH,
    label: "SUBLY_SPONSOR_KEYPAIR"
  });
  if (
    env.SUBLY_SPONSOR_FEE_PAYER !== undefined &&
    env.SUBLY_SPONSOR_FEE_PAYER !== sponsor.address
  ) {
    throw new Error(
      "SUBLY_SPONSOR_FEE_PAYER does not match the configured sponsor keypair public key"
    );
  }

  const adapter = new KaminoVaultAdapter({
    rpc,
    vaultAddress: SUBLY_VAULT.address,
    ...(env.SUBLY_EXTRA_LOOKUP_TABLES === undefined
      ? {}
      : {
          extraLookupTables: env.SUBLY_EXTRA_LOOKUP_TABLES.split(",")
            .map((value) => value.trim())
            .filter((value) => value.length > 0)
        })
  });
  const engine = new TransactionSubmissionEngine(rpc);

  const computeUnitLimit =
    env.SUBLY_CU_LIMIT === undefined ? undefined : Number(env.SUBLY_CU_LIMIT);
  const computeUnitPriceMicroLamports =
    env.SUBLY_CU_PRICE_MICROLAMPORTS === undefined
      ? undefined
      : BigInt(env.SUBLY_CU_PRICE_MICROLAMPORTS);

  const transactionBuilder = new KaminoCanonicalTransactionBuilder({
    rpc,
    adapter,
    config: {
      ...(computeUnitLimit === undefined ? {} : { computeUnitLimit }),
      ...(computeUnitPriceMicroLamports === undefined
        ? {}
        : { computeUnitPriceMicroLamports })
    }
  });

  const { feeEstimator, feeLamportsToUsdc } = buildFeeEstimator(env);
  const settlementSubmitter = new KaminoSettlementSubmitter({
    engine,
    sponsor,
    ...(feeLamportsToUsdc === null ? {} : { feeLamportsToUsdc })
  });

  const service = new SublyService({
    transactionBuilder,
    feeEstimator,
    settlementSubmitter,
    config: {
      sponsorFeePayer: sponsor.address
    }
  });

  const mandateService = buildMandateService(service.ledger, env, logger);

  const vaultFlowService = new VaultFlowService({
    ledger: service.ledger,
    adapter,
    engine,
    sponsor,
    config: {
      ...(computeUnitLimit === undefined ? {} : { computeUnitLimit }),
      ...(computeUnitPriceMicroLamports === undefined
        ? {}
        : { computeUnitPriceMicroLamports })
    },
    ...(feeLamportsToUsdc === null ? {} : { feeLamportsToUsdc }),
    mandates: mandateService
  });

  const chainWalletSync = new ChainWalletSyncService({
    adapter,
    service,
    apiClient: new KaminoApiClient(env.SUBLY_KAMINO_API_BASE)
  });

  const minSponsorBalanceLamports =
    env.SUBLY_MIN_SPONSOR_BALANCE_LAMPORTS === undefined
      ? 100_000_000n // 0.1 SOL
      : BigInt(env.SUBLY_MIN_SPONSOR_BALANCE_LAMPORTS);
  const sponsorMonitoring = {
    sponsorAddress: sponsor.address,
    getSponsorBalanceLamports: async () => {
      const balance = await rpc.getBalance(sponsor.address).send();
      return BigInt(balance.value);
    },
    minSponsorBalanceLamports
  };

  return {
    service,
    serverOptions: {
      vaultFlowService,
      chainWalletSync,
      sponsorMonitoring,
      mandateService
    },
    mode: "mainnet"
  };
}

/**
 * Spending-mandate enforcement layer (docs/spending-mandate-design.md).
 * SUBLY_MANDATE_ENFORCEMENT stages the rollout: off | warn | on (default).
 */
function buildMandateService(
  ledger: Ledger,
  env: NodeJS.ProcessEnv,
  logger?: FastifyBaseLogger
): SpendingMandateService {
  const approveUrlBase =
    env.SUBLY_APPROVE_URL_BASE ?? "https://app.subly.fi/approve/";
  const setupUrlBase = env.SUBLY_SETUP_URL_BASE ?? "https://app.subly.fi/setup/";
  // Passkey assertions verify against the host serving the owner pages. By
  // default both are derived from the page URL bases; override for split
  // deployments (SUBLY_WEBAUTHN_RP_ID / SUBLY_WEBAUTHN_ORIGINS, comma-sep).
  const derivedOrigins = [
    ...new Set(
      [setupUrlBase, approveUrlBase].flatMap((base) => {
        try {
          return [new URL(base).origin];
        } catch {
          return [];
        }
      })
    )
  ];
  const rpId =
    env.SUBLY_WEBAUTHN_RP_ID ??
    (derivedOrigins.length > 0 ? new URL(derivedOrigins[0]!).hostname : "app.subly.fi");
  const origins =
    env.SUBLY_WEBAUTHN_ORIGINS === undefined
      ? derivedOrigins.length > 0
        ? derivedOrigins
        : ["https://app.subly.fi"]
      : env.SUBLY_WEBAUTHN_ORIGINS.split(",")
          .map((value) => value.trim())
          .filter((value) => value.length > 0);

  return new SpendingMandateService({
    ledger,
    config: {
      enforcementLevel: parseMandateEnforcementLevel(
        env.SUBLY_MANDATE_ENFORCEMENT
      ),
      approveUrlBase,
      setupUrlBase,
      webauthn: { rpId, origins },
      ...(logger === undefined
        ? {}
        : {
            onWarn: (message: string, detail: unknown) =>
              logger.warn({ detail }, `[subly-mandate] ${message}`)
          })
    }
  });
}

function buildFeeEstimator(env: NodeJS.ProcessEnv): {
  feeEstimator: FeeEstimator;
  feeLamportsToUsdc: ((feeLamports: bigint) => Promise<bigint>) | null;
} {
  const hasStaticPolicyFee =
    env.SUBLY_SOL_USDC_PRICE_SCALED !== undefined &&
    env.SUBLY_PRICE_SCALE !== undefined &&
    env.SUBLY_FEE_OBSERVED_AT !== undefined;
  if (hasStaticPolicyFee) {
    return { feeEstimator: feeEstimatorFromEnv(env), feeLamportsToUsdc: null };
  }

  const pyth = new PythHermesFeeEstimator({
    ...(env.SUBLY_HERMES_BASE_URL === undefined
      ? {}
      : { hermesBaseUrl: env.SUBLY_HERMES_BASE_URL }),
    ...(env.SUBLY_ESTIMATED_FEE_LAMPORTS === undefined
      ? {}
      : { estimatedFeeLamports: BigInt(env.SUBLY_ESTIMATED_FEE_LAMPORTS) }),
    ...(env.SUBLY_MAX_ESTIMATED_FEE_LAMPORTS === undefined
      ? {}
      : {
          maxEstimatedFeeLamports: BigInt(env.SUBLY_MAX_ESTIMATED_FEE_LAMPORTS)
        }),
    ...(env.SUBLY_MAX_FEE_DEBT_RAW_USDC_PER_PAYMENT === undefined
      ? {}
      : {
          maxFeeDebtRawUsdcPerPayment: BigInt(
            env.SUBLY_MAX_FEE_DEBT_RAW_USDC_PER_PAYMENT
          )
        }),
    ...(env.SUBLY_FEE_MAX_AGE_MS === undefined
      ? {}
      : { maxPriceAgeMs: Number(env.SUBLY_FEE_MAX_AGE_MS) })
  });

  return {
    feeEstimator: pyth,
    feeLamportsToUsdc: (feeLamports) => pyth.convertFeeLamportsToUsdc(feeLamports)
  };
}
