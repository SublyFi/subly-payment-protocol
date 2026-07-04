import type { SolanaRpc } from "../solana/rpc.js";
import type { AgentWalletSigner } from "./agent-wallet-signer.js";
import type { YieldRealizer } from "./standard-x402-payer.js";
import {
  VaultFlowClient,
  VaultFlowClientError
} from "./vault-flows.js";

/**
 * Product/distribution-form yield realizer. The sponsor keypair lives ONLY on
 * the Subly relayer, never in a third party's MCP install — so
 * anyone who installs the client with just their agent key still gets gas
 * sponsorship, exactly like the existing beta.
 *
 * "Realize" reuses the deployed, mainnet-proven sponsored withdrawal flow via
 * the shared VaultFlowClient (one wire-protocol implementation for the demo
 * CLIs, the MCP vault tools, and this payment path):
 *   getBudget()   chain-sync + spendable-yield precheck (principal guard)
 *   withdraw({ purpose: "yield_realize" })
 *                 prepare -> agent owner-signs locally -> relayer sponsor
 *                 co-signs + submits -> poll until terminal
 *
 * Principal is protected twice: this client refuses to realize beyond the
 * ledger's spendable YIELD, and the relayer itself refuses to prepare a
 * yield_realize withdrawal the spendable yield cannot cover.
 */

/**
 * Client-side estimate of the relayer's realize-fee headroom
 * (VaultFlowServiceConfig.realizeOverheadRawUsdc, default 0.0025 USDC). Keeps
 * the precheck aligned with the server guard so a payment the server would
 * refuse is not attempted; the server remains authoritative.
 */
const REALIZE_OVERHEAD_RAW_USDC = 2_500n;

export class RelayerRealizeError extends Error {
  constructor(
    readonly code:
      | "insufficient_yield"
      | "budget_unavailable"
      | "prepare_failed"
      | "submit_failed"
      | "realize_not_confirmed"
      | "approval_required",
    message: string,
    readonly detail: unknown = null
  ) {
    super(message);
    this.name = "RelayerRealizeError";
  }
}

export interface RelayerYieldRealizerConfig {
  /** Subly relayer API base URL; `SUBLY_FACILITATOR_URL` remains a legacy env fallback. */
  relayerBaseUrl: string;
  signer: AgentWalletSigner;
  /** Used only to resolve lookup tables for structured-intent validation. */
  rpc: SolanaRpc;
  usdcMint?: string;
  fetchImpl?: typeof fetch;
  /**
   * Resolves a prepared transaction's lookup tables for intent validation.
   * Defaults to the RPC-backed resolver; injectable for tests.
   */
  lookupTablesFor?: (
    serializedTransaction: string
  ) => Promise<Record<string, readonly string[]>>;
}

export class RelayerYieldRealizer implements YieldRealizer {
  private readonly vaultFlows: VaultFlowClient;

  constructor(config: RelayerYieldRealizerConfig) {
    this.vaultFlows = new VaultFlowClient({
      relayerBaseUrl: config.relayerBaseUrl,
      signer: config.signer,
      rpc: config.rpc,
      ...(config.fetchImpl === undefined ? {} : { fetchImpl: config.fetchImpl }),
      ...(config.lookupTablesFor === undefined
        ? {}
        : { lookupTablesFor: config.lookupTablesFor })
    });
  }

  async ensureUsdcAvailable(input: {
    amountRawUsdc: bigint;
    payment?: {
      payTo: string;
      amountRawUsdc: string;
      resourceUrlHash: string;
      method: string;
    };
    /** Owner approval for a payment above the mandate threshold. */
    approvalId?: string;
  }): Promise<{
    realizedRawUsdc: bigint;
    txSignature: string | null;
    withdrawalId: string | null;
  }> {
    // Always realize the full payment amount from the yield ledger. The agent's
    // ATA may contain manual top-ups or unrelated USDC, so raw ATA balance is
    // not valid provenance for a "yield-funded" payment.
    const shortfallRawUsdc = input.amountRawUsdc;

    await this.assertSpendableYield(shortfallRawUsdc);

    let outcome;
    try {
      outcome = await this.vaultFlows.withdraw({
        amountRawUsdc: shortfallRawUsdc,
        // The relayer refuses to prepare this withdrawal beyond the spendable
        // yield — the principal-protection guard the client cannot bypass.
        purpose: "yield_realize",
        // Declares what is being paid so the relayer's spending-mandate layer
        // can enforce caps/payee and keep the mandate → payment audit chain.
        ...(input.payment === undefined ? {} : { payment: input.payment }),
        ...(input.approvalId === undefined
          ? {}
          : { approvalId: input.approvalId })
      });
    } catch (error) {
      throw this.mapWithdrawError(error);
    }

    if (outcome.status !== "confirmed" || outcome.txSignature === null) {
      throw new RelayerRealizeError(
        "realize_not_confirmed",
        `yield realize withdrawal did not confirm (status=${outcome.status})`,
        outcome
      );
    }

    return {
      realizedRawUsdc: BigInt(outcome.actualWithdrawRawUsdc ?? "0"),
      txSignature: outcome.txSignature,
      withdrawalId: outcome.withdrawalId
    };
  }

  /**
   * Best-effort report-back of the x402 payment tx this realize funded —
   * closes the relayer's mandate → realize → payment audit chain. Callers
   * must never let a failure here affect the payment result.
   */
  async reportPayment(input: {
    withdrawalId: string;
    paymentTxSignature: string;
  }): Promise<void> {
    await this.vaultFlows.reportPayment(input);
  }

  /**
   * Refuses to realize more than the ledger's spendable yield (principal).
   * getBudget syncs the relayer's ledger from chain first (best-effort), so a
   * long-running client sees yield as it accrues instead of a frozen view.
   */
  private async assertSpendableYield(shortfallRawUsdc: bigint): Promise<void> {
    let spendable: bigint;
    try {
      const budget = await this.vaultFlows.getBudget();
      spendable = BigInt(budget.spendableYieldRawUsdc);
    } catch (error) {
      throw new RelayerRealizeError(
        "budget_unavailable",
        "could not read the spendable-yield budget",
        error
      );
    }
    // Mirror the server guard (gross withdraw + fee headroom); anything the
    // server would refuse should fail here, before a prepare is attempted.
    const requiredRawUsdc = shortfallRawUsdc + REALIZE_OVERHEAD_RAW_USDC;
    if (spendable < requiredRawUsdc) {
      throw new RelayerRealizeError(
        "insufficient_yield",
        `spendable yield ${spendable} cannot cover ${shortfallRawUsdc} raw USDC ` +
          `plus the ${REALIZE_OVERHEAD_RAW_USDC} raw fee headroom; ` +
          "the principal is never spent — wait for more yield",
        { spendableYieldRawUsdc: spendable.toString() }
      );
    }
  }

  private mapWithdrawError(error: unknown): RelayerRealizeError {
    if (!(error instanceof VaultFlowClientError)) {
      return new RelayerRealizeError(
        "prepare_failed",
        `yield realize failed: ${
          error instanceof Error ? error.message : String(error)
        }`,
        error
      );
    }
    const serverCode = error.code ?? errorCodeFrom(error.detail);
    // Mandate threshold escalation: nothing was realized or paid. The detail
    // carries approvalId/approveUrl — the caller pastes the link into chat
    // and retries the same call with the approvalId once the owner signed.
    if (serverCode === "approval_required") {
      return new RelayerRealizeError(
        "approval_required",
        "this payment exceeds the owner-approval threshold; nothing was " +
          "realized or paid. Ask the owner to approve, then retry with the approvalId",
        error.errorDetails ?? error.detail
      );
    }
    // The relayer's own principal-protection guard: surface it under the
    // same code as the client precheck so callers see one "wait for yield".
    if (
      serverCode === "insufficient_yield" ||
      serverCode === "post_state_principal_invariant_failed"
    ) {
      return new RelayerRealizeError(
        "insufficient_yield",
        "the relayer refused to realize beyond the spendable yield; " +
          "the principal is never spent — wait for more yield",
        error.detail
      );
    }
    return new RelayerRealizeError(
      error.step === "submit" ? "submit_failed" : "prepare_failed",
      error.message,
      error.detail
    );
  }
}

function errorCodeFrom(detail: unknown): string | null {
  if (typeof detail !== "string") {
    return null;
  }
  try {
    const parsed = JSON.parse(detail) as {
      error?: { code?: unknown };
    };
    return typeof parsed.error?.code === "string" ? parsed.error.code : null;
  } catch {
    return null;
  }
}
