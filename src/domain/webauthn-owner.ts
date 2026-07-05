/**
 * WebAuthn (passkey) owner-signature verification for spending mandates
 * (docs/spending-mandate-design.md, Phase 2).
 *
 * Passkey owners sign the SAME one-line messages as ed25519 owners; the
 * WebAuthn assertion binds to the message by carrying
 * base64url(sha256(message)) as its challenge. The registered credential
 * public key is the SPKI DER that the setup page reads from
 * AuthenticatorAttestationResponse.getPublicKey() (plus its COSE algorithm
 * id), so verification needs no CBOR or attestation parsing — the trust
 * anchor is the same as the ed25519 path: whoever holds the registered
 * credential is the owner. Signature counters are not tracked (synced
 * passkeys report 0; clone detection is not part of this trust model).
 */
import { createHash, createPublicKey, verify as cryptoVerify } from "node:crypto";

export interface WebAuthnOwnerConfig {
  /** Relying-party id the owner pages are served under (a hostname). */
  rpId: string;
  /** Web origins accepted in assertion clientDataJSON. */
  origins: string[];
}

/** COSE algorithm ids the setup page may register. */
export const COSE_ES256 = -7;
export const COSE_EDDSA = -8;
export const COSE_RS256 = -257;
export const SUPPORTED_COSE_ALGORITHMS: readonly number[] = [
  COSE_ES256,
  COSE_EDDSA,
  COSE_RS256
];

/** The wire form a passkey owner signature travels as: base64url(JSON of this). */
export interface WebAuthnAssertionWire {
  credentialId: string; // base64url
  authenticatorData: string; // base64url
  clientDataJSON: string; // base64url
  signature: string; // base64url
}

/** The challenge a passkey assertion must carry for a signed Subly message. */
export function webAuthnChallengeFor(message: string): string {
  return createHash("sha256").update(message, "utf8").digest("base64url");
}

const FLAG_USER_PRESENT = 0x01;
const FLAG_USER_VERIFIED = 0x04;

/**
 * Verifies a passkey owner assertion over a one-line Subly message. Returns
 * false for anything malformed — callers map that to their own error code,
 * exactly like verifyEd25519Message.
 */
export function verifyWebAuthnOwnerAssertion(input: {
  message: string;
  /** base64url(JSON WebAuthnAssertionWire). */
  signature: string;
  credential: {
    publicKey: string; // base64url SPKI DER
    credentialId?: string | undefined;
    algorithm?: number | undefined; // COSE alg id
  };
  config: WebAuthnOwnerConfig;
}): boolean {
  const assertion = decodeAssertion(input.signature);
  if (assertion === null) {
    return false;
  }
  if (
    input.credential.credentialId === undefined ||
    assertion.credentialId !== input.credential.credentialId
  ) {
    return false;
  }

  let clientDataBytes: Buffer;
  let authData: Buffer;
  let signature: Buffer;
  try {
    clientDataBytes = Buffer.from(assertion.clientDataJSON, "base64url");
    authData = Buffer.from(assertion.authenticatorData, "base64url");
    signature = Buffer.from(assertion.signature, "base64url");
  } catch {
    return false;
  }

  // Client data: a "webauthn.get" ceremony, over OUR message hash, from an
  // allowed origin. The challenge equality is what binds the biometric tap
  // to the exact document being authorized.
  let clientData: { type?: unknown; challenge?: unknown; origin?: unknown };
  try {
    clientData = JSON.parse(clientDataBytes.toString("utf8"));
  } catch {
    return false;
  }
  if (
    clientData.type !== "webauthn.get" ||
    clientData.challenge !== webAuthnChallengeFor(input.message) ||
    typeof clientData.origin !== "string" ||
    !input.config.origins.includes(clientData.origin)
  ) {
    return false;
  }

  // Authenticator data: correct relying party, user present AND verified
  // (Face ID / fingerprint / PIN — "UP without UV" silent taps are refused).
  if (authData.length < 37) {
    return false;
  }
  const expectedRpIdHash = createHash("sha256")
    .update(input.config.rpId, "utf8")
    .digest();
  if (!authData.subarray(0, 32).equals(expectedRpIdHash)) {
    return false;
  }
  const flags = authData[32]!;
  if ((flags & FLAG_USER_PRESENT) === 0 || (flags & FLAG_USER_VERIFIED) === 0) {
    return false;
  }

  // WebAuthn signs authenticatorData || sha256(clientDataJSON).
  const signedData = Buffer.concat([
    authData,
    createHash("sha256").update(clientDataBytes).digest()
  ]);

  try {
    const key = createPublicKey({
      key: Buffer.from(input.credential.publicKey, "base64url"),
      format: "der",
      type: "spki"
    });
    const algorithm = input.credential.algorithm ?? inferAlgorithm(key.asymmetricKeyType);
    switch (algorithm) {
      case COSE_ES256:
        if (key.asymmetricKeyType !== "ec") {
          return false;
        }
        return cryptoVerify(
          "sha256",
          signedData,
          { key, dsaEncoding: "der" },
          signature
        );
      case COSE_EDDSA:
        if (key.asymmetricKeyType !== "ed25519") {
          return false;
        }
        return cryptoVerify(null, signedData, key, signature);
      case COSE_RS256:
        if (key.asymmetricKeyType !== "rsa") {
          return false;
        }
        return cryptoVerify("sha256", signedData, key, signature);
      default:
        return false;
    }
  } catch {
    return false;
  }
}

function inferAlgorithm(keyType: string | undefined): number {
  switch (keyType) {
    case "ec":
      return COSE_ES256;
    case "ed25519":
      return COSE_EDDSA;
    case "rsa":
      return COSE_RS256;
    default:
      return 0;
  }
}

function decodeAssertion(signature: string): WebAuthnAssertionWire | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(signature, "base64url").toString("utf8"));
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) {
    return null;
  }
  const candidate = parsed as Record<string, unknown>;
  if (
    typeof candidate.credentialId !== "string" ||
    typeof candidate.authenticatorData !== "string" ||
    typeof candidate.clientDataJSON !== "string" ||
    typeof candidate.signature !== "string"
  ) {
    return null;
  }
  return {
    credentialId: candidate.credentialId,
    authenticatorData: candidate.authenticatorData,
    clientDataJSON: candidate.clientDataJSON,
    signature: candidate.signature
  };
}
