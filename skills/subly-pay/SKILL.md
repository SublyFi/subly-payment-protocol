---
name: subly-pay
description: Use Subly to pay compatible x402 APIs from Kamino vault yield and manage vault deposits, withdrawals and owner approvals. Use when the user asks to pay through Subly or manage their Subly wallet; an HTTP 402 response alone does not authorize a purchase.
metadata:
  version: 0.8.6
  openclaw:
    requires:
      bins:
        - node
        - npm
    primaryEnv: SUBLY_DEMO_AGENT_KEYPAIR_PATH
    envVars:
      - name: SUBLY_DEMO_AGENT_KEYPAIR_PATH
        required: false
        description: Absolute path to the local agent wallet keypair JSON. Required for local signing; custody signers use their provider configuration instead. The client loads the key locally; never share it.
      - name: SUBLY_RELAYER_URL
        required: true
        description: HTTPS URL of a relayer operator the user trusts.
      - name: SOLANA_RPC_URL
        required: false
        description: Solana RPC endpoint. Defaults to the public mainnet RPC.
      - name: SUBLY_MCP_MAX_AMOUNT_RAW_USDC
        required: false
        description: Per-payment cap in raw USDC units (6 decimals). Defaults to 10000 (0.01 USDC).
    emoji: "💸"
    homepage: https://github.com/SublyFi/subly-payment-protocol
---

# Subly pay (yield-funded x402)

Use the versioned client `npx -y @subly_fi/pay@0.8.6`. Supported sellers offer
Solana mainnet USDC `exact` with `extra.feePayer`. The client realizes accrued
vault yield through the chosen relayer, then pays through the seller's x402
facilitator. These are separate transactions.

## When to use

- Follow the user's chosen URL, amount cap, wallet and vault. Preserve any
  existing specific authorization; a request to install Subly does not itself
  authorize funding, deposits, withdrawals or paid API calls.
- The default API payment cap is `10000` raw USDC (0.01 USDC). The owner's
  policy may be stricter. Never raise either limit to make a test pass.

## One-time wallet setup (if not done yet)

For first-time setup, follow the [client guide](../../packages/pay/README.md).
Use Node.js 24+, a trusted operator's HTTPS URL, mainnet RPC and a reviewed
vault catalogue. Keep CLI and MCP on the same wallet, vault, relayer and
absolute `SUBLY_MCP_STATE_PATH`. Local keypairs, Circle and Privy are supported.
Subly does not create or fund wallets. Key creation belongs in the user's
private terminal: `solana-keygen new` displays a recovery phrase. Do not capture
it through an AI tool or ask for its output. The client reads a local key into
process memory to sign; it does not send that key to the relayer.

Run `npx -y @subly_fi/pay@0.8.6 doctor` before setup. It checks configuration and
reachability, not balances, simulation support or transaction success.

Agree on the first deposit amount and policy, then use `setup-link
--initial-deposit <rawAmount>`. Share the returned link privately with the owner.
After the owner approves on the correct domain, check `setup-status <sessionId>`.
Continue only when completed. First registration with a requested initial
deposit can include an approved `initialDepositApproval`; otherwise use the
normal separate deposit approval. Browser approval never executes a deposit.

For an existing owner, use `owner-link` and `owner-status` for policy changes,
reactivation, revocation or recovery cancellation. Use `recovery-status` to
inspect access. Start the 72-hour `recovery-start` process only when requested;
it cannot bypass an explicit owner revocation.

A new deposit may have no spendable yield. Check `budget` and wait until the
API price plus fees are covered; never reclassify principal as yield. This is
beta software without an external audit. See the [validation record](../../docs/validation.md).

## How to run

Run the one-shot pay command (no clone — uses the published package via npx)
with the resource URL:

```bash
npx -y @subly_fi/pay@0.8.6 fetch "<url>"
```

To set a tighter per-call cap (raw USDC, 6 decimals — e.g. 100 = 0.0001 USDC):

```bash
npx -y @subly_fi/pay@0.8.6 fetch "<url>" 100
```

The command prints JSON. Paid success includes `paid: true`, an HTTP 2xx
`status`, the response `body`, and a `payment` object with `amountRawUsdc`,
`payTo`, `feePayer`, `realizedRawUsdc`, `realizeTxSignature` and
`paymentTxSignature`. Report the delivered result and the returned signatures;
do not invent a receipt field or substitute the realization for the seller payment.

## Reading the result

- `paid: true` with a successful HTTP status and payment receipt means the
  paid request completed. `paid: false` does not establish payment.
- A refusal has `paid: false` and a `reason`:
  - `realize_failed` means yield realization was refused before submission.
    Inspect `detail.error.code`; `insufficient_yield` means the available yield
    does not cover this payment. Check the budget and wait rather than retrying
    in a loop. Other causes need their own diagnosis.
  - `amount_exceeds_client_cap` → the price exceeds the cap. Only re-run with a
    higher cap if the user confirms the price is expected.
  - `payment_outcome_unknown` can refer to unfinished yield realization or
    an external payment. Preserve state and inspect its stage. Follow the
    recovery guide to resume the original withdrawal when supported; for
    `external_outcome_unknown`, investigate the original seller/facilitator
    outcome with the operator. Do not force a new payment or delete state.
  - `realize_underfunded` means the realized amount was below the required
    price. Preserve the operation evidence and reconcile with the operator.
  - `approval_required` → the price exceeds the owner's approval threshold;
    NOTHING was paid. The output carries an `approveUrl`, an `approvalId`,
    and a ready-made `retry` command: paste the approveUrl to the user, and
    once they approve with their passkey or owner wallet, run the `retry`
    command for the same request. Preserve its URL, method, body, headers
    and cap rather than creating a different purchase:
    `npx -y @subly_fi/pay@0.8.6 fetch "<url>" <sameMaxAmountRawUsdc> apr_<approvalId>`
  - `state_persist_failed` → the local pending-payment marker could not be
    stored. Do not retry until the state path/disk issue is fixed.

## Deposits and withdrawals

- `npx -y @subly_fi/pay@0.8.6 deposit <amountRawUsdc> [apr_<approvalId>]`
- `npx -y @subly_fi/pay@0.8.6 withdraw <amountRawUsdc> [apr_<approvalId>]`

Deposits require owner approval by default; the active mandate controls the
deposit and withdrawal policy. If the output contains `"approvalRequired": true`, paste the
`approveUrl` to the user and retry with the printed `apr_...` id once they
approved. If it contains `"setupRequired": true`, run the owner onboarding
(setup-link) from the wallet-setup section first. Confirm any initial-deposit
approval before relying on it. For `submitted` or an interrupted operation,
keep its original `dep_...` / `wdr_...` ID and use
`npx -y @subly_fi/pay@0.8.6 status <intentId>`. Submission may be unresolved;
do not prepare another operation. Follow the [recovery guide](../../packages/pay/README.md#recovery-and-troubleshooting)
for interrupted yield realization or an unknown external payment.

## Guardrails

- Never read, print, or transmit the contents of the keypair file in
  `SUBLY_DEMO_AGENT_KEYPAIR_PATH`. Only the public receipt is shared.
- Do not raise the payment cap on your own initiative.
- Paste setup/approve links exactly as printed; never alter the values the
  human is asked to confirm, and never claim an approval happened — always
  verify via setup-status or by retrying with the approval id.

Preserve `SUBLY_MCP_STATE_PATH` across processes and restarts. An unknown payment outcome blocks retries. A stale `.lock` may be removed only after all clients using it stop; never delete pending-state JSON to retry.
