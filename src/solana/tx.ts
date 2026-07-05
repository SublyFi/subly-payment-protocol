import bs58 from "bs58";
import {
  appendTransactionMessageInstructions,
  compileTransaction,
  compressTransactionMessageUsingAddressLookupTables,
  createTransactionMessage,
  getBase64EncodedWireTransaction,
  getTransactionDecoder,
  partiallySignTransaction,
  pipe,
  setTransactionMessageFeePayer,
  setTransactionMessageLifetimeUsingBlockhash,
  type Address,
  type Blockhash,
  type Instruction,
  type SignatureBytes,
  type Transaction
} from "@solana/kit";
import { sha256TaggedHex } from "../lib/hash.js";

export const MAX_TRANSACTION_BYTES = 1232;

export interface BuiltTransaction {
  transaction: Transaction;
  serializedBase64: string;
  messageHash: string;
}

export interface BuildTransactionInput {
  feePayer: Address;
  blockhash: Blockhash;
  lastValidBlockHeight: bigint;
  instructions: Instruction[];
  /** Map of lookup-table address to the addresses stored in that table. */
  lookupTables?: Record<string, Address[]> | undefined;
  /** CryptoKeyPairs that sign at build time (e.g. temporary account keypair). */
  partialSigners?: CryptoKeyPair[] | undefined;
}

export async function buildVersionedTransaction(
  input: BuildTransactionInput
): Promise<BuiltTransaction> {
  const message = pipe(
    createTransactionMessage({ version: 0 }),
    (m) => setTransactionMessageFeePayer(input.feePayer, m),
    (m) =>
      setTransactionMessageLifetimeUsingBlockhash(
        {
          blockhash: input.blockhash,
          lastValidBlockHeight: input.lastValidBlockHeight
        },
        m
      ),
    (m) => appendTransactionMessageInstructions(input.instructions, m)
  );

  const compressed =
    input.lookupTables !== undefined && Object.keys(input.lookupTables).length > 0
      ? compressTransactionMessageUsingAddressLookupTables(
          message,
          input.lookupTables as Parameters<
            typeof compressTransactionMessageUsingAddressLookupTables
          >[1]
        )
      : message;

  let transaction: Transaction = compileTransaction(compressed);
  if (input.partialSigners !== undefined && input.partialSigners.length > 0) {
    transaction = await partiallySignTransaction(input.partialSigners, transaction);
  }

  const serializedBase64 = getBase64EncodedWireTransaction(transaction);
  const byteLength = Buffer.from(serializedBase64, "base64").length;
  if (byteLength > MAX_TRANSACTION_BYTES) {
    throw new Error(
      `Transaction is ${byteLength} bytes which exceeds the ${MAX_TRANSACTION_BYTES} byte limit`
    );
  }

  return {
    transaction,
    serializedBase64,
    messageHash: transactionMessageHash(transaction)
  };
}

export function transactionMessageHash(transaction: Transaction): string {
  return sha256TaggedHex(Buffer.from(transaction.messageBytes));
}

export function decodeSerializedTransaction(
  serializedBase64: string
): Transaction {
  return getTransactionDecoder().decode(Buffer.from(serializedBase64, "base64"));
}

/**
 * Attaches a signature produced outside this process (custody/MPC provider)
 * to an already-decoded transaction. The signature is inserted as-is; callers
 * must verify it against the transaction's messageBytes and the signer's
 * public key first (see src/client/remote-signer-transport.ts).
 */
export function attachExternalSignatureToTransaction(params: {
  transaction: Transaction;
  signer: Address;
  signature: Uint8Array;
}): { serializedBase64: string; transaction: Transaction } {
  if (!(params.signer in params.transaction.signatures)) {
    throw new Error(
      `transaction does not expect a signature from ${params.signer}`
    );
  }
  const transaction: Transaction = Object.freeze({
    ...params.transaction,
    signatures: Object.freeze({
      ...params.transaction.signatures,
      [params.signer]: params.signature as SignatureBytes
    })
  });
  return {
    serializedBase64: getBase64EncodedWireTransaction(transaction),
    transaction
  };
}

export async function addSignaturesToSerializedTransaction(params: {
  serializedBase64: string;
  signers: CryptoKeyPair[];
}): Promise<{ serializedBase64: string; transaction: Transaction }> {
  const decoded = decodeSerializedTransaction(params.serializedBase64);
  const signed = await partiallySignTransaction(params.signers, decoded);
  return {
    serializedBase64: getBase64EncodedWireTransaction(signed),
    transaction: signed
  };
}

export function signatureBase58ForSigner(
  transaction: Transaction,
  signer: Address
): string | null {
  const signature = transaction.signatures[signer];
  if (signature === null || signature === undefined) {
    return null;
  }

  return bs58.encode(signature);
}
