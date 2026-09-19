import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import bs58 from "bs58";
import nacl from "tweetnacl";
import { chromium } from "playwright";
import { buildServer } from "../src/api/server.js";
import { ApprovalRequiredError, SublyError } from "../src/domain/errors.js";
import { StaticFeeEstimator } from "../src/domain/fee-estimator.js";
import { InMemoryLedger } from "../src/domain/ledger.js";
import { SublyService } from "../src/domain/payment-service.js";
import { SpendingMandateService } from "../src/domain/spending-mandate-service.js";

// Real shipped HTML, browser WebAuthn, HTTP handlers and signature validation.
// Only the authenticator and ledger are disposable; no RPC or funds are used.
process.env.NODE_ENV = "test";
const service = new SublyService({
  ledger: new InMemoryLedger(),
  feeEstimator: new StaticFeeEstimator({ estimatedFeeLamports: 0n, estimatedFeeDebtRawUsdc: 0n }),
});
const wallet = bs58.encode(nacl.sign.keyPair().publicKey);
const vault = service.vault.address;
const adminToken = randomBytes(24).toString("hex");
const origins: string[] = [];
let nowMs = Date.now();
const mandateService = new SpendingMandateService({
  ledger: service.ledger,
  config: {
    enforcementLevel: "on",
    webauthn: { rpId: "localhost", origins },
    nowMs: () => nowMs,
  },
});
const server = buildServer(service, {
  adminApiToken: adminToken, mandateService, apiRatePerMinute: 0,
});
let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;

async function createSession(agentWallet = wallet) {
  const response = await server.inject({
    method: "POST", url: `/v1/wallets/${agentWallet}/setup-sessions`,
    headers: { authorization: `Bearer ${adminToken}` },
    payload: { initialDepositRawUsdc: "1000000" },
  });
  assert.equal(response.statusCode, 200, response.body);
  return response.json<{ sessionId: string }>().sessionId;
}

async function requestApproval(amountRawUsdc: bigint) {
  try {
    await mandateService.authorizeDeposit({ wallet, vault, amountRawUsdc, approvalId: null });
  } catch (error) {
    assert(error instanceof ApprovalRequiredError);
    const details = error.details as { approvalId: string };
    assert.equal(typeof details.approvalId, "string");
    return details.approvalId;
  }
  throw new Error("Expected an owner approval requirement");
}

try {
  await server.listen({ host: "127.0.0.1", port: 0 });
  const address = server.server.address();
  assert(address && typeof address !== "string");
  const origin = `http://localhost:${address.port}`;
  origins.push(origin);
  browser = await chromium.launch({ headless: true });
  const context = await browser.newContext();
  await context.route("**/*", route => new URL(route.request().url()).origin === origin
    ? route.continue() : route.abort());
  const page = await context.newPage();
  page.setDefaultTimeout(10_000);
  const pageErrors: string[] = [];
  page.on("pageerror", error => pageErrors.push(error.message));
  const cdp = await context.newCDPSession(page);
  await cdp.send("WebAuthn.enable");
  await cdp.send("WebAuthn.addVirtualAuthenticator", {
    options: {
      protocol: "ctap2", transport: "internal", hasResidentKey: true,
      hasUserVerification: true, isUserVerified: true,
      automaticPresenceSimulation: true,
    },
  });
  const expectStatus = async (text: string) => {
    await page.waitForFunction(expected => document.getElementById("status")?.textContent?.includes(expected), text);
  };

  const sessionId = await createSession();
  await page.goto(`${origin}/setup/${sessionId}`);
  await page.locator("#btn-passkey").waitFor({ state: "visible" });
  assert.match(await page.locator("#details").innerText(), /First deposit \(included in this approval\)/);
  await page.locator("#btn-passkey").click();
  await expectStatus("the mandate is active");
  const mandate = await mandateService.getMandate(wallet, vault);
  assert.equal((await mandateService.getMandateSummary(wallet, vault)).ownerAuth, "passkey");
  assert.equal(mandate.status, "active");
  assert.match(await page.locator("#status").innerText(), /first deposit is pre-approved/);
  await page.reload();
  await expectStatus("already completed");
  assert.equal(await page.locator("#btn-passkey").isVisible(), false);
  console.log("Browser: passkey registration and completed setup verified.");

  const approvalId = await requestApproval(2_000_000n);
  await page.goto(`${origin}/approve/${approvalId}`);
  await page.locator("#btn-approve").waitFor({ state: "visible" });
  assert.match(await page.locator("#details").innerText(), /2 USDC/);
  await page.locator("#btn-approve").click();
  await expectStatus("Approved");
  assert.equal((await mandateService.getApprovalView(approvalId)).status, "approved");
  const authorized = await mandateService.authorizeDeposit({ wallet, vault, amountRawUsdc: 2_000_000n, approvalId });
  assert.equal(authorized.approvalId, approvalId);

  const deniedId = await requestApproval(3_000_000n);
  await page.goto(`${origin}/approve/${deniedId}`);
  await page.locator("#btn-deny").click();
  await expectStatus("Denied");
  assert.equal((await mandateService.getApprovalView(deniedId)).status, "denied");
  console.log("Browser: signed approval and denial verified by the server.");

  await page.goto(`${origin}/revoke/${wallet}?vault=${encodeURIComponent(vault)}`);
  page.once("dialog", dialog => dialog.accept());
  await page.locator("#btn-revoke").click();
  await expectStatus("Revoked");
  assert.equal((await mandateService.getMandate(wallet, vault)).status, "revoked");
  await assert.rejects(
    mandateService.authorizeDeposit({ wallet, vault, amountRawUsdc: 2_000_000n, approvalId }),
    error => error instanceof SublyError && error.code === "mandate_revoked",
  );
  console.log("Browser: revocation blocks even a previously approved deposit.");

  // Exercise the alternate wallet owner path using a generated, unfunded key.
  const owner = nacl.sign.keyPair();
  const walletAgent = bs58.encode(nacl.sign.keyPair().publicKey);
  const walletSessionId = await createSession(walletAgent);
  await page.exposeFunction("testOwnerSign", (message: number[]) =>
    Array.from(nacl.sign.detached(Uint8Array.from(message), owner.secretKey)));
  await page.goto(`${origin}/setup/${walletSessionId}`);
  // Keep this browser fixture as JS so tsx's name-preserving helpers are not
  // serialized into a browser context that has no transpiler runtime.
  await page.evaluate(`window.solana = {
    publicKey: { toString() { return ${JSON.stringify(bs58.encode(owner.publicKey))}; } },
    async connect() {},
    async signMessage(message) {
      return { signature: Uint8Array.from(await window.testOwnerSign(Array.from(message))) };
    }
  };`);
  await page.locator("#btn-wallet").click();
  await expectStatus("the mandate is active");
  assert.equal((await mandateService.getMandateSummary(walletAgent, vault)).ownerAuth, "ed25519");
  console.log("Browser: Solana wallet owner registration verified with a generated key.");

  const expiredSessionId = await createSession();
  nowMs += 11 * 60_000;
  await page.goto(`${origin}/setup/${expiredSessionId}`);
  await expectStatus("has expired");
  assert.equal(await page.locator("#btn-passkey").isVisible(), false);
  assert.deepEqual(pageErrors, []);
  console.log("Browser: expired setup refuses approval. No chain transactions were sent.");
} finally {
  await browser?.close();
  await server.close();
}
