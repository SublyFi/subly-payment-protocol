/**
 * Generates (or reads) a Solana keypair JSON for the beta agent wallet
 * without requiring solana-keygen. Idempotent: an existing file is never
 * overwritten — its public key is printed instead.
 *
 * Usage:
 *   npx tsx demo/generate-agent-key.ts <path/to/key.json>
 *
 * Prints the wallet's public key (base58) on stdout.
 */
import { generateKeyPairSync } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import bs58 from "bs58";

const path = process.argv[2];
if (path === undefined || path.length === 0) {
  console.error("Usage: npx tsx demo/generate-agent-key.ts <path/to/key.json>");
  process.exit(1);
}

function base64UrlToBytes(value: string): Uint8Array {
  return new Uint8Array(Buffer.from(value, "base64url"));
}

if (existsSync(path)) {
  const bytes = new Uint8Array(JSON.parse(readFileSync(path, "utf8")));
  if (bytes.length !== 64) {
    console.error(`${path} is not a 64-byte Solana keypair JSON`);
    process.exit(1);
  }
  console.log(bs58.encode(bytes.slice(32)));
  process.exit(0);
}

const { privateKey, publicKey } = generateKeyPairSync("ed25519");
const seed = base64UrlToBytes(
  (privateKey.export({ format: "jwk" }) as { d: string }).d
);
const pub = base64UrlToBytes(
  (publicKey.export({ format: "jwk" }) as { x: string }).x
);
if (seed.length !== 32 || pub.length !== 32) {
  console.error("unexpected key material length");
  process.exit(1);
}

mkdirSync(dirname(path), { recursive: true });
writeFileSync(path, JSON.stringify([...seed, ...pub]), { mode: 0o600 });
console.log(bs58.encode(pub));
