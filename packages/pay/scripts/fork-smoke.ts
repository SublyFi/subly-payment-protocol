/**
 * Opt-in integration test against a disposable Surfpool mainnet fork.
 * Generates all signers in memory. Never loads an operator/user keypair.
 * Requires npm ci in the root and packages/pay, plus a running Surfpool.
 * Synthetic token balances and a labelled ledger-yield fixture make the
 * transaction pipeline testable without waiting for interest to accrue.
 */
import assert from "node:assert/strict";
import { address, generateKeyPairSigner } from "@solana/kit";
import { buildServer } from "../../../src/api/server.js";
import { SUBLY_VAULT, SOLANA_MAINNET_NETWORK } from "../../../src/config/constants.js";
import { InMemoryLedger } from "../../../src/domain/ledger.js";
import { SublyService } from "../../../src/domain/payment-service.js";
import { VaultFlowService } from "../../../src/domain/vault-flow-service.js";
import { ChainWalletSyncService } from "../../../src/domain/chain-wallet-sync.js";
import { SpendingMandateService } from "../../../src/domain/spending-mandate-service.js";
import { mandateHashOf, mandateSigningMessage, type SpendingMandatePayload } from "../../../src/domain/spending-mandate.js";
import { PythHermesFeeEstimator, pythHermesConnectionFromEnv } from "../../../src/domain/pyth-fee-estimator.js";
import { KaminoVaultAdapter } from "../../../src/kamino/vault-adapter.js";
import { createRpc } from "../../../src/solana/rpc.js";
import { TransactionSubmissionEngine } from "../../../src/solana/submission.js";
import { addSignaturesToSerializedTransaction } from "../../../src/solana/tx.js";
import { LocalKeypairAgentWalletSigner } from "../../../src/client/agent-wallet-signer.js";
import { ensureWalletOnboarded } from "../../../src/client/onboarding.js";
import { VaultFlowClient } from "../../../src/client/vault-flows.js";
import { createRelayerX402Payer } from "../../../src/client/relayer-payer.js";
import { deriveAssociatedTokenAddress } from "../../../src/lib/associated-token-account.js";
import { encodeX402Header } from "../../../src/x402/headers.js";
import { createTestPasskey } from "../../../tests/helpers/mandate-fixtures.js";
import { createSvmX402Fetch } from "../src/svm-x402-fetch.js";

async function main() {
  const rpcUrl = process.env.SUBLY_FORK_RPC_URL ?? "http://127.0.0.1:18899";
  const url = new URL(rpcUrl);
  assert(url.protocol === "http:" && url.hostname === "127.0.0.1" && !url.username && !url.password,
    "Fork tests only accept a numeric loopback HTTP endpoint");
  assert(process.env.NODE_ENV !== "production", "Use a disposable development process");
  async function rawRpc(method: string, params: unknown[] = []) {
    const response = await fetch(rpcUrl, { method: "POST", redirect: "error",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
      signal: AbortSignal.timeout(60_000) });
    assert(response.ok, `Local RPC HTTP ${response.status}`);
    const body = await response.json() as { result: unknown; error?: { message: string } };
    assert(!body.error, `Local ${method}: ${body.error?.message}`);
    return body.result;
  }
  const version = await rawRpc("getVersion") as Record<string, unknown>;
  assert(typeof version["surfnet-version"] === "string", "Refusing to fund or send to a non-Surfpool RPC");
  console.log(`Surfpool ${version["surfnet-version"]}; only disposable local transactions will be sent.`);
  const rpc = createRpc(rpcUrl);
  const [agent, sponsor, seller] = await Promise.all([
    generateKeyPairSigner(), generateKeyPairSigner(), generateKeyPairSigner()
  ]);
  await rawRpc("surfnet_setAccount", [sponsor.address, { lamports: 2_000_000_000 }]);
  await rawRpc("surfnet_setAccount", [agent.address, { lamports: 1_000_000 }]);
  await rawRpc("surfnet_setAccount", [seller.address, { lamports: 1_000_000 }]);
  await rawRpc("surfnet_setTokenAccount", [agent.address, SUBLY_VAULT.usdcMint, { amount: 3_000_000 }]);
  await rawRpc("surfnet_setTokenAccount", [seller.address, SUBLY_VAULT.usdcMint, { amount: 0 }]);
  const ledger = new InMemoryLedger();
  const service = new SublyService({ ledger });
  const adapter = new KaminoVaultAdapter({ rpc, vaultAddress: SUBLY_VAULT.address, vaultConfig: SUBLY_VAULT });
  await adapter.validateConfiguration();
  const engine = new TransactionSubmissionEngine(rpc);
  const oracle = new PythHermesFeeEstimator(pythHermesConnectionFromEnv());
  const mandates = new SpendingMandateService({ ledger, config: { enforcementLevel: "on",
    setupUrlBase: "http://127.0.0.1/setup/", approveUrlBase: "http://127.0.0.1/approve/",
    webauthn: { rpId: "127.0.0.1", origins: ["http://127.0.0.1"] } } });
  const flows = new VaultFlowService({ ledger, adapter, engine, sponsor, mandates,
    feeLamportsToUsdc: fee => oracle.convertFeeLamportsToUsdc(fee) });
  const chainWalletSync = new ChainWalletSyncService({ adapter, service });
  const server = buildServer(service, { vaultFlowService: flows, chainWalletSync, mandateService: mandates, apiRatePerMinute: 0 });
  let paymentCount = 0;
  const sellerAta = deriveAssociatedTokenAddress({ owner: seller.address, mint: SUBLY_VAULT.usdcMint });
  const requirement = { scheme: "exact", network: SOLANA_MAINNET_NETWORK,
    asset: SUBLY_VAULT.usdcMint, amount: "10000", payTo: seller.address,
    maxTimeoutSeconds: 120, extra: { feePayer: sponsor.address } };
  server.get("/fork-paid-data", async (request, reply) => {
    const header = request.headers["payment-signature"];
    if (typeof header !== "string") {
      const challenge = { x402Version: 2, accepts: [requirement],
        resource: { url: `${baseUrl}/fork-paid-data`, description: "Local fixture", mimeType: "application/json" } };
      return reply.code(402).header("payment-required", encodeX402Header(challenge)).send(challenge);
    }
    const payload = JSON.parse(Buffer.from(header, "base64").toString()) as { payload: { transaction: string } };
    const signed = await addSignaturesToSerializedTransaction({ serializedBase64: payload.payload.transaction, signers: [sponsor.keyPair] });
    const simulation = await engine.simulateSignedTransaction(signed.serializedBase64);
    assert.equal(simulation.err, null, "Local x402 payment simulation failed");
    const signature = await engine.sendSignedTransaction(signed.serializedBase64);
    const confirmed = await engine.waitForConfirmation({ txSignature: signature, lastValidBlockHeight: null });
    assert.equal(confirmed.status, "confirmed");
    paymentCount++;
    return reply.header("payment-response", encodeX402Header({ success: true, transaction: signature, network: SOLANA_MAINNET_NETWORK }))
      .send({ ok: true, fixture: "local-surfpool" });
  });
  let baseUrl = "";
  try {
    baseUrl = await server.listen({ host: "127.0.0.1", port: 0 });
    const signer = new LocalKeypairAgentWalletSigner(agent);
    const client = new VaultFlowClient({ relayerBaseUrl: baseUrl, signer, rpc, pollIntervalMs: 100 });
    await ensureWalletOnboarded({ relayerBaseUrl: baseUrl, signer });
    const session = await client.createSetupSession({ initialDepositRawUsdc: "2020000" });
    const passkey = createTestPasskey({ rpId: "127.0.0.1", origins: ["http://127.0.0.1"] });
    const payload: SpendingMandatePayload = { version: 1, ownerAuth: "passkey", ownerCredential: passkey.credential,
      enforcementMode: "subly", agentWallet: agent.address, vault: SUBLY_VAULT.address,
      issuedAtMs: Date.now(), expiresAtMs: session.mandateExpiresAtMs,
      policy: session.policy as unknown as SpendingMandatePayload["policy"], initialDeposit: { amountRawUsdc: "2020000" } };
    const document = { ...payload, ownerSignature: passkey.signAssertion(mandateSigningMessage(mandateHashOf(payload))) };
    const completed = await fetch(`${baseUrl}/v1/setup-sessions/${session.sessionId}/complete`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ document }) });
    assert.equal(completed.status, 200, await completed.text());
    console.log("PASS: HTTP wallet authentication and simulated passkey owner onboarding");
    const deposit = await client.deposit({ amountRawUsdc: 2_020_000n });
    assert.equal(deposit.status, "confirmed", JSON.stringify(deposit));
    const deposited = await ledger.getPosition(agent.address, SUBLY_VAULT.address);
    assert(deposited && deposited.principalBasisRawUsdc === BigInt(deposit.actualDepositRawUsdc!));
    assert(deposited.totalSharesRaw > 0n && deposited.feeDebtRawUsdc > 0n);
    console.log("PASS: signed sponsored deposit, receipt accounting and live Pyth fee conversion", deposit);

    // A test fixture for accrued yield; this is NOT measured economic return.
    // Only the disposable in-memory ledger is changed. Production sync never
    // accepts this fabricated baseline. Remove unrelated ATA funds so they
    // cannot hide a one-unit shortfall in the exact payment path.
    const fixtureBasis = deposited.principalBasisRawUsdc - 50_000n;
    await ledger.savePosition({ ...deposited, principalBasisRawUsdc: fixtureBasis });
    await rawRpc("surfnet_setTokenAccount", [agent.address, SUBLY_VAULT.usdcMint, { amount: 0 }]);
    // The relayer uses Kit v2 and the published x402 package uses Kit v5.
    // Their local keypair signer wire contract is the same; the live fork
    // exercises this boundary with real signature verification enabled.
    const x402Signer = agent as unknown as Parameters<typeof createSvmX402Fetch>[0]["signer"];
    const payer = createRelayerX402Payer({ relayerBaseUrl: baseUrl, signer, rpc,
      x402Fetch: await createSvmX402Fetch({ signer: x402Signer, rpcUrl }), defaultMaxAmountRawUsdc: 10_000n });
    const paid = await payer.pay({ url: `${baseUrl}/fork-paid-data` });
    assert(paid.paid && BigInt(paid.payment!.realizedRawUsdc) >= 10_000n);
    assert.equal(paymentCount, 1);
    const sellerBalance = await rpc.getTokenAccountBalance(address(sellerAta)).send();
    assert.equal(sellerBalance.value.amount, "10000");
    const afterPayment = await ledger.getPosition(agent.address, SUBLY_VAULT.address);
    assert.equal(afterPayment?.principalBasisRawUsdc, fixtureBasis);
    assert(paid.payment?.paymentTxSignature, "x402 v2 payment receipt must be read");
    const realizes = (await ledger.listWithdrawalsForPosition(agent.address, SUBLY_VAULT.address))
      .filter(intent => intent.purpose === "yield_realize");
    assert.equal(realizes.length, 1);
    assert.equal(realizes[0]?.paymentVerification, "verified_onchain");
    assert.equal(realizes[0]?.paymentTxSignature, paid.payment.paymentTxSignature);
    console.log("PASS: zero-ATA-balance yield realization + official x402 client + local seller settlement; principal unchanged", paid);

    const withdrawal = await client.withdraw({ amountRawUsdc: 500_000n });
    assert.equal(withdrawal.status, "confirmed", JSON.stringify(withdrawal));
    const net = BigInt(withdrawal.actualWithdrawRawUsdc!);
    assert(net >= 499_990n && net <= 500_010n);
    console.log("PASS: signed normal exit withdrawal and receipt accounting", withdrawal);
    console.log("Fork smoke passed. All funds, signatures and ledger changes were local test fixtures; no mainnet transaction was sent.");
  } finally {
    await server.close();
  }
}

main().catch(error => {
  // Do not print RPC request objects, credentials, signed bytes or key material.
  const message = error instanceof Error ? error.message : "Unexpected fork-test failure";
  console.error("Fork smoke failed:", message.replace(/https?:\/\/[^\s"'<>]+/g, "[endpoint omitted]"));
  process.exitCode = 1;
});
