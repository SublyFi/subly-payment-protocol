/**
 * Builds the kit-v5 TransactionSigner that @x402/svm signs the standard-x402
 * payment transaction with, from an env-selected agent signer bundle:
 * local keypair bytes, or a custody transport (Circle/Privy) wrapped as a
 * TransactionPartialSigner. The remote path round-trips each transaction
 * through requestVerifiedTransactionSignature — the same single trust
 * boundary the vault-flow signer uses — so provider responses are verified
 * against the wallet key and the exact transaction bytes before use.
 */
import {
  address,
  createKeyPairSignerFromBytes,
  getBase64EncodedWireTransaction,
  type SignatureBytes,
  type SignatureDictionary,
  type Transaction,
  type TransactionPartialSigner,
  type TransactionSigner
} from "@solana/kit";
import {
  ed25519PublicKeyBytes,
  requestVerifiedTransactionSignature,
  type RemoteSignerTransport
} from "../../../src/client/remote-signer-transport.js";
import type { AgentSignerBundle } from "../../../src/client/signer-env.js";

export async function svmTransactionSignerFromBundle(
  bundle: AgentSignerBundle
): Promise<TransactionSigner> {
  if (bundle.provider === "local") {
    return createKeyPairSignerFromBytes(bundle.localSecretKey);
  }
  return remoteSvmTransactionSigner(bundle.transport);
}

function remoteSvmTransactionSigner(
  transport: RemoteSignerTransport
): TransactionPartialSigner {
  const signerAddress = address(transport.walletAddress);
  const publicKey = ed25519PublicKeyBytes(
    transport.provider,
    transport.walletAddress
  );

  return {
    address: signerAddress,
    async signTransactions(
      transactions: readonly Transaction[]
    ): Promise<readonly SignatureDictionary[]> {
      const dictionaries: SignatureDictionary[] = [];
      for (const transaction of transactions) {
        const signature = await requestVerifiedTransactionSignature({
          transport,
          serializedTransactionBase64:
            getBase64EncodedWireTransaction(transaction),
          messageBytes: transaction.messageBytes as unknown as Uint8Array,
          publicKey
        });
        dictionaries.push(
          Object.freeze({ [signerAddress]: signature as SignatureBytes })
        );
      }
      return dictionaries;
    }
  };
}
