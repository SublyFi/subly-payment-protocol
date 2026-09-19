import { SOLANA_MAINNET_NETWORK, SUBLY_VAULT } from "../config/constants.js";
import { canonicalJsonHash, sha256HexOf } from "../lib/canonical-json.js";
import type { PreparedWithdrawal } from "./vault-flows.js";
import {
  decodeX402Header,
  PAYMENT_REQUIRED_HEADER,
  PAYMENT_RESPONSE_HEADER,
  requestBodyHashFor
} from "../x402/headers.js";
import {
  decodeStandardPaymentRequiredHeader,
  parseStandardChallenge,
  selectPayableSolanaRequirement,
  StandardX402ChallengeError,
  standardRequirementMatchesSelected,
  type SelectedSolanaRequirement
} from "../x402/standard-requirements.js";

/**
 * Buyer-side payer for STANDARD x402 (v2) sellers — pays compatible Solana
 * USDC `exact` APIs from Kamino vault yield, with no Subly-specific integration
 * on the seller side.
 *
 * Flow per purchase:
 *   1. probe the URL unpaid -> read the 402 challenge
 *   2. select the Solana `exact` USDC requirement, enforce the client cap
 *   3. realize just enough yield into the agent's USDC ATA (realizer)
 *   4. delegate to the injected x402 client, which builds/signs the transfer
 *      and retries; the seller's x402 facilitator verifies + settles it
 *
 * The realize step (a Kamino withdraw) and the x402 payment are two separate
 * transactions by necessity: PayAI's `exact` verifier accepts only a fixed
 * compute-budget + TransferChecked instruction set, so a Kamino redeem can
 * never ride in the same transaction.
 */

/**
 * The x402 payment a realize funds, declared to the relayer so server-side
 * spending caps and the audit log key off "what was paid", not just an
 * amount (docs/spending-mandate-design.md).
 */
export interface RealizePaymentBinding {
  payTo: string;
  amountRawUsdc: string;
  resourceUrlHash: string;
  method: string;
}

/** Ensures the agent USDC ATA can cover a payment, realizing yield as needed. */
export interface YieldRealizer {
  readonly vault?: string;
  /** Stable identity of the source of funds; required for safe restart recovery. */
  readonly realizationContext?: { wallet: string; vault: string; relayerBaseUrl: string };
  ensureUsdcAvailable(input: {
    amountRawUsdc: bigint;
    payment?: RealizePaymentBinding;
    /** Owner approval for payments above the mandate threshold. */
    approvalId?: string;
    onPrepared?: (prepared: PreparedWithdrawal) => Promise<void>;
  }): Promise<{
    realizedRawUsdc: bigint;
    txSignature: string | null;
    /** The relayer's realize withdrawal id, when the realizer knows it. */
    withdrawalId?: string | null;
  }>;
  /** Resume the same withdrawal without reading a new budget or preparing again. */
  resumeUsdcAvailable?(input: {
    amountRawUsdc: bigint;
    payment: RealizePaymentBinding;
    prepared: PreparedWithdrawal;
  }): Promise<{ realizedRawUsdc: bigint; txSignature: string | null; withdrawalId?: string | null }>;
  /**
   * Optional best-effort report-back of the x402 payment tx a realize
   * funded (relayer audit chain). Failures must never affect the payment.
   */
  reportPayment?(input: {
    withdrawalId: string;
    paymentTxSignature: string;
  }): Promise<void>;
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
  status: "realizing" | "realized" | "external_outcome_unknown";
  /** Absent in older records, which remain refusal-only. Never store request credentials. */
  recovery?: {
    version: 1;
    context: { wallet: string; vault: string; relayerBaseUrl: string };
    requestHeadersHash: string;
    requirement: SelectedSolanaRequirement["requirement"];
    prepared?: PreparedWithdrawal;
  };
  createdAtMs: number;
  updatedAtMs: number;
  detail?: unknown;
}

export interface StandardX402StateStore {
  /** Serialize all read/modify/payment/write work across clients sharing a store. */
  withExclusiveLock?<T>(operation: () => Promise<T>): Promise<T>;
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
  /**
   * Owner approval id for a payment above the mandate threshold: after an
   * "approval_required" refusal and the owner's sign-off, retry the SAME
   * call with the approvalId from the refusal detail.
   */
  approvalId?: string;
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
  fundingVault?: string;
  paid: boolean;
  status: number;
  body: string;
  payment?: {
    amountRawUsdc: string;
    payTo: string;
    feePayer: string | null;
    realizedRawUsdc: string;
    realizeTxSignature: string | null;
    /** From the seller's PAYMENT-RESPONSE settle header, when present. */
    paymentTxSignature: string | null;
  };
}

export class StandardX402PayError extends Error {
  constructor(
    readonly reason:
      | "invalid_challenge"
      | "no_payable_requirement"
      | "amount_exceeds_client_cap"
      | "approval_required"
      | "realize_failed"
      | "realize_underfunded"
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

  pay(input: StandardPayInput, realizer: YieldRealizer = this.realizer): Promise<StandardPayResult> {
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

    const run = async () => {
      if (this.stateStore?.withExclusiveLock) {
        this.pending.clear();
        for (const record of this.stateStore.load()) this.pending.set(record.key, record);
      }
      return this.run(input, { method, requestBodyHash, pendingKey }, realizer);
    };
    const flow = (this.stateStore?.withExclusiveLock
      ? this.stateStore.withExclusiveLock(run) : run()).finally(() => {
      this.inFlight.delete(pendingKey);
    });
    this.inFlight.set(pendingKey, flow);
    return flow;
  }

  private async run(
    input: StandardPayInput,
    computed: { method: string; requestBodyHash: string; pendingKey: string },
    realizer: YieldRealizer
  ): Promise<StandardPayResult> {
    const { method, requestBodyHash, pendingKey } = computed;
    const existingPending = this.pending.get(pendingKey);
    const resuming = existingPending?.recovery !== undefined &&
      existingPending.status !== "external_outcome_unknown";
    const requestHeadersHash = canonicalJsonHash(input.headers ?? {});
    if (resuming) {
      const recovery = existingPending.recovery!;
      if (canonicalJsonHash(recovery.context) !== canonicalJsonHash(realizer.realizationContext ?? null) ||
          recovery.requestHeadersHash !== requestHeadersHash ||
          existingPending.url !== input.url || existingPending.method !== method ||
          existingPending.requestBodyHash !== requestBodyHash) {
        throw new StandardX402PayError("payment_outcome_unknown",
          "The pending realization belongs to a different wallet, vault, relayer or request; refusing to resume or discard it.", publicPendingPayment(existingPending));
      }
      if (existingPending.status === "realizing" && recovery.prepared === undefined) {
        throw new StandardX402PayError("payment_outcome_unknown",
          "Realization was interrupted before its withdrawal ID was saved. Reconcile the original operation before retrying; forceNewPayment cannot discard an incomplete realization.", publicPendingPayment(existingPending));
      }
    } else if (existingPending !== undefined) {
      // Older records have no recovery checkpoint and may already have attempted
      // an external payment. Their historical refusal semantics stay intact.
      if (input.forceNewPayment !== true || existingPending.status === "realizing") {
        throw new StandardX402PayError(
          "payment_outcome_unknown",
          "A previous payment or realization has an unknown outcome. Verify it before purchasing again.",
          publicPendingPayment(existingPending)
        );
      }
      try { this.untrack(pendingKey); }
      catch (error) {
        throw new StandardX402PayError("state_persist_failed",
          "Could not clear the previous pending x402 marker before forcing a new payment", error);
      }
    }

    const init = {
      method,
      ...(input.body === undefined ? {} : { body: input.body }),
      ...(input.headers === undefined ? {} : { headers: input.headers })
    };

    const probe = await this.probeFetch(input.url, init);
    if (probe.status !== 402) {
      if (resuming) {
        throw new StandardX402PayError("payment_outcome_unknown",
          "The seller no longer offers the original payment challenge; the saved realization is retained for reconciliation.", publicPendingPayment(existingPending));
      }
      return { paid: false, status: probe.status, body: await probe.text() };
    }

    const selected = await this.selectRequirement(probe);
    if (resuming && (!standardRequirementMatchesSelected(existingPending.recovery!.requirement, selected) ||
        existingPending.amountRawUsdc !== selected.amountRawUsdc.toString() ||
        existingPending.payTo !== selected.payTo || existingPending.feePayer !== selected.feePayer)) {
      throw new StandardX402PayError("payment_outcome_unknown",
        "The seller's payment challenge differs from the saved realization; refusing to fund a different payment.", publicPendingPayment(existingPending));
    }

    const cap = input.maxAmountRawUsdc ?? this.defaultMaxAmountRawUsdc;
    if (selected.amountRawUsdc > cap) {
      throw new StandardX402PayError(
        "amount_exceeds_client_cap",
        `the challenge demands ${selected.amountRawUsdc} raw USDC, above the client cap of ${cap}; no new payment was attempted`,
        { amountRawUsdc: selected.amountRawUsdc.toString(), payTo: selected.payTo }
      );
    }
    const payment: RealizePaymentBinding = {
      payTo: selected.payTo,
      amountRawUsdc: selected.amountRawUsdc.toString(),
      resourceUrlHash: sha256HexOf(input.url),
      method
    };
    let pendingRecord: StandardX402PendingPaymentRecord = resuming ? existingPending : {
      key: pendingKey, url: input.url, method, requestBodyHash,
      amountRawUsdc: selected.amountRawUsdc.toString(), payTo: selected.payTo,
      feePayer: selected.feePayer, realizedRawUsdc: "0", realizeTxSignature: null,
      status: "realizing", createdAtMs: this.nowMs(), updatedAtMs: this.nowMs(),
      ...(realizer.realizationContext === undefined ? {} : {
        recovery: { version: 1, context: { ...realizer.realizationContext }, requestHeadersHash,
          requirement: structuredClone(selected.requirement) }
      })
    };
    if (!resuming) this.persistCheckpoint(pendingRecord);

    let realized: { realizedRawUsdc: bigint; txSignature: string | null; withdrawalId?: string | null };
    if (resuming && pendingRecord.status === "realized") {
      realized = { realizedRawUsdc: BigInt(pendingRecord.realizedRawUsdc),
        txSignature: pendingRecord.realizeTxSignature,
        withdrawalId: pendingRecord.recovery?.prepared?.withdrawalId ?? null };
    } else {
      try {
        if (resuming) {
          if (realizer.resumeUsdcAvailable === undefined) {
            throw new Error("This realizer cannot reconcile the saved withdrawal");
          }
          realized = await realizer.resumeUsdcAvailable({ amountRawUsdc: selected.amountRawUsdc,
            payment, prepared: pendingRecord.recovery!.prepared! });
        } else {
          realized = await realizer.ensureUsdcAvailable({
            amountRawUsdc: selected.amountRawUsdc, payment,
            ...(input.approvalId === undefined ? {} : { approvalId: input.approvalId }),
            onPrepared: async (prepared) => {
              if (pendingRecord.recovery === undefined) {
                throw new StandardX402PayError("state_persist_failed", "Cannot save a withdrawal without a pinned funding context");
              }
              const checkpoint = { ...pendingRecord, updatedAtMs: this.nowMs(),
                recovery: { ...pendingRecord.recovery, prepared: structuredClone(prepared) } };
              this.persistCheckpoint(checkpoint);
              pendingRecord = checkpoint;
            }
          });
        }
      } catch (error) {
        if (error instanceof StandardX402PayError && error.reason === "state_persist_failed") throw error;
        const failure = error as { code?: unknown; detail?: unknown; realizationSafeToRetry?: boolean };
        // Only a proven pre-submit refusal may remove the initial marker.
        // A resumed operation can already have submitted in a previous process.
        const safeToRetry = !resuming && (failure.realizationSafeToRetry === true ||
          (failure.code === "approval_required" && pendingRecord.recovery?.prepared === undefined));
        if (safeToRetry) {
          try { this.untrack(pendingKey); }
          catch (persistError) {
            throw new StandardX402PayError("state_persist_failed", "Could not clear the safely refused realization", persistError);
          }
        }
        if (safeToRetry && failure.code === "approval_required") {
          throw new StandardX402PayError("approval_required",
            "This payment needs the owner's approval; nothing was paid. Ask the owner to open approveUrl, then retry the same call with approvalId.",
            failure.detail ?? null);
        }
        throw new StandardX402PayError(safeToRetry ? "realize_failed" : "payment_outcome_unknown",
          safeToRetry ? "Yield realization failed before submission; no payment was attempted."
            : "The original yield realization has not been confirmed. Its saved withdrawal must be reconciled before any new withdrawal or payment.",
          { error, pendingPayment: safeToRetry ? null : publicPendingPayment(pendingRecord) });
      }
    }

    pendingRecord = { ...pendingRecord, status: "realized",
      realizedRawUsdc: realized.realizedRawUsdc.toString(), realizeTxSignature: realized.txSignature,
      updatedAtMs: this.nowMs() };
    this.persistCheckpoint(pendingRecord);

    if (realized.realizedRawUsdc < selected.amountRawUsdc) {
      throw new StandardX402PayError(
        "realize_underfunded",
        "The confirmed withdrawal did not cover the exact API price. No external payment was attempted; reconcile the recorded withdrawal before retrying.",
        { pendingPayment: publicPendingPayment(pendingRecord) }
      );
    }
    // This barrier distinguishes a safely resumable realization from a
    // possibly delivered external payment, including a crash inside x402Fetch.
    this.persistCheckpoint({ ...pendingRecord, status: "external_outcome_unknown",
      updatedAtMs: this.nowMs() });

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
    const receipt = readSettlementReceipt(response);
    if (response.status < 200 || response.status >= 300 ||
        receipt.status === "failed" || receipt.status === "invalid") {
      const persistError = this.tryMarkUnknown(pendingKey, {
        status: response.status,
        body: bodyText,
        receiptStatus: receipt.status
      });
      throw new StandardX402PayError(
        "payment_outcome_unknown",
        `the x402 payment attempt returned HTTP ${response.status} with a ${receipt.status} receipt; ` +
          "verify whether it settled before paying again",
        { status: response.status, body: bodyText, receiptStatus: receipt.status, persistError }
      );
    }
    this.clearDelivered(pendingKey);

    // The seller's settle response header names the on-chain payment tx.
    // Reporting it back to the relayer completes the mandate → realize →
    // payment audit chain; best-effort only, the payment already succeeded.
    const paymentTxSignature = receipt.txSignature;
    if (
      paymentTxSignature !== null &&
      typeof realized.withdrawalId === "string" &&
      realizer.reportPayment !== undefined
    ) {
      try {
        await realizer.reportPayment({
          withdrawalId: realized.withdrawalId,
          paymentTxSignature
        });
      } catch (error) {
        console.error(
          `[subly-x402] payment report-back failed (audit only, payment ok): ${
            error instanceof Error ? error.message : String(error)
          }`
        );
      }
    }

    return {
      paid: true,
      ...(realizer.vault === undefined ? {} : { fundingVault: realizer.vault }),
      status: response.status,
      body: bodyText,
      payment: {
        amountRawUsdc: selected.amountRawUsdc.toString(),
        payTo: selected.payTo,
        feePayer: selected.feePayer,
        realizedRawUsdc: realized.realizedRawUsdc.toString(),
        realizeTxSignature: realized.txSignature,
        paymentTxSignature
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

  private persistCheckpoint(record: StandardX402PendingPaymentRecord): void {
    try { this.track(record); }
    catch (error) {
      throw new StandardX402PayError("state_persist_failed",
        "Could not persist payment recovery state; refusing the next financial operation.",
        { error, pendingPayment: publicPendingPayment(record) });
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

/** Recovery signing material stays on disk, never in CLI/MCP error payloads. */
function publicPendingPayment(record: StandardX402PendingPaymentRecord) {
  return {
    url: record.url, method: record.method, requestBodyHash: record.requestBodyHash,
    amountRawUsdc: record.amountRawUsdc, payTo: record.payTo, feePayer: record.feePayer,
    realizedRawUsdc: record.realizedRawUsdc, realizeTxSignature: record.realizeTxSignature,
    status: record.status, createdAtMs: record.createdAtMs, updatedAtMs: record.updatedAtMs,
    withdrawalId: record.recovery?.prepared?.withdrawalId ?? null,
    fundingSource: record.recovery?.context ?? null
  };
}

function pendingPaymentKey(input: {
  url: string;
  method: string;
  requestBodyHash: string;
}): string {
  return `${input.method}:${input.url}:${input.requestBodyHash}`;
}

/**
 * Standard x402 v2: after settlement the resource server echoes the settle
 * response as base64 JSON in PAYMENT-RESPONSE, including the payment
 * transaction signature. Absent, failed or malformed receipts yield null.
 */
export function extractSettledPaymentTxSignature(
  response: FetchResponseLike
): string | null {
  return readSettlementReceipt(response).txSignature;
}

function readSettlementReceipt(response: FetchResponseLike): {
  status: "absent" | "success" | "failed" | "invalid";
  txSignature: string | null;
} {
  const header = response.headers.get(PAYMENT_RESPONSE_HEADER) ?? response.headers.get("x-payment-response");
  if (header === null) {
    // Preserve delivery compatibility with sellers that do not expose a receipt.
    return { status: "absent", txSignature: null };
  }
  try {
    const decoded = decodeX402Header(header);
    if (decoded === null || typeof decoded !== "object" || Array.isArray(decoded) ||
        !("success" in decoded) || typeof decoded.success !== "boolean") {
      return { status: "invalid", txSignature: null };
    }
    if (!decoded.success) return { status: "failed", txSignature: null };
    const receipt = decoded as { transaction?: unknown; txHash?: unknown };
    if (typeof receipt.transaction === "string" && receipt.transaction.length > 0) {
      return { status: "success", txSignature: receipt.transaction };
    }
    if (typeof receipt.txHash === "string" && receipt.txHash.length > 0) {
      return { status: "success", txSignature: receipt.txHash };
    }
    return { status: "invalid", txSignature: null };
  } catch {
    return { status: "invalid", txSignature: null };
  }
}
