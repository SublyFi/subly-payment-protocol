import { z } from "zod";
import { PAYMENT_SCHEME } from "../config/constants.js";
import { EMPTY_BODY_HASH, sha256TaggedHex } from "../lib/hash.js";

/**
 * x402 v2 HTTP transport reuse: 402 + PAYMENT-REQUIRED, retry with
 * PAYMENT-SIGNATURE, settlement receipt in PAYMENT-RESPONSE. All three
 * headers carry base64-encoded JSON. Subly only registers the
 * `subly-yield-exact` scheme inside this transport.
 */
export const PAYMENT_REQUIRED_HEADER = "payment-required";
export const PAYMENT_SIGNATURE_HEADER = "payment-signature";
export const PAYMENT_RESPONSE_HEADER = "payment-response";
export const X402_VERSION = 2;

const MAX_HEADER_JSON_BYTES = 16_384;

export class X402HeaderError extends Error {
  readonly reason: string;

  constructor(reason: string, message: string) {
    super(message);
    this.name = "X402HeaderError";
    this.reason = reason;
  }
}

export const sublyPaymentRequirementsSchema = z
  .object({
    scheme: z.literal(PAYMENT_SCHEME),
    network: z.string().min(1),
    asset: z.string().min(32),
    /** Exact seller amount in raw USDC; the scheme settles exactly this. */
    amountRawUsdc: z.string().regex(/^[1-9]\d*$/),
    resource: z.string().url(),
    description: z.string().optional(),
    mimeType: z.string().optional(),
    payTo: z.string().min(32),
    maxTimeoutSeconds: z.number().int().positive(),
    extra: z.object({
      sellerRequestId: z.string().min(1),
      seller: z.string().min(32),
      sellerUsdcAta: z.string().min(32),
      vault: z.string().min(32),
      shareMint: z.string().min(32)
    })
  })
  .loose();

export const paymentRequiredSchema = z
  .object({
    x402Version: z.number().int(),
    accepts: z.array(z.unknown()),
    error: z.string().optional()
  })
  .loose();

export const sublyPaymentPayloadSchema = z
  .object({
    x402Version: z.number().int(),
    scheme: z.literal(PAYMENT_SCHEME),
    network: z.string().min(1),
    payload: z.object({
      paymentId: z.string().min(1),
      requestBindingHash: z.string().min(1),
      preparedMessageHash: z.string().min(1),
      serializedTransaction: z.string().min(1).max(4096),
      agentSignature: z.string().min(1).max(128),
      temporarySettlementSignature: z.string().min(1).max(128)
    })
  })
  .loose();

export type SublyPaymentRequirements = z.infer<
  typeof sublyPaymentRequirementsSchema
>;
export type PaymentRequired = z.infer<typeof paymentRequiredSchema>;
export type SublyPaymentPayload = z.infer<typeof sublyPaymentPayloadSchema>;

export function encodeX402Header(value: unknown): string {
  const json = JSON.stringify(value);
  if (Buffer.byteLength(json, "utf8") > MAX_HEADER_JSON_BYTES) {
    throw new X402HeaderError(
      "header_too_large",
      `x402 header JSON exceeds ${MAX_HEADER_JSON_BYTES} bytes`
    );
  }

  return Buffer.from(json, "utf8").toString("base64");
}

export function decodeX402Header(headerValue: string): unknown {
  if (headerValue.length > Math.ceil(MAX_HEADER_JSON_BYTES * 4 / 3) + 4) {
    throw new X402HeaderError(
      "header_too_large",
      `x402 header exceeds ${MAX_HEADER_JSON_BYTES} encoded bytes`
    );
  }

  const json = Buffer.from(headerValue, "base64").toString("utf8");
  try {
    return JSON.parse(json);
  } catch {
    throw new X402HeaderError(
      "invalid_header_encoding",
      "x402 header is not base64-encoded JSON"
    );
  }
}

export function decodePaymentRequiredHeader(headerValue: string): {
  paymentRequired: PaymentRequired;
  sublyRequirements: SublyPaymentRequirements[];
} {
  const parsed = paymentRequiredSchema.safeParse(decodeX402Header(headerValue));
  if (!parsed.success) {
    throw new X402HeaderError(
      "invalid_payment_required",
      "PAYMENT-REQUIRED header is not a valid x402 PaymentRequired object"
    );
  }

  const sublyRequirements = parsed.data.accepts.flatMap((candidate) => {
    const requirement = sublyPaymentRequirementsSchema.safeParse(candidate);
    return requirement.success ? [requirement.data] : [];
  });

  return { paymentRequired: parsed.data, sublyRequirements };
}

export function decodePaymentSignatureHeader(
  headerValue: string
): SublyPaymentPayload {
  const parsed = sublyPaymentPayloadSchema.safeParse(
    decodeX402Header(headerValue)
  );
  if (!parsed.success) {
    throw new X402HeaderError(
      "invalid_payment_payload",
      "PAYMENT-SIGNATURE header is not a valid subly-yield-exact PaymentPayload"
    );
  }

  return parsed.data;
}

/** Canonical request body hash: sha256 of the body, or of empty bytes. */
export function requestBodyHashFor(
  body: string | Uint8Array | null | undefined
): string {
  if (body === null || body === undefined || body.length === 0) {
    return EMPTY_BODY_HASH;
  }

  return sha256TaggedHex(
    typeof body === "string" ? Buffer.from(body, "utf8") : Buffer.from(body)
  );
}
