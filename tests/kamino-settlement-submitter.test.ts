import { describe, expect, it } from "vitest";
import { KaminoSettlementSubmitter } from "../src/domain/kamino-settlement-submitter.js";
import type { PaymentIntent } from "../src/domain/models.js";
import type {
  TransactionSubmissionEngine,
  TransactionLookupResult
} from "../src/solana/submission.js";

const SELLER_USDC_ATA = "SellerAtaPubkey111111111111111111111111111";
const DUST_ATA = "DustAtaPubkey1111111111111111111111111111111";

function intentFixture(): PaymentIntent {
  return {
    paymentId: "pay_test",
    wallet: "AgentWallet11111111111111111111111111111111",
    vault: "Vault111111111111111111111111111111111111111",
    seller: "Seller11111111111111111111111111111111111111",
    sellerRequestId: "seller_req_1",
    httpMethod: "GET",
    canonicalResourceUrl: "https://api.example.com/v1/data",
    requestBodyHash: "sha256-empty",
    requestBindingHash: "sha256-binding",
    asset: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
    amountRawUsdc: 500_000n,
    payTo: "Seller11111111111111111111111111111111111111",
    sellerUsdcAta: SELLER_USDC_ATA,
    dustRecipientUsdcAta: DUST_ATA,
    signingPolicyId: "policy_1",
    preparedMessageHash: "sha256-prepared",
    recentBlockhash: "blockhash",
    lastValidBlockHeight: 100,
    temporarySettlementTokenAccount:
      "TempAccount111111111111111111111111111111111",
    temporarySettlementSignature: "tempsig",
    sharesToRedeemRaw: 500_100n,
    requiredWithdrawRawUsdc: 500_051n,
    estimatedFeeLamports: 120_000n,
    estimatedFeeDebtRawUsdc: 100n,
    principalBasisBeforeRawUsdc: 100_000_000n,
    grossYieldBeforeRawUsdc: 1_000_000n,
    spendableYieldBeforeRawUsdc: 900_000n,
    postPositionValueRawUsdc: 100_500_000n,
    reservationRawUsdc: 500_100n,
    status: "submission_prepared",
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
    submittedAt: null,
    terminalAt: null,
    txSignature: "stored_tx_signature",
    submittedSerializedTransaction: "c3RvcmVkLXNpZ25lZC1ieXRlcw==",
    settlementResponse: null,
    intentJson: {}
  };
}

interface FakeEngineBehavior {
  lookupResults: TransactionLookupResult[];
  simulateErr?: unknown;
}

function fakeEngine(behavior: FakeEngineBehavior) {
  const calls = {
    lookup: 0,
    simulate: 0,
    send: 0
  };
  const engine = {
    async lookupTransaction(): Promise<TransactionLookupResult> {
      const result =
        behavior.lookupResults[
          Math.min(calls.lookup, behavior.lookupResults.length - 1)
        ];
      calls.lookup += 1;
      return result ?? { found: false };
    },
    async simulateSignedTransaction() {
      calls.simulate += 1;
      return { err: behavior.simulateErr ?? null, logs: null };
    },
    async sendSignedTransaction() {
      calls.send += 1;
      return "sent";
    },
    async waitForConfirmation() {
      return { status: "confirmed" as const };
    },
    async isBlockhashExpired() {
      return false;
    }
  };

  return { engine: engine as unknown as TransactionSubmissionEngine, calls };
}

const SPONSOR_ADDRESS = "Sponsor1111111111111111111111111111111111111";
const SPONSOR = {
  address: SPONSOR_ADDRESS,
  keyPair: {} as CryptoKeyPair
} as unknown as import("@solana/kit").KeyPairSigner;

describe("KaminoSettlementSubmitter retry safety", () => {
  it("treats an already-landed transaction as settled instead of re-simulating", async () => {
    const intent = intentFixture();
    const { engine, calls } = fakeEngine({
      lookupResults: [
        {
          found: true,
          err: null,
          feeLamports: 6000n,
          tokenBalanceDeltas: new Map([
            [SELLER_USDC_ATA, 500_000n],
            [DUST_ATA, 51n]
          ]),
          slot: 123n
        }
      ],
      // If the implementation simulated the landed transaction it would see
      // this error and incorrectly report failed_not_submitted.
      simulateErr: { InstructionError: [4, "Custom"] }
    });
    const submitter = new KaminoSettlementSubmitter({
      engine,
      sponsor: SPONSOR
    });

    const result = await submitter.submitPaymentSettlement({
      intent,
      sponsorFeePayer: SPONSOR_ADDRESS,
      txSignature: intent.txSignature!,
      serializedSignedTransaction: intent.submittedSerializedTransaction!
    });

    expect(result.status).toBe("settled");
    expect(result.status === "settled" && result.withdrawOutputRawUsdc).toBe(
      500_051n
    );
    expect(result.status === "settled" && result.sellerTransferRawUsdc).toBe(
      500_000n
    );
    expect(calls.simulate).toBe(0);
    expect(calls.send).toBe(0);
  });

  it("treats an already-landed failed transaction as landed_failed with fee debt", async () => {
    const intent = intentFixture();
    const { engine, calls } = fakeEngine({
      lookupResults: [
        {
          found: true,
          err: { InstructionError: [5, "Custom"] },
          feeLamports: 6000n,
          tokenBalanceDeltas: new Map(),
          slot: 123n
        }
      ]
    });
    const submitter = new KaminoSettlementSubmitter({
      engine,
      sponsor: SPONSOR
    });

    const result = await submitter.submitPaymentSettlement({
      intent,
      sponsorFeePayer: SPONSOR_ADDRESS,
      txSignature: intent.txSignature!,
      serializedSignedTransaction: intent.submittedSerializedTransaction!
    });

    expect(result.status).toBe("failed");
    expect(result.status === "failed" && result.errorCode).toBe("landed_failed");
    expect(calls.send).toBe(0);
  });

  it("invokes onBeforeSend after simulation and before broadcasting", async () => {
    const intent = intentFixture();
    const { engine, calls } = fakeEngine({
      lookupResults: [
        { found: false },
        {
          found: true,
          err: null,
          feeLamports: 5000n,
          tokenBalanceDeltas: new Map([[SELLER_USDC_ATA, 500_000n]]),
          slot: 5n
        }
      ]
    });
    const events: string[] = [];
    const originalSend = engine.sendSignedTransaction.bind(engine);
    engine.sendSignedTransaction = async (tx: string) => {
      events.push("send");
      return originalSend(tx);
    };
    const submitter = new KaminoSettlementSubmitter({
      engine,
      sponsor: SPONSOR
    });

    const result = await submitter.submitPaymentSettlement({
      intent,
      sponsorFeePayer: SPONSOR_ADDRESS,
      txSignature: intent.txSignature!,
      serializedSignedTransaction: intent.submittedSerializedTransaction!,
      onBeforeSend: async () => {
        events.push("mark_submitted");
      }
    });

    expect(events).toEqual(["mark_submitted", "send"]);
    expect(result.status).toBe("settled");
    expect(calls.simulate).toBe(1);
  });

  it("does not broadcast when onBeforeSend fails to persist", async () => {
    const intent = intentFixture();
    const { engine, calls } = fakeEngine({ lookupResults: [{ found: false }] });
    const submitter = new KaminoSettlementSubmitter({
      engine,
      sponsor: SPONSOR
    });

    await expect(
      submitter.submitPaymentSettlement({
        intent,
        sponsorFeePayer: SPONSOR_ADDRESS,
        txSignature: intent.txSignature!,
        serializedSignedTransaction: intent.submittedSerializedTransaction!,
        onBeforeSend: async () => {
          throw new Error("ledger unavailable");
        }
      })
    ).rejects.toThrow("ledger unavailable");
    expect(calls.send).toBe(0);
  });

  it("does not invoke onBeforeSend for an already-landed transaction", async () => {
    const intent = intentFixture();
    const { engine, calls } = fakeEngine({
      lookupResults: [
        {
          found: true,
          err: null,
          feeLamports: 5000n,
          tokenBalanceDeltas: new Map([[SELLER_USDC_ATA, 500_000n]]),
          slot: 5n
        }
      ]
    });
    const submitter = new KaminoSettlementSubmitter({
      engine,
      sponsor: SPONSOR
    });
    let markCalls = 0;

    const result = await submitter.submitPaymentSettlement({
      intent,
      sponsorFeePayer: SPONSOR_ADDRESS,
      txSignature: intent.txSignature!,
      serializedSignedTransaction: intent.submittedSerializedTransaction!,
      onBeforeSend: async () => {
        markCalls += 1;
      }
    });

    expect(result.status).toBe("settled");
    expect(markCalls).toBe(0);
    expect(calls.send).toBe(0);
  });

  it("does not invoke onBeforeSend when simulation fails before any broadcast", async () => {
    const intent = intentFixture();
    const { engine, calls } = fakeEngine({
      lookupResults: [{ found: false }],
      simulateErr: { InstructionError: [4, "Custom"] }
    });
    const submitter = new KaminoSettlementSubmitter({
      engine,
      sponsor: SPONSOR
    });
    let markCalls = 0;

    const result = await submitter.submitPaymentSettlement({
      intent,
      sponsorFeePayer: SPONSOR_ADDRESS,
      txSignature: intent.txSignature!,
      serializedSignedTransaction: intent.submittedSerializedTransaction!,
      onBeforeSend: async () => {
        markCalls += 1;
      }
    });

    expect(result.status).toBe("failed_not_submitted");
    expect(markCalls).toBe(0);
    expect(calls.send).toBe(0);
  });

  it("still rejects before sending when the unlanded transaction fails simulation", async () => {
    const intent = intentFixture();
    const { engine, calls } = fakeEngine({
      lookupResults: [{ found: false }],
      simulateErr: { InstructionError: [4, "Custom"] }
    });
    const submitter = new KaminoSettlementSubmitter({
      engine,
      sponsor: SPONSOR
    });

    const result = await submitter.submitPaymentSettlement({
      intent,
      sponsorFeePayer: SPONSOR_ADDRESS,
      txSignature: intent.txSignature!,
      serializedSignedTransaction: intent.submittedSerializedTransaction!
    });

    expect(result.status).toBe("failed_not_submitted");
    expect(calls.send).toBe(0);
  });
});
