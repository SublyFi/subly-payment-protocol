# Subly Spending Mandate Design — Delegated Signing, Threshold Approval, and Kill Switch

> **Historical design record.** This document preserves the original proposals,
> rationale, and dated implementation updates, including superseded decisions
> and planned features. Its regulatory comparisons are historical design
> rationale, not a current legal assessment. For current guarantees and usage,
> see the [security model](security-model.md) and [client guide](../packages/pay/README.md).

> **Implementation update (2026-09-16):** Multiple USDC Kamino vaults can now be selected.
> The current mandate key is `(wallet, vault)`, and PostgreSQL stores mandates in
> `vault_spending_mandates`. At startup, legacy `spending_mandates` records are
> copied to their corresponding vaults and retained, but are no longer updated.
> Approval reuse and decisions are restricted to the current mandate hash;
> approvals for another vault or a replaced mandate cannot be reused.
> Balances, spending caps, and revocation are per vault. MCP payment deduplication
> is shared across vault selections. See the
> [operator guide](../deploy/README.md#advanced-your-own-kamino-vault) for setup and migration.

Created: 2026-07-04 JST / Initial status: **Phase 1 implemented** (server core,
2026-07-04; see “Implementation Notes — Phase 1” below). At the time of the
initial design, Phase 2 (web setup/approve pages + passkeys) was not yet implemented.
The later Phase 2 implementation notes below document its implementation and
refinements to the original design.

> Background: In response to regulatory requirements for human involvement when
> AI agents move funds, the industry (AP2 / Coinbase Agentic Wallets / Visa
> Intelligent Commerce / Mastercard Agent Pay) is converging on **human approval
> when delegating authority (a signed policy), infrastructure enforcement of that
> scope, transaction-time approval only above a threshold, and an audit trail
> with immediate revocation**, rather than human approval for every transaction.
> This design adds those four elements to Subly's existing architecture, where
> the relayer is the authoritative yield-only guard.

## Goal

1. **Spending Mandate**: Register a spending delegation document signed by the
   human owner with ed25519 at the relayer, and enforce its scope for every
   payment. Make “who approved what, and when” independently verifiable
   (equivalent to an AP2 Intent Mandate).
2. **Server-enforced caps**: Enforce per-payment / daily / monthly spending caps
   at the relayer. Move the per-payment cap (`defaultMaxAmountRawUsdc`), currently
   enforced only by the client, to a boundary the client cannot modify.
3. **Threshold escalation**: Refuse realization for payments above the mandate's
   `approvalThresholdRawUsdc` unless the owner has signed transaction-time
   approval (HITL).
4. **Kill switch + audit**: Let the owner immediately revoke a mandate at any
   time and track all payments in a human-readable spending log. The relayer
   records the mandate → realize transaction link itself; the realize → x402
   payment link is best effort, using client reporting and on-chain verification.

The existing yield-only guard (spendable-yield enforcement for
`purpose: "yield_realize"`) remains a structural ceiling that prevents touching
principal. The mandate adds another layer above it. The regulatory narrative
therefore has four layers: **mathematical ceiling (yield-only) × signed
delegation × threshold HITL × kill switch**.

## Non-goals

- On-chain mandate enforcement (program / PDA custody). Enforcement happens at
  the relayer. For the same reasons described in the Non-goals of
  technical-design.md, the claim is a relayer attestation.
- General multi-owner or role-based permissions. The owner is a single key.
- Notification channels (email / Slack / push). Phase 3 adds these as ways to
  deliver approval requests; this design specifies only approval
  **verification**, independent of the channel. The relayer trusts only the
  owner's signature.

## Core Decisions

- **Enforce at the relayer's `prepareWithdrawal(purpose: "yield_realize")`**.
  This is the single budget gate through which all x402 payments must pass,
  colocated with the existing yield-only guard. The modifiable client performs
  prechecks only.
- **Recommend separate owner credentials and agent keys, while allowing the
  same key (self mode)**. Self mode means `ownerAuth: "ed25519"` with the owner's
  public key equal to `agentWallet`; it is derived rather than stored as a
  separate field. In delegated mode (separate credentials), someone who obtains
  the agent key cannot relax the policy themselves. That separation is the
  purpose of delegation. Self mode still provides policy enforcement and audit
  records, but is weaker evidence of delegation; the documentation must make
  that distinction.
- **Add a payment binding to realization requests**. Realization currently
  carries only an amount. Require `{ payTo, amountRawUsdc, resourceUrlHash,
  method }` so caps apply to payments and audit records can identify what was
  paid for.
- **Aggregate rolling windows from the ledger instead of maintaining counters**
  (UTC-based 24h / 30d). Count confirmed realization as spending, conservatively
  including cases where realization succeeds but the x402 payment fails.
- **An approval is a document signed by the owner credential, bound to one
  operation, single-use, and subject to a TTL**. The agent cannot forge approval
  because it does not hold the owner credential. The primary delivery path is
  “the agent posts an approval link in chat → the human opens it on a phone and
  signs with a passkey / wallet,” with a CLI alternative for terminal users.
  Chat delivers the request; it does not carry the authorization itself.
- **Deposits (putting principal into DeFi) require owner approval by default,
  regardless of amount** (`depositPolicy: "owner_approval_required"`). Payments
  can use only yield, but deposits are the sole entry point that exposes
  principal to DeFi protocol risk. They are infrequent and large, making them
  the most worthwhile place for HITL friction. Include the first deposit in the
  mandate signed during setup (`initialDeposit`), so one Face ID interaction
  authorizes both the mandate and the first deposit. This extends the regulatory
  narrative to **principal never entering DeFi without human biometric approval**.

## Policy Layering — Combining Wallet Infrastructure Policies

An agent wallet need not be a raw local keypair. As the existing
`AgentWalletSigner` abstraction anticipates, signing may happen through wallet
infrastructure with its own policy engine: Privy / Turnkey / Coinbase CDP
(Agentic Wallets) / MPC custody / Squads-style smart accounts. These systems
can enforce per-transaction caps, session caps, payee allowlists, and their own
approval flows at the signer. This design layers on top of them:

```text
Layer 1  Wallet infrastructure policy (signer boundary)
         "What this key may sign" — protects all USDC in the agent ATA,
         including balances outside Subly, and the x402 payment transaction
         itself. Enforced by the custody infrastructure.
Layer 2  Subly Mandate (relayer boundary) ← this design
         "What may be realized from vault yield" — yield provenance,
         principal protection, delegation records, and the audit chain
         from realization to payment.
Layer 3  Yield-only guard (existing) — the mathematical ceiling.
```

Principles and design consequences:

- **Combine policies by intersection: the stricter rule wins**. A payment must
  pass both layers. Two independent denial points provide defense in depth: if
  one is bypassed, the other remains. This strengthens the regulatory argument.
  Do not create precedence resolution or delegation protocols between layers,
  which would introduce a way to disable one of them.
- **A Subly mandate does not replace wallet policy, or vice versa**. A wallet
  policy engine cannot distinguish principal from yield because it cannot see
  the vault ledger. Conversely, the Subly relayer cannot see outflows of
  non-Subly USDC from the agent ATA. They protect different assets and actions.
- **The human declares one of two operating modes at setup**:
  - `enforcementMode: "subly"` — a raw-keypair configuration (the current beta
    arrangement). Subly handles all caps, threshold approvals, and the kill
    switch. Even without a registered mandate, the relayer's default policy
    described below applies.
  - `enforcementMode: "wallet_infra"` — a signer backed by wallet infrastructure
    with a policy engine (Privy / Turnkey / CDP / Squads, etc.). Delegate caps
    and threshold approval to that infrastructure by setting fields such as
    `dailyApiSpendCapRawUsdc` to null. Subly retains yield provenance,
    delegation records, auditing, and `perPaymentCapRawUsdc` as a final
    vault-side backstop. This is a human self-declaration that the relayer
    cannot verify, so this mode must retain the backstop.
- **Duplicate HITL prompts**: If the wallet infrastructure also has threshold
  approvals, a single payment may require two approvals. Prefer concentrating
  escalation in one layer. If wallet infrastructure provides an approval flow,
  set `approvalThresholdRawUsdc: null` in the mandate and let Subly focus on caps
  and auditing. With a raw keypair, Subly is the only escalation layer. Confirm
  this choice during the `mandate init` interaction.
- **Mapping owner identity**: The owner in mandate v1 is an ed25519 key, so a
  human wallet such as Phantom can sign using message signing. Using the
  person's usual wallet as the owner key is the most natural delegated setup.
  Attestation-based mandates that treat a custody provider's administrator
  identity (OIDC / API key) as the owner are a future extension, outside v1.
- **Signer policy hook**: `IntentValidationPolicy` is the existing hook at the
  signer boundary where wallet infrastructure implementations add their own
  checks. This design does not change it.

## Mandate Document

Canonicalize JSON as key-sorted JSON (`JSON.stringify` with sorted keys and no
whitespace), implemented in `src/lib/canonical-json.ts`. The signed message
follows the same convention as wallet-auth (`src/api/wallet-auth.ts`):

```text
Signed message (one UTF-8 line):
  subly-mandate:v1:{sha256hex(canonicalJson(payload))}
```

Verification of `ownerSignature` follows one of two paths based on `ownerAuth`:

- `"ed25519"`: A detached signature over the message above, verified in the same
  way as wallet-auth.
- `"passkey"`: A WebAuthn assertion. Embed the message's sha256 in a
  relayer-issued challenge, then store and verify the entire assertion
  (authenticatorData + clientDataJSON + signature). WebAuthn signs
  `authenticatorData || sha256(clientDataJSON)`, not the message itself, so the
  verifier also checks the challenge, origin (rpId = app.subly.fi), and counter.

```json
{
  "version": 1,
  "ownerAuth": "passkey",
  "ownerCredential": {
    "credentialId": "<base64url WebAuthn credential id>",
    "publicKey": "<base64url COSE public key>"
  },
  "enforcementMode": "subly",
  "agentWallet": "<base58 agent wallet pubkey>",
  "vault": "5kfkpQZ6AkQgizHVThqkxD4J3db2i7pE3mHdPNRbx7jr",
  "issuedAtMs": 1751600000000,
  "expiresAtMs": 1783136000000,
  "policy": {
    "perPaymentCapRawUsdc": "10000000",
    "dailyApiSpendCapRawUsdc": "100000000",
    "monthlyApiSpendCapRawUsdc": null,
    "dailyDepositCapRawUsdc": "3000000000",
    "approvalThresholdRawUsdc": "1000000",
    "allowedPayToAddresses": null,
    "depositPolicy": "owner_approval_required",
    "withdrawalPolicy": "owner_approval_required"
  },
  "initialDeposit": { "amountRawUsdc": "500000000" }
}
```

For `ownerAuth: "ed25519"`, `ownerCredential` is
`{ "publicKey": "<base58 pubkey>" }`. Self mode means `ownerAuth: "ed25519"`
and publicKey = agentWallet; it is derived, with no separate field.
`enforcementMode` ("subly" | "wallet_infra") records the operating mode declared
in the Policy Layering section.

Explain the two main policy dimensions to users as **daily paid API spending**
(`dailyApiSpendCapRawUsdc`, the rolling 24h cap on confirmed yield_realize
amounts) and **how much may be deposited into DeFi** (`dailyDepositCapRawUsdc`,
the rolling 24h cap on confirmed vault deposits). The per-payment cap and
approval threshold provide additional safeguards within those limits.

Default policy, applied by the relayer when no mandate is registered and used
as the initial values for `mandate init`:

| Dimension | Default | Raw value |
| --- | --- | --- |
| `approvalThresholdRawUsdc` | 1 USDC — automatic at or below this amount | `"1000000"` |
| `perPaymentCapRawUsdc` | 10 USDC — an absolute cap that approval cannot override | `"10000000"` |
| `dailyApiSpendCapRawUsdc` | 100 USDC / day | `"100000000"` |
| `dailyDepositCapRawUsdc` | 3,000 USDC / day | `"3000000000"` |

**Three-tier semantics** (`threshold < per-payment cap` is an invariant checked
at registration):

```text
amount <= threshold            : automatic (do not ask the human)
threshold < amount <= cap      : execute with owner approval
cap < amount                   : refuse even with approval (absolute cap)
```

Approved payments still count toward daily / monthly caps. Approval waives the
threshold requirement, not the cap. As an industry reference, Coinbase / AWS
x402 design examples use a $100 session limit and human approval above $10.
Actual x402 payments are typically around 0.001–0.05 USDC, so a 1 USDC threshold
rarely triggers in normal operation. Because payments are yield-funded,
spendable yield normally runs out before the daily API cap becomes binding:
100 USDC/day in yield requires roughly 500,000 USDC in TVL. The daily cap is
therefore a backstop that is unlikely to trigger in normal use.

**Deposits do not use these three tiers**. With the default `depositPolicy:
"owner_approval_required"`, every deposit requires owner approval (Face ID),
regardless of amount. `dailyDepositCapRawUsdc` remains an absolute cap that
approval cannot override, just as payment approval does not waive caps.
Unlike payments, deposits are infrequent (the initial deposit and occasional
top-ups), so there is no automatic band below a threshold. Relaxing the policy
to `"agent_allowed"` permits automatic deposits within the cap as an opt-out
for advanced users.

- All amounts are raw USDC strings (6 decimals). A null cap explicitly means
  “do not check this dimension,” as when delegating it in wallet_infra mode,
  rather than an overall claim of unlimited spending. perPaymentCap is required.
- The document carries two signatures: `ownerSignature` (the owner key accepting
  the delegation) and `agentWalletSignature` (the agent wallet key signing the
  mandate hash, proving that the current authority over the funds agrees to
  appoint this owner). Initial registration verifies both. Replacement and
  revocation require only the current owner's signature; see “Establishing the
  Owner and Where Signing Happens.”
- `approvalThresholdRawUsdc: null` means no escalation: everything within caps
  is automatic. `"0"` means every payment requires approval, providing full HITL
  mode. A non-null threshold must satisfy `threshold < perPaymentCap` at
  registration (`invalid_policy_thresholds`).
- `allowedPayToAddresses`: An optional payee allowlist (null = unrestricted).
- `depositPolicy`: `"owner_approval_required" (default) | "agent_allowed"`.
  Requires owner approval for deposits that put principal into DeFi.
- `withdrawalPolicy`: `"agent_allowed" | "owner_approval_required"`.
  Can require owner approval for normal withdrawals (exiting principal).
  The agent's current ability to withdraw without restriction is a gap in the
  principal-protection narrative; delegated mode can close it.
- `initialDeposit` (optional, at the top level of the payload): The first
  deposit amount agreed during setup. The owner's mandate signature and the
  agent's co-signature also authorize this one deposit, analogous to an AP2
  Intent Mandate that includes the intended purchase. When activating the
  mandate, the relayer issues an **approved, single-use approval with a
  15-minute TTL**, bound to `{ kind: "deposit", amountRawUsdc }`. It returns the
  approvalId in the setup completion response and `GET mandate`, requiring only
  one Face ID interaction. Ignore `initialDeposit` on mandate replacement; it
  applies only to initial registration.
- Replacement requires `issuedAtMs` to be greater than the current value to
  prevent rollback replay. Revocation is immediate and permanent; only a new
  mandate registered by the same owner can restore access.
- **After `expiresAtMs`, treat the mandate as unregistered and fall back to the
  relayer's default policy**. This also removes `withdrawalPolicy` protection.
  Warn about an approaching expiry in the spending log and MCP responses, and
  prompt renewal through replacement.
- **Recovery after losing the owner credential (dead-man switch)**: To prevent
  principal from becoming locked when the owner loses both a passkey and its
  platform account, support delayed revocation authorized by the agent wallet
  key. `POST /v1/wallets/:wallet/mandate/recovery-revoke` (agent wallet-auth)
  schedules revocation. During a **72-hour grace period**, the current owner can
  veto it with one signature; expose the pending state in the spending log,
  MCP, and notification channels. After the grace period, the mandate expires
  and the default policy resumes. The agent cannot immediately remove the
  policy on its own, while an available owner can notice and stop recovery.
  This is the same compromise used in account recovery elsewhere in the industry.

## Approval Document

When the relayer creates a pending approval for a payment above the threshold,
the owner signs and returns a decision.

```text
Signed message (one UTF-8 line):
  subly-approval:v1:{approvalId}:{approve|deny}:{bindingHash}:{signedAtMs}
```

- `bindingHash = sha256hex(canonicalJson(binding))`. Approval is inseparably
  bound to a particular operation. There are three binding types:
  `{ kind: "payment", payTo, amountRawUsdc, resourceUrlHash, method }` /
  `{ kind: "deposit", amountRawUsdc }` /
  `{ kind: "withdrawal", amountRawUsdc }`. All share the same document format,
  TTL, and single-use rules.
- TTL: Automatically expire at `requestedAtMs + 15 min`.
- Single-use: Mark `consumed` when prepare succeeds. Reject reuse of the same
  approvalId. The Enforcement Flow section below refines consumption to occur
  at confirmation instead.
- `signedAtMs` establishes decision freshness, using the same 5-minute window
  as wallet-auth.

## Enforcement Flow

Add enforcement **before** the existing guard in
`VaultFlowService.prepareWithdrawal` for `purpose: "yield_realize"`. Extend the
input as follows:

```jsonc
// POST /v1/withdrawals/prepare (wallet-auth, signed by the agent)
{
  "wallet": "...",
  "amountRawUsdc": "58000",
  "purpose": "yield_realize",
  "payment": {                     // Required for yield_realize
    "payTo": "<base58 seller ATA owner>",
    "amountRawUsdc": "58000",
    "resourceUrlHash": "<sha256hex(url)>",
    "method": "POST"
  },
  "approvalId": "apr_..."          // Only on retries above the threshold
}
```

Checks run in this order, using the existing `error.code` format. Without a
registered mandate, read step 1 as “apply the default policy”:

1. Check that the mandate is active and unexpired → `mandate_revoked` /
   `mandate_expired`. An unregistered or expired mandate continues under the
   default policy.
2. Check `allowedPayToAddresses`, if set → `payee_not_allowed`.
3. Check `payment.amountRawUsdc <= perPaymentCapRawUsdc`, an absolute cap that
   approval cannot override → `per_payment_cap_exceeded`.
4. Check that confirmed realizations over the rolling 24h / 30d window plus
   this amount remain within daily / monthly caps → `daily_cap_exceeded` /
   `monthly_cap_exceeded`. Include approved payments in the total.
5. If `threshold < amount <= cap`, require an `approvalId` that (a) exists,
   (b) is `approved`, (c) has the matching bindingHash, (d) is unexpired, and
   (e) is unconsumed. Otherwise, **create a new pending approval** and return
   `approval_required` as below. While the default policy applies and no owner
   is registered, approval cannot be verified: refuse with
   `mandate_required_for_larger_payments` and direct the user to setup.
6. Apply the existing yield-only guard unchanged: spendable yield, instant
   liquidity, and the post-state principal invariant.

Consume an approval **when its authorized realization withdrawal reaches
`confirmed`, not when prepare succeeds**, linking it through
`consumed_by_withdrawal_id`. If submission or confirmation fails after prepare,
allow another prepare with the same approvalId within the TTL, with only one
in-flight intent at a time. This avoids asking the human to approve again after
each transient chain failure. Binding, TTL, and the single in-flight restriction
prevent replay.

The `approval_required` response uses HTTP 409 rather than 403. Nothing has
been realized, so retrying is safe:

```json
{
  "success": false,
  "error": {
    "code": "approval_required",
    "message": "This payment exceeds the approval threshold of 0.05 USDC. After owner approval, retry the same call with approvalId.",
    "approvalId": "apr_9f3c...",
    "expiresAtMs": 1751601000000,
    "approveUrl": "https://app.subly.fi/approve/apr_9f3c...",
    "approveCommand": "subly-pay approve apr_9f3c..."
  }
}
```

The agent posts `approveUrl` unchanged in chat as the primary path.
`approveCommand` is an alternative for terminal users.

On the deposit side, add two checks to `prepareDeposit`:

1. Confirmed deposits over the rolling 24h window plus this amount must remain
   within `dailyDepositCapRawUsdc`. Refuse excess with
   `daily_deposit_cap_exceeded`; approval cannot override this absolute cap.
2. With the default `depositPolicy: "owner_approval_required"`, require a valid
   `approvalId` bound to `{ kind: "deposit", amountRawUsdc }`, using the same
   single-use / TTL / bindingHash checks as payments. Otherwise, **create a
   pending approval and return `deposit_approval_required`** (409 with
   approveUrl, shaped like the payment `approval_required` response). Consume
   approval when the deposit is confirmed, as with payments. The first deposit
   can use the approval issued from the mandate's `initialDeposit`.

The deposit cap limits how quickly exposure to DeFi protocol risk increases,
rather than limiting principal itself. The approval asymmetry is deliberate:
a deposit **enters** risk and needs human consent; a withdrawal to the agent's
own ATA **exits** risk and is entrusted to the agent by default. It can be
restricted through `withdrawalPolicy`.

For wallets without a registered mandate, **apply the relayer's default
policy**: a Coinbase-style infrastructure default, so unconfigured wallets are
not unrestricted. The default has caps but no approval path. Without a
registered owner key, the relayer cannot verify approval, so amounts above the
threshold or cap are refused with `mandate_required_for_larger_payments` and a
setup link for owner registration. **Deposits likewise cannot be approved
without an owner and are refused with `mandate_required_for_deposit`**. Owner
registration through setup is effectively a prerequisite for deposits, extending
“principal never enters DeFi without owner approval” to unregistered wallets.
Including `initialDeposit` in setup makes the first deposit straightforward.
Registering a signed mandate replaces the default policy. Record
`policySource: "default" | "mandate:<hash>"` in the spending log. Roll out to
existing beta wallets using `SUBLY_MANDATE_ENFORCEMENT=off|warn|on` in the
relayer deployment environment; warn mode logs violations without blocking.

## API Surface

Add all endpoints to the existing Fastify server (`src/api/server.ts`). Verify
the **signature inside the document** (who approved it, retained for audit)
independently of the wallet-auth transport signature (who sent it).

```text
PUT  /v1/wallets/:wallet/mandate      Register/replace a mandate document with its owner signature
GET  /v1/wallets/:wallet/mandate      Current mandate and mandateHash (wallet or admin)
POST /v1/wallets/:wallet/mandate/revoke
                                      Owner-signed revocation document. Immediate revocation = kill switch
POST /v1/wallets/:wallet/mandate/recovery-revoke
                                      Agent wallet-auth. Schedule delayed revocation after losing the owner
                                      (effective after a 72h grace period)
POST /v1/wallets/:wallet/mandate/recovery-cancel
                                      Owner signature. Veto a pending recovery-revoke
GET  /v1/wallets/:wallet/approvals?status=pending
                                      List pending approvals (wallet or admin)
POST /v1/approvals/:approvalId/decision
                                      Owner-signed approve/deny document
GET  /v1/wallets/:wallet/spending-log
                                      Human-readable payment history (below)
POST /v1/payments/report              Agent wallet-auth. Report the payment transaction signature
                                      after x402 payment completion
                                      (linked to the realization's payment binding)
POST /v1/wallets/:wallet/setup-sessions
                                      Agent wallet-auth. Create a setup session prefilled with the
                                      agreed policy and initial deposit amount, and return its URL
                                      (10-minute TTL, single-use)
GET  /v1/setup-sessions/:sessionId    Content shown on the setup page (public, single-use URL)
POST /v1/setup-sessions/:sessionId/complete
                                      Create the owner credential and submit a signed mandate.
                                      Return an approved approvalId if initialDeposit is present
POST /v1/webauthn/challenge           Issue a challenge for passkey signing (approve / setup)
```

- Authorize `PUT mandate` / `POST revoke` / `POST decision` using the **owner
  credential's signature inside the document**: an ed25519 message signature,
  or a WebAuthn assertion with the document hash embedded in its challenge.
  Either a web page or CLI may carry the request. In self mode (owner publicKey
  = agentWallet), the agent key supplies the owner signature.
- Revocation document: `subly-mandate-revoke:v1:{mandateHash}:{signedAtMs}`.
- One spending-log entry per payment:
  `{ paidAtMs, payTo, amountRawUsdc, resourceUrlHash, method,
     realizeTxSignature, paymentTxSignature | null,
     paymentVerification: "verified_onchain" | "reported" | "unreported",
     decision: "auto_within_policy" | "owner_approved:apr_...",
     mandateHash }`
  This maps “delegation → individual decision → execution transaction” from
  the relayer ledger, analogous to AP2's intent → cart → payment chain.
- **Honest limits of the audit chain**: The relayer records mandate → realize
  transaction itself, but the x402 payment transaction occurs on the client
  through @x402/svm and is not directly observed by the relayer. The payment
  binding is a declaration of intent to pay. After success, the client reports
  the transaction signature through `POST /v1/payments/report`. The relayer
  performs best-effort on-chain TransferChecked verification (payTo / amount)
  and records `paymentVerification`. Realizations without a report remain
  `unreported`, distinguishable in the audit trail.

## Data Model (Postgres)

```sql
CREATE TABLE spending_mandates (
  wallet            TEXT PRIMARY KEY,
  mandate_json      JSONB NOT NULL,        -- Original document, including signatures
  mandate_hash      TEXT NOT NULL,         -- sha256hex(canonicalJson(payload))
  owner_auth        TEXT NOT NULL,         -- passkey | ed25519
  owner_credential  JSONB NOT NULL,        -- credentialId + COSE public key, or base58 pubkey
  enforcement_mode  TEXT NOT NULL,         -- subly | wallet_infra
  issued_at_ms      BIGINT NOT NULL,
  expires_at_ms     BIGINT NOT NULL,
  status            TEXT NOT NULL,         -- active | revoked | recovery_pending
  recovery_at_ms    BIGINT,                -- Scheduled activation time of the dead-man switch
  revoked_at_ms     BIGINT,
  revoke_json       JSONB                  -- Signed revocation / recovery document
);

CREATE TABLE spending_mandate_events (     -- Append-only history of registration/replacement/revocation
  id              BIGSERIAL PRIMARY KEY,
  wallet          TEXT NOT NULL,
  event_type      TEXT NOT NULL,           -- registered | replaced | revoked
  mandate_hash    TEXT NOT NULL,
  document_json   JSONB NOT NULL,
  created_at_ms   BIGINT NOT NULL
);

CREATE TABLE payment_approvals (           -- Shared by payment / deposit / withdrawal
  approval_id     TEXT PRIMARY KEY,        -- apr_ + random
  wallet          TEXT NOT NULL,
  binding_hash    TEXT NOT NULL,
  binding_json    JSONB NOT NULL,          -- kind: payment | deposit | withdrawal
  mandate_hash    TEXT NOT NULL,
  status          TEXT NOT NULL,           -- pending | approved | denied | expired | consumed
  decision_json   JSONB,                   -- Signed decision document; for initialDeposit:
                                           -- { source: "mandate_initial_deposit", mandateHash }
  requested_at_ms BIGINT NOT NULL,
  decided_at_ms   BIGINT,
  consumed_at_ms  BIGINT,
  consumed_by_withdrawal_id TEXT           -- Realization that consumed approval on confirmation
);
```

Aggregate spending through rolling-window queries on `withdrawal_intents`
(purpose = yield_realize, status = confirmed). Add `payment_binding JSONB`,
`mandate_hash`, `payment_tx_signature` (reported by the client), and
`payment_verification` to intent rows. Aggregate deposits similarly from
`deposit_intents` with status = confirmed. Index `(wallet, confirmed_at_ms)`
on both tables.

## Client / MCP Changes

- Add a payment binding to the input of `YieldRealizer.ensureUsdcAvailable`.
  `standard-x402-payer.ts` already has payTo / amount / url from the 402
  challenge, so it only needs to pass them through.
- After a successful payment (when x402Fetch returns 200), the payer reports
  the payment transaction signature through `POST /v1/payments/report` on a
  best-effort basis. Reporting failure must not affect the payment result.
- Add reason `"approval_required"` to `StandardX402PayError`. State explicitly
  that **nothing has been paid**, because refusal occurred before realization.
  Include `approvalId` / `approveUrl` / `expiresAtMs` in the details.
- MCP `fetch_with_subly_payment`: Return `approval_required` as a structured
  response rather than isError. Its tool description must instruct the agent
  to present `approveUrl` unchanged to the user and retry the same call with
  approvalId once the user says approval is complete. Add approvalId to the
  tool input.
- `packages/pay` CLI (**an alternative for terminal users**): The owner runs it
  on their own device. It reads a passphrase-encrypted owner key and rejects
  plaintext keypairs:

```text
subly-pay mandate init      Interactively choose a policy, sign it, and register it
subly-pay mandate show      Current mandate and usage (remaining daily/monthly budget)
subly-pay mandate revoke    Kill switch
subly-pay approve <id>      Show pending approval details → y/N → sign and submit
subly-pay log               Human-readable spending log
```

Because `mandate init` requires `agentWalletSignature` as a co-signature, it
works only when the agent keypair and owner key are on the same machine, as in
a Claude Code setup. Use web setup when the agent is on a separate VPS.

- `deposit_to_subly_vault` (MCP): Return `deposit_approval_required` /
  `mandate_required_for_deposit` as structured responses rather than isError.
  Present approveUrl or a setup link to the user, then retry with approvalId
  after approval. This follows the same UX as `approval_required` for
  `fetch_with_subly_payment`. Add approvalId to the tool input. The initial
  deposit uses the approvalId returned at setup completion without another
  human action.
- `withdraw_from_subly_vault` (MCP): Use the same escalation when
  `withdrawalPolicy: "owner_approval_required"`, with approval bound to
  `{ kind: "withdrawal", amountRawUsdc }`.

### Setup Timing — Agree in Chat, Authorize on the Human's Phone

Subly's primary agent environments include setups where the human has no
terminal: with OpenClaw, for example, the agent runs as a persistent process on
a VPS while the human interacts only through Telegram / WhatsApp. Authorization
must therefore be completed on the human's phone or browser. The structure is
the same as Circle CLI: agree in conversation, then authorize somewhere the
agent cannot reach. Here, **a link in chat plus a passkey / wallet signature**
replaces a terminal plus email OTP.

**Appoint the owner during onboarding, in the conversation that prepares the
first deposit**. At that point, the human asking the agent to configure Subly
is necessarily present in chat. The flow is:

1. The agent presents the default policy in chat (approval threshold 1 / absolute
   cap 10 / daily API spending 100 / daily deposits 3,000 USDC) and the **initial
   deposit amount**. The human and agent agree on any changes.
2. The agent creates a setup session at the relayer using agent wallet-auth,
   prefilled with the agreed values and initial deposit amount. It posts the
   returned **setup link unchanged in chat**:
   `https://app.subly.fi/setup/st_...` (10-minute TTL, single-use).
3. The human opens the link on a phone. The page **only displays** the agent
   wallet address, proposed policy, and initial deposit amount. It is
   confirm-only: values cannot be edited on the page. To change them, the human
   returns to chat, agrees on new values, and has the agent issue another
   session. The mandate includes the agent wallet's co-signature over the
   mandate hash, so changing values on the page would invalidate that signature.
   Confirm-only also follows the payment UI principle that amounts cannot be
   modified on an approval screen. After reviewing the details, the human
   **creates an owner credential and signs** using one of:
   - **Passkey (default)**: WebAuthn, created and used immediately with Face ID
     or a fingerprint. No wallet app is needed. This is the same mechanism Visa
     / Mastercard use to authorize agent payments and is the most accessible
     option for consumers.
   - **Solana wallet (advanced users)**: Message signing with Phantom or a
     similar wallet, using the mandate v1 ed25519 owner format directly.
4. The relayer activates the mandate and issues an approved approvalId for
   `initialDeposit`. The agent checks the result through a read-only API,
   summarizes it in chat, and makes the initial deposit using that approvalId.
   **One Face ID interaction covers both the mandate and the initial deposit**.
   If setup is skipped, the relayer's default policy continues to govern
   payments, but **deposits cannot proceed without an owner to approve them**
   (`mandate_required_for_deposit`). Setup is therefore effectively required to
   start using Subly. Later deposits each use an approval link followed by Face
   ID, the same mechanism as threshold approval for payments.

**Above-threshold approval uses the same mechanism**: the agent posts
`https://app.subly.fi/approve/apr_...` in chat; the human opens it on a phone,
reviews the payment details (recipient / amount / URL), and signs with a
passkey or wallet; the agent retries with approvalId. Put the kill switch
(revoke) on the same management page, authorized by the same credential. Keep
`subly-pay` CLI as an **alternative** for terminal users such as Claude Code
users, with mandatory passphrase encryption for the owner key. The primary
path remains the web.

**Email is unnecessary**. Circle uses email plus OTP because its identity model
is based on email; OTP itself is not the goal. Subly's identity is a key from
the outset (wallet-auth: the wallet key itself is the identity), so the owner
key's signature provides proof of authorization directly. It is stronger than
a one-time OTP in this design's rationale: cryptographic, non-repudiable, and
independently verifiable afterward. Email / Slack and similar channels are
useful only for **notification delivery**, such as alerting an absent human to
an above-threshold request, rather than as proof of authorization. Add them as
optional Phase 3 webhooks, not required elements of the specification. When the
human is present in chat, the agent's request is itself the notification.

### Owner Key Isolation — Structurally Restrict Signing to the Human

Make clear that there are two kinds of signatures, with opposite automation
requirements:

- **Agent key**: The agent **automatically signs payments within policy during
  the conversation, without asking the human**. This is the product's core
  function. Prior policy and relayer enforcement provide control, as in
  Coinbase's automatic enclave signing. The agent key also signs deposit
  transactions automatically, but the relayer will not return a prepared
  transaction without owner approval (approvalId), so the human's Face ID
  interaction always comes first.
- **Owner key**: Used for mandate registration / changes / revocation and
  approvals. Automatic signing would eliminate human approval. The system must
  therefore make it **impossible for the agent to perform this signing** through
  its structure, not merely through an operating rule.

Threat: The agent has a shell, such as Bash in OpenClaw / Claude Code. If the
owner key is a **plaintext file on the same machine**, the agent can complete
`subly-pay approve` on its own. “Run this on the human's device” would then be
an unenforced request. This is exactly the problem Circle's email OTP addresses:
the final authorization factor exists only outside the machine, in the human's
inbox.

Countermeasures that preserve the same separation without requiring email:

1. **A credential on a separate device (primary path)**: Use a passkey held only
   on the human's phone / browser, or a key in the human's wallet such as
   Phantom. Perform setup / approval / revocation through web pages. The
   owner's secret **does not exist on the agent's machine**, so even an agent
   with a shell cannot complete approval. This follows the same pattern as
   Squads / Crossmint dual-key designs.
2. **CLI with a passphrase-encrypted owner key (alternative for terminal
   users)**: When using `subly-pay`, require encrypted storage and an interactive
   TTY passphrase prompt for signing. The CLI rejects plaintext keypairs and
   non-TTY stdin. The passphrase exists only in the human's memory, acting as
   the equivalent of OTP. README and CLI warnings must explicitly tell users
   not to enter it through the agent's shell.
3. **Self mode (owner = agent key) does not provide this guarantee**. Relayer
   enforcement of caps and yield-only limits, and auditing, still apply, but
   there is no cryptographic proof that a human approved an action. This is a
   compatibility mode for the beta's single-key operation. Regulatory claims
   assume at least delegated mode with an encrypted owner key.

Agent-runtime permission prompts (Claude Code / OpenClaw) and command allowlists
can provide an additional layer, but users may enable auto-approval, so this
design does not rely on them.

### Establishing the Owner and Where Signing Happens

**What establishes the owner, and when?** The owner is established **during
onboarding, when the human opens the setup link from the initial-deposit
conversation and creates a credential on their phone**. The mandate document
has two signatures: `ownerSignature` from the appointed owner credential
(accepting delegation), and `agentWalletSignature` from the agent wallet key
(proving that the current authority over the funds agrees to appoint that
owner, signed over the mandate hash). This pair establishes initial registration.
Afterward, **only the current owner's signature** authorizes replacement,
revocation, and approval.

Record the owner credential in the mandate through `ownerAuth`: `"passkey"`
(a WebAuthn credential whose assertion is verified as ownerSignature) or
`"ed25519"` (message signing by a Solana wallet / keypair). Neither appears
on-chain; they are used exclusively for off-chain signing. The owner identity
exists solely for authorization and needs neither funds nor SOL. **The owner
does not even need a wallet**: a passkey works for someone without a wallet app.
Keeping the agent wallet and owner separate is the recommended arrangement.

Explicit trust-model limitations and residual risks:

- Whoever controls the agent key at bootstrap can appoint the owner. No product
  can structurally prevent an agent that is already hostile during setup from
  abusing that authority; Circle likewise assumes the registered email belongs
  to the human. Delegation gains its meaning from separation after appointment.
- **The setup link is a capability: the first person to complete it becomes the
  owner**. A compromised chat channel can expose that link. Mitigate this with
  a 10-minute TTL, single-use completion, clear display of the agent wallet and
  policy so the human can compare them with the agreed setup, and a completion
  summary in chat so unexpected completion is visible. “Single-use” applies to
  completion; allow repeated GET requests and page reloads before completion.

**Where signing takes place**: Never inside the chat UI. Signing always means
that a process with access to the owner credential computes an ed25519
signature or WebAuthn assertion and submits it to the relayer over HTTPS POST:

| Signature | Execution location | Human action |
| --- | --- | --- |
| Agent key (payments / realization, deposits already approved by the owner) | Automatic inside MCP / a persistent process | None within policy; deposits require prior owner approval |
| Owner — web (primary path) | The human's phone / browser | Open the link from chat, review the details, then use Face ID (passkey) or wallet message signing |
| Owner — CLI (alternative) | The `subly-pay` process on the human's machine | Run `subly-pay approve <id>` in a separate terminal, confirm y/N, then enter the passphrase |

Both owner paths submit an HTTPS POST to the same approval API. The relayer
only verifies whether the signature is valid for the registered owner
credential. **The owner credential never needs to be on the agent's machine**;
keeping it off that machine is preferable.

**Experience in each agent environment**:

- OpenClaw (persistent agent on a VPS; human in Telegram / WhatsApp): When an
  approval is needed, the agent posts an approval link in chat. The human taps
  it on a phone, reviews the payment, uses Face ID, and finishes. No terminal
  is involved. Setup and owner appointment already followed the same pattern
  during onboarding.
- Claude Code (running in the human's terminal): The human can open the same
  approval link, or use `subly-pay approve <id>` in a separate terminal. Do not
  run it inside chat, including with a `!` prefix: the passphrase would pass
  through the agent's context. The CLI also rejects non-TTY stdin.

The web UI can be small: a static page and relayer APIs to fetch approval /
setup details, submit a decision, and issue WebAuthn challenges. This does not
require building a substantial website. Passkey assertion verification does,
however, add server-side implementation work compared with an ed25519-only
setup.

Passkeys work through the same link on a computer: Touch ID on Mac, or Windows
Hello (face / fingerprint / PIN) on Windows. WebAuthn cross-device authentication
can delegate to a phone's Face ID through a QR code. Browsers can invoke it not
only on computers without biometric sensors but also in **mixed ecosystems**,
such as using an Android-created passkey on a Mac when platform accounts do not
synchronize it. Within one ecosystem, such as iPhone + Mac, passkeys synchronize
across devices through Apple / Google accounts, so an owner credential created
on a phone can later be used in a desktop browser. A password manager such as
1Password can also synchronize across ecosystems. The approval device may vary
from one use to the next; the relayer checks only whether the assertion is
valid for the registered credential. Strictly speaking, the owner is linked to
the person's platform account rather than one device. Synced passkeys are the
industry-standard tradeoff; the core requirement remains that the credential
is absent from the agent's machine. Replace credentials after a device or
ecosystem change through mandate replacement signed by the current owner.

For comparison, the Circle skill's conservative recommendations are 1 USDC per
transaction, 5 daily, 20 weekly, and 50 monthly, much lower than Subly's defaults.
Circle's caps protect outflows from the entire wallet balance, including
principal; Subly's daily API cap is a backstop on a path that permits only
yield. The amount at risk therefore differs. Principal movement through
deposits / withdrawals is covered by `depositPolicy` (approval required),
`dailyDepositCapRawUsdc`, and `withdrawalPolicy`.

## Security Notes

- **Compromised agent key**: In delegated mode, an attacker can pay only within
  caps and the allowlist, and cannot change policy, approve, or revoke. The
  owner can stop activity immediately through revocation. This is the design's
  central claim. Mandatory deposit approval also prevents the attacker from
  moving additional USDC from the ATA into the vault without consent. Protecting
  the ATA balance itself against outflows belongs to Layer 1, the wallet
  infrastructure policy.
- **Detecting relayer tampering**: Echo `mandateHash` in every prepare response
  and spending-log entry so the owner can compare it with their signed document.
  A relayer that relaxes policy cannot forge the owner's signature.
- **Approval replay**: Single-use, bindingHash, and TTL. A new purchase with
  identical details requires a new approval.
- **Realized but unpaid**: If realization confirms but x402 payment fails, the
  amount has already counted toward caps because funds did leave the vault.
  This is consistent with existing `external_outcome_unknown` recovery.
- **Time**: Window aggregation and TTL use the relayer's clock. Requiring
  monotonically increasing `issuedAtMs` prevents re-registration of old mandates.
- **Recovery-revoke abuse**: An attacker with the agent key can schedule a return
  to default policy after 72 hours. Exposing the pending state in the spending
  log, MCP, and notifications lets the owner veto recovery and move funds during
  the grace period. This intentionally sacrifices immediate recovery to avoid
  funds becoming permanently locked when the owner credential is lost.
- **Approval consumption**: Consuming on confirmation and allowing prepare
  retries within TTL avoids requesting human approval again after chain
  failures. Binding, one in-flight intent, and TTL together prevent duplicate
  payments.

## Phasing

- **Phase 1 — Server core (default policy + cap enforcement + log)**:
  canonical-json / mandate verification, schema, prepareWithdrawal /
  prepareDeposit guards, relayer default policy, spending-log, and mandate API.
  The current source default is `on`. Only when migrating an existing beta
  environment, first observe `SUBLY_MANDATE_ENFORCEMENT=warn`, then change to
  `on`. This completes the core regulatory controls: caps even without explicit
  configuration, plus an audit trail.
- **Phase 2 — Owner experience integrated with chat (primary path)**:
  Web setup / approve / revoke pages with passkey and wallet signing,
  setup-session API including initialDeposit, approval table and decision API,
  and payer / MCP UX for `approval_required` / `deposit_approval_required` with
  approvalId retries. **Enable `depositPolicy` enforcement in this phase**,
  because it depends on the web approval mechanism; Phase 1 enforces only the
  daily deposit cap. This completes the entire OpenClaw flow for environments
  such as Telegram with no terminal: owner appointment, initial deposit,
  threshold approval, and kill switch.
- **Phase 3 — Delivery and extensions**: payTo allowlists, owner approval for
  withdrawals, webhook approval notifications, and the `subly-pay` CLI mandate /
  approve paths as an alternative for terminal users.

## Validation Plan

- Unit: Stable canonical JSON; mandate / approval / revocation signature
  verification (ed25519 + WebAuthn assertions); rolling-window boundaries
  (exactly cap / cap+1, 24h boundary); **all three threshold / cap tiers
  (exactly threshold / +1 / exactly cap / +1, and rejection of registration
  when threshold >= cap)**; approval state machine (pending → approved →
  consumed on confirmation, prepare retry within TTL after submission failure,
  expiry, binding mismatch); **deposit approval (refuse prepare without
  approvalId; initialDeposit approval issuance, single use, and ignoring it
  during replacement; daily deposit cap cannot be overridden by approval)**;
  setup-session single-use behavior and TTL; **recovery-revoke state transitions
  (scheduled → owner veto / grace period elapsed)**; on-chain verification for
  payments/report.
- Integration: Refusal matrix for prepareWithdrawal / prepareDeposit
  (error code × enforcement mode off/warn/on), and monotonic issuedAtMs on
  mandate replacement.
- E2E (mainnet demo): Onboard through a Telegram-like chat → complete the setup
  link using a passkey (one Face ID interaction for the mandate and initial
  deposit) → attempt an above-threshold Nansen purchase → receive
  `approval_required` → open the approval link on a phone and approve with a
  passkey → retry and complete payment → an additional deposit returns
  `deposit_approval_required` → approve → succeed → record `owner_approved` in
  the spending log; after revocation, refuse all payments and deposits.

## Implementation Notes — Phase 1 (Implemented 2026-07-04)

Implemented server core: `src/lib/canonical-json.ts`; document verification in
`src/domain/spending-mandate.ts`; enforcement and approval state machine in
`src/domain/spending-mandate-service.ts`; guard integration into
`VaultFlowService`; mandate / approvals / spending-log / payments/report APIs;
PostgreSQL schema (`spending_mandates`, `spending_mandate_events`,
`payment_approvals`); `SUBLY_MANDATE_ENFORCEMENT=off|warn|on` (default on);
and client payment-binding pass-through (`standard-x402-payer` →
`relayer-yield-realizer` → `vault-flows`). Tests:
`tests/spending-mandate*.test.ts`, `tests/mandate-api.test.ts`, and
`tests/vault-flow-service.test.ts` (integration section).

Differences from and refinements to the design:

- **Approval table and decision API moved forward into Phase 1**, initially
  supporting only ed25519 owners. Web pages and passkey (WebAuthn) verification
  remained in Phase 2. Mandates with `ownerAuth: "passkey"` were refused with
  `owner_auth_unsupported`, avoiding acceptance without verification.
- **The message signed by `agentWalletSignature`** is the same one-line message
  signed by the owner: `subly-mandate:v1:{mandateHash}`. This defines the exact
  bytes meant by “sign the mandate hash.”
- **Owner credential rotation uses `currentOwnerSignature`** on the replacement
  document: the current owner's signature over the new mandate message. It is
  unnecessary when replacing with the same credential. Restoring a revoked
  wallet accepts only a document with the same owner credential. Expired
  mandates and completed recovery are treated as unregistered, while issuedAtMs
  monotonicity is always enforced.
- **The recovery-cancel message** is
  `subly-mandate-recovery-cancel:v1:{mandateHash}:{signedAtMs}`.
- Intent records use `policyDecision` (`auto_within_policy` |
  `owner_approved:apr_...` | `warned:<code>` | `unenforced`) and `policySource`
  (`default` | `mandate:<hash>`). Realizations prepared at level=off record
  `unenforced` so they remain distinguishable in audits. A warn-mode realization
  with violations records the first violation as `warned:<code>`, preserving
  in the spending log that it did not fully satisfy the policy.
- **The kill switch is enforced in warn mode too**: `mandate_revoked` blocks
  realization and deposits in warn and on modes. Only off disables everything.
  Revocation can only result from an explicit owner action on a wallet with a
  registered mandate, so this does not break older clients lacking bindings.
- The mandate's expiresAtMs still applies during recovery_pending, with expiry
  taking precedence. Recovery-revoke / recovery-cancel on an expired mandate
  is refused with `mandate_expired`. An expired mandate is treated as
  unregistered, so re-registration is the appropriate action.
- `POST /v1/payments/report` accepts `{ wallet, withdrawalId,
  paymentTxSignature }`. It makes a best-effort check that the balance delta
  into the binding's payTo ATA is at least the amount, equivalent to checking
  TransferChecked, and records `verified_onchain | reported`. Each realization
  has one reported transaction. Replacing it with a different signature is
  refused with `payment_already_reported`; reporting the same signature again
  is idempotent. Verification may only advance from reported to
  verified_onchain, never regress.
- Persist lazy approval expiry only on state-transition paths, such as
  decisions or references during prepare. GET (listApprovals) returns a
  read-only derived view. Process approval decisions under the same wallet-vault
  lock as prepare.
- Phase 1 window aggregation reads a position's intents from the ledger and
  sums them in memory, following the existing flow's read pattern. Move to the
  planned SQL rolling-window queries and indexes if row counts become a problem.
- Warn mode does not create pending approvals because it does not block.
  Older clients without bindings also proceed with warning logs only. Switch
  to `on` only after clients (MCP / pay CLI) send bindings.

## Implementation Notes — Phase 2 (Implemented 2026-07-04)

Implemented owner experience integrated with chat: setup-session API
(`POST /v1/wallets/:wallet/setup-sessions` uses agent wallet-auth;
`GET /v1/setup-sessions/:id` and `POST .../complete` are public capability URLs);
three owner web pages served directly by the relayer (`/setup/:sessionId`,
`/approve/:approvalId`, `/revoke/:wallet`, self-contained HTML without external
assets, using passkeys by default and Phantom message signing as an
alternative); passkey (WebAuthn) verification in `src/domain/webauthn-owner.ts`;
depositPolicy enforcement (`deposit_approval_required` /
`mandate_required_for_deposit`); payer / MCP UX for `approval_required` and
related responses, with approvalId retries; and client calls to
`POST /v1/payments/report` using X-PAYMENT-RESPONSE on a best-effort basis.
Tests: `tests/setup-session.test.ts`, `tests/mandate-api.test.ts`
(setup-session API section), `tests/spending-mandate*.test.ts` (passkey /
deposit sections), `tests/standard-x402-payer.test.ts`, and
`tests/vault-flows.test.ts`.

Differences from and refinements to the design:

- **Passkey verification is implemented directly, without additional
  dependencies**. ownerCredential contains SPKI DER (base64url) from
  `AuthenticatorAttestationResponse.getPublicKey()`, rather than a COSE key,
  plus `algorithm` (COSE algorithm ID: -7 ES256 / -8 EdDSA / -257 RS256).
  Attestation is not verified; attestation "none" is assumed. As with ed25519,
  the trust anchor is an assertion from a registered credential. Device-origin
  attestation is not required. Assertions sign the standard WebAuthn
  `authenticatorData || sha256(clientDataJSON)`. The challenge is
  `base64url(sha256(messageToSign))`, cryptographically binding it to the
  document. Verify clientData type/origin, authenticatorData rpIdHash, and the
  UP+UV flags. Do not track signature counters: synced passkeys commonly keep
  them at 0, and clone detection is outside this trust model. All passkey owner
  signatures use `base64url(JSON {credentialId, authenticatorData,
  clientDataJSON, signature})` in the existing signature field (schema limit
  8KB).
- **Setup-session substitute for the agent co-signature**: Because
  ownerCredential is created on the page, the agent cannot sign the final
  mandate hash beforehand. Creating the session with agent wallet-auth, with
  policy / initialDeposit / TTL in the body, substitutes for that co-signature.
  Completion enforces an exact match to the session prefill
  (`setup_session_mismatch`); the page may choose only issuedAtMs and
  ownerCredential. The document's `agentWalletSignature` may be omitted only
  on the setup-session path. Record the session's wallet-auth headers in the
  mandate event as audit provenance.
- **The relayer serves the web pages**; app.subly.fi is unnecessary. Set rpId /
  origin explicitly through `SUBLY_WEBAUTHN_RP_ID` / `SUBLY_WEBAUTHN_ORIGINS`, or
  derive them from the `SUBLY_SETUP_URL_BASE` / `SUBLY_APPROVE_URL_BASE` URLs
  when unset. **Passkeys are bound to rpId, so production URL bases must match
  the domain serving the pages**, such as api.demo.sublyfi.com.
- Public reads for owner pages: `GET /v1/approvals/:approvalId` uses the URL
  itself as the capability. `GET /v1/wallets/:wallet/mandate/summary`, used by
  the revoke page, exposes only mandateHash / status / ownerAuth / credentialId,
  not policy details.
- Deposit approvals share the payment approval state machine, TTL, single-use,
  and in-flight rules, generalized through `requireOperationApproval`. Stamp
  DepositIntent with policySource / mandateHash / policyDecision / approvalId,
  and consume approval when the deposit is confirmed. Enforcement levels have
  the same meaning as in Phase 1: on enforces, warn only stamps
  `warned:<code>`, and the kill switch still blocks in warn mode.
- Client behavior: If `VaultFlowClient.deposit` receives
  `deposit_approval_required` without an explicit approvalId, it automatically
  resolves an already-approved deposit approval with the same amount binding
  (the form issued by initialDeposit) and retries once. This makes one Face ID
  interaction sufficient for the mandate and initial deposit, without extra
  agent-side work. MCP adds `create_subly_setup_link` / `check_subly_setup`.
  It returns `approval_required` / `deposit_approval_required` /
  `mandate_required_for_deposit` as structured responses, including approveUrl /
  approvalId / retry instructions, rather than isError.
- Client payments/report implementation: Read the payment transaction signature
  from the standard x402 settlement response header `X-PAYMENT-RESPONSE`
  (base64 JSON), then report it through the realizer on a best-effort basis.
  Reporting failure does not affect the payment result.

### Self-Review Fixes (2026-07-04, Immediately After Phase 2 Implementation)

- **Implemented withdrawalPolicy enforcement**, using the same escalation as
  deposits with binding `{ kind: "withdrawal", amountRawUsdc }` as specified
  above. Normal withdrawal prepare goes through `authorizeWithdrawal`. The
  default remains agent_allowed; `withdrawal_approval_required` (409 +
  approveUrl) applies only when the mandate opts into owner_approval_required.
  **The kill switch (revoked) also blocks withdrawals**: allowing principal to
  be withdrawn to the agent ATA after the owner no longer trusts the agent key
  would defeat revocation. Re-registration by the same owner removes the block.
  Revoke-page wording was also updated to cover payments / deposits / withdrawals.
- **Owner-page display hardening**: HTML-escape every dynamic value with
  `esc()`; this is essential for the agent-supplied `binding.method`. Add a CSP
  meta tag to every page (`default-src 'none'; script-src/style-src
  'unsafe-inline'; connect-src 'self'`). Restrict `paymentBindingSchema.method`
  to letters only (`^[A-Za-z]{1,16}$`).
- **The setup page displays every field in the signed policy**, adding monthly
  cap / allowedPayToAddresses / withdrawalPolicy and explicitly showing null
  caps as "No limit".
- **Setup links for wallets with existing mandates**: Include
  `existingMandate {status, ownerAuth}` in the pending view. Before Face ID,
  the page explains that a new passkey cannot replace the mandate because only
  the current owner can rotate it, and disables the passkey button. If the
  owner already uses a passkey, hide both buttons. The server continues to
  refuse unauthorized rotation with `owner_rotation_requires_current_owner`.
- `tests/owner-pages.test.ts` executes the inline JavaScript crypto helpers
  (canonicalJson / WebAuthn challenge / base58 / esc) and verifies byte-for-byte
  agreement with the server implementation. This includes a fix aligning
  base58's empty-input behavior with bs58.
- MCP setup tools do not perform chain sync or RPC calls because
  check_subly_setup is polled. Relayer error messages are consistently English.
