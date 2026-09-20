# Spending mandates

A mandate records the owner's policy for one `(agent wallet, vault)` pair.
The relayer enforces it alongside the spendable-yield guard. It does not add
on-chain custody or prevent the agent key from transacting outside Subly.
For setup and policy changes, use the [client guide](../packages/pay/README.md);
see the [security model](security-model.md) for trust and recovery boundaries.

## Policy fields

USDC amounts are integer strings with six decimals: `1000000` is 1 USDC.

| Field | Meaning |
| --- | --- |
| `perPaymentCapRawUsdc` | Required positive per-payment ceiling. Owner approval cannot override it. |
| `dailyApiSpendCapRawUsdc` | Positive rolling 24-hour API ceiling, or `null` for no limit on this axis. |
| `monthlyApiSpendCapRawUsdc` | Positive rolling 30-day API ceiling, or `null`. |
| `dailyDepositCapRawUsdc` | Positive rolling 24-hour deposit ceiling, or `null`. |
| `approvalThresholdRawUsdc` | Payments above this amount need owner approval. `0` requires approval for every positive payment; `null` disables threshold escalation. A non-null threshold must be strictly below the per-payment cap. |
| `allowedPayToAddresses` | Nonempty list of allowed payment recipients, or `null` to leave recipients unrestricted. |
| `depositPolicy` | `owner_approval_required` or `agent_allowed`. |
| `withdrawalPolicy` | `owner_approval_required` or `agent_allowed` for normal withdrawals. |

Caps allow equality: a request is refused when it would exceed the cap. Deposit
limits apply to the requested amount before share rounding. API windows count
confirmed yield realizations, including when the subsequent seller payment
fails. Approval waives threshold escalation, never caps, the payee allowlist or
the yield guard. Normal withdrawals return funds to the agent and can include
principal; they are distinct from yield realizations.

Without an active mandate, the default policy allows 10 USDC per payment,
100 USDC of API spending per rolling 24 hours and 3,000 USDC of deposits per
rolling 24 hours. It requires payment approval above 1 USDC and approval for
all deposits, while allowing normal withdrawals. Monthly cap and payee allowlist
are unset. An operation requiring approval is refused until an owner exists.
Expired mandates fall back to this policy. Explicit revocation blocks new
relayer operations; expiry is not revocation.

`SUBLY_MANDATE_ENFORCEMENT=on` enforces these rules. `warn` logs violations and
`off` disables this layer. `warn` still blocks explicit revocation, but neither
mode enforces the complete owner policy.
The signed `enforcementMode` field does not install custody-provider rules or
remove Subly's checks. The independent yield guard still applies.

## Owner registration and approvals

Owners use an Ed25519 wallet or a passkey. Direct mandate registration requires
the owner and agent to sign the same mandate message. With a setup session,
the wallet-authenticated request binds the exact policy and replaces the agent's
document co-signature. Rotating the owner of a live mandate requires the existing owner's
authorization. Expiry or completed recovery can permit a new registration
without the old credential; explicit revocation cannot be bypassed this way. For independent human approval, the agent must not control the
owner credential.

Setup and owner-management links expire after 10 minutes and are single-use.
Approval requests normally expire after 15 minutes and bind to the wallet,
current mandate and exact operation. Payment bindings contain `kind: "payment"`, `payTo`,
`amountRawUsdc`, `resourceUrlHash` and `method`; deposit and normal-withdrawal
bindings contain their operation kind and amount. Changing the operation or
mandate invalidates reuse. The relayer reserves an approval for one in-flight
intent and consumes it on confirmation. On an uncertain outcome, reconcile the
same intent rather than submitting a replacement.

First registration can include approval for the exact initial deposit. Setup
completion does not transfer funds. Replacement setup and policy-management
links do not pre-approve deposits. See [owner management](api.md#owner-management-083)
for policy updates, revocation and the 72-hour lost-credential recovery process.

## Signed documents

Use the helpers in [spending-mandate.ts](../src/domain/spending-mandate.ts) and
[canonical-json.ts](../src/lib/canonical-json.ts). The mandate hash covers the
explicit payload, excluding signatures. Canonical JSON sorts object keys,
preserves array order, omits undefined object properties and has no extra
whitespace. Hashes are plain SHA-256 hex over UTF-8, without a `sha256-` prefix.
The approval binding hash is `canonicalJsonHash(binding)`.

```text
subly-mandate:v1:{mandateHash}
subly-mandate-revoke:v1:{mandateHash}:{signedAtMs}
subly-mandate-recovery-cancel:v1:{mandateHash}:{signedAtMs}
subly-approval:v1:{approvalId}:{approve|deny}:{bindingHash}:{signedAtMs}
```

Decision timestamps use Unix milliseconds and a five-minute freshness window.
Ed25519 signatures are base58 encoded. Passkey public keys use base64url SPKI
DER with a credential ID and COSE algorithm identifier; assertions use
base64url(SHA-256(message)) as their challenge. The verifier checks the
configured RP ID, origin, user presence, user verification and signature. It
does not provide attestation verification or signature-counter tracking. See
[webauthn-owner.ts](../src/domain/webauthn-owner.ts) for the accepted formats.

## Payment records

The authenticated `POST /v1/payments/report` body is
`{wallet, withdrawalId, paymentTxSignature}`. It links a confirmed yield
realization to one seller transaction. Records distinguish `unreported`,
`reported` and `verified_onchain`. On-chain verification checks a successful
transaction and sufficient USDC credit to the declared recipient's associated
token account; it does not prove API delivery.

A repeated report may upgrade verification for the same transaction signature;
it cannot replace the signature or downgrade a verified record. Chain lookup
is best effort, so `reported` does not imply failed settlement. The payment and
yield-realization transactions remain separate. See the [API reference](api.md)
and [troubleshooting](troubleshooting.md) for reconciliation.
