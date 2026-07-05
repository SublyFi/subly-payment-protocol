/**
 * RemoteSignerTransport backed by Privy server wallets
 * (REST wallet API: basic auth with app id + app secret, walletId).
 *
 * Supports Privy's "agentic wallets" setup: a wallet owned by an
 * authorization key (policy-controlled) works by passing that key as
 * authorizationPrivateKey — every non-GET wallet request is then signed
 * into a privy-authorization-signature header (RFC 8785 canonical JSON →
 * SHA-256 → ECDSA P-256, DER, base64), per Privy's spec. Wallets without
 * an authorization key simply omit it.
 */
import { createPrivateKey, createSign, type KeyObject } from "node:crypto";
import {
  providerJsonRequest,
  RemoteSigningError,
  verifiedEd25519Signature,
  type RemoteSignerTransport
} from "../remote-signer-transport.js";

const PROVIDER = "privy";
const DEFAULT_BASE_URL = "https://api.privy.io";

export interface PrivySignerTransportConfig {
  appId: string;
  appSecret: string;
  /** The Privy server wallet id (a Solana wallet). */
  walletId: string;
  /**
   * Authorization private key for wallets owned by an authorization key
   * ("agentic wallets"): base64 PKCS#8 P-256, as issued by Privy — the
   * "wallet-auth:" prefix may be included and is stripped.
   */
  authorizationPrivateKey?: string | undefined;
  baseUrl?: string | undefined;
  fetchImpl?: typeof fetch | undefined;
}

/**
 * RFC 8785 (JCS) canonicalization for the payload shapes we sign: objects
 * with string keys sorted code-point-wise, minimal whitespace. Our payloads
 * contain only ASCII strings, integers, and nested plain objects, for which
 * this matches the full spec.
 */
function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(",")}]`;
  }
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries
      .map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function parseAuthorizationKey(base64Pkcs8: string): KeyObject {
  const stripped = base64Pkcs8.replace(/^wallet-auth:/, "").trim();
  try {
    return createPrivateKey({
      key: Buffer.from(stripped, "base64"),
      format: "der",
      type: "pkcs8"
    });
  } catch (error) {
    throw new RemoteSigningError(
      PROVIDER,
      "authorization key is not a base64 PKCS#8 P-256 private key",
      error
    );
  }
}

/** Signs a wallet API request payload per Privy's authorization-signature spec. */
function authorizationSignature(params: {
  key: KeyObject;
  appId: string;
  method: "POST" | "PUT" | "PATCH" | "DELETE";
  url: string;
  body: Record<string, unknown>;
}): string {
  const payload = {
    version: 1,
    method: params.method,
    url: params.url,
    body: params.body,
    headers: { "privy-app-id": params.appId }
  };
  const signer = createSign("sha256");
  signer.update(canonicalJson(payload));
  return signer.sign(params.key).toString("base64");
}

export async function createPrivySignerTransport(
  config: PrivySignerTransportConfig
): Promise<RemoteSignerTransport> {
  const baseUrl = (config.baseUrl ?? DEFAULT_BASE_URL).replace(/\/$/, "");
  const fetchImpl = config.fetchImpl ?? fetch;
  const authorizationKey =
    config.authorizationPrivateKey === undefined
      ? null
      : parseAuthorizationKey(config.authorizationPrivateKey);
  const baseHeaders = {
    authorization: `Basic ${Buffer.from(
      `${config.appId}:${config.appSecret}`
    ).toString("base64")}`,
    "privy-app-id": config.appId
  };

  const request = async (
    method: "GET" | "POST",
    path: string,
    body?: Record<string, unknown>
  ): Promise<Record<string, unknown>> => {
    // Owner-key wallets require an authorization signature on every
    // state-changing request; Privy does not require it on GETs.
    const headers =
      authorizationKey !== null && method !== "GET" && body !== undefined
        ? {
            ...baseHeaders,
            "privy-authorization-signature": authorizationSignature({
              key: authorizationKey,
              appId: config.appId,
              method,
              url: `${baseUrl}${path}`,
              body
            })
          }
        : baseHeaders;
    const json = await providerJsonRequest({
      provider: PROVIDER,
      fetchImpl,
      baseUrl,
      path,
      method,
      headers,
      body
    });
    if (json === null || typeof json !== "object") {
      throw new RemoteSigningError(
        PROVIDER,
        `${method} ${path} returned a non-JSON body`
      );
    }
    return json as Record<string, unknown>;
  };

  const rpc = async (
    body: Record<string, unknown>
  ): Promise<Record<string, unknown>> => {
    const response = await request(
      "POST",
      `/v1/wallets/${config.walletId}/rpc`,
      body
    );
    const data = response.data;
    if (data === null || typeof data !== "object") {
      throw new RemoteSigningError(PROVIDER, "rpc returned no data", response);
    }
    return data as Record<string, unknown>;
  };

  // Resolve and pin the wallet address up front; also validates credentials.
  // Strict chain check: fail at config time, not later at signing.
  const wallet = await request("GET", `/v1/wallets/${config.walletId}`);
  const walletAddress = wallet.address;
  if (typeof walletAddress !== "string") {
    throw new RemoteSigningError(
      PROVIDER,
      `wallet ${config.walletId} has no address`,
      wallet
    );
  }
  if (wallet.chain_type !== "solana") {
    throw new RemoteSigningError(
      PROVIDER,
      `wallet ${config.walletId} is ${String(
        wallet.chain_type
      )}, expected solana`
    );
  }

  return {
    provider: PROVIDER,
    walletAddress,

    async signMessage(message: Uint8Array): Promise<Uint8Array> {
      const data = await rpc({
        chain_type: "solana",
        method: "signMessage",
        params: {
          message: Buffer.from(message).toString("base64"),
          encoding: "base64"
        }
      });
      const signature = data.signature;
      if (typeof signature !== "string") {
        throw new RemoteSigningError(
          PROVIDER,
          "signMessage returned no signature",
          data
        );
      }
      return verifiedEd25519Signature({
        provider: PROVIDER,
        encodedSignature: signature,
        message,
        walletAddress
      });
    },

    async signTransaction(
      serializedTransactionBase64: string
    ): Promise<string> {
      const data = await rpc({
        chain_type: "solana",
        method: "signTransaction",
        params: {
          transaction: serializedTransactionBase64,
          encoding: "base64"
        }
      });
      const signedTransaction = data.signed_transaction;
      if (typeof signedTransaction !== "string") {
        throw new RemoteSigningError(
          PROVIDER,
          "signTransaction returned no signed_transaction",
          data
        );
      }
      return signedTransaction;
    }
  };
}
