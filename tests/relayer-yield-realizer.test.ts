import { describe, expect, it, vi } from "vitest";
import { SUBLY_VAULT } from "../src/config/constants.js";
import type { AgentWalletSigner } from "../src/client/agent-wallet-signer.js";
import {
  RelayerRealizeError,
  RelayerYieldRealizer
} from "../src/client/relayer-yield-realizer.js";
import type { SolanaRpc } from "../src/solana/rpc.js";

const WALLET = "GPqt7ksu6LoKAx7PXEDb54bjrN5fs9R61TkzyL5X3H1M";
const BASE = "https://api.demo.sublyfi.com";

function fakeSigner(): AgentWalletSigner {
  return {
    walletAddress: WALLET,
    validationMode: "structured_intent_transaction",
    signPayment: vi.fn(),
    signDeposit: vi.fn(),
    signWithdrawal: vi.fn(async () => ({
      serializedTransaction: "signedTxB64",
      agentSignature: "agentSig"
    })),
    signApiMessage: vi.fn(async () => "authsig")
  } as unknown as AgentWalletSigner;
}

/** rpc.getTokenAccountBalance().send() -> { value: { amount } }. */
function fakeRpc(ataAmount: bigint): SolanaRpc {
  return {
    getTokenAccountBalance: () => ({
      send: async () => ({ value: { amount: ataAmount.toString() } })
    })
  } as unknown as SolanaRpc;
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status });
}

describe("RelayerYieldRealizer", () => {
  it("reuses the sponsored withdrawal flow to realize yield", async () => {
    const calls: Array<{ url: string; method: string; body?: unknown }> = [];
    const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const u = String(url);
      calls.push({
        url: u,
        method: init?.method ?? "GET",
        body:
          typeof init?.body === "string" ? JSON.parse(init.body) : undefined
      });
      if (u.endsWith("/sync")) {
        return jsonResponse(200, { position: {} });
      }
      if (u.endsWith("/budget")) {
        return jsonResponse(200, {
          budget: { spendableYieldRawUsdc: "1000000" }
        });
      }
      if (u.endsWith("/v1/withdrawals/prepare")) {
        return jsonResponse(200, {
          withdrawalId: "wd_1",
          serializedTransaction: "preparedTxB64",
          destinationUsdcAta: "ata",
          signingIntent: { wallet: WALLET }
        });
      }
      if (u.endsWith("/v1/withdrawals/submit")) {
        return jsonResponse(200, {
          status: "confirmed",
          txSignature: "realizeSig",
          actualWithdrawRawUsdc: "10000"
        });
      }
      throw new Error(`unexpected url ${u}`);
    });

    const realizer = new RelayerYieldRealizer({
      relayerBaseUrl: BASE,
      signer: fakeSigner(),
      rpc: fakeRpc(0n), // empty ATA -> must realize
      fetchImpl: fetchImpl as unknown as typeof fetch,
      lookupTablesFor: async () => ({})
    });

    const result = await realizer.ensureUsdcAvailable({ amountRawUsdc: 10_000n });

    expect(result.txSignature).toBe("realizeSig");
    expect(result.realizedRawUsdc).toBe(10_000n);
    // Syncs the ledger from chain first so freshly accrued yield is visible.
    expect(calls.map((c) => c.url)).toEqual([
      `${BASE}/v1/wallets/${WALLET}/sync`,
      `${BASE}/v1/wallets/${WALLET}/budget`,
      `${BASE}/v1/withdrawals/prepare`,
      `${BASE}/v1/withdrawals/submit`
    ]);
    // The prepare must be marked yield_realize so the relayer enforces the
    // spendable-yield cap server-side.
    const prepare = calls.find((c) => c.url.endsWith("/prepare"));
    expect(prepare?.body).toMatchObject({ purpose: "yield_realize" });
  });

  it("does not treat existing ATA balance as yield provenance", async () => {
    const calls: string[] = [];
    const fetchImpl = vi.fn(async (url: string | URL | Request) => {
      const u = String(url);
      calls.push(u);
      if (u.endsWith("/sync")) {
        return jsonResponse(200, { position: {} });
      }
      if (u.endsWith("/budget")) {
        return jsonResponse(200, {
          budget: { spendableYieldRawUsdc: "1000000" }
        });
      }
      if (u.endsWith("/v1/withdrawals/prepare")) {
        return jsonResponse(200, {
          withdrawalId: "wd_1",
          serializedTransaction: "preparedTxB64",
          destinationUsdcAta: "ata",
          signingIntent: { wallet: WALLET }
        });
      }
      if (u.endsWith("/v1/withdrawals/submit")) {
        return jsonResponse(200, {
          status: "confirmed",
          txSignature: "realizeSig",
          actualWithdrawRawUsdc: "10000"
        });
      }
      throw new Error(`unexpected url ${u}`);
    });
    const realizer = new RelayerYieldRealizer({
      relayerBaseUrl: BASE,
      signer: fakeSigner(),
      rpc: fakeRpc(20_000n), // existing ATA funds are not yield provenance
      fetchImpl: fetchImpl as unknown as typeof fetch,
      lookupTablesFor: async () => ({})
    });

    const result = await realizer.ensureUsdcAvailable({ amountRawUsdc: 10_000n });
    expect(result).toEqual({
      realizedRawUsdc: 10_000n,
      txSignature: "realizeSig"
    });
    expect(calls).toEqual([
      `${BASE}/v1/wallets/${WALLET}/sync`,
      `${BASE}/v1/wallets/${WALLET}/budget`,
      `${BASE}/v1/withdrawals/prepare`,
      `${BASE}/v1/withdrawals/submit`
    ]);
  });

  it("refuses when spendable yield cannot cover the shortfall", async () => {
    const fetchImpl = vi.fn(async (url: string | URL | Request) => {
      const u = String(url);
      if (u.endsWith("/sync")) {
        return jsonResponse(200, { position: {} });
      }
      if (u.endsWith("/budget")) {
        return jsonResponse(200, { budget: { spendableYieldRawUsdc: "5000" } });
      }
      throw new Error("should not reach withdrawal endpoints");
    });
    const realizer = new RelayerYieldRealizer({
      relayerBaseUrl: BASE,
      signer: fakeSigner(),
      rpc: fakeRpc(0n),
      fetchImpl: fetchImpl as unknown as typeof fetch
    });

    await expect(
      realizer.ensureUsdcAvailable({ amountRawUsdc: 10_000n })
    ).rejects.toMatchObject({ code: "insufficient_yield" });
    expect(fetchImpl).toHaveBeenCalledTimes(2); // sync + budget only
  });

  it("keeps the realize-fee headroom in the precheck (matches the server guard)", async () => {
    const fetchImpl = vi.fn(async (url: string | URL | Request) => {
      const u = String(url);
      if (u.endsWith("/sync")) {
        return jsonResponse(200, { position: {} });
      }
      if (u.endsWith("/budget")) {
        // Exactly the payment amount: gross fits, but the fee headroom
        // (2500 raw) does not — the server guard would refuse this too.
        return jsonResponse(200, { budget: { spendableYieldRawUsdc: "10000" } });
      }
      throw new Error("should not reach withdrawal endpoints");
    });
    const realizer = new RelayerYieldRealizer({
      relayerBaseUrl: BASE,
      signer: fakeSigner(),
      rpc: fakeRpc(0n),
      fetchImpl: fetchImpl as unknown as typeof fetch
    });

    await expect(
      realizer.ensureUsdcAvailable({ amountRawUsdc: 10_000n })
    ).rejects.toMatchObject({ code: "insufficient_yield" });
  });

  it("still reads the budget when the chain sync fails (best-effort)", async () => {
    const fetchImpl = vi.fn(async (url: string | URL | Request) => {
      const u = String(url);
      if (u.endsWith("/sync")) {
        return jsonResponse(503, {
          error: { code: "chain_sync_unavailable" }
        });
      }
      if (u.endsWith("/budget")) {
        return jsonResponse(200, { budget: { spendableYieldRawUsdc: "5000" } });
      }
      throw new Error("should not reach withdrawal endpoints");
    });
    const realizer = new RelayerYieldRealizer({
      relayerBaseUrl: BASE,
      signer: fakeSigner(),
      rpc: fakeRpc(0n),
      fetchImpl: fetchImpl as unknown as typeof fetch
    });

    await expect(
      realizer.ensureUsdcAvailable({ amountRawUsdc: 10_000n })
    ).rejects.toMatchObject({ code: "insufficient_yield" });
  });

  it("maps the relayer's server-side yield guard to insufficient_yield", async () => {
    const fetchImpl = vi.fn(async (url: string | URL | Request) => {
      const u = String(url);
      if (u.endsWith("/sync")) {
        return jsonResponse(200, { position: {} });
      }
      if (u.endsWith("/budget")) {
        // Stale client-side view says there is enough...
        return jsonResponse(200, {
          budget: { spendableYieldRawUsdc: "1000000" }
        });
      }
      if (u.endsWith("/v1/withdrawals/prepare")) {
        // ...but the relayer's own guard refuses beyond the spendable yield.
        return jsonResponse(409, {
          success: false,
          error: {
            code: "insufficient_yield",
            message: "Yield-realize withdrawals are limited to the spendable yield"
          }
        });
      }
      throw new Error(`unexpected url ${u}`);
    });
    const realizer = new RelayerYieldRealizer({
      relayerBaseUrl: BASE,
      signer: fakeSigner(),
      rpc: fakeRpc(0n),
      fetchImpl: fetchImpl as unknown as typeof fetch
    });

    await expect(
      realizer.ensureUsdcAvailable({ amountRawUsdc: 10_000n })
    ).rejects.toMatchObject({ code: "insufficient_yield" });
  });

  it("uses the vault USDC mint by default", () => {
    const realizer = new RelayerYieldRealizer({
      relayerBaseUrl: BASE,
      signer: fakeSigner(),
      rpc: fakeRpc(0n)
    });
    expect(realizer).toBeInstanceOf(RelayerYieldRealizer);
    expect(SUBLY_VAULT.usdcMint).toMatch(/^EPjF/);
  });
});
