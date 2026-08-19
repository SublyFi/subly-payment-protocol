/**
 * Client side of wallet-signature request auth (see src/api/wallet-auth.ts):
 * builds the x-subly-* headers by signing the canonical message with the
 * agent wallet key. This replaces any shared API token — the wallet key is
 * the buyer's only credential, matching standard x402 where the payment
 * signature itself is the identity.
 */
import {
  WALLET_AUTH_SIGNED_AT_HEADER,
  WALLET_AUTH_SIGNATURE_HEADER,
  WALLET_AUTH_WALLET_HEADER,
  walletAuthMessage
} from "../api/wallet-auth.js";

export interface ApiMessageSigner {
  readonly walletAddress: string;
  signApiMessage(message: Uint8Array): Promise<string>;
}

export async function walletAuthHeaders(params: {
  signer: ApiMessageSigner;
  method: string;
  url: string;
  body?: string;
}): Promise<Record<string, string>> {
  const signedAtMs = String(Date.now());
  const message = walletAuthMessage({
    method: params.method,
    path: (() => {
      const url = new URL(params.url);
      return url.pathname + url.search;
    })(),
    rawBody: params.body ?? "",
    signedAtMs
  });
  return {
    [WALLET_AUTH_WALLET_HEADER]: params.signer.walletAddress,
    [WALLET_AUTH_SIGNED_AT_HEADER]: signedAtMs,
    [WALLET_AUTH_SIGNATURE_HEADER]: await params.signer.signApiMessage(message)
  };
}
