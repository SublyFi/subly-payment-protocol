import { SUBLY_VAULT } from "../config/constants.js";
import type { SolanaRpc } from "../solana/rpc.js";
import type { AgentWalletSigner } from "./agent-wallet-signer.js";
import { fetchLookupTablesForTransaction } from "./lookup-tables.js";
import { walletAuthHeaders } from "./wallet-auth-headers.js";
import type { YieldRealizer } from "./standard-x402-payer.js";

/**
 * Product/distribution-form yield realizer. The sponsor keypair lives ONLY on
 * the Subly relayer (facilitator), never in a third party's MCP install — so
 * anyone who installs the client with just their agent key still gets gas
 * sponsorship, exactly like the existing beta.
 *
 * "Realize" reuses the deployed, mainnet-proven sponsored withdrawal flow:
 *   GET  /v1/wallets/:w/budget            (principal-protection guard)
 *   POST /v1/withdrawals/prepare          (server builds withdraw -> own ATA)
 *   signer.signWithdrawal(...)            (agent owner-signs locally)
 *   POST /v1/withdrawals/submit           (relayer sponsor co-signs + submits)
 *
 * Principal is protected because we only ever realize an amount the server's
 * ledger reports as spendable YIELD; the deposited principal is never touched.
 */

export class RelayerRealizeError extends Error {
  constructor(
    readonly code:
      | "insufficient_yield"
      | "budget_unavailable"
      | "prepare_failed"
      | "submit_failed"
      | "realize_not_confirmed",
    message: string,
    readonly detail: unknown = null
  ) {
    super(message);
    this.name = "RelayerRealizeError";
  }
}

export interface RelayerYieldRealizerConfig {
  facilitatorBaseUrl: string;
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

interface PreparedWithdrawal {
  withdrawalId: string;
  serializedTransaction: string;
  destinationUsdcAta: string;
  signingIntent: Parameters<AgentWalletSigner["signWithdrawal"]>[0]["intent"];
}

interface SubmittedWithdrawal {
  status: string;
  txSignature: string | null;
  actualWithdrawRawUsdc: string | null;
}

export class RelayerYieldRealizer implements YieldRealizer {
  private readonly config: {
    facilitatorBaseUrl: string;
    usdcMint: string;
  };
  private readonly signer: AgentWalletSigner;
  private readonly rpc: SolanaRpc;
  private readonly fetchImpl: typeof fetch;
  private readonly lookupTablesFor: (
    serializedTransaction: string
  ) => Promise<Record<string, readonly string[]>>;

  constructor(config: RelayerYieldRealizerConfig) {
    this.config = {
      facilitatorBaseUrl: config.facilitatorBaseUrl.replace(/\/$/, ""),
      usdcMint: config.usdcMint ?? SUBLY_VAULT.usdcMint
    };
    this.signer = config.signer;
    this.rpc = config.rpc;
    this.fetchImpl = config.fetchImpl ?? fetch;
    this.lookupTablesFor =
      config.lookupTablesFor ??
      ((serializedTransaction) =>
        fetchLookupTablesForTransaction(this.rpc, serializedTransaction));
  }

  async ensureUsdcAvailable(input: {
    amountRawUsdc: bigint;
  }): Promise<{ realizedRawUsdc: bigint; txSignature: string | null }> {
    // Always realize the full payment amount from the yield ledger. The agent's
    // ATA may contain manual top-ups or unrelated USDC, so raw ATA balance is
    // not valid provenance for a "yield-funded" payment.
    const shortfallRawUsdc = input.amountRawUsdc;

    await this.assertSpendableYield(shortfallRawUsdc);

    const prepared = (await this.postJson("/v1/withdrawals/prepare", {
      wallet: this.signer.walletAddress,
      amountRawUsdc: shortfallRawUsdc.toString()
    })) as PreparedWithdrawal;

    const signed = await this.signer.signWithdrawal({
      intent: prepared.signingIntent,
      serializedTransaction: prepared.serializedTransaction,
      lookupTables: await this.lookupTablesFor(prepared.serializedTransaction)
    });

    let settled = (await this.postJson("/v1/withdrawals/submit", {
      withdrawalId: prepared.withdrawalId,
      serializedTransaction: signed.serializedTransaction,
      agentSignature: signed.agentSignature
    })) as SubmittedWithdrawal;

    // The relayer submits the sponsor-signed tx but may return before the tx
    // confirms on-chain (status "submitted"). Poll the reconciling GET endpoint
    // until it reaches a terminal state; each read looks the tx up on-chain and
    // finalizes to "confirmed" once it lands (or a terminal failure if the
    // blockhash expires without landing).
    if (settled.status === "submitted") {
      settled = await this.pollUntilSettled(prepared.withdrawalId);
    }

    if (settled.status !== "confirmed" || settled.txSignature === null) {
      throw new RelayerRealizeError(
        "realize_not_confirmed",
        `yield realize withdrawal did not confirm (status=${settled.status})`,
        settled
      );
    }

    return {
      realizedRawUsdc: BigInt(settled.actualWithdrawRawUsdc ?? "0"),
      txSignature: settled.txSignature
    };
  }

  /** Refuses to realize more than the ledger's spendable yield (principal). */
  private async assertSpendableYield(shortfallRawUsdc: bigint): Promise<void> {
    const url = `${this.config.facilitatorBaseUrl}/v1/wallets/${this.signer.walletAddress}/budget`;
    let response: Awaited<ReturnType<typeof fetch>>;
    try {
      response = await this.fetchImpl(url, {
        headers: await walletAuthHeaders({
          signer: this.signer,
          method: "GET",
          url
        })
      });
    } catch (error) {
      throw new RelayerRealizeError(
        "budget_unavailable",
        "could not read the spendable-yield budget",
        error
      );
    }
    if (response.status !== 200) {
      throw new RelayerRealizeError(
        "budget_unavailable",
        `budget endpoint returned ${response.status}`
      );
    }
    const body = (await response.json()) as {
      budget?: { spendableYieldRawUsdc?: string };
    };
    const spendable = BigInt(body.budget?.spendableYieldRawUsdc ?? "0");
    if (spendable < shortfallRawUsdc) {
      throw new RelayerRealizeError(
        "insufficient_yield",
        `spendable yield ${spendable} cannot cover ${shortfallRawUsdc} raw USDC; ` +
          "the principal is never spent — wait for more yield",
        { spendableYieldRawUsdc: spendable.toString() }
      );
    }
  }

  /**
   * Polls GET /v1/withdrawals/:id (which reconciles a submitted intent against
   * the chain) until it leaves the "submitted" state or the timeout elapses.
   */
  private async pollUntilSettled(
    withdrawalId: string,
    { timeoutMs = 90_000, intervalMs = 2_500 } = {}
  ): Promise<SubmittedWithdrawal> {
    const deadline = Date.now() + timeoutMs;
    let latest: SubmittedWithdrawal | null = null;
    while (Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, intervalMs));
      const url = `${this.config.facilitatorBaseUrl}/v1/withdrawals/${withdrawalId}`;
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
      latest = (await response.json()) as SubmittedWithdrawal;
      if (latest.status !== "submitted") {
        return latest;
      }
    }
    return (
      latest ?? {
        status: "submitted",
        txSignature: null,
        actualWithdrawRawUsdc: null
      }
    );
  }

  private async postJson(path: string, body: unknown): Promise<unknown> {
    const url = `${this.config.facilitatorBaseUrl}${path}`;
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
      throw new RelayerRealizeError(
        path.endsWith("/submit") ? "submit_failed" : "prepare_failed",
        `${path} failed with ${response.status}: ${text}`
      );
    }
    return JSON.parse(text);
  }
}
