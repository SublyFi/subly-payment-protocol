import bs58 from "bs58";
import nacl from "tweetnacl";
import { describe, expect, it } from "vitest";
import { buildServer } from "../src/api/server.js";
import {
  verifyWalletAuth,
  WALLET_AUTH_SIGNED_AT_HEADER,
  WALLET_AUTH_SIGNATURE_HEADER,
  WALLET_AUTH_WALLET_HEADER,
  walletAuthMessage
} from "../src/api/wallet-auth.js";
import { SublyService } from "../src/domain/payment-service.js";

function testWallet() {
  const keyPair = nacl.sign.keyPair();
  const wallet = bs58.encode(keyPair.publicKey);
  const sign = (params: {
    method: string;
    path: string;
    rawBody?: string;
    signedAtMs?: string;
  }) => {
    const signedAtMs = params.signedAtMs ?? String(Date.now());
    const message = walletAuthMessage({
      method: params.method,
      path: params.path,
      rawBody: params.rawBody ?? "",
      signedAtMs
    });
    return {
      [WALLET_AUTH_WALLET_HEADER]: wallet,
      [WALLET_AUTH_SIGNED_AT_HEADER]: signedAtMs,
      [WALLET_AUTH_SIGNATURE_HEADER]: bs58.encode(
        nacl.sign.detached(message, keyPair.secretKey)
      )
    };
  };
  return { wallet, sign };
}

function registerBody(wallet: string): string {
  return JSON.stringify({
    wallet,
    signingPolicyId: "self-serve",
    signingMode: "non_interactive",
    signerValidationMode: "structured_intent_transaction",
    signerProvider: "local-keypair",
    activateForPayments: true
  });
}

describe("verifyWalletAuth", () => {
  it("accepts a valid signature and rejects tampering", () => {
    const { wallet, sign } = testWallet();
    const headers = sign({ method: "POST", path: "/v1/wallets/agent", rawBody: "{}" });

    expect(
      verifyWalletAuth({
        wallet,
        signedAt: headers[WALLET_AUTH_SIGNED_AT_HEADER],
        signature: headers[WALLET_AUTH_SIGNATURE_HEADER],
        method: "POST",
        path: "/v1/wallets/agent",
        rawBody: "{}"
      })
    ).toEqual({ ok: true, wallet });

    // Different body, path, or method must not verify.
    for (const variant of [
      { method: "POST", path: "/v1/wallets/agent", rawBody: "{tampered}" },
      { method: "POST", path: "/v1/payments/prepare", rawBody: "{}" },
      { method: "GET", path: "/v1/wallets/agent", rawBody: "{}" }
    ]) {
      const result = verifyWalletAuth({
        wallet,
        signedAt: headers[WALLET_AUTH_SIGNED_AT_HEADER],
        signature: headers[WALLET_AUTH_SIGNATURE_HEADER],
        ...variant
      });
      expect(result.ok).toBe(false);
    }
  });

  it("rejects stale signatures", () => {
    const { wallet, sign } = testWallet();
    const signedAtMs = String(Date.now() - 600_000);
    const headers = sign({
      method: "GET",
      path: "/v1/wallets/x/budget",
      signedAtMs
    });
    const result = verifyWalletAuth({
      wallet,
      signedAt: signedAtMs,
      signature: headers[WALLET_AUTH_SIGNATURE_HEADER],
      method: "GET",
      path: "/v1/wallets/x/budget",
      rawBody: ""
    });
    expect(result).toMatchObject({ ok: false });
  });
});

describe("wallet-signature auth on the API", () => {
  it("lets a wallet self-register, sync from chain, and read its own budget", async () => {
    const server = buildServer(new SublyService(), {
      sellerApiToken: "seller-secret",
      adminApiToken: "admin-secret"
    });
    const { wallet, sign } = testWallet();

    const body = registerBody(wallet);
    const register = await server.inject({
      method: "POST",
      url: "/v1/wallets/agent",
      headers: {
        ...sign({ method: "POST", path: "/v1/wallets/agent", rawBody: body }),
        "content-type": "application/json"
      },
      payload: body
    });
    expect(register.statusCode).toBe(200);
    expect(register.json().status).toBe("active");

    // Chain sync passes auth; it fails only because this test wires no RPC.
    const syncBody = JSON.stringify({ source: "chain" });
    const sync = await server.inject({
      method: "POST",
      url: `/v1/wallets/${wallet}/sync`,
      headers: {
        ...sign({
          method: "POST",
          path: `/v1/wallets/${wallet}/sync`,
          rawBody: syncBody
        }),
        "content-type": "application/json"
      },
      payload: syncBody
    });
    expect(sync.statusCode).toBe(501);
    expect(sync.json().error.code).toBe("chain_sync_unavailable");

    const budget = await server.inject({
      method: "GET",
      url: `/v1/wallets/${wallet}/budget`,
      headers: sign({ method: "GET", path: `/v1/wallets/${wallet}/budget` })
    });
    expect(budget.statusCode).toBe(200);
    expect(budget.json().position.wallet).toBe(wallet);

    await server.close();
  });

  it("rejects acting on a different wallet than the signature's", async () => {
    const server = buildServer(new SublyService(), {
      adminApiToken: "admin-secret"
    });
    const attacker = testWallet();
    const victim = testWallet();

    const body = registerBody(victim.wallet);
    const response = await server.inject({
      method: "POST",
      url: "/v1/wallets/agent",
      headers: {
        ...attacker.sign({
          method: "POST",
          path: "/v1/wallets/agent",
          rawBody: body
        }),
        "content-type": "application/json"
      },
      payload: body
    });
    expect(response.statusCode).toBe(403);
    expect(response.json().error.code).toBe("wallet_mismatch");
    await server.close();
  });

  it("keeps manual position sync operator-only", async () => {
    const server = buildServer(new SublyService(), {
      adminApiToken: "admin-secret"
    });
    const { wallet, sign } = testWallet();

    const body = registerBody(wallet);
    await server.inject({
      method: "POST",
      url: "/v1/wallets/agent",
      headers: {
        ...sign({ method: "POST", path: "/v1/wallets/agent", rawBody: body }),
        "content-type": "application/json"
      },
      payload: body
    });

    // A wallet attesting its own shares/exchange rate must be refused.
    const manualBody = JSON.stringify({
      totalSharesRaw: "100000000",
      exchangeRateScaled: "2000000000000",
      instantRedeemCapacityRawUsdc: "100000000"
    });
    const response = await server.inject({
      method: "POST",
      url: `/v1/wallets/${wallet}/sync`,
      headers: {
        ...sign({
          method: "POST",
          path: `/v1/wallets/${wallet}/sync`,
          rawBody: manualBody
        }),
        "content-type": "application/json"
      },
      payload: manualBody
    });
    expect(response.statusCode).toBe(403);
    expect(response.json().error.code).toBe("admin_required");
    await server.close();
  });

  it("rejects unauthenticated and badly signed requests", async () => {
    const server = buildServer(new SublyService(), {
      adminApiToken: "admin-secret"
    });
    const { wallet, sign } = testWallet();

    const noHeaders = await server.inject({
      method: "GET",
      url: `/v1/wallets/${wallet}/budget`
    });
    expect(noHeaders.statusCode).toBe(401);

    const headers = sign({
      method: "GET",
      path: `/v1/wallets/${wallet}/budget`
    });
    const tampered = await server.inject({
      method: "GET",
      url: `/v1/wallets/${wallet}/budget`,
      headers: {
        ...headers,
        [WALLET_AUTH_SIGNATURE_HEADER]: bs58.encode(new Uint8Array(64))
      }
    });
    expect(tampered.statusCode).toBe(401);
    await server.close();
  });
});
