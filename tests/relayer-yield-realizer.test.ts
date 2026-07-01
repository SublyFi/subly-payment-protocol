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
    const calls: Array<{ url: string; method: string }> = [];
    const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const u = String(url);
      calls.push({ url: u, method: init?.method ?? "GET" });
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
      facilitatorBaseUrl: BASE,
      signer: fakeSigner(),
      rpc: fakeRpc(0n), // empty ATA -> must realize
      fetchImpl: fetchImpl as unknown as typeof fetch,
      lookupTablesFor: async () => ({})
    });

    const result = await realizer.ensureUsdcAvailable({ amountRawUsdc: 10_000n });

    expect(result.txSignature).toBe("realizeSig");
    expect(result.realizedRawUsdc).toBe(10_000n);
    expect(calls.map((c) => c.url)).toEqual([
      `${BASE}/v1/wallets/${WALLET}/budget`,
      `${BASE}/v1/withdrawals/prepare`,
      `${BASE}/v1/withdrawals/submit`
    ]);
  });

  it("skips realize when the ATA already covers the price (idempotency)", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(200, {}));
    const realizer = new RelayerYieldRealizer({
      facilitatorBaseUrl: BASE,
      signer: fakeSigner(),
      rpc: fakeRpc(20_000n), // already funded
      fetchImpl: fetchImpl as unknown as typeof fetch
    });

    const result = await realizer.ensureUsdcAvailable({ amountRawUsdc: 10_000n });
    expect(result).toEqual({ realizedRawUsdc: 0n, txSignature: null });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("refuses when spendable yield cannot cover the shortfall", async () => {
    const fetchImpl = vi.fn(async (url: string | URL | Request) => {
      if (String(url).endsWith("/budget")) {
        return jsonResponse(200, { budget: { spendableYieldRawUsdc: "5000" } });
      }
      throw new Error("should not reach withdrawal endpoints");
    });
    const realizer = new RelayerYieldRealizer({
      facilitatorBaseUrl: BASE,
      signer: fakeSigner(),
      rpc: fakeRpc(0n),
      fetchImpl: fetchImpl as unknown as typeof fetch
    });

    await expect(
      realizer.ensureUsdcAvailable({ amountRawUsdc: 10_000n })
    ).rejects.toMatchObject({ code: "insufficient_yield" });
    expect(fetchImpl).toHaveBeenCalledTimes(1); // budget only
  });

  it("uses the vault USDC mint by default", () => {
    const realizer = new RelayerYieldRealizer({
      facilitatorBaseUrl: BASE,
      signer: fakeSigner(),
      rpc: fakeRpc(0n)
    });
    expect(realizer).toBeInstanceOf(RelayerYieldRealizer);
    expect(SUBLY_VAULT.usdcMint).toMatch(/^EPjF/);
  });
});
