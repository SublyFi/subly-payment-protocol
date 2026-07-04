import {
  createHash,
  generateKeyPairSync,
  randomBytes,
  sign as cryptoSign
} from "node:crypto";
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
import type { WebAuthnOwnerConfig } from "../../src/domain/webauthn-owner.js";

export const OWNER = nacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(11));
export const AGENT = nacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(12));
export const OWNER_PUB = bs58.encode(OWNER.publicKey);
export const AGENT_PUB = bs58.encode(AGENT.publicKey);
export const NOW_MS = 1_751_600_000_000;

export const TEST_WEBAUTHN: WebAuthnOwnerConfig = {
  rpId: "app.subly.fi",
  origins: ["https://app.subly.fi"]
};

/**
 * Simulated platform authenticator (ES256): produces the exact wire format
 * the setup/approve pages produce — SPKI public key + base64url(JSON
 * assertion) whose challenge is sha256 of the signed Subly message.
 */
export function createTestPasskey(config: WebAuthnOwnerConfig = TEST_WEBAUTHN) {
  const { publicKey, privateKey } = generateKeyPairSync("ec", {
    namedCurve: "P-256"
  });
  const credentialId = randomBytes(16).toString("base64url");
  const credential = {
    publicKey: publicKey
      .export({ format: "der", type: "spki" })
      .toString("base64url"),
    credentialId,
    algorithm: -7
  };

  function signAssertion(
    message: string,
    overrides?: {
      origin?: string;
      rpId?: string;
      flags?: number;
      type?: string;
      challenge?: string;
    }
  ): string {
    const clientData = Buffer.from(
      JSON.stringify({
        type: overrides?.type ?? "webauthn.get",
        challenge:
          overrides?.challenge ??
          createHash("sha256").update(message, "utf8").digest("base64url"),
        origin: overrides?.origin ?? config.origins[0]
      }),
      "utf8"
    );
    const authData = Buffer.concat([
      createHash("sha256")
        .update(overrides?.rpId ?? config.rpId, "utf8")
        .digest(),
      Buffer.from([overrides?.flags ?? 0x05]), // UP | UV
      Buffer.from([0, 0, 0, 0]) // counter
    ]);
    const signature = cryptoSign(
      "sha256",
      Buffer.concat([authData, createHash("sha256").update(clientData).digest()]),
      { key: privateKey, dsaEncoding: "der" }
    );
    return Buffer.from(
      JSON.stringify({
        credentialId,
        authenticatorData: authData.toString("base64url"),
        clientDataJSON: clientData.toString("base64url"),
        signature: signature.toString("base64url")
      }),
      "utf8"
    ).toString("base64url");
  }

  return { credential, signAssertion };
}

/** A passkey-owned mandate document signed the way the setup page signs it. */
export function buildPasskeyDocument(
  passkey: ReturnType<typeof createTestPasskey>,
  overrides?: {
    payload?: Partial<SpendingMandatePayload>;
    policy?: Partial<MandatePolicyWire>;
    agentKeys?: nacl.SignKeyPair;
    omitAgentCosign?: boolean;
  }
): SpendingMandateDocument {
  const agentKeys = overrides?.agentKeys ?? AGENT;
  const payload: SpendingMandatePayload = {
    version: 1,
    ownerAuth: "passkey",
    ownerCredential: passkey.credential,
    enforcementMode: "subly",
    agentWallet: bs58.encode(agentKeys.publicKey),
    vault: SUBLY_VAULT.address,
    issuedAtMs: NOW_MS - 1_000,
    expiresAtMs: NOW_MS + 10 * 365 * 24 * 60 * 60 * 1000,
    policy: { ...defaultPolicyWire(), ...overrides?.policy },
    ...overrides?.payload
  };
  const message = mandateSigningMessage(mandateHashOf(payload));
  return {
    ...payload,
    ownerSignature: passkey.signAssertion(message),
    ...(overrides?.omitAgentCosign === true
      ? {}
      : { agentWalletSignature: sign(message, agentKeys.secretKey) })
  };
}

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
