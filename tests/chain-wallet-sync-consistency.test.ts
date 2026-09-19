import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { address } from "@solana/kit";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RATE_SCALE, SUBLY_VAULT } from "../src/config/constants.js";
import { ChainWalletSyncService } from "../src/domain/chain-wallet-sync.js";
import { InMemoryLedger, type Ledger } from "../src/domain/ledger.js";
import type { DepositIntent, WithdrawalIntent } from "../src/domain/models.js";
import { SublyService } from "../src/domain/payment-service.js";
import { PostgresLedger } from "../src/domain/postgres-ledger.js";
import { VaultFlowService } from "../src/domain/vault-flow-service.js";
import type { KaminoVaultAdapter, UserSharesRaw, VaultContext } from "../src/kamino/vault-adapter.js";
import { deriveAssociatedTokenAddress } from "../src/lib/associated-token-account.js";
import type { TransactionSubmissionEngine } from "../src/solana/submission.js";

const WALLET = address("11111111111111111111111111111111");
const VAULT = SUBLY_VAULT.address;
const ATA = deriveAssociatedTokenAddress({ owner: WALLET, mint: SUBLY_VAULT.usdcMint });
const connectionString = process.env.SUBLY_TEST_POSTGRES_URL;

function shares(totalSharesRaw: bigint): UserSharesRaw {
  return {
    totalSharesRaw,
    stakedSharesRaw: 0n,
    unstakedSharesRaw: totalSharesRaw,
    sharesAtaAddress: WALLET,
    sharesAtaExists: true
  };
}

function submittedFlowFields() {
  return {
    wallet: WALLET,
    vault: VAULT,
    policySource: null,
    mandateHash: null,
    policyDecision: null,
    approvalId: null,
    preparedMessageHash: "mock",
    recentBlockhash: "mock",
    lastValidBlockHeight: 2000,
    serializedTransaction: "mock",
    txSignature: "mock_landed",
    submittedSerializedTransaction: "mock",
    principalBasisBeforeRawUsdc: 100_000_000n,
    principalBasisAfterRawUsdc: null,
    status: "submitted" as const,
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
    submittedAt: new Date().toISOString(),
    terminalAt: null,
    errorCode: null
  };
}

function submittedDeposit(): DepositIntent {
  return {
    ...submittedFlowFields(),
    depositId: "dep_sync",
    amountRawUsdc: 10_000_000n,
    actualDepositRawUsdc: null,
    sharesMintedRaw: null
  };
}

function submittedWithdrawal(): WithdrawalIntent {
  return {
    ...submittedFlowFields(),
    withdrawalId: "wdr_sync",
    purpose: "yield_realize",
    paymentBinding: null,
    paymentTxSignature: null,
    paymentVerification: "unreported",
    requestedWithdrawRawUsdc: 500_000n,
    requestedSharesRaw: 500_000n,
    maxSharesToRedeemRaw: 500_000n,
    destinationUsdcAta: ATA,
    actualSharesBurnedRaw: null,
    actualWithdrawRawUsdc: null,
    liquidityRejectionReason: null
  };
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

for (const backend of ["memory", "postgres"] as const) {
  describe.skipIf(backend === "postgres" && !connectionString)(`Chain sync receipt consistency (${backend})`, () => {
    let ledger: Ledger;
    let service: SublyService;
    let cleanup: (() => Promise<void>) | undefined;

    beforeEach(async () => {
      if (backend === "postgres") {
        const schema = `subly_sync_test_${randomUUID().replaceAll("-", "")}`;
        const admin = new Pool({ connectionString });
        await admin.query(`create schema ${schema}`);
        const postgres = new PostgresLedger({ connectionString, options: `-c search_path=${schema}` });
        ledger = postgres;
        cleanup = async () => {
          await postgres.close();
          await admin.query(`drop schema ${schema} cascade`);
          await admin.end();
        };
      } else {
        ledger = new InMemoryLedger();
      }
      service = new SublyService({ ledger });
      await ledger.savePosition({
        wallet: WALLET,
        vault: VAULT,
        signingPolicyId: "test_policy",
        signingMode: "non_interactive",
        signerValidationMode: "structured_intent_transaction",
        signerProvider: "local_test",
        ...shares(101_000_000n),
        exchangeRateScaled: RATE_SCALE,
        instantRedeemCapacityRawUsdc: 1_000_000_000n,
        principalBasisRawUsdc: 100_000_000n,
        principalBasisSource: "subly_receipts",
        reservedRawUsdc: 0n,
        feeDebtRawUsdc: 0n,
        safetyBufferRawUsdc: 0n,
        kaminoPositionSnapshot: [],
        kaminoPnlSnapshot: [],
        lastSyncedSlot: 100,
        version: 1,
        status: "active"
      });
    });

    afterEach(async () => {
      await cleanup?.();
      cleanup = undefined;
    });

    function harness(afterSharesRaw: bigint, usdcDelta: bigint) {
      const getUserSharesRaw = vi.fn(async () => shares(afterSharesRaw));
      const loadContext = vi.fn(async () => ({
        slot: 1000n,
        exchangeRateScaled: RATE_SCALE,
        instantRedeemCapacityRawUsdc: 1_000_000_000n
      }) as unknown as VaultContext);
      const adapter = { vaultAddress: VAULT, getUserSharesRaw, loadContext } as unknown as KaminoVaultAdapter;
      const engine = {
        async lookupTransaction() {
          return { found: true, err: null, feeLamports: 0n,
            tokenBalanceDeltas: new Map([[ATA, usdcDelta]]), slot: 1000n };
        }
      } as unknown as TransactionSubmissionEngine;
      return {
        getUserSharesRaw,
        loadContext,
        sync: new ChainWalletSyncService({ adapter, service }),
        flows: new VaultFlowService({ ledger, adapter, engine,
          sponsor: { address: WALLET, keyPair: {} } as never })
      };
    }

    it("keeps a landed deposit out of sync until its receipt adds principal once", async () => {
      await ledger.saveDeposit(submittedDeposit());
      const { sync, flows } = harness(111_000_000n, -10_000_000n);
      const before = await ledger.getPosition(WALLET, VAULT);

      await expect(sync.syncFromChain({ wallet: WALLET })).rejects.toMatchObject({
        code: "vault_flow_pending",
        details: { depositIds: ["dep_sync"], withdrawalIds: [] }
      });
      expect(await ledger.getPosition(WALLET, VAULT)).toEqual(before);
      expect(await ledger.listSyncEvents(WALLET, VAULT)).toHaveLength(0);

      const receipt = await flows.getDeposit("dep_sync");
      expect(receipt).toMatchObject({ status: "confirmed", sharesMintedRaw: "10000000",
        principalBasisAfterRawUsdc: "110000000" });
      const refreshed = await sync.syncFromChain({ wallet: WALLET });
      expect(refreshed.position.principalBasisRawUsdc).toBe("110000000");
      expect(refreshed.budget.spendableYieldRawUsdc).toBe("1000000");
    });

    it("preserves the remaining yield when a landed withdrawal is awaiting its receipt", async () => {
      await ledger.saveWithdrawal(submittedWithdrawal());
      const { sync, flows } = harness(100_500_000n, 500_000n);
      const before = await ledger.getPosition(WALLET, VAULT);

      await expect(sync.syncFromChain({ wallet: WALLET })).rejects.toMatchObject({
        code: "vault_flow_pending",
        details: { depositIds: [], withdrawalIds: ["wdr_sync"] }
      });
      expect(await ledger.getPosition(WALLET, VAULT)).toEqual(before);

      const receipt = await flows.getWithdrawal("wdr_sync");
      expect(receipt).toMatchObject({ status: "confirmed", actualSharesBurnedRaw: "500000",
        principalBasisAfterRawUsdc: "100000000" });
      const refreshed = await sync.syncFromChain({ wallet: WALLET });
      expect(refreshed.position.principalBasisRawUsdc).toBe("100000000");
      expect(refreshed.budget.spendableYieldRawUsdc).toBe("500000");
    });

    it("rejects an old snapshot when a deposit finalizes during the chain read", async () => {
      await ledger.saveDeposit(submittedDeposit());
      const { sync, flows, getUserSharesRaw } = harness(111_000_000n, -10_000_000n);
      const started = deferred();
      const release = deferred();
      getUserSharesRaw.mockImplementationOnce(async () => {
        started.resolve();
        await release.promise;
        return shares(101_000_000n);
      });
      const delayedSync = sync.syncFromChain({ wallet: WALLET });
      await started.promise;
      try {
        await flows.getDeposit("dep_sync");
      } finally {
        release.resolve();
      }
      await expect(delayedSync).rejects.toMatchObject({ code: "stale_position_snapshot" });
      expect(await ledger.getPosition(WALLET, VAULT)).toMatchObject({
        totalSharesRaw: 111_000_000n,
        principalBasisRawUsdc: 110_000_000n,
        principalBasisSource: "subly_receipts"
      });
      expect(await ledger.listSyncEvents(WALLET, VAULT)).toHaveLength(1);
    });

    it("rejects an older chain slot even when the ledger revision stays unchanged", async () => {
      const { sync, loadContext } = harness(90_000_000n, 0n);
      loadContext.mockResolvedValueOnce({
        slot: 99n,
        exchangeRateScaled: RATE_SCALE,
        instantRedeemCapacityRawUsdc: 1_000_000_000n
      } as unknown as VaultContext);
      const before = await ledger.getPosition(WALLET, VAULT);

      await expect(sync.syncFromChain({ wallet: WALLET })).rejects.toMatchObject({ code: "stale_position_snapshot" });
      expect(await ledger.getPosition(WALLET, VAULT)).toEqual(before);
      expect(await ledger.listSyncEvents(WALLET, VAULT)).toHaveLength(0);
    });
  });
}
