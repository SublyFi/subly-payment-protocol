import bs58 from "bs58";
import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { SHARED_JS } from "../src/api/owner-pages.js";
import { canonicalJson, sha256HexOf } from "../src/lib/canonical-json.js";
import { webAuthnChallengeFor } from "../src/domain/webauthn-owner.js";

/**
 * The owner pages ship their own crypto helpers as inline JS strings, so the
 * type checker never sees them. These tests EXECUTE that code (it only
 * defines functions at the top level; no DOM is touched until an element is
 * looked up) and prove the parts the owner's signature depends on byte-match
 * the server implementations.
 */
const helpers = new Function(
  `${SHARED_JS}; return { canonicalJson, sha256Hex, sha256Bytes, b64u, base58, esc };`
)() as {
  canonicalJson(value: unknown): string;
  sha256Hex(text: string): Promise<string>;
  sha256Bytes(text: string): Promise<Uint8Array>;
  b64u(bytes: Uint8Array): string;
  base58(bytes: Uint8Array): string;
  esc(value: unknown): string;
};

describe("owner-page inline helpers match the server", () => {
  it("canonicalJson byte-matches canonical-json.ts on mandate-shaped values", () => {
    const samples: unknown[] = [
      null,
      "text",
      42,
      true,
      ["b", "a", { z: 1, a: null }],
      {
        version: 1,
        ownerAuth: "passkey",
        ownerCredential: { publicKey: "pk", credentialId: "cid", algorithm: -7 },
        policy: {
          perPaymentCapRawUsdc: "10000000",
          dailyApiSpendCapRawUsdc: null,
          allowedPayToAddresses: ["addr2", "addr1"],
          depositPolicy: "owner_approval_required"
        },
        zLast: "sorted-first-by-key-not-position",
        dropped: undefined,
        issuedAtMs: 1751600000000
      }
    ];
    for (const value of samples) {
      expect(helpers.canonicalJson(value)).toBe(canonicalJson(value));
    }
  });

  it("computes the same mandate message hash as the server", async () => {
    const payload = { agentWallet: "w", policy: { a: "1" }, issuedAtMs: 5 };
    expect(await helpers.sha256Hex(helpers.canonicalJson(payload))).toBe(
      sha256HexOf(canonicalJson(payload))
    );
  });

  it("produces the exact WebAuthn challenge the relayer verifies", async () => {
    const message = "subly-mandate:v1:" + "ab".repeat(32);
    expect(helpers.b64u(await helpers.sha256Bytes(message))).toBe(
      webAuthnChallengeFor(message)
    );
  });

  it("base58-encodes like bs58 (including leading zeros)", () => {
    const cases = [
      new Uint8Array([]),
      new Uint8Array([0]),
      new Uint8Array([0, 0, 255, 1]),
      new Uint8Array(randomBytes(64))
    ];
    for (const bytes of cases) {
      expect(helpers.base58(bytes)).toBe(bs58.encode(bytes));
    }
  });

  it("escapes every HTML-active character", () => {
    expect(helpers.esc(`<svg onload=x> & "quoted" 'single'`)).toBe(
      "&lt;svg onload=x&gt; &amp; &quot;quoted&quot; &#39;single&#39;"
    );
  });
});
