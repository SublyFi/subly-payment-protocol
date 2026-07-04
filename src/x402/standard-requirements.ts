import { z } from "zod";
import { SOLANA_MAINNET_NETWORK, SUBLY_VAULT } from "../config/constants.js";
import { decodeX402Header, X402HeaderError } from "./headers.js";

/**
 * Parser for STANDARD x402 (v2) 402 challenges — the wire format used by
 * third-party sellers and their facilitators (e.g. Nansen via PayAI), NOT the
 * Subly-specific `subly-yield-exact` scheme in ./headers.ts.
 *
 * A standard challenge is a JSON object (delivered in the response body and/or
 * the base64 `payment-required` header) with an `accepts[]` array of payment
 * requirements across many chains. Subly only pays the Solana `exact`
 * requirement whose asset is the vault USDC mint, funded from realized yield;
 * every other rail (EVM USDC/USDT, permit2, eip3009, ...) is ignored.
 *
 * Confirmed against the live Nansen challenge (2026-07-01):
 *   { scheme:"exact", network:"solana:5eykt4...", asset:"EPjFW...Dt1v"(USDC),
 *     amount:"10000", payTo:"J7Zv...PZYx", maxTimeoutSeconds:300,
 *     extra:{ feePayer:"2wKu...DBg4" } }
 * The facilitator's `extra.feePayer` sponsors gas, so the agent needs no SOL.
 */

/** Standard x402 `exact` scheme identifier (distinct from subly-yield-exact). */
export const STANDARD_EXACT_SCHEME = "exact" as const;

export const standardExactRequirementSchema = z
  .object({
    scheme: z.literal(STANDARD_EXACT_SCHEME),
    /** CAIP-2 chain id, e.g. "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp". */
    network: z.string().min(1),
    /** SPL mint (Solana) or token contract (EVM); Subly only pays USDC/Solana. */
    asset: z.string().min(1),
    /** Exact price in the asset's atomic units, as a decimal string. */
    amount: z.string().regex(/^[1-9]\d*$/),
    /** Recipient wallet; the transfer destination ATA is derived from it. */
    payTo: z.string().min(1),
    maxTimeoutSeconds: z.number().int().positive().optional(),
    extra: z
      .object({
        /** Facilitator address that pays the tx fee (gas sponsorship). */
        feePayer: z.string().min(1).optional()
      })
      .loose()
      .optional()
  })
  .loose();

export const standardPaymentRequiredSchema = z
  .object({
    x402Version: z.number().int(),
    accepts: z.array(z.unknown()),
    error: z.string().optional(),
    resource: z
      .object({ url: z.string().optional() })
      .loose()
      .optional()
  })
  .loose();

export type StandardExactRequirement = z.infer<
  typeof standardExactRequirementSchema
>;
export type StandardPaymentRequired = z.infer<
  typeof standardPaymentRequiredSchema
>;

export interface SelectedSolanaRequirement {
  requirement: StandardExactRequirement;
  amountRawUsdc: bigint;
  payTo: string;
  feePayer: string;
}

export class StandardX402ChallengeError extends Error {
  readonly reason: string;

  constructor(reason: string, message: string) {
    super(message);
    this.name = "StandardX402ChallengeError";
    this.reason = reason;
  }
}

/** Parses a standard x402 challenge object into typed requirements. */
export function parseStandardChallenge(challenge: unknown): {
  paymentRequired: StandardPaymentRequired;
  solanaExactRequirements: StandardExactRequirement[];
} {
  const parsed = standardPaymentRequiredSchema.safeParse(challenge);
  if (!parsed.success) {
    throw new StandardX402ChallengeError(
      "invalid_payment_required",
      "Response is not a valid x402 PaymentRequired object"
    );
  }

  const solanaExactRequirements = parsed.data.accepts.flatMap((candidate) => {
    const requirement = standardExactRequirementSchema.safeParse(candidate);
    if (!requirement.success) {
      return [];
    }
    return requirement.data.network.startsWith("solana:")
      ? [requirement.data]
      : [];
  });

  return { paymentRequired: parsed.data, solanaExactRequirements };
}

/** Decodes the base64 `payment-required` header into a standard challenge. */
export function decodeStandardPaymentRequiredHeader(headerValue: string): {
  paymentRequired: StandardPaymentRequired;
  solanaExactRequirements: StandardExactRequirement[];
} {
  let decoded: unknown;
  try {
    decoded = decodeX402Header(headerValue);
  } catch (error) {
    throw new StandardX402ChallengeError(
      error instanceof X402HeaderError ? error.reason : "invalid_header",
      "Cannot decode the payment-required header"
    );
  }
  return parseStandardChallenge(decoded);
}

/**
 * Selects the single Solana `exact` requirement Subly can pay: mainnet USDC
 * (the vault's own mint) with facilitator fee sponsorship by default. Throws
 * when the challenge offers no such requirement so the caller never silently
 * pays the wrong rail or realizes yield before an unpayable SVM challenge.
 */
export function selectPayableSolanaRequirement(
  requirements: StandardExactRequirement[],
  options?: { network?: string; usdcMint?: string }
): SelectedSolanaRequirement {
  const network = options?.network ?? SOLANA_MAINNET_NETWORK;
  const usdcMint = options?.usdcMint ?? SUBLY_VAULT.usdcMint;

  const matchingRequirements = requirements.filter(
    (candidate) => candidate.network === network && candidate.asset === usdcMint
  );
  if (matchingRequirements.length === 0) {
    throw new StandardX402ChallengeError(
      "no_payable_requirement",
      `The challenge has no Solana exact requirement on ${network} paying ${usdcMint}`
    );
  }
  const requirement =
    matchingRequirements.find(
      (candidate) => candidate.extra?.feePayer !== undefined
    ) ?? null;
  if (requirement === null) {
    throw new StandardX402ChallengeError(
      "missing_svm_fee_payer",
      "The Solana exact requirement does not include extra.feePayer, " +
        "which the official @x402/svm client requires for gas sponsorship"
    );
  }
  const feePayer = requirement.extra?.feePayer;
  if (feePayer === undefined) {
    throw new StandardX402ChallengeError(
      "missing_svm_fee_payer",
      "The Solana exact requirement does not include extra.feePayer, " +
        "which the official @x402/svm client requires for gas sponsorship"
    );
  }

  return {
    requirement,
    amountRawUsdc: BigInt(requirement.amount),
    payTo: requirement.payTo,
    feePayer
  };
}

/**
 * Strict equality used to bind a preflight-approved challenge to the actual
 * x402 payment client execution. A seller may return a fresh challenge on the
 * paid retry path; Subly must not pay it unless the parsed requirement object
 * is identical to the one that passed the yield/cap checks.
 */
export function standardRequirementMatchesSelected(
  candidate: unknown,
  selected: SelectedSolanaRequirement
): boolean {
  const parsed = standardExactRequirementSchema.safeParse(candidate);
  return (
    parsed.success &&
    stableJson(parsed.data) === stableJson(selected.requirement)
  );
}

function stableJson(value: unknown): string {
  return JSON.stringify(sortJson(value));
}

function sortJson(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sortJson);
  }
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .filter(([, entry]) => entry !== undefined)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, entry]) => [key, sortJson(entry)])
    );
  }
  return value;
}
