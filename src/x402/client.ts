import { SOLANA_MAINNET_NETWORK, SUBLY_VAULT } from "../config/constants.js";
import { deriveAssociatedTokenAddress } from "../lib/associated-token-account.js";
import type { AgentWalletSigner } from "../client/agent-wallet-signer.js";
import type { PaymentSigningIntent } from "../client/transaction-intent-validator.js";
import {
  decodePaymentRequiredHeader,
  encodeX402Header,
  PAYMENT_REQUIRED_HEADER,
  PAYMENT_SIGNATURE_HEADER,
  requestBodyHashFor,
  X402_VERSION,
  X402HeaderError,
  type SublyPaymentPayload,
  type SublyPaymentRequirements
} from "./headers.js";

export type ClientFetchLike = (
  url: string,
  init?: {
    method?: string;
    headers?: Record<string, string>;
    body?: string;
  }
) => Promise<{
  status: number;
  headers: { get(name: string): string | null };
  json(): Promise<unknown>;
}>;

export interface SublyX402ClientConfig {
  facilitatorBaseUrl: string;
  clientApiToken: string;
  signer: AgentWalletSigner;
  network?: string;
  /**
   * Resolves lookup-table contents through the agent's own RPC view so
   * intent validation is not anchored to facilitator-supplied data.
   * Required when prepared transactions reference lookup tables.
   */
  lookupTablesFor?: (
    serializedTransaction: string
  ) => Promise<Record<string, readonly string[]>>;
  fetchImpl?: ClientFetchLike;
}

export class X402ClientError extends Error {
  readonly reason: string;
  readonly detail: unknown;

  constructor(reason: string, message: string, detail?: unknown) {
    super(message);
    this.name = "X402ClientError";
    this.reason = reason;
    this.detail = detail;
  }
}

interface PreparedPaymentResponse {
  paymentId: string;
  requestBindingHash: string;
  preparedMessageHash: string;
  temporarySettlementSignature: string;
  intentJson: {
    serializedTransaction: string;
    signingIntent: PaymentSigningIntent;
  };
}

/**
 * Agent-side x402 client for the subly-yield-exact scheme: selects the Subly
 * requirement from a 402 challenge, prepares the payment at the facilitator,
 * runs the structured-intent signer, and produces the PAYMENT-SIGNATURE
 * header for the retry.
 */
export class SublyX402Client {
  private readonly config: {
    facilitatorBaseUrl: string;
    clientApiToken: string;
    network: string;
  };
  private readonly signer: AgentWalletSigner;
  private readonly lookupTablesFor:
    | ((tx: string) => Promise<Record<string, readonly string[]>>)
    | null;
  private readonly fetchImpl: ClientFetchLike;

  constructor(config: SublyX402ClientConfig) {
    this.config = {
      facilitatorBaseUrl: config.facilitatorBaseUrl.replace(/\/$/, ""),
      clientApiToken: config.clientApiToken,
      network: config.network ?? SOLANA_MAINNET_NETWORK
    };
    this.signer = config.signer;
    this.lookupTablesFor = config.lookupTablesFor ?? null;
    this.fetchImpl = config.fetchImpl ?? (fetch as unknown as ClientFetchLike);
  }

  /**
   * Builds the PAYMENT-SIGNATURE header for a 402 challenge. The request
   * method, URL, and body must be exactly the request being retried; they are
   * bound into the payment and verified again by the seller and facilitator.
   */
  async buildPaymentSignatureHeader(input: {
    paymentRequiredHeader: string;
    httpMethod: string;
    url: string;
    body?: string | Uint8Array | null;
  }): Promise<{ headerValue: string; paymentId: string }> {
    const requirement = this.selectRequirement(input.paymentRequiredHeader);
    if (requirement.resource !== input.url) {
      throw new X402ClientError(
        "resource_mismatch",
        "PAYMENT-REQUIRED resource does not match the request URL"
      );
    }

    const requestBodyHash = requestBodyHashFor(input.body);
    const prepared = await this.preparePayment({
      requirement,
      httpMethod: input.httpMethod.toUpperCase(),
      requestBodyHash
    });

    const lookupTables =
      this.lookupTablesFor === null
        ? undefined
        : await this.lookupTablesFor(prepared.intentJson.serializedTransaction);
    const signed = await this.signer.signPayment({
      intent: prepared.intentJson.signingIntent,
      serializedTransaction: prepared.intentJson.serializedTransaction,
      lookupTables
    });

    const payload: SublyPaymentPayload = {
      x402Version: X402_VERSION,
      scheme: requirement.scheme,
      network: requirement.network,
      payload: {
        paymentId: prepared.paymentId,
        requestBindingHash: prepared.requestBindingHash,
        preparedMessageHash: prepared.preparedMessageHash,
        serializedTransaction: signed.serializedTransaction,
        agentSignature: signed.agentSignature,
        temporarySettlementSignature: prepared.temporarySettlementSignature
      }
    };

    return {
      headerValue: encodeX402Header(payload),
      paymentId: prepared.paymentId
    };
  }

  /**
   * Convenience wrapper: performs the request, and on a 402 with a Subly
   * requirement pays from vault yield and retries once.
   */
  async fetchWithPayment(
    url: string,
    init?: {
      method?: string;
      headers?: Record<string, string>;
      body?: string;
    }
  ): Promise<{
    status: number;
    headers: { get(name: string): string | null };
    json(): Promise<unknown>;
  }> {
    const first = await this.fetchImpl(url, init);
    if (first.status !== 402) {
      return first;
    }

    const challenge = first.headers.get(PAYMENT_REQUIRED_HEADER);
    if (challenge === null) {
      return first;
    }

    const { headerValue } = await this.buildPaymentSignatureHeader({
      paymentRequiredHeader: challenge,
      httpMethod: init?.method ?? "GET",
      url,
      body: init?.body ?? null
    });

    return this.fetchImpl(url, {
      ...init,
      headers: {
        ...init?.headers,
        [PAYMENT_SIGNATURE_HEADER]: headerValue
      }
    });
  }

  private selectRequirement(
    paymentRequiredHeader: string
  ): SublyPaymentRequirements {
    let sublyRequirements: SublyPaymentRequirements[];
    try {
      sublyRequirements = decodePaymentRequiredHeader(
        paymentRequiredHeader
      ).sublyRequirements;
    } catch (error) {
      throw new X402ClientError(
        error instanceof X402HeaderError ? error.reason : "invalid_challenge",
        "Cannot decode the PAYMENT-REQUIRED header"
      );
    }

    const selected =
      sublyRequirements.find(
        (candidate) =>
          candidate.network === this.config.network &&
          candidate.extra.vault === SUBLY_VAULT.address &&
          candidate.extra.shareMint === SUBLY_VAULT.shareMint &&
          candidate.asset === SUBLY_VAULT.usdcMint
      ) ?? null;
    if (selected === null) {
      throw new X402ClientError(
        "no_supported_requirement",
        "The 402 challenge contains no supported subly-yield-exact requirement"
      );
    }

    return selected;
  }

  private async preparePayment(input: {
    requirement: SublyPaymentRequirements;
    httpMethod: string;
    requestBodyHash: string;
  }): Promise<PreparedPaymentResponse> {
    const { requirement } = input;
    const wallet = this.signer.walletAddress;
    const response = await this.fetchImpl(
      `${this.config.facilitatorBaseUrl}/v1/payments/prepare`,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${this.config.clientApiToken}`,
          "content-type": "application/json"
        },
        body: JSON.stringify({
          wallet,
          scheme: requirement.scheme,
          network: requirement.network,
          vault: requirement.extra.vault,
          shareMint: requirement.extra.shareMint,
          asset: requirement.asset,
          seller: requirement.extra.seller,
          sellerRequestId: requirement.extra.sellerRequestId,
          httpMethod: input.httpMethod,
          canonicalResourceUrl: requirement.resource,
          requestBodyHash: input.requestBodyHash,
          amountRawUsdc: requirement.amountRawUsdc,
          payTo: requirement.payTo,
          sellerUsdcAta: requirement.extra.sellerUsdcAta,
          dustRecipientUsdcAta: deriveAssociatedTokenAddress({
            owner: wallet,
            mint: SUBLY_VAULT.usdcMint
          })
        })
      }
    );

    const body = (await response.json()) as Record<string, unknown>;
    if (response.status !== 200) {
      const error = body.error as { code?: unknown } | undefined;
      throw new X402ClientError(
        typeof error?.code === "string" ? error.code : "prepare_failed",
        "Payment preparation failed at the facilitator",
        body
      );
    }

    const prepared = body as unknown as PreparedPaymentResponse;
    if (
      typeof prepared.paymentId !== "string" ||
      typeof prepared.preparedMessageHash !== "string" ||
      typeof prepared.intentJson?.serializedTransaction !== "string" ||
      typeof prepared.intentJson?.signingIntent !== "object"
    ) {
      throw new X402ClientError(
        "invalid_prepare_response",
        "Facilitator prepare response is missing required fields"
      );
    }

    return prepared;
  }
}
