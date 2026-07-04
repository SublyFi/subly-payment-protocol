import { describe, expect, it } from "vitest";
import { canonicalJson, canonicalJsonHash } from "../src/lib/canonical-json.js";
import { SUBLY_VAULT } from "../src/config/constants.js";
import {
  bindingHashOf,
  mandateHashOf,
  mandatePayloadOf,
  mandateSigningMessage,
  parseMandatePolicy,
  validateMandateDocument,
  verifyEd25519Message
} from "../src/domain/spending-mandate.js";
import {
  AGENT_PUB,
  buildDocument,
  defaultPolicyWire,
  NOW_MS,
  OWNER,
  OWNER_PUB,
  sign
} from "./helpers/mandate-fixtures.js";

describe("canonical json", () => {
  it("is key-order independent and whitespace-free", () => {
    expect(canonicalJson({ b: 1, a: { d: null, c: "x" } })).toBe(
      '{"a":{"c":"x","d":null},"b":1}'
    );
    expect(canonicalJsonHash({ b: 1, a: 2 })).toBe(
      canonicalJsonHash({ a: 2, b: 1 })
    );
  });

  it("binds approvals to the exact operation content", () => {
    const payment = bindingHashOf({
      kind: "payment",
      payTo: AGENT_PUB,
      amountRawUsdc: "58000",
      resourceUrlHash: "ab".repeat(32),
      method: "POST"
    });
    const differentAmount = bindingHashOf({
      kind: "payment",
      payTo: AGENT_PUB,
      amountRawUsdc: "58001",
      resourceUrlHash: "ab".repeat(32),
      method: "POST"
    });
    expect(payment).not.toBe(differentAmount);
    expect(
      bindingHashOf({ kind: "deposit", amountRawUsdc: "58000" })
    ).not.toBe(bindingHashOf({ kind: "withdrawal", amountRawUsdc: "58000" }));
  });
});

describe("mandate document validation", () => {
  it("accepts a well-signed ed25519 mandate and hashes only the payload", () => {
    const document = buildDocument();
    const validated = validateMandateDocument({
      document,
      wallet: AGENT_PUB,
      vault: SUBLY_VAULT.address,
      nowMs: NOW_MS
    });
    expect(validated.mandateHash).toBe(mandateHashOf(mandatePayloadOf(document)));
    expect(validated.policy.perPaymentCapRawUsdc).toBe(10_000_000n);
    // Signatures must not influence the hash.
    expect(mandateHashOf(mandatePayloadOf({ ...document, ownerSignature: "x" })))
      .toBe(validated.mandateHash);
  });

  it("rejects a tampered payload (owner signature no longer verifies)", () => {
    const document = buildDocument();
    const tampered = {
      ...document,
      policy: { ...document.policy, perPaymentCapRawUsdc: "999000000" }
    };
    expect(() =>
      validateMandateDocument({
        document: tampered,
        wallet: AGENT_PUB,
        vault: SUBLY_VAULT.address,
        nowMs: NOW_MS
      })
    ).toThrowError(/ownerSignature/);
  });

  it("rejects a missing agent co-sign", () => {
    const document = buildDocument();
    const badCosign = { ...document, agentWalletSignature: document.ownerSignature };
    expect(() =>
      validateMandateDocument({
        document: badCosign,
        wallet: AGENT_PUB,
        vault: SUBLY_VAULT.address,
        nowMs: NOW_MS
      })
    ).toThrowError(/agentWalletSignature/);
  });

  it("rejects passkey owners until Phase 2 ships verification", () => {
    const document = buildDocument({ payload: { ownerAuth: "passkey" } });
    expect(() =>
      validateMandateDocument({
        document,
        wallet: AGENT_PUB,
        vault: SUBLY_VAULT.address,
        nowMs: NOW_MS
      })
    ).toThrowError(/passkey/);
  });

  it("rejects wrong wallet, wrong vault, and expired documents", () => {
    const document = buildDocument();
    expect(() =>
      validateMandateDocument({
        document,
        wallet: OWNER_PUB,
        vault: SUBLY_VAULT.address,
        nowMs: NOW_MS
      })
    ).toThrowError(/agentWallet/);
    expect(() =>
      validateMandateDocument({
        document,
        wallet: AGENT_PUB,
        vault: AGENT_PUB,
        nowMs: NOW_MS
      })
    ).toThrowError(/vault/);
    expect(() =>
      validateMandateDocument({
        document,
        wallet: AGENT_PUB,
        vault: SUBLY_VAULT.address,
        nowMs: document.expiresAtMs + 1
      })
    ).toThrowError(/expiresAtMs/);
  });
});

describe("policy validation", () => {
  it("enforces threshold < per-payment cap (three-band invariant)", () => {
    expect(() =>
      parseMandatePolicy({
        ...defaultPolicyWire(),
        approvalThresholdRawUsdc: "10000000"
      })
    ).toThrowError(/strictly below/);
    // threshold exactly cap-1 and full-HITL "0" are both fine.
    expect(
      parseMandatePolicy({
        ...defaultPolicyWire(),
        approvalThresholdRawUsdc: "9999999"
      }).approvalThresholdRawUsdc
    ).toBe(9_999_999n);
    expect(
      parseMandatePolicy({
        ...defaultPolicyWire(),
        approvalThresholdRawUsdc: "0"
      }).approvalThresholdRawUsdc
    ).toBe(0n);
  });

  it("treats null caps as delegated axes, not zero", () => {
    const policy = parseMandatePolicy({
      ...defaultPolicyWire(),
      dailyApiSpendCapRawUsdc: null,
      approvalThresholdRawUsdc: null
    });
    expect(policy.dailyApiSpendCapRawUsdc).toBeNull();
    expect(policy.approvalThresholdRawUsdc).toBeNull();
  });
});

describe("ed25519 message verification", () => {
  it("verifies and rejects appropriately", () => {
    const message = mandateSigningMessage("ab".repeat(32));
    const signature = sign(message, OWNER.secretKey);
    expect(
      verifyEd25519Message({
        message,
        signatureBase58: signature,
        publicKeyBase58: OWNER_PUB
      })
    ).toBe(true);
    expect(
      verifyEd25519Message({
        message: `${message}x`,
        signatureBase58: signature,
        publicKeyBase58: OWNER_PUB
      })
    ).toBe(false);
    expect(
      verifyEd25519Message({
        message,
        signatureBase58: "not-base58!!!",
        publicKeyBase58: OWNER_PUB
      })
    ).toBe(false);
  });
});
