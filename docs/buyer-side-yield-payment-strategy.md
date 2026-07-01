# Subly Buyer-Side Yield Payment Strategy

最終更新: 2026-06-19 JST

このドキュメントは、既存の `docs/technical-design.md` とは別の戦略メモである。
会話で深掘りした「Seller 側に Subly SDK を入れてもらわず、Buyer/Agent 側から
既存 x402 / AWS WAF / MPP Seller へ yield で支払う」方向性を整理する。

## 背景

現状の Subly MVP は `subly-yield-exact` という独自 scheme を使う。
これは Kamino Vault redeem と seller transfer を同じ settlement transaction に
まとめられるため、Subly らしい yield-budgeted payment を強く表現できる。

一方で、この方式は Seller が Subly scheme を受け入れ、Subly facilitator を
使う必要がある。x402 SDK、MPP、AWS WAF AI traffic monetization のような
Seller 側の標準化が進むほど、「Seller に Subly SDK を営業する」導線は重くなる。

したがって、Subly の主導線を Seller SDK ではなく Buyer/Agent 側の
payment router / spending account に寄せる戦略を検討する。

## 戦略仮説

Subly は「Seller 向け決済 SDK」ではなく、まず
`yield-funded agent payment wallet / spending account` として使われるべきである。

Buyer/Agent は Subly に USDC を deposit し、Kamino Vault などで運用する。
Subly は元本、yield、spendable budget を管理し、agent が有料 API、MCP、
AI traffic monetization endpoint にアクセスした時、yield 由来の支払い余力で
標準 x402 / AWS WAF / MPP 支払いを行う。

Seller から見ると通常の x402 / MPP 支払いであり、Subly 対応は不要である。
Buyer から見ると、元本ではなく yield budget で agent が支払っている。

## Product Modes

### 1. Subly Yield-Attested Seller Mode

現在の `subly-yield-exact` に近い。

- Seller は Subly scheme を受け入れる。
- Subly facilitator が yield budget を検証する。
- Kamino redeem と seller transfer を JIT settlement できる。
- Seller は Subly receipt / attestation を確認できる。

強み:

- Subly の独自性が一番強い。
- 「この支払いは yield budget 内だった」と明確に表現できる。
- 元本保護、request binding、seller settlement を一体で扱える。

弱み:

- Seller 導入が必要。
- x402 / AWS WAF / MPP の既存導入先にはそのまま乗れない。
- GTM が重い。

位置付け:

- 最初の配布チャネルではなく、高信頼 / 高単価 / Subly receipt が必要な
  Seller 向けの premium mode として残す。

### 2. Standard x402 / AWS WAF Payer Mode

Seller が既に標準 x402、特に AWS WAF AI traffic monetization を使っている場合、
Subly は Buyer 側の payer として動く。

標準 x402 Solana `exact` は Kamino redeem + seller transfer の複合 transaction を
表現しない。そのため、互換モードでは次の流れが必要になる。

```text
Kamino position accrues yield
-> Subly computes spendable yield
-> Subly realizes part of yield into a USDC payment buffer
-> Subly signs / submits a standard x402 payment
-> Seller receives ordinary USDC settlement
```

強み:

- Seller 側 Subly SDK が不要。
- AWS WAF / x402 の普及に乗れる。
- Seller から見れば通常の支払いなので導入摩擦が低い。

弱み:

- Seller は「Subly yield 支払い」であることを知らない。
- 外から見ると通常の USDC 支払いなので、Subly の差別化は Buyer UX 側に閉じる。
- yield buffer、二重払い防止、budget accounting、reconciliation が必要。

位置付け:

- 最優先の配布戦略。
- Seller 営業を避けるための wedge。

### 3. MPP Payer Adapter

Stripe MPP / Machine Payments Protocol は x402 と似た buyer-driven payment 体験を
提供するが、支払い credential、network、settlement rail は x402 と同一ではない。

Subly が対応する場合、まず Solana USDC 互換の範囲に絞るべきである。
Base、Tempo、card / SPT、fiat settlement は別 rail として扱い、早期 MVP では
無理に一体化しない。

位置付け:

- x402 / AWS WAF payer mode の次。
- 「agent payment router」として対応先を広げるための adapter。

### 4. Private Payer Mode

Buyer がどの Seller / API / MCP / data source に支払ったかは競争情報である。
Subly はこの情報を public chain に晒さない commercial privacy layer になれる。

目標は「誰にも追跡されない匿名支払い」ではない。
目標は「public chain observer や Seller に Buyer の利用先グラフを見せないが、
Buyer 本人と必要な監査者には説明可能な支払い」である。

推奨する初期設計:

```text
Yield Vault: user-specific position
Payment execution: Subly payer pool / rotating payer accounts
Internal accounting: user-specific ledger
Auditability: encrypted history, receipt export, view/audit access
Compliance: seller allowlist, KYB where needed, sanctions screening
```

Public chain 上では次のように見える。

```text
Subly Payer #7 -> Seller
```

Buyer wallet から Seller への直接 link は出ない。

## Wallet なのか

実質的には wallet 的な機能を持つ。ただし、Subly が Phantom や Coinbase Wallet の
ような汎用 wallet を作るという意味ではない。

Subly が作るべきものは、Agent 用の `spending account` である。

- deposit / withdraw
- yield position sync
- spendable yield calculation
- per-payment caps
- seller allowlist / denylist
- x402 / AWS WAF / MPP payment routing
- idempotency and receipt history
- optional private payer pool

ウォレット基盤そのものは、Privy、CDP Wallet、Turnkey、KMS、local signer、
MoonPay Agents など既存の programmable wallet / embedded wallet を使える。

MoonPay Agents との違い:

- MoonPay Agents は agent 用の汎用 crypto wallet / financial stack。
- Subly は yield-funded payment budget と API/MCP 支払いに特化した spending layer。

したがって、Subly は wallet provider と正面衝突するより、wallet provider の上で
「yield-backed spend control」を提供する方が現実的である。

## これは単に yield を引き出して払っているだけか

標準 x402 / AWS WAF 互換モードでは、経済的にはかなり近い。

```text
yield accrues
-> yield is realized as USDC
-> USDC pays Seller
```

この点はごまかすべきではない。
特に互換モードは `auto-harvested yield payment account` と見るのが正確である。

ただし、手動で yield を引き出して払うこととの違いはある。

- Kamino Vault の share exchange rate から元本と yield を安全に分ける。
- Agent が 402 challenge に反応して自律的に支払える。
- 元本を消費しない spend control を enforce できる。
- seller allowlist、per-payment cap、daily cap、idempotency を持てる。
- x402 / AWS WAF / MPP の複数 rail を抽象化できる。
- Private Payer Mode では Buyer と Seller の public-chain link を隠せる。

Subly の価値は「新しい決済魔法」ではなく、`yield-backed spend control` である。

## Payer Account Architecture

Private Payer Mode では、payer account をどう持つかが重要になる。

### Option A: User-Specific Payer Account

```text
Subly Alice Payer -> Seller A
Subly Alice Payer -> Seller B
```

利点:

- 会計が簡単。
- user ごとの資金分離を説明しやすい。

欠点:

- 同じ payer address の支払い履歴が紐づく。
- Alice の本名は隠れても、同じ agent がどの Seller 群を使っているか推測される。

### Option B: Fully Shared Payer Account

```text
Subly Shared Payer -> Seller A
Subly Shared Payer -> Seller B
```

利点:

- public chain privacy は強い。

欠点:

- 資金混在、custody、money transmission、AML、会計の論点が重い。
- 匿名 mixer のように見えるリスクがある。

### Option C: Payer Pool / Rotating Payers

```text
Subly Payer #3 -> Seller A
Subly Payer #7 -> Seller B
Subly Payer #2 -> Seller C
```

利点:

- Buyer と Seller の直接 link を隠しやすい。
- fully shared account より運用制御しやすい。
- payer risk、seller category、region、volume に応じて分けられる。

欠点:

- 内部 ledger と reconciliation が必須。
- compliance policy が必要。
- payer liquidity management が必要。

推奨:

MVP では、元本 / yield position は user-specific に保ち、Seller への外向き支払いだけ
Subly Payer Pool から出す。これが privacy、会計、実装のバランスが良い。

## 重要なリスク

### Economics

Yield だけで払える金額は小さい。
例えば年利 10% でも、100 USDC の deposit は 1 日あたり約 0.027 USDC 程度しか
yield を生まない。

したがって、初期ユースケースは次に絞るべきである。

- 低単価 API
- 低頻度 MCP tool
- crawler / agent がたまに呼ぶ paid endpoint
- monthly subscription ではなく small metered payments

高頻度・高単価 API を yield だけで払う訴求は弱い。

### Standard Mode Differentiation

標準 x402 で払うと、Seller から見れば普通の USDC 支払いになる。
Subly の独自性は Buyer 側に閉じる。

そのため、訴求は protocol ではなく次に寄せる。

- principal-preserving agent budget
- no manual top-up
- yield-funded API access
- private payment graph
- policy-controlled autonomous spend

### Custody And Compliance

Payer Pool を使うと、Subly が一時的に支払い liquidity を持ち、Buyer のために
Seller へ払うように見える。

このため、次を設計に入れる必要がある。

- user ledger segregation
- audit export
- withdrawal rights
- seller allowlist / blocklist
- sanctions screening
- abnormal usage detection
- commercial privacy messaging

「匿名支払い」「追跡不能」を訴求してはいけない。
訴求は `commercial privacy with auditability` とする。

### Competitive Risk

Buyer-side wallet / payment router になると競合は変わる。

- AWS Bedrock AgentCore Payments
- Coinbase CDP Wallet / x402 facilitator
- Stripe MPP
- MoonPay Agents
- Privy / Turnkey / embedded wallet providers

Subly は wallet 機能全般では勝たない。
`yield-funded spend control` と `private API payment graph` で差別化する。

### Implementation Risk

互換モードには、現行 `subly-yield-exact` とは別の実装面が必要になる。

- realized-yield USDC buffer
- standard x402 Solana exact payment builder
- x402 challenge parser for AWS WAF/CDP style responses
- payer pool liquidity management
- ledger reservation and reconciliation
- private receipt storage
- policy engine for seller allowlist and caps
- retry / idempotency across external facilitators

## 推奨 Roadmap

### Phase 1: Buyer-Side x402 Compatibility

- 標準 x402 Solana `exact` の payer を実装する。
- AWS WAF AI traffic monetization の 402 challenge を parse できるようにする。
- Subly yield budget から realized-yield buffer を作る。
- Seller 側 Subly SDK なしで 1 件の mainnet payment を通す。

Success metric:

- Buyer が `subly pay <aws-waf-x402-url>` で支払える。
- Seller は Subly を知らない。
- Buyer ledger では元本が減っていないことを確認できる。

### Phase 2: Productize Agent Spending Account

- `budget status`
- `spend history`
- `per-payment cap`
- `daily / weekly cap`
- `seller allowlist`
- `force new payment` / duplicate payment guard
- MCP tool support

Success metric:

- Agent developer が wallet ではなく spending account として理解できる。

### Phase 3: Private Payer Pool

- Subly Payer Pool から standard x402 payment を出す。
- Buyer-Seller mapping を encrypted ledger に保存する。
- Buyer に receipt / export / view access を提供する。
- Seller category / risk policy ごとに payer を分ける。

Success metric:

- Public chain observer が Buyer wallet と Seller payment を直接リンクできない。
- Buyer は自分の支払い履歴を確認できる。
- Operator / auditor 向けの説明可能性がある。

### Phase 4: MPP Adapter

- Solana USDC compatible MPP flow から対応する。
- Base / Tempo / card / SPT / fiat settlement は別途検討する。

Success metric:

- x402 以外の machine payment Seller にも同じ yield-funded budget で払える。

### Phase 5: Advanced Privacy

- Arcium / MPC / ZK を使った private budget check や private allowlist check を検討する。
- ただし、完全な shielded payment pool は規制・UX・実装コストが高いため、
  MVP には含めない。

## 現時点の推奨判断

Subly は Seller SDK を主戦略にしない。
Seller SDK / `subly-yield-exact` は差別化の強い premium path として残す。

主戦略は次に置く。

```text
Buyer-side yield-funded agent spending account
-> standard x402 / AWS WAF payer compatibility
-> optional private payer pool
-> later MPP adapter
```

この戦略の本質は、`agent に自由なお金を持たせる` ことではない。
`agent に元本を消費しない支払い余力だけを持たせる` ことである。

