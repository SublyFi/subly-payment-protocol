/**
 * Spending Mandate documents — the owner-signed delegation that scopes what
 * an agent wallet may spend (docs/spending-mandate-design.md).
 *
 * This module owns the document formats and their cryptographic
 * verification; the enforcement logic lives in spending-mandate-service.ts.
 *
 * Signed messages (utf8, one line each):
 *   mandate           subly-mandate:v1:{sha256hex(canonicalJson(payload))}
 *   revoke            subly-mandate-revoke:v1:{mandateHash}:{signedAtMs}
 *   recovery cancel   subly-mandate-recovery-cancel:v1:{mandateHash}:{signedAtMs}
 *   approval          subly-approval:v1:{approvalId}:{approve|deny}:{bindingHash}:{signedAtMs}
 *
 * The mandate carries two signatures over the SAME mandate message: the
 * owner credential's (accepting the delegation) and the agent wallet key's
 * (the current holder of the funds consenting to the owner appointment).
 */
import bs58 from "bs58";
import nacl from "tweetnacl";
import { canonicalJsonHash } from "../lib/canonical-json.js";
import { parsePositiveRawUnits, parseRawUnits } from "../lib/raw-units.js";
import { badRequest } from "./errors.js";
import {
  SUPPORTED_COSE_ALGORITHMS,
  verifyWebAuthnOwnerAssertion,
  type WebAuthnOwnerConfig
} from "./webauthn-owner.js";

export type OwnerAuth = "ed25519" | "passkey";
export type MandateEnforcementMode = "subly" | "wallet_infra";
export type DepositPolicyMode = "owner_approval_required" | "agent_allowed";
export type WithdrawalPolicyMode = "agent_allowed" | "owner_approval_required";

/** Staged rollout level for the whole mandate layer (SUBLY_MANDATE_ENFORCEMENT). */
export type MandateEnforcementLevel = "off" | "warn" | "on";

export function parseMandateEnforcementLevel(
  value: string | undefined
): MandateEnforcementLevel {
  if (value === undefined || value === "" || value === "warn") {
    return "warn";
  }
  if (value === "off" || value === "on") {
    return value;
  }
  throw new Error(
    `SUBLY_MANDATE_ENFORCEMENT must be off|warn|on, got "${value}"`
  );
}

/** Wire form of the policy block (raw USDC amounts as strings). */
export interface MandatePolicyWire {
  perPaymentCapRawUsdc: string;
  dailyApiSpendCapRawUsdc: string | null;
  monthlyApiSpendCapRawUsdc: string | null;
  dailyDepositCapRawUsdc: string | null;
  approvalThresholdRawUsdc: string | null;
  allowedPayToAddresses: string[] | null;
  depositPolicy: DepositPolicyMode;
  withdrawalPolicy: WithdrawalPolicyMode;
}

/** Parsed policy used by enforcement. `null` caps mean "no check on this axis". */
export interface MandatePolicy {
  perPaymentCapRawUsdc: bigint;
  dailyApiSpendCapRawUsdc: bigint | null;
  monthlyApiSpendCapRawUsdc: bigint | null;
  dailyDepositCapRawUsdc: bigint | null;
  approvalThresholdRawUsdc: bigint | null;
  allowedPayToAddresses: string[] | null;
  depositPolicy: DepositPolicyMode;
  withdrawalPolicy: WithdrawalPolicyMode;
}

/**
 * Relayer default policy: applied to wallets with no registered mandate and
 * used as the `mandate init` prefill. Defaults per the design doc: approval
 * threshold 1 USDC, absolute per-payment cap 10 USDC, daily API spend
 * 100 USDC, daily deposit 3,000 USDC.
 */
export const DEFAULT_RELAYER_POLICY: MandatePolicy = {
  perPaymentCapRawUsdc: 10_000_000n,
  dailyApiSpendCapRawUsdc: 100_000_000n,
  monthlyApiSpendCapRawUsdc: null,
  dailyDepositCapRawUsdc: 3_000_000_000n,
  approvalThresholdRawUsdc: 1_000_000n,
  allowedPayToAddresses: null,
  depositPolicy: "owner_approval_required",
  withdrawalPolicy: "agent_allowed"
};

export interface MandateOwnerCredential {
  /** base58 ed25519 pubkey, or base64url SPKI DER for passkey owners. */
  publicKey: string;
  /** WebAuthn credential id; present only for ownerAuth "passkey". */
  credentialId?: string | undefined;
  /** COSE algorithm id of the passkey credential (-7 ES256 / -8 EdDSA / -257 RS256). */
  algorithm?: number | undefined;
}

/** The signed payload — everything except the signatures themselves. */
export interface SpendingMandatePayload {
  version: 1;
  ownerAuth: OwnerAuth;
  ownerCredential: MandateOwnerCredential;
  enforcementMode: MandateEnforcementMode;
  agentWallet: string;
  vault: string;
  issuedAtMs: number;
  expiresAtMs: number;
  policy: MandatePolicyWire;
  initialDeposit?: { amountRawUsdc: string } | undefined;
}

export interface SpendingMandateDocument extends SpendingMandatePayload {
  /**
   * Owner credential's signature over the mandate message: base58 ed25519,
   * or base64url(JSON WebAuthn assertion) for passkey owners.
   */
  ownerSignature: string;
  /**
   * Agent wallet key's signature over the same mandate message (co-sign).
   * Absent only on the setup-session path, where the wallet-auth'd session
   * creation stands in for it (see validateMandateDocument).
   */
  agentWalletSignature?: string | undefined;
  /**
   * Required only when replacing a mandate with a DIFFERENT owner credential
   * (credential rotation): the currently registered owner's signature over
   * the new mandate message.
   */
  currentOwnerSignature?: string | undefined;
}

/** Approval bindings — the operation content an approval is bound to. */
export type ApprovalBinding =
  | {
      kind: "payment";
      payTo: string;
      amountRawUsdc: string;
      resourceUrlHash: string;
      method: string;
    }
  | { kind: "deposit"; amountRawUsdc: string }
  | { kind: "withdrawal"; amountRawUsdc: string };

export function mandatePayloadOf(
  document: SpendingMandateDocument
): SpendingMandatePayload {
  // Explicit field pick: the hash must cover exactly the signed payload,
  // never the signatures riding alongside it.
  return {
    version: document.version,
    ownerAuth: document.ownerAuth,
    ownerCredential: {
      publicKey: document.ownerCredential.publicKey,
      ...(document.ownerCredential.credentialId === undefined
        ? {}
        : { credentialId: document.ownerCredential.credentialId }),
      ...(document.ownerCredential.algorithm === undefined
        ? {}
        : { algorithm: document.ownerCredential.algorithm })
    },
    enforcementMode: document.enforcementMode,
    agentWallet: document.agentWallet,
    vault: document.vault,
    issuedAtMs: document.issuedAtMs,
    expiresAtMs: document.expiresAtMs,
    policy: {
      perPaymentCapRawUsdc: document.policy.perPaymentCapRawUsdc,
      dailyApiSpendCapRawUsdc: document.policy.dailyApiSpendCapRawUsdc,
      monthlyApiSpendCapRawUsdc: document.policy.monthlyApiSpendCapRawUsdc,
      dailyDepositCapRawUsdc: document.policy.dailyDepositCapRawUsdc,
      approvalThresholdRawUsdc: document.policy.approvalThresholdRawUsdc,
      allowedPayToAddresses:
        document.policy.allowedPayToAddresses === null
          ? null
          : [...document.policy.allowedPayToAddresses],
      depositPolicy: document.policy.depositPolicy,
      withdrawalPolicy: document.policy.withdrawalPolicy
    },
    ...(document.initialDeposit === undefined
      ? {}
      : {
          initialDeposit: {
            amountRawUsdc: document.initialDeposit.amountRawUsdc
          }
        })
  };
}

export function mandateHashOf(payload: SpendingMandatePayload): string {
  return canonicalJsonHash(payload);
}

export function mandateSigningMessage(mandateHash: string): string {
  return `subly-mandate:v1:${mandateHash}`;
}

export function revokeSigningMessage(
  mandateHash: string,
  signedAtMs: number
): string {
  return `subly-mandate-revoke:v1:${mandateHash}:${signedAtMs}`;
}

export function recoveryCancelSigningMessage(
  mandateHash: string,
  signedAtMs: number
): string {
  return `subly-mandate-recovery-cancel:v1:${mandateHash}:${signedAtMs}`;
}

export function approvalSigningMessage(input: {
  approvalId: string;
  decision: "approve" | "deny";
  bindingHash: string;
  signedAtMs: number;
}): string {
  return `subly-approval:v1:${input.approvalId}:${input.decision}:${input.bindingHash}:${input.signedAtMs}`;
}

export function bindingHashOf(binding: ApprovalBinding): string {
  return canonicalJsonHash(binding);
}

export function verifyEd25519Message(input: {
  message: string;
  signatureBase58: string;
  publicKeyBase58: string;
}): boolean {
  let publicKey: Uint8Array;
  let signature: Uint8Array;
  try {
    publicKey = bs58.decode(input.publicKeyBase58);
    signature = bs58.decode(input.signatureBase58);
  } catch {
    return false;
  }
  if (publicKey.length !== 32 || signature.length !== 64) {
    return false;
  }
  return nacl.sign.detached.verify(
    new TextEncoder().encode(input.message),
    signature,
    publicKey
  );
}

/**
 * One owner-signature check for both credential kinds: ed25519 detached
 * message signatures and WebAuthn passkey assertions (which carry
 * sha256(message) as their challenge). Used for every owner-signed action —
 * mandate registration, replacement (currentOwnerSignature), revocation,
 * recovery cancellation, and approval decisions.
 */
export function verifyOwnerMessageSignature(input: {
  ownerAuth: OwnerAuth;
  credential: MandateOwnerCredential;
  message: string;
  signature: string;
  webauthn: WebAuthnOwnerConfig;
}): boolean {
  if (input.ownerAuth === "passkey") {
    return verifyWebAuthnOwnerAssertion({
      message: input.message,
      signature: input.signature,
      credential: input.credential,
      config: input.webauthn
    });
  }
  return verifyEd25519Message({
    message: input.message,
    signatureBase58: input.signature,
    publicKeyBase58: input.credential.publicKey
  });
}

/** DEFAULT_RELAYER_POLICY in wire form (setup-session prefill). */
export function defaultMandatePolicyWire(): MandatePolicyWire {
  const p = DEFAULT_RELAYER_POLICY;
  return {
    perPaymentCapRawUsdc: p.perPaymentCapRawUsdc.toString(),
    dailyApiSpendCapRawUsdc:
      p.dailyApiSpendCapRawUsdc === null ? null : p.dailyApiSpendCapRawUsdc.toString(),
    monthlyApiSpendCapRawUsdc:
      p.monthlyApiSpendCapRawUsdc === null
        ? null
        : p.monthlyApiSpendCapRawUsdc.toString(),
    dailyDepositCapRawUsdc:
      p.dailyDepositCapRawUsdc === null ? null : p.dailyDepositCapRawUsdc.toString(),
    approvalThresholdRawUsdc:
      p.approvalThresholdRawUsdc === null
        ? null
        : p.approvalThresholdRawUsdc.toString(),
    allowedPayToAddresses:
      p.allowedPayToAddresses === null ? null : [...p.allowedPayToAddresses],
    depositPolicy: p.depositPolicy,
    withdrawalPolicy: p.withdrawalPolicy
  };
}

export function parseMandatePolicy(wire: MandatePolicyWire): MandatePolicy {
  let policy: MandatePolicy;
  try {
    policy = {
      perPaymentCapRawUsdc: parsePositiveRawUnits(
        wire.perPaymentCapRawUsdc,
        "policy.perPaymentCapRawUsdc"
      ),
      dailyApiSpendCapRawUsdc:
        wire.dailyApiSpendCapRawUsdc === null
          ? null
          : parsePositiveRawUnits(
              wire.dailyApiSpendCapRawUsdc,
              "policy.dailyApiSpendCapRawUsdc"
            ),
      monthlyApiSpendCapRawUsdc:
        wire.monthlyApiSpendCapRawUsdc === null
          ? null
          : parsePositiveRawUnits(
              wire.monthlyApiSpendCapRawUsdc,
              "policy.monthlyApiSpendCapRawUsdc"
            ),
      dailyDepositCapRawUsdc:
        wire.dailyDepositCapRawUsdc === null
          ? null
          : parsePositiveRawUnits(
              wire.dailyDepositCapRawUsdc,
              "policy.dailyDepositCapRawUsdc"
            ),
      // "0" means every payment requires approval (full-HITL mode).
      approvalThresholdRawUsdc:
        wire.approvalThresholdRawUsdc === null
          ? null
          : parseRawUnits(
              wire.approvalThresholdRawUsdc,
              "policy.approvalThresholdRawUsdc"
            ),
      allowedPayToAddresses:
        wire.allowedPayToAddresses === null
          ? null
          : [...wire.allowedPayToAddresses],
      depositPolicy: wire.depositPolicy,
      withdrawalPolicy: wire.withdrawalPolicy
    };
  } catch (error) {
    throw badRequest(
      "invalid_policy",
      error instanceof Error ? error.message : "invalid mandate policy"
    );
  }

  // Three-band invariant: amounts up to the threshold run unattended,
  // threshold..cap needs owner approval, above the cap is refused outright.
  // threshold >= cap would make the approval band unreachable dead code.
  if (
    policy.approvalThresholdRawUsdc !== null &&
    policy.approvalThresholdRawUsdc >= policy.perPaymentCapRawUsdc
  ) {
    throw badRequest(
      "invalid_policy_thresholds",
      "approvalThresholdRawUsdc must be strictly below perPaymentCapRawUsdc",
      {
        approvalThresholdRawUsdc: policy.approvalThresholdRawUsdc.toString(),
        perPaymentCapRawUsdc: policy.perPaymentCapRawUsdc.toString()
      }
    );
  }

  return policy;
}

/** Allowed clock skew for issuedAtMs, and freshness window for decision-time
 *  signatures (revoke / recovery-cancel / approval decisions) — matches
 *  wallet-auth's 5 minute window. */
export const SIGNED_AT_MAX_AGE_MS = 300_000;

export interface ValidatedMandate {
  payload: SpendingMandatePayload;
  policy: MandatePolicy;
  mandateHash: string;
}

/**
 * Structural + cryptographic validation of a submitted mandate document.
 * Replace-time rules (issuedAtMs monotonicity, owner rotation) need the
 * existing record and live in the service.
 *
 * `agentCosign: "setup_session"` skips the agentWalletSignature check: the
 * owner credential is created ON the setup page, so the agent cannot have
 * pre-signed the mandate hash. There the agent's consent is the wallet-auth
 * signature over the setup-session request that pinned these exact values,
 * and the service enforces document == session prefill before calling this.
 */
export function validateMandateDocument(input: {
  document: SpendingMandateDocument;
  wallet: string;
  vault: string;
  nowMs: number;
  webauthn: WebAuthnOwnerConfig;
  agentCosign?: "document" | "setup_session" | undefined;
}): ValidatedMandate {
  const { document, wallet, vault, nowMs } = input;

  if (document.agentWallet !== wallet) {
    throw badRequest(
      "mandate_wallet_mismatch",
      "mandate agentWallet does not match the wallet this request acts on"
    );
  }
  if (document.vault !== vault) {
    throw badRequest(
      "mandate_vault_mismatch",
      `mandate vault must be the Subly vault ${vault}`
    );
  }
  if (document.ownerAuth === "passkey") {
    if (
      document.ownerCredential.credentialId === undefined ||
      document.ownerCredential.algorithm === undefined ||
      !SUPPORTED_COSE_ALGORITHMS.includes(document.ownerCredential.algorithm)
    ) {
      throw badRequest(
        "invalid_owner_credential",
        "passkey owners must provide ownerCredential.credentialId and a " +
          "supported COSE algorithm (-7 ES256, -8 EdDSA, -257 RS256)"
      );
    }
  }
  if (
    !Number.isSafeInteger(document.issuedAtMs) ||
    !Number.isSafeInteger(document.expiresAtMs) ||
    document.expiresAtMs <= document.issuedAtMs
  ) {
    throw badRequest(
      "invalid_mandate_times",
      "issuedAtMs and expiresAtMs must be sane unix milliseconds with expiresAtMs > issuedAtMs"
    );
  }
  if (document.issuedAtMs > nowMs + SIGNED_AT_MAX_AGE_MS) {
    throw badRequest(
      "invalid_mandate_times",
      "issuedAtMs is in the future beyond the allowed clock skew"
    );
  }
  if (document.expiresAtMs <= nowMs) {
    throw badRequest(
      "mandate_expired",
      "the submitted mandate is already past expiresAtMs"
    );
  }

  const policy = parseMandatePolicy(document.policy);
  const payload = mandatePayloadOf(document);
  const mandateHash = mandateHashOf(payload);
  const message = mandateSigningMessage(mandateHash);

  if (
    !verifyOwnerMessageSignature({
      ownerAuth: document.ownerAuth,
      credential: document.ownerCredential,
      message,
      signature: document.ownerSignature,
      webauthn: input.webauthn
    })
  ) {
    throw badRequest(
      "owner_signature_invalid",
      "ownerSignature does not verify against ownerCredential for this mandate"
    );
  }
  if (input.agentCosign !== "setup_session") {
    if (
      document.agentWalletSignature === undefined ||
      !verifyEd25519Message({
        message,
        signatureBase58: document.agentWalletSignature,
        publicKeyBase58: document.agentWallet
      })
    ) {
      throw badRequest(
        "agent_cosign_invalid",
        "agentWalletSignature does not verify against the agent wallet key for this mandate"
      );
    }
  }

  return { payload, policy, mandateHash };
}

export function assertFreshSignedAt(signedAtMs: number, nowMs: number): void {
  if (
    !Number.isSafeInteger(signedAtMs) ||
    Math.abs(nowMs - signedAtMs) > SIGNED_AT_MAX_AGE_MS
  ) {
    throw badRequest(
      "signature_expired",
      "signedAtMs is outside the allowed freshness window"
    );
  }
}
