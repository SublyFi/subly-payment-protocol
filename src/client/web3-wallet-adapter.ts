import { Keypair, type VersionedTransaction } from "@solana/web3.js";

/**
 * WalletAdapter shape expected by the x402-solana client (createX402Client).
 * It signs a legacy @solana/web3.js VersionedTransaction — the transfer the
 * facilitator (e.g. PayAI) submits. The agent signs only its transfer
 * authority; the facilitator's `extra.feePayer` covers the tx fee, so the
 * agent needs no SOL for the payment itself.
 */
export interface X402WalletAdapter {
  address: string;
  signTransaction: (tx: VersionedTransaction) => Promise<VersionedTransaction>;
}

/**
 * Builds an x402 WalletAdapter from a 64-byte ed25519 secret key (the same
 * bytes Subly loads for the agent wallet). Signing is local; the private key
 * never leaves this process.
 */
export function createX402WalletAdapter(
  secretKey: Uint8Array
): X402WalletAdapter {
  if (secretKey.length !== 64) {
    throw new Error("agent secret key must be 64 bytes");
  }
  const keypair = Keypair.fromSecretKey(secretKey);
  return {
    address: keypair.publicKey.toBase58(),
    signTransaction: async (tx: VersionedTransaction) => {
      tx.sign([keypair]);
      return tx;
    }
  };
}
