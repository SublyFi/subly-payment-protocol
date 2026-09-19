import { assertWithdrawalPreview } from "./withdrawal-preview.js";
import { canonicalJsonHash } from "../lib/canonical-json.js";
import { SUBLY_VAULT } from "../config/constants.js";
import type { VaultConfig } from "../config/vault.js";
import type { SolanaRpc } from "../solana/rpc.js";
import type { AgentWalletSigner } from "./agent-wallet-signer.js";
import { fetchLookupTablesForTransaction } from "./lookup-tables.js";
import { walletAuthHeaders } from "./wallet-auth-headers.js";

/**
 * Client for the Subly relayer's sponsored vault flows: deposit USDC into the
 * Kamino vault, withdraw back to the agent's USDC ATA, and read the
 * yield-budget — all signed locally by the agent wallet, with the transaction
 * fee paid by the relayer's sponsor (the agent needs no SOL).
 *
 * One implementation serves every distribution form: the demo CLIs
 * (demo/deposit.ts, demo/withdraw.ts — also the published `pay deposit` /
 * `pay withdraw` bins) and the MCP vault tools in mcp-payment-server.ts.
 */

export class VaultFlowClientError extends Error {
  constructor(
    readonly step: "prepare" | "submit" | "budget" | "sync" | "read",
    message: string,
    readonly detail: unknown = null,
    /** The relayer's error.code when the response carried one. */
    readonly code: string | null = null,
    /** The relayer's error.details (e.g. approvalId/approveUrl). */
    readonly errorDetails: unknown = null
  ) {
    super(message);
    this.name = "VaultFlowClientError";
  }
}

export interface VaultFlowClientConfig {
  /** Subly relayer API base URL; `SUBLY_FACILITATOR_URL` remains a legacy env fallback. */
  relayerBaseUrl: string;
  signer: AgentWalletSigner;
  vault?: Readonly<VaultConfig>;
  /** Independent RPC for lookup tables and unsigned withdrawal simulation. */
  rpc: SolanaRpc;
  fetchImpl?: typeof fetch;
  lookupTablesFor?: (
    serializedTransaction: string
  ) => Promise<Record<string, readonly string[]>>;
  pollTimeoutMs?: number;
  pollIntervalMs?: number;
}

export interface VaultDepositOutcome {
  depositId: string;
  status: string;
  txSignature: string | null;
  actualDepositRawUsdc: string | null;
  sharesMintedRaw: string | null;
  errorCode: string | null;
}

export interface VaultWithdrawalOutcome {
  withdrawalId: string;
  status: string;
  txSignature: string | null;
  destinationUsdcAta: string | null;
  actualWithdrawRawUsdc: string | null;
  actualSharesBurnedRaw: string | null;
  errorCode: string | null;
}

export interface VaultOperationStatus {
  intentId: string;
  kind: "deposit" | "withdrawal";
  wallet: string;
  vault: string;
  status: "prepared" | "submitted" | "confirmed" | "failed" | "expired" | "failed_not_submitted";
  requestedAmountRawUsdc: string;
  actualAmountRawUsdc: string | null;
  txSignature: string | null;
  errorCode: string | null;
  stillConfirming: boolean;
  nextAction: "check_again" | "done" | "reconcile_with_operator";
  message: string;
}

export function vaultOperationKind(intentId: string): "deposit" | "withdrawal" {
  if (/^dep_[0-9a-f]{32}$/.test(intentId)) return "deposit";
  if (/^wdr_[0-9a-f]{32}$/.test(intentId)) return "withdrawal";
  throw new VaultFlowClientError("read", "intentId must be the original dep_ or wdr_ ID followed by 32 lowercase hexadecimal characters");
}

export interface VaultBudgetView {
  wallet: string;
  vault?: string;
  principalBasisRawUsdc: string;
  positionValueRawUsdc: string;
  grossYieldRawUsdc: string;
  spendableYieldRawUsdc: string;
}

export interface ApprovalView {
  approvalId: string;
  wallet: string;
  binding: unknown;
  bindingHash: string;
  status: string;
  requestedAtMs: number;
  expiresAtMs: number;
}

export interface SetupSessionCreated {
  sessionId: string;
  setupUrl: string;
  expiresAtMs: number;
  wallet: string;
  vault: string;
  policy: Record<string, unknown>;
  enforcementMode: string;
  mandateExpiresAtMs: number;
  initialDepositRawUsdc: string | null;
}

export interface SetupSessionView {
  sessionId: string;
  status: "pending" | "completed" | "expired";
  wallet: string;
  mandateHash?: string | null;
  initialDepositApproval?: {
    approvalId: string;
    expiresAtMs: number;
    status: string;
  } | null;
  expiresAtMs?: number;
}

interface PreparedDeposit {
  depositId: string;
  serializedTransaction: string;
  signingIntent: Parameters<AgentWalletSigner["signDeposit"]>[0]["intent"];
}

export interface PreparedWithdrawal {
  requestedWithdrawRawUsdc: string;
  purpose: "normal" | "yield_realize";
  withdrawalId: string;
  serializedTransaction: string;
  destinationUsdcAta: string;
  signingIntent: Parameters<AgentWalletSigner["signWithdrawal"]>[0]["intent"];
}

export interface VaultWithdrawalInput {
  amountRawUsdc: bigint;
  purpose?: "yield_realize";
  payment?: { payTo: string; amountRawUsdc: string; resourceUrlHash: string; method: string };
  approvalId?: string;
  /** Must complete durably before signing/submitting this withdrawal. */
  onPrepared?: (prepared: PreparedWithdrawal) => Promise<void>;
  /** Internal progress notification, immediately before the submit request. */
  onBeforeSubmit?: () => void;
}

export class VaultFlowClient {
  readonly vault: Readonly<VaultConfig>;
  private readonly rpc: SolanaRpc;
  private readonly baseUrl: string;
  private readonly signer: AgentWalletSigner;
  private readonly fetchImpl: typeof fetch;
  private readonly lookupTablesFor: (
    serializedTransaction: string
  ) => Promise<Record<string, readonly string[]>>;
  private readonly pollTimeoutMs: number;
  private readonly pollIntervalMs: number;

  constructor(config: VaultFlowClientConfig) {
    this.rpc = config.rpc;
    this.vault = config.vault ?? config.signer.vault ?? SUBLY_VAULT;
    if (config.signer.vault && config.signer.vault.address !== this.vault.address) {
      throw new Error("Vault flow client and signer must select the same vault");
    }
    this.baseUrl = config.relayerBaseUrl.replace(/\/$/, "");
    this.signer = config.signer;
    this.fetchImpl = config.fetchImpl ?? fetch;
    this.lookupTablesFor =
      config.lookupTablesFor ??
      ((serializedTransaction) =>
        fetchLookupTablesForTransaction(config.rpc, serializedTransaction));
    this.pollTimeoutMs = config.pollTimeoutMs ?? 90_000;
    this.pollIntervalMs = config.pollIntervalMs ?? 2_500;
  }

  /**
   * Moves USDC from the agent wallet into the vault (fee sponsored). Under
   * depositPolicy "owner_approval_required" the relayer refuses to prepare
   * without an owner approval; when the caller passes none, an already
   * APPROVED deposit approval for this exact amount (e.g. the mandate's
   * initialDeposit — "one Face ID covers mandate + first deposit") is looked
   * up and used automatically before surfacing deposit_approval_required.
   */
  async deposit(input: {
    amountRawUsdc: bigint;
    approvalId?: string;
  }): Promise<VaultDepositOutcome> {
    let approvalId = input.approvalId;
    let prepared: PreparedDeposit;
    try {
      prepared = (await this.postJson("prepare", "/v1/deposits/prepare", {
        wallet: this.signer.walletAddress,
        vault: this.vault.address,
        amountRawUsdc: input.amountRawUsdc.toString(),
        ...(approvalId === undefined ? {} : { approvalId })
      })) as PreparedDeposit;
    } catch (error) {
      if (
        !(error instanceof VaultFlowClientError) ||
        error.code !== "deposit_approval_required" ||
        approvalId !== undefined
      ) {
        throw error;
      }
      approvalId = await this.findApprovedDepositApproval(input.amountRawUsdc);
      if (approvalId === undefined) {
        throw error;
      }
      prepared = (await this.postJson("prepare", "/v1/deposits/prepare", {
        wallet: this.signer.walletAddress,
        vault: this.vault.address,
        amountRawUsdc: input.amountRawUsdc.toString(),
        approvalId
      })) as PreparedDeposit;
    }

    if (prepared.signingIntent?.wallet !== this.signer.walletAddress ||
        prepared.signingIntent.vault !== this.vault.address ||
        prepared.signingIntent.amountRawUsdc !== input.amountRawUsdc.toString()) {
      throw new VaultFlowClientError("prepare", "Prepared deposit differs from the requested wallet, vault or amount");
    }
    const signed = await this.signer.signDeposit({
      intent: prepared.signingIntent,
      serializedTransaction: prepared.serializedTransaction,
      lookupTables: await this.lookupTablesFor(prepared.serializedTransaction)
    });

    let outcome = (await this.postJson("submit", "/v1/deposits/submit", {
      depositId: prepared.depositId,
      serializedTransaction: signed.serializedTransaction,
      agentSignature: signed.agentSignature
    })) as VaultDepositOutcome;
    if (outcome.status === "submitted") {
      outcome = (await this.pollUntilTerminal(
        `/v1/deposits/${prepared.depositId}`,
        outcome
      )) as VaultDepositOutcome;
    }
    // The reconciling GET returns the full serialized intent (transaction
    // bytes and all); pick only the outcome fields so callers — including
    // agent-visible MCP tool results — never see the internals.
    return {
      depositId: prepared.depositId,
      status: outcome.status,
      txSignature: outcome.txSignature ?? null,
      actualDepositRawUsdc: outcome.actualDepositRawUsdc ?? null,
      sharesMintedRaw: outcome.sharesMintedRaw ?? null,
      errorCode: outcome.errorCode ?? null
    };
  }

  /**
   * Moves USDC from the vault back to the agent wallet's USDC ATA (fee
   * sponsored). A plain withdrawal is the exit path and MAY spend principal;
   * with purpose "yield_realize" the relayer refuses anything beyond the
   * spendable yield (the payment path, via RelayerYieldRealizer).
   */
  async withdraw(input: VaultWithdrawalInput): Promise<VaultWithdrawalOutcome> {
    const prepared = (await this.postJson(
      "prepare",
      "/v1/withdrawals/prepare",
      {
        wallet: this.signer.walletAddress,
        vault: this.vault.address,
        amountRawUsdc: input.amountRawUsdc.toString(),
        ...(input.purpose === undefined ? {} : { purpose: input.purpose }),
        ...(input.payment === undefined ? {} : { payment: input.payment }),
        ...(input.approvalId === undefined
          ? {}
          : { approvalId: input.approvalId })
      }
    )) as PreparedWithdrawal;

    this.assertPreparedWithdrawal(prepared, input);
    await input.onPrepared?.(prepared);
    return this.submitPreparedWithdrawal(prepared, input);
  }

  /** Reconcile or submit the original intent; never prepare a replacement. */
  async resumeWithdrawal(
    prepared: PreparedWithdrawal,
    input: VaultWithdrawalInput
  ): Promise<VaultWithdrawalOutcome> {
    this.assertPreparedWithdrawal(prepared, input);
    const current = (await this.getJson(
      `/v1/withdrawals/${encodeURIComponent(prepared.withdrawalId)}`
    )) as VaultWithdrawalOutcome & PreparedWithdrawal & {
      wallet: string; vault: string; paymentBinding: VaultWithdrawalInput["payment"] | null;
      preparedMessageHash: string;
    };
    // A saved checkpoint is only a reference. Confirm its operation against
    // the current relayer response and the caller's pinned wallet/vault.
    if (current.withdrawalId !== prepared.withdrawalId ||
        current.wallet !== this.signer.walletAddress || current.vault !== this.vault.address ||
        current.requestedWithdrawRawUsdc !== input.amountRawUsdc.toString() ||
        current.purpose !== (input.purpose ?? "normal") ||
        canonicalJsonHash(current.paymentBinding ?? null) !== canonicalJsonHash(input.payment ?? null) ||
        current.serializedTransaction !== prepared.serializedTransaction ||
        current.preparedMessageHash !== prepared.signingIntent.preparedMessageHash ||
        current.destinationUsdcAta !== prepared.destinationUsdcAta) {
      throw new VaultFlowClientError("read", "Saved withdrawal differs from the original operation; refusing to resume");
    }
    if (current.status === "prepared") {
      // Re-run the independent preview and structured signing validation.
      return this.submitPreparedWithdrawal(prepared, input);
    }
    if (!["submitted", "confirmed", "failed", "failed_not_submitted", "expired", "quarantined"].includes(current.status)) {
      throw new VaultFlowClientError("read", "Relayer returned an unknown withdrawal status");
    }
    return this.withdrawalOutcome(prepared, current);
  }

  private assertPreparedWithdrawal(prepared: PreparedWithdrawal, input: VaultWithdrawalInput): void {

    if (prepared.signingIntent?.wallet !== this.signer.walletAddress ||
        prepared.signingIntent.vault !== this.vault.address ||
        prepared.requestedWithdrawRawUsdc !== input.amountRawUsdc.toString() ||
        prepared.purpose !== (input.purpose ?? "normal") ||
        (input.purpose === "yield_realize" && prepared.signingIntent.allowFullExit)) {
      throw new VaultFlowClientError("prepare", "Prepared withdrawal differs from the requested operation");
    }
    if (typeof prepared.withdrawalId !== "string" || prepared.withdrawalId.length === 0) {
      throw new VaultFlowClientError("prepare", "Prepared withdrawal has no withdrawal ID");
    }
  }

  private async submitPreparedWithdrawal(
    prepared: PreparedWithdrawal,
    input: VaultWithdrawalInput
  ): Promise<VaultWithdrawalOutcome> {
    await assertWithdrawalPreview({
      rpc: this.rpc,
      serializedTransaction: prepared.serializedTransaction,
      wallet: this.signer.walletAddress,
      vault: this.vault,
      amountRawUsdc: input.amountRawUsdc,
      ...(input.purpose === undefined ? {} : { purpose: input.purpose })
    });
    const signed = await this.signer.signWithdrawal({
      intent: prepared.signingIntent,
      serializedTransaction: prepared.serializedTransaction,
      lookupTables: await this.lookupTablesFor(prepared.serializedTransaction)
    });

    input.onBeforeSubmit?.();
    let outcome = (await this.postJson("submit", "/v1/withdrawals/submit", {
      withdrawalId: prepared.withdrawalId,
      serializedTransaction: signed.serializedTransaction,
      agentSignature: signed.agentSignature
    })) as VaultWithdrawalOutcome;
    if (outcome.status === "submitted") {
      outcome = (await this.pollUntilTerminal(
        `/v1/withdrawals/${prepared.withdrawalId}`,
        outcome
      )) as VaultWithdrawalOutcome;
    }
    return this.withdrawalOutcome(prepared, outcome);
  }

  private withdrawalOutcome(prepared: PreparedWithdrawal, outcome: VaultWithdrawalOutcome): VaultWithdrawalOutcome {
    return {
      withdrawalId: prepared.withdrawalId,
      status: outcome.status,
      txSignature: outcome.txSignature ?? null,
      destinationUsdcAta: prepared.destinationUsdcAta,
      actualWithdrawRawUsdc: outcome.actualWithdrawRawUsdc ?? null,
      actualSharesBurnedRaw: outcome.actualSharesBurnedRaw ?? null,
      errorCode: outcome.errorCode ?? null
    };
  }

  /** Authenticated read/reconciliation only: never prepare, sign or submit a transaction. */
  async getOperationStatus(intentId: string): Promise<VaultOperationStatus> {
    const kind = vaultOperationKind(intentId);
    const raw = await this.getJson(`/v1/${kind === "deposit" ? "deposits" : "withdrawals"}/${intentId}?resubmit=false`);
    if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
      throw new VaultFlowClientError("read", "Relayer returned an invalid operation status");
    }
    const record = raw as Record<string, unknown>;
    if (record[kind === "deposit" ? "depositId" : "withdrawalId"] !== intentId ||
        record.wallet !== this.signer.walletAddress || record.vault !== this.vault.address) {
      throw new VaultFlowClientError("read", "Operation does not match the requested ID, current wallet or selected vault; use the original wallet, vault and relayer");
    }
    const requested = record[kind === "deposit" ? "amountRawUsdc" : "requestedWithdrawRawUsdc"];
    const actual = record[kind === "deposit" ? "actualDepositRawUsdc" : "actualWithdrawRawUsdc"];
    if (typeof record.status !== "string" ||
        !["prepared", "submitted", "confirmed", "failed", "expired", "failed_not_submitted"].includes(record.status) ||
        typeof requested !== "string" || !/^\d+$/.test(requested) ||
        (actual !== null && (typeof actual !== "string" || !/^\d+$/.test(actual))) ||
        (record.txSignature !== null && (typeof record.txSignature !== "string" || record.txSignature.length === 0)) ||
        (record.errorCode !== null && typeof record.errorCode !== "string") ||
        (record.status === "confirmed" && (actual === null || record.txSignature === null))) {
      throw new VaultFlowClientError("read", "Relayer returned incomplete or invalid operation status fields");
    }
    const status = record.status as VaultOperationStatus["status"];
    const nextAction = status === "confirmed" ? "done" :
      status === "submitted" || status === "prepared" ? "check_again" : "reconcile_with_operator";
    const message = status === "confirmed" ? `The original ${kind} is confirmed.` :
      status === "submitted" ? "The original transaction is still confirming. Check this same intent ID again; do not repeat the deposit or withdrawal." :
      status === "prepared" ? "The original intent is prepared. This status check does not submit it. Check the same ID again or ask the operator to reconcile it before starting another operation." :
      "The original operation ended without a confirmed result. Reconcile its intent ID and transaction with the operator before starting another operation.";
    // Explicit projection keeps transaction bytes, signatures-to-submit and
    // approval capabilities in the relayer, out of agent-visible responses.
    return { intentId, kind, wallet: this.signer.walletAddress, vault: this.vault.address,
      status, requestedAmountRawUsdc: requested, actualAmountRawUsdc: actual as string | null,
      txSignature: record.txSignature as string | null, errorCode: record.errorCode as string | null,
      stillConfirming: status === "submitted", nextAction, message };
  }

  /**
   * Reads the yield budget. Syncs the relayer's ledger from chain first (so
   * yield accrued since the last sync shows up); the sync is best-effort and
   * on failure the last-synced view is returned.
   */
  async getBudget(
    options: { refreshFromChain?: boolean } = {}
  ): Promise<VaultBudgetView> {
    if (options.refreshFromChain !== false) {
      try {
        await this.postJson(
          "sync",
          `/v1/wallets/${this.signer.walletAddress}/sync`,
          { source: "chain", vault: this.vault.address }
        );
      } catch {
        // Fall back to the last-synced ledger view.
      }
    }

    const url = `${this.baseUrl}/v1/wallets/${this.signer.walletAddress}/budget?vault=${this.vault.address}`;
    const response = await this.fetchImpl(url, {
      headers: await walletAuthHeaders({
        signer: this.signer,
        method: "GET",
        url
      })
    });
    const text = await response.text();
    if (response.status !== 200) {
      throw new VaultFlowClientError(
        "budget",
        `budget endpoint returned ${response.status}: ${text}`
      );
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      throw new VaultFlowClientError(
        "budget",
        "budget endpoint returned 200 with a non-JSON body",
        text
      );
    }
    const body = parsed as {
      position?: { vault?: string; principalBasisRawUsdc?: string };
      budget?: {
        positionValueRawUsdc?: string;
        grossYieldRawUsdc?: string;
        spendableYieldRawUsdc?: string;
      };
    };
    if (body.position?.vault !== undefined && body.position.vault !== this.vault.address) {
      throw new VaultFlowClientError("budget", "Relayer returned the budget for a different vault");
    }
    return {
      wallet: this.signer.walletAddress,
      vault: this.vault.address,
      principalBasisRawUsdc: body.position?.principalBasisRawUsdc ?? "0",
      positionValueRawUsdc: body.budget?.positionValueRawUsdc ?? "0",
      grossYieldRawUsdc: body.budget?.grossYieldRawUsdc ?? "0",
      spendableYieldRawUsdc: body.budget?.spendableYieldRawUsdc ?? "0"
    };
  }

  /** Best-effort audit link: reports the x402 payment tx a realize funded. */
  async reportPayment(input: {
    withdrawalId: string;
    paymentTxSignature: string;
  }): Promise<void> {
    await this.postJson("submit", "/v1/payments/report", {
      wallet: this.signer.walletAddress,
      withdrawalId: input.withdrawalId,
      paymentTxSignature: input.paymentTxSignature
    });
  }

  /** Wallet's approvals as the relayer sees them (optionally by status). */
  async listApprovals(status?: string): Promise<ApprovalView[]> {
    const body = (await this.getJson(
      `/v1/wallets/${this.signer.walletAddress}/approvals${
        `?vault=${this.vault.address}${status === undefined ? "" : `&status=${encodeURIComponent(status)}`}`
      }`
    )) as { approvals?: ApprovalView[] };
    return body.approvals ?? [];
  }

  /**
   * Creates the owner-onboarding setup link (wallet-auth pins the agreed
   * policy + initial deposit). Paste `setupUrl` into the chat verbatim.
   */
  async createSetupSession(input: {
    policy?: Record<string, unknown>;
    enforcementMode?: "subly" | "wallet_infra";
    mandateTtlDays?: number;
    initialDepositRawUsdc?: string;
  }): Promise<SetupSessionCreated> {
    const session = (await this.postJson(
      "prepare",
      `/v1/wallets/${this.signer.walletAddress}/setup-sessions`,
      {
        vault: this.vault.address,
        ...(input.policy === undefined ? {} : { policy: input.policy }),
        ...(input.enforcementMode === undefined
          ? {}
          : { enforcementMode: input.enforcementMode }),
        ...(input.mandateTtlDays === undefined
          ? {}
          : { mandateTtlDays: input.mandateTtlDays }),
        ...(input.initialDepositRawUsdc === undefined
          ? {}
          : { initialDepositRawUsdc: input.initialDepositRawUsdc })
      }
    )) as SetupSessionCreated;
    if (session.vault !== this.vault.address || session.wallet !== this.signer.walletAddress) {
      throw new VaultFlowClientError("prepare", "Relayer returned a setup session for a different wallet or vault");
    }
    return session;
  }

  /** Polls a setup session (public capability URL — no auth needed). */
  async getSetupSession(sessionId: string): Promise<SetupSessionView> {
    const url = `${this.baseUrl}/v1/setup-sessions/${encodeURIComponent(sessionId)}`;
    const response = await this.fetchImpl(url);
    const text = await response.text();
    if (response.status !== 200) {
      const parsed = parseRelayerError(text);
      throw new VaultFlowClientError(
        "read",
        parsed.message ?? `setup session read failed with ${response.status}`,
        text,
        parsed.code,
        parsed.details
      );
    }
    return JSON.parse(text) as SetupSessionView;
  }

  /**
   * Finds an APPROVED, unconsumed deposit approval bound to exactly this
   * amount — the shape the mandate's initialDeposit approval has.
   */
  private async findApprovedDepositApproval(
    amountRawUsdc: bigint
  ): Promise<string | undefined> {
    try {
      const approvals = await this.listApprovals("approved");
      const match = approvals.find((approval) => {
        const binding = approval.binding as
          | { kind?: string; amountRawUsdc?: string }
          | null;
        return (
          binding?.kind === "deposit" &&
          binding.amountRawUsdc === amountRawUsdc.toString()
        );
      });
      return match?.approvalId;
    } catch {
      return undefined;
    }
  }

  /**
   * Polls the reconciling GET endpoint until the intent leaves "submitted"
   * (each read looks the tx up on-chain) or the timeout elapses.
   */
  private async pollUntilTerminal<T extends { status: string }>(
    path: string,
    last: T
  ): Promise<T> {
    const deadline = Date.now() + this.pollTimeoutMs;
    let latest = last;
    while (Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, this.pollIntervalMs));
      const url = `${this.baseUrl}${path}`;
      const response = await this.fetchImpl(url, {
        headers: await walletAuthHeaders({
          signer: this.signer,
          method: "GET",
          url
        })
      });
      if (response.status !== 200) {
        continue;
      }
      try {
        latest = (await response.json()) as T;
      } catch {
        continue; // transient garbage body; keep polling
      }
      if (latest.status !== "submitted") {
        return latest;
      }
    }
    return latest;
  }

  private async postJson(
    step: "prepare" | "submit" | "sync",
    path: string,
    body: unknown
  ): Promise<unknown> {
    const url = `${this.baseUrl}${path}`;
    const serialized = JSON.stringify(body);
    const response = await this.fetchImpl(url, {
      method: "POST",
      headers: {
        ...(await walletAuthHeaders({
          signer: this.signer,
          method: "POST",
          url,
          body: serialized
        })),
        "content-type": "application/json"
      },
      body: serialized
    });
    const text = await response.text();
    if (response.status !== 200) {
      const parsed = parseRelayerError(text);
      throw new VaultFlowClientError(
        step,
        parsed.message === null
          ? `${path} failed with ${response.status}: ${text}`
          : `${path} failed (${parsed.code ?? response.status}): ${parsed.message}`,
        text,
        parsed.code,
        parsed.details
      );
    }
    try {
      return JSON.parse(text);
    } catch {
      throw new VaultFlowClientError(
        step,
        `${path} returned 200 with a non-JSON body`,
        text
      );
    }
  }

  private async getJson(path: string): Promise<unknown> {
    const url = `${this.baseUrl}${path}`;
    const response = await this.fetchImpl(url, {
      headers: await walletAuthHeaders({
        signer: this.signer,
        method: "GET",
        url
      })
    });
    const text = await response.text();
    if (response.status !== 200) {
      const parsed = parseRelayerError(text);
      throw new VaultFlowClientError(
        "read",
        parsed.message === null
          ? `${path} failed with ${response.status}: ${text}`
          : `${path} failed (${parsed.code ?? response.status}): ${parsed.message}`,
        text,
        parsed.code,
        parsed.details
      );
    }
    try {
      return JSON.parse(text);
    } catch {
      throw new VaultFlowClientError(
        "read",
        `${path} returned 200 with a non-JSON body`,
        text
      );
    }
  }
}

function parseRelayerError(text: string): {
  code: string | null;
  message: string | null;
  details: unknown;
} {
  try {
    const parsed = JSON.parse(text) as {
      error?: { code?: unknown; message?: unknown; details?: unknown };
    };
    return {
      code: typeof parsed.error?.code === "string" ? parsed.error.code : null,
      message:
        typeof parsed.error?.message === "string" ? parsed.error.message : null,
      details: parsed.error?.details ?? null
    };
  } catch {
    return { code: null, message: null, details: null };
  }
}
