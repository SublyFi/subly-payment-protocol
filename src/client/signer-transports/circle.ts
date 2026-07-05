/**
 * RemoteSignerTransport backed by Circle developer-controlled wallets
 * (the w3s API: API key + registered entity secret + walletId).
 *
 * Note this is NOT the `circle` CLI "agent wallet" (email+OTP product) —
 * that surface exposes no raw signing API and cannot back a Subly agent
 * wallet. Developer-controlled Solana wallets are plain ed25519 EOAs with
 * signMessage / signTransaction endpoints, which is exactly what Subly
 * needs.
 *
 * Every request carries a fresh entitySecretCiphertext: the 32-byte entity
 * secret RSA-OAEP(SHA-256)-encrypted to Circle's entity public key, as
 * Circle requires. The entity secret itself never leaves this process.
 */
import {
  constants,
  createPublicKey,
  publicEncrypt,
  type KeyObject
} from "node:crypto";
import {
  providerJsonRequest,
  RemoteSigningError,
  verifiedEd25519Signature,
  type RemoteSignerTransport
} from "../remote-signer-transport.js";

const PROVIDER = "circle";
const DEFAULT_BASE_URL = "https://api.circle.com";

export interface CircleSignerTransportConfig {
  apiKey: string;
  /** 32-byte hex entity secret registered in the Circle developer console. */
  entitySecret: string;
  /** The developer-controlled wallet id (a Solana mainnet wallet). */
  walletId: string;
  baseUrl?: string | undefined;
  fetchImpl?: typeof fetch | undefined;
}

export async function createCircleSignerTransport(
  config: CircleSignerTransportConfig
): Promise<RemoteSignerTransport> {
  if (!/^[0-9a-fA-F]{64}$/.test(config.entitySecret)) {
    throw new RemoteSigningError(
      PROVIDER,
      "entity secret must be 32 bytes of hex (64 hex chars)"
    );
  }
  const baseUrl = (config.baseUrl ?? DEFAULT_BASE_URL).replace(/\/$/, "");
  const fetchImpl = config.fetchImpl ?? fetch;

  const request = async (
    method: "GET" | "POST",
    path: string,
    body?: Record<string, unknown>
  ): Promise<Record<string, unknown>> => {
    const json = await providerJsonRequest({
      provider: PROVIDER,
      fetchImpl,
      baseUrl,
      path,
      method,
      headers: { authorization: `Bearer ${config.apiKey}` },
      body
    });
    const data = (json as { data?: Record<string, unknown> } | null)?.data;
    if (data === undefined) {
      throw new RemoteSigningError(
        PROVIDER,
        `${method} ${path} returned no data envelope`,
        json
      );
    }
    return data;
  };

  // Resolve and pin the wallet address up front; also validates credentials.
  // Strict mainnet check: the Subly relayer and x402 rail are mainnet-only,
  // so a SOL-DEVNET (or non-Solana) wallet must fail here at config time,
  // not later at submission with a confusing error.
  const walletData = await request("GET", `/v1/w3s/wallets/${config.walletId}`);
  const wallet = walletData.wallet as
    | { address?: string; blockchain?: string }
    | undefined;
  if (wallet?.address === undefined) {
    throw new RemoteSigningError(
      PROVIDER,
      `wallet ${config.walletId} has no address`,
      walletData
    );
  }
  if (wallet.blockchain !== "SOL") {
    throw new RemoteSigningError(
      PROVIDER,
      `wallet ${config.walletId} is on ${String(
        wallet.blockchain
      )}, expected SOL (Solana mainnet)`
    );
  }
  const walletAddress = wallet.address;

  let entityPublicKey: KeyObject | null = null;
  const entitySecretCiphertext = async (): Promise<string> => {
    if (entityPublicKey === null) {
      const data = await request("GET", "/v1/w3s/config/entity/publicKey");
      const publicKey = data.publicKey;
      if (typeof publicKey !== "string") {
        throw new RemoteSigningError(
          PROVIDER,
          "entity public key response has no publicKey",
          data
        );
      }
      entityPublicKey = createPublicKey(publicKey);
    }
    return publicEncrypt(
      {
        key: entityPublicKey,
        padding: constants.RSA_PKCS1_OAEP_PADDING,
        oaepHash: "sha256"
      },
      Buffer.from(config.entitySecret, "hex")
    ).toString("base64");
  };

  return {
    provider: PROVIDER,
    walletAddress,

    async signMessage(message: Uint8Array): Promise<Uint8Array> {
      const data = await request("POST", "/v1/w3s/developer/sign/message", {
        walletId: config.walletId,
        message: `0x${Buffer.from(message).toString("hex")}`,
        encodedByHex: true,
        entitySecretCiphertext: await entitySecretCiphertext()
      });
      const signature = data.signature;
      if (typeof signature !== "string") {
        throw new RemoteSigningError(
          PROVIDER,
          "sign/message returned no signature",
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
      const data = await request(
        "POST",
        "/v1/w3s/developer/sign/transaction",
        {
          walletId: config.walletId,
          rawTransaction: serializedTransactionBase64,
          entitySecretCiphertext: await entitySecretCiphertext()
        }
      );
      const signedTransaction = data.signedTransaction;
      if (typeof signedTransaction !== "string") {
        throw new RemoteSigningError(
          PROVIDER,
          "sign/transaction returned no signedTransaction",
          data
        );
      }
      return signedTransaction;
    }
  };
}
