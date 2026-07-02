import { SOLANA_MAINNET_NETWORK, SUBLY_VAULT } from "../config/constants.js";
import {
  PAYMENT_REQUIRED_HEADER,
  requestBodyHashFor
} from "../x402/headers.js";
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
 *   4. delegate to the injected x402 client, which builds/signs the transfer
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

export type StandardX402FetchLike = (
  url: string,
  init: { method?: string; headers?: Record<string, string>; body?: string },
  expected: SelectedSolanaRequirement
) => Promise<FetchResponseLike>;

export interface StandardX402PendingPaymentRecord {
  key: string;
  url: string;
  method: string;
  requestBodyHash: string;
  amountRawUsdc: string;
  payTo: string;
  feePayer: string | null;
  realizedRawUsdc: string;
  realizeTxSignature: string | null;
  status: "realized" | "external_outcome_unknown";
  createdAtMs: number;
  updatedAtMs: number;
  detail?: unknown;
}

export interface StandardX402StateStore {
  load(): StandardX402PendingPaymentRecord[];
  save(records: StandardX402PendingPaymentRecord[]): void;
}

export interface StandardPayInput {
  url: string;
  method?: string;
  body?: string;
  headers?: Record<string, string>;
  maxAmountRawUsdc?: bigint;
  forceNewPayment?: boolean;
}

export interface StandardX402PayerConfig {
  /** Realizes vault yield into the agent USDC ATA before paying. */
  realizer: YieldRealizer;
  /**
   * The standard x402 client's `fetch`: given a 402, it builds/signs the
   * Solana transfer with the agent wallet and retries. Injected for testability.
   */
  x402Fetch: StandardX402FetchLike;
  /** Unpaid probe used to read the challenge before realizing. */
  probeFetch?: FetchLike;
  /** Client-side cap when a call passes no maxAmountRawUsdc. */
  defaultMaxAmountRawUsdc: bigint;
  network?: string;
  usdcMint?: string;
  stateStore?: StandardX402StateStore;
  nowMs?: () => number;
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
      | "payment_outcome_unknown"
      | "state_persist_failed",
    message: string,
    readonly detail: unknown = null
  ) {
    super(message);
    this.name = "StandardX402PayError";
  }
}

export class StandardX402Payer {
  private readonly realizer: YieldRealizer;
  private readonly x402Fetch: StandardX402FetchLike;
  private readonly probeFetch: FetchLike;
  private readonly defaultMaxAmountRawUsdc: bigint;
  private readonly network: string;
  private readonly usdcMint: string;
  private readonly stateStore: StandardX402StateStore | null;
  private readonly pending = new Map<string, StandardX402PendingPaymentRecord>();
  private readonly inFlight = new Map<string, Promise<StandardPayResult>>();
  private readonly nowMs: () => number;

  constructor(config: StandardX402PayerConfig) {
    this.realizer = config.realizer;
    this.x402Fetch = config.x402Fetch;
    this.probeFetch =
      config.probeFetch ?? (fetch as unknown as FetchLike);
    this.defaultMaxAmountRawUsdc = config.defaultMaxAmountRawUsdc;
    this.network = config.network ?? SOLANA_MAINNET_NETWORK;
    this.usdcMint = config.usdcMint ?? SUBLY_VAULT.usdcMint;
    this.stateStore = config.stateStore ?? null;
    this.nowMs = config.nowMs ?? (() => Date.now());
    if (this.stateStore !== null) {
      for (const record of this.stateStore.load()) {
        this.pending.set(record.key, record);
      }
    }
  }

  pay(input: StandardPayInput): Promise<StandardPayResult> {
    const method = (input.method ?? "GET").toUpperCase();
    const requestBodyHash = requestBodyHashFor(input.body ?? null);
    const pendingKey = pendingPaymentKey({
      url: input.url,
      method,
      requestBodyHash
    });
    const existingFlow = this.inFlight.get(pendingKey);
    if (existingFlow !== undefined) {
      return existingFlow;
    }

    const flow = this.run(input, {
      method,
      requestBodyHash,
      pendingKey
    }).finally(() => {
      this.inFlight.delete(pendingKey);
    });
    this.inFlight.set(pendingKey, flow);
    return flow;
  }

  private async run(
    input: StandardPayInput,
    computed: { method: string; requestBodyHash: string; pendingKey: string }
  ): Promise<StandardPayResult> {
    const { method, requestBodyHash, pendingKey } = computed;
    const existingPending = this.pending.get(pendingKey);
    if (existingPending !== undefined && input.forceNewPayment !== true) {
      throw new StandardX402PayError(
        "payment_outcome_unknown",
        "a previous external x402 payment for this request has an unknown " +
          "outcome. Verify whether it settled before purchasing again; to pay " +
          "again anyway, call with forceNewPayment=true.",
        existingPending
      );
    }
    if (existingPending !== undefined && input.forceNewPayment === true) {
      try {
        this.untrack(pendingKey);
      } catch (error) {
        throw new StandardX402PayError(
          "state_persist_failed",
          "could not clear the previous pending x402 marker before forcing " +
            "a new payment",
          error
        );
      }
    }

    const init = {
      method,
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

    const pendingRecord: StandardX402PendingPaymentRecord = {
      key: pendingKey,
      url: input.url,
      method,
      requestBodyHash,
      amountRawUsdc: selected.amountRawUsdc.toString(),
      payTo: selected.payTo,
      feePayer: selected.feePayer,
      realizedRawUsdc: realized.realizedRawUsdc.toString(),
      realizeTxSignature: realized.txSignature,
      status: "realized",
      createdAtMs: this.nowMs(),
      updatedAtMs: this.nowMs()
    };
    try {
      this.track(pendingRecord);
    } catch (error) {
      throw new StandardX402PayError(
        "state_persist_failed",
        "could not persist the pending x402 marker; refusing to attempt the " +
          "external payment because a restart would not be double-payment safe",
        { error, pendingPayment: pendingRecord }
      );
    }

    let response: FetchResponseLike;
    try {
      response = await this.x402Fetch(input.url, init, selected);
    } catch (error) {
      const persistError = this.tryMarkUnknown(pendingKey, {
        message: error instanceof Error ? error.message : String(error)
      });
      throw new StandardX402PayError(
        "payment_outcome_unknown",
        `the x402 payment attempt failed after yield was realized; verify ` +
          `whether it settled before paying again: ${
          error instanceof Error ? error.message : String(error)
        }`,
        { error, persistError }
      );
    }
    const bodyText = await response.text();
    if (response.status !== 200) {
      const persistError = this.tryMarkUnknown(pendingKey, {
        status: response.status,
        body: bodyText
      });
      throw new StandardX402PayError(
        "payment_outcome_unknown",
        `the x402 payment attempt returned ${response.status} after yield ` +
          "was realized; verify whether it settled before paying again",
        { status: response.status, body: bodyText, persistError }
      );
    }
    this.clearDelivered(pendingKey);

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

  private track(record: StandardX402PendingPaymentRecord): void {
    const previous = this.pending.get(record.key);
    this.pending.set(record.key, record);
    try {
      this.persist();
    } catch (error) {
      if (previous === undefined) {
        this.pending.delete(record.key);
      } else {
        this.pending.set(record.key, previous);
      }
      throw error;
    }
  }

  private markUnknown(key: string, detail: unknown): void {
    const current = this.pending.get(key);
    if (current === undefined) {
      return;
    }
    const next = {
      ...current,
      status: "external_outcome_unknown" as const,
      updatedAtMs: this.nowMs(),
      detail
    };
    this.pending.set(key, next);
    try {
      this.persist();
    } catch (error) {
      this.pending.set(key, current);
      throw error;
    }
  }

  private tryMarkUnknown(key: string, detail: unknown): unknown | null {
    try {
      this.markUnknown(key, detail);
      return null;
    } catch (error) {
      return error;
    }
  }

  private untrack(key: string): void {
    const previous = this.pending.get(key);
    const existed = previous !== undefined;
    this.pending.delete(key);
    try {
      this.persist();
    } catch (error) {
      if (existed) {
        this.pending.set(key, previous);
      }
      throw error;
    }
  }

  private clearDelivered(key: string): void {
    const previous = this.pending.get(key);
    this.pending.delete(key);
    try {
      this.persist();
    } catch (error) {
      if (previous !== undefined) {
        this.pending.set(key, previous);
      }
      console.error(
        `[subly-x402] payment delivered but pending marker could not be ` +
          `cleared: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  private persist(): void {
    if (this.stateStore === null) {
      return;
    }
    this.stateStore.save([...this.pending.values()]);
  }
}

function pendingPaymentKey(input: {
  url: string;
  method: string;
  requestBodyHash: string;
}): string {
  return `${input.method}:${input.url}:${input.requestBodyHash}`;
}
