# Subly Operations Runbook

最終更新: 2026-06-11 JST

技術設計は `docs/technical-design.md` を正とする。本書はmainnet運用の構成と起動前チェックを記す。

## 環境変数

### 必須 (mainnet)

```text
NODE_ENV=production            production以外を明示しない限りfail-closedガードが有効
SOLANA_RPC_URL                 mainnet RPCエンドポイント (有料/専用推奨。公開RPCはgetTokenLargestAccounts等が制限される)
SUBLY_SPONSOR_KEYPAIR          sponsor秘密鍵 (base58 64byte) または
SUBLY_SPONSOR_KEYPAIR_PATH     solana-keygen形式JSONファイルパス
DATABASE_URL                   PostgreSQL接続文字列
SUBLY_SELLER_API_TOKEN         seller向け /v1/x402/verify, /v1/x402/settle
SUBLY_CLIENT_API_TOKEN         client向け prepare/submit系 + deposit/withdrawal状態取得
SUBLY_ADMIN_API_TOKEN          admin向け wallet/policy/sync/recover/monitoring系
```

3つのAPIトークンは別々の値であること (同一値を設定すると起動時にエラー)。
`NODE_ENV` が `development` / `test` 以外 (未設定含む) の場合は常にproduction扱いとなり、
DATABASE_URL・fee oracle・structured signer・liquidity policy等のガードが強制される。

### 任意

```text
SUBLY_EXTRA_LOOKUP_TABLES          Subly管理のsettlement LUTアドレス (カンマ区切り)
SUBLY_CU_LIMIT                     Compute unit limit (default 1000000)
SUBLY_CU_PRICE_MICROLAMPORTS       Priority fee (default 1)
SUBLY_ESTIMATED_FEE_LAMPORTS       見積もり手数料lamports (default 120000)
SUBLY_MAX_ESTIMATED_FEE_LAMPORTS   手数料キャップ (default 2000000)
SUBLY_MAX_FEE_DEBT_RAW_USDC_PER_PAYMENT  決済毎fee debtキャップ raw USDC (default 50000)
SUBLY_FEE_MAX_AGE_MS               オラクル鮮度上限 (default 60000)
SUBLY_HERMES_BASE_URL              Pyth Hermes URL (default https://hermes.pyth.network)
SUBLY_KAMINO_API_BASE              Kamino公開APIベースURL (default https://api.kamino.finance)
SUBLY_MIN_SPONSOR_BALANCE_LAMPORTS sponsor残高下限 (default 100000000 = 0.1 SOL。下回ると/monitoringがbelowMinimum+error log)
SUBLY_SOL_USDC_PRICE_SCALED 等     旧static fee oracle設定 (設定時はPythの代わりに使用)
```

Fee oracleはデフォルトでPyth Hermes SOL/USDフィード
(`ef0d8b6f...c280b56d`) を使用し、鮮度・キャップ違反時は `stale_oracle` /
`fee_cap_exceeded` で決済準備を拒否する。

## 起動前チェックリスト

1. **Sponsorウォレット**: SOL残高 (決済毎に一時アカウントrent ~0.00204 SOLを立替え、同一トランザクションで回収)。
2. **Settlement LUT**: 下記を実行しLUTを作成、`SUBLY_EXTRA_LOOKUP_TABLES` に設定。
   ```bash
   SOLANA_RPC_URL=... SUBLY_SPONSOR_KEYPAIR=... \
     npx tsx scripts/create-settlement-lut.ts <agentWallet...>
   ```
   Vault reserves・farm口座・memo/farms program等を収録する。これがないと
   farm staked sharesのunstakeを含むsettlementが1232バイト制限を超過し得る
   (2026-06-10 mainnet検証: LUTなし時1326バイト)。curator側でKamino vault LUTを
   sync済みなら不要な場合もある。
3. **流動性ポリシー**: `POST /v1/admin/liquidity-policies` で `sellerClass:"default"`
   を必ず登録 (productionでは未登録だと`liquidity_policy_missing`で全決済拒否)。
4. **Agentウォレット登録**: `POST /v1/wallets/agent` で
   `signerValidationMode: "structured_intent_transaction"` を設定
   (productionではこれ以外は決済不可)。Agent signer は transaction decode 後に
   `preparedMessageHash`、seller/payee/ATA、temporary account、Kamino withdraw、
   seller transfer、dust sweep、close、memoに加え、ComputeBudget limit/priceと
   temporary-account rentがpolicy上限内であることを確認してから署名する。
5. **初回同期**: `POST /v1/wallets/{wallet}/sync` body `{"source":"chain"}`。
   信頼できるcost basisが取れない場合はconservative reset
   (basis = 現在価値、以後の新規yieldのみ決済可能) となる。

## 読み取り専用mainnet検証

```bash
SOLANA_RPC_URL=... npm run validate:mainnet
```

実Vaultに対して: コンテキスト取得 → 決済quote → canonical settlement
transaction構築 → probe/finalシミュレーション (資金移動なし) → Kamino P&L API
→ fee oracleを検証する。`SUBLY_VALIDATE_WALLET` でshare保有ウォレットを指定可能。

2026-06-10 検証結果: share保有ウォレット (farm staked) に対し、一時アカウント
作成 → farm unstake → kVault withdrawFromAvailable → 非ATA口座着金のprobe
シミュレーションがmainnetで成功。finalトランザクションはLUT未設定時のみ
サイズ超過 (上記チェックリスト2で解消)。

## 監視

- `GET /v1/admin/monitoring` (adminトークン): settlementレイテンシ (p50/p95/max)、
  settlement成功/失敗カウンタ、`simulation_failed` / `budget_illiquid` /
  `stale_oracle` / `fee_cap_exceeded` 等のエラーカウンタ、sponsor SOL残高と
  下限割れフラグを返す。外形監視からポーリングしてアラートに接続する。
- `GET /v1/wallets/{wallet}/sync-events` (adminトークン): wallet同期・deposit/
  withdraw確定・settlement・外部share移動の監査イベント (design `sync_events`)。

## 失敗時の挙動 (要点)

- `/settle` 前のシミュレーション失敗・blockhash失効 → `failed_not_submitted`
  (fee debtなし、予約解放)。
- landed失敗 → `failed` + 実fee debt計上。
- 送信後不明 → `submitted` のまま。`POST /v1/admin/settlements/recover` が保存済み
  バイト列の再送/照合のみ行う (新規トランザクションは絶対に作らない)。
- 外部のshare移動を検知 → `needs_baseline_reset`。`{"source":"chain","forceConservativeReset":true}`
  でsyncして復旧。
- 同一 `sellerRequestId` の支払いが `expired` / `failed` / `failed_not_submitted`
  で終端した場合のみ、同じrequest binding hashで新しい `paymentId` のre-prepareが
  可能 (settled・進行中は冪等に既存intentを返す)。intentは初回ブロードキャスト直前に
  必ず `submitted` へ永続化され、ブロードキャストされた可能性のあるsettlementは
  保存済みsignatureの照合とblockhash失効によってのみ終端する (再シミュレーションで
  `failed_not_submitted` にしない)。したがって `failed_not_submitted` は「一度も
  送信されていない」か「もはやland不可能」であることを意味し、re-prepareによる
  二重支払いは起きない。
- seller側のretryに対する `/verify` は冪等: payloadが保存済みintentと一致する限り
  `prepared` (未失効) / `submission_prepared` / `submitted` / `settled` で
  `isValid: true` を返すので、settleタイムアウト後のretryでも `/settle` に到達して
  保存済みレシートを回収できる。
- `payTo` がagent wallet自身の決済は `self_payment_not_supported` で拒否
  (通常withdrawを使う)。

## x402 トランスポート (seller / agent SDK)

- `src/x402/headers.ts`: `PAYMENT-REQUIRED` / `PAYMENT-SIGNATURE` /
  `PAYMENT-RESPONSE` ヘッダのcodecと `subly-yield-exact` スキーマ。
- `src/x402/seller.ts` `SublySellerGate`: 402チャレンジ生成と、retry時の
  binding再計算 → facilitator `/verify` → `/settle` → 成功時のみアクセス許可
  (settle-before-deliver)。`success:true` だけでは許可せず、`PAYMENT-RESPONSE`
  の network/asset/amount/paymentId/requestBindingHash/sellerRequestId/payTo/
  sellerUsdcAta/sellerTransferRawUsdc がpriced requestと一致することを確認する。
- `src/x402/client.ts` `SublyX402Client`: 402受信 → `/v1/payments/prepare` →
  structured-intent署名 (`AgentWalletSigner`) → `PAYMENT-SIGNATURE` 付きretry
  (`fetchWithPayment`)。lookup table解決はクライアント自身のRPC
  (`fetchLookupTablesForTransaction`) を渡す。
