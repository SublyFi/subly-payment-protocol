import { describe, expect, it, vi } from "vitest";
import type { AgentWalletSigner } from "../src/client/agent-wallet-signer.js";
import {
  VaultFlowClient,
  VaultFlowClientError
} from "../src/client/vault-flows.js";
import type { SolanaRpc } from "../src/solana/rpc.js";

const WALLET = "GPqt7ksu6LoKAx7PXEDb54bjrN5fs9R61TkzyL5X3H1M";
const BASE = "https://api.demo.sublyfi.com";

function fakeSigner(): AgentWalletSigner {
  return {
    walletAddress: WALLET,
    validationMode: "structured_intent_transaction",
    signPayment: vi.fn(),
    signDeposit: vi.fn(async () => ({
      serializedTransaction: "signedDepositTxB64",
      agentSignature: "agentSig"
    })),
    signWithdrawal: vi.fn(async () => ({
      serializedTransaction: "signedWithdrawTxB64",
      agentSignature: "agentSig"
    })),
    signApiMessage: vi.fn(async () => "authsig")
  } as unknown as AgentWalletSigner;
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status });
}

function buildClient(fetchImpl: typeof fetch) {
  return new VaultFlowClient({
    facilitatorBaseUrl: BASE,
    signer: fakeSigner(),
    rpc: {} as SolanaRpc,
    fetchImpl,
    lookupTablesFor: async () => ({}),
    pollIntervalMs: 1,
    pollTimeoutMs: 200
  });
}

describe("VaultFlowClient", () => {
  it("runs the sponsored deposit flow end to end", async () => {
    const calls: string[] = [];
    const fetchImpl = vi.fn(async (url: string | URL | Request) => {
      const u = String(url);
      calls.push(u);
      if (u.endsWith("/v1/deposits/prepare")) {
        return jsonResponse(200, {
          depositId: "dep_1",
          serializedTransaction: "preparedTxB64",
          signingIntent: { wallet: WALLET }
        });
      }
      if (u.endsWith("/v1/deposits/submit")) {
        return jsonResponse(200, {
          status: "confirmed",
          txSignature: "depositSig",
          actualDepositRawUsdc: "1000000",
          sharesMintedRaw: "999",
          errorCode: null
        });
      }
      throw new Error(`unexpected url ${u}`);
    });

    const outcome = await buildClient(
      fetchImpl as unknown as typeof fetch
    ).deposit({ amountRawUsdc: 1_000_000n });

    expect(outcome.status).toBe("confirmed");
    expect(outcome.depositId).toBe("dep_1");
    expect(outcome.txSignature).toBe("depositSig");
    expect(calls).toEqual([
      `${BASE}/v1/deposits/prepare`,
      `${BASE}/v1/deposits/submit`
    ]);
  });

  it("polls a submitted withdrawal until it confirms and strips internals", async () => {
    let statusReads = 0;
    let prepareBody: unknown;
    const fetchImpl = vi.fn(
      async (url: string | URL | Request, init?: RequestInit) => {
        const u = String(url);
        if (u.endsWith("/v1/withdrawals/prepare")) {
          prepareBody =
            typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
          return jsonResponse(200, {
            withdrawalId: "wdr_1",
            serializedTransaction: "preparedTxB64",
            destinationUsdcAta: "ata",
            signingIntent: { wallet: WALLET }
          });
        }
        if (u.endsWith("/v1/withdrawals/submit")) {
          return jsonResponse(200, {
            status: "submitted",
            txSignature: "wdrSig",
            actualWithdrawRawUsdc: null,
            actualSharesBurnedRaw: null,
            errorCode: null
          });
        }
        if (u.endsWith("/v1/withdrawals/wdr_1")) {
          statusReads += 1;
          return jsonResponse(
            200,
            statusReads < 2
              ? { status: "submitted", txSignature: "wdrSig" }
              : {
                  status: "confirmed",
                  txSignature: "wdrSig",
                  actualWithdrawRawUsdc: "500000",
                  actualSharesBurnedRaw: "499",
                  errorCode: null,
                  // Internals from the serialized intent must not leak into
                  // the outcome an agent sees.
                  serializedTransaction: "SECRETB64",
                  preparedMessageHash: "sha256-x"
                }
          );
        }
        throw new Error(`unexpected url ${u}`);
      }
    );

    const outcome = await buildClient(
      fetchImpl as unknown as typeof fetch
    ).withdraw({ amountRawUsdc: 500_000n, purpose: "yield_realize" });

    expect(outcome).toEqual({
      withdrawalId: "wdr_1",
      status: "confirmed",
      txSignature: "wdrSig",
      destinationUsdcAta: "ata",
      actualWithdrawRawUsdc: "500000",
      actualSharesBurnedRaw: "499",
      errorCode: null
    });
    expect(statusReads).toBe(2);
    expect(prepareBody).toMatchObject({ purpose: "yield_realize" });
  });

  it("syncs from chain before reading the budget", async () => {
    const calls: string[] = [];
    const fetchImpl = vi.fn(async (url: string | URL | Request) => {
      const u = String(url);
      calls.push(u);
      if (u.endsWith("/sync")) {
        return jsonResponse(200, { position: {} });
      }
      if (u.endsWith("/budget")) {
        return jsonResponse(200, {
          position: { principalBasisRawUsdc: "100000000" },
          budget: {
            positionValueRawUsdc: "101000000",
            grossYieldRawUsdc: "1000000",
            spendableYieldRawUsdc: "900000"
          }
        });
      }
      throw new Error(`unexpected url ${u}`);
    });

    const budget = await buildClient(
      fetchImpl as unknown as typeof fetch
    ).getBudget();

    expect(budget).toEqual({
      wallet: WALLET,
      principalBasisRawUsdc: "100000000",
      positionValueRawUsdc: "101000000",
      grossYieldRawUsdc: "1000000",
      spendableYieldRawUsdc: "900000"
    });
    expect(calls).toEqual([
      `${BASE}/v1/wallets/${WALLET}/sync`,
      `${BASE}/v1/wallets/${WALLET}/budget`
    ]);
  });

  it("returns the budget even when the chain sync fails", async () => {
    const fetchImpl = vi.fn(async (url: string | URL | Request) => {
      const u = String(url);
      if (u.endsWith("/sync")) {
        return jsonResponse(503, { error: { code: "chain_sync_unavailable" } });
      }
      if (u.endsWith("/budget")) {
        return jsonResponse(200, {
          position: { principalBasisRawUsdc: "0" },
          budget: {
            positionValueRawUsdc: "0",
            grossYieldRawUsdc: "0",
            spendableYieldRawUsdc: "0"
          }
        });
      }
      throw new Error(`unexpected url ${u}`);
    });

    const budget = await buildClient(
      fetchImpl as unknown as typeof fetch
    ).getBudget();
    expect(budget.spendableYieldRawUsdc).toBe("0");
  });

  it("surfaces prepare failures with the step and server detail", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse(400, {
        error: { code: "deposit_below_minimum", message: "too small" }
      })
    );

    await expect(
      buildClient(fetchImpl as unknown as typeof fetch).deposit({
        amountRawUsdc: 1n
      })
    ).rejects.toSatisfy(
      (error: unknown) =>
        error instanceof VaultFlowClientError &&
        error.step === "prepare" &&
        error.message.includes("deposit_below_minimum")
    );
  });
});
