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
    readonly step: "prepare" | "submit" | "budget" | "sync",
    message: string,
    readonly detail: unknown = null
  ) {
    super(message);
    this.name = "VaultFlowClientError";
  }
}

export interface VaultFlowClientConfig {
  /** Subly relayer API base URL. Kept as facilitatorBaseUrl for env compatibility. */
  facilitatorBaseUrl: string;
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
    this.baseUrl = config.facilitatorBaseUrl.replace(/\/$/, "");
    this.signer = config.signer;
    this.fetchImpl = config.fetchImpl ?? fetch;
    this.lookupTablesFor =
      config.lookupTablesFor ??
      ((serializedTransaction) =>
        fetchLookupTablesForTransaction(config.rpc, serializedTransaction));
    this.pollTimeoutMs = config.pollTimeoutMs ?? 90_000;
    this.pollIntervalMs = config.pollIntervalMs ?? 2_500;
  }

  /** Moves USDC from the agent wallet into the vault (fee sponsored). */
  async deposit(input: { amountRawUsdc: bigint }): Promise<VaultDepositOutcome> {
    const prepared = (await this.postJson("prepare", "/v1/deposits/prepare", {
      wallet: this.signer.walletAddress,
      amountRawUsdc: input.amountRawUsdc.toString()
    })) as PreparedDeposit;

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
  }): Promise<VaultWithdrawalOutcome> {
    const prepared = (await this.postJson(
      "prepare",
      "/v1/withdrawals/prepare",
      {
        wallet: this.signer.walletAddress,
        amountRawUsdc: input.amountRawUsdc.toString(),
        ...(input.purpose === undefined ? {} : { purpose: input.purpose })
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
      throw new VaultFlowClientError(
        step,
        `${path} failed with ${response.status}: ${text}`,
        text
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
}
