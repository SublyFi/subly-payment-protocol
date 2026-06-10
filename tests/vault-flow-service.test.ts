import { describe, expect, it } from "vitest";
import { getAddMemoInstruction } from "@solana-program/memo";
import { blockhash, type Blockhash } from "@solana/kit";
import bs58 from "bs58";
import nacl from "tweetnacl";
import { SUBLY_VAULT } from "../src/config/constants.js";
import { InMemoryLedger } from "../src/domain/ledger.js";
import type { PaymentIntent, WalletPosition } from "../src/domain/models.js";
import { VaultFlowService } from "../src/domain/vault-flow-service.js";
import type {
  KaminoVaultAdapter,
  UserSharesRaw,
  VaultContext
} from "../src/kamino/vault-adapter.js";
import type { TransactionSubmissionEngine } from "../src/solana/submission.js";

const WALLET_KEYS = nacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(7));
const WALLET = bs58.encode(WALLET_KEYS.publicKey);
const TEST_BLOCKHASH = blockhash("GHtnjzoaqLgzJZ4XTQr5ChCAPGJmCEqVMG6gRGoiTLDv");

class FakeAdapter {
  readonly vaultAddress = SUBLY_VAULT.address;
  totalSharesRaw = 101_000_000n;

  async loadContext(): Promise<VaultContext> {
    return {
      slot: 1n,
      blockhash: TEST_BLOCKHASH as Blockhash,
      lastValidBlockHeight: 1_000n,
      exchangeRateScaled: 1_000_000_000_000n,
      tokenAvailableRaw: 10_000_000n,
      instantRedeemCapacityRawUsdc: 10_000_000n,
      singleInstructionRedeemCapacityRawUsdc: 10_000_000n,
      withdrawalPenaltyBps: 0n,
      withdrawalPenaltyLamports: 0n,
      minWithdrawAmountRaw: 10n
    } as unknown as VaultContext;
  }

  async getUserSharesRaw(): Promise<UserSharesRaw> {
    return {
      stakedSharesRaw: 0n,
      unstakedSharesRaw: this.totalSharesRaw,
      totalSharesRaw: this.totalSharesRaw,
      sharesAtaAddress: WALLET as never,
      sharesAtaExists: true
    };
  }

  async buildDepositInstructions() {
    return [getAddMemoInstruction({ memo: "deposit" })];
  }

  async buildNormalWithdrawInstructions() {
    return [getAddMemoInstruction({ memo: "withdraw" })];
  }

  async loadLookupTables() {
    return {};
  }
}

function buildService(params?: {
  adapter?: FakeAdapter;
  ledger?: InMemoryLedger;
}) {
  const ledger = params?.ledger ?? new InMemoryLedger();
  const adapter = params?.adapter ?? new FakeAdapter();
  const service = new VaultFlowService({
    ledger,
    adapter: adapter as unknown as KaminoVaultAdapter,
    engine: {} as TransactionSubmissionEngine,
    sponsor: {
      address: WALLET,
      keyPair: {} as CryptoKeyPair
    } as never
  });

  return { service, ledger, adapter };
}

async function registerPosition(
  ledger: InMemoryLedger,
  overrides?: Partial<WalletPosition>
) {
  await ledger.savePosition({
    wallet: WALLET,
    vault: SUBLY_VAULT.address,
    signingPolicyId: "policy_1",
    signingMode: "non_interactive",
    signerValidationMode: "structured_intent_transaction",
    signerProvider: "local_test",
    stakedSharesRaw: 0n,
    unstakedSharesRaw: 101_000_000n,
    totalSharesRaw: 101_000_000n,
    exchangeRateScaled: 1_000_000_000_000n,
    instantRedeemCapacityRawUsdc: 10_000_000n,
    principalBasisRawUsdc: 100_000_000n,
    principalBasisSource: "kamino_pnl_current",
    reservedRawUsdc: 0n,
    feeDebtRawUsdc: 0n,
    safetyBufferRawUsdc: 0n,
    kaminoPositionSnapshot: [],
    kaminoPnlSnapshot: [],
    lastSyncedSlot: null,
    version: 1,
    status: "active",
    ...overrides
  });
}

function submittedPayment(): PaymentIntent {
  return {
    paymentId: "pay_submitted",
    wallet: WALLET,
    vault: SUBLY_VAULT.address,
    seller: WALLET,
    sellerRequestId: "req",
    httpMethod: "GET",
    canonicalResourceUrl: "https://api.example.com/v1/data",
    requestBodyHash: "sha256-empty",
    requestBindingHash: "sha256-x",
    asset: SUBLY_VAULT.usdcMint,
    amountRawUsdc: 1n,
    payTo: WALLET,
    sellerUsdcAta: WALLET,
    dustRecipientUsdcAta: WALLET,
    signingPolicyId: "policy_1",
    preparedMessageHash: "sha256-y",
    recentBlockhash: null,
    lastValidBlockHeight: null,
    temporarySettlementTokenAccount: WALLET,
    temporarySettlementSignature: "sig",
    sharesToRedeemRaw: 1n,
    requiredWithdrawRawUsdc: 1n,
    estimatedFeeLamports: 0n,
    estimatedFeeDebtRawUsdc: 0n,
    principalBasisBeforeRawUsdc: 0n,
    grossYieldBeforeRawUsdc: 0n,
    spendableYieldBeforeRawUsdc: 0n,
    postPositionValueRawUsdc: 0n,
    reservationRawUsdc: 0n,
    status: "submitted",
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
    submittedAt: new Date().toISOString(),
    terminalAt: null,
    txSignature: "sig",
    submittedSerializedTransaction: "AA==",
    settlementResponse: null,
    intentJson: {}
  };
}

describe("VaultFlowService gates", () => {
  it("prepares a deposit and returns a signing intent", async () => {
    const { service, ledger } = buildService();
    await registerPosition(ledger);

    const prepared = await service.prepareDeposit({
      wallet: WALLET,
      amountRawUsdc: "1000000"
    });
    expect(prepared.status).toBe("prepared");
    expect(prepared.signingIntent.feePayer).toBe(WALLET);
    expect(prepared.preparedMessageHash).toMatch(/^sha256-/);
    expect(prepared.serializedTransaction.length).toBeGreaterThan(0);
  });

  it("rejects flows for wallets without a non-interactive signer", async () => {
    const { service, ledger } = buildService();
    await registerPosition(ledger, {
      signingMode: "observed_only",
      status: "observed_only"
    });

    await expect(
      service.prepareDeposit({ wallet: WALLET, amountRawUsdc: "1000000" })
    ).rejects.toMatchObject({ code: "observed_only" });
  });

  it("rejects a second flow while one is pending", async () => {
    const { service, ledger } = buildService();
    await registerPosition(ledger);
    await service.prepareDeposit({ wallet: WALLET, amountRawUsdc: "1000000" });

    await expect(
      service.prepareDeposit({ wallet: WALLET, amountRawUsdc: "2000000" })
    ).rejects.toMatchObject({ code: "vault_flow_pending" });
    await expect(
      service.prepareWithdrawal({ wallet: WALLET, amountRawUsdc: "1000000" })
    ).rejects.toMatchObject({ code: "vault_flow_pending" });
  });

  it("blocks withdrawals while a payment is submitted", async () => {
    const { service, ledger } = buildService();
    await registerPosition(ledger);
    await ledger.savePayment(submittedPayment());

    await expect(
      service.prepareWithdrawal({ wallet: WALLET, amountRawUsdc: "1000000" })
    ).rejects.toMatchObject({ code: "wallet_locked_by_payment" });
  });

  it("flags needs_baseline_reset when chain shares differ on deposit prepare", async () => {
    const adapter = new FakeAdapter();
    adapter.totalSharesRaw = 90_000_000n;
    const { service, ledger } = buildService({ adapter });
    await registerPosition(ledger);

    await expect(
      service.prepareDeposit({ wallet: WALLET, amountRawUsdc: "1000000" })
    ).rejects.toMatchObject({ code: "needs_baseline_reset" });
    const position = await ledger.getPosition(WALLET, SUBLY_VAULT.address);
    expect(position?.status).toBe("needs_baseline_reset");
  });

  it("rejects withdrawals beyond instant capacity", async () => {
    const adapter = new FakeAdapter();
    const { service, ledger } = buildService({ adapter });
    await registerPosition(ledger);

    await expect(
      service.prepareWithdrawal({ wallet: WALLET, amountRawUsdc: "50000000" })
    ).rejects.toMatchObject({ code: "withdraw_illiquid" });
  });
});
