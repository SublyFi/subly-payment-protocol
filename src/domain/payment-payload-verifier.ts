import bs58 from "bs58";
import nacl from "tweetnacl";
import { sha256TaggedHex } from "../lib/hash.js";
import type { PaymentIntent } from "./models.js";

const MAX_SOLANA_TRANSACTION_BYTES = 1232;

export interface SignedPaymentPayload {
  serializedTransaction: string;
  agentSignature: string;
  temporarySettlementSignature: string;
}

export interface PaymentPayloadVerifierInput extends SignedPaymentPayload {
  intent: PaymentIntent;
}

export interface PaymentPayloadVerifier {
  verify(input: PaymentPayloadVerifierInput):
    | { ok: true }
    | { ok: false; reason: string };
}

export class StrictPaymentPayloadVerifier implements PaymentPayloadVerifier {
  verify(input: PaymentPayloadVerifierInput) {
    if (!input.agentSignature || !input.temporarySettlementSignature) {
      return { ok: false as const, reason: "missing_required_signature" };
    }

    const transaction = parseTransaction(input.serializedTransaction);
    if (transaction === null) {
      return { ok: false as const, reason: "invalid_transaction_encoding" };
    }

    if (
      sha256TaggedHex(Buffer.from(transaction.message)) !==
      input.intent.preparedMessageHash
    ) {
      return { ok: false as const, reason: "message_hash_mismatch" };
    }

    const tempSignatureCheck = verifyRequiredSigner({
      transaction,
      signerPublicKey: input.intent.temporarySettlementTokenAccount,
      providedSignature: input.temporarySettlementSignature
    });
    if (!tempSignatureCheck.ok) {
      return {
        ok: false as const,
        reason: `temporary_settlement_${tempSignatureCheck.reason}`
      };
    }

    const agentSignatureCheck = verifyRequiredSigner({
      transaction,
      signerPublicKey: input.intent.wallet,
      providedSignature: input.agentSignature
    });
    if (!agentSignatureCheck.ok) {
      return { ok: false as const, reason: `agent_${agentSignatureCheck.reason}` };
    }

    return { ok: true as const };
  }
}

export function preparedMessageHashFromSerializedTransaction(
  serializedTransaction: string
): string | null {
  const transaction = parseTransaction(serializedTransaction);
  if (transaction === null) {
    return null;
  }

  return sha256TaggedHex(Buffer.from(transaction.message));
}

export function extractValidRequiredSignerSignature(input: {
  serializedTransaction: string;
  signerPublicKey: string;
}): { ok: true; signature: string } | { ok: false; reason: string } {
  const transaction = parseTransaction(input.serializedTransaction);
  if (transaction === null) {
    return { ok: false, reason: "invalid_transaction_encoding" };
  }

  const signerSignature = validRequiredSignerSignature({
    transaction,
    signerPublicKey: input.signerPublicKey
  });
  if (!signerSignature.ok) {
    return signerSignature;
  }

  return {
    ok: true,
    signature: bs58.encode(signerSignature.signature)
  };
}

export function transactionSignatureFromSerializedTransaction(
  serializedTransaction: string
): string | null {
  const transaction = parseTransaction(serializedTransaction);
  const signature = transaction?.signatures[0];
  return signature === undefined ? null : bs58.encode(signature);
}

interface ParsedTransaction {
  message: Uint8Array;
  signatures: Uint8Array[];
  accountKeys: Uint8Array[];
  numRequiredSignatures: number;
}

function parseTransaction(serializedTransaction: string): ParsedTransaction | null {
  const bytes = Buffer.from(serializedTransaction, "base64");
  if (bytes.length === 0 || bytes.length > MAX_SOLANA_TRANSACTION_BYTES) {
    return null;
  }

  const signatureCount = readShortVec(bytes, 0);
  if (signatureCount === null) {
    return null;
  }

  let offset = signatureCount.nextOffset;
  const signatures: Uint8Array[] = [];
  for (let index = 0; index < signatureCount.value; index += 1) {
    if (offset + 64 > bytes.length) {
      return null;
    }
    signatures.push(bytes.subarray(offset, offset + 64));
    offset += 64;
  }

  const message = bytes.subarray(offset);
  const parsedMessage = parseMessage(message);
  if (parsedMessage === null) {
    return null;
  }

  return {
    message,
    signatures,
    accountKeys: parsedMessage.accountKeys,
    numRequiredSignatures: parsedMessage.numRequiredSignatures
  };
}

function parseMessage(message: Uint8Array):
  | { accountKeys: Uint8Array[]; numRequiredSignatures: number }
  | null {
  let offset = 0;
  if (message.length < 3) {
    return null;
  }

  if ((message[0]! & 0x80) !== 0) {
    offset = 1;
  }

  if (offset + 3 > message.length) {
    return null;
  }

  const numRequiredSignatures = message[offset]!;
  offset += 3;

  const accountCount = readShortVec(message, offset);
  if (accountCount === null) {
    return null;
  }
  offset = accountCount.nextOffset;

  const accountKeys: Uint8Array[] = [];
  for (let index = 0; index < accountCount.value; index += 1) {
    if (offset + 32 > message.length) {
      return null;
    }
    accountKeys.push(message.subarray(offset, offset + 32));
    offset += 32;
  }

  return { accountKeys, numRequiredSignatures };
}

function verifyRequiredSigner(input: {
  transaction: ParsedTransaction;
  signerPublicKey: string;
  providedSignature: string;
}): { ok: true } | { ok: false; reason: string } {
  const providedSignature = decodeBase58(input.providedSignature, 64);
  if (providedSignature === null) {
    return { ok: false, reason: "signature_encoding_invalid" };
  }

  const signerSignature = validRequiredSignerSignature({
    transaction: input.transaction,
    signerPublicKey: input.signerPublicKey
  });
  if (!signerSignature.ok) {
    return signerSignature;
  }
  if (!bytesEqual(signerSignature.signature, providedSignature)) {
    return { ok: false, reason: "signature_mismatch" };
  }

  return { ok: true };
}

function validRequiredSignerSignature(input: {
  transaction: ParsedTransaction;
  signerPublicKey: string;
}):
  | { ok: true; signature: Uint8Array }
  | { ok: false; reason: string } {
  const publicKey = decodeBase58(input.signerPublicKey, 32);
  if (publicKey === null) {
    return { ok: false, reason: "signature_encoding_invalid" };
  }

  const signerIndex = input.transaction.accountKeys.findIndex((accountKey) =>
    bytesEqual(accountKey, publicKey)
  );
  if (signerIndex < 0) {
    return { ok: false, reason: "signer_missing" };
  }
  if (signerIndex >= input.transaction.numRequiredSignatures) {
    return { ok: false, reason: "not_required_signer" };
  }

  const transactionSignature = input.transaction.signatures[signerIndex];
  if (transactionSignature === undefined) {
    return { ok: false, reason: "signature_missing" };
  }
  if (
    !nacl.sign.detached.verify(
      input.transaction.message,
      transactionSignature,
      publicKey
    )
  ) {
    return { ok: false, reason: "signature_invalid" };
  }

  return { ok: true, signature: transactionSignature };
}

function readShortVec(
  bytes: Uint8Array,
  startOffset: number
): { value: number; nextOffset: number } | null {
  let value = 0;
  let shift = 0;
  let offset = startOffset;

  while (offset < bytes.length) {
    const byte = bytes[offset]!;
    value |= (byte & 0x7f) << shift;
    offset += 1;
    if ((byte & 0x80) === 0) {
      return { value, nextOffset: offset };
    }
    shift += 7;
    if (shift > 28) {
      return null;
    }
  }

  return null;
}

function decodeBase58(value: string, expectedLength: number): Uint8Array | null {
  try {
    const decoded = bs58.decode(value);
    return decoded.length === expectedLength ? decoded : null;
  } catch {
    return null;
  }
}

function bytesEqual(left: Uint8Array, right: Uint8Array): boolean {
  if (left.length !== right.length) {
    return false;
  }

  return left.every((value, index) => value === right[index]!);
}
