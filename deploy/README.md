# Legacy Deploy Bundle

この `deploy/` ディレクトリは、旧 `subly-yield-exact` / hosted Seller βの
検証用 bundle として残っている。現在の Subly の主導線では使わない。

現在の方針:

- Subly は既存 standard x402 Seller に SDK 導入を求めない。
- Seller は Nansen など既存の x402 payment flow をそのまま使う。
- Subly 側は Buyer の vault/budget/yield-realize を担う relayer API と
  `@subly_fi/pay` クライアントを提供する。

現行の参照先:

- `docs/README.md`
- `docs/nansen-x402-yield-payment-architecture.md`
- `docs/buyer-side-yield-payment-strategy.md`
- `packages/pay/README.md`

この bundle を再利用する場合は、現在方針とは別の legacy 実験として扱う。
