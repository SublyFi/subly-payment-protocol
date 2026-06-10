import bs58 from "bs58";
import nacl from "tweetnacl";
import { describe, expect, it } from "vitest";
import {
  PAYMENT_SCHEME,
  SOLANA_MAINNET_NETWORK,
  SUBLY_VAULT
} from "../src/config/constants.js";
import type { FeeEstimator } from "../src/domain/fee-estimator.js";
import { InMemoryLedger } from "../src/domain/ledger.js";
import { SublyService } from "../src/domain/payment-service.js";
import type {
  CanonicalPaymentSettlementInput,
  CanonicalTransactionBuilder,
  PreparedSettlementTransaction,
  SettlementQuote
} from "../src/domain/transaction-builder.js";
import {
  SettlementSubmissionError,
  type SettlementReconciliationInput,
  type SettlementReconciliationResult,
  type SettlementSubmissionPreparationInput,
  SettlementSubmissionInput,
  SettlementSubmissionResult,
  type SettlementSubmitter
} from "../src/domain/settlement-submitter.js";
import { deriveAssociatedTokenAddress } from "../src/lib/associated-token-account.js";
import { sha256TaggedHex } from "../src/lib/hash.js";

describe("SublyService", () => {
  it("uses conservative baseline on first sync without trusted cost basis", async () => {
    const wallet = ADDRESSES.wallet;
    const service = new SublyService();

    await service.registerAgentWallet({
      wallet,
      signingPolicyId: "policy_1"
    });
    const synced = await service.syncWalletPosition({
      wallet,
      totalSharesRaw: "100000000",
      exchangeRateScaled: "1010000000000",
      instantRedeemCapacityRawUsdc: "1000000"
    });

    expect(synced.position.principalBasisRawUsdc).toBe("101000000");
    expect(synced.budget.spendableYieldRawUsdc).toBe("0");
  });

  it("prepares and reserves a payment when the transaction builder succeeds", async () => {
    const wallet = ADDRESSES.wallet;
    const seller = ADDRESSES.seller;
    const sellerUsdcAta = ADDRESSES.sellerUsdcAta;
    const builder = new FakeTransactionBuilder();
    const service = new SublyService({
      transactionBuilder: builder,
      config: {
        defaultEstimatedFeeDebtRawUsdc: 100_000n
      }
    });

    await service.registerAgentWallet({
      wallet,
      signingPolicyId: "policy_1",
      signerProvider: "local_test"
    });
    await service.syncWalletPosition({
      wallet,
      totalSharesRaw: "101000000",
      exchangeRateScaled: "1000000000000",
      instantRedeemCapacityRawUsdc: "1000000",
      principalBasisRawUsdc: "100000000",
      principalBasisSource: "kamino_pnl_current"
    });

    const payment = await service.preparePayment({
      wallet,
      scheme: PAYMENT_SCHEME,
      network: SOLANA_MAINNET_NETWORK,
      asset: SUBLY_VAULT.usdcMint,
      seller,
      sellerRequestId: "seller_req_1",
      httpMethod: "GET",
      canonicalResourceUrl: "https://api.example.com/v1/data",
      amountRawUsdc: "500000",
      payTo: seller,
      sellerUsdcAta,
      dustRecipientUsdcAta: ADDRESSES.agentUsdcAta
    });

    expect(payment.status).toBe("prepared");
    expect(payment.reservationRawUsdc).toBe("600000");
    expect(payment.preparedMessageHash).toMatch(/^sha256-/);

    const budget = await service.getBudget(wallet);
    expect(budget.position.reservedRawUsdc).toBe("600000");
    expect(builder.calls).toBe(1);
    await expect(
      service.verifyPaymentPayload({
        paymentId: payment.paymentId,
        requestBindingHash: payment.requestBindingHash,
        preparedMessageHash: payment.preparedMessageHash,
        ...payloadFor(payment)
      })
    ).resolves.toMatchObject({
      isValid: true,
      paymentId: payment.paymentId
    });
  });

  it("does not overbook instant redeem capacity across active reservations", async () => {
    const service = await serviceWithSpendableYield({
      totalSharesRaw: "102000000",
      principalBasisRawUsdc: "100000000",
      instantRedeemCapacityRawUsdc: "750000"
    });

    await service.preparePayment({
      wallet: ADDRESSES.wallet,
      asset: SUBLY_VAULT.usdcMint,
      seller: ADDRESSES.seller,
      sellerRequestId: "seller_req_liquidity_1",
      httpMethod: "GET",
      canonicalResourceUrl: "https://api.example.com/v1/data",
      amountRawUsdc: "500000",
      payTo: ADDRESSES.seller,
      sellerUsdcAta: ADDRESSES.sellerUsdcAta,
      dustRecipientUsdcAta: ADDRESSES.agentUsdcAta
    });

    await expect(
      service.preparePayment({
        wallet: ADDRESSES.wallet,
        asset: SUBLY_VAULT.usdcMint,
        seller: ADDRESSES.seller,
        sellerRequestId: "seller_req_liquidity_2",
        httpMethod: "GET",
        canonicalResourceUrl: "https://api.example.com/v1/data",
        amountRawUsdc: "300000",
        payTo: ADDRESSES.seller,
        sellerUsdcAta: ADDRESSES.sellerUsdcAta,
        dustRecipientUsdcAta: ADDRESSES.agentUsdcAta
      })
    ).rejects.toMatchObject({
      code: "budget_illiquid",
      details: {
        activeWithdrawReservedRawUsdc: "500000",
        requiredInstantRedeemCapacityRawUsdc: "800000"
      }
    });
  });

  it("settles a prepared payment once and updates the ledger", async () => {
    const submitter = new FakeSettlementSubmitter({
      status: "settled",
      txSignature: "settlement_signature",
      actualFeeLamports: 4000n,
      actualFeeDebtRawUsdc: 90_000n
    });
    const service = await serviceWithSpendableYield({
      settlementSubmitter: submitter
    });
    const payment = await service.preparePayment({
      wallet: ADDRESSES.wallet,
      asset: SUBLY_VAULT.usdcMint,
      seller: ADDRESSES.seller,
      sellerRequestId: "seller_req_settle",
      httpMethod: "GET",
      canonicalResourceUrl: "https://api.example.com/v1/data",
      amountRawUsdc: "500000",
      payTo: ADDRESSES.seller,
      sellerUsdcAta: ADDRESSES.sellerUsdcAta,
      dustRecipientUsdcAta: ADDRESSES.agentUsdcAta
    });
    const payload = {
      paymentId: payment.paymentId,
      requestBindingHash: payment.requestBindingHash,
      preparedMessageHash: payment.preparedMessageHash,
      ...payloadFor(payment)
    };

    const response = await service.settlePaymentPayload(payload);

    expect(response).toMatchObject({
      success: true,
      transaction: txSignatureFor(payment),
      amount: "500000",
      extensions: {
        subly: {
          paymentId: payment.paymentId,
          sellerUsdcAta: ADDRESSES.sellerUsdcAta,
          sharesRedeemedRaw: "500000",
          sellerTransferRawUsdc: "500000"
        }
      }
    });
    expect(submitter.calls).toBe(1);
    expect(submitter.prepareSubmissionCalls).toBe(1);
    expect(submitter.inputs[0]?.intent.paymentId).toBe(payment.paymentId);
    expect(submitter.inputs[0]?.serializedSignedTransaction).toBe(
      serializedTransactionFor(payment)
    );
    expect("serializedTransaction" in submitter.inputs[0]!).toBe(false);
    expect("agentSignature" in submitter.inputs[0]!).toBe(false);
    expect("temporarySettlementSignature" in submitter.inputs[0]!).toBe(false);
    expect((await service.getPayment(payment.paymentId)).status).toBe("settled");

    const budget = await service.getBudget(ADDRESSES.wallet);
    expect(budget.position.reservedRawUsdc).toBe("0");
    expect(budget.position.feeDebtRawUsdc).toBe("90000");
    expect(budget.position.totalSharesRaw).toBe("100500000");
    expect(budget.budget.spendableYieldRawUsdc).toBe("410000");

    await expect(service.settlePaymentPayload(payload)).resolves.toEqual(response);
    expect(submitter.calls).toBe(1);
  });

  it("persists submitted status before the settlement broadcast", async () => {
    let statusAtBroadcast: string | null = null;
    const holder: { service: SublyService | null } = { service: null };
    const submitter = new FakeSettlementSubmitter({
      status: "settled",
      txSignature: "settlement_signature"
    });
    const originalSubmit = submitter.submitPaymentSettlement.bind(submitter);
    submitter.submitPaymentSettlement = async (input) => {
      // Mirrors the production submitter: the service must have durably
      // marked the intent submitted before the first broadcast.
      await input.onBeforeSend?.();
      statusAtBroadcast = (
        await holder.service!.getPayment(input.intent.paymentId)
      ).status;
      return originalSubmit(input);
    };
    const service = await serviceWithSpendableYield({
      settlementSubmitter: submitter
    });
    holder.service = service;
    const payment = await service.preparePayment({
      wallet: ADDRESSES.wallet,
      asset: SUBLY_VAULT.usdcMint,
      seller: ADDRESSES.seller,
      sellerRequestId: "seller_req_mark_submitted",
      httpMethod: "GET",
      canonicalResourceUrl: "https://api.example.com/v1/data",
      amountRawUsdc: "500000",
      payTo: ADDRESSES.seller,
      sellerUsdcAta: ADDRESSES.sellerUsdcAta,
      dustRecipientUsdcAta: ADDRESSES.agentUsdcAta
    });

    const response = await service.settlePaymentPayload({
      paymentId: payment.paymentId,
      requestBindingHash: payment.requestBindingHash,
      preparedMessageHash: payment.preparedMessageHash,
      ...payloadFor(payment)
    });

    expect(statusAtBroadcast).toBe("submitted");
    expect(response).toMatchObject({ success: true });
    const settled = await service.getPayment(payment.paymentId);
    expect(settled.status).toBe("settled");
    expect(settled.submittedAt).not.toBeNull();
  });

  it("verifies submitted and settled payloads idempotently for seller retries", async () => {
    const submitter = new FakeSettlementSubmitter({
      status: "settled",
      txSignature: "settlement_signature"
    });
    const service = await serviceWithSpendableYield({
      settlementSubmitter: submitter
    });
    const payment = await service.preparePayment({
      wallet: ADDRESSES.wallet,
      asset: SUBLY_VAULT.usdcMint,
      seller: ADDRESSES.seller,
      sellerRequestId: "seller_req_verify_retry",
      httpMethod: "GET",
      canonicalResourceUrl: "https://api.example.com/v1/data",
      amountRawUsdc: "500000",
      payTo: ADDRESSES.seller,
      sellerUsdcAta: ADDRESSES.sellerUsdcAta,
      dustRecipientUsdcAta: ADDRESSES.agentUsdcAta
    });
    const payload = {
      paymentId: payment.paymentId,
      requestBindingHash: payment.requestBindingHash,
      preparedMessageHash: payment.preparedMessageHash,
      ...payloadFor(payment)
    };

    // A seller retry while the settlement is in flight must still verify so
    // it can reach /settle and reconcile instead of being dead-ended.
    const intent = await service.ledger.getPayment(payment.paymentId);
    await service.ledger.savePayment({
      ...intent!,
      status: "submitted",
      txSignature: txSignatureFor(payment),
      submittedSerializedTransaction: serializedTransactionFor(payment),
      submittedAt: new Date().toISOString()
    });
    await expect(service.verifyPaymentPayload(payload)).resolves.toMatchObject({
      isValid: true,
      status: "submitted"
    });

    await service.ledger.savePayment({ ...intent! });
    await service.settlePaymentPayload(payload);
    await expect(service.verifyPaymentPayload(payload)).resolves.toMatchObject({
      isValid: true,
      status: "settled"
    });

    // A tampered payload must still be rejected regardless of status.
    await expect(
      service.verifyPaymentPayload({
        paymentId: payment.paymentId,
        requestBindingHash: payment.requestBindingHash,
        preparedMessageHash: payment.preparedMessageHash,
        ...tamperedPayloadFor(payment)
      })
    ).resolves.toMatchObject({ isValid: false });
  });

  it("rejects self-payments whose payTo is the agent wallet", async () => {
    const service = await serviceWithSpendableYield();

    await expect(
      service.preparePayment({
        wallet: ADDRESSES.wallet,
        asset: SUBLY_VAULT.usdcMint,
        seller: ADDRESSES.wallet,
        sellerRequestId: "seller_req_self_payment",
        httpMethod: "GET",
        canonicalResourceUrl: "https://api.example.com/v1/data",
        amountRawUsdc: "500000",
        payTo: ADDRESSES.wallet,
        sellerUsdcAta: ADDRESSES.agentUsdcAta,
        dustRecipientUsdcAta: ADDRESSES.agentUsdcAta
      })
    ).rejects.toMatchObject({ code: "self_payment_not_supported" });
  });

  it("releases reservations without fee debt when settlement is not submitted", async () => {
    const submitter = new FakeSettlementSubmitter({
      status: "failed_not_submitted",
      errorCode: "rpc_unavailable",
      errorMessage: "RPC unavailable"
    });
    const service = await serviceWithSpendableYield({
      settlementSubmitter: submitter
    });
    const payment = await service.preparePayment({
      wallet: ADDRESSES.wallet,
      asset: SUBLY_VAULT.usdcMint,
      seller: ADDRESSES.seller,
      sellerRequestId: "seller_req_failed_not_submitted",
      httpMethod: "GET",
      canonicalResourceUrl: "https://api.example.com/v1/data",
      amountRawUsdc: "500000",
      payTo: ADDRESSES.seller,
      sellerUsdcAta: ADDRESSES.sellerUsdcAta,
      dustRecipientUsdcAta: ADDRESSES.agentUsdcAta
    });
    const payload = {
      paymentId: payment.paymentId,
      requestBindingHash: payment.requestBindingHash,
      preparedMessageHash: payment.preparedMessageHash,
      ...payloadFor(payment)
    };

    const response = await service.settlePaymentPayload(payload);

    expect(response).toMatchObject({
      success: false,
      error: {
        code: "rpc_unavailable"
      }
    });
    expect((await service.getPayment(payment.paymentId)).status).toBe(
      "failed_not_submitted"
    );
    const budget = await service.getBudget(ADDRESSES.wallet);
    expect(budget.position.reservedRawUsdc).toBe("0");
    expect(budget.position.feeDebtRawUsdc).toBe("0");
    expect(budget.position.totalSharesRaw).toBe("101000000");

    await service.settlePaymentPayload(payload);
    expect(submitter.calls).toBe(1);
  });

  it("does not trust inconsistent custom settlement responses from the submitter", async () => {
    const submitter = new FakeSettlementSubmitter({
      status: "failed_not_submitted",
      errorCode: "rpc_unavailable",
      errorMessage: "RPC unavailable",
      settlementResponse: {
        success: true,
        transaction: "not_real"
      }
    });
    const service = await serviceWithSpendableYield({
      settlementSubmitter: submitter
    });
    const payment = await service.preparePayment({
      wallet: ADDRESSES.wallet,
      asset: SUBLY_VAULT.usdcMint,
      seller: ADDRESSES.seller,
      sellerRequestId: "seller_req_inconsistent_response",
      httpMethod: "GET",
      canonicalResourceUrl: "https://api.example.com/v1/data",
      amountRawUsdc: "500000",
      payTo: ADDRESSES.seller,
      sellerUsdcAta: ADDRESSES.sellerUsdcAta,
      dustRecipientUsdcAta: ADDRESSES.agentUsdcAta
    });

    await expect(
      service.settlePaymentPayload({
        paymentId: payment.paymentId,
        requestBindingHash: payment.requestBindingHash,
        preparedMessageHash: payment.preparedMessageHash,
        ...payloadFor(payment)
      })
    ).resolves.toMatchObject({
      success: false,
      transaction: null,
      error: {
        code: "rpc_unavailable"
      }
    });
  });

  it("keeps ambiguous submission failures submitted for reconciliation", async () => {
    const submitter = new FakeSettlementSubmitter(
      new Error("network timeout after send attempt")
    );
    const service = await serviceWithSpendableYield({
      settlementSubmitter: submitter
    });
    const payment = await service.preparePayment({
      wallet: ADDRESSES.wallet,
      asset: SUBLY_VAULT.usdcMint,
      seller: ADDRESSES.seller,
      sellerRequestId: "seller_req_ambiguous_submit",
      httpMethod: "GET",
      canonicalResourceUrl: "https://api.example.com/v1/data",
      amountRawUsdc: "500000",
      payTo: ADDRESSES.seller,
      sellerUsdcAta: ADDRESSES.sellerUsdcAta,
      dustRecipientUsdcAta: ADDRESSES.agentUsdcAta
    });
    const payload = {
      paymentId: payment.paymentId,
      requestBindingHash: payment.requestBindingHash,
      preparedMessageHash: payment.preparedMessageHash,
      ...payloadFor(payment)
    };

    const response = await service.settlePaymentPayload(payload);

    expect(response).toMatchObject({
      success: false,
      error: {
        code: "settlement_pending"
      },
      latestError: {
        code: "settlement_submission_ambiguous"
      }
    });
    const stored = await service.getPayment(payment.paymentId);
    expect(stored.status).toBe("submitted");
    expect(stored.txSignature).toBe(txSignatureFor(payment));
    const budget = await service.getBudget(ADDRESSES.wallet);
    expect(budget.position.reservedRawUsdc).toBe("600000");
    expect(budget.position.feeDebtRawUsdc).toBe("0");

    await service.settlePaymentPayload(payload);
    expect(submitter.calls).toBe(1);
    expect(submitter.reconcileCalls).toBe(1);
  });

  it("allows submitted payments to reconcile to a terminal settlement", async () => {
    const submitter = new FakeSettlementSubmitter(
      new SettlementSubmissionError({
        outcome: "ambiguous",
        errorCode: "send_timeout",
        message: "send timed out",
        txSignature: "confirmed_signature"
      }),
      {
        status: "settled",
        txSignature: "confirmed_signature",
        actualFeeDebtRawUsdc: 90_000n
      }
    );
    const service = await serviceWithSpendableYield({
      settlementSubmitter: submitter
    });
    const payment = await service.preparePayment({
      wallet: ADDRESSES.wallet,
      asset: SUBLY_VAULT.usdcMint,
      seller: ADDRESSES.seller,
      sellerRequestId: "seller_req_reconcile",
      httpMethod: "GET",
      canonicalResourceUrl: "https://api.example.com/v1/data",
      amountRawUsdc: "500000",
      payTo: ADDRESSES.seller,
      sellerUsdcAta: ADDRESSES.sellerUsdcAta,
      dustRecipientUsdcAta: ADDRESSES.agentUsdcAta
    });
    const payload = {
      paymentId: payment.paymentId,
      requestBindingHash: payment.requestBindingHash,
      preparedMessageHash: payment.preparedMessageHash,
      ...payloadFor(payment)
    };

    await expect(service.settlePaymentPayload(payload)).resolves.toMatchObject({
      success: false,
      error: {
        code: "settlement_pending"
      }
    });
    const reconciled = await service.settlePaymentPayload(payload);

    expect(reconciled).toMatchObject({
      success: true,
      transaction: txSignatureFor(payment)
    });
    expect(submitter.calls).toBe(1);
    expect(submitter.reconcileCalls).toBe(1);
    expect((await service.getPayment(payment.paymentId)).status).toBe("settled");
    const budget = await service.getBudget(ADDRESSES.wallet);
    expect(budget.position.reservedRawUsdc).toBe("0");
    expect(budget.position.feeDebtRawUsdc).toBe("90000");
  });

  it("does not reconcile a fresh submitted payment without submission evidence", async () => {
    const submitter = new FakeSettlementSubmitter(
      {
        status: "settled",
        txSignature: "should_not_submit"
      },
      {
        status: "settled",
        txSignature: "should_not_reconcile"
      }
    );
    const service = await serviceWithSpendableYield({
      settlementSubmitter: submitter
    });
    const payment = await service.preparePayment({
      wallet: ADDRESSES.wallet,
      asset: SUBLY_VAULT.usdcMint,
      seller: ADDRESSES.seller,
      sellerRequestId: "seller_req_fresh_submitted",
      httpMethod: "GET",
      canonicalResourceUrl: "https://api.example.com/v1/data",
      amountRawUsdc: "500000",
      payTo: ADDRESSES.seller,
      sellerUsdcAta: ADDRESSES.sellerUsdcAta,
      dustRecipientUsdcAta: ADDRESSES.agentUsdcAta
    });
    const rawPayment = await service.ledger.getPayment(payment.paymentId);
    expect(rawPayment).not.toBeNull();
    await service.ledger.savePayment({
      ...rawPayment!,
      status: "submitted",
      submittedAt: new Date().toISOString()
    });

    await expect(
      service.settlePaymentPayload({
        paymentId: payment.paymentId,
        requestBindingHash: payment.requestBindingHash,
        preparedMessageHash: payment.preparedMessageHash,
        ...payloadFor(payment)
      })
    ).resolves.toMatchObject({
      success: false,
      error: {
        code: "settlement_pending"
      }
    });

    expect(submitter.calls).toBe(0);
    expect(submitter.reconcileCalls).toBe(0);
    expect((await service.getPayment(payment.paymentId)).status).toBe("submitted");
  });

  it("resends the stored signed transaction after a submission-prepared crash", async () => {
    const submitter = new FakeSettlementSubmitter();
    const service = await serviceWithSpendableYield({
      settlementSubmitter: submitter
    });
    const payment = await service.preparePayment({
      wallet: ADDRESSES.wallet,
      asset: SUBLY_VAULT.usdcMint,
      seller: ADDRESSES.seller,
      sellerRequestId: "seller_req_outbox_retry",
      httpMethod: "GET",
      canonicalResourceUrl: "https://api.example.com/v1/data",
      amountRawUsdc: "500000",
      payTo: ADDRESSES.seller,
      sellerUsdcAta: ADDRESSES.sellerUsdcAta,
      dustRecipientUsdcAta: ADDRESSES.agentUsdcAta
    });
    const rawPayment = await service.ledger.getPayment(payment.paymentId);
    const storedSignedTransaction = serializedTransactionFor(payment);
    expect(rawPayment).not.toBeNull();
    await service.ledger.savePayment({
      ...rawPayment!,
      status: "submission_prepared",
      txSignature: txSignatureFor(payment),
      submittedSerializedTransaction: storedSignedTransaction,
      settlementResponse: {
        success: false,
        error: {
          code: "settlement_pending"
        }
      }
    });

    const response = await service.settlePaymentPayload({
      paymentId: payment.paymentId,
      requestBindingHash: payment.requestBindingHash,
      preparedMessageHash: payment.preparedMessageHash,
      ...payloadFor(payment)
    });

    expect(response).toMatchObject({
      success: true,
      transaction: txSignatureFor(payment)
    });
    expect(submitter.prepareSubmissionCalls).toBe(0);
    expect(submitter.calls).toBe(1);
    expect(submitter.inputs[0]?.serializedSignedTransaction).toBe(
      storedSignedTransaction
    );
    expect((await service.getPayment(payment.paymentId)).status).toBe("settled");
  });

  it("does not submit invalid persisted signed transaction bytes after a crash", async () => {
    const submitter = new FakeSettlementSubmitter();
    const service = await serviceWithSpendableYield({
      settlementSubmitter: submitter
    });
    const payment = await service.preparePayment({
      wallet: ADDRESSES.wallet,
      asset: SUBLY_VAULT.usdcMint,
      seller: ADDRESSES.seller,
      sellerRequestId: "seller_req_invalid_outbox_retry",
      httpMethod: "GET",
      canonicalResourceUrl: "https://api.example.com/v1/data",
      amountRawUsdc: "500000",
      payTo: ADDRESSES.seller,
      sellerUsdcAta: ADDRESSES.sellerUsdcAta,
      dustRecipientUsdcAta: ADDRESSES.agentUsdcAta
    });
    const rawPayment = await service.ledger.getPayment(payment.paymentId);
    expect(rawPayment).not.toBeNull();
    await service.ledger.savePayment({
      ...rawPayment!,
      status: "submission_prepared",
      txSignature: txSignatureFor(payment),
      submittedSerializedTransaction: "stored_signed_transaction",
      settlementResponse: {
        success: false,
        error: {
          code: "settlement_pending"
        }
      }
    });

    const response = await service.settlePaymentPayload({
      paymentId: payment.paymentId,
      requestBindingHash: payment.requestBindingHash,
      preparedMessageHash: payment.preparedMessageHash,
      ...payloadFor(payment)
    });

    expect(response).toMatchObject({
      isValid: false,
      invalidReason: "submission_record_invalid"
    });
    expect(submitter.calls).toBe(0);
    expect((await service.getPayment(payment.paymentId)).status).toBe(
      "submission_prepared"
    );
  });

  it("recovers submission-prepared payments by resending stored signed transaction bytes", async () => {
    const submitter = new FakeSettlementSubmitter();
    const service = await serviceWithSpendableYield({
      settlementSubmitter: submitter
    });
    const payment = await service.preparePayment({
      wallet: ADDRESSES.wallet,
      asset: SUBLY_VAULT.usdcMint,
      seller: ADDRESSES.seller,
      sellerRequestId: "seller_req_outbox_worker_retry",
      httpMethod: "GET",
      canonicalResourceUrl: "https://api.example.com/v1/data",
      amountRawUsdc: "500000",
      payTo: ADDRESSES.seller,
      sellerUsdcAta: ADDRESSES.sellerUsdcAta,
      dustRecipientUsdcAta: ADDRESSES.agentUsdcAta
    });
    const rawPayment = await service.ledger.getPayment(payment.paymentId);
    const storedSignedTransaction = serializedTransactionFor(payment);
    expect(rawPayment).not.toBeNull();
    await service.ledger.savePayment({
      ...rawPayment!,
      status: "submission_prepared",
      txSignature: txSignatureFor(payment),
      submittedSerializedTransaction: storedSignedTransaction,
      settlementResponse: {
        success: false,
        error: {
          code: "settlement_pending"
        }
      }
    });

    const recovery = await service.recoverPendingSettlements();

    expect(recovery).toMatchObject({
      processed: 1,
      results: [
        {
          paymentId: payment.paymentId,
          recovered: true,
          response: {
            success: true,
            transaction: txSignatureFor(payment)
          }
        }
      ]
    });
    expect(submitter.prepareSubmissionCalls).toBe(0);
    expect(submitter.calls).toBe(1);
    expect(submitter.inputs[0]?.serializedSignedTransaction).toBe(
      storedSignedTransaction
    );
    expect((await service.getPayment(payment.paymentId)).status).toBe("settled");
  });

  it("recovers submitted payments by reconciling the stored transaction signature", async () => {
    const submitter = new FakeSettlementSubmitter(
      {
        status: "settled",
        txSignature: "unused_submit"
      },
      {
        status: "settled",
        txSignature: "confirmed_signature",
        actualFeeDebtRawUsdc: 90_000n
      }
    );
    const service = await serviceWithSpendableYield({
      settlementSubmitter: submitter
    });
    const payment = await service.preparePayment({
      wallet: ADDRESSES.wallet,
      asset: SUBLY_VAULT.usdcMint,
      seller: ADDRESSES.seller,
      sellerRequestId: "seller_req_outbox_worker_reconcile",
      httpMethod: "GET",
      canonicalResourceUrl: "https://api.example.com/v1/data",
      amountRawUsdc: "500000",
      payTo: ADDRESSES.seller,
      sellerUsdcAta: ADDRESSES.sellerUsdcAta,
      dustRecipientUsdcAta: ADDRESSES.agentUsdcAta
    });
    const rawPayment = await service.ledger.getPayment(payment.paymentId);
    expect(rawPayment).not.toBeNull();
    await service.ledger.savePayment({
      ...rawPayment!,
      status: "submitted",
      submittedAt: new Date().toISOString(),
      txSignature: txSignatureFor(payment),
      submittedSerializedTransaction: serializedTransactionFor(payment)
    });

    const recovery = await service.recoverPendingSettlements();

    expect(recovery).toMatchObject({
      processed: 1,
      results: [
        {
          paymentId: payment.paymentId,
          recovered: true,
          response: {
            success: true,
            transaction: txSignatureFor(payment)
          }
        }
      ]
    });
    expect(submitter.calls).toBe(0);
    expect(submitter.reconcileCalls).toBe(1);
    expect((await service.getPayment(payment.paymentId)).status).toBe("settled");
  });

  it("rejects invalid settled results without mutating reserved budget", async () => {
    const submitter = new FakeSettlementSubmitter({
      status: "settled",
      txSignature: "settlement_signature",
      actualSharesRedeemedRaw: 500_001n
    });
    const service = await serviceWithSpendableYield({
      settlementSubmitter: submitter
    });
    const payment = await service.preparePayment({
      wallet: ADDRESSES.wallet,
      asset: SUBLY_VAULT.usdcMint,
      seller: ADDRESSES.seller,
      sellerRequestId: "seller_req_invalid_settled_result",
      httpMethod: "GET",
      canonicalResourceUrl: "https://api.example.com/v1/data",
      amountRawUsdc: "500000",
      payTo: ADDRESSES.seller,
      sellerUsdcAta: ADDRESSES.sellerUsdcAta,
      dustRecipientUsdcAta: ADDRESSES.agentUsdcAta
    });

    await expect(
      service.settlePaymentPayload({
        paymentId: payment.paymentId,
        requestBindingHash: payment.requestBindingHash,
        preparedMessageHash: payment.preparedMessageHash,
        ...payloadFor(payment)
      })
    ).rejects.toMatchObject({
      code: "settlement_result_invalid"
    });

    expect((await service.getPayment(payment.paymentId)).status).toBe("submitted");
    expect((await service.getPayment(payment.paymentId)).txSignature).toBe(
      txSignatureFor(payment)
    );
    expect((await service.getPayment(payment.paymentId)).settlementResponse).toMatchObject({
      success: false,
      latestError: {
        code: "settlement_result_invalid"
      }
    });
    expect(
      (await service.getBudget(ADDRESSES.wallet)).position.reservedRawUsdc
    ).toBe("600000");
    expect((await service.getBudget(ADDRESSES.wallet)).position.status).toBe(
      "needs_baseline_reset"
    );
  });

  it("rejects settled results that do not prove the exact seller transfer", async () => {
    const submitter = new FakeSettlementSubmitter({
      status: "settled",
      txSignature: "settlement_signature",
      sellerTransferRawUsdc: 499_999n,
      withdrawOutputRawUsdc: 500_000n,
      dustTransferRawUsdc: 1n
    });
    const service = await serviceWithSpendableYield({
      settlementSubmitter: submitter
    });
    const payment = await service.preparePayment({
      wallet: ADDRESSES.wallet,
      asset: SUBLY_VAULT.usdcMint,
      seller: ADDRESSES.seller,
      sellerRequestId: "seller_req_short_seller_transfer",
      httpMethod: "GET",
      canonicalResourceUrl: "https://api.example.com/v1/data",
      amountRawUsdc: "500000",
      payTo: ADDRESSES.seller,
      sellerUsdcAta: ADDRESSES.sellerUsdcAta,
      dustRecipientUsdcAta: ADDRESSES.agentUsdcAta
    });

    await expect(
      service.settlePaymentPayload({
        paymentId: payment.paymentId,
        requestBindingHash: payment.requestBindingHash,
        preparedMessageHash: payment.preparedMessageHash,
        ...payloadFor(payment)
      })
    ).rejects.toMatchObject({
      code: "settlement_result_invalid"
    });

    expect((await service.getPayment(payment.paymentId)).status).toBe("submitted");
    expect((await service.getBudget(ADDRESSES.wallet)).position.status).toBe(
      "needs_baseline_reset"
    );
  });

  it("flags the wallet for baseline reset when landed fee debt exceeds the prepared estimate", async () => {
    const submitter = new FakeSettlementSubmitter({
      status: "settled",
      txSignature: "settlement_signature",
      actualFeeDebtRawUsdc: 700_000n
    });
    const service = await serviceWithSpendableYield({
      settlementSubmitter: submitter
    });
    const payment = await service.preparePayment({
      wallet: ADDRESSES.wallet,
      asset: SUBLY_VAULT.usdcMint,
      seller: ADDRESSES.seller,
      sellerRequestId: "seller_req_fee_debt_over_estimate",
      httpMethod: "GET",
      canonicalResourceUrl: "https://api.example.com/v1/data",
      amountRawUsdc: "500000",
      payTo: ADDRESSES.seller,
      sellerUsdcAta: ADDRESSES.sellerUsdcAta,
      dustRecipientUsdcAta: ADDRESSES.agentUsdcAta
    });

    await expect(
      service.settlePaymentPayload({
        paymentId: payment.paymentId,
        requestBindingHash: payment.requestBindingHash,
        preparedMessageHash: payment.preparedMessageHash,
        ...payloadFor(payment)
      })
    ).resolves.toMatchObject({
      success: true,
      transaction: txSignatureFor(payment)
    });

    const budget = await service.getBudget(ADDRESSES.wallet);
    expect(budget.position.feeDebtRawUsdc).toBe("700000");
    expect(budget.position.reservedRawUsdc).toBe("0");
    expect(budget.position.status).toBe("needs_baseline_reset");
    await expect(
      service.preparePayment({
        wallet: ADDRESSES.wallet,
        asset: SUBLY_VAULT.usdcMint,
        seller: ADDRESSES.seller,
        sellerRequestId: "seller_req_after_fee_overrun",
        httpMethod: "GET",
        canonicalResourceUrl: "https://api.example.com/v1/data",
        amountRawUsdc: "1",
        payTo: ADDRESSES.seller,
        sellerUsdcAta: ADDRESSES.sellerUsdcAta,
        dustRecipientUsdcAta: ADDRESSES.agentUsdcAta
      })
    ).rejects.toMatchObject({
      code: "needs_baseline_reset"
    });
  });

  it("does not submit invalid settlement payloads", async () => {
    const submitter = new FakeSettlementSubmitter();
    const service = await serviceWithSpendableYield({
      settlementSubmitter: submitter
    });
    const payment = await service.preparePayment({
      wallet: ADDRESSES.wallet,
      asset: SUBLY_VAULT.usdcMint,
      seller: ADDRESSES.seller,
      sellerRequestId: "seller_req_invalid_settle",
      httpMethod: "GET",
      canonicalResourceUrl: "https://api.example.com/v1/data",
      amountRawUsdc: "500000",
      payTo: ADDRESSES.seller,
      sellerUsdcAta: ADDRESSES.sellerUsdcAta,
      dustRecipientUsdcAta: ADDRESSES.agentUsdcAta
    });

    await expect(
      service.settlePaymentPayload({
        paymentId: payment.paymentId,
        requestBindingHash: payment.requestBindingHash,
        preparedMessageHash: payment.preparedMessageHash,
        ...tamperedPayloadFor(payment)
      })
    ).resolves.toMatchObject({
      isValid: false,
      invalidReason: "message_hash_mismatch"
    });

    expect(submitter.calls).toBe(0);
    expect((await service.getPayment(payment.paymentId)).status).toBe("prepared");
    expect(
      (await service.getBudget(ADDRESSES.wallet)).position.reservedRawUsdc
    ).toBe("600000");
  });

  it("leaves prepared payments unchanged when settlement submitter is unavailable", async () => {
    const service = await serviceWithSpendableYield();
    const payment = await service.preparePayment({
      wallet: ADDRESSES.wallet,
      asset: SUBLY_VAULT.usdcMint,
      seller: ADDRESSES.seller,
      sellerRequestId: "seller_req_submitter_unavailable",
      httpMethod: "GET",
      canonicalResourceUrl: "https://api.example.com/v1/data",
      amountRawUsdc: "500000",
      payTo: ADDRESSES.seller,
      sellerUsdcAta: ADDRESSES.sellerUsdcAta,
      dustRecipientUsdcAta: ADDRESSES.agentUsdcAta
    });

    await expect(
      service.settlePaymentPayload({
        paymentId: payment.paymentId,
        requestBindingHash: payment.requestBindingHash,
        preparedMessageHash: payment.preparedMessageHash,
        ...payloadFor(payment)
      })
    ).rejects.toMatchObject({
      code: "settlement_submitter_unavailable"
    });

    expect((await service.getPayment(payment.paymentId)).status).toBe("prepared");
    expect(
      (await service.getBudget(ADDRESSES.wallet)).position.reservedRawUsdc
    ).toBe("600000");
  });

  it("does not persist or submit invalid signed transaction bytes from the submitter", async () => {
    const submitter = new InvalidPreparedSubmissionSubmitter();
    const service = await serviceWithSpendableYield({
      settlementSubmitter: submitter
    });
    const payment = await service.preparePayment({
      wallet: ADDRESSES.wallet,
      asset: SUBLY_VAULT.usdcMint,
      seller: ADDRESSES.seller,
      sellerRequestId: "seller_req_invalid_prepared_submission",
      httpMethod: "GET",
      canonicalResourceUrl: "https://api.example.com/v1/data",
      amountRawUsdc: "500000",
      payTo: ADDRESSES.seller,
      sellerUsdcAta: ADDRESSES.sellerUsdcAta,
      dustRecipientUsdcAta: ADDRESSES.agentUsdcAta
    });

    await expect(
      service.settlePaymentPayload({
        paymentId: payment.paymentId,
        requestBindingHash: payment.requestBindingHash,
        preparedMessageHash: payment.preparedMessageHash,
        ...payloadFor(payment)
      })
    ).rejects.toMatchObject({
      code: "submission_record_invalid"
    });

    expect(submitter.calls).toBe(0);
    const stored = await service.getPayment(payment.paymentId);
    expect(stored.status).toBe("prepared");
    expect(stored.submittedSerializedTransaction).toBeNull();
  });

  it("rejects signed payloads whose transaction does not match the prepared transaction", async () => {
    const service = await serviceWithSpendableYield();
    const payment = await service.preparePayment({
      wallet: ADDRESSES.wallet,
      asset: SUBLY_VAULT.usdcMint,
      seller: ADDRESSES.seller,
      sellerRequestId: "seller_req_payload_mismatch",
      httpMethod: "GET",
      canonicalResourceUrl: "https://api.example.com/v1/data",
      amountRawUsdc: "500000",
      payTo: ADDRESSES.seller,
      sellerUsdcAta: ADDRESSES.sellerUsdcAta,
      dustRecipientUsdcAta: ADDRESSES.agentUsdcAta
    });

    await expect(
      service.verifyPaymentPayload({
        paymentId: payment.paymentId,
        requestBindingHash: payment.requestBindingHash,
        preparedMessageHash: payment.preparedMessageHash,
        ...tamperedPayloadFor(payment)
      })
    ).resolves.toMatchObject({
      isValid: false,
      invalidReason: "message_hash_mismatch"
    });
  });

  it("rejects malformed serialized transaction payloads", async () => {
    const service = await serviceWithSpendableYield();
    const payment = await service.preparePayment({
      wallet: ADDRESSES.wallet,
      asset: SUBLY_VAULT.usdcMint,
      seller: ADDRESSES.seller,
      sellerRequestId: "seller_req_malformed_payload",
      httpMethod: "GET",
      canonicalResourceUrl: "https://api.example.com/v1/data",
      amountRawUsdc: "500000",
      payTo: ADDRESSES.seller,
      sellerUsdcAta: ADDRESSES.sellerUsdcAta,
      dustRecipientUsdcAta: ADDRESSES.agentUsdcAta
    });

    await expect(
      service.verifyPaymentPayload({
        paymentId: payment.paymentId,
        requestBindingHash: payment.requestBindingHash,
        preparedMessageHash: payment.preparedMessageHash,
        ...payloadFor(payment),
        serializedTransaction: "!!!!"
      })
    ).resolves.toMatchObject({
      isValid: false,
      invalidReason: "invalid_transaction_encoding"
    });
  });

  it("returns the existing payment for repeated sellerRequestId with the same binding", async () => {
    const wallet = ADDRESSES.wallet;
    const seller = ADDRESSES.seller;
    const service = await serviceWithSpendableYield();

    const first = await service.preparePayment({
      wallet,
      asset: SUBLY_VAULT.usdcMint,
      seller,
      sellerRequestId: "seller_req_idempotent",
      httpMethod: "GET",
      canonicalResourceUrl: "https://api.example.com/v1/data",
      amountRawUsdc: "500000",
      payTo: seller,
      sellerUsdcAta: ADDRESSES.sellerUsdcAta,
      dustRecipientUsdcAta: ADDRESSES.agentUsdcAta
    });
    const second = await service.preparePayment({
      wallet,
      asset: SUBLY_VAULT.usdcMint,
      seller,
      sellerRequestId: "seller_req_idempotent",
      httpMethod: "GET",
      canonicalResourceUrl: "https://api.example.com/v1/data",
      amountRawUsdc: "500000",
      payTo: seller,
      sellerUsdcAta: ADDRESSES.sellerUsdcAta,
      dustRecipientUsdcAta: ADDRESSES.agentUsdcAta
    });

    expect(second.paymentId).toBe(first.paymentId);
    expect((await service.getBudget(wallet)).position.reservedRawUsdc).toBe(
      "600000"
    );
  });

  it("does not re-estimate fees for idempotent prepare retries", async () => {
    const feeEstimator = new OneShotFeeEstimator(100_000n);
    const service = await serviceWithSpendableYield({ feeEstimator });

    const first = await service.preparePayment({
      wallet: ADDRESSES.wallet,
      asset: SUBLY_VAULT.usdcMint,
      seller: ADDRESSES.seller,
      sellerRequestId: "seller_req_idempotent_fee",
      httpMethod: "GET",
      canonicalResourceUrl: "https://api.example.com/v1/data",
      amountRawUsdc: "500000",
      payTo: ADDRESSES.seller,
      sellerUsdcAta: ADDRESSES.sellerUsdcAta,
      dustRecipientUsdcAta: ADDRESSES.agentUsdcAta
    });
    const second = await service.preparePayment({
      wallet: ADDRESSES.wallet,
      asset: SUBLY_VAULT.usdcMint,
      seller: ADDRESSES.seller,
      sellerRequestId: "seller_req_idempotent_fee",
      httpMethod: "GET",
      canonicalResourceUrl: "https://api.example.com/v1/data",
      amountRawUsdc: "500000",
      payTo: ADDRESSES.seller,
      sellerUsdcAta: ADDRESSES.sellerUsdcAta,
      dustRecipientUsdcAta: ADDRESSES.agentUsdcAta
    });

    expect(second.paymentId).toBe(first.paymentId);
    expect(feeEstimator.calls).toBe(1);
  });

  it("re-prepares the same sellerRequestId under a new paymentId after expiry", async () => {
    const service = await serviceWithSpendableYield({
      paymentExpirySeconds: 0
    });
    const request = {
      wallet: ADDRESSES.wallet,
      asset: SUBLY_VAULT.usdcMint,
      seller: ADDRESSES.seller,
      sellerRequestId: "seller_req_reprepare",
      httpMethod: "GET",
      canonicalResourceUrl: "https://api.example.com/v1/data",
      amountRawUsdc: "500000",
      payTo: ADDRESSES.seller,
      sellerUsdcAta: ADDRESSES.sellerUsdcAta,
      dustRecipientUsdcAta: ADDRESSES.agentUsdcAta
    };

    const first = await service.preparePayment(request);
    // The zero-second expiry makes the first intent terminal on the retry.
    const second = await service.preparePayment(request);

    expect(second.paymentId).not.toBe(first.paymentId);
    expect(second.status).toBe("prepared");
    expect((await service.getPayment(first.paymentId)).status).toBe("expired");

    // Reuse with a different binding stays rejected even after expiry.
    await expect(
      service.preparePayment({ ...request, amountRawUsdc: "600000" })
    ).rejects.toMatchObject({ code: "seller_request_id_reuse" });
  });

  it("keeps settled payments idempotent for the same sellerRequestId", async () => {
    const service = await serviceWithSpendableYield({
      settlementSubmitter: new FakeSettlementSubmitter({
        status: "settled",
        txSignature: "settlement_signature"
      })
    });
    const request = {
      wallet: ADDRESSES.wallet,
      asset: SUBLY_VAULT.usdcMint,
      seller: ADDRESSES.seller,
      sellerRequestId: "seller_req_settled_idempotent",
      httpMethod: "GET",
      canonicalResourceUrl: "https://api.example.com/v1/data",
      amountRawUsdc: "500000",
      payTo: ADDRESSES.seller,
      sellerUsdcAta: ADDRESSES.sellerUsdcAta,
      dustRecipientUsdcAta: ADDRESSES.agentUsdcAta
    };
    const payment = await service.preparePayment(request);
    await service.settlePaymentPayload({
      paymentId: payment.paymentId,
      requestBindingHash: payment.requestBindingHash,
      preparedMessageHash: payment.preparedMessageHash,
      ...payloadFor(payment)
    });

    const retried = await service.preparePayment(request);
    expect(retried.paymentId).toBe(payment.paymentId);
    expect(retried.status).toBe("settled");
  });

  it("records sync events for syncs and settlements", async () => {
    const service = await serviceWithSpendableYield({
      settlementSubmitter: new FakeSettlementSubmitter({
        status: "settled",
        txSignature: "settlement_signature"
      })
    });
    const payment = await service.preparePayment({
      wallet: ADDRESSES.wallet,
      asset: SUBLY_VAULT.usdcMint,
      seller: ADDRESSES.seller,
      sellerRequestId: "seller_req_sync_events",
      httpMethod: "GET",
      canonicalResourceUrl: "https://api.example.com/v1/data",
      amountRawUsdc: "500000",
      payTo: ADDRESSES.seller,
      sellerUsdcAta: ADDRESSES.sellerUsdcAta,
      dustRecipientUsdcAta: ADDRESSES.agentUsdcAta
    });
    await service.settlePaymentPayload({
      paymentId: payment.paymentId,
      requestBindingHash: payment.requestBindingHash,
      preparedMessageHash: payment.preparedMessageHash,
      ...payloadFor(payment)
    });

    const { events } = await service.listSyncEvents(ADDRESSES.wallet);
    const types = events.map((event) => event.eventType);
    expect(types).toContain("wallet_sync");
    expect(types).toContain("payment_settled");
    const settled = events.find((event) => event.eventType === "payment_settled");
    expect(settled?.deltaSharesRaw).toBe("-500000");
    expect(settled?.txSignature).toBe(txSignatureFor(payment));
  });

  it("rejects sellerRequestId reuse with a different request binding", async () => {
    const wallet = ADDRESSES.wallet;
    const seller = ADDRESSES.seller;
    const service = await serviceWithSpendableYield();

    await service.preparePayment({
      wallet,
      asset: SUBLY_VAULT.usdcMint,
      seller,
      sellerRequestId: "seller_req_reuse",
      httpMethod: "GET",
      canonicalResourceUrl: "https://api.example.com/v1/data",
      amountRawUsdc: "500000",
      payTo: seller,
      sellerUsdcAta: ADDRESSES.sellerUsdcAta,
      dustRecipientUsdcAta: ADDRESSES.agentUsdcAta
    });

    await expect(
      service.preparePayment({
        wallet,
        asset: SUBLY_VAULT.usdcMint,
        seller,
        sellerRequestId: "seller_req_reuse",
        httpMethod: "GET",
        canonicalResourceUrl: "https://api.example.com/v1/data",
        amountRawUsdc: "600000",
        payTo: seller,
        sellerUsdcAta: ADDRESSES.sellerUsdcAta,
        dustRecipientUsdcAta: ADDRESSES.agentUsdcAta
      })
    ).rejects.toMatchObject({
      code: "seller_request_id_reuse"
    });
  });

  it("rejects a seller USDC token account that is not the payTo ATA", async () => {
    const service = await serviceWithSpendableYield();

    await service.preparePayment({
      wallet: ADDRESSES.wallet,
      asset: SUBLY_VAULT.usdcMint,
      seller: ADDRESSES.seller,
      sellerRequestId: "seller_req_reuse_token_account",
      httpMethod: "GET",
      canonicalResourceUrl: "https://api.example.com/v1/data",
      amountRawUsdc: "500000",
      payTo: ADDRESSES.seller,
      sellerUsdcAta: ADDRESSES.sellerUsdcAta,
      dustRecipientUsdcAta: ADDRESSES.agentUsdcAta
    });

    await expect(
      service.preparePayment({
        wallet: ADDRESSES.wallet,
        asset: SUBLY_VAULT.usdcMint,
        seller: ADDRESSES.seller,
        sellerRequestId: "seller_req_reuse_token_account",
        httpMethod: "GET",
        canonicalResourceUrl: "https://api.example.com/v1/data",
        amountRawUsdc: "500000",
        payTo: ADDRESSES.seller,
        sellerUsdcAta: ADDRESSES.agentUsdcAta,
        dustRecipientUsdcAta: ADDRESSES.agentUsdcAta
      })
    ).rejects.toMatchObject({
      code: "seller_ata_mismatch"
    });
  });

  it("rejects a dust recipient that is not the agent wallet USDC ATA", async () => {
    const service = await serviceWithSpendableYield();

    await expect(
      service.preparePayment({
        wallet: ADDRESSES.wallet,
        asset: SUBLY_VAULT.usdcMint,
        seller: ADDRESSES.seller,
        sellerRequestId: "seller_req_invalid_dust_recipient",
        httpMethod: "GET",
        canonicalResourceUrl: "https://api.example.com/v1/data",
        amountRawUsdc: "500000",
        payTo: ADDRESSES.seller,
        sellerUsdcAta: ADDRESSES.sellerUsdcAta,
        dustRecipientUsdcAta: ADDRESSES.sellerUsdcAta
      })
    ).rejects.toMatchObject({
      code: "dust_recipient_ata_mismatch"
    });
  });

  it("normalizes sha256-empty to the canonical empty body hash", async () => {
    const service = await serviceWithSpendableYield();

    const payment = await service.preparePayment({
      wallet: ADDRESSES.wallet,
      asset: SUBLY_VAULT.usdcMint,
      seller: ADDRESSES.seller,
      sellerRequestId: "seller_req_empty_hash",
      httpMethod: "GET",
      canonicalResourceUrl: "https://api.example.com/v1/data",
      requestBodyHash: "sha256-empty",
      amountRawUsdc: "500000",
      payTo: ADDRESSES.seller,
      sellerUsdcAta: ADDRESSES.sellerUsdcAta,
      dustRecipientUsdcAta: ADDRESSES.agentUsdcAta
    });

    expect(payment.requestBodyHash).toMatch(/^sha256-[a-f0-9]{64}$/);
  });

  it("ignores client-supplied fee estimates and uses the facilitator config", async () => {
    const service = await serviceWithSpendableYield();

    const payment = await service.preparePayment({
      wallet: ADDRESSES.wallet,
      asset: SUBLY_VAULT.usdcMint,
      seller: ADDRESSES.seller,
      sellerRequestId: "seller_req_fee",
      httpMethod: "GET",
      canonicalResourceUrl: "https://api.example.com/v1/data",
      amountRawUsdc: "500000",
      payTo: ADDRESSES.seller,
      sellerUsdcAta: ADDRESSES.sellerUsdcAta,
      dustRecipientUsdcAta: ADDRESSES.agentUsdcAta,
      estimatedFeeDebtRawUsdc: "0"
    } as Parameters<SublyService["preparePayment"]>[0] & {
      estimatedFeeDebtRawUsdc: string;
    });

    expect(payment.estimatedFeeDebtRawUsdc).toBe("100000");
    expect(payment.reservationRawUsdc).toBe("600000");
  });

  it("releases expired prepared reservations during budget cleanup", async () => {
    const service = await serviceWithSpendableYield({
      paymentExpirySeconds: -1
    });

    const payment = await service.preparePayment({
      wallet: ADDRESSES.wallet,
      asset: SUBLY_VAULT.usdcMint,
      seller: ADDRESSES.seller,
      sellerRequestId: "seller_req_expired_cleanup",
      httpMethod: "GET",
      canonicalResourceUrl: "https://api.example.com/v1/data",
      amountRawUsdc: "500000",
      payTo: ADDRESSES.seller,
      sellerUsdcAta: ADDRESSES.sellerUsdcAta,
      dustRecipientUsdcAta: ADDRESSES.agentUsdcAta
    });

    expect(
      (
        await service.ledger.getPosition(
          ADDRESSES.wallet,
          SUBLY_VAULT.address
        )
      )?.reservedRawUsdc
    ).toBe(600000n);

    const budget = await service.getBudget(ADDRESSES.wallet);

    expect(budget.position.reservedRawUsdc).toBe("0");
    expect((await service.getPayment(payment.paymentId)).status).toBe("expired");
  });

  it("expires prepared reservations before a conservative baseline reset", async () => {
    const service = await serviceWithSpendableYield();
    const payment = await service.preparePayment({
      wallet: ADDRESSES.wallet,
      asset: SUBLY_VAULT.usdcMint,
      seller: ADDRESSES.seller,
      sellerRequestId: "seller_req_reset",
      httpMethod: "GET",
      canonicalResourceUrl: "https://api.example.com/v1/data",
      amountRawUsdc: "500000",
      payTo: ADDRESSES.seller,
      sellerUsdcAta: ADDRESSES.sellerUsdcAta,
      dustRecipientUsdcAta: ADDRESSES.agentUsdcAta
    });

    expect(
      (await service.getBudget(ADDRESSES.wallet)).position.reservedRawUsdc
    ).toBe("600000");

    const synced = await service.syncWalletPosition({
      wallet: ADDRESSES.wallet,
      totalSharesRaw: "101000000",
      exchangeRateScaled: "1000000000000",
      instantRedeemCapacityRawUsdc: "1000000",
      forceConservativeReset: true
    });

    expect(synced.position.reservedRawUsdc).toBe("0");
    expect(synced.position.principalBasisRawUsdc).toBe("101000000");
    expect((await service.getPayment(payment.paymentId)).status).toBe("expired");
    await expect(
      service.verifyPaymentPayload({
        paymentId: payment.paymentId,
        requestBindingHash: payment.requestBindingHash,
        preparedMessageHash: payment.preparedMessageHash,
        ...payloadFor(payment)
      })
    ).resolves.toMatchObject({
      isValid: false,
      invalidReason: "expired"
    });
  });

  it("floors manual sync basis at the value of newly observed external shares", async () => {
    const service = await serviceWithSpendableYield({
      totalSharesRaw: "100000000",
      principalBasisRawUsdc: "100000000",
      instantRedeemCapacityRawUsdc: "10000000"
    });

    const synced = await service.syncWalletPosition({
      wallet: ADDRESSES.wallet,
      totalSharesRaw: "150000000",
      exchangeRateScaled: "1000000000000",
      instantRedeemCapacityRawUsdc: "10000000",
      principalBasisRawUsdc: "120000000",
      principalBasisSource: "kamino_pnl_current"
    });

    expect(synced.position.principalBasisRawUsdc).toBe("150000000");
    expect(synced.budget.spendableYieldRawUsdc).toBe("0");
  });

  it("runs a conservative reset on manual sync when shares move without trusted basis", async () => {
    const service = await serviceWithSpendableYield({
      totalSharesRaw: "100000000",
      principalBasisRawUsdc: "100000000",
      instantRedeemCapacityRawUsdc: "10000000"
    });

    const synced = await service.syncWalletPosition({
      wallet: ADDRESSES.wallet,
      totalSharesRaw: "150000000",
      exchangeRateScaled: "1000000000000",
      instantRedeemCapacityRawUsdc: "10000000"
    });

    expect(synced.position.principalBasisSource).toBe(
      "conservative_activation_reset"
    );
    expect(synced.position.principalBasisRawUsdc).toBe("150000000");
    expect(synced.budget.spendableYieldRawUsdc).toBe("0");
  });

  it("runs a conservative reset on manual sync when shares decrease externally", async () => {
    const service = await serviceWithSpendableYield({
      totalSharesRaw: "100000000",
      principalBasisRawUsdc: "90000000",
      instantRedeemCapacityRawUsdc: "10000000"
    });

    const synced = await service.syncWalletPosition({
      wallet: ADDRESSES.wallet,
      totalSharesRaw: "80000000",
      exchangeRateScaled: "1000000000000",
      instantRedeemCapacityRawUsdc: "10000000",
      principalBasisRawUsdc: "95000000",
      principalBasisSource: "kamino_pnl_current"
    });

    expect(synced.position.principalBasisSource).toBe(
      "conservative_activation_reset"
    );
    expect(synced.position.principalBasisRawUsdc).toBe("80000000");
    expect(synced.budget.spendableYieldRawUsdc).toBe("0");
  });

  it("blocks conservative baseline reset while a submitted payment is active", async () => {
    const service = await serviceWithSpendableYield();
    const payment = await service.preparePayment({
      wallet: ADDRESSES.wallet,
      asset: SUBLY_VAULT.usdcMint,
      seller: ADDRESSES.seller,
      sellerRequestId: "seller_req_submitted",
      httpMethod: "GET",
      canonicalResourceUrl: "https://api.example.com/v1/data",
      amountRawUsdc: "500000",
      payTo: ADDRESSES.seller,
      sellerUsdcAta: ADDRESSES.sellerUsdcAta,
      dustRecipientUsdcAta: ADDRESSES.agentUsdcAta
    });
    const rawPayment = await service.ledger.getPayment(payment.paymentId);
    expect(rawPayment).not.toBeNull();
    await service.ledger.savePayment({
      ...rawPayment!,
      status: "submitted",
      submittedAt: new Date().toISOString()
    });

    await expect(
      service.syncWalletPosition({
        wallet: ADDRESSES.wallet,
        totalSharesRaw: "101000000",
        exchangeRateScaled: "1000000000000",
        instantRedeemCapacityRawUsdc: "1000000",
        forceConservativeReset: true
      })
    ).rejects.toMatchObject({
      code: "submitted_payment_active"
    });

    expect(
      (await service.getBudget(ADDRESSES.wallet)).position.reservedRawUsdc
    ).toBe("600000");
  });

  it("does not allow sync input to clear needs_baseline_reset without force reset", async () => {
    const service = await serviceWithSpendableYield();
    const position = await service.ledger.getPosition(
      ADDRESSES.wallet,
      SUBLY_VAULT.address
    );
    expect(position).not.toBeNull();
    await service.ledger.savePosition({
      ...position!,
      status: "needs_baseline_reset"
    });

    const synced = await service.syncWalletPosition({
      wallet: ADDRESSES.wallet,
      totalSharesRaw: "101000000",
      exchangeRateScaled: "1000000000000",
      instantRedeemCapacityRawUsdc: "1000000",
      status: "active"
    } as Parameters<SublyService["syncWalletPosition"]>[0] & {
      status: "active";
    });

    expect(synced.position.status).toBe("needs_baseline_reset");
  });

  it("does not allow signer updates to clear needs_baseline_reset", async () => {
    const service = await serviceWithSpendableYield();
    const position = await service.ledger.getPosition(
      ADDRESSES.wallet,
      SUBLY_VAULT.address
    );
    expect(position).not.toBeNull();
    await service.ledger.savePosition({
      ...position!,
      status: "needs_baseline_reset"
    });

    const observedUpdate = await service.registerAgentWallet({
      wallet: ADDRESSES.wallet,
      signingPolicyId: "policy_observed",
      signingMode: "observed_only"
    });
    expect(observedUpdate.status).toBe("needs_baseline_reset");

    const activatedUpdate = await service.registerAgentWallet({
      wallet: ADDRESSES.wallet,
      signingPolicyId: "policy_active",
      signerProvider: "privy",
      activateForPayments: true
    });
    expect(activatedUpdate.status).toBe("needs_baseline_reset");

    await expect(
      service.preparePayment({
        wallet: ADDRESSES.wallet,
        asset: SUBLY_VAULT.usdcMint,
        seller: ADDRESSES.seller,
        sellerRequestId: "seller_req_needs_reset_signer_update",
        httpMethod: "GET",
        canonicalResourceUrl: "https://api.example.com/v1/data",
        amountRawUsdc: "1",
        payTo: ADDRESSES.seller,
        sellerUsdcAta: ADDRESSES.sellerUsdcAta,
        dustRecipientUsdcAta: ADDRESSES.agentUsdcAta
      })
    ).rejects.toMatchObject({
      code: "needs_baseline_reset"
    });
  });

  it("keeps observed-only wallets observed until explicit signer activation", async () => {
    const service = new SublyService();
    await service.registerAgentWallet({
      wallet: ADDRESSES.wallet,
      signingPolicyId: "policy_1",
      signingMode: "observed_only"
    });

    const stillObserved = await service.registerAgentWallet({
      wallet: ADDRESSES.wallet,
      signingPolicyId: "policy_2"
    });
    expect(stillObserved.status).toBe("observed_only");

    await expect(
      service.registerAgentWallet({
        wallet: ADDRESSES.wallet,
        signingPolicyId: "policy_3",
        activateForPayments: true
      })
    ).rejects.toMatchObject({
      code: "signer_provider_missing"
    });

    const active = await service.registerAgentWallet({
      wallet: ADDRESSES.wallet,
      signingPolicyId: "policy_4",
      signerProvider: "privy",
      activateForPayments: true
    });
    expect(active.status).toBe("active");
  });

  it("keeps observed-only wallets observed after conservative reset", async () => {
    const builder = new FakeTransactionBuilder();
    const service = new SublyService({
      transactionBuilder: builder,
      config: {
        defaultEstimatedFeeDebtRawUsdc: 100_000n
      }
    });
    await service.registerAgentWallet({
      wallet: ADDRESSES.wallet,
      signingPolicyId: "policy_observed",
      signingMode: "observed_only",
      signerProvider: "privy"
    });

    const synced = await service.syncWalletPosition({
      wallet: ADDRESSES.wallet,
      totalSharesRaw: "101000000",
      exchangeRateScaled: "1000000000000",
      instantRedeemCapacityRawUsdc: "1000000",
      forceConservativeReset: true
    });

    expect(synced.position.status).toBe("observed_only");
    await expect(
      service.preparePayment({
        wallet: ADDRESSES.wallet,
        asset: SUBLY_VAULT.usdcMint,
        seller: ADDRESSES.seller,
        sellerRequestId: "seller_req_observed_reset",
        httpMethod: "GET",
        canonicalResourceUrl: "https://api.example.com/v1/data",
        amountRawUsdc: "1",
        payTo: ADDRESSES.seller,
        sellerUsdcAta: ADDRESSES.sellerUsdcAta,
        dustRecipientUsdcAta: ADDRESSES.agentUsdcAta
      })
    ).rejects.toMatchObject({
      code: "observed_only"
    });
    expect(builder.calls).toBe(0);
  });

  it("blocks payment preparation when signing mode is observed-only even if status is active", async () => {
    const builder = new FakeTransactionBuilder();
    const service = await serviceWithSpendableYield({
      transactionBuilder: builder
    });
    const position = await service.ledger.getPosition(
      ADDRESSES.wallet,
      SUBLY_VAULT.address
    );
    expect(position).not.toBeNull();
    await service.ledger.savePosition({
      ...position!,
      signingMode: "observed_only",
      status: "active"
    });

    await expect(
      service.preparePayment({
        wallet: ADDRESSES.wallet,
        asset: SUBLY_VAULT.usdcMint,
        seller: ADDRESSES.seller,
        sellerRequestId: "seller_req_observed_active",
        httpMethod: "GET",
        canonicalResourceUrl: "https://api.example.com/v1/data",
        amountRawUsdc: "1",
        payTo: ADDRESSES.seller,
        sellerUsdcAta: ADDRESSES.sellerUsdcAta,
        dustRecipientUsdcAta: ADDRESSES.agentUsdcAta
      })
    ).rejects.toMatchObject({
      code: "observed_only"
    });
    expect(builder.calls).toBe(0);
  });

  it("rejects inconsistent share totals before storing a corrupt position", async () => {
    const service = await serviceWithSpendableYield();

    await expect(
      service.syncWalletPosition({
        wallet: ADDRESSES.wallet,
        totalSharesRaw: "100",
        stakedSharesRaw: "101",
        exchangeRateScaled: "1000000000000",
        instantRedeemCapacityRawUsdc: "1000000"
      })
    ).rejects.toMatchObject({
      code: "share_total_mismatch"
    });

    expect((await service.getBudget(ADDRESSES.wallet)).position.totalSharesRaw).toBe(
      "101000000"
    );
  });

  it("preserves safety buffer when only the signing policy is updated", async () => {
    const service = new SublyService();
    await service.registerAgentWallet({
      wallet: ADDRESSES.wallet,
      signingPolicyId: "policy_1",
      safetyBufferRawUsdc: "123"
    });

    const updated = await service.registerAgentWallet({
      wallet: ADDRESSES.wallet,
      signingPolicyId: "policy_2"
    });

    expect(updated.safetyBufferRawUsdc).toBe("123");
  });

  it("returns a domain 400 for invalid Solana addresses", async () => {
    const service = new SublyService();

    await expect(
      service.registerAgentWallet({
        wallet: "not-a-pubkey",
        signingPolicyId: "policy_1"
      })
    ).rejects.toMatchObject({
      code: "invalid_solana_address",
      httpStatus: 400
    });
  });

  it("rejects implicit static fee estimation in production", () => {
    withTemporaryEnv(
      {
        NODE_ENV: "production",
        SUBLY_ESTIMATED_FEE_LAMPORTS: undefined,
        SUBLY_SOL_USDC_PRICE_SCALED: undefined,
        SUBLY_PRICE_SCALE: undefined,
        SUBLY_FEE_OBSERVED_AT: undefined
      },
      () => {
        let thrown: unknown;
        try {
          new SublyService({
            ledger: new InMemoryLedger()
          });
        } catch (error) {
          thrown = error;
        }

        expect(thrown).toMatchObject({
          code: "fee_estimator_not_configured"
        });
      }
    );
  });

  it("keeps unconfigured signer wallets observed-only and blocks payment preparation", async () => {
    const wallet = ADDRESSES.wallet;
    const seller = ADDRESSES.seller;
    const builder = new FakeTransactionBuilder();
    const service = new SublyService({
      transactionBuilder: builder,
      config: {
        defaultEstimatedFeeDebtRawUsdc: 100_000n
      }
    });

    await service.registerAgentWallet({
      wallet,
      signingPolicyId: "policy_1"
    });
    await service.syncWalletPosition({
      wallet,
      totalSharesRaw: "101000000",
      exchangeRateScaled: "1000000000000",
      instantRedeemCapacityRawUsdc: "1000000",
      principalBasisRawUsdc: "100000000",
      principalBasisSource: "kamino_pnl_current"
    });

    expect((await service.getBudget(wallet)).position.status).toBe(
      "observed_only"
    );

    await expect(
      service.preparePayment({
        wallet,
        asset: SUBLY_VAULT.usdcMint,
        seller,
        sellerRequestId: "seller_req_missing_signer_provider",
        httpMethod: "GET",
        canonicalResourceUrl: "https://api.example.com/v1/data",
        amountRawUsdc: "500000",
        payTo: seller,
        sellerUsdcAta: ADDRESSES.sellerUsdcAta,
        dustRecipientUsdcAta: ADDRESSES.agentUsdcAta
      })
    ).rejects.toMatchObject({
      code: "observed_only"
    });

    expect(builder.calls).toBe(0);
    expect((await service.getBudget(wallet)).position.reservedRawUsdc).toBe("0");
  });

  it("blocks production payments unless signer transaction validation is attested", async () => {
    await withTemporaryEnvAsync(
      {
        NODE_ENV: "production"
      },
      async () => {
        const builder = new FakeTransactionBuilder();
        const service = new SublyService({
          ledger: new InMemoryLedger(),
          transactionBuilder: builder,
          feeEstimator: new OneShotFeeEstimator(100_000n),
          settlementSubmitter: new FakeSettlementSubmitter(),
          config: {
            sponsorFeePayer: ADDRESSES.wallet
          }
        });

        await service.registerAgentWallet({
          wallet: ADDRESSES.wallet,
          signingPolicyId: "policy_1",
          signerProvider: "privy"
        });
        await service.syncWalletPosition({
          wallet: ADDRESSES.wallet,
          totalSharesRaw: "101000000",
          exchangeRateScaled: "1000000000000",
          instantRedeemCapacityRawUsdc: "1000000",
          principalBasisRawUsdc: "100000000",
          principalBasisSource: "kamino_pnl_current"
        });

        await expect(
          service.preparePayment({
            wallet: ADDRESSES.wallet,
            asset: SUBLY_VAULT.usdcMint,
            seller: ADDRESSES.seller,
            sellerRequestId: "seller_req_unverified_signer_policy",
            httpMethod: "GET",
            canonicalResourceUrl: "https://api.example.com/v1/data",
            amountRawUsdc: "500000",
            payTo: ADDRESSES.seller,
            sellerUsdcAta: ADDRESSES.sellerUsdcAta,
            dustRecipientUsdcAta: ADDRESSES.agentUsdcAta
          })
        ).rejects.toMatchObject({
          code: "signer_policy_validation_missing"
        });

        expect(builder.calls).toBe(0);
      }
    );
  });

  it("rejects missing sponsor fee payer in production", () => {
    withTemporaryEnv(
      {
        NODE_ENV: "production"
      },
      () => {
        let thrown: unknown;
        try {
          new SublyService({
            ledger: new InMemoryLedger(),
            feeEstimator: new OneShotFeeEstimator(100_000n)
          });
        } catch (error) {
          thrown = error;
        }

        expect(thrown).toMatchObject({
          code: "sponsor_fee_payer_not_configured"
        });
      }
    );
  });

  it("does not reserve when the settlement transaction builder is unavailable", async () => {
    const wallet = ADDRESSES.wallet;
    const seller = ADDRESSES.seller;
    const service = new SublyService({
      config: {
        defaultEstimatedFeeDebtRawUsdc: 100_000n
      }
    });

    await service.registerAgentWallet({
      wallet,
      signingPolicyId: "policy_1",
      signerProvider: "local_test"
    });
    await service.syncWalletPosition({
      wallet,
      totalSharesRaw: "101000000",
      exchangeRateScaled: "1000000000000",
      instantRedeemCapacityRawUsdc: "1000000",
      principalBasisRawUsdc: "100000000",
      principalBasisSource: "kamino_pnl_current"
    });

    await expect(
      service.preparePayment({
        wallet,
        asset: SUBLY_VAULT.usdcMint,
        seller,
        sellerRequestId: "seller_req_1",
        httpMethod: "GET",
        canonicalResourceUrl: "https://api.example.com/v1/data",
        amountRawUsdc: "500000",
        payTo: seller,
        sellerUsdcAta: ADDRESSES.sellerUsdcAta,
        dustRecipientUsdcAta: ADDRESSES.agentUsdcAta
      })
    ).rejects.toMatchObject({
      code: "transaction_builder_unavailable"
    });

    const budget = await service.getBudget(wallet);
    expect(budget.position.reservedRawUsdc).toBe("0");
  });

  it("does not reserve when the settlement transaction builder returns invalid prepared data", async () => {
    const wallet = ADDRESSES.wallet;
    const seller = ADDRESSES.seller;
    const builder = new InvalidTransactionBuilder({
      serializedTransaction: ""
    });
    const service = new SublyService({
      transactionBuilder: builder,
      config: {
        defaultEstimatedFeeDebtRawUsdc: 100_000n
      }
    });

    await service.registerAgentWallet({
      wallet,
      signingPolicyId: "policy_1",
      signerProvider: "local_test"
    });
    await service.syncWalletPosition({
      wallet,
      totalSharesRaw: "101000000",
      exchangeRateScaled: "1000000000000",
      instantRedeemCapacityRawUsdc: "1000000",
      principalBasisRawUsdc: "100000000",
      principalBasisSource: "kamino_pnl_current"
    });

    await expect(
      service.preparePayment({
        wallet,
        asset: SUBLY_VAULT.usdcMint,
        seller,
        sellerRequestId: "seller_req_invalid_prepared_transaction",
        httpMethod: "GET",
        canonicalResourceUrl: "https://api.example.com/v1/data",
        amountRawUsdc: "500000",
        payTo: seller,
        sellerUsdcAta: ADDRESSES.sellerUsdcAta,
        dustRecipientUsdcAta: ADDRESSES.agentUsdcAta
      })
    ).rejects.toMatchObject({
      code: "transaction_builder_invalid"
    });

    expect(builder.calls).toBe(1);
    const budget = await service.getBudget(wallet);
    expect(budget.position.reservedRawUsdc).toBe("0");
  });

  it("does not reserve when the settlement transaction builder returns a mismatched message hash", async () => {
    const wallet = ADDRESSES.wallet;
    const seller = ADDRESSES.seller;
    const builder = new InvalidTransactionBuilder({
      preparedMessageHash: `sha256-${"0".repeat(64)}`
    });
    const service = new SublyService({
      transactionBuilder: builder,
      config: {
        defaultEstimatedFeeDebtRawUsdc: 100_000n
      }
    });

    await service.registerAgentWallet({
      wallet,
      signingPolicyId: "policy_1",
      signerProvider: "local_test"
    });
    await service.syncWalletPosition({
      wallet,
      totalSharesRaw: "101000000",
      exchangeRateScaled: "1000000000000",
      instantRedeemCapacityRawUsdc: "1000000",
      principalBasisRawUsdc: "100000000",
      principalBasisSource: "kamino_pnl_current"
    });

    await expect(
      service.preparePayment({
        wallet,
        asset: SUBLY_VAULT.usdcMint,
        seller,
        sellerRequestId: "seller_req_mismatched_hash",
        httpMethod: "GET",
        canonicalResourceUrl: "https://api.example.com/v1/data",
        amountRawUsdc: "500000",
        payTo: seller,
        sellerUsdcAta: ADDRESSES.sellerUsdcAta,
        dustRecipientUsdcAta: ADDRESSES.agentUsdcAta
      })
    ).rejects.toMatchObject({
      code: "transaction_builder_invalid"
    });

    const budget = await service.getBudget(wallet);
    expect(budget.position.reservedRawUsdc).toBe("0");
  });

  it("rejects missing transaction builder in production", () => {
    withTemporaryEnv(
      {
        NODE_ENV: "production"
      },
      () => {
        let thrown: unknown;
        try {
          new SublyService({
            ledger: new InMemoryLedger(),
            feeEstimator: new OneShotFeeEstimator(100_000n),
            settlementSubmitter: new FakeSettlementSubmitter(),
            config: {
              sponsorFeePayer: ADDRESSES.wallet
            }
          });
        } catch (error) {
          thrown = error;
        }

        expect(thrown).toMatchObject({
          code: "transaction_builder_not_configured"
        });
      }
    );
  });

  it("rejects missing settlement submitter in production", () => {
    withTemporaryEnv(
      {
        NODE_ENV: "production"
      },
      () => {
        let thrown: unknown;
        try {
          new SublyService({
            ledger: new InMemoryLedger(),
            feeEstimator: new OneShotFeeEstimator(100_000n),
            transactionBuilder: new FakeTransactionBuilder(),
            config: {
              sponsorFeePayer: ADDRESSES.wallet
            }
          });
        } catch (error) {
          thrown = error;
        }

        expect(thrown).toMatchObject({
          code: "settlement_submitter_not_configured"
        });
      }
    );
  });
});

describe("SublyService on-chain quote and liquidity policy", () => {
  const basePreparePayment = {
    wallet: () => ADDRESSES.wallet,
    asset: SUBLY_VAULT.usdcMint,
    seller: () => ADDRESSES.seller,
    httpMethod: "GET",
    canonicalResourceUrl: "https://api.example.com/v1/data"
  };

  function prepareInput(sellerRequestId: string, amountRawUsdc = "500000") {
    return {
      wallet: basePreparePayment.wallet(),
      asset: basePreparePayment.asset,
      seller: basePreparePayment.seller(),
      sellerRequestId,
      httpMethod: basePreparePayment.httpMethod,
      canonicalResourceUrl: basePreparePayment.canonicalResourceUrl,
      amountRawUsdc,
      payTo: ADDRESSES.seller,
      sellerUsdcAta: ADDRESSES.sellerUsdcAta,
      dustRecipientUsdcAta: ADDRESSES.agentUsdcAta
    };
  }

  it("uses the quote as payment-critical state and stores quote shares", async () => {
    const builder = new FakeQuoteBuilder({
      requiredWithdrawRawUsdc: 502_000n,
      sharesToRedeemRaw: 502_004n,
      userUnstakedSharesRaw: 101_000_000n,
      userTotalSharesRaw: 101_000_000n,
      exchangeRateScaled: 1_000_000_000_000n,
      instantRedeemCapacityRawUsdc: 900_000n
    });
    const service = await serviceWithSpendableYield({
      transactionBuilder: builder
    });

    const payment = await service.preparePayment(prepareInput("quote_req_1"));
    expect(builder.quoteCalls).toBe(1);
    expect(payment.sharesToRedeemRaw).toBe("502004");
    expect(payment.requiredWithdrawRawUsdc).toBe("502000");

    const budget = await service.getBudget(ADDRESSES.wallet);
    expect(budget.position.instantRedeemCapacityRawUsdc).toBe("900000");
  });

  it("flags needs_baseline_reset when on-chain shares differ from the ledger", async () => {
    const builder = new FakeQuoteBuilder({
      userUnstakedSharesRaw: 90_000_000n,
      userTotalSharesRaw: 90_000_000n
    });
    const service = await serviceWithSpendableYield({
      transactionBuilder: builder
    });

    await expect(
      service.preparePayment(prepareInput("quote_req_mismatch"))
    ).rejects.toMatchObject({ code: "needs_baseline_reset" });

    const position = await service.ledger.getPosition(
      ADDRESSES.wallet,
      SUBLY_VAULT.address
    );
    expect(position?.status).toBe("needs_baseline_reset");
  });

  it("rejects when the quoted gross withdraw exceeds quoted instant capacity", async () => {
    const builder = new FakeQuoteBuilder({
      requiredWithdrawRawUsdc: 502_000n,
      sharesToRedeemRaw: 502_004n,
      userUnstakedSharesRaw: 101_000_000n,
      userTotalSharesRaw: 101_000_000n,
      instantRedeemCapacityRawUsdc: 400_000n
    });
    const service = await serviceWithSpendableYield({
      transactionBuilder: builder
    });

    await expect(
      service.preparePayment(prepareInput("quote_req_illiquid"))
    ).rejects.toMatchObject({ code: "budget_illiquid" });
  });

  it("enforces the seller liquidity policy amount cap", async () => {
    const service = await serviceWithSpendableYield();
    await service.upsertLiquidityPolicy({
      sellerClass: "default",
      expectedPaymentSizeRawUsdc: "100000",
      minInstantLiquidityRawUsdc: "0",
      targetBudgetIlliquidRate: 0.01
    });

    await expect(
      service.preparePayment(prepareInput("policy_req_1"))
    ).rejects.toMatchObject({ code: "amount_exceeds_policy" });
  });

  it("rejects payments when instant liquidity is below the policy minimum", async () => {
    const service = await serviceWithSpendableYield({
      instantRedeemCapacityRawUsdc: "600000"
    });
    await service.upsertLiquidityPolicy({
      sellerClass: "default",
      expectedPaymentSizeRawUsdc: "1000000",
      minInstantLiquidityRawUsdc: "700000",
      targetBudgetIlliquidRate: 0.01
    });

    await expect(
      service.preparePayment(prepareInput("policy_req_2"))
    ).rejects.toMatchObject({ code: "budget_illiquid" });
  });

  it("rejects payments while a vault flow is pending", async () => {
    const service = await serviceWithSpendableYield();
    await service.ledger.saveDeposit({
      depositId: "dep_pending",
      wallet: ADDRESSES.wallet,
      vault: SUBLY_VAULT.address,
      amountRawUsdc: 1_000_000n,
      preparedMessageHash: "sha256-test",
      recentBlockhash: null,
      lastValidBlockHeight: null,
      serializedTransaction: "AA==",
      txSignature: null,
      submittedSerializedTransaction: null,
      actualDepositRawUsdc: null,
      sharesMintedRaw: null,
      principalBasisBeforeRawUsdc: 0n,
      principalBasisAfterRawUsdc: null,
      status: "prepared",
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      submittedAt: null,
      terminalAt: null,
      errorCode: null
    });

    await expect(
      service.preparePayment(prepareInput("flow_req_1"))
    ).rejects.toMatchObject({ code: "vault_flow_pending" });
  });
});

class FakeQuoteBuilder implements CanonicalTransactionBuilder {
  calls = 0;
  quoteCalls = 0;

  constructor(private readonly quote: Partial<SettlementQuote> = {}) {}

  async quoteSettlementWithdraw(): Promise<SettlementQuote> {
    this.quoteCalls += 1;
    return {
      requiredWithdrawRawUsdc: 502_000n,
      sharesToRedeemRaw: 502_004n,
      withdrawalPenaltyRawUsdc: 0n,
      exchangeRateScaled: 1_000_000_000_000n,
      instantRedeemCapacityRawUsdc: 1_000_000n,
      userStakedSharesRaw: 0n,
      userUnstakedSharesRaw: 101_000_000n,
      userTotalSharesRaw: 101_000_000n,
      observedSlot: 1,
      ...this.quote
    };
  }

  async preparePaymentSettlement(
    input: CanonicalPaymentSettlementInput
  ): Promise<PreparedSettlementTransaction> {
    this.calls += 1;
    return new FakeTransactionBuilder().preparePaymentSettlement(input);
  }
}

class FakeTransactionBuilder implements CanonicalTransactionBuilder {
  calls = 0;

  async preparePaymentSettlement(
    input: CanonicalPaymentSettlementInput
  ): Promise<PreparedSettlementTransaction> {
    this.calls += 1;
    const signedTransaction = createSignedTransaction();

    return {
      preparedMessageHash: sha256TaggedHex(Buffer.from(signedTransaction.message)),
      recentBlockhash: "recent-blockhash",
      lastValidBlockHeight: 123,
      temporarySettlementTokenAccount: ADDRESSES.temporarySettlementTokenAccount,
      temporarySettlementSignature: bs58.encode(signedTransaction.tempSignature),
      serializedTransaction: Buffer.from(signedTransaction.transaction).toString(
        "base64"
      )
    };
  }
}

class InvalidTransactionBuilder implements CanonicalTransactionBuilder {
  calls = 0;

  constructor(private readonly overrides: Partial<PreparedSettlementTransaction>) {}

  async preparePaymentSettlement(): Promise<PreparedSettlementTransaction> {
    this.calls += 1;
    const valid = await new FakeTransactionBuilder().preparePaymentSettlement(
      {} as CanonicalPaymentSettlementInput
    );

    return {
      ...valid,
      ...this.overrides
    };
  }
}

class FakeSettlementSubmitter implements SettlementSubmitter {
  readonly ready = true;
  calls = 0;
  reconcileCalls = 0;
  readonly inputs: SettlementSubmissionInput[] = [];
  readonly reconcileInputs: SettlementReconciliationInput[] = [];
  prepareSubmissionCalls = 0;

  constructor(
    private readonly result:
      | SettlementSubmissionResult
      | Error
      | ((input: SettlementSubmissionInput) => SettlementSubmissionResult) = {
      status: "settled",
      txSignature: "settlement_signature"
    },
    private readonly reconciliationResult:
      | SettlementReconciliationResult
      | Error
      | ((
          input: SettlementReconciliationInput
        ) => SettlementReconciliationResult) = {
      status: "submitted"
    }
  ) {}

  async preparePaymentSettlementSubmission(
    input: SettlementSubmissionPreparationInput
  ) {
    this.prepareSubmissionCalls += 1;
    return {
      txSignature: transactionSignatureForSerializedTransaction(
        input.serializedTransaction
      ),
      serializedSignedTransaction: input.serializedTransaction
    };
  }

  async submitPaymentSettlement(input: SettlementSubmissionInput) {
    this.calls += 1;
    this.inputs.push(input);
    if (this.result instanceof Error) {
      throw this.result;
    }

    const result =
      typeof this.result === "function" ? this.result(input) : this.result;
    return settlementResultWithTxSignature(
      result,
      input.txSignature,
      input.intent.amountRawUsdc
    );
  }

  async reconcilePaymentSettlement(input: SettlementReconciliationInput) {
    this.reconcileCalls += 1;
    this.reconcileInputs.push(input);
    if (this.reconciliationResult instanceof Error) {
      throw this.reconciliationResult;
    }

    const result = typeof this.reconciliationResult === "function"
      ? this.reconciliationResult(input)
      : this.reconciliationResult;
    return input.intent.txSignature === null
      ? result
      : reconciliationResultWithTxSignature(
          result,
          input.intent.txSignature,
          input.intent.amountRawUsdc
        );
  }
}

class InvalidPreparedSubmissionSubmitter
  extends FakeSettlementSubmitter
  implements SettlementSubmitter
{
  override async preparePaymentSettlementSubmission() {
    this.prepareSubmissionCalls += 1;
    return {
      txSignature: txSignatureFor({
        intentJson: {
          serializedTransaction: Buffer.from(createSignedTransaction().transaction).toString(
            "base64"
          )
        }
      }),
      serializedSignedTransaction: "stored_signed_transaction"
    };
  }
}

async function serviceWithSpendableYield(params?: {
  transactionBuilder?: CanonicalTransactionBuilder;
  feeEstimator?: FeeEstimator;
  settlementSubmitter?: SettlementSubmitter;
  paymentExpirySeconds?: number;
  totalSharesRaw?: string;
  principalBasisRawUsdc?: string;
  instantRedeemCapacityRawUsdc?: string;
}) {
  const service = new SublyService({
    transactionBuilder: params?.transactionBuilder ?? new FakeTransactionBuilder(),
    ...(params?.feeEstimator === undefined
      ? {}
      : { feeEstimator: params.feeEstimator }),
    ...(params?.settlementSubmitter === undefined
      ? {}
      : { settlementSubmitter: params.settlementSubmitter }),
    config: {
      defaultEstimatedFeeDebtRawUsdc: 100_000n,
      ...(params?.paymentExpirySeconds === undefined
        ? {}
        : { paymentExpirySeconds: params.paymentExpirySeconds })
    }
  });

  await service.registerAgentWallet({
    wallet: ADDRESSES.wallet,
    signingPolicyId: "policy_1",
    signerProvider: "local_test"
  });
  await service.syncWalletPosition({
    wallet: ADDRESSES.wallet,
    totalSharesRaw: params?.totalSharesRaw ?? "101000000",
    exchangeRateScaled: "1000000000000",
    instantRedeemCapacityRawUsdc:
      params?.instantRedeemCapacityRawUsdc ?? "1000000",
    principalBasisRawUsdc: params?.principalBasisRawUsdc ?? "100000000",
    principalBasisSource: "kamino_pnl_current"
  });

  return service;
}

class OneShotFeeEstimator implements FeeEstimator {
  calls = 0;

  constructor(private readonly estimatedFeeDebtRawUsdc: bigint) {}

  async estimatePaymentFee() {
    this.calls += 1;
    if (this.calls > 1) {
      throw new Error("fee estimator should not be called for idempotent retry");
    }

    return {
      estimatedFeeLamports: 5000n,
      estimatedFeeDebtRawUsdc: this.estimatedFeeDebtRawUsdc,
      source: "one_shot_test",
      observedAt: new Date().toISOString()
    };
  }
}

const TEST_KEYS = {
  wallet: nacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(1)),
  seller: nacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(2)),
  temporarySettlementTokenAccount: nacl.sign.keyPair.fromSeed(
    new Uint8Array(32).fill(5)
  )
};

const WALLET_ADDRESS = bs58.encode(TEST_KEYS.wallet.publicKey);
const SELLER_ADDRESS = bs58.encode(TEST_KEYS.seller.publicKey);
const ADDRESSES = {
  wallet: WALLET_ADDRESS,
  seller: SELLER_ADDRESS,
  sellerUsdcAta: deriveAssociatedTokenAddress({
    owner: SELLER_ADDRESS,
    mint: SUBLY_VAULT.usdcMint
  }),
  agentUsdcAta: deriveAssociatedTokenAddress({
    owner: WALLET_ADDRESS,
    mint: SUBLY_VAULT.usdcMint
  }),
  temporarySettlementTokenAccount: bs58.encode(
    TEST_KEYS.temporarySettlementTokenAccount.publicKey
  )
} as const;

function payloadFor(payment: {
  intentJson: unknown;
  temporarySettlementSignature: string;
}) {
  const serializedTransaction = serializedTransactionFor(payment);

  return {
    serializedTransaction,
    agentSignature: bs58.encode(transactionSignatureAt(serializedTransaction, 0)),
    temporarySettlementSignature: payment.temporarySettlementSignature
  };
}

function txSignatureFor(payment: { intentJson: unknown }) {
  return transactionSignatureForSerializedTransaction(
    serializedTransactionFor(payment)
  );
}

function transactionSignatureForSerializedTransaction(
  serializedTransaction: string
) {
  return bs58.encode(transactionSignatureAt(serializedTransaction, 0));
}

function settlementResultWithTxSignature(
  result: SettlementSubmissionResult,
  txSignature: string,
  defaultSellerTransferRawUsdc: bigint
): SettlementSubmissionResult {
  return result.status === "failed_not_submitted"
    ? result
    : {
        ...result,
        txSignature,
        ...(result.status === "settled" &&
        result.sellerTransferRawUsdc === undefined
          ? { sellerTransferRawUsdc: defaultSellerTransferRawUsdc }
          : {})
      };
}

function reconciliationResultWithTxSignature(
  result: SettlementReconciliationResult,
  txSignature: string,
  defaultSellerTransferRawUsdc: bigint
): SettlementReconciliationResult {
  return result.status === "submitted"
    ? {
        ...result,
        txSignature
      }
    : settlementResultWithTxSignature(
        result,
        txSignature,
        defaultSellerTransferRawUsdc
      );
}

function serializedTransactionFor(payment: { intentJson: unknown }) {
  const intentJson = payment.intentJson as { serializedTransaction?: unknown };
  if (typeof intentJson.serializedTransaction !== "string") {
    throw new Error("test payment missing serialized transaction");
  }

  return intentJson.serializedTransaction;
}

function tamperedPayloadFor(payment: {
  intentJson: unknown;
  temporarySettlementSignature: string;
}) {
  const payload = payloadFor(payment);
  const bytes = Buffer.from(payload.serializedTransaction, "base64");
  const lastByteIndex = bytes.length - 1;
  bytes[lastByteIndex] = bytes[lastByteIndex]! ^ 1;

  return {
    ...payload,
    serializedTransaction: bytes.toString("base64")
  };
}

function createSignedTransaction() {
  const message = Uint8Array.from([
    2,
    0,
    0,
    2,
    ...TEST_KEYS.wallet.publicKey,
    ...TEST_KEYS.temporarySettlementTokenAccount.publicKey,
    ...new Uint8Array(32),
    0
  ]);
  const walletSignature = nacl.sign.detached(message, TEST_KEYS.wallet.secretKey);
  const tempSignature = nacl.sign.detached(
    message,
    TEST_KEYS.temporarySettlementTokenAccount.secretKey
  );
  const transaction = Uint8Array.from([
    2,
    ...walletSignature,
    ...tempSignature,
    ...message
  ]);

  return { transaction, message, walletSignature, tempSignature };
}

function transactionSignatureAt(serializedTransaction: string, index: number) {
  const bytes = Buffer.from(serializedTransaction, "base64");
  const offset = 1 + index * 64;
  return bytes.subarray(offset, offset + 64);
}

function withTemporaryEnv(
  updates: Record<string, string | undefined>,
  callback: () => void
) {
  const previous = new Map<string, string | undefined>();
  for (const [key, value] of Object.entries(updates)) {
    previous.set(key, process.env[key]);
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }

  try {
    callback();
  } finally {
    for (const [key, value] of previous) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }
}

async function withTemporaryEnvAsync(
  updates: Record<string, string | undefined>,
  callback: () => Promise<void>
) {
  const previous = new Map<string, string | undefined>();
  for (const [key, value] of Object.entries(updates)) {
    previous.set(key, process.env[key]);
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }

  try {
    await callback();
  } finally {
    for (const [key, value] of previous) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }
}
