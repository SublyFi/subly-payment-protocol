/**
 * Remote signing transport for custody/MPC agent wallets (Circle
 * developer-controlled wallets, Privy server wallets, ...). The private key
 * never enters this process: each method asks the provider's API for a
 * signature over bytes we constructed locally. Everything security-relevant
 * stays on our side of that call — structured-intent validation runs before
 * the request (see RemoteAgentWalletSigner), and every returned signature is
 * verified against the wallet's public key and OUR transaction bytes before
 * it is attached, so a provider signing anything else fails loudly.
 *
 * Verification ownership: for transactions, requestVerifiedTransactionSignature
 * below is the single verifier — transports return the provider's signed wire
 * transaction unchecked. For messages, transports must already return verified
 * raw bytes (they need try-decode-and-verify to normalize provider encodings),
 * and RemoteAgentWalletSigner re-verifies as defense in depth.
 */
import type { Address } from "@solana/kit";
import bs58 from "bs58";
import nacl from "tweetnacl";
import {
  attachExternalSignatureToTransaction,
  decodeSerializedTransaction
} from "../solana/tx.js";

export interface RemoteSignerTransport {
  /** Provider slug reported to the relayer at registration (e.g. "circle"). */
  readonly provider: string;
  /** Base58 ed25519 wallet public key held by the provider. */
  readonly walletAddress: string;
  /**
   * ed25519 signature over exactly these message bytes (Subly wallet-auth).
   * Implementations must normalize the provider's signature encoding and
   * return raw 64 bytes that verify for walletAddress (use
   * verifiedEd25519Signature).
   */
  signMessage(message: Uint8Array): Promise<Uint8Array>;
  /**
   * Signs the base64 wire transaction; returns the provider's signed wire
   * transaction, base64, UNVERIFIED — callers must go through
   * requestVerifiedTransactionSignature, which extracts only the wallet's
   * signature and discards any other mutation the provider makes.
   */
  signTransaction(serializedTransactionBase64: string): Promise<string>;
}

export class RemoteSigningError extends Error {
  constructor(
    readonly provider: string,
    message: string,
    readonly detail: unknown = null
  ) {
    super(`[${provider}] ${message}`);
    this.name = "RemoteSigningError";
  }
}

/** Decodes a base58 wallet address into ed25519 public-key bytes, guarded. */
export function ed25519PublicKeyBytes(
  provider: string,
  walletAddress: string
): Uint8Array {
  let bytes: Uint8Array;
  try {
    bytes = bs58.decode(walletAddress);
  } catch {
    throw new RemoteSigningError(
      provider,
      `wallet address ${walletAddress} is not base58`
    );
  }
  if (bytes.length !== 32) {
    throw new RemoteSigningError(
      provider,
      `wallet address ${walletAddress} is not a 32-byte ed25519 key`
    );
  }
  return bytes;
}

/**
 * Decodes a provider-encoded ed25519 signature (base58, base64/base64url, or
 * hex — custody APIs are inconsistent and do not always document the format)
 * by picking the candidate that actually verifies over the message for the
 * wallet key. The leniency cannot cause a false accept: every candidate is
 * gated by the ed25519 verification, so at worst a wrong decode is skipped.
 */
export function verifiedEd25519Signature(params: {
  provider: string;
  encodedSignature: string;
  message: Uint8Array;
  walletAddress: string;
}): Uint8Array {
  const publicKey = ed25519PublicKeyBytes(params.provider, params.walletAddress);
  const encoded = params.encodedSignature.trim();
  for (const candidate of decodeSignatureCandidates(encoded)) {
    if (nacl.sign.detached.verify(params.message, candidate, publicKey)) {
      return candidate;
    }
  }
  throw new RemoteSigningError(
    params.provider,
    `signature did not verify for wallet ${params.walletAddress}`
  );
}

function decodeSignatureCandidates(encoded: string): Uint8Array[] {
  const candidates: Uint8Array[] = [];
  const hex = encoded.startsWith("0x") ? encoded.slice(2) : encoded;
  if (/^[0-9a-fA-F]{128}$/.test(hex)) {
    candidates.push(Uint8Array.from(Buffer.from(hex, "hex")));
  }
  try {
    const fromBase58 = bs58.decode(encoded);
    if (fromBase58.length === 64) {
      candidates.push(fromBase58);
    }
  } catch {
    // not base58
  }
  if (/^[A-Za-z0-9+/=_-]+$/.test(encoded)) {
    const fromBase64 = Uint8Array.from(
      Buffer.from(encoded.replace(/-/g, "+").replace(/_/g, "/"), "base64")
    );
    if (fromBase64.length === 64) {
      candidates.push(fromBase64);
    }
  }
  return candidates;
}

/**
 * The single trust boundary for provider-signed transactions, shared by the
 * vault-flow path (externallySignedAgentTransaction) and the standard-x402
 * path (packages/pay svm-signer): sends OUR serialized bytes, extracts only
 * the wallet's signature from the provider's response, and verifies it over
 * OUR message bytes. Any other mutation the provider makes — including a
 * "helpful" blockhash refresh — is rejected, because downstream (sponsor
 * co-sign, x402 settlement) commits to the exact prepared bytes.
 */
export async function requestVerifiedTransactionSignature(params: {
  transport: RemoteSignerTransport;
  serializedTransactionBase64: string;
  /** Message bytes of that same transaction (what the wallet must sign). */
  messageBytes: Uint8Array;
  /** Cached wallet public key; derived from the transport when omitted. */
  publicKey?: Uint8Array | undefined;
}): Promise<Uint8Array> {
  const { transport } = params;
  const signedBase64 = await transport.signTransaction(
    params.serializedTransactionBase64
  );

  let returned;
  try {
    returned = decodeSerializedTransaction(signedBase64);
  } catch (error) {
    throw new RemoteSigningError(
      transport.provider,
      "provider returned an undecodable signed transaction",
      error
    );
  }
  const signature =
    returned.signatures[transport.walletAddress as Address] ?? null;
  if (signature === null) {
    throw new RemoteSigningError(
      transport.provider,
      `signed transaction is missing the signature for ${transport.walletAddress}`
    );
  }
  const publicKey =
    params.publicKey ??
    ed25519PublicKeyBytes(transport.provider, transport.walletAddress);
  if (!nacl.sign.detached.verify(params.messageBytes, signature, publicKey)) {
    throw new RemoteSigningError(
      transport.provider,
      "returned signature does not verify over the requested transaction"
    );
  }
  return signature;
}

/**
 * Remote-signs a prepared vault-flow transaction and re-attaches the verified
 * signature to OUR bytes. The provider's returned transaction is never
 * forwarded.
 */
export async function externallySignedAgentTransaction(params: {
  transport: RemoteSignerTransport;
  serializedTransaction: string;
}): Promise<{ serializedTransaction: string; agentSignature: string }> {
  const original = decodeSerializedTransaction(params.serializedTransaction);
  const signature = await requestVerifiedTransactionSignature({
    transport: params.transport,
    serializedTransactionBase64: params.serializedTransaction,
    messageBytes: original.messageBytes as unknown as Uint8Array
  });

  const attached = attachExternalSignatureToTransaction({
    transaction: original,
    signer: params.transport.walletAddress as Address,
    signature
  });
  return {
    serializedTransaction: attached.serializedBase64,
    agentSignature: bs58.encode(signature)
  };
}

/**
 * Shared JSON request for provider transports: throws RemoteSigningError with
 * the response body attached on any non-2xx, returns the parsed JSON body.
 */
export async function providerJsonRequest(params: {
  provider: string;
  fetchImpl: typeof fetch;
  baseUrl: string;
  path: string;
  method: "GET" | "POST";
  headers: Record<string, string>;
  body?: Record<string, unknown> | undefined;
}): Promise<unknown> {
  const response = await params.fetchImpl(`${params.baseUrl}${params.path}`, {
    method: params.method,
    headers: { ...params.headers, "content-type": "application/json" },
    ...(params.body === undefined ? {} : { body: JSON.stringify(params.body) })
  });
  let json: unknown = null;
  try {
    json = await response.json();
  } catch {
    json = null;
  }
  if (!response.ok) {
    throw new RemoteSigningError(
      params.provider,
      `${params.method} ${params.path} failed with ${response.status}`,
      json
    );
  }
  return json;
}
