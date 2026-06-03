# Pay-From-Yield Protocol Options

最終更新: 2026-06-02 JST

## Core Constraint

Kamino Vault yield is not a separate spendable token balance.

Yield exists as increased redeem value of the user's Kamino Vault shares/kTokens:

```text
position_value = shares * exchange_rate
yield_value = position_value - principal_basis
```

Therefore, a seller cannot receive "Kamino yield" directly unless that yield is first converted into USDC by redeeming/withdrawing some shares. The protocol can hide and automate that step, but it cannot avoid the economic operation.

## Standard x402 Solana Exact

The current x402 SVM `exact` scheme is a standard SPL/Token-2022 payment flow:

1. Seller returns `402 Payment Required`.
2. Client creates a partially signed Solana transaction.
3. Transaction contains a token transfer to seller.
4. Facilitator verifies the transaction and signs as fee payer.
5. Facilitator submits the transaction.

Important limitation:

Standard x402 SVM facilitator verification expects a narrow instruction layout:

```text
ComputeBudget
ComputeBudget
TransferChecked
optional Lighthouse/Memo
```

So a standard x402 `exact` payment cannot include Kamino withdraw instructions. If Subly wants to pay from Kamino yield while staying compatible with standard x402, Subly must have already realized yield into a USDC buffer before the API payment transaction.

## Option A: Yield Buffer + Standard x402

This is the most production-realistic approach.

```text
Background:
  Kamino shares -> withdraw yield -> Agent USDC yield buffer

API request time:
  standard x402 exact payment
  Agent signs USDC transfer from yield buffer
  Subly/facilitator pays SOL fee
```

User experience:

```text
Agent requests API
402 returned
Subly checks yield budget
USDC payment settles
API returns data
```

The user does not manually click withdraw. The withdraw is an invisible maintenance operation.

Pros:

- Compatible with standard x402 SVM.
- Simple seller integration.
- Fast API payment path.
- Works even if Kamino realization happened earlier.

Cons:

- Requires pre-funded yield buffer.
- Seller cannot independently know the USDC came from yield unless it trusts Subly receipt.

## Option B: Subly402 Pay-From-Yield Scheme

Subly can define a custom x402-like scheme:

```json
{
  "scheme": "subly-yield-exact",
  "network": "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp",
  "asset": "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
  "amount": "10000",
  "payTo": "seller",
  "extra": {
    "feePayer": "sublySponsor",
    "vault": "5kfkpQZ6AkQgizHVThqkxD4J3db2i7pE3mHdPNRbx7jr",
    "payerWallet": "agentWallet",
    "paymentId": "..."
  }
}
```

The payment payload may contain:

```text
Kamino withdraw yield-sized shares to payer USDC ATA
SPL TransferChecked exact amount to seller ATA
Memo payment_id
```

The Subly facilitator must verify:

- payment amount exactly matches seller requirement
- seller destination ATA is correct
- Kamino vault and share mint are the approved Subly vault
- withdraw amount is within Subly's computed spendable yield
- withdrawn USDC destination is the agent's expected token account
- transaction has no unapproved instructions
- Subly sponsor is fee payer and is not a transfer authority/source
- simulation succeeds before sponsor signature
- payment ID is not reused

Pros:

- Strongest "pay directly from Kamino yield" UX.
- A single HTTP payment attempt can include realization and payment.
- Subly receipt can attest that payment was approved against yield budget.

Cons:

- Not standard x402 `exact`; sellers must accept Subly402 or use Subly facilitator.
- Only works synchronously if Kamino withdraw is instant.
- If withdrawal queues, the API payment cannot settle immediately.
- Kamino withdraw transactions can be large/complex due to ALTs, unstake, reserve accounts, and queue paths.

## Option C: Two-Tx Just-In-Time Realization

This is a middle ground.

When the API request arrives:

```text
1. Subly sees yield buffer is low.
2. Subly builds Kamino yield realization tx.
3. Agent signs; Subly pays fee.
4. If confirmed and USDC arrives, Subly immediately builds x402 payment tx.
5. Agent signs; Subly pays fee.
6. API returns data.
```

Pros:

- Keeps standard x402 payment transaction clean.
- Does not require a large standing buffer.
- Easier than custom one-transaction scheme.

Cons:

- Slower than normal x402.
- Fails or delays if Kamino withdrawal queues.
- User/API may see `budget_pending`.

## Recommendation

Use Option A as the default production path:

```text
Maintain a small yield buffer.
Use standard x402 for seller payment.
Attach Subly receipt proving the payment passed yield-budget checks.
```

Add Option C as fallback for low buffer.

Build Option B only if Subly wants a differentiated protocol primitive and is ready to run a custom facilitator/scheme.

Messaging:

```text
Subly makes x402-like API payments using Kamino yield.
The withdraw/redeem operation is protocol-managed and hidden from the agent UX.
```

Avoid claiming:

```text
USDC can move directly out of Kamino yield without redeeming shares.
```

That is not how Kamino shares work.

## Sources

- x402 SVM exact scheme: https://github.com/x402-foundation/x402/blob/main/specs/schemes/exact/scheme_exact_svm.md
- x402 client/server flow: https://docs.x402.org/core-concepts/client-server
- x402 network/token support: https://docs.x402.org/core-concepts/network-and-token-support
- Kamino Vault model: https://kamino.com/docs/curators/vaults/concepts/how-vaults-work
- Kamino liquidity and withdrawals: https://kamino.com/docs/curators/vaults/concepts/liquidity-and-withdrawals
