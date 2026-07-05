import { createHash } from "node:crypto";
import { stableStringify } from "./hash.js";

/**
 * Canonicalization for signed Subly documents (spending mandates, approvals,
 * revocations): key-sorted JSON with no whitespace, hashed as plain sha256
 * hex. Signed messages embed this hash, so canonicalization must stay
 * byte-stable forever — see docs/spending-mandate-design.md.
 */
export function canonicalJson(value: unknown): string {
  return stableStringify(value as Parameters<typeof stableStringify>[0]);
}

/** Plain (untagged) sha256 hex over utf8; signed messages embed this form. */
export function sha256HexOf(data: string): string {
  return createHash("sha256").update(data, "utf8").digest("hex");
}

export function canonicalJsonHash(value: unknown): string {
  return sha256HexOf(canonicalJson(value));
}
