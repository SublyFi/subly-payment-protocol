import bs58 from "bs58";
import nacl from "tweetnacl";
import { SUBLY_VAULT } from "../../src/config/constants.js";
import {
  mandateHashOf,
  mandateSigningMessage,
  type MandatePolicyWire,
  type SpendingMandateDocument,
  type SpendingMandatePayload
} from "../../src/domain/spending-mandate.js";

export const OWNER = nacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(11));
export const AGENT = nacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(12));
export const OWNER_PUB = bs58.encode(OWNER.publicKey);
export const AGENT_PUB = bs58.encode(AGENT.publicKey);
export const NOW_MS = 1_751_600_000_000;

export function sign(message: string, secretKey: Uint8Array): string {
  return bs58.encode(
    nacl.sign.detached(new TextEncoder().encode(message), secretKey)
  );
}

export function defaultPolicyWire(): MandatePolicyWire {
  return {
    perPaymentCapRawUsdc: "10000000",
    dailyApiSpendCapRawUsdc: "100000000",
    monthlyApiSpendCapRawUsdc: null,
    dailyDepositCapRawUsdc: "3000000000",
    approvalThresholdRawUsdc: "1000000",
    allowedPayToAddresses: null,
    depositPolicy: "owner_approval_required",
    withdrawalPolicy: "agent_allowed"
  };
}

export function buildDocument(overrides?: {
  payload?: Partial<SpendingMandatePayload>;
  policy?: Partial<MandatePolicyWire>;
  ownerKeys?: nacl.SignKeyPair;
  agentKeys?: nacl.SignKeyPair;
}): SpendingMandateDocument {
  const ownerKeys = overrides?.ownerKeys ?? OWNER;
  const agentKeys = overrides?.agentKeys ?? AGENT;
  const payload: SpendingMandatePayload = {
    version: 1,
    ownerAuth: "ed25519",
    ownerCredential: { publicKey: bs58.encode(ownerKeys.publicKey) },
    enforcementMode: "subly",
    agentWallet: bs58.encode(agentKeys.publicKey),
    vault: SUBLY_VAULT.address,
    issuedAtMs: NOW_MS - 1_000,
    // Far future so fixtures stay valid against both the injected test
    // clock (NOW_MS) and the real clock used by API-level tests.
    expiresAtMs: NOW_MS + 10 * 365 * 24 * 60 * 60 * 1000,
    policy: { ...defaultPolicyWire(), ...overrides?.policy },
    ...overrides?.payload
  };
  const message = mandateSigningMessage(mandateHashOf(payload));
  return {
    ...payload,
    ownerSignature: sign(message, ownerKeys.secretKey),
    agentWalletSignature: sign(message, agentKeys.secretKey)
  };
}
