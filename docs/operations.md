# Subly Operations Runbook

最終更新: 2026-06-11 JST

技術設計は `docs/technical-design.md` を正とする。本書はmainnet運用の構成と起動前チェックを記す。
**デモの実行手順 (環境変数の設定方法含む) は `demo/README.md` を参照** — 本書はその際の環境変数リファレンスとして使う。

## 環境変数

### 必須 (mainnet)

```text
NODE_ENV=production            production以外を明示しない限りfail-closedガードが有効
SOLANA_RPC_URL                 mainnet RPCエンドポイント (有料/専用推奨。公開RPCはgetTokenLargestAccounts等が制限される)
SUBLY_SPONSOR_KEYPAIR          sponsor秘密鍵 (base58 64byte) または
SUBLY_SPONSOR_KEYPAIR_PATH     solana-keygen形式JSONファイルパス
DATABASE_URL                   PostgreSQL接続文字列
SUBLY_SELLER_API_TOKEN         seller向け /v1/x402/verify, /v1/x402/settle
SUBLY_ADMIN_API_TOKEN          admin向け wallet/policy/sync/recover/monitoring系
```

3つのAPIトークンは別々の値であること (同一値を設定すると起動時にエラー)。
`NODE_ENV` が `development` / `test` 以外 (未設定含む) の場合は常にproduction扱いとなり、
DATABASE_URL・fee oracle・structured signer・liquidity policy等のガードが強制される。

### 任意

```text
PORT / HOST                        listenポート/アドレス (default 3000 / 0.0.0.0)
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

## インフラ構成

必要なものは以下の4つ。AWSである必要はなく、アルファ段階は
Railway / Fly.io / Render + マネージドPostgres (Neon等) で十分。

| 構成要素 | 要件 |
|---|---|
| アプリサーバー | Node >= 20 の単一プロセス (Fastify)。`npm run build` → `npm start`。`GET /healthz` をヘルスチェックに使用 |
| PostgreSQL | `DATABASE_URL` で接続。スキーマは起動時に `create table if not exists` で自動作成 (マイグレーション不要)。TLS接続 (`?sslmode=require`) を推奨 |
| RPC | 有料/専用エンドポイント (Helius / Triton / QuickNode等)。公開RPCは `getTokenLargestAccounts` 等がレート制限される |
| シークレットストア | sponsor秘密鍵 + APIトークン3種。ホスティングのsecret機能 or Secrets Manager。平文の環境変数ファイルをリポジトリ/イメージに含めない |

注意:

- **インスタンスは1台のみ**で運用する。settlementの二重送信はDBの
  partial unique index (`sellerRequestId`) で防御されるが、水平スケールを
  前提とした検証はしていない。オートスケール/複数レプリカを無効にすること。
- **sponsorはホットウォレット**。サーバーから署名に使うため、残高は運転資金
  (rent立替え ~0.00204 SOL/決済 + tx fee) のみに抑え、大きな資金を置かない。
- グレースフルシャットダウン前提のローリング再起動でよい。`submitted` のまま
  プロセスが落ちても `POST /v1/admin/settlements/recover` で照合復旧できる
  (「失敗時の挙動」参照)。

## ゼロからの構築手順

1. **PostgreSQL作成**: マネージドDBを作成し `DATABASE_URL` を控える。
2. **RPC契約**: mainnetエンドポイントを取得し `SOLANA_RPC_URL` を控える。
3. **Sponsorキーペア生成・入金**:
   ```bash
   solana-keygen new --no-bip39-passphrase -o sponsor.json
   solana address -k sponsor.json   # ここへSOLを入金 (目安 0.5 SOL〜)
   ```
   鍵はシークレットストアへ登録し、ローカルの `sponsor.json` は削除する。
4. **APIトークン生成** (3つとも別値):
   ```bash
   openssl rand -hex 32   # SUBLY_SELLER_API_TOKEN
   openssl rand -hex 32   # SUBLY_ADMIN_API_TOKEN
   ```
5. **Settlement LUT作成** (ローカルから実行可。sponsor入金後):
   ```bash
   SOLANA_RPC_URL=... SUBLY_SPONSOR_KEYPAIR=... \
     npx tsx scripts/create-settlement-lut.ts <agentWallet...>
   ```
   出力されたLUTアドレスを `SUBLY_EXTRA_LOOKUP_TABLES` に控える。
6. **読み取り専用mainnet検証** (任意だが推奨): `npm run validate:mainnet`
   (後述) でsettlementパスのシミュレーションが通ることを確認する。
7. **デプロイ**: 「環境変数 > 必須」+ `SUBLY_EXTRA_LOOKUP_TABLES` を設定し、
   build command `npm ci && npm run build`、start command `npm start`、
   ヘルスチェック `GET /healthz` でデプロイする。
8. **起動後の初期化** (adminトークンで本番URLに対して実行):
   ```bash
   # 流動性ポリシー (未登録だと全決済が liquidity_policy_missing で拒否)
   curl -X POST $BASE/v1/admin/liquidity-policies \
     -H "Authorization: Bearer $ADMIN" -H "Content-Type: application/json" \
     -d '{"sellerClass":"default",
          "expectedPaymentSizeRawUsdc":"<raw USDC>",
          "minInstantLiquidityRawUsdc":"<raw USDC>",
          "targetBudgetIlliquidRate":0.05}'

   # Agentウォレット登録
   curl -X POST $BASE/v1/wallets/agent \
     -H "Authorization: Bearer $ADMIN" -H "Content-Type: application/json" \
     -d '{"wallet":"<agentWallet>",
          "signingPolicyId":"<policyId>",
          "signerValidationMode":"structured_intent_transaction",
          "activateForPayments":true}'

   # 初回チェーン同期
   curl -X POST $BASE/v1/wallets/<agentWallet>/sync \
     -H "Authorization: Bearer $ADMIN" -H "Content-Type: application/json" \
     -d '{"source":"chain"}'
   ```
   各エンドポイントのbodyスキーマは `src/api/schemas.ts` を正とする。
9. **監視接続**: 外形監視から `GET /healthz` (死活) と
   `GET /v1/admin/monitoring` (sponsor残高・エラーカウンタ) をポーリングし
   アラートに接続する (「監視」参照)。

要件の詳細・背景は次節「起動前チェックリスト」を参照。

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

## ローカル動作確認

用途別に3段階。いずれも `NODE_ENV=development` が前提
(未設定だとproduction扱いになり起動しない)。APIトークン3つは
ローカルでも必須かつ別値 (ダミー値でよい)。

### 1. 完全オフライン起動 (detachedモード)

DB・RPC・sponsor鍵すべて不要。

```bash
NODE_ENV=development \
SUBLY_SELLER_API_TOKEN=dev-seller \
SUBLY_ADMIN_API_TOKEN=dev-admin \
npm run dev
```

- `DATABASE_URL` 未設定 → インメモリ台帳 (再起動で消える)。
- RPC/sponsor未設定 → detachedモード (`mode: "detached"` がログに出る)。
  settlement / deposit / withdraw は不可。
- 確認できるもの: `/healthz`、`/v1/admin/monitoring`、ポリシー登録、
  ウォレット登録、スキーマバリデーション、認証 (401/403)。

### 2. 読み取り専用mainnet検証 (資金移動なし)

チェーン連携部分の確認はこれが本命。次節「読み取り専用mainnet検証」参照。

### 3. ローカルでフル起動 (mainnetモード)

```bash
NODE_ENV=development SOLANA_RPC_URL=... SUBLY_SPONSOR_KEYPAIR=... \
SUBLY_SELLER_API_TOKEN=dev-seller \
SUBLY_ADMIN_API_TOKEN=dev-admin \
npm run dev
```

台帳はインメモリのまま、チェーンアクセスは実mainnet。
prepare / verify までは資金移動なしで通せるが、**`/settle` ・
deposit/withdrawのsubmitは実資金が動く**。devnetは使えない
(Kamino vaultがmainnetにしかない)。一時的な検証にはdust額 +
使い捨てsponsor鍵を使うこと。

ユニット/結合テストは `npm test` (vitest、ネットワーク不要)。

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
