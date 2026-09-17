import bs58 from "bs58";
import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { SHARED_JS, setupPageHtml } from "../src/api/owner-pages.js";
import { defaultMandatePolicyWire } from "../src/domain/spending-mandate.js";
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

describe("setup page deposit approval scope", () => {
  // Execute the shipped inline page. A replaced/expired mandate does not
  // receive the first-registration deposit approval from the server.
  function renderSetup(existingMandate: null | { status: string; ownerAuth: string }) {
    const elements = new Map<string, {
      innerHTML: string; textContent: string; className: string;
      hidden: boolean; disabled: boolean; addEventListener: () => void;
    }>();
    const getElementById = (id: string) => {
      if (!elements.has(id)) elements.set(id, {
        innerHTML: "", textContent: "", className: "", hidden: true,
        disabled: false, addEventListener() {}
      });
      return elements.get(id)!;
    };
    const session = {
      wallet: "wallet", vault: "vault", policy: defaultMandatePolicyWire(),
      initialDepositRawUsdc: "1010000", existingMandate,
      mandateExpiresAtMs: Date.now() + 60_000
    };
    // This fixture has one script with literal template delimiters. Assert that
    // contract; this is not a general HTML parser or a sanitization filter.
    const [, scriptAndFooter, extraScript] = setupPageHtml().split("<script>");
    expect(scriptAndFooter).toBeDefined();
    expect(extraScript).toBeUndefined();
    const [script, footer, extraFooter] = scriptAndFooter!.split("</script>");
    expect(footer).toBeDefined();
    expect(extraFooter).toBeUndefined();
    const page = new Function("document", "location", "fetch", "initialSession", `${script}
      session = initialSession; render(); return { complete };`)(
      { getElementById }, { pathname: "/setup/test" },
      () => new Promise(() => {}), session
    ) as { complete(payload: unknown, signature: string): Promise<void> };
    return { elements, page, script, session, getElementById };
  }

  it.each(["expired", "recovery_elapsed"])(
    "requires a separate deposit approval when replacing a %s mandate", (status) => {
      const { elements } = renderSetup({ status, ownerAuth: "ed25519" });
      expect(elements.get("details")!.innerHTML).toContain("Deposit (separate approval required)");
      expect(elements.get("details")!.innerHTML).not.toContain("First deposit");
      expect(elements.get("btn-passkey")!.hidden).toBe(false);
    }
  );

  it("includes a deposit only for the first owner registration", () => {
    const { elements } = renderSetup(null);
    expect(elements.get("details")!.innerHTML).toContain("First deposit (included in this approval)");
    expect(elements.get("details")!.innerHTML).not.toContain("separate approval required");
  });

  it("reports a missing deposit approval after successful owner replacement", async () => {
    const { script, session, getElementById, elements } = renderSetup({ status: "expired", ownerAuth: "ed25519" });
    const complete = new Function("document", "location", "fetch", "initialSession", `${script}
      session = initialSession; return complete;`)(
      { getElementById }, { pathname: "/setup/test" },
      (_url: string, init?: RequestInit) => init?.method === "POST"
        ? Promise.resolve({ ok: true, json: async () => ({ initialDepositApproval: null }) })
        : new Promise(() => {}), session
    ) as (payload: unknown, signature: string) => Promise<void>;
    await complete({}, "signature");
    expect(elements.get("status")!.textContent).toContain("deposit still needs a separate owner approval");
    expect(elements.get("status")!.textContent).not.toContain("pre-approved");
  });
});
