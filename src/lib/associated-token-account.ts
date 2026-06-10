import { createHash } from "node:crypto";
import bs58 from "bs58";
import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  SPL_TOKEN_PROGRAM_ID,
  SUBLY_VAULT
} from "../config/constants.js";

const PDA_MARKER = Buffer.from("ProgramDerivedAddress", "utf8");
const ED25519_P = (1n << 255n) - 19n;
const ED25519_D =
  mod(-121665n * modPow(121666n, ED25519_P - 2n, ED25519_P), ED25519_P);

export function deriveAssociatedTokenAddress(params: {
  owner: string;
  mint?: string;
  tokenProgramId?: string;
}): string {
  const owner = decodePublicKey(params.owner, "owner");
  const mint = decodePublicKey(params.mint ?? SUBLY_VAULT.usdcMint, "mint");
  const tokenProgramId = decodePublicKey(
    params.tokenProgramId ?? SPL_TOKEN_PROGRAM_ID,
    "tokenProgramId"
  );
  const associatedTokenProgramId = decodePublicKey(
    ASSOCIATED_TOKEN_PROGRAM_ID,
    "associatedTokenProgramId"
  );

  for (let bump = 255; bump >= 0; bump -= 1) {
    const address = createProgramAddress(
      [owner, tokenProgramId, mint, Uint8Array.of(bump)],
      associatedTokenProgramId
    );
    if (address !== null) {
      return bs58.encode(address);
    }
  }

  throw new Error("Unable to derive associated token account address");
}

function createProgramAddress(
  seeds: Uint8Array[],
  programId: Uint8Array
): Uint8Array | null {
  const hash = createHash("sha256");
  for (const seed of seeds) {
    hash.update(seed);
  }
  hash.update(programId);
  hash.update(PDA_MARKER);

  const digest = hash.digest();
  return isEd25519Point(digest) ? null : new Uint8Array(digest);
}

function decodePublicKey(value: string, fieldName: string): Uint8Array {
  const decoded = bs58.decode(value);
  if (decoded.length !== 32) {
    throw new Error(`${fieldName} must be a 32-byte public key`);
  }

  return decoded;
}

function isEd25519Point(bytes: Uint8Array): boolean {
  if (bytes.length !== 32) {
    return false;
  }

  const yBytes = Uint8Array.from(bytes);
  yBytes[31] = yBytes[31]! & 0x7f;
  const y = littleEndianToBigInt(yBytes);
  if (y >= ED25519_P) {
    return false;
  }

  const ySquared = mod(y * y, ED25519_P);
  const numerator = mod(ySquared - 1n, ED25519_P);
  const denominator = mod(ED25519_D * ySquared + 1n, ED25519_P);
  if (denominator === 0n) {
    return false;
  }

  const xSquared = mod(
    numerator * modPow(denominator, ED25519_P - 2n, ED25519_P),
    ED25519_P
  );
  return xSquared === 0n || modPow(xSquared, (ED25519_P - 1n) / 2n, ED25519_P) === 1n;
}

function littleEndianToBigInt(bytes: Uint8Array): bigint {
  let value = 0n;
  for (let index = bytes.length - 1; index >= 0; index -= 1) {
    value = (value << 8n) + BigInt(bytes[index]!);
  }

  return value;
}

function mod(value: bigint, modulus: bigint): bigint {
  const result = value % modulus;
  return result >= 0n ? result : result + modulus;
}

function modPow(base: bigint, exponent: bigint, modulus: bigint): bigint {
  let result = 1n;
  let nextBase = mod(base, modulus);
  let nextExponent = exponent;

  while (nextExponent > 0n) {
    if ((nextExponent & 1n) === 1n) {
      result = mod(result * nextBase, modulus);
    }
    nextBase = mod(nextBase * nextBase, modulus);
    nextExponent >>= 1n;
  }

  return result;
}
