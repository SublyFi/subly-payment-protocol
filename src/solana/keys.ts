import { readFileSync } from "node:fs";
import bs58 from "bs58";
import {
  createKeyPairSignerFromBytes,
  type KeyPairSigner
} from "@solana/kit";

/**
 * Loads a 64-byte ed25519 keypair from either a base58 string or a JSON
 * byte-array file (solana-keygen format). Exactly one source must be set.
 */
export async function loadKeyPairSigner(params: {
  base58Secret?: string | undefined;
  jsonFilePath?: string | undefined;
  label: string;
}): Promise<KeyPairSigner> {
  const { base58Secret, jsonFilePath, label } = params;
  if (base58Secret !== undefined && base58Secret.length > 0) {
    const bytes = bs58.decode(base58Secret);
    if (bytes.length !== 64) {
      throw new Error(`${label} base58 secret must decode to 64 bytes`);
    }
    return createKeyPairSignerFromBytes(bytes);
  }

  if (jsonFilePath !== undefined && jsonFilePath.length > 0) {
    const raw = JSON.parse(readFileSync(jsonFilePath, "utf8"));
    if (!Array.isArray(raw) || raw.length !== 64) {
      throw new Error(`${label} keypair file must be a 64-byte JSON array`);
    }
    return createKeyPairSignerFromBytes(Uint8Array.from(raw));
  }

  throw new Error(`${label} keypair is not configured`);
}
