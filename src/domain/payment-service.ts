import { randomUUID } from "node:crypto";
import { isProductionEnv } from "../config/env.js";
import {
  DEFAULT_ESTIMATED_FEE_DEBT_RAW_USDC,
  DEFAULT_PAYMENT_EXPIRY_SECONDS,
  PAYMENT_SCHEME,
  RATE_SCALE,
  SOLANA_MAINNET_NETWORK,
  SUBLY_VAULT
} from "../config/constants.js";
import { deriveAssociatedTokenAddress } from "../lib/associated-token-account.js";
import { EMPTY_BODY_HASH } from "../lib/hash.js";
import {
  clampToZero,
  maxBigInt,
  minBigInt,
  mulDivCeil,
  parsePositiveRawUnits,
  parseRawUnits,
  rawUnitsToString
} from "../lib/raw-units.js";
import { assertSolanaAddress } from "../lib/solana-address.js";
import {
  computeBudgetSnapshot,
  computePositionValueRawUsdc,
  evaluatePaymentBudget
} from "./budget.js";
import {
  badRequest,
  conflict,
  notFound,
  SublyError,
  unavailable
} from "./errors.js";
import {
  feeEstimatorFromEnv,
  type FeeEstimator,
  StaticFeeEstimator
} from "./fee-estimator.js";
import { InMemoryLedger, type Ledger } from "./ledger.js";
import type {
  PaymentIntent,
  PrincipalBasisSource,
  ProvenancedRawValue,
  SellerLiquidityPolicy,
  SignerValidationMode,
  SigningMode,
  SyncEvent,
  SyncEventType,
  WalletPosition
} from "./models.js";
import {
  extractValidRequiredSignerSignature,
  preparedMessageHashFromSerializedTransaction,
  StrictPaymentPayloadVerifier,
  transactionSignatureFromSerializedTransaction,
  type PaymentPayloadVerifier,
  type SignedPaymentPayload
} from "./payment-payload-verifier.js";
import {
  expirePreparedPaymentsForLockedPosition,
  paymentIntentExpired
} from "./position-maintenance.js";
import { pendingVaultFlows } from "./vault-flow-service.js";
import { PostgresLedger } from "./postgres-ledger.js";
import { computeRequestBindingHash } from "./request-binding.js";
import {
  isSettlementSubmissionError,
  UnsupportedSettlementSubmitter,
  type SettlementReconciliationResult,
  type SettlementSubmissionResult,
  type SettlementSubmitter
} from "./settlement-submitter.js";
import type {
  CanonicalTransactionBuilder,
  PreparedSettlementTransaction,
  SettlementQuote
} from "./transaction-builder.js";
import { UnsupportedCanonicalTransactionBuilder } from "./transaction-builder.js";

export interface SublyServiceConfig {
  defaultEstimatedFeeDebtRawUsdc: bigint;
  defaultEstimatedFeeLamports: bigint;
  paymentExpirySeconds: number;
  sponsorFeePayer: string | null;
}

export interface RegisterAgentWalletInput {
  wallet: string;
  signingPolicyId: string;
  signingMode?: SigningMode | undefined;
  signerValidationMode?: SignerValidationMode | undefined;
  signerProvider?: string | undefined;
  safetyBufferRawUsdc?: string | undefined;
  activateForPayments?: boolean | undefined;
}

export interface SyncWalletPositionInput {
  wallet: string;
  vault?: string | undefined;
  stakedSharesRaw?: string | undefined;
  unstakedSharesRaw?: string | undefined;
  totalSharesRaw: string;
  exchangeRateScaled: string;
  instantRedeemCapacityRawUsdc: string;
  principalBasisRawUsdc?: string | undefined;
  principalBasisSource?: PrincipalBasisSource | undefined;
  kaminoPnlSnapshot?: ProvenancedRawValue[] | undefined;
  observedSlot?: number | undefined;
  sourceEndpoint?: string | undefined;
  forceConservativeReset?: boolean | undefined;
}

export interface PreparePaymentInput {
  wallet: string;
  scheme?: string | undefined;
  network?: string | undefined;
  vault?: string | undefined;
  shareMint?: string | undefined;
  asset: string;
  seller: string;
  sellerRequestId: string;
  httpMethod: string;
  canonicalResourceUrl: string;
  requestBodyHash?: string | undefined;
  amountRawUsdc: string;
  payTo: string;
  sellerUsdcAta: string;
  dustRecipientUsdcAta: string;
}

export interface VerifyPaymentPayloadInput extends SignedPaymentPayload {
  paymentId: string;
  requestBindingHash: string;
  preparedMessageHash: string;
}

export class SublyService {
  readonly ledger: Ledger;
  private readonly transactionBuilder: CanonicalTransactionBuilder;
  private readonly feeEstimator: FeeEstimator;
  private readonly paymentPayloadVerifier: PaymentPayloadVerifier;
  private readonly settlementSubmitter: SettlementSubmitter;
  private readonly config: SublyServiceConfig;

  constructor(params?: {
    ledger?: Ledger;
    transactionBuilder?: CanonicalTransactionBuilder;
    feeEstimator?: FeeEstimator;
    paymentPayloadVerifier?: PaymentPayloadVerifier;
    settlementSubmitter?: SettlementSubmitter;
    config?: Partial<SublyServiceConfig>;
  }) {
    this.config = {
      defaultEstimatedFeeDebtRawUsdc: DEFAULT_ESTIMATED_FEE_DEBT_RAW_USDC,
      defaultEstimatedFeeLamports: 0n,
      paymentExpirySeconds: DEFAULT_PAYMENT_EXPIRY_SECONDS,
      sponsorFeePayer: null,
      ...params?.config
    };
    this.ledger = params?.ledger ?? defaultLedger();
    const transactionBuilderConfigured = params?.transactionBuilder !== undefined;
    this.transactionBuilder =
      params?.transactionBuilder ?? new UnsupportedCanonicalTransactionBuilder();
    this.feeEstimator =
      params?.feeEstimator ?? defaultFeeEstimator(this.config);
    if (isProductionEnv() && this.config.sponsorFeePayer === null) {
      throw badRequest(
        "sponsor_fee_payer_not_configured",
        "SUBLY_SPONSOR_FEE_PAYER must be configured in production"
      );
    }
    this.paymentPayloadVerifier =
      params?.paymentPayloadVerifier ?? new StrictPaymentPayloadVerifier();
    const settlementSubmitterConfigured = params?.settlementSubmitter !== undefined;
    this.settlementSubmitter =
      params?.settlementSubmitter ?? new UnsupportedSettlementSubmitter();
    assertProductionSettlementDependencies({
      transactionBuilderConfigured,
      settlementSubmitterConfigured,
      settlementSubmitter: this.settlementSubmitter
    });
  }

  async registerAgentWallet(input: RegisterAgentWalletInput) {
    const wallet = requireSolanaAddress(input.wallet, "wallet");

    return this.ledger.withWalletVaultLock(wallet, SUBLY_VAULT.address, async () => {
      const existing = await this.ledger.getPosition(wallet, SUBLY_VAULT.address);
      const safetyBufferRawUsdc =
        input.safetyBufferRawUsdc === undefined
          ? existing?.safetyBufferRawUsdc ?? 0n
          : parseRawUnits(input.safetyBufferRawUsdc, "safetyBufferRawUsdc");
      const nextSignerProvider =
        input.signerProvider ?? existing?.signerProvider ?? "unconfigured";
      const nextSignerValidationMode =
        input.signerValidationMode ??
        existing?.signerValidationMode ??
        "unverified";
      const activateForPayments = input.activateForPayments === true;
      if (
        existing?.status === "observed_only" &&
        activateForPayments &&
        nextSignerProvider === "unconfigured"
      ) {
        throw conflict(
          "signer_provider_missing",
          "Observed-only wallets can become active only after a signer provider is configured"
        );
      }
      const initialSignerProvider = input.signerProvider ?? "unconfigured";
      const initialSigningMode =
        input.signingMode ??
        (initialSignerProvider === "unconfigured"
          ? "observed_only"
          : "non_interactive");
      const nextSigningMode =
        input.signingMode ??
        (existing?.signingMode === "observed_only" &&
        activateForPayments &&
        nextSignerProvider !== "unconfigured"
          ? "non_interactive"
          : existing?.signingMode);
      const position: WalletPosition =
        existing === null
          ? {
              wallet,
              vault: SUBLY_VAULT.address,
              signingPolicyId: input.signingPolicyId,
              signingMode: initialSigningMode,
              signerValidationMode: input.signerValidationMode ?? "unverified",
              signerProvider: initialSignerProvider,
              stakedSharesRaw: 0n,
              unstakedSharesRaw: 0n,
              totalSharesRaw: 0n,
              exchangeRateScaled: RATE_SCALE,
              instantRedeemCapacityRawUsdc: 0n,
              principalBasisRawUsdc: 0n,
              principalBasisSource: "empty",
              reservedRawUsdc: 0n,
              feeDebtRawUsdc: 0n,
              safetyBufferRawUsdc,
              kaminoPositionSnapshot: [],
              kaminoPnlSnapshot: [],
              lastSyncedSlot: null,
              version: 1,
              status:
                initialSigningMode === "observed_only" ||
                initialSignerProvider === "unconfigured"
                  ? "observed_only"
                  : "active"
            }
          : {
              ...existing,
              signingPolicyId: input.signingPolicyId,
              signingMode: nextSigningMode ?? existing.signingMode,
              signerValidationMode: nextSignerValidationMode,
              signerProvider: nextSignerProvider,
              safetyBufferRawUsdc,
              version: existing.version + 1,
              status: nextWalletStatusAfterSignerUpdate({
                existingStatus: existing.status,
                nextSigningMode: nextSigningMode ?? existing.signingMode,
                nextSignerProvider,
                activateForPayments
              })
            };

      return serializeWalletPosition(await this.ledger.savePosition(position));
    });
  }

  async syncWalletPosition(input: SyncWalletPositionInput) {
    const wallet = requireSolanaAddress(input.wallet, "wallet");
    const vault = input.vault ?? SUBLY_VAULT.address;
    if (vault !== SUBLY_VAULT.address) {
      throw badRequest("unsupported_vault", "Only the Subly alpha vault is supported");
    }

    return this.ledger.withWalletVaultLock(wallet, vault, async () => {
      const existing = await this.ledger.getPosition(wallet, vault);
      if (existing === null) {
        throw notFound(
          "wallet_not_registered",
          "Register the agent wallet before syncing its Kamino position"
        );
      }

      const totalSharesRaw = parseRawUnits(input.totalSharesRaw, "totalSharesRaw");
      const stakedSharesRaw =
        input.stakedSharesRaw === undefined
          ? existing.stakedSharesRaw
          : parseRawUnits(input.stakedSharesRaw, "stakedSharesRaw");
      if (input.unstakedSharesRaw === undefined && stakedSharesRaw > totalSharesRaw) {
        throw badRequest(
          "share_total_mismatch",
          "stakedSharesRaw must be less than or equal to totalSharesRaw when unstakedSharesRaw is omitted"
        );
      }
      const unstakedSharesRaw =
        input.unstakedSharesRaw === undefined
          ? totalSharesRaw - stakedSharesRaw
          : parseRawUnits(input.unstakedSharesRaw, "unstakedSharesRaw");

      if (stakedSharesRaw + unstakedSharesRaw !== totalSharesRaw) {
        throw badRequest(
          "share_total_mismatch",
          "stakedSharesRaw + unstakedSharesRaw must equal totalSharesRaw"
        );
      }

      const exchangeRateScaled = parsePositiveRawUnits(
        input.exchangeRateScaled,
        "exchangeRateScaled"
      );
      const instantRedeemCapacityRawUsdc = parseRawUnits(
        input.instantRedeemCapacityRawUsdc,
        "instantRedeemCapacityRawUsdc"
      );
      const currentPositionValueRawUsdc = computePositionValueRawUsdc(
        totalSharesRaw,
        exchangeRateScaled
      );

      const providedPrincipal =
        input.principalBasisRawUsdc === undefined
          ? null
          : parseRawUnits(input.principalBasisRawUsdc, "principalBasisRawUsdc");
      const forceReset = input.forceConservativeReset === true;
      const sharesIncreased = totalSharesRaw > existing.totalSharesRaw;
      const sharesDecreased = totalSharesRaw < existing.totalSharesRaw;
      const hasEstablishedBaseline =
        existing.principalBasisSource !== "empty" ||
        existing.totalSharesRaw > 0n;
      const runConservativeReset =
        forceReset ||
        (hasEstablishedBaseline && sharesDecreased) ||
        (sharesIncreased && providedPrincipal === null);
      const activePayments = await this.ledger.listPaymentsForPosition(wallet, vault);
      const submittedPayments = activePayments.filter(
        (payment) =>
          payment.status === "submission_prepared" ||
          payment.status === "submitted"
      );
      if (runConservativeReset && submittedPayments.length > 0) {
        throw conflict(
          "submitted_payment_active",
          "Cannot reset baseline while submitted payments are awaiting terminal settlement",
          {
            paymentIds: submittedPayments.map((payment) => payment.paymentId)
          }
        );
      }

      const now = new Date().toISOString();
      if (runConservativeReset) {
        for (const payment of activePayments) {
          if (payment.status === "prepared") {
            await this.ledger.savePayment({
              ...payment,
              status: "expired",
              terminalAt: now,
              settlementResponse: {
                error: "expired_by_conservative_baseline_reset"
              }
            });
          }
        }
      }

      const externalDepositFloorRawUsdc =
        hasEstablishedBaseline && sharesIncreased && providedPrincipal !== null
          ? existing.principalBasisRawUsdc +
            mulDivCeil(
              totalSharesRaw - existing.totalSharesRaw,
              exchangeRateScaled,
              RATE_SCALE
            )
          : existing.principalBasisRawUsdc;

      const nextPrincipalBasisRawUsdc = runConservativeReset
        ? currentPositionValueRawUsdc
        : providedPrincipal === null
          ? existing.principalBasisSource === "empty"
            ? currentPositionValueRawUsdc
            : existing.principalBasisRawUsdc
          : maxBigInt(
              maxBigInt(existing.principalBasisRawUsdc, providedPrincipal),
              externalDepositFloorRawUsdc
            );

      const next: WalletPosition = {
        ...existing,
        stakedSharesRaw,
        unstakedSharesRaw,
        totalSharesRaw,
        exchangeRateScaled,
        instantRedeemCapacityRawUsdc,
        principalBasisRawUsdc: nextPrincipalBasisRawUsdc,
        principalBasisSource: runConservativeReset
          ? "conservative_activation_reset"
          : input.principalBasisSource ??
            (existing.principalBasisSource === "empty"
              ? "conservative_activation_reset"
              : existing.principalBasisSource),
        kaminoPnlSnapshot: input.kaminoPnlSnapshot ?? existing.kaminoPnlSnapshot,
        reservedRawUsdc: runConservativeReset ? 0n : existing.reservedRawUsdc,
        status: runConservativeReset
          ? walletStatusAfterConservativeReset(existing)
          : existing.status,
        lastSyncedSlot: input.observedSlot ?? existing.lastSyncedSlot,
        version: existing.version + 1
      };

      const saved = await this.ledger.savePosition(next);
      await this.recordSyncEvent({
        wallet,
        vault,
        eventType: "wallet_sync",
        deltaSharesRaw: totalSharesRaw - existing.totalSharesRaw,
        deltaPrincipalRawUsdc:
          nextPrincipalBasisRawUsdc - existing.principalBasisRawUsdc,
        classification: runConservativeReset
          ? "conservative_baseline_reset"
          : providedPrincipal === null
            ? "snapshot_update"
            : "basis_confirmed",
        sourceEndpoint: input.sourceEndpoint ?? "subly_sync_api",
        rawSnapshot: {
          totalSharesRaw: rawUnitsToString(totalSharesRaw),
          exchangeRateScaled: rawUnitsToString(exchangeRateScaled),
          instantRedeemCapacityRawUsdc: rawUnitsToString(
            instantRedeemCapacityRawUsdc
          )
        },
        slot: input.observedSlot ?? null
      });
      return serializeBudget(saved);
    });
  }

  async listSyncEvents(
    walletInput: string,
    vault: string = SUBLY_VAULT.address,
    limit = 100
  ) {
    const wallet = requireSolanaAddress(walletInput, "wallet");
    const events = await this.ledger.listSyncEvents(wallet, vault, limit);
    return { events: events.map(serializeSyncEvent) };
  }

  private async recordSyncEvent(input: {
    wallet: string;
    vault: string;
    eventType: SyncEventType;
    deltaSharesRaw: bigint;
    deltaPrincipalRawUsdc: bigint;
    classification: string;
    sourceEndpoint: string;
    rawSnapshot?: unknown;
    txSignature?: string | null;
    slot?: number | null;
  }): Promise<void> {
    const event: SyncEvent = {
      eventId: `evt_${randomUUID().replaceAll("-", "")}`,
      wallet: input.wallet,
      vault: input.vault,
      eventType: input.eventType,
      txSignature: input.txSignature ?? null,
      deltaSharesRaw: input.deltaSharesRaw,
      deltaPrincipalRawUsdc: input.deltaPrincipalRawUsdc,
      classification: input.classification,
      sourceEndpoint: input.sourceEndpoint,
      rawSnapshot: input.rawSnapshot ?? null,
      slot: input.slot ?? null,
      observedAt: new Date().toISOString()
    };
    await this.ledger.saveSyncEvent(event);
  }

  async getBudget(walletInput: string, vault: string = SUBLY_VAULT.address) {
    const wallet = requireSolanaAddress(walletInput, "wallet");
    if (vault !== SUBLY_VAULT.address) {
      throw badRequest("unsupported_vault", "Only the Subly alpha vault is supported");
    }

    return this.ledger.withWalletVaultLock(wallet, vault, async () => {
      const position = await this.ledger.getPosition(wallet, vault);
      if (position === null) {
        throw notFound("wallet_not_registered", "Wallet position does not exist");
      }

      const refreshed = await this.expirePreparedPaymentsForLockedPosition(
        wallet,
        vault
      );
      return serializeBudget(refreshed ?? position);
    });
  }

  async preparePayment(input: PreparePaymentInput) {
    const wallet = requireSolanaAddress(input.wallet, "wallet");
    const vault = input.vault ?? SUBLY_VAULT.address;
    const scheme = input.scheme ?? PAYMENT_SCHEME;
    const network = input.network ?? SOLANA_MAINNET_NETWORK;
    const shareMint = input.shareMint ?? SUBLY_VAULT.shareMint;
    const requestBodyHash = normalizeRequestBodyHash(input.requestBodyHash);
    const amountRawUsdc = parsePositiveRawUnits(
      input.amountRawUsdc,
      "amountRawUsdc"
    );

    assertExpectedPaymentRequirement({
      scheme,
      network,
      vault,
      shareMint,
      asset: input.asset,
      requestBodyHash,
      canonicalResourceUrl: input.canonicalResourceUrl
    });

    const seller = requireSolanaAddress(input.seller, "seller");
    const payTo = requireSolanaAddress(input.payTo, "payTo");
    // Self-payments would make the seller ATA and the dust recipient ATA the
    // same account, which breaks the settlement output accounting and has no
    // product meaning (paying yield back to the same wallet is a withdrawal).
    if (payTo === wallet) {
      throw badRequest(
        "self_payment_not_supported",
        "payTo must not be the agent wallet; use a normal withdrawal instead"
      );
    }
    const sellerUsdcAta = requireSolanaAddress(input.sellerUsdcAta, "sellerUsdcAta");
    const expectedSellerUsdcAta = deriveAssociatedTokenAddress({
      owner: payTo,
      mint: SUBLY_VAULT.usdcMint
    });
    if (sellerUsdcAta !== expectedSellerUsdcAta) {
      throw badRequest(
        "seller_ata_mismatch",
        "sellerUsdcAta must be the associated USDC token account for payTo",
        {
          payTo,
          sellerUsdcAta,
          expectedSellerUsdcAta
        }
      );
    }
    const dustRecipientUsdcAta = requireSolanaAddress(
      input.dustRecipientUsdcAta,
      "dustRecipientUsdcAta"
    );
    const expectedDustRecipientUsdcAta = deriveAssociatedTokenAddress({
      owner: wallet,
      mint: SUBLY_VAULT.usdcMint
    });
    if (dustRecipientUsdcAta !== expectedDustRecipientUsdcAta) {
      throw badRequest(
        "dust_recipient_ata_mismatch",
        "dustRecipientUsdcAta must be the associated USDC token account for the agent wallet",
        {
          wallet,
          dustRecipientUsdcAta,
          expectedDustRecipientUsdcAta
        }
      );
    }
    const httpMethod = input.httpMethod.toUpperCase();
    const requestBindingHash = computeRequestBindingHash({
      sellerRequestId: input.sellerRequestId,
      httpMethod,
      canonicalResourceUrl: input.canonicalResourceUrl,
      requestBodyHash,
      seller,
      asset: input.asset,
      amountRawUsdc: amountRawUsdc.toString(),
      payTo,
      sellerUsdcAta
    });

    return this.ledger.withSellerRequestLock(
      seller,
      input.sellerRequestId,
      async () =>
        this.ledger.withWalletVaultLock(wallet, vault, async () => {
          await this.expirePreparedPaymentsForLockedPosition(wallet, vault);

          const existingSellerRequest = await this.ledger.findPaymentBySellerRequest(
            seller,
            input.sellerRequestId
          );
          if (existingSellerRequest !== null) {
            if (existingSellerRequest.requestBindingHash !== requestBindingHash) {
              throw conflict(
                "seller_request_id_reuse",
                "sellerRequestId is already bound to a different payment request",
                {
                  paymentId: existingSellerRequest.paymentId,
                  existingRequestBindingHash:
                    existingSellerRequest.requestBindingHash,
                  requestBindingHash
                }
              );
            }

            // Live and settled payments are idempotent for the request.
            // Terminal failures (expired, failed, failed_not_submitted) never
            // moved USDC to the seller and never get their stored bytes
            // resubmitted, so the same request binding may be re-prepared
            // under a fresh paymentId.
            if (!isTerminalFailedPaymentStatus(existingSellerRequest.status)) {
              return serializePaymentIntent(existingSellerRequest);
            }
          }

          const position = await this.ledger.getPosition(wallet, vault);
          if (position === null) {
            throw notFound(
              "wallet_not_registered",
              "Wallet position does not exist"
            );
          }
          if (position.status !== "active") {
            throw conflict(
              position.status,
              `Wallet position is ${position.status}; payments are blocked`
            );
          }
          if (position.signingPolicyId === null) {
            throw conflict(
              "signing_policy_missing",
              "Wallet has no approved signing policy"
            );
          }
          if (position.signingMode !== "non_interactive") {
            throw conflict(
              "observed_only",
              "Wallet signing mode is observed_only; payments require a non-interactive signer"
            );
          }
          if (position.signerProvider === "unconfigured") {
            throw conflict(
              "signer_provider_missing",
              "Wallet has no configured signer provider"
            );
          }
          if (
            isProductionEnv() &&
            position.signerValidationMode !== "structured_intent_transaction"
          ) {
            throw conflict(
              "signer_policy_validation_missing",
              "Production payments require a signer policy that validates structured intent and transaction contents before signing"
            );
          }

          const pendingFlows = await pendingVaultFlows(this.ledger, wallet, vault);
          if (pendingFlows > 0) {
            throw conflict(
              "vault_flow_pending",
              "A deposit or withdrawal for this wallet is pending; retry after it reaches a terminal state"
            );
          }

          const liquidityPolicy =
            (await this.ledger.getLiquidityPolicy(seller, vault)) ??
            (await this.ledger.getLiquidityPolicy("default", vault));
          if (liquidityPolicy === null) {
            if (isProductionEnv()) {
              throw conflict(
                "liquidity_policy_missing",
                "No seller liquidity policy is configured for this vault"
              );
            }
          } else if (liquidityPolicy.status !== "active") {
            throw conflict(
              "liquidity_policy_disabled",
              "The seller liquidity policy for this vault is disabled"
            );
          } else if (amountRawUsdc > liquidityPolicy.expectedPaymentSizeRawUsdc) {
            throw conflict(
              "amount_exceeds_policy",
              "Payment amount exceeds the seller class expected payment size",
              {
                amountRawUsdc: amountRawUsdc.toString(),
                expectedPaymentSizeRawUsdc:
                  liquidityPolicy.expectedPaymentSizeRawUsdc.toString()
              }
            );
          }

          // Payment-critical current state comes from the on-chain quote when
          // the transaction builder can provide it; the last synced ledger
          // snapshot is only a fallback for builders without chain access.
          let workingPosition = position;
          let quote: SettlementQuote | null = null;
          if (this.transactionBuilder.quoteSettlementWithdraw !== undefined) {
            quote = await this.transactionBuilder.quoteSettlementWithdraw({
              wallet,
              vault,
              amountRawUsdc
            });
            if (quote.userTotalSharesRaw !== position.totalSharesRaw) {
              await this.ledger.savePosition({
                ...position,
                status: "needs_baseline_reset",
                version: position.version + 1
              });
              await this.recordSyncEvent({
                wallet,
                vault,
                eventType: "external_share_movement",
                deltaSharesRaw:
                  quote.userTotalSharesRaw - position.totalSharesRaw,
                deltaPrincipalRawUsdc: 0n,
                classification: "needs_baseline_reset",
                sourceEndpoint: "chain_rpc",
                slot: quote.observedSlot
              });
              throw conflict(
                "needs_baseline_reset",
                "On-chain share balance does not match the Subly ledger; classify the movement or run a conservative baseline reset before new payments",
                {
                  ledgerTotalSharesRaw: position.totalSharesRaw.toString(),
                  onchainTotalSharesRaw: quote.userTotalSharesRaw.toString()
                }
              );
            }
            workingPosition = await this.ledger.savePosition({
              ...position,
              stakedSharesRaw: quote.userStakedSharesRaw,
              unstakedSharesRaw: quote.userUnstakedSharesRaw,
              exchangeRateScaled: quote.exchangeRateScaled,
              instantRedeemCapacityRawUsdc: quote.instantRedeemCapacityRawUsdc,
              lastSyncedSlot: quote.observedSlot,
              version: position.version + 1
            });
          }

          if (
            liquidityPolicy !== null &&
            liquidityPolicy.status === "active" &&
            workingPosition.instantRedeemCapacityRawUsdc <
              liquidityPolicy.minInstantLiquidityRawUsdc
          ) {
            throw conflict(
              "budget_illiquid",
              "Vault instant liquidity is below the seller class minimum",
              {
                instantRedeemCapacityRawUsdc:
                  workingPosition.instantRedeemCapacityRawUsdc.toString(),
                minInstantLiquidityRawUsdc:
                  liquidityPolicy.minInstantLiquidityRawUsdc.toString()
              }
            );
          }

          const feeEstimate = await this.feeEstimator.estimatePaymentFee({
            wallet,
            seller,
            amountRawUsdc
          });
          const estimatedFeeDebtRawUsdc = feeEstimate.estimatedFeeDebtRawUsdc;
          const estimatedFeeLamports = feeEstimate.estimatedFeeLamports;

          const evaluation = evaluatePaymentBudget({
            position: workingPosition,
            sellerAmountRawUsdc: amountRawUsdc,
            estimatedFeeDebtRawUsdc,
            ...(quote === null
              ? {}
              : { requiredWithdrawRawUsdc: quote.requiredWithdrawRawUsdc }),
            activeWithdrawReservedRawUsdc:
              await this.activeWithdrawReservedRawUsdc(wallet, vault)
          });

          if (!evaluation.ok) {
            throw conflict(
              evaluation.code,
              "Payment cannot be prepared",
              evaluation.details
            );
          }

          const paymentId = `pay_${randomUUID().replaceAll("-", "")}`;
          const expiresAt = new Date(
            Date.now() + this.config.paymentExpirySeconds * 1000
          ).toISOString();
          const sharesToRedeemRaw =
            quote?.sharesToRedeemRaw ?? evaluation.sharesToRedeemRaw;

          const prepared = await this.transactionBuilder.preparePaymentSettlement({
            paymentId,
            wallet,
            vault,
            shareMint: SUBLY_VAULT.shareMint,
            usdcMint: SUBLY_VAULT.usdcMint,
            feePayer: this.config.sponsorFeePayer,
            seller,
            sellerRequestId: input.sellerRequestId,
            requestBindingHash,
            httpMethod,
            canonicalResourceUrl: input.canonicalResourceUrl,
            requestBodyHash,
            amountRawUsdc,
            payTo,
            sellerUsdcAta,
            dustRecipientUsdcAta,
            sharesToRedeemRaw,
            requiredWithdrawRawUsdc: evaluation.requiredWithdrawRawUsdc,
            memo: paymentId,
            expiresAt
          });
          assertPreparedSettlementTransaction(prepared);
          // The ledger tracks the exact shares the canonical transaction
          // burns; sharesToRedeemRaw above is the signer-approved maximum.
          const actualSharesToRedeemRaw =
            prepared.sharesToRedeemRaw ?? sharesToRedeemRaw;
          if (actualSharesToRedeemRaw > sharesToRedeemRaw) {
            throw unavailable(
              "transaction_builder_invalid",
              "Prepared transaction burns more shares than the approved maximum"
            );
          }

          const intent: PaymentIntent = {
            paymentId,
            wallet,
            vault,
            seller,
            sellerRequestId: input.sellerRequestId,
            httpMethod,
            canonicalResourceUrl: input.canonicalResourceUrl,
            requestBodyHash,
            requestBindingHash,
            asset: input.asset,
            amountRawUsdc,
            payTo,
            sellerUsdcAta,
            dustRecipientUsdcAta,
            signingPolicyId: position.signingPolicyId,
            preparedMessageHash: prepared.preparedMessageHash,
            recentBlockhash: prepared.recentBlockhash,
            lastValidBlockHeight: prepared.lastValidBlockHeight,
            temporarySettlementTokenAccount:
              prepared.temporarySettlementTokenAccount,
            temporarySettlementSignature: prepared.temporarySettlementSignature,
            sharesToRedeemRaw: actualSharesToRedeemRaw,
            requiredWithdrawRawUsdc: evaluation.requiredWithdrawRawUsdc,
            estimatedFeeLamports,
            estimatedFeeDebtRawUsdc,
            principalBasisBeforeRawUsdc: workingPosition.principalBasisRawUsdc,
            grossYieldBeforeRawUsdc: evaluation.budget.grossYieldRawUsdc,
            spendableYieldBeforeRawUsdc:
              evaluation.budget.spendableYieldRawUsdc,
            postPositionValueRawUsdc: evaluation.postPositionValueRawUsdc,
            reservationRawUsdc: evaluation.reservationRawUsdc,
            status: "prepared",
            expiresAt,
            submittedAt: null,
            terminalAt: null,
            txSignature: null,
            submittedSerializedTransaction: null,
            settlementResponse: null,
            intentJson: {
              scheme,
              network,
              requestBindingHash,
              serializedTransaction: prepared.serializedTransaction,
              // Structured signing intent: the agent signer must validate the
              // transaction against these fields before signing. Lookup table
              // contents are intentionally not included; signers resolve them
              // through their own RPC view.
              signingIntent: {
                paymentId,
                sellerRequestId: input.sellerRequestId,
                wallet,
                network,
                scheme,
                httpMethod,
                canonicalResourceUrl: input.canonicalResourceUrl,
                requestBodyHash,
                requestBindingHash,
                seller,
                vault,
                shareMint: SUBLY_VAULT.shareMint,
                asset: input.asset,
                amountRawUsdc: rawUnitsToString(amountRawUsdc),
                payTo,
                sellerUsdcAta,
                feePayer: this.config.sponsorFeePayer,
                temporarySettlementTokenAccount:
                  prepared.temporarySettlementTokenAccount,
                dustRecipientUsdcAta,
                maxSharesToRedeemRaw: rawUnitsToString(sharesToRedeemRaw),
                memo: paymentId,
                expiresAt,
                preparedMessageHash: prepared.preparedMessageHash
              }
            }
          };

          const updatedPosition: WalletPosition = {
            ...workingPosition,
            reservedRawUsdc:
              workingPosition.reservedRawUsdc + evaluation.reservationRawUsdc,
            version: workingPosition.version + 1
          };

          await this.ledger.savePosition(updatedPosition);
          return serializePaymentIntent(await this.ledger.savePayment(intent));
        })
    );
  }

  async verifyPaymentPayload(input: VerifyPaymentPayloadInput) {
    const intent = await this.ledger.getPayment(input.paymentId);
    if (intent === null) {
      return {
        isValid: false,
        invalidReason: "payment_not_found"
      };
    }

    if (intent.status === "prepared" && paymentIntentExpired(intent)) {
      return this.ledger.withWalletVaultLock(intent.wallet, intent.vault, async () => {
        const latest = await this.ledger.getPayment(intent.paymentId);
        if (latest === null) {
          return {
            isValid: false,
            invalidReason: "payment_not_found"
          };
        }
        if (latest.status === "prepared" && paymentIntentExpired(latest)) {
          return this.expirePreparedPayment(latest);
        }

        return this.verifyLoadedPaymentPayload(latest, input);
      });
    }

    return this.verifyLoadedPaymentPayload(intent, input);
  }

  async settlePaymentPayload(input: VerifyPaymentPayloadInput) {
    const firstRead = await this.ledger.getPayment(input.paymentId);
    if (firstRead === null) {
      return {
        isValid: false,
        invalidReason: "payment_not_found"
      };
    }

    if (firstRead.status === "submitted") {
      return this.reconcileSubmittedPayment(firstRead, input);
    }
    if (firstRead.status === "submission_prepared") {
      return this.submitPreparedSettlement(firstRead, input);
    }

    const existingTerminalResponse =
      terminalSettlementResponseForStoredState(firstRead);
    if (existingTerminalResponse !== null) {
      return existingTerminalResponse;
    }

    const preparedResult = await this.ledger.withWalletVaultLock(
      firstRead.wallet,
      firstRead.vault,
      async () => {
        const intent = await this.ledger.getPayment(input.paymentId);
        if (intent === null) {
          return {
            kind: "response" as const,
            response: {
              isValid: false,
              invalidReason: "payment_not_found"
            }
          };
        }

        if (intent.status === "submitted") {
          return {
            kind: "reconcile" as const,
            intent
          };
        }
        if (intent.status === "submission_prepared") {
          return {
            kind: "submit_prepared" as const,
            intent
          };
        }

        const storedTerminalResponse =
          terminalSettlementResponseForStoredState(intent);
        if (storedTerminalResponse !== null) {
          return {
            kind: "response" as const,
            response: storedTerminalResponse
          };
        }

        const verification = this.verifyLoadedPaymentPayload(intent, input);
        if (!verification.isValid) {
          if (verification.invalidReason === "expired") {
            return {
              kind: "response" as const,
              response: await this.expirePreparedPayment(intent)
            };
          }

          return {
            kind: "response" as const,
            response: verification
          };
        }

        if (!this.settlementSubmitter.ready) {
          throw unavailable(
            "settlement_submitter_unavailable",
            "Settlement submission is not connected yet"
          );
        }
        if (
          this.settlementSubmitter.preparePaymentSettlementSubmission ===
          undefined
        ) {
          throw unavailable(
            "settlement_submission_record_unavailable",
            "Settlement submitter must provide a transaction signature before submission"
          );
        }

        const preparedSubmission =
          await this.settlementSubmitter.preparePaymentSettlementSubmission({
            intent,
            sponsorFeePayer: this.config.sponsorFeePayer,
            serializedTransaction: input.serializedTransaction,
            agentSignature: input.agentSignature,
            temporarySettlementSignature: input.temporarySettlementSignature
          });
        if (preparedSubmission.txSignature.length === 0) {
          throw unavailable(
            "settlement_submission_record_invalid",
            "Settlement submitter returned an empty transaction signature"
          );
        }
        if (preparedSubmission.serializedSignedTransaction.length === 0) {
          throw unavailable(
            "settlement_submission_record_invalid",
            "Settlement submitter returned an empty signed transaction"
          );
        }

        const submissionRecordError = this.submissionRecordValidationError({
          ...intent,
          status: "submission_prepared",
          txSignature: preparedSubmission.txSignature,
          submittedSerializedTransaction:
            preparedSubmission.serializedSignedTransaction
        });
        if (submissionRecordError !== null) {
          throw submissionRecordError;
        }

        return {
          kind: "submitted" as const,
          intent: await this.ledger.savePayment({
            ...intent,
            status: "submission_prepared",
            txSignature: preparedSubmission.txSignature,
            submittedSerializedTransaction:
              preparedSubmission.serializedSignedTransaction,
            settlementResponse: pendingSettlementResponse(intent.paymentId)
          })
        };
      }
    );

    if (preparedResult.kind === "response") {
      return preparedResult.response;
    }
    if (preparedResult.kind === "reconcile") {
      return this.reconcileSubmittedPayment(preparedResult.intent, input);
    }
    return this.submitPreparedSettlement(preparedResult.intent, input);
  }

  private async submitPreparedSettlement(
    intentToSubmit: PaymentIntent,
    input: VerifyPaymentPayloadInput
  ) {
    const verification = this.verifySettlementPayloadForIntent(
      intentToSubmit,
      input
    );
    if (!verification.isValid) {
      return verification;
    }

    if (
      intentToSubmit.txSignature === null ||
      intentToSubmit.submittedSerializedTransaction == null
    ) {
      return invalidSettlementResponse(
        intentToSubmit.paymentId,
        "submission_record_missing",
        "Prepared settlement submission is missing persisted transaction data"
      );
    }

    const submissionRecordError =
      this.submissionRecordValidationError(intentToSubmit);
    if (submissionRecordError !== null) {
      return invalidSettlementResponse(
        intentToSubmit.paymentId,
        submissionRecordError.code,
        submissionRecordError.message
      );
    }

    let submissionResult: SettlementSubmissionResult;
    try {
      submissionResult = await this.settlementSubmitter.submitPaymentSettlement({
        intent: intentToSubmit,
        sponsorFeePayer: this.config.sponsorFeePayer,
        txSignature: intentToSubmit.txSignature,
        serializedSignedTransaction: intentToSubmit.submittedSerializedTransaction,
        // Persist `submitted` before the first broadcast: once the transaction
        // may be on the wire, only the reconcile path (lookup + blockhash
        // expiry) is allowed to reach failed_not_submitted. A retry that
        // re-simulated a broadcast-but-unconfirmed transaction could otherwise
        // terminally fail an intent that still lands, re-open the
        // sellerRequestId, and double-pay the request.
        onBeforeSend: () => this.markPaymentSubmittedBeforeSend(intentToSubmit)
      });
    } catch (error) {
      if (
        isSettlementSubmissionError(error) &&
        error.outcome === "failed_not_submitted"
      ) {
        submissionResult = {
          status: "failed_not_submitted",
          errorCode: error.errorCode,
          errorMessage: error.message
        };
      } else {
        return this.recordAmbiguousSubmission(intentToSubmit, error);
      }
    }

    return this.ledger.withWalletVaultLock(
      intentToSubmit.wallet,
      intentToSubmit.vault,
      async () => {
        const latest = await this.ledger.getPayment(intentToSubmit.paymentId);
        if (latest === null) {
          return {
            isValid: false,
            invalidReason: "payment_not_found"
          };
        }

        const storedResponse = terminalSettlementResponseForStoredState(latest);
        if (storedResponse !== null) {
          return storedResponse;
        }

        return this.finalizeSubmittedPayment(latest, submissionResult);
      }
    );
  }

  private async markPaymentSubmittedBeforeSend(
    intent: PaymentIntent
  ): Promise<void> {
    await this.ledger.withWalletVaultLock(intent.wallet, intent.vault, async () => {
      const latest = await this.ledger.getPayment(intent.paymentId);
      if (latest === null || latest.status !== "submission_prepared") {
        return;
      }

      await this.ledger.savePayment({
        ...latest,
        status: "submitted",
        submittedAt: latest.submittedAt ?? new Date().toISOString()
      });
    });
  }

  private async reconcileSubmittedPayment(
    intent: PaymentIntent,
    input: VerifyPaymentPayloadInput
  ) {
    const verification = this.verifySettlementPayloadForIntent(intent, input);
    if (!verification.isValid) {
      return verification;
    }

    if (
      intent.txSignature === null &&
      intent.settlementResponse === null &&
      new Date(intent.expiresAt).getTime() > Date.now()
    ) {
      return pendingSettlementResponse(intent.paymentId);
    }

    if (
      !this.settlementSubmitter.ready ||
      this.settlementSubmitter.reconcilePaymentSettlement === undefined
    ) {
      return submittedSettlementResponseForStoredState(intent);
    }

    let reconciliation: SettlementReconciliationResult;
    try {
      reconciliation =
        await this.settlementSubmitter.reconcilePaymentSettlement({
          intent,
          sponsorFeePayer: this.config.sponsorFeePayer
        });
    } catch (error) {
      return this.recordAmbiguousSubmission(intent, error);
    }

    if (reconciliation.status === "submitted") {
      return this.recordPendingSubmission(intent, {
        txSignature: reconciliation.txSignature,
        settlementResponse: reconciliation.settlementResponse
      });
    }

    return this.ledger.withWalletVaultLock(intent.wallet, intent.vault, async () => {
      const latest = await this.ledger.getPayment(intent.paymentId);
      if (latest === null) {
        return {
          isValid: false,
          invalidReason: "payment_not_found"
        };
      }

      const storedResponse = terminalSettlementResponseForStoredState(latest);
      if (storedResponse !== null) {
        return storedResponse;
      }

      if (latest.status !== "submitted") {
        return invalidSettlementResponse(
          latest.paymentId,
          latest.status,
          `Payment intent is ${latest.status}`
        );
      }

      return this.finalizeSubmittedPayment(latest, reconciliation);
    });
  }

  async getPayment(paymentId: string) {
    const intent = await this.ledger.getPayment(paymentId);
    if (intent === null) {
      throw notFound("payment_not_found", "Payment intent does not exist");
    }

    return serializePaymentIntent(intent);
  }

  async upsertLiquidityPolicy(input: {
    sellerClass: string;
    vault?: string | undefined;
    expectedPaymentSizeRawUsdc: string;
    minInstantLiquidityRawUsdc: string;
    targetBudgetIlliquidRate: number;
    status?: "active" | "disabled" | undefined;
  }) {
    const vault = input.vault ?? SUBLY_VAULT.address;
    if (vault !== SUBLY_VAULT.address) {
      throw badRequest("unsupported_vault", "Only the Subly alpha vault is supported");
    }
    if (
      !Number.isFinite(input.targetBudgetIlliquidRate) ||
      input.targetBudgetIlliquidRate < 0 ||
      input.targetBudgetIlliquidRate > 1
    ) {
      throw badRequest(
        "invalid_liquidity_policy",
        "targetBudgetIlliquidRate must be between 0 and 1"
      );
    }

    const saved = await this.ledger.saveLiquidityPolicy({
      sellerClass: input.sellerClass,
      vault,
      expectedPaymentSizeRawUsdc: parsePositiveRawUnits(
        input.expectedPaymentSizeRawUsdc,
        "expectedPaymentSizeRawUsdc"
      ),
      minInstantLiquidityRawUsdc: parseRawUnits(
        input.minInstantLiquidityRawUsdc,
        "minInstantLiquidityRawUsdc"
      ),
      targetBudgetIlliquidRate: input.targetBudgetIlliquidRate,
      status: input.status ?? "active"
    });

    return serializeLiquidityPolicy(saved);
  }

  async listLiquidityPolicies() {
    const policies = await this.ledger.listLiquidityPolicies();
    return { policies: policies.map(serializeLiquidityPolicy) };
  }

  async recoverPendingSettlements(limit = 100) {
    if (!Number.isSafeInteger(limit) || limit <= 0) {
      throw badRequest("invalid_recovery_limit", "limit must be a positive safe integer");
    }

    const intents = await this.ledger.listPaymentsByStatus(
      ["submission_prepared", "submitted"],
      limit
    );
    const results = [];

    for (const intent of intents) {
      const payload = storedSettlementPayloadForIntent(intent);
      if (payload === null) {
        results.push({
          paymentId: intent.paymentId,
          status: intent.status,
          recovered: false,
          reason: "submission_record_missing_or_invalid"
        });
        continue;
      }

      const response =
        intent.status === "submission_prepared"
          ? await this.submitPreparedSettlement(intent, payload)
          : await this.reconcileSubmittedPayment(intent, payload);
      results.push({
        paymentId: intent.paymentId,
        status: intent.status,
        recovered: true,
        response
      });
    }

    return {
      processed: results.length,
      results
    };
  }

  private verifySettlementPayloadForIntent(
    intent: PaymentIntent,
    input: VerifyPaymentPayloadInput
  ) {
    if (intent.requestBindingHash !== input.requestBindingHash) {
      return {
        isValid: false,
        invalidReason: "request_binding_mismatch",
        paymentId: intent.paymentId
      };
    }

    if (intent.preparedMessageHash !== input.preparedMessageHash) {
      return {
        isValid: false,
        invalidReason: "message_hash_mismatch",
        paymentId: intent.paymentId
      };
    }

    const payloadVerification = this.paymentPayloadVerifier.verify({
      intent,
      serializedTransaction: input.serializedTransaction,
      agentSignature: input.agentSignature,
      temporarySettlementSignature: input.temporarySettlementSignature
    });
    if (!payloadVerification.ok) {
      return {
        isValid: false,
        invalidReason: payloadVerification.reason,
        paymentId: intent.paymentId
      };
    }

    return {
      isValid: true,
      paymentId: intent.paymentId,
      status: intent.status
    };
  }

  private submissionRecordValidationError(intent: PaymentIntent): SublyError | null {
    if (
      intent.txSignature === null ||
      intent.submittedSerializedTransaction === null
    ) {
      return unavailable(
        "submission_record_missing",
        "Prepared settlement submission is missing persisted transaction data"
      );
    }

    const actualTxSignature = transactionSignatureFromSerializedTransaction(
      intent.submittedSerializedTransaction
    );
    if (actualTxSignature === null) {
      return unavailable(
        "submission_record_invalid",
        "Persisted signed transaction is not a valid Solana transaction"
      );
    }
    if (actualTxSignature !== intent.txSignature) {
      return unavailable(
        "submission_record_invalid",
        "Persisted signed transaction signature does not match the recorded txSignature"
      );
    }

    const payload = storedSettlementPayloadForIntent(intent);
    if (payload === null) {
      return unavailable(
        "submission_record_invalid",
        "Persisted signed transaction is missing valid required signer signatures"
      );
    }

    const verification = this.verifySettlementPayloadForIntent(intent, payload);
    if (!verification.isValid) {
      return unavailable(
        "submission_record_invalid",
        `Persisted signed transaction does not match the prepared intent: ${verification.invalidReason}`
      );
    }

    return null;
  }

  private verifyLoadedPaymentPayload(
    intent: PaymentIntent,
    input: VerifyPaymentPayloadInput
  ) {
    if (intent.requestBindingHash !== input.requestBindingHash) {
      return {
        isValid: false,
        invalidReason: "request_binding_mismatch",
        paymentId: intent.paymentId
      };
    }

    if (intent.preparedMessageHash !== input.preparedMessageHash) {
      return {
        isValid: false,
        invalidReason: "message_hash_mismatch",
        paymentId: intent.paymentId
      };
    }

    // Terminal failures are not settleable; everything else (prepared,
    // submission_prepared, submitted, settled) verifies the payload so a
    // seller retry after a settle timeout can still reach /settle and
    // recover the idempotent settlement state or receipt.
    if (isTerminalFailedPaymentStatus(intent.status)) {
      return {
        isValid: false,
        invalidReason: intent.status,
        paymentId: intent.paymentId
      };
    }

    if (intent.status === "prepared" && paymentIntentExpired(intent)) {
      return {
        isValid: false,
        invalidReason: "expired",
        paymentId: intent.paymentId
      };
    }

    const payloadVerification = this.paymentPayloadVerifier.verify({
      intent,
      serializedTransaction: input.serializedTransaction,
      agentSignature: input.agentSignature,
      temporarySettlementSignature: input.temporarySettlementSignature
    });
    if (!payloadVerification.ok) {
      return {
        isValid: false,
        invalidReason: payloadVerification.reason,
        paymentId: intent.paymentId
      };
    }

    return {
      isValid: true,
      paymentId: intent.paymentId,
      status: intent.status
    };
  }

  private async expirePreparedPayment(intent: PaymentIntent) {
    const response = invalidSettlementResponse(
      intent.paymentId,
      "expired",
      "Payment intent has expired"
    );
    const now = new Date().toISOString();
    const position = await this.ledger.getPosition(intent.wallet, intent.vault);
    if (position !== null) {
      await this.ledger.savePosition({
        ...position,
        reservedRawUsdc: clampToZero(
          position.reservedRawUsdc - intent.reservationRawUsdc
        ),
        version: position.version + 1
      });
    }

    await this.ledger.savePayment({
      ...intent,
      status: "expired",
      terminalAt: now,
      settlementResponse: response
    });

    return response;
  }

  private async expirePreparedPaymentsForLockedPosition(
    wallet: string,
    vault: string
  ): Promise<WalletPosition | null> {
    return expirePreparedPaymentsForLockedPosition(this.ledger, wallet, vault);
  }

  private async activeWithdrawReservedRawUsdc(
    wallet: string,
    vault: string
  ): Promise<bigint> {
    const payments = await this.ledger.listPaymentsForPosition(wallet, vault);
    return payments
      .filter(paymentHoldsSettlementReservation)
      .reduce((total, payment) => total + payment.requiredWithdrawRawUsdc, 0n);
  }

  private async finalizeSubmittedPayment(
    intent: PaymentIntent,
    result: SettlementSubmissionResult
  ) {
    const validationError = settlementResultValidationError(intent, result);
    if (validationError !== null) {
      const position = await this.ledger.getPosition(intent.wallet, intent.vault);
      if (position !== null) {
        await this.ledger.savePosition({
          ...position,
          status: "needs_baseline_reset",
          version: position.version + 1
        });
      }

      await this.ledger.savePayment({
        ...intent,
        status: "submitted",
        submittedAt: intent.submittedAt ?? new Date().toISOString(),
        txSignature: settlementResultTxSignature(result) ?? intent.txSignature,
        settlementResponse: pendingSettlementResponse(intent.paymentId, {
          code: validationError.code,
          message: validationError.message
        })
      });
      throw validationError;
    }

    const response =
      result.status === "settled"
        ? successfulSettlementResponse({
            intent,
            result,
            sponsorFeePayer: this.config.sponsorFeePayer
          })
        : failedSettlementResponse({ intent, result });
    const now = new Date().toISOString();
    const position = await this.ledger.getPosition(intent.wallet, intent.vault);
    if (position !== null) {
      await this.ledger.savePosition(
        applySettlementResultToPosition(position, intent, result)
      );
    }
    if (result.status !== "failed_not_submitted") {
      await this.recordSyncEvent({
        wallet: intent.wallet,
        vault: intent.vault,
        eventType:
          result.status === "settled" ? "payment_settled" : "payment_landed_failed",
        deltaSharesRaw:
          result.status === "settled"
            ? -(result.actualSharesRedeemedRaw ?? intent.sharesToRedeemRaw)
            : 0n,
        deltaPrincipalRawUsdc: 0n,
        classification: result.status,
        sourceEndpoint: "subly_settlement",
        txSignature: result.txSignature,
        rawSnapshot: { paymentId: intent.paymentId }
      });
    }

    await this.ledger.savePayment({
      ...intent,
      status: result.status,
      submittedAt:
        result.status === "failed_not_submitted"
          ? intent.submittedAt
          : intent.submittedAt ?? now,
      terminalAt: now,
      txSignature:
        result.status === "failed_not_submitted" ? null : result.txSignature,
      settlementResponse: response
    });

    return response;
  }

  private async recordAmbiguousSubmission(
    intent: PaymentIntent,
    error: unknown
  ) {
    const txSignature =
      isSettlementSubmissionError(error) && error.txSignature !== null
        ? error.txSignature
        : undefined;
    const errorCode = isSettlementSubmissionError(error)
      ? error.errorCode
      : "settlement_submission_ambiguous";
    const message =
      error instanceof Error
        ? error.message
        : "Settlement submission outcome is unknown";

    return this.recordPendingSubmission(intent, {
      txSignature,
      settlementResponse: pendingSettlementResponse(intent.paymentId, {
        code: errorCode,
        message
      })
    });
  }

  private async recordPendingSubmission(
    intent: PaymentIntent,
    params: {
      txSignature?: string | undefined;
      settlementResponse?: unknown;
    }
  ) {
    return this.ledger.withWalletVaultLock(intent.wallet, intent.vault, async () => {
      const latest = await this.ledger.getPayment(intent.paymentId);
      if (latest === null) {
        return {
          isValid: false,
          invalidReason: "payment_not_found"
        };
      }

      const terminalResponse = terminalSettlementResponseForStoredState(latest);
      if (terminalResponse !== null) {
        return terminalResponse;
      }

      const response =
        params.settlementResponse ??
        latest.settlementResponse ??
        pendingSettlementResponse(intent.paymentId);
      const now = new Date().toISOString();
      await this.ledger.savePayment({
        ...latest,
        status: "submitted",
        submittedAt: latest.submittedAt ?? now,
        txSignature: latest.txSignature ?? params.txSignature ?? null,
        settlementResponse: response
      });

      return response;
    });
  }
}

function nextWalletStatusAfterSignerUpdate(input: {
  existingStatus: WalletPosition["status"];
  nextSigningMode: SigningMode;
  nextSignerProvider: string;
  activateForPayments: boolean;
}): WalletPosition["status"] {
  if (input.existingStatus === "needs_baseline_reset") {
    return "needs_baseline_reset";
  }

  if (
    input.nextSigningMode === "observed_only" ||
    input.nextSignerProvider === "unconfigured"
  ) {
    return "observed_only";
  }

  if (input.existingStatus === "observed_only" && input.activateForPayments) {
    return "active";
  }

  return input.existingStatus;
}

function walletStatusAfterConservativeReset(
  position: WalletPosition
): WalletPosition["status"] {
  return position.signingMode === "non_interactive" &&
    position.signerProvider !== "unconfigured"
    ? "active"
    : "observed_only";
}

function isTerminalFailedPaymentStatus(
  status: PaymentIntent["status"]
): boolean {
  return (
    status === "expired" ||
    status === "failed" ||
    status === "failed_not_submitted"
  );
}

function paymentHoldsSettlementReservation(intent: PaymentIntent): boolean {
  return (
    intent.status === "prepared" ||
    intent.status === "submission_prepared" ||
    intent.status === "submitted"
  );
}

function terminalSettlementResponseForStoredState(
  intent: PaymentIntent
): unknown | null {
  if (
    intent.status === "prepared" ||
    intent.status === "submission_prepared" ||
    intent.status === "submitted"
  ) {
    return null;
  }

  if (intent.settlementResponse !== null) {
    return intent.settlementResponse;
  }

  return invalidSettlementResponse(
    intent.paymentId,
    intent.status,
    `Payment intent is ${intent.status}`
  );
}

function submittedSettlementResponseForStoredState(intent: PaymentIntent) {
  return intent.settlementResponse ?? pendingSettlementResponse(intent.paymentId);
}

function pendingSettlementResponse(
  paymentId: string,
  latestError?: { code: string; message: string } | undefined
) {
  return {
    success: false,
    paymentId,
    error: {
      code: "settlement_pending",
      message: "Settlement is already submitted and awaiting terminal confirmation"
    },
    ...(latestError === undefined ? {} : { latestError })
  };
}

function invalidSettlementResponse(
  paymentId: string,
  code: string,
  message: string
) {
  return {
    isValid: false,
    invalidReason: code,
    paymentId,
    success: false,
    error: {
      code,
      message
    }
  };
}

function successfulSettlementResponse(input: {
  intent: PaymentIntent;
  result: Extract<SettlementSubmissionResult, { status: "settled" }>;
  sponsorFeePayer: string | null;
}) {
  const sharesRedeemedRaw =
    input.result.actualSharesRedeemedRaw ?? input.intent.sharesToRedeemRaw;
  const sellerTransferRawUsdc =
    input.result.sellerTransferRawUsdc ?? input.intent.amountRawUsdc;
  const withdrawOutputRawUsdc =
    input.result.withdrawOutputRawUsdc ??
    input.intent.requiredWithdrawRawUsdc;
  const dustTransferRawUsdc =
    input.result.dustTransferRawUsdc ??
    clampToZero(withdrawOutputRawUsdc - sellerTransferRawUsdc);

  return {
    success: true,
    transaction: input.result.txSignature,
    network: SOLANA_MAINNET_NETWORK,
    payer: input.sponsorFeePayer,
    asset: input.intent.asset,
    amount: rawUnitsToString(input.intent.amountRawUsdc),
    extensions: {
      subly: {
        paymentId: input.intent.paymentId,
        sellerRequestId: input.intent.sellerRequestId,
        requestBindingHash: input.intent.requestBindingHash,
        httpMethod: input.intent.httpMethod,
        canonicalResourceUrl: input.intent.canonicalResourceUrl,
        requestBodyHash: input.intent.requestBodyHash,
        agentWallet: input.intent.wallet,
        payTo: input.intent.payTo,
        sellerUsdcAta: input.intent.sellerUsdcAta,
        vault: input.intent.vault,
        temporarySettlementTokenAccount:
          input.intent.temporarySettlementTokenAccount,
        sharesRedeemedRaw: rawUnitsToString(sharesRedeemedRaw),
        withdrawOutputRawUsdc: rawUnitsToString(withdrawOutputRawUsdc),
        sellerTransferRawUsdc: rawUnitsToString(sellerTransferRawUsdc),
        dustTransferRawUsdc: rawUnitsToString(dustTransferRawUsdc),
        principalBasisBeforeRawUsdc: rawUnitsToString(
          input.intent.principalBasisBeforeRawUsdc
        ),
        grossYieldBeforeRawUsdc: rawUnitsToString(
          input.intent.grossYieldBeforeRawUsdc
        ),
        spendableYieldBeforeRawUsdc: rawUnitsToString(
          input.intent.spendableYieldBeforeRawUsdc
        ),
        postPositionValueRawUsdc: rawUnitsToString(
          input.intent.postPositionValueRawUsdc
        ),
        fundingMode: "kamino_jit_yield"
      }
    }
  };
}

function failedSettlementResponse(input: {
  intent: PaymentIntent;
  result: Exclude<SettlementSubmissionResult, { status: "settled" }>;
}) {
  return {
    success: false,
    transaction:
      input.result.status === "failed" ? input.result.txSignature : null,
    paymentId: input.intent.paymentId,
    error: {
      code: input.result.errorCode,
      message: input.result.errorMessage
    },
    extensions: {
      subly: {
        paymentId: input.intent.paymentId,
        sellerRequestId: input.intent.sellerRequestId,
        requestBindingHash: input.intent.requestBindingHash,
        agentWallet: input.intent.wallet,
        payTo: input.intent.payTo,
        sellerUsdcAta: input.intent.sellerUsdcAta,
        vault: input.intent.vault,
        fundingMode: "kamino_jit_yield"
      }
    }
  };
}

function applySettlementResultToPosition(
  position: WalletPosition,
  intent: PaymentIntent,
  result: SettlementSubmissionResult
): WalletPosition {
  const feeDebtRawUsdc =
    result.status === "failed_not_submitted"
      ? 0n
      : result.actualFeeDebtRawUsdc ?? intent.estimatedFeeDebtRawUsdc;
  const feeDebtExceededEstimate =
    result.status !== "failed_not_submitted" &&
    feeDebtRawUsdc > intent.estimatedFeeDebtRawUsdc;
  const base: WalletPosition = {
    ...position,
    reservedRawUsdc: clampToZero(
      position.reservedRawUsdc - intent.reservationRawUsdc
    ),
    feeDebtRawUsdc: position.feeDebtRawUsdc + feeDebtRawUsdc,
    status: feeDebtExceededEstimate ? "needs_baseline_reset" : position.status,
    version: position.version + 1
  };

  if (result.status !== "settled") {
    return base;
  }

  const sharesRedeemedRaw =
    result.actualSharesRedeemedRaw ?? intent.sharesToRedeemRaw;
  if (sharesRedeemedRaw > position.totalSharesRaw) {
    return {
      ...base,
      status: "needs_baseline_reset"
    };
  }

  const shareBalances = subtractRedeemedShares(
    position,
    sharesRedeemedRaw
  );
  const withdrawOutputRawUsdc =
    result.withdrawOutputRawUsdc ?? intent.requiredWithdrawRawUsdc;

  return {
    ...base,
    ...shareBalances,
    instantRedeemCapacityRawUsdc: clampToZero(
      position.instantRedeemCapacityRawUsdc - withdrawOutputRawUsdc
    )
  };
}

function settlementResultValidationError(
  intent: PaymentIntent,
  result: SettlementSubmissionResult
): SublyError | null {
  const resultTxSignature = settlementResultTxSignature(result);
  if (
    intent.txSignature !== null &&
    resultTxSignature !== null &&
    resultTxSignature !== intent.txSignature
  ) {
    return conflict(
      "settlement_result_invalid",
      "Settlement result transaction signature does not match the prepared submission",
      {
        paymentId: intent.paymentId,
        txSignature: resultTxSignature,
        expectedTxSignature: intent.txSignature
      }
    );
  }

  if (result.status !== "settled") {
    return null;
  }

  const sharesRedeemedRaw =
    result.actualSharesRedeemedRaw ?? intent.sharesToRedeemRaw;
  if (sharesRedeemedRaw > intent.sharesToRedeemRaw) {
    return conflict(
      "settlement_result_invalid",
      "Settlement redeemed more shares than the prepared maximum",
      {
        paymentId: intent.paymentId,
        sharesRedeemedRaw: sharesRedeemedRaw.toString(),
        maxPreparedSharesToRedeemRaw: intent.sharesToRedeemRaw.toString()
      }
    );
  }

  const withdrawOutputRawUsdc =
    result.withdrawOutputRawUsdc ?? intent.requiredWithdrawRawUsdc;
  const sellerTransferRawUsdc = result.sellerTransferRawUsdc;
  if (sellerTransferRawUsdc === undefined) {
    return conflict(
      "settlement_result_invalid",
      "Settlement result is missing the seller transfer amount",
      {
        paymentId: intent.paymentId
      }
    );
  }
  if (sellerTransferRawUsdc !== intent.amountRawUsdc) {
    return conflict(
      "settlement_result_invalid",
      "Settlement seller transfer does not match the payment amount",
      {
        paymentId: intent.paymentId,
        sellerTransferRawUsdc: sellerTransferRawUsdc.toString(),
        amountRawUsdc: intent.amountRawUsdc.toString()
      }
    );
  }
  if (withdrawOutputRawUsdc < intent.amountRawUsdc) {
    return conflict(
      "settlement_result_invalid",
      "Settlement withdraw output is less than the seller payment amount",
      {
        paymentId: intent.paymentId,
        withdrawOutputRawUsdc: withdrawOutputRawUsdc.toString(),
        amountRawUsdc: intent.amountRawUsdc.toString()
      }
    );
  }

  if (result.dustTransferRawUsdc !== undefined) {
    const expectedDustRawUsdc = withdrawOutputRawUsdc - sellerTransferRawUsdc;
    if (result.dustTransferRawUsdc !== expectedDustRawUsdc) {
      return conflict(
        "settlement_result_invalid",
        "Settlement dust transfer does not match withdraw output minus seller amount",
        {
          paymentId: intent.paymentId,
          dustTransferRawUsdc: result.dustTransferRawUsdc.toString(),
          expectedDustTransferRawUsdc: expectedDustRawUsdc.toString()
        }
      );
    }
  }

  return null;
}

function settlementResultTxSignature(
  result: SettlementSubmissionResult
): string | null {
  return result.status === "failed_not_submitted" ? null : result.txSignature;
}

function subtractRedeemedShares(
  position: WalletPosition,
  sharesRedeemedRaw: bigint
): Pick<
  WalletPosition,
  "stakedSharesRaw" | "unstakedSharesRaw" | "totalSharesRaw"
> {
  if (sharesRedeemedRaw > position.totalSharesRaw) {
    throw new Error("sharesRedeemedRaw exceeds the tracked wallet share balance");
  }

  const unstakedRedeemedRaw = minBigInt(
    position.unstakedSharesRaw,
    sharesRedeemedRaw
  );
  const remainingRedeemRaw = sharesRedeemedRaw - unstakedRedeemedRaw;
  const stakedRedeemedRaw = minBigInt(
    position.stakedSharesRaw,
    remainingRedeemRaw
  );
  const stakedSharesRaw = position.stakedSharesRaw - stakedRedeemedRaw;
  const unstakedSharesRaw = position.unstakedSharesRaw - unstakedRedeemedRaw;

  return {
    stakedSharesRaw,
    unstakedSharesRaw,
    totalSharesRaw: stakedSharesRaw + unstakedSharesRaw
  };
}

export function serializeWalletPosition(position: WalletPosition) {
  return {
    wallet: position.wallet,
    vault: position.vault,
    signingPolicyId: position.signingPolicyId,
    signingMode: position.signingMode,
    signerValidationMode: position.signerValidationMode,
    signerProvider: position.signerProvider,
    stakedSharesRaw: rawUnitsToString(position.stakedSharesRaw),
    unstakedSharesRaw: rawUnitsToString(position.unstakedSharesRaw),
    totalSharesRaw: rawUnitsToString(position.totalSharesRaw),
    exchangeRateScaled: rawUnitsToString(position.exchangeRateScaled),
    instantRedeemCapacityRawUsdc: rawUnitsToString(
      position.instantRedeemCapacityRawUsdc
    ),
    principalBasisRawUsdc: rawUnitsToString(position.principalBasisRawUsdc),
    principalBasisSource: position.principalBasisSource,
    reservedRawUsdc: rawUnitsToString(position.reservedRawUsdc),
    feeDebtRawUsdc: rawUnitsToString(position.feeDebtRawUsdc),
    safetyBufferRawUsdc: rawUnitsToString(position.safetyBufferRawUsdc),
    lastSyncedSlot: position.lastSyncedSlot,
    version: position.version,
    status: position.status
  };
}

export function serializeBudget(position: WalletPosition) {
  const budget = computeBudgetSnapshot(position);

  return {
    position: serializeWalletPosition(position),
    budget: {
      positionValueRawUsdc: rawUnitsToString(budget.positionValueRawUsdc),
      grossYieldRawUsdc: rawUnitsToString(budget.grossYieldRawUsdc),
      spendableYieldRawUsdc: rawUnitsToString(budget.spendableYieldRawUsdc)
    }
  };
}

export function serializeSyncEvent(event: SyncEvent) {
  return {
    eventId: event.eventId,
    wallet: event.wallet,
    vault: event.vault,
    eventType: event.eventType,
    txSignature: event.txSignature,
    deltaSharesRaw: event.deltaSharesRaw.toString(),
    deltaPrincipalRawUsdc: event.deltaPrincipalRawUsdc.toString(),
    classification: event.classification,
    sourceEndpoint: event.sourceEndpoint,
    rawSnapshot: event.rawSnapshot,
    slot: event.slot,
    observedAt: event.observedAt
  };
}

export function serializeLiquidityPolicy(policy: SellerLiquidityPolicy) {
  return {
    sellerClass: policy.sellerClass,
    vault: policy.vault,
    expectedPaymentSizeRawUsdc: rawUnitsToString(
      policy.expectedPaymentSizeRawUsdc
    ),
    minInstantLiquidityRawUsdc: rawUnitsToString(
      policy.minInstantLiquidityRawUsdc
    ),
    targetBudgetIlliquidRate: policy.targetBudgetIlliquidRate,
    status: policy.status
  };
}

export function serializePaymentIntent(intent: PaymentIntent) {
  return {
    paymentId: intent.paymentId,
    wallet: intent.wallet,
    vault: intent.vault,
    seller: intent.seller,
    sellerRequestId: intent.sellerRequestId,
    httpMethod: intent.httpMethod,
    canonicalResourceUrl: intent.canonicalResourceUrl,
    requestBodyHash: intent.requestBodyHash,
    requestBindingHash: intent.requestBindingHash,
    asset: intent.asset,
    amountRawUsdc: rawUnitsToString(intent.amountRawUsdc),
    payTo: intent.payTo,
    sellerUsdcAta: intent.sellerUsdcAta,
    dustRecipientUsdcAta: intent.dustRecipientUsdcAta,
    signingPolicyId: intent.signingPolicyId,
    preparedMessageHash: intent.preparedMessageHash,
    recentBlockhash: intent.recentBlockhash,
    lastValidBlockHeight: intent.lastValidBlockHeight,
    temporarySettlementTokenAccount: intent.temporarySettlementTokenAccount,
    temporarySettlementSignature: intent.temporarySettlementSignature,
    sharesToRedeemRaw: rawUnitsToString(intent.sharesToRedeemRaw),
    requiredWithdrawRawUsdc: rawUnitsToString(intent.requiredWithdrawRawUsdc),
    estimatedFeeLamports: rawUnitsToString(intent.estimatedFeeLamports),
    estimatedFeeDebtRawUsdc: rawUnitsToString(intent.estimatedFeeDebtRawUsdc),
    principalBasisBeforeRawUsdc: rawUnitsToString(
      intent.principalBasisBeforeRawUsdc
    ),
    grossYieldBeforeRawUsdc: rawUnitsToString(intent.grossYieldBeforeRawUsdc),
    spendableYieldBeforeRawUsdc: rawUnitsToString(
      intent.spendableYieldBeforeRawUsdc
    ),
    postPositionValueRawUsdc: rawUnitsToString(intent.postPositionValueRawUsdc),
    reservationRawUsdc: rawUnitsToString(intent.reservationRawUsdc),
    status: intent.status,
    expiresAt: intent.expiresAt,
    submittedAt: intent.submittedAt,
    terminalAt: intent.terminalAt,
    txSignature: intent.txSignature,
    submittedSerializedTransaction: intent.submittedSerializedTransaction,
    settlementResponse: intent.settlementResponse,
    intentJson: intent.intentJson
  };
}

function assertExpectedPaymentRequirement(input: {
  scheme: string;
  network: string;
  vault: string;
  shareMint: string;
  asset: string;
  requestBodyHash: string;
  canonicalResourceUrl: string;
}) {
  if (input.scheme !== PAYMENT_SCHEME) {
    throw badRequest("unsupported_scheme", `scheme must be ${PAYMENT_SCHEME}`);
  }
  if (input.network !== SOLANA_MAINNET_NETWORK) {
    throw badRequest(
      "unsupported_network",
      `network must be ${SOLANA_MAINNET_NETWORK}`
    );
  }
  if (input.vault !== SUBLY_VAULT.address) {
    throw badRequest("unsupported_vault", "Unsupported Kamino vault");
  }
  if (input.shareMint !== SUBLY_VAULT.shareMint) {
    throw badRequest("unsupported_share_mint", "Unsupported vault share mint");
  }
  if (input.asset !== SUBLY_VAULT.usdcMint) {
    throw badRequest("unsupported_asset", "Only USDC is supported");
  }
  if (!/^sha256-([a-f0-9]{64}|empty)$/.test(input.requestBodyHash)) {
    throw badRequest(
      "invalid_request_body_hash",
      "requestBodyHash must be sha256-<hex> or sha256-empty"
    );
  }
  try {
    const url = new URL(input.canonicalResourceUrl);
    const isLoopbackHttp =
      url.protocol === "http:" &&
      !isProductionEnv() &&
      (url.hostname === "localhost" ||
        url.hostname === "127.0.0.1" ||
        url.hostname === "[::1]");
    if (url.protocol !== "https:" && !isLoopbackHttp) {
      throw new Error("canonicalResourceUrl must use https");
    }
  } catch (error) {
    throw badRequest(
      "invalid_canonical_resource_url",
      error instanceof Error
        ? error.message
        : "canonicalResourceUrl must be a valid URL"
    );
  }
}

function assertPreparedSettlementTransaction(
  prepared: PreparedSettlementTransaction
) {
  if (!/^sha256-[a-f0-9]{64}$/.test(prepared.preparedMessageHash)) {
    throw invalidPreparedSettlementTransaction(
      "preparedMessageHash must be sha256-<hex>"
    );
  }
  const actualMessageHash = preparedMessageHashFromSerializedTransaction(
    prepared.serializedTransaction
  );
  if (actualMessageHash === null) {
    throw invalidPreparedSettlementTransaction(
      "serializedTransaction must be a valid Solana transaction"
    );
  }
  if (actualMessageHash !== prepared.preparedMessageHash) {
    throw invalidPreparedSettlementTransaction(
      "preparedMessageHash must match the serialized transaction message"
    );
  }
  try {
    assertSolanaAddress(
      prepared.temporarySettlementTokenAccount,
      "temporarySettlementTokenAccount"
    );
  } catch {
    throw invalidPreparedSettlementTransaction(
      "temporarySettlementTokenAccount must be a valid Solana public key"
    );
  }
  if (prepared.temporarySettlementSignature.length === 0) {
    throw invalidPreparedSettlementTransaction(
      "temporarySettlementSignature must be non-empty"
    );
  }
  const temporarySignature = extractValidRequiredSignerSignature({
    serializedTransaction: prepared.serializedTransaction,
    signerPublicKey: prepared.temporarySettlementTokenAccount
  });
  if (!temporarySignature.ok) {
    throw invalidPreparedSettlementTransaction(
      `temporarySettlementSignature must be a valid required signer signature: ${temporarySignature.reason}`
    );
  }
  if (temporarySignature.signature !== prepared.temporarySettlementSignature) {
    throw invalidPreparedSettlementTransaction(
      "temporarySettlementSignature must match the serialized transaction signature"
    );
  }
  if (
    prepared.recentBlockhash !== null &&
    prepared.recentBlockhash.length === 0
  ) {
    throw invalidPreparedSettlementTransaction(
      "recentBlockhash must be null or non-empty"
    );
  }
  if (
    prepared.lastValidBlockHeight !== null &&
    (!Number.isSafeInteger(prepared.lastValidBlockHeight) ||
      prepared.lastValidBlockHeight < 0)
  ) {
    throw invalidPreparedSettlementTransaction(
      "lastValidBlockHeight must be null or a non-negative safe integer"
    );
  }
}

function invalidPreparedSettlementTransaction(message: string): SublyError {
  return unavailable("transaction_builder_invalid", message);
}

function storedSettlementPayloadForIntent(
  intent: PaymentIntent
): VerifyPaymentPayloadInput | null {
  if (intent.submittedSerializedTransaction === null) {
    return null;
  }

  const agentSignature = extractValidRequiredSignerSignature({
    serializedTransaction: intent.submittedSerializedTransaction,
    signerPublicKey: intent.wallet
  });
  if (!agentSignature.ok) {
    return null;
  }

  const temporarySettlementSignature = extractValidRequiredSignerSignature({
    serializedTransaction: intent.submittedSerializedTransaction,
    signerPublicKey: intent.temporarySettlementTokenAccount
  });
  if (!temporarySettlementSignature.ok) {
    return null;
  }

  return {
    paymentId: intent.paymentId,
    requestBindingHash: intent.requestBindingHash,
    preparedMessageHash: intent.preparedMessageHash,
    serializedTransaction: intent.submittedSerializedTransaction,
    agentSignature: agentSignature.signature,
    temporarySettlementSignature: temporarySettlementSignature.signature
  };
}

function assertProductionSettlementDependencies(input: {
  transactionBuilderConfigured: boolean;
  settlementSubmitterConfigured: boolean;
  settlementSubmitter: SettlementSubmitter;
}) {
  if (!isProductionEnv()) {
    return;
  }

  if (!input.transactionBuilderConfigured) {
    throw badRequest(
      "transaction_builder_not_configured",
      "A concrete settlement transaction builder must be configured in production"
    );
  }

  if (
    !input.settlementSubmitterConfigured ||
    !input.settlementSubmitter.ready ||
    input.settlementSubmitter.preparePaymentSettlementSubmission === undefined ||
    input.settlementSubmitter.reconcilePaymentSettlement === undefined
  ) {
    throw badRequest(
      "settlement_submitter_not_configured",
      "A ready settlement submitter with prepare and reconcile support must be configured in production"
    );
  }
}

export function defaultSublyService() {
  const sponsorFeePayer =
    process.env.SUBLY_SPONSOR_FEE_PAYER === undefined
      ? null
      : requireSolanaAddress(
          process.env.SUBLY_SPONSOR_FEE_PAYER,
          "SUBLY_SPONSOR_FEE_PAYER"
        );

  return new SublyService({
    ledger: defaultLedger(),
    config: {
      sponsorFeePayer
    }
  });
}

export function isSublyError(error: unknown): error is SublyError {
  return error instanceof SublyError;
}

function requireSolanaAddress(value: string, fieldName: string): string {
  try {
    return assertSolanaAddress(value, fieldName);
  } catch {
    throw badRequest(
      "invalid_solana_address",
      `${fieldName} must be a valid Solana public key`,
      {
        fieldName
      }
    );
  }
}

function normalizeRequestBodyHash(value: string | undefined): string {
  if (value === undefined || value === "sha256-empty") {
    return EMPTY_BODY_HASH;
  }

  return value;
}

function defaultLedger(): Ledger {
  if (process.env.DATABASE_URL !== undefined) {
    return new PostgresLedger(process.env.DATABASE_URL);
  }

  if (isProductionEnv()) {
    throw badRequest(
      "database_not_configured",
      "DATABASE_URL must be configured in production"
    );
  }

  return new InMemoryLedger();
}

function defaultFeeEstimator(config: SublyServiceConfig): FeeEstimator {
  const hasPolicyFeeEnv =
    process.env.SUBLY_ESTIMATED_FEE_LAMPORTS !== undefined ||
    process.env.SUBLY_SOL_USDC_PRICE_SCALED !== undefined ||
    process.env.SUBLY_PRICE_SCALE !== undefined ||
    process.env.SUBLY_FEE_OBSERVED_AT !== undefined;

  if (hasPolicyFeeEnv) {
    return feeEstimatorFromEnv(process.env);
  }

  if (isProductionEnv()) {
    throw badRequest(
      "fee_estimator_not_configured",
      "Fee estimator oracle environment variables must be configured in production"
    );
  }

  return new StaticFeeEstimator({
    estimatedFeeLamports: config.defaultEstimatedFeeLamports,
    estimatedFeeDebtRawUsdc: config.defaultEstimatedFeeDebtRawUsdc
  });
}
