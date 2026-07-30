# Subly Docs

> **Looking for the project overview, quick start, or self-hosting guide?**
> See the [root README](../README.md). This directory is the design-docs index;
> most documents are currently written in Japanese (English translations are
> welcome — see [CONTRIBUTING](../CONTRIBUTING.md)).

最終更新: 2026-07-30 JST

## 現在の正

Subly の現在の主導線は、Seller に Subly SDK や独自 facilitator を導入してもらうことではない。

```text
Existing standard x402 Seller
-> Buyer/agent receives 402
-> Subly checks spendable Kamino yield
-> Subly realizes yield into the buyer payment wallet
-> Buyer pays the Seller with standard x402
```

Seller から見ると通常の x402 支払い。Buyer から見ると「元本を減らさず、spendable yield で有料 API を使う」体験になる。

参照する設計ドキュメント:

- `docs/nansen-x402-yield-payment-architecture.md`
- `docs/buyer-side-yield-payment-strategy.md`
- `docs/business-model.md` — 収益アーキテクチャ(TVL × perf fee 3 層)と配布戦略
- `packages/pay/README.md`

## 用語

- `Subly relayer`: Buyer 側の vault/budget/yield-realize API。Seller の x402 facilitator ではない。
- `Seller facilitator`: Nansen/PayAI/Coinbase CDP など、既存 x402 Seller 側が使う標準 facilitator。
- `subly-yield-exact`: 過去の Seller 導入型 / Subly 独自スキーム。現在のデモとGTMの主導線ではない。

## Legacy

以下は履歴・設計検証用として残す。現在のデモや営業導線の正として使わない。

- `docs/technical-design.md`: 旧 `subly-yield-exact` の技術仕様
- `docs/operations.md`: 旧 `subly-yield-exact` 運用メモ
- `demo/README.md`: 現行デモ導線と legacy demo の境界

なお `deploy/README.md` は現行 relayer のデプロイ手順(legacy ではない)。
旧 Seller 向け `/v1/x402/*` エンドポイントはデフォルト無効になっており、
`SUBLY_ENABLE_LEGACY_X402=1` を設定した場合のみ提供される。
