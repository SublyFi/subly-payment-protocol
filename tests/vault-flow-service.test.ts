import { describe, expect, it } from "vitest";
import { getAddMemoInstruction } from "@solana-program/memo";
import { blockhash, type Blockhash } from "@solana/kit";
import bs58 from "bs58";
import nacl from "tweetnacl";
import { SUBLY_VAULT } from "../src/config/constants.js";
import { InMemoryLedger } from "../src/domain/ledger.js";
import type { PaymentIntent, WalletPosition } from "../src/domain/models.js";
import { SpendingMandateService } from "../src/domain/spending-mandate-service.js";
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
      minWithdrawAmountRaw: 10n,
      minDepositAmountRaw: 1_000_000n
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
  mandates?: SpendingMandateService;
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
    } as never,
    ...(params?.mandates === undefined ? {} : { mandates: params.mandates })
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
      amountRawUsdc: "1000010"
    });
    expect(prepared.status).toBe("prepared");
    expect(prepared.signingIntent.feePayer).toBe(WALLET);
    expect(prepared.preparedMessageHash).toMatch(/^sha256-/);
    expect(prepared.serializedTransaction.length).toBeGreaterThan(0);
  });

  it("rejects deposits below the vault minimum before signing", async () => {
    const { service, ledger } = buildService();
    await registerPosition(ledger);

    await expect(
      service.prepareDeposit({ wallet: WALLET, amountRawUsdc: "999999" })
    ).rejects.toMatchObject({
      code: "deposit_below_minimum",
      details: { minDepositAmountRaw: "1000000" }
    });
  });

  it("rejects a deposit of exactly the minimum (share rounding margin)", async () => {
    const { service, ledger } = buildService();
    await registerPosition(ledger);

    // kvault rounds the effective deposit down by a few raw units, so a
    // deposit of exactly the minimum lands below it on-chain.
    await expect(
      service.prepareDeposit({ wallet: WALLET, amountRawUsdc: "1000000" })
    ).rejects.toMatchObject({
      code: "deposit_below_minimum",
      details: { effectiveMinDepositRaw: "1000010" }
    });
  });

  it("rejects flows for wallets without a non-interactive signer", async () => {
    const { service, ledger } = buildService();
    await registerPosition(ledger, {
      signingMode: "observed_only",
      status: "observed_only"
    });

    await expect(
      service.prepareDeposit({ wallet: WALLET, amountRawUsdc: "1000010" })
    ).rejects.toMatchObject({ code: "observed_only" });
  });

  it("rejects a second flow while one is pending", async () => {
    const { service, ledger } = buildService();
    await registerPosition(ledger);
    await service.prepareDeposit({ wallet: WALLET, amountRawUsdc: "1000010" });

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
      service.prepareDeposit({ wallet: WALLET, amountRawUsdc: "1000010" })
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

describe("VaultFlowService yield-realize guard", () => {
  // Position: 101 shares @ rate 1.0 = 101 USDC value, basis 100 USDC
  // -> spendable yield 1 USDC (1_000_000 raw).

  it("prepares a yield-realize withdrawal within the spendable yield", async () => {
    const { service, ledger } = buildService();
    await registerPosition(ledger);

    const prepared = await service.prepareWithdrawal({
      wallet: WALLET,
      amountRawUsdc: "10000", // 0.01 USDC, well inside 1 USDC of yield
      purpose: "yield_realize"
    });
    expect(prepared.status).toBe("prepared");
  });

  it("refuses a yield-realize withdrawal beyond the spendable yield", async () => {
    const { service, ledger } = buildService();
    await registerPosition(ledger);

    await expect(
      service.prepareWithdrawal({
        wallet: WALLET,
        amountRawUsdc: "2000000", // 2 USDC > 1 USDC spendable yield
        purpose: "yield_realize"
      })
    ).rejects.toMatchObject({ code: "insufficient_yield" });
  });

  it("keeps the sponsored-fee headroom out of the spendable yield", async () => {
    const { service, ledger } = buildService();
    await registerPosition(ledger);

    // Exactly the whole yield: gross withdraw fits, but the realize-fee
    // headroom (default 2500 raw) does not — the principal would pay it.
    await expect(
      service.prepareWithdrawal({
        wallet: WALLET,
        amountRawUsdc: "1000000",
        purpose: "yield_realize"
      })
    ).rejects.toMatchObject({ code: "insufficient_yield" });
  });

  it("still allows a plain exit withdrawal beyond the yield", async () => {
    const { service, ledger } = buildService();
    await registerPosition(ledger);

    const prepared = await service.prepareWithdrawal({
      wallet: WALLET,
      amountRawUsdc: "2000000" // principal exit, no purpose flag
    });
    expect(prepared.status).toBe("prepared");
  });
});

describe("VaultFlowService spending-mandate integration", () => {
  const PAYMENT = {
    payTo: WALLET,
    amountRawUsdc: "10000",
    resourceUrlHash: "ef".repeat(32),
    method: "GET"
  };

  function withMandates(level: "on" | "warn") {
    const ledger = new InMemoryLedger();
    const mandates = new SpendingMandateService({
      ledger,
      config: { enforcementLevel: level, onWarn: () => undefined }
    });
    return buildService({ ledger, mandates });
  }

  it("stamps the mandate decision and binding on a realize intent", async () => {
    const { service, ledger } = withMandates("on");
    await registerPosition(ledger);

    const prepared = await service.prepareWithdrawal({
      wallet: WALLET,
      amountRawUsdc: "10000",
      purpose: "yield_realize",
      payment: PAYMENT
    });
    expect(prepared.purpose).toBe("yield_realize");
    expect(prepared.paymentBinding).toEqual(PAYMENT);
    expect(prepared.policySource).toBe("default");
    expect(prepared.policyDecision).toBe("auto_within_policy");
    expect(prepared.paymentVerification).toBe("unreported");
  });

  it("refuses a realize without its payment binding when enforcement is on", async () => {
    const { service, ledger } = withMandates("on");
    await registerPosition(ledger);

    await expect(
      service.prepareWithdrawal({
        wallet: WALLET,
        amountRawUsdc: "10000",
        purpose: "yield_realize"
      })
    ).rejects.toMatchObject({ code: "payment_binding_required" });
  });

  it("keeps warn mode non-blocking for legacy clients without a binding", async () => {
    const { service, ledger } = withMandates("warn");
    await registerPosition(ledger);

    const prepared = await service.prepareWithdrawal({
      wallet: WALLET,
      amountRawUsdc: "10000",
      purpose: "yield_realize"
    });
    expect(prepared.status).toBe("prepared");
    expect(prepared.policyDecision).toBe("auto_within_policy");
  });

  it("leaves plain exit withdrawals outside the mandate payment gate", async () => {
    const { service, ledger } = withMandates("on");
    await registerPosition(ledger);

    const prepared = await service.prepareWithdrawal({
      wallet: WALLET,
      amountRawUsdc: "2000000"
    });
    expect(prepared.purpose).toBe("normal");
    expect(prepared.policyDecision).toBeNull();
  });

  it("enforces the daily deposit cap at prepare time", async () => {
    const { service, ledger } = withMandates("on");
    await registerPosition(ledger);

    await expect(
      service.prepareDeposit({
        wallet: WALLET,
        amountRawUsdc: "3000000001" // 3,000.000001 USDC > default daily cap
      })
    ).rejects.toMatchObject({ code: "daily_deposit_cap_exceeded" });

    const withinCap = await service.prepareDeposit({
      wallet: WALLET,
      amountRawUsdc: "1000010"
    });
    expect(withinCap.status).toBe("prepared");
  });
});
