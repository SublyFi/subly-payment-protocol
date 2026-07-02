# Subly Demo Notes

現在のデモ主導線は、既存 standard x402 Seller に対して Buyer 側から
yield 支払いする flow である。

推奨デモ:

```bash
npm run demo:pay-x402 -- <standard-x402-url> [maxAmountRawUsdc]
```

または公開パッケージ:

```bash
npx -y @subly_fi/pay fetch <standard-x402-url> [maxAmountRawUsdc]
```

この flow では Seller は Subly を知らない。Seller から見ると通常の x402
USDC payment であり、Subly は Buyer 側で spendable yield を確認し、必要分を
realize してから標準 x402 payment を行う。realize は relayer 側でも
`purpose: "yield_realize"` として spendable yield 超過を拒否する
(元本保護はクライアント任せではない)。

MCP サーバ (`demo/run-mcp.sh` / `npx -y @subly_fi/pay mcp`) は支払いに加えて
`deposit_to_subly_vault` / `withdraw_from_subly_vault` /
`get_subly_yield_budget` ツールを公開しており、エージェントは MCP だけで
入金 → 利回り確認 → 支払い → 出金のライフサイクルを完結できる
(ガスはすべてスポンサー負担、エージェント wallet に SOL は不要)。

`demo/seller.ts`、`demo/buyer.ts`、`demo/pay.ts` は旧
`subly-yield-exact` / hosted Seller 検証用の legacy demo であり、現在の
最終デモやGTMの正ではない。実行する場合の npm scripts は
`demo:legacy:seller`、`demo:legacy:buyer`、`demo:legacy:pay` としている。
