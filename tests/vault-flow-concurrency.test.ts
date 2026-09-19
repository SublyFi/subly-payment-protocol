import { blockhash, generateKeyPairSigner } from "@solana/kit";
import { getAddMemoInstruction } from "@solana-program/memo";
import { afterEach, describe, expect, it, vi } from "vitest";
import { RATE_SCALE, SUBLY_VAULT } from "../src/config/constants.js";
import { InMemoryLedger } from "../src/domain/ledger.js";
import type { DepositIntent, WithdrawalIntent } from "../src/domain/models.js";
import type { SpendingMandateService } from "../src/domain/spending-mandate-service.js";
import { pendingVaultFlows, VaultFlowService } from "../src/domain/vault-flow-service.js";
import type { KaminoVaultAdapter } from "../src/kamino/vault-adapter.js";
import { deriveAssociatedTokenAddress } from "../src/lib/associated-token-account.js";
import type { TransactionLookupResult, TransactionSubmissionEngine } from "../src/solana/submission.js";
import { addSignaturesToSerializedTransaction, buildVersionedTransaction, signatureBase58ForSigner } from "../src/solana/tx.js";

afterEach(() => vi.restoreAllMocks());

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

type Kind = "deposit" | "withdrawal";
type Simulation = Awaited<ReturnType<TransactionSubmissionEngine["simulateSignedTransaction"]>>;
const failedSimulation: Simulation = { err: { InstructionError: [0, "AlreadyProcessed"] }, logs: null };

async function harness(kind: Kind, mandates?: SpendingMandateService) {
  const signer = await generateKeyPairSigner();
  const wallet = signer.address;
  const ledger = new InMemoryLedger();
  const ata = deriveAssociatedTokenAddress({ owner: wallet, mint: SUBLY_VAULT.usdcMint });
  const amount = kind === "deposit" ? 2_000_000n : 500_000n;
  const shareDelta = kind === "deposit" ? amount : -amount;
  const built = await buildVersionedTransaction({
    feePayer: wallet,
    blockhash: blockhash("GHtnjzoaqLgzJZ4XTQr5ChCAPGJmCEqVMG6gRGoiTLDv"),
    lastValidBlockHeight: 1000n,
    instructions: [getAddMemoInstruction({ memo: "offline concurrency fixture" })]
  });
  const signed = await addSignaturesToSerializedTransaction({
    serializedBase64: built.serializedBase64, signers: [signer.keyPair]
  });
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
    preparedMessageHash: built.messageHash, recentBlockhash: "fixture", lastValidBlockHeight: 1000,
    serializedTransaction: built.serializedBase64, txSignature: null, submittedSerializedTransaction: null,
    principalBasisBeforeRawUsdc: 100_000_000n, principalBasisAfterRawUsdc: null,
    status: "prepared" as const, expiresAt: new Date(Date.now() + 60_000).toISOString(),
    submittedAt: null, terminalAt: null, errorCode: null
  };
  if (kind === "deposit") {
    ledger.saveDeposit({ ...common, depositId: "dep_race", amountRawUsdc: amount, actualDepositRawUsdc: null, sharesMintedRaw: null });
  } else {
    ledger.saveWithdrawal({
      ...common, withdrawalId: "wdr_race", purpose: "yield_realize", paymentBinding: null,
      paymentTxSignature: null, paymentVerification: "unreported", requestedWithdrawRawUsdc: amount,
      requestedSharesRaw: amount, maxSharesToRedeemRaw: amount, destinationUsdcAta: ata,
      actualSharesBurnedRaw: null, actualWithdrawRawUsdc: null, liquidityRejectionReason: null
    });
  }
  const state = { landed: false, expired: false };
  const engine = {
    simulateSignedTransaction: vi.fn(async (): Promise<Simulation> => failedSimulation),
    sendSignedTransaction: vi.fn(async () => signatureBase58ForSigner(signed.transaction, wallet)!),
    waitForConfirmation: vi.fn(async () => ({ status: "timeout" as const })),
    isBlockhashExpired: vi.fn(async () => state.expired),
    lookupTransaction: vi.fn(async (): Promise<TransactionLookupResult> => state.landed ? {
      found: true, err: null, feeLamports: 0n, slot: 2n,
      tokenBalanceDeltas: new Map([[ata, -shareDelta]])
    } : { found: false })
  };
  const adapter = {
    vaultAddress: SUBLY_VAULT.address,
    loadContext: async () => ({ slot: 2n, exchangeRateScaled: RATE_SCALE, instantRedeemCapacityRawUsdc: 100_000_000n }),
    getUserSharesRaw: async () => ({
      stakedSharesRaw: 0n, unstakedSharesRaw: 101_000_000n + shareDelta,
      totalSharesRaw: 101_000_000n + shareDelta, sharesAtaAddress: wallet, sharesAtaExists: true
    })
  } as unknown as KaminoVaultAdapter;
  const service = new VaultFlowService({
    ledger, adapter, engine: engine as unknown as TransactionSubmissionEngine, sponsor: signer,
    ...(mandates ? { mandates } : {})
  });
  const input = { serializedTransaction: signed.serializedBase64, agentSignature: signatureBase58ForSigner(signed.transaction, wallet)! };
  const submit = () => kind === "deposit"
    ? service.submitDeposit({ ...input, depositId: "dep_race" })
    : service.submitWithdrawal({ ...input, withdrawalId: "wdr_race" });
  const status = (resubmit = false) => kind === "deposit"
    ? service.getDeposit("dep_race", { resubmit })
    : service.getWithdrawal("wdr_race", { resubmit });
  const stored = () => (kind === "deposit" ? ledger.getDeposit("dep_race") : ledger.getWithdrawal("wdr_race"))!;
  const pending = () => pendingVaultFlows(ledger, wallet, SUBLY_VAULT.address);
  const events = () => ledger.listSyncEvents(wallet, SUBLY_VAULT.address);
  function pauseSimulation() {
    const entered = deferred<void>();
    const result = deferred<Simulation>();
    engine.simulateSignedTransaction.mockImplementationOnce(async () => {
      entered.resolve();
      return result.promise;
    });
    return { entered: entered.promise, finish: () => result.resolve(failedSimulation) };
  }
  return { ledger, wallet, amount, engine, state, submit, status, stored, pending, events, pauseSimulation };
}

for (const kind of ["deposit", "withdrawal"] as const) {
  describe(`${kind} concurrent recovery`, () => {
    it("preserves a confirmed receipt when recovery broadcasts before the initial simulation fails", async () => {
      const h = await harness(kind);
      const simulation = h.pauseSimulation();
      const submitting = h.submit();
      await simulation.entered;
      expect(h.engine.sendSignedTransaction).not.toHaveBeenCalled();
      expect((await h.status(true)).status).toBe("submitted");
      expect(h.engine.sendSignedTransaction).toHaveBeenCalledExactlyOnceWith(h.stored().submittedSerializedTransaction);
      h.state.landed = true; // The recovery broadcast is the only source of this receipt.
      expect((await h.status()).status).toBe("confirmed");
      const receipt = h.stored();
      simulation.finish();
      expect((await submitting).status).toBe("confirmed");
      expect(h.stored()).toEqual(receipt);
      expect(h.events()).toHaveLength(1);
      expect(h.engine.sendSignedTransaction).toHaveBeenCalledOnce();
      expect(await h.pending()).toBe(0);
    });

    it("keeps an unindexed broadcast pending after simulation fails and recovers the same transaction", async () => {
      const h = await harness(kind);
      const simulation = h.pauseSimulation();
      const submitting = h.submit();
      await simulation.entered;
      await h.status(true);
      const submitted = h.stored();
      simulation.finish();
      expect((await submitting).status).toBe("submitted");
      expect(h.stored()).toEqual(submitted);
      expect(await h.pending()).toBe(1);
      expect(h.engine.sendSignedTransaction).toHaveBeenCalledOnce();
      await h.status(true);
      expect(h.engine.sendSignedTransaction).toHaveBeenNthCalledWith(2, submitted.submittedSerializedTransaction);
      h.state.landed = true;
      expect((await h.status()).status).toBe("confirmed");
      expect(h.stored().txSignature).toBe(submitted.txSignature);
      expect(h.events()).toHaveLength(1);
    });

    it("does not unlock a simulation refusal until expiry and a final absent receipt establish failure", async () => {
      const h = await harness(kind);
      expect((await h.submit()).status).toBe("submitted");
      expect(h.engine.sendSignedTransaction).not.toHaveBeenCalled();
      expect(await h.pending()).toBe(1);
      h.state.expired = true;
      h.engine.lookupTransaction.mockClear();
      expect(await h.status()).toMatchObject({ status: "failed_not_submitted", errorCode: "blockhash_expired" });
      expect(h.engine.lookupTransaction).toHaveBeenCalledTimes(2);
      expect(await h.pending()).toBe(0);
      expect(h.events()).toHaveLength(0);
    });

    it("checks for a newly indexed receipt after observing blockhash expiry", async () => {
      const h = await harness(kind);
      await h.submit();
      h.engine.isBlockhashExpired.mockImplementationOnce(async () => {
        h.state.landed = true;
        return true;
      });
      expect((await h.status()).status).toBe("confirmed");
      expect(h.events()).toHaveLength(1);
      expect(h.engine.sendSignedTransaction).not.toHaveBeenCalled();
    });

    it.each(["initial submission", "status recovery"] as const)("does not overwrite a confirmed receipt with an older expiry result from %s", async (source) => {
      const h = await harness(kind);
      if (source === "status recovery") await h.submit();
      h.state.expired = true;
      const finalLookup = deferred<TransactionLookupResult>();
      const entered = deferred<void>();
      h.engine.lookupTransaction
        .mockResolvedValueOnce({ found: false })
        .mockImplementationOnce(async () => { entered.resolve(); return finalLookup.promise; });
      const expiring = source === "initial submission" ? h.submit() : h.status();
      await entered.promise;
      h.state.landed = true;
      expect((await h.status()).status).toBe("confirmed");
      const receipt = h.stored();
      finalLookup.resolve({ found: false });
      expect((await expiring).status).toBe("confirmed");
      expect(h.stored()).toEqual(receipt);
      expect(h.events()).toHaveLength(1);
    });

    it("does not expire a stale prepared snapshot after an already-authorized submission commits", async () => {
      const authorizationEntered = deferred<void>();
      const authorize = deferred<void>();
      const mandates = {
        assertPreparedAuthorization: async () => { authorizationEntered.resolve(); await authorize.promise; }
      } as unknown as SpendingMandateService;
      const h = await harness(kind, mandates);
      const simulation = h.pauseSimulation();
      const submitting = h.submit();
      await authorizationEntered.promise;
      vi.spyOn(Date, "now").mockReturnValue(Date.parse(h.stored().expiresAt) + 1);
      const staleRead = h.status();
      // Let status read the prepared snapshot and queue behind the submit lock.
      await Promise.resolve();
      authorize.resolve();
      await simulation.entered;
      expect((await staleRead).status).toBe("submitted");
      expect(h.stored().status).toBe("submitted");
      simulation.finish();
      expect((await submitting).status).toBe("submitted");
      expect(await h.pending()).toBe(1);
    });

    it("keeps incomplete submitted records pending instead of permitting another flow", async () => {
      const h = await harness(kind);
      await h.submit();
      const incomplete = { ...h.stored(), txSignature: null, submittedSerializedTransaction: null };
      if (kind === "deposit") h.ledger.saveDeposit(incomplete as DepositIntent);
      else h.ledger.saveWithdrawal(incomplete as WithdrawalIntent);
      expect((await h.status()).status).toBe("submitted");
      expect(await h.pending()).toBe(1);
      expect(h.engine.sendSignedTransaction).not.toHaveBeenCalled();
    });
  });
}
