import { address } from "@solana/kit";
import bs58 from "bs58";
import nacl from "tweetnacl";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildServer } from "../src/api/server.js";
import { walletAuthMessage } from "../src/api/wallet-auth.js";
import { RATE_SCALE, SUBLY_VAULT } from "../src/config/constants.js";
import { InMemoryLedger } from "../src/domain/ledger.js";
import { SublyService } from "../src/domain/payment-service.js";
import { VaultFlowService } from "../src/domain/vault-flow-service.js";
import type { KaminoVaultAdapter } from "../src/kamino/vault-adapter.js";
import { deriveAssociatedTokenAddress } from "../src/lib/associated-token-account.js";
import type { SolanaRpc } from "../src/solana/rpc.js";
import { TransactionSubmissionEngine } from "../src/solana/submission.js";

const keys = nacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(71));
const wallet = address(bs58.encode(keys.publicKey));
const ata = deriveAssociatedTokenAddress({ owner: wallet, mint: SUBLY_VAULT.usdcMint });
const storedBytes = Buffer.from("already-signed-transaction-fixture").toString("base64");
const servers: ReturnType<typeof buildServer>[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()));
});

function auth(path: string) {
  const signedAtMs = String(Date.now());
  return {
    "x-subly-wallet": wallet,
    "x-subly-signed-at": signedAtMs,
    "x-subly-signature": bs58.encode(nacl.sign.detached(
      walletAuthMessage({ method: "GET", path, rawBody: "", signedAtMs }), keys.secretKey
    ))
  };
}

async function harness(kind: "deposit" | "withdrawal", confirmed = false) {
  const ledger = new InMemoryLedger();
  await ledger.savePosition({
    wallet, vault: SUBLY_VAULT.address,
    signingPolicyId: "fixture", signingMode: "non_interactive",
    signerValidationMode: "structured_intent_transaction", signerProvider: "local_test",
    stakedSharesRaw: 0n, unstakedSharesRaw: 101_000_000n, totalSharesRaw: 101_000_000n,
    exchangeRateScaled: RATE_SCALE, instantRedeemCapacityRawUsdc: 100_000_000n,
    principalBasisRawUsdc: 100_000_000n, principalBasisSource: "kamino_pnl_current",
    reservedRawUsdc: 0n, feeDebtRawUsdc: 0n, safetyBufferRawUsdc: 0n,
    kaminoPositionSnapshot: [], kaminoPnlSnapshot: [], lastSyncedSlot: 1, version: 1, status: "active"
  });
  const common = {
    wallet, vault: SUBLY_VAULT.address,
    policySource: null, mandateHash: null, policyDecision: null, approvalId: null,
    preparedMessageHash: "fixture", recentBlockhash: "fixture", lastValidBlockHeight: 1000,
    serializedTransaction: "unsigned-fixture", txSignature: "stored-signature",
    submittedSerializedTransaction: storedBytes,
    principalBasisBeforeRawUsdc: 100_000_000n, principalBasisAfterRawUsdc: null,
    status: "submitted" as const, expiresAt: new Date(Date.now() + 60_000).toISOString(),
    submittedAt: new Date().toISOString(), terminalAt: null, errorCode: null
  };
  if (kind === "deposit") {
    await ledger.saveDeposit({
      ...common, depositId: "dep_status", amountRawUsdc: 10_000_000n,
      actualDepositRawUsdc: null, sharesMintedRaw: null
    });
  } else {
    await ledger.saveWithdrawal({
      ...common, withdrawalId: "wdr_status", purpose: "yield_realize",
      paymentBinding: null, paymentTxSignature: null, paymentVerification: "unreported",
      requestedWithdrawRawUsdc: 500_000n, requestedSharesRaw: 500_000n,
      maxSharesToRedeemRaw: 500_000n, destinationUsdcAta: ata,
      actualSharesBurnedRaw: null, actualWithdrawRawUsdc: null, liquidityRejectionReason: null
    });
  }
  const getTransaction = vi.fn(() => ({ send: async () => confirmed ? {
    slot: 2n,
    transaction: { message: { accountKeys: [ata] } },
    meta: {
      err: null, fee: 0n,
      preTokenBalances: [{ accountIndex: 0, uiTokenAmount: { amount: "10000000" } }],
      postTokenBalances: [{ accountIndex: 0, uiTokenAmount: { amount: kind === "deposit" ? "0" : "10500000" } }]
    }
  } : null }));
  const getBlockHeight = vi.fn(() => ({ send: async () => 500n }));
  const sendTransaction = vi.fn(() => ({ send: async () => "stored-signature" }));
  const engine = new TransactionSubmissionEngine({
    getTransaction, getBlockHeight, sendTransaction
  } as unknown as SolanaRpc);
  const sendSignedTransaction = vi.spyOn(engine, "sendSignedTransaction");
  const sharesAfter = kind === "deposit" ? 111_000_000n : 100_500_000n;
  const adapter = {
    vaultAddress: SUBLY_VAULT.address,
    loadContext: async () => ({ slot: 2n, exchangeRateScaled: RATE_SCALE, instantRedeemCapacityRawUsdc: 100_000_000n }),
    getUserSharesRaw: async () => ({
      stakedSharesRaw: 0n, unstakedSharesRaw: sharesAfter, totalSharesRaw: sharesAfter,
      sharesAtaAddress: wallet, sharesAtaExists: true
    })
  } as unknown as KaminoVaultAdapter;
  const vaultFlowService = new VaultFlowService({
    ledger, adapter, engine, sponsor: { address: wallet, keyPair: {} } as never
  });
  const server = buildServer(new SublyService({ ledger }), { vaultFlowService, apiRatePerMinute: 0 });
  servers.push(server);
  const path = kind === "deposit" ? "/v1/deposits/dep_status" : "/v1/withdrawals/wdr_status";
  return { server, path, ledger, getTransaction, getBlockHeight, sendTransaction, sendSignedTransaction };
}

for (const kind of ["deposit", "withdrawal"] as const) {
  describe(`${kind} status reconciliation`, () => {
    it("does not rebroadcast a pending transaction with resubmit=false", async () => {
      const h = await harness(kind);
      const path = `${h.path}?resubmit=false`;
      const response = await h.server.inject({ method: "GET", url: path, headers: auth(path) });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({ status: "submitted", txSignature: "stored-signature" });
      expect(h.getTransaction).toHaveBeenCalledOnce();
      expect(h.getBlockHeight).toHaveBeenCalledOnce();
      expect(h.sendSignedTransaction).not.toHaveBeenCalled();
      expect(h.sendTransaction).not.toHaveBeenCalled();
      expect((await h.ledger.getPosition(wallet, SUBLY_VAULT.address))?.version).toBe(1);
    });

    it.each(["", "?resubmit=true"])("retains stored-byte recovery for '%s'", async (query) => {
      const h = await harness(kind);
      const path = `${h.path}${query}`;
      const response = await h.server.inject({ method: "GET", url: path, headers: auth(path) });
      expect(response.statusCode).toBe(200);
      expect(response.json().status).toBe("submitted");
      expect(h.sendSignedTransaction).toHaveBeenCalledExactlyOnceWith(storedBytes);
      expect(h.sendTransaction).toHaveBeenCalledExactlyOnceWith(storedBytes, {
        encoding: "base64", skipPreflight: true, maxRetries: 3n
      });
    });

    it("finalizes a confirmed receipt once with resubmit=false", async () => {
      const h = await harness(kind, true);
      const path = `${h.path}?resubmit=false`;
      for (let attempt = 0; attempt < 2; attempt++) {
        const response = await h.server.inject({ method: "GET", url: path, headers: auth(path) });
        expect(response.statusCode).toBe(200);
        expect(response.json()).toMatchObject({
          status: "confirmed", principalBasisAfterRawUsdc: kind === "deposit" ? "110000000" : "100000000"
        });
      }
      expect(h.getTransaction).toHaveBeenCalledOnce();
      expect(h.sendSignedTransaction).not.toHaveBeenCalled();
      expect(h.sendTransaction).not.toHaveBeenCalled();
      expect((await h.ledger.getPosition(wallet, SUBLY_VAULT.address))?.version).toBe(2);
      expect(await h.ledger.listSyncEvents(wallet, SUBLY_VAULT.address)).toHaveLength(1);
    });

    it("rejects unknown, invalid and duplicate query flags before reconciliation", async () => {
      const h = await harness(kind);
      for (const query of ["?resubmit=0", "?resubmit=FALSE", "?resubmit=", "?readonly=true", "?resubmit=false&unknown=true", "?resubmit=false&resubmit=true"]) {
        const path = `${h.path}${query}`;
        const response = await h.server.inject({ method: "GET", url: path, headers: auth(path) });
        expect(response.statusCode, query).toBe(400);
      }
      expect(h.getTransaction).not.toHaveBeenCalled();
      expect(h.sendTransaction).not.toHaveBeenCalled();
    });

    it("requires the wallet signature to cover the resubmit query", async () => {
      const h = await harness(kind);
      const response = await h.server.inject({
        method: "GET", url: `${h.path}?resubmit=false`, headers: auth(h.path)
      });
      expect(response.statusCode).toBe(401);
      expect(h.getTransaction).not.toHaveBeenCalled();
      expect(h.sendTransaction).not.toHaveBeenCalled();
    });
  });
}
