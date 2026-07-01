import { SOLANA_MAINNET_NETWORK, SUBLY_VAULT } from "../config/constants.js";
import { PAYMENT_REQUIRED_HEADER } from "../x402/headers.js";
import {
  decodeStandardPaymentRequiredHeader,
  parseStandardChallenge,
  selectPayableSolanaRequirement,
  StandardX402ChallengeError,
  type SelectedSolanaRequirement
} from "../x402/standard-requirements.js";

/**
 * Buyer-side payer for STANDARD x402 (v2) sellers — pays ANY x402-compatible
 * paid API (Nansen via PayAI, etc.) from Kamino vault yield, with no
 * Subly-specific integration on the seller side.
 *
 * Flow per purchase:
 *   1. probe the URL unpaid -> read the 402 challenge
 *   2. select the Solana `exact` USDC requirement, enforce the client cap
 *   3. realize just enough yield into the agent's USDC ATA (realizer)
 *   4. delegate to the x402-solana client, which builds/signs the transfer
 *      and retries; the seller's facilitator verifies + settles it
 *
 * The realize step (a Kamino withdraw) and the x402 payment are two separate
 * transactions by necessity: PayAI's `exact` verifier accepts only a fixed
 * compute-budget + TransferChecked instruction set, so a Kamino redeem can
 * never ride in the same transaction.
 */

/** Ensures the agent USDC ATA can cover a payment, realizing yield as needed. */
export interface YieldRealizer {
  ensureUsdcAvailable(input: { amountRawUsdc: bigint }): Promise<{
    realizedRawUsdc: bigint;
    txSignature: string | null;
  }>;
}

/** Minimal HTTP surface (satisfied by the global fetch Response). */
export interface FetchResponseLike {
  status: number;
  headers: { get(name: string): string | null };
  text(): Promise<string>;
  json(): Promise<unknown>;
}

export type FetchLike = (
  url: string,
  init?: { method?: string; headers?: Record<string, string>; body?: string }
) => Promise<FetchResponseLike>;

export interface StandardX402PayerConfig {
  /** Realizes vault yield into the agent USDC ATA before paying. */
  realizer: YieldRealizer;
  /**
   * The x402-solana client's `fetch`: given a 402, it builds/signs the Solana
   * transfer with the agent wallet and retries. Injected for testability.
   */
  x402Fetch: FetchLike;
  /** Unpaid probe used to read the challenge before realizing. */
  probeFetch?: FetchLike;
  /** Client-side cap when a call passes no maxAmountRawUsdc. */
  defaultMaxAmountRawUsdc: bigint;
  network?: string;
  usdcMint?: string;
}

export interface StandardPayResult {
  paid: boolean;
  status: number;
  body: string;
  payment?: {
    amountRawUsdc: string;
    payTo: string;
    feePayer: string | null;
    realizedRawUsdc: string;
    realizeTxSignature: string | null;
  };
}

export class StandardX402PayError extends Error {
  constructor(
    readonly reason:
      | "invalid_challenge"
      | "no_payable_requirement"
      | "amount_exceeds_client_cap"
      | "realize_failed"
      | "delivery_failed",
    message: string,
    readonly detail: unknown = null
  ) {
    super(message);
    this.name = "StandardX402PayError";
  }
}

export class StandardX402Payer {
  private readonly realizer: YieldRealizer;
  private readonly x402Fetch: FetchLike;
  private readonly probeFetch: FetchLike;
  private readonly defaultMaxAmountRawUsdc: bigint;
  private readonly network: string;
  private readonly usdcMint: string;

  constructor(config: StandardX402PayerConfig) {
    this.realizer = config.realizer;
    this.x402Fetch = config.x402Fetch;
    this.probeFetch =
      config.probeFetch ?? (fetch as unknown as FetchLike);
    this.defaultMaxAmountRawUsdc = config.defaultMaxAmountRawUsdc;
    this.network = config.network ?? SOLANA_MAINNET_NETWORK;
    this.usdcMint = config.usdcMint ?? SUBLY_VAULT.usdcMint;
  }

  async pay(input: {
    url: string;
    method?: string;
    body?: string;
    headers?: Record<string, string>;
    maxAmountRawUsdc?: bigint;
  }): Promise<StandardPayResult> {
    const init = {
      method: input.method ?? "GET",
      ...(input.body === undefined ? {} : { body: input.body }),
      ...(input.headers === undefined ? {} : { headers: input.headers })
    };

    const probe = await this.probeFetch(input.url, init);
    if (probe.status !== 402) {
      return { paid: false, status: probe.status, body: await probe.text() };
    }

    const selected = await this.selectRequirement(probe);

    const cap = input.maxAmountRawUsdc ?? this.defaultMaxAmountRawUsdc;
    if (selected.amountRawUsdc > cap) {
      throw new StandardX402PayError(
        "amount_exceeds_client_cap",
        `the challenge demands ${selected.amountRawUsdc} raw USDC, above the ` +
          `client cap of ${cap}; nothing was paid`,
        { amountRawUsdc: selected.amountRawUsdc.toString(), payTo: selected.payTo }
      );
    }

    let realized: { realizedRawUsdc: bigint; txSignature: string | null };
    try {
      realized = await this.realizer.ensureUsdcAvailable({
        amountRawUsdc: selected.amountRawUsdc
      });
    } catch (error) {
      throw new StandardX402PayError(
        "realize_failed",
        `could not realize yield to cover ${selected.amountRawUsdc} raw USDC: ${
          error instanceof Error ? error.message : String(error)
        }`,
        error
      );
    }

    const response = await this.x402Fetch(input.url, init);
    const bodyText = await response.text();
    if (response.status !== 200) {
      throw new StandardX402PayError(
        "delivery_failed",
        `the x402 payment did not deliver (status ${response.status})`,
        { status: response.status, body: bodyText }
      );
    }

    return {
      paid: true,
      status: response.status,
      body: bodyText,
      payment: {
        amountRawUsdc: selected.amountRawUsdc.toString(),
        payTo: selected.payTo,
        feePayer: selected.feePayer,
        realizedRawUsdc: realized.realizedRawUsdc.toString(),
        realizeTxSignature: realized.txSignature
      }
    };
  }

  /** Reads the challenge from the header (preferred) or the JSON body. */
  private async selectRequirement(
    probe: FetchResponseLike
  ): Promise<SelectedSolanaRequirement> {
    const header = probe.headers.get(PAYMENT_REQUIRED_HEADER);
    let requirements;
    try {
      if (header !== null) {
        requirements =
          decodeStandardPaymentRequiredHeader(header).solanaExactRequirements;
      } else {
        requirements = parseStandardChallenge(
          await probe.json()
        ).solanaExactRequirements;
      }
    } catch (error) {
      throw new StandardX402PayError(
        error instanceof StandardX402ChallengeError
          ? (error.reason as "invalid_challenge")
          : "invalid_challenge",
        "could not parse the x402 402 challenge",
        error
      );
    }

    try {
      return selectPayableSolanaRequirement(requirements, {
        network: this.network,
        usdcMint: this.usdcMint
      });
    } catch (error) {
      throw new StandardX402PayError(
        "no_payable_requirement",
        error instanceof Error ? error.message : String(error),
        error
      );
    }
  }
}
