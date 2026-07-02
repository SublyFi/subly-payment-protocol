# Nansen x402 Yield Payment Architecture

調査日: 2026-07-01 JST

## 結論

Nansen のように既に公式 x402 に対応している Seller に対して、Seller 側に
Subly SDK / `subly-yield-exact` を入れてもらわずに、Buyer が Subly の
yield budget から支払う形には変更できる。

ただし、現行の Subly settlement transaction をそのまま Nansen の x402 に
差し込むことはできない。変更の本質は、Subly を Seller SDK から
Buyer-side payment router / spending account へ寄せること。

推奨するデモ方針:

```text
Buyer deposits USDC into Subly/Kamino
-> yield accrues
-> Subly checks spendable yield
-> realized-yield USDC buffer is funded
-> Buyer pays Nansen with standard x402 Solana exact
-> Nansen returns paid API data
-> Subly records external x402 receipt and keeps principal basis unchanged
```

Seller から見ると通常の x402 支払い。Buyer から見ると「元本を使わず、
発生済み yield だけで Nansen API を使った」という体験になる。

## Nansen の x402 条件

Nansen docs の `x402 Payments` page で確認した内容:

- API key / subscription なしで x402 pay-per-call を提供。
- 支払い network は Base と Solana。
- 通貨は USDC。
- Facilitator は Base が Coinbase CDP、Solana が Payai。
- Pro-tier endpoint は x402 対象。ただし labels 系など一部除外あり。
- 価格は endpoint tier ごとに `0.01 USDC` または `0.05 USDC`。
- x402 request rate limit は wallet ごとに `5 req/sec`, `60 req/min`。

デモでは Solana を優先する。Subly の既存資産、Kamino vault、agent wallet、
USDC mint が Solana mainnet 前提で揃っているため、Base 対応より実装量が少ない。

## なぜ現行 Subly フローのままでは無理か

現行コードの前提:

- `src/x402/headers.ts` は `scheme = subly-yield-exact` だけを valid payload として扱う。
- `src/x402/client.ts` は 402 challenge から `subly-yield-exact` requirement だけを選ぶ。
- `src/x402/seller.ts` は Seller が Subly facilitator の `/v1/x402/verify` と `/v1/x402/settle` を呼ぶ前提。
- `src/domain/payment-service.ts` の `/v1/payments/prepare` は Kamino redeem + seller transfer の canonical transaction を作る。

一方、公式 x402 Solana `exact` の payload は、`accepted.scheme = "exact"` と
`payload.transaction` を持つ partially signed Solana transaction であり、
facilitator はその transaction が `payTo` の USDC ATA に正しい transfer outcome
を生むかを検証してから fee payer として署名・送信する。

このため、Nansen の 402 は次のような標準 requirement を返す想定になる。

```json
{
  "scheme": "exact",
  "network": "solana:...",
  "amount": "...",
  "asset": "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
  "payTo": "...",
  "extra": {
    "feePayer": "..."
  }
}
```

Subly の Kamino withdraw + temporary settlement + seller transfer transaction は、
公式 x402 seller/facilitator から見ると独自 settlement であり、Nansen の
Payai facilitator が期待する標準 `exact` payload ではない。

主な非互換点:

- scheme が `subly-yield-exact` と `exact` で違う。
- Subly payload は `paymentId`, `requestBindingHash`, `serializedTransaction`,
  `agentSignature`, `temporarySettlementSignature` を持つ独自 shape。
- 公式 SVM exact payload は `payload.transaction` を持つ。
- 公式 SVM exact の sponsor/feePayer は Nansen 側 requirement の `extra.feePayer`。
  Subly sponsor を勝手に fee payer にできない。
- Subly settlement transaction は agent wallet、Subly sponsor、temporary settlement
  account の複数署名を必要とするが、公式 SVM exact の sponsor policy は基本的に
  client と sponsor 以外の required signature を嫌う。
- Kamino withdraw program は、外部 facilitator の static path / allowed smart-wallet
  path に載らない可能性が高い。

したがって「Nansen の公式 x402 に Subly の複合 transaction をそのまま渡す」は
デモ向きではない。互換モードでは payment source を一度 standard x402 が使える
USDC balance に変換する必要がある。

## 推奨アーキテクチャ

### Phase 1: User-Specific Standard x402 Payer

最短で Nansen デモを成立させる実装。

```text
agent wallet Kamino position
-> Subly yield budget ledger
-> yield-only withdraw to agent/payer USDC ATA
-> standard x402 Solana exact payment
-> Nansen API response
```

利点:

- Seller 側変更なし。
- Nansen の既存 x402 endpoint にそのまま接続できる。
- Subly が custody / payer pool を持つ前にデモできる。
- 既存の deposit / withdraw / budget / signer validation を再利用しやすい。

欠点:

- Buyer/payer address と Nansen payment が public chain 上で直接見える。
- 「Sublyから支払われた」と Seller は認識しない。
- yield を USDC buffer に realize する transaction と x402 payment transaction が
  分かれるため、現行 `subly-yield-exact` より atomic ではない。

この phase では、訴求を「Seller が Subly 対応している」ではなく、
「Subly の yield-backed spend control で、既存 x402 API を使える」に寄せる。

### Phase 2: External x402 Payment Router

`PaidFetchService` を拡張するより、別 route として追加する方が安全。

```text
paidFetch(url)
  1. request without API key
  2. if 402 has subly-yield-exact -> existing flow
  3. if 402 has exact + solana USDC -> standard x402 payer flow
  4. otherwise reject no_supported_requirement
```

必要な追加コンポーネント:

- `OfficialX402PaymentRequired` parser
- `StandardSvmExactPayer`
- `ExternalPaymentLedger`
- `YieldBufferService`
- `ExternalPaymentPolicy`
- Nansen demo CLI / MCP route

既存 `PaidFetchService` は Subly seller payment の二重払い防止に寄っている。
外部 x402 は settlement owner が Nansen/Payai になるため、payment state と
reconciliation は別モデルにした方がよい。

### Phase 3: Payer Pool / Private Payer Mode

デモ後の本命。

```text
user-specific yield position
-> Subly internal ledger reserves user spendable yield
-> Subly payer pool pays Seller by standard x402
-> user sees receipt/export
```

利点:

- Seller 側変更なし。
- Buyer wallet と Seller usage graph を public chain 上で直接つながなくて済む。
- Agent 向け spending account として見せやすい。

欠点:

- custody / money transmission / AML / accounting 論点が重い。
- payer liquidity management と reconciliation が必須。
- 「匿名支払い」ではなく `commercial privacy with auditability` として設計・訴求する必要がある。

## Nansen デモ実装案

### Demo target

最初は `0.01 USDC` の Basic endpoint を選ぶ。

候補:

- `/api/v1/token-screener`
- `/api/v1/profiler/address/current-balance`
- `/api/v1/tgm/dex-trades`

Smart Money endpoint は trader story と相性がよいが `0.05 USDC` なので、
demo wallet の yield budget に余裕がある場合に使う。

### Demo story

```text
1. Buyer deposits 1,000 USDC into Subly/Kamino.
2. Subly shows principal basis = 1,000 USDC.
3. Yield accrues, e.g. spendable yield >= 0.05 USDC.
4. Buyer/agent calls Nansen API without API key.
5. Nansen returns official x402 402.
6. Subly selects Solana USDC exact requirement.
7. Subly verifies price <= cap and spendable yield.
8. Subly realizes only yield into payer USDC buffer.
9. Standard x402 Solana exact payment is sent to Nansen.
10. Nansen returns trader data.
11. Subly receipt shows principal basis is still protected.
```

このストーリーなら、「トレードが下手な人が API 代を稼ぐために元本をリスクに晒す」
問題に対して、Subly は「元本ではなく yield だけを API 支払いに使う spending layer」
として説明できる。

### Economic sanity

`1,000 USDC` deposit の yield は高頻度支払いには向かない。

概算:

```text
10% APY -> 100 USDC/year -> 約0.274 USDC/day
5% APY  ->  50 USDC/year -> 約0.137 USDC/day
```

Nansen の `0.01 USDC` call なら demo story として成立しやすい。
`0.05 USDC` call は 1,000 USDC deposit でも 1 日あたり数回程度の訴求になる。

## 実装タスク

### Required for final demo

1. Official x402 challenge parser
   - `PAYMENT-REQUIRED` header and/or body から official `accepts` を読む。
   - `scheme=exact`, `network=solana:*`, `asset=USDC` を選ぶ。

2. Standard SVM exact payer
   - 公式 `@x402/*` package を使うか、spec に沿って Solana transfer transaction を組む。
   - `extra.feePayer` を fee payer にする。
   - `payTo` の USDC ATA へ TransferChecked。
   - `extra.memo` があれば memo を一致させる。なければ nonce memo。
   - `payload.transaction` を base64 serialized partially-signed tx として返す。

3. Yield-only buffer funding
   - 既存 normal withdraw をそのまま使うと元本 withdraw と混同しやすいので、
     `prepareYieldBufferTopUp` のような明示 API に分ける。
   - budget check は `sellerAmount + fees + buffer <= spendable_yield`。
   - principal basis を下げない。

4. External payment ledger
   - `externalPaymentId`
   - `provider = nansen`
   - `url`, `method`, `bodyHash`
   - selected `accepted`
   - `amountRawUsdc`, `asset`, `payTo`
   - `payerWallet`
   - `transaction`
   - `status = prepared | submitted | settled | failed | unknown`
   - `paymentResponse`

5. Retry / double-payment guard
   - Same URL/body/hash の in-flight を coalesce。
   - Response lost 時は stored transaction signature を chain lookup して settled 判定。
   - `payment-identifier` extension が advertised される場合だけ利用。

6. CLI / MCP UX
   - `subly pay nansen ...` または既存 `pay fetch` に official x402 fallback を追加。
   - `maxAmountRawUsdc` cap は必須。

### Not required for final demo

- Base x402 support.
- Stripe MPP support.
- Payer pool privacy.
- Fully automated bridge/swap.
- Seller-facing Subly attestation for Nansen.

## Product Positioning

変更後の主張:

```text
Subly lets agents pay existing x402 APIs from yield, without draining principal.
```

避けるべき主張:

- Nansen が Subly に対応した。
- 支払いが完全に匿名。
- 元本が on-chain で絶対に動かない。
- yield で無制限に有料 API を使える。

正確な説明:

- Seller は通常の x402 USDC payment を受け取る。
- Subly は Buyer 側で spendable yield を計算し、元本を下回らないように支払いを制限する。
- 標準 x402 mode では「yield を realize して払う」に近い。
- Subly の価値は決済魔法ではなく、agent 向けの yield-backed spend control。

## 判断

Nansen で最終日デモをする方針は実現可能。

ただし、実装方針は現行 Seller SDK の延長ではなく、Buyer-side standard x402 payer を
追加すること。`subly-yield-exact` は Seller が Subly receipt / attestation を
明示的に受け入れる premium path として残し、GTM の主導線は既存 x402 Seller を
利用できる Buyer-side payer mode に移すのが妥当。

