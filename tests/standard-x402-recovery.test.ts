import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SUBLY_VAULT, SOLANA_MAINNET_NETWORK } from "../src/config/constants.js";
import { sha256HexOf } from "../src/lib/canonical-json.js";
import { deriveAssociatedTokenAddress } from "../src/lib/associated-token-account.js";
import { RelayerYieldRealizer } from "../src/client/relayer-yield-realizer.js";
import { fileStandardX402StateStore } from "../src/client/standard-x402-state-store.js";
import { StandardX402Payer, type StandardX402PendingPaymentRecord, type StandardX402StateStore } from "../src/client/standard-x402-payer.js";
import type { AgentWalletSigner } from "../src/client/agent-wallet-signer.js";
import { previewRpc } from "./helpers/withdrawal-preview.js";

const WALLET = "GPqt7ksu6LoKAx7PXEDb54bjrN5fs9R61TkzyL5X3H1M";
const BASE = "https://relayer.invalid";
const URL = "https://seller.invalid/jobs";
const PAY_TO = "J7ZvJEspvwP1oRxQZ7mYmNmT22NTm3GWq3t7HEbvPZYx";
const FEE_PAYER = "2wKupLR9q6wXYppw8Gr2NvWxKBUqm4PPJKkQfoxHDBg4";
const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "subly-recovery-")); dirs.push(directory);
  const path = join(directory, "pending.json");
  const disk = fileStandardX402StateStore(path);
  let failSave: (records: StandardX402PendingPaymentRecord[]) => boolean = () => false;
  const store = (): StandardX402StateStore => ({ ...fileStandardX402StateStore(path), save(records) {
    if (failSave(records)) throw new Error("disk full");
    disk.save(records);
  } });
  const payment = { payTo: PAY_TO, amountRawUsdc: "10000", resourceUrlHash: sha256HexOf(URL), method: "POST" };
  const prepared = {
    withdrawalId: "wdr_original", wallet: WALLET, vault: SUBLY_VAULT.address,
    requestedWithdrawRawUsdc: "10000", purpose: "yield_realize", paymentBinding: payment,
    serializedTransaction: "original-prepared-transaction", preparedMessageHash: "original-message-hash",
    destinationUsdcAta: deriveAssociatedTokenAddress({ owner: WALLET, mint: SUBLY_VAULT.usdcMint }),
    signingIntent: { wallet: WALLET, vault: SUBLY_VAULT.address, farm: SUBLY_VAULT.farm,
      shareMint: SUBLY_VAULT.shareMint, asset: SUBLY_VAULT.usdcMint,
      destinationUsdcAta: deriveAssociatedTokenAddress({ owner: WALLET, mint: SUBLY_VAULT.usdcMint }),
      maxSharesToRedeemRaw: "11000", allowFullExit: false, feePayer: FEE_PAYER,
      expiresAt: new Date(Date.now() + 60_000).toISOString(), preparedMessageHash: "original-message-hash" }
  };
  let status = "confirmed";
  let loseSubmitResponse = false;
  let requireApproval = false;
  let readOverride: Record<string, unknown> = {};
  const calls: string[] = [];
  const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const route = new globalThis.URL(String(url)).pathname;
    calls.push(route);
    if (route.endsWith("/sync")) return json({});
    if (route.endsWith("/budget")) return json({ budget: { spendableYieldRawUsdc: "1000000" } });
    if (route.endsWith("/prepare")) {
      if (requireApproval && !(JSON.parse(String(init?.body)) as {approvalId?: string}).approvalId) {
        return json({ error: { code: "approval_required", details: { approvalId: "apr_test", approveUrl: "https://owner.invalid" } } }, 409);
      }
      return json(prepared);
    }
    if (route.endsWith("/submit")) {
      expect(JSON.parse(String(init?.body))).toMatchObject({ withdrawalId: "wdr_original" });
      if (loseSubmitResponse) throw new Error("response lost after submission");
      return json({ ...prepared, status, txSignature: "original-realize-signature", actualWithdrawRawUsdc: "10000" });
    }
    if (route === "/v1/withdrawals/wdr_original") {
      return json({ ...prepared, status, txSignature: "original-realize-signature", actualWithdrawRawUsdc: "10000", ...readOverride });
    }
    throw new Error(`Unexpected request: ${route}`);
  });
  const signer = { walletAddress: WALLET, validationMode: "structured_intent_transaction",
    signWithdrawal: vi.fn(async () => ({ serializedTransaction: "signed-original", agentSignature: "agent-signature" })),
    signPayment: vi.fn(), signDeposit: vi.fn(), signApiMessage: vi.fn(async () => "auth-signature")
  } satisfies AgentWalletSigner;
  const rpc = previewRpc(WALLET, 10_000n);
  const simulate = vi.spyOn(rpc, "simulateTransaction");
  const realizer = new RelayerYieldRealizer({ relayerBaseUrl: BASE, signer, rpc,
    fetchImpl: fetchImpl as typeof fetch, lookupTablesFor: async () => ({}) });
  const requirement = { scheme: "exact", network: SOLANA_MAINNET_NETWORK,
    asset: SUBLY_VAULT.usdcMint, amount: "10000", payTo: PAY_TO, maxTimeoutSeconds: 300, extra: { feePayer: FEE_PAYER } };
  const probeFetch = vi.fn(async () => json({ x402Version: 2, accepts: [requirement] }, 402));
  const x402Fetch = vi.fn(async () => new Response("delivered", { status: 200 }));
  const payer = (funding = realizer) => new StandardX402Payer({ realizer: funding, probeFetch, x402Fetch,
    stateStore: store(), defaultMaxAmountRawUsdc: 10_000n });
  const input = { url: URL, method: "POST", body: '{"task":"private request"}', headers: { authorization: "Bearer secret-api-key" } };
  return { path, disk, calls, signer, simulate, realizer, requirement, probeFetch, x402Fetch, payer, input,
    failSaves: (predicate: typeof failSave) => { failSave = predicate; },
    loseSubmit: (lose: boolean) => { loseSubmitResponse = lose; },
    serverStatus: (value: string) => { status = value; },
    approval: () => { requireApproval = true; },
    overrideRead: (value: Record<string, unknown>) => { readOverride = value; } };
}

describe("durable realization recovery", () => {
  it("reconciles a submitted withdrawal across restart and pays from its original confirmation", async () => {
    const f = fixture(); f.loseSubmit(true); f.serverStatus("submitted");
    await expect(f.payer().pay(f.input)).rejects.toMatchObject({ reason: "payment_outcome_unknown" });
    expect(f.disk.load()[0]).toMatchObject({ status: "realizing", recovery: { prepared: { withdrawalId: "wdr_original" } } });
    await expect(f.payer().pay({ ...f.input, forceNewPayment: true })).rejects.toMatchObject({ reason: "payment_outcome_unknown" });
    f.serverStatus("confirmed");
    expect((await f.payer().pay(f.input)).paid).toBe(true);
    expect(f.calls.filter(p => p.endsWith("/prepare"))).toHaveLength(1);
    expect(f.calls.filter(p => p.endsWith("/submit"))).toHaveLength(1);
    expect(f.calls.filter(p => p.endsWith("/sync"))).toHaveLength(1);
    expect(f.calls.filter(p => p.endsWith("/budget"))).toHaveLength(1);
    expect(f.signer.signWithdrawal).toHaveBeenCalledTimes(1);
    expect(f.x402Fetch).toHaveBeenCalledTimes(1);
    expect(f.disk.load()).toEqual([]);
  });

  it("does nothing financial when the initial durable marker cannot be saved", async () => {
    const f = fixture(); f.failSaves(() => true);
    await expect(f.payer().pay(f.input)).rejects.toMatchObject({ reason: "state_persist_failed" });
    expect(f.calls).toEqual([]); expect(f.x402Fetch).not.toHaveBeenCalled();
  });

  it("does not sign or submit if saving the prepared ID fails, and force cannot discard the interruption", async () => {
    const f = fixture(); f.failSaves(records => records[0]?.recovery?.prepared !== undefined);
    await expect(f.payer().pay(f.input)).rejects.toMatchObject({ reason: "state_persist_failed" });
    expect(f.signer.signWithdrawal).not.toHaveBeenCalled();
    expect(f.calls.filter(p => p.endsWith("/submit"))).toEqual([]);
    f.failSaves(() => false);
    await expect(f.payer().pay({ ...f.input, forceNewPayment: true })).rejects.toMatchObject({ reason: "payment_outcome_unknown" });
    expect(f.calls.filter(p => p.endsWith("/prepare"))).toHaveLength(1);
  });

  it.each(["realized", "external_outcome_unknown"] as const)("recovers a save failure at %s without another withdrawal", async (stage) => {
    const f = fixture(); f.failSaves(records => records[0]?.status === stage);
    await expect(f.payer().pay(f.input)).rejects.toMatchObject({ reason: "state_persist_failed" });
    expect(f.x402Fetch).not.toHaveBeenCalled();
    expect(f.disk.load()[0]?.recovery?.prepared?.withdrawalId).toBe("wdr_original");
    f.failSaves(() => false);
    expect((await f.payer().pay(f.input)).paid).toBe(true);
    expect(f.calls.filter(p => p.endsWith("/prepare"))).toHaveLength(1);
    expect(f.calls.filter(p => p.endsWith("/submit"))).toHaveLength(1);
    expect(f.x402Fetch).toHaveBeenCalledTimes(1);
  });

  it("re-previews and re-signs only the original prepared transaction after a lost submit", async () => {
    const f = fixture(); f.loseSubmit(true); f.serverStatus("prepared");
    await expect(f.payer().pay(f.input)).rejects.toMatchObject({ reason: "payment_outcome_unknown" });
    f.loseSubmit(false);
    // The first reconciliation reads prepared, and the original submit confirms.
    f.overrideRead({ status: "prepared" }); f.serverStatus("confirmed");
    expect((await f.payer().pay(f.input)).paid).toBe(true);
    expect(f.calls.filter(p => p.endsWith("/prepare"))).toHaveLength(1);
    expect(f.signer.signWithdrawal).toHaveBeenCalledTimes(2);
    expect(f.simulate).toHaveBeenCalledTimes(2);
    expect(f.x402Fetch).toHaveBeenCalledTimes(1);
  });

  it("retains the external-attempt barrier when delivery fails after recovered confirmation", async () => {
    const f = fixture(); f.loseSubmit(true);
    await expect(f.payer().pay(f.input)).rejects.toMatchObject({ reason: "payment_outcome_unknown" });
    f.x402Fetch.mockRejectedValueOnce(new Error("merchant delivery lost"));
    await expect(f.payer().pay(f.input)).rejects.toMatchObject({ reason: "payment_outcome_unknown" });
    const calls = f.calls.length; const probes = f.probeFetch.mock.calls.length;
    await expect(f.payer().pay(f.input)).rejects.toMatchObject({ reason: "payment_outcome_unknown" });
    expect(f.calls).toHaveLength(calls); expect(f.probeFetch).toHaveBeenCalledTimes(probes);
    expect(f.x402Fetch).toHaveBeenCalledTimes(1);
  });

  it("clears a proven approval-before-submission refusal for a clean approved retry", async () => {
    const f = fixture(); f.approval();
    await expect(f.payer().pay(f.input)).rejects.toMatchObject({ reason: "approval_required", detail: { approvalId: "apr_test" } });
    expect(f.disk.load()).toEqual([]); expect(f.signer.signWithdrawal).not.toHaveBeenCalled();
    expect((await f.payer().pay({ ...f.input, approvalId: "apr_test" })).paid).toBe(true);
  });

  it.each(["wallet", "vault", "relayerBaseUrl"] as const)("refuses recovery under another %s even with forceNewPayment", async (field) => {
    const f = fixture(); f.loseSubmit(true);
    await expect(f.payer().pay(f.input)).rejects.toMatchObject({ reason: "payment_outcome_unknown" });
    const changed = Object.create(f.realizer) as RelayerYieldRealizer;
    Object.defineProperty(changed, "realizationContext", { value: { ...f.realizer.realizationContext, [field]: "different" } });
    const calls = f.calls.length;
    await expect(f.payer(changed).pay({ ...f.input, forceNewPayment: true })).rejects.toMatchObject({ reason: "payment_outcome_unknown" });
    expect(f.calls).toHaveLength(calls); expect(f.x402Fetch).not.toHaveBeenCalled();
  });

  it("binds request headers and the exact challenge without storing request credentials/body", async () => {
    const f = fixture(); f.loseSubmit(true);
    await expect(f.payer().pay(f.input)).rejects.toMatchObject({ reason: "payment_outcome_unknown" });
    const saved = readFileSync(f.path, "utf8");
    expect(saved).not.toContain("secret-api-key"); expect(saved).not.toContain("private request");
    await expect(f.payer().pay({ ...f.input, headers: { authorization: "Bearer different" } })).rejects.toMatchObject({ reason: "payment_outcome_unknown" });
    f.requirement.amount = "9000";
    await expect(f.payer().pay(f.input)).rejects.toMatchObject({ reason: "payment_outcome_unknown" });
    expect(f.calls.filter(p => p.startsWith("/v1/withdrawals/wdr_"))).toHaveLength(0);
    expect(f.x402Fetch).not.toHaveBeenCalled();
  });

  it("exposes reconciliation IDs but keeps signing material out of CLI/MCP errors", async () => {
    const f = fixture(); f.loseSubmit(true);
    const error = await f.payer().pay(f.input).catch(error => error);
    expect(error.detail.pendingPayment.withdrawalId).toBe("wdr_original");
    expect(JSON.stringify(error)).not.toContain("original-prepared-transaction");
    expect(JSON.stringify(error)).not.toContain("signingIntent");
    expect(readFileSync(f.path, "utf8")).toContain("original-prepared-transaction");
  });

  it.each([{ wallet: FEE_PAYER }, { vault: FEE_PAYER }, { purpose: "normal" },
    { requestedWithdrawRawUsdc: "9999" }, { paymentBinding: null }, { serializedTransaction: "different" }])(
    "rejects an incompatible same-ID reconciliation response %j", async (changed) => {
      const f = fixture(); f.loseSubmit(true);
      await expect(f.payer().pay(f.input)).rejects.toMatchObject({ reason: "payment_outcome_unknown" });
      f.overrideRead(changed);
      await expect(f.payer().pay(f.input)).rejects.toMatchObject({ reason: "payment_outcome_unknown" });
      expect(f.x402Fetch).not.toHaveBeenCalled(); expect(f.signer.signWithdrawal).toHaveBeenCalledTimes(1);
    });

  it("keeps older realized records refusal-only", async () => {
    const f = fixture(); f.failSaves(records => records[0]?.status === "external_outcome_unknown");
    await expect(f.payer().pay(f.input)).rejects.toMatchObject({ reason: "state_persist_failed" });
    const legacy = f.disk.load(); delete legacy[0]!.recovery; f.disk.save(legacy);
    await expect(f.payer().pay(f.input)).rejects.toMatchObject({ reason: "payment_outcome_unknown" });
    expect(f.x402Fetch).not.toHaveBeenCalled();
  });

  it.each([{}, { version: 1, context: {} }, { version: 7 }])("rejects malformed persisted recovery envelopes %j", async recovery => {
    const f = fixture(); f.loseSubmit(true);
    await expect(f.payer().pay(f.input)).rejects.toMatchObject({ reason: "payment_outcome_unknown" });
    const records = f.disk.load();
    writeFileSync(f.path, JSON.stringify([{ ...records[0], recovery }]));
    expect(() => f.payer()).toThrow("invalid record");
  });

  it("rejects corrupt recovered amounts and duplicate request keys before recovery", async () => {
    const f = fixture(); f.loseSubmit(true);
    await expect(f.payer().pay(f.input)).rejects.toMatchObject({ reason: "payment_outcome_unknown" });
    const records = f.disk.load();
    writeFileSync(f.path, JSON.stringify([{ ...records[0], realizedRawUsdc: "not-an-amount" }]));
    expect(() => f.payer()).toThrow("invalid record");
    writeFileSync(f.path, JSON.stringify([records[0], records[0]]));
    expect(() => f.payer()).toThrow("duplicate request keys");
  });
});
