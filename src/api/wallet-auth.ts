/**
 * Wallet-signature authentication for buyer-facing endpoints.
 *
 * Standard x402 has no buyer-side API credential: the wallet key itself is
 * the identity. Subly's buyer-facing relayer endpoints (vault
 * flows, self-serve registration, budget reads) follow the same principle —
 * each request is signed with the agent wallet's ed25519 key, so only the
 * wallet owner can act on (or reserve budget against) that wallet. No shared
 * client token exists.
 *
 * Request headers:
 *   x-subly-wallet      base58 wallet public key
 *   x-subly-signed-at   unix milliseconds (freshness window below)
 *   x-subly-signature   base58 ed25519 signature over the message
 *
 * Signed message (single line, utf8):
 *   subly-api:{METHOD}:{path[?query]}:{sha256hex(rawBody or "")}:{signedAtMs}
 *
 * Binding the method, path including the query string, exact body bytes, and timestamp prevents
 * cross-endpoint or cross-wallet reuse; TLS prevents capture in transit.
 */
import { createHash } from "node:crypto";
import bs58 from "bs58";
import nacl from "tweetnacl";

export const WALLET_AUTH_WALLET_HEADER = "x-subly-wallet";
export const WALLET_AUTH_SIGNED_AT_HEADER = "x-subly-signed-at";
export const WALLET_AUTH_SIGNATURE_HEADER = "x-subly-signature";
export const WALLET_AUTH_MAX_AGE_MS = 300_000;

export function sha256Hex(data: string): string {
  return createHash("sha256").update(data, "utf8").digest("hex");
}

export function walletAuthMessage(params: {
  method: string;
  path: string;
  rawBody: string;
  signedAtMs: string;
}): Uint8Array {
  return new TextEncoder().encode(
    `subly-api:${params.method.toUpperCase()}:${params.path}:${sha256Hex(
      params.rawBody
    )}:${params.signedAtMs}`
  );
}

export type WalletAuthResult =
  | { ok: true; wallet: string }
  | { ok: false; reason: string };

export function verifyWalletAuth(params: {
  wallet: string | undefined;
  signedAt: string | undefined;
  signature: string | undefined;
  method: string;
  path: string;
  rawBody: string;
  nowMs?: number;
}): WalletAuthResult {
  const { wallet, signedAt, signature } = params;
  if (
    wallet === undefined ||
    signedAt === undefined ||
    signature === undefined
  ) {
    return { ok: false, reason: "missing wallet auth headers" };
  }
  if (!/^\d{1,16}$/.test(signedAt)) {
    return { ok: false, reason: "invalid x-subly-signed-at" };
  }
  const now = params.nowMs ?? Date.now();
  const age = Math.abs(now - Number(signedAt));
  if (age > WALLET_AUTH_MAX_AGE_MS) {
    return { ok: false, reason: "wallet auth signature expired" };
  }

  let publicKeyBytes: Uint8Array;
  let signatureBytes: Uint8Array;
  try {
    publicKeyBytes = bs58.decode(wallet);
    signatureBytes = bs58.decode(signature);
  } catch {
    return { ok: false, reason: "invalid base58 in wallet auth headers" };
  }
  if (publicKeyBytes.length !== 32 || signatureBytes.length !== 64) {
    return { ok: false, reason: "invalid wallet auth key or signature length" };
  }

  const message = walletAuthMessage({
    method: params.method,
    path: params.path,
    rawBody: params.rawBody,
    signedAtMs: signedAt
  });
  const valid = nacl.sign.detached.verify(
    message,
    signatureBytes,
    publicKeyBytes
  );
  if (!valid) {
    return { ok: false, reason: "wallet auth signature verification failed" };
  }

  return { ok: true, wallet };
}
