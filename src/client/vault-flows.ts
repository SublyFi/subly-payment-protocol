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
  /** Used only to resolve lookup tables for structured-intent validation. */
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

export interface VaultBudgetView {
  wallet: string;
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

interface PreparedWithdrawal {
  withdrawalId: string;
  serializedTransaction: string;
  destinationUsdcAta: string;
  signingIntent: Parameters<AgentWalletSigner["signWithdrawal"]>[0]["intent"];
}

export class VaultFlowClient {
  private readonly baseUrl: string;
  private readonly signer: AgentWalletSigner;
  private readonly fetchImpl: typeof fetch;
  private readonly lookupTablesFor: (
    serializedTransaction: string
  ) => Promise<Record<string, readonly string[]>>;
  private readonly pollTimeoutMs: number;
  private readonly pollIntervalMs: number;

  constructor(config: VaultFlowClientConfig) {
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
        amountRawUsdc: input.amountRawUsdc.toString(),
        approvalId
      })) as PreparedDeposit;
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
  async withdraw(input: {
    amountRawUsdc: bigint;
    purpose?: "yield_realize";
    /**
     * The x402 payment a yield_realize funds; the relayer's spending-mandate
     * layer checks caps/payee against it and records it in the audit log.
     */
    payment?: {
      payTo: string;
      amountRawUsdc: string;
      resourceUrlHash: string;
      method: string;
    };
    /** Owner approval id for payments above the mandate threshold. */
    approvalId?: string;
  }): Promise<VaultWithdrawalOutcome> {
    const prepared = (await this.postJson(
      "prepare",
      "/v1/withdrawals/prepare",
      {
        wallet: this.signer.walletAddress,
        amountRawUsdc: input.amountRawUsdc.toString(),
        ...(input.purpose === undefined ? {} : { purpose: input.purpose }),
        ...(input.payment === undefined ? {} : { payment: input.payment }),
        ...(input.approvalId === undefined
          ? {}
          : { approvalId: input.approvalId })
      }
    )) as PreparedWithdrawal;

    const signed = await this.signer.signWithdrawal({
      intent: prepared.signingIntent,
      serializedTransaction: prepared.serializedTransaction,
      lookupTables: await this.lookupTablesFor(prepared.serializedTransaction)
    });

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
          { source: "chain" }
        );
      } catch {
        // Fall back to the last-synced ledger view.
      }
    }

    const url = `${this.baseUrl}/v1/wallets/${this.signer.walletAddress}/budget`;
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
      position?: { principalBasisRawUsdc?: string };
      budget?: {
        positionValueRawUsdc?: string;
        grossYieldRawUsdc?: string;
        spendableYieldRawUsdc?: string;
      };
    };
    return {
      wallet: this.signer.walletAddress,
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
        status === undefined ? "" : `?status=${encodeURIComponent(status)}`
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
    return (await this.postJson(
      "prepare",
      `/v1/wallets/${this.signer.walletAddress}/setup-sessions`,
      {
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
