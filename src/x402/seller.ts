import {
  PAYMENT_SCHEME,
  SOLANA_MAINNET_NETWORK,
  SUBLY_VAULT
} from "../config/constants.js";
import { computeRequestBindingHash } from "../domain/request-binding.js";
import { deriveAssociatedTokenAddress } from "../lib/associated-token-account.js";
import {
  decodePaymentSignatureHeader,
  encodeX402Header,
  PAYMENT_REQUIRED_HEADER,
  PAYMENT_RESPONSE_HEADER,
  requestBodyHashFor,
  X402_VERSION,
  X402HeaderError,
  type PaymentRequired,
  type SublyPaymentRequirements
} from "./headers.js";

export type FetchLike = (
  url: string,
  init: {
    method: string;
    headers: Record<string, string>;
    body: string;
  }
) => Promise<{ status: number; json(): Promise<unknown> }>;

export interface SellerGateConfig {
  /** Subly facilitator base URL, e.g. https://facilitator.subly.dev */
  facilitatorBaseUrl: string;
  sellerApiToken: string;
  /** Seller wallet that receives USDC. */
  payTo: string;
  network?: string;
  maxTimeoutSeconds?: number;
  fetchImpl?: FetchLike;
}

export interface PricedRequest {
  /** Unique id for this priced request; part of the request binding. */
  sellerRequestId: string;
  httpMethod: string;
  /** Canonical resource URL the agent must pay for. */
  resource: string;
  amountRawUsdc: string;
  description?: string;
  /** Raw request body for binding; omit for bodyless requests. */
  body?: string | Uint8Array | null;
}

export type SellerGateResult =
  | {
      granted: true;
      paymentId: string;
      settlementResponse: unknown;
      /** Value for the PAYMENT-RESPONSE header on the protected response. */
      responseHeaders: Record<string, string>;
    }
  | {
      granted: false;
      reason: string;
      detail?: unknown;
    };

/**
 * Seller-side helper for the subly-yield-exact scheme. Framework agnostic:
 * the seller builds the 402 challenge with `paymentRequiredResponse` and, on
 * retry, passes the PAYMENT-SIGNATURE header to `settle`. Access is granted
 * only after the facilitator's /settle reports success (settle-before-deliver).
 */
export class SublySellerGate {
  private readonly config: Required<
    Pick<SellerGateConfig, "facilitatorBaseUrl" | "sellerApiToken" | "payTo">
  > & {
    network: string;
    maxTimeoutSeconds: number;
  };
  private readonly fetchImpl: FetchLike;
  private readonly sellerUsdcAta: string;

  constructor(config: SellerGateConfig) {
    this.config = {
      facilitatorBaseUrl: config.facilitatorBaseUrl.replace(/\/$/, ""),
      sellerApiToken: config.sellerApiToken,
      payTo: config.payTo,
      network: config.network ?? SOLANA_MAINNET_NETWORK,
      maxTimeoutSeconds: config.maxTimeoutSeconds ?? 120
    };
    this.fetchImpl = config.fetchImpl ?? (fetch as unknown as FetchLike);
    this.sellerUsdcAta = deriveAssociatedTokenAddress({
      owner: config.payTo,
      mint: SUBLY_VAULT.usdcMint
    });
  }

  /** Builds the 402 challenge body and PAYMENT-REQUIRED header value. */
  paymentRequiredResponse(request: PricedRequest): {
    statusCode: 402;
    headers: Record<string, string>;
    body: PaymentRequired;
  } {
    const requirement: SublyPaymentRequirements = {
      scheme: PAYMENT_SCHEME,
      network: this.config.network,
      asset: SUBLY_VAULT.usdcMint,
      amountRawUsdc: request.amountRawUsdc,
      resource: request.resource,
      ...(request.description === undefined
        ? {}
        : { description: request.description }),
      payTo: this.config.payTo,
      maxTimeoutSeconds: this.config.maxTimeoutSeconds,
      extra: {
        sellerRequestId: request.sellerRequestId,
        seller: this.config.payTo,
        sellerUsdcAta: this.sellerUsdcAta,
        vault: SUBLY_VAULT.address,
        shareMint: SUBLY_VAULT.shareMint
      }
    };
    const body: PaymentRequired = {
      x402Version: X402_VERSION,
      accepts: [requirement]
    };

    return {
      statusCode: 402,
      headers: { [PAYMENT_REQUIRED_HEADER]: encodeX402Header(body) },
      body
    };
  }

  /**
   * Verifies and settles a retried request carrying PAYMENT-SIGNATURE. The
   * binding hash is recomputed from the seller's own request facts, so a
   * payload prepared for a different request, amount, or payee never settles.
   */
  async settle(params: {
    paymentSignatureHeader: string;
    request: PricedRequest;
  }): Promise<SellerGateResult> {
    let payload;
    try {
      payload = decodePaymentSignatureHeader(params.paymentSignatureHeader);
    } catch (error) {
      return {
        granted: false,
        reason:
          error instanceof X402HeaderError
            ? error.reason
            : "invalid_payment_payload"
      };
    }

    if (payload.network !== this.config.network) {
      return { granted: false, reason: "network_mismatch" };
    }

    const expectedBindingHash = computeRequestBindingHash({
      sellerRequestId: params.request.sellerRequestId,
      httpMethod: params.request.httpMethod,
      canonicalResourceUrl: params.request.resource,
      requestBodyHash: requestBodyHashFor(params.request.body),
      seller: this.config.payTo,
      asset: SUBLY_VAULT.usdcMint,
      amountRawUsdc: params.request.amountRawUsdc,
      payTo: this.config.payTo,
      sellerUsdcAta: this.sellerUsdcAta
    });
    if (payload.payload.requestBindingHash !== expectedBindingHash) {
      return { granted: false, reason: "request_binding_mismatch" };
    }

    const verify = await this.callFacilitator("/v1/x402/verify", payload.payload);
    if (!isValidVerifyResponse(verify)) {
      return {
        granted: false,
        reason: invalidReasonOf(verify) ?? "verification_failed",
        detail: verify
      };
    }

    const settlement = await this.callFacilitator(
      "/v1/x402/settle",
      payload.payload
    );
    if (!isSuccessfulSettlement(settlement)) {
      return {
        granted: false,
        reason: invalidReasonOf(settlement) ?? "settlement_failed",
        detail: settlement
      };
    }
    const settlementMismatch = settlementMismatchReason({
      settlement,
      paymentId: payload.payload.paymentId,
      expectedBindingHash,
      request: params.request,
      payTo: this.config.payTo,
      network: this.config.network,
      sellerUsdcAta: this.sellerUsdcAta
    });
    if (settlementMismatch !== null) {
      return {
        granted: false,
        reason: settlementMismatch,
        detail: settlement
      };
    }

    return {
      granted: true,
      paymentId: payload.payload.paymentId,
      settlementResponse: settlement,
      responseHeaders: {
        [PAYMENT_RESPONSE_HEADER]: encodeX402Header(settlement)
      }
    };
  }

  private async callFacilitator(path: string, body: unknown): Promise<unknown> {
    const response = await this.fetchImpl(
      `${this.config.facilitatorBaseUrl}${path}`,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${this.config.sellerApiToken}`,
          "content-type": "application/json"
        },
        body: JSON.stringify(body)
      }
    );

    return response.json();
  }
}

function isValidVerifyResponse(response: unknown): boolean {
  return (
    typeof response === "object" &&
    response !== null &&
    (response as { isValid?: unknown }).isValid === true
  );
}

function isSuccessfulSettlement(response: unknown): boolean {
  return (
    typeof response === "object" &&
    response !== null &&
    (response as { success?: unknown }).success === true
  );
}

function invalidReasonOf(response: unknown): string | null {
  if (typeof response !== "object" || response === null) {
    return null;
  }
  const body = response as {
    invalidReason?: unknown;
    error?: { code?: unknown };
  };
  if (typeof body.invalidReason === "string") {
    return body.invalidReason;
  }
  if (typeof body.error?.code === "string") {
    return body.error.code;
  }
  return null;
}

function settlementMismatchReason(input: {
  settlement: unknown;
  paymentId: string;
  expectedBindingHash: string;
  request: PricedRequest;
  payTo: string;
  network: string;
  sellerUsdcAta: string;
}): string | null {
  if (typeof input.settlement !== "object" || input.settlement === null) {
    return "settlement_response_mismatch";
  }

  const settlement = input.settlement as {
    transaction?: unknown;
    network?: unknown;
    asset?: unknown;
    amount?: unknown;
    extensions?: {
      subly?: {
        paymentId?: unknown;
        sellerRequestId?: unknown;
        requestBindingHash?: unknown;
        payTo?: unknown;
        sellerUsdcAta?: unknown;
        sellerTransferRawUsdc?: unknown;
      };
    };
  };
  const subly = settlement.extensions?.subly;
  if (typeof settlement.transaction !== "string" || settlement.transaction.length === 0) {
    return "settlement_transaction_missing";
  }
  if (settlement.network !== input.network) {
    return "network_mismatch";
  }
  if (settlement.asset !== SUBLY_VAULT.usdcMint) {
    return "asset_mismatch";
  }
  if (settlement.amount !== input.request.amountRawUsdc) {
    return "amount_mismatch";
  }
  if (subly === undefined) {
    return "settlement_response_mismatch";
  }
  if (subly.paymentId !== input.paymentId) {
    return "payment_id_mismatch";
  }
  if (subly.sellerRequestId !== input.request.sellerRequestId) {
    return "seller_request_id_mismatch";
  }
  if (subly.requestBindingHash !== input.expectedBindingHash) {
    return "request_binding_mismatch";
  }
  if (subly.payTo !== input.payTo) {
    return "pay_to_mismatch";
  }
  if (subly.sellerUsdcAta !== input.sellerUsdcAta) {
    return "seller_ata_mismatch";
  }
  if (subly.sellerTransferRawUsdc !== input.request.amountRawUsdc) {
    return "seller_transfer_mismatch";
  }

  return null;
}
