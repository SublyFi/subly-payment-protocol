# Subly402 Custom Scheme

最終更新: 2026-06-02 JST

## Direction

Option A の yield buffer + standard x402 は実装しやすいが、次の弱点がある。

- buffer が足りないと API payment が失敗する。
- buffer に置いた USDC は Kamino で yield を稼がない。
- seller から見ると普通の x402 USDC payment であり、Kamino yield-funded の protocol 性が弱い。

Subly の本線は、標準 x402 互換ではなく **x402-like HTTP UX を持つ独自 scheme** とする。

```text
scheme = subly-yield-exact
```

UX goal:

```text
Agent calls API
API returns 402 Payment Required
Agent signs once
Subly facilitator realizes Kamino yield and pays seller
API returns response
```

## Core Constraint

Kamino yield is not a claimable cash balance. It is embedded in kToken/share appreciation.

Therefore Subly402 cannot literally transfer yield without redeeming shares. The protocol must do:

```text
redeem yield-equivalent Kamino shares
  -> receive USDC
  -> transfer USDC to seller
```

The innovation is making this one protocol-mediated payment flow rather than a user-visible withdraw step.

## HTTP Flow

### 1. Agent Requests Resource

```http
GET /v1/weather?city=Tokyo
```

### 2. Seller Returns Subly402 Payment Requirement

```http
HTTP/1.1 402 Payment Required
PAYMENT-REQUIRED: <base64-json>
```

Decoded payload:

```json
{
  "x402Version": 1,
  "accepts": [
    {
      "scheme": "subly-yield-exact",
      "network": "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp",
      "asset": "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
      "amount": "10000",
      "payTo": "sellerWallet",
      "resource": "GET https://api.example.com/v1/weather?city=Tokyo",
      "paymentId": "pay_...",
      "expiresAt": "2026-06-02T12:00:30.000Z",
      "facilitator": "https://facilitator.subly.finance"
    }
  ]
}
```

### 3. Agent Sends Requirement To Subly Facilitator

```http
POST /v1/subly402/prepare
```

Body:

```json
{
  "agentWallet": "agentPubkey",
  "vault": "5kfkpQZ6AkQgizHVThqkxD4J3db2i7pE3mHdPNRbx7jr",
  "paymentRequirement": { "...": "..." }
}
```

### 4. Facilitator Builds Yield Payment Transaction

If the current Kamino position has enough spendable yield and instant liquidity appears sufficient, facilitator returns a transaction requiring:

- Agent Wallet signature as Kamino share owner / token authority.
- Subly sponsor signature as fee payer.

Transaction shape:

```text
ComputeBudget
Kamino withdraw yield-equivalent shares -> agent USDC ATA
SPL Token TransferChecked USDC -> seller USDC ATA
Memo payment_id
```

The exact Kamino instructions may include optional unstake/setup instructions depending on the position.

### 5. Agent Signs Once

Agent signs the transaction. Subly sponsor signs as fee payer after validation and simulation.

### 6. Facilitator Settles

Facilitator sends transaction and waits for confirmation.

### 7. Agent Retries API Request

```http
GET /v1/weather?city=Tokyo
PAYMENT-SIGNATURE: <base64-subly-payment>
```

Seller verifies through Subly facilitator or by checking the receipt.

```http
HTTP/1.1 200 OK
PAYMENT-RESPONSE: <base64-json>
```

## Facilitator Verification Rules

The Subly facilitator must reject any transaction that violates these rules.

Payment requirement:

- `scheme == subly-yield-exact`
- `network == solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp`
- `asset == USDC mint`
- `amount` exactly matches seller requirement
- `payTo` resolves to expected seller USDC ATA
- `paymentId` unused and unexpired

Kamino:

- vault equals approved Subly Vault
- share mint equals Vault share mint
- user shares are sufficient
- computed spendable yield is sufficient
- withdrawal amount does not exceed yield budget plus configured tolerance
- no principal-basis reducing external activity is pending resync

Transaction:

- fee payer is Subly sponsor
- seller transfer is exact amount
- no unexpected writable accounts
- no extra token transfers
- no unknown program instructions
- memo/payment id is included
- transaction simulates successfully before sponsor signature

Post-settlement:

- seller received exact USDC amount
- budget ledger records spent yield
- SOL fee is converted to USDC and recorded as fee debt
- receipt is returned to seller and agent

## Liquidity Outcomes

### Case A: Instant Kamino Withdraw

Best path.

```text
HTTP 402 -> sign once -> withdraw yield + pay seller -> 200 OK
```

This is the intended x402-like UX.

### Case B: Kamino Withdraw Would Queue

The transaction cannot complete immediate seller payment from Kamino yield.

Subly has three possible policies.

#### B1: Return Budget Illiquid

```json
{
  "error": "budget_illiquid",
  "reason": "yield exists but is not instantly withdrawable",
  "retryAfterSeconds": 600
}
```

Pros:

- No credit risk.
- Honest accounting.

Cons:

- API UX is worse.

#### B2: Delayed Settlement

Seller accepts an async receipt:

```text
payment queued
resource delivered after settlement
```

Pros:

- No Subly treasury risk.

Cons:

- Not suitable for normal API calls expecting immediate response.

#### B3: Subly Liquidity Backstop

Subly pays seller immediately from treasury/settlement pool, then later recovers from the user's Kamino yield when withdrawal settles.

Pros:

- Best UX.
- Keeps user yield maximally deployed.

Cons:

- Subly takes liquidity and credit risk.
- Requires strict per-user credit limits, reserve monitoring, and risk pricing.

Recommended production policy:

```text
Default: B1 for early production
Premium/reliable tier: B3 with small credit limits
Avoid B2 for ordinary API requests
```

## Why This Is Different From Manual Withdraw

Manual flow:

```text
User/agent checks Kamino
withdraws yield
waits for confirmation
manually pays seller
seller manually verifies
```

Subly402 flow:

```text
Seller declares price over HTTP
Subly computes yield budget
Subly builds exact transaction
Agent signs once
Subly sponsors gas and settles
Seller gets verifiable receipt
API response is released
```

The protocol value is not that redeeming shares disappears. The value is that it becomes a payment primitive tied to HTTP resource access.

## Minimal Spec

Payment requirement:

```ts
type SublyYieldExactRequirement = {
  scheme: "subly-yield-exact";
  network: "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp";
  asset: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
  amount: string; // atomic USDC units
  payTo: string;
  resource: string;
  paymentId: string;
  expiresAt: string;
  facilitator: string;
};
```

Payment response:

```ts
type SublyPaymentResponse = {
  paymentId: string;
  status: "settled" | "budget_illiquid" | "queued" | "failed";
  txSignature?: string;
  amount: string;
  seller: string;
  vault: string;
  budgetSnapshot: {
    principalBasis: string;
    positionValue: string;
    spendableYieldBefore: string;
    spendableYieldAfter: string;
    feeDebt: string;
  };
};
```

## Practical Recommendation

Build Subly402 custom scheme as the product's main path.

Use this policy:

```text
No standing yield buffer by default.
Just-in-time Kamino yield realization.
Subly pays SOL fees.
If instant withdraw succeeds, seller is paid immediately.
If yield is illiquid, return budget_illiquid or optionally use Subly liquidity backstop.
```

For reliability, Subly may still keep a tiny operational buffer per active wallet or per pooled settlement account, but that is an optimization, not the primary design.

