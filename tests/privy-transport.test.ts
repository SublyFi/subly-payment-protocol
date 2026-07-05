import { describe, expect, it } from "vitest";
import { createVerify, generateKeyPairSync } from "node:crypto";
import bs58 from "bs58";
import nacl from "tweetnacl";
import { createPrivySignerTransport } from "../src/client/signer-transports/privy.js";

const APP_ID = "app_test";
const WALLET_ID = "w1";
const BASE = "https://api.privy.io";

/** Test-side RFC 8785 canonicalization (sorted keys, minimal whitespace). */
function canonical(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(canonical).join(",")}]`;
  }
  if (value !== null && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function jsonResponse(body: unknown): Response {
  return {
    ok: true,
    status: 200,
    json: async () => body
  } as unknown as Response;
}

interface StubOptions {
  walletAddress: string;
  walletSecretKey: Uint8Array;
  chainType?: string;
  /** Receives every POST's headers + parsed body for assertions. */
  onPost?: (headers: Record<string, string>, body: Record<string, unknown>) => void;
}

function privyFetchStub(options: StubOptions): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url === `${BASE}/v1/wallets/${WALLET_ID}` && (init?.method ?? "GET") === "GET") {
      return jsonResponse({
        id: WALLET_ID,
        address: options.walletAddress,
        chain_type: options.chainType ?? "solana"
      });
    }
    if (url === `${BASE}/v1/wallets/${WALLET_ID}/rpc` && init?.method === "POST") {
      const body = JSON.parse(String(init.body)) as Record<string, unknown>;
      options.onPost?.(init.headers as Record<string, string>, body);
      const params = body.params as { message?: string; transaction?: string };
      if (body.method === "signMessage") {
        const message = Buffer.from(params.message!, "base64");
        const signature = nacl.sign.detached(message, options.walletSecretKey);
        return jsonResponse({
          method: "signMessage",
          data: {
            signature: Buffer.from(signature).toString("base64"),
            encoding: "base64"
          }
        });
      }
      throw new Error(`unexpected rpc method ${String(body.method)}`);
    }
    throw new Error(`unexpected request ${url}`);
  }) as typeof fetch;
}

describe("createPrivySignerTransport", () => {
  it("signs non-GET wallet requests with a verifying P-256 authorization signature", async () => {
    const wallet = nacl.sign.keyPair();
    const walletAddress = bs58.encode(wallet.publicKey);
    const authKey = generateKeyPairSync("ec", { namedCurve: "P-256" });
    const authKeyBase64 = authKey.privateKey
      .export({ format: "der", type: "pkcs8" })
      .toString("base64");

    const seen: Array<{ headers: Record<string, string>; body: Record<string, unknown> }> = [];
    const transport = await createPrivySignerTransport({
      appId: APP_ID,
      appSecret: "secret",
      walletId: WALLET_ID,
      // The dashboard-issued form carries this prefix; it must be stripped.
      authorizationPrivateKey: `wallet-auth:${authKeyBase64}`,
      fetchImpl: privyFetchStub({
        walletAddress,
        walletSecretKey: wallet.secretKey,
        onPost: (headers, body) => seen.push({ headers, body })
      })
    });
    expect(transport.walletAddress).toBe(walletAddress);

    const message = new TextEncoder().encode("subly-api:POST:/v1/x:h:1");
    const signature = await transport.signMessage(message);
    expect(
      nacl.sign.detached.verify(message, signature, wallet.publicKey)
    ).toBe(true);

    expect(seen).toHaveLength(1);
    const { headers, body } = seen[0]!;
    const authSignature = headers["privy-authorization-signature"];
    expect(authSignature).toBeDefined();
    // Recompute the canonical payload Privy verifies and check the ECDSA
    // signature against the authorization public key.
    const payload = {
      version: 1,
      method: "POST",
      url: `${BASE}/v1/wallets/${WALLET_ID}/rpc`,
      body,
      headers: { "privy-app-id": APP_ID }
    };
    const verifier = createVerify("sha256");
    verifier.update(canonical(payload));
    expect(
      verifier.verify(authKey.publicKey, Buffer.from(authSignature!, "base64"))
    ).toBe(true);
  });

  it("omits the authorization header when no authorization key is configured", async () => {
    const wallet = nacl.sign.keyPair();
    const seen: Array<{ headers: Record<string, string> }> = [];
    const transport = await createPrivySignerTransport({
      appId: APP_ID,
      appSecret: "secret",
      walletId: WALLET_ID,
      fetchImpl: privyFetchStub({
        walletAddress: bs58.encode(wallet.publicKey),
        walletSecretKey: wallet.secretKey,
        onPost: (headers) => seen.push({ headers })
      })
    });

    await transport.signMessage(new TextEncoder().encode("m"));
    expect(seen[0]!.headers["privy-authorization-signature"]).toBeUndefined();
  });

  it("rejects a non-solana wallet at construction", async () => {
    const wallet = nacl.sign.keyPair();
    await expect(
      createPrivySignerTransport({
        appId: APP_ID,
        appSecret: "secret",
        walletId: WALLET_ID,
        fetchImpl: privyFetchStub({
          walletAddress: bs58.encode(wallet.publicKey),
          walletSecretKey: wallet.secretKey,
          chainType: "ethereum"
        })
      })
    ).rejects.toThrow(/expected solana/);
  });

  it("rejects a malformed authorization key with a typed error", async () => {
    const wallet = nacl.sign.keyPair();
    await expect(
      createPrivySignerTransport({
        appId: APP_ID,
        appSecret: "secret",
        walletId: WALLET_ID,
        authorizationPrivateKey: "wallet-auth:not-a-key",
        fetchImpl: privyFetchStub({
          walletAddress: bs58.encode(wallet.publicKey),
          walletSecretKey: wallet.secretKey
        })
      })
    ).rejects.toThrow(/authorization key is not a base64 PKCS#8/);
  });
});
