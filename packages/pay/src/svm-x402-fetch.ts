import { createKeyPairSignerFromBytes } from "@solana/kit";
import { wrapFetchWithPaymentFromConfig } from "@x402/fetch";
import { ExactSvmScheme, toClientSvmSigner } from "@x402/svm";
import type {
  FetchLike,
  FetchResponseLike
} from "../../../src/client/standard-x402-payer.js";

/**
 * Builds the x402 payment `fetch` for the published client using the OFFICIAL
 * x402 Foundation Solana implementation (@x402/svm + @x402/fetch, kit v5). It
 * derives the agent's SVM signer from the raw 64-byte secret, registers the
 * Exact SVM scheme under the `solana:*` wildcard (matches any Solana mainnet
 * CAIP-2 network a seller advertises), and returns a fetch that transparently
 * pays a 402 challenge.
 *
 * This replaces PayAI's x402-solana, whose transaction builder rejected
 * off-curve (PDA) seller payTo addresses; @x402/svm derives the destination ATA
 * with @solana-program/token, which handles off-curve owners correctly.
 */
export async function createSvmX402Fetch(params: {
  agentSecretKey: Uint8Array;
  rpcUrl: string;
}): Promise<FetchLike> {
  const signer = toClientSvmSigner(
    await createKeyPairSignerFromBytes(params.agentSecretKey)
  );
  const wrapped = wrapFetchWithPaymentFromConfig(fetch, {
    schemes: [
      {
        network: "solana:*",
        client: new ExactSvmScheme(signer, { rpcUrl: params.rpcUrl })
      }
    ]
  });

  return (url, init) =>
    wrapped(url, init as RequestInit) as unknown as Promise<FetchResponseLike>;
}
