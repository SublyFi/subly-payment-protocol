# Custody Wallet Smoke Test — Circle / Privy 実クレデンシャル検証手順

作成: 2026-07-05 JST / Status: **手順のみ(未実施)**。結果は末尾 Run Log に追記する。
対象実装: `SUBLY_SIGNER_PROVIDER=local|circle|privy`(branch `buyer-x402-realize-mcp`)。

> 背景: カストディ型エージェントウォレット対応(Circle developer-controlled
> wallets / Privy server wallets)はユニットテスト・型検査・多角レビューまで
> 完了済みだが、**プロバイダAPIの実挙動に依存する 3 つの未知数**だけは実
> クレデンシャルでしか検証できない。本手順はその 3 点を最小コスト
> (USDC ~1.02、SOL 不要、所要 ~30 分 + yield 待ち)で順に潰す。

## 検証したい 3 つの未知数

| # | 未知数 | 黒だった場合の影響 |
|---|---|---|
| ① | プロバイダは**自ウォレットが fee payer でない** tx に署名するか(Subly は sponsor / facilitator が fee 負担) | deposit/withdraw/x402 支払い全滅。プロバイダ側設定 or サポート確認が必要 |
| ② | Circle `sign/message` は**生バイトに素の ed25519 署名**をするか(ラップ/プリハッシュだと wallet-auth が通らない) | relayer API 認証が全滅。ただし実装は未検証署名を絶対に出さない設計なので、失敗は安全側(`signature did not verify` で停止) |
| ③ | Kamino deposit/withdraw のような**多命令の複雑な tx** をプロバイダが拒否しないか | vault 流入出のみ不可。x402 支払い(単純 transfer)は生き残る可能性あり |

Privy は署名 API が素直(base64 の signMessage / signTransaction)なので主リスクは①のみ。②③は主に Circle の検証項目。

## 共通前提

- ブランチ `buyer-x402-realize-mcp` で `cd packages/pay && npm run build` 済み。
  以下のコマンドは `node packages/pay/dist/<entry>.js` 表記
  (npm 公開後なら `npx -y @subly_fi/pay <cmd>` に読み替え)。
- relayer はデフォルトの本番 `https://api.demo.sublyfi.com`(env 変更不要)。
- 費用: deposit 最小 1.01 USDC + 送金分。**SOL は一切不要**(fee は全てスポンサー/facilitator 負担)。
- 手元にローカル鍵は作らない。それがこのテストの意味。

## Part A — Circle (developer-controlled wallets)

> 注意: `circle` CLI の agent wallet(email+OTP)は**別プロダクトで使用不可**
> (署名 API が無い)。使うのは w3s の developer-controlled wallets。

### A-0. アカウント準備(初回のみ、Circle Developer Console)

1. <https://console.circle.com> → API Key を作成(**LIVE** 環境。sandbox は Solana devnet になり弾かれる)。
2. Entity Secret を生成・登録(32 バイト hex = 64 文字)。コンソールの手順に従い、**recovery ファイルを必ず保管**。
3. Wallet Set を作成 → その中に **blockchain `SOL`(Solana mainnet)** のウォレットを 1 つ作成 → `walletId` を控える。

### A-1. 環境変数

```bash
export SUBLY_SIGNER_PROVIDER=circle
export CIRCLE_API_KEY=<LIVE APIキー>
export CIRCLE_ENTITY_SECRET=<64桁hex>
export CIRCLE_WALLET_ID=<walletId>
```

### A-2. Step 1: transport 初期化 + メッセージ署名 【未知数②/オンチェーン費用ゼロ】

```bash
node packages/pay/dist/setup-link.js
```

- **成功**: `[setup-link] agent <base58アドレス> -> https://api.demo...` に続き
  `setupUrl` 入りの JSON。ここまで来れば、①ウォレット取得+mainnet 確認、
  ②wallet-auth 署名(Circle sign/message → relayer が ed25519 検証)が通った
  ということ。**未知数②はクリア**。setupUrl はまだ開かなくてよい(10 分で失効、使い捨て)。
- **`[circle] signature did not verify for wallet ...`**: 未知数②が黒。
  Circle が生バイト以外(envelope/prehash)に署名している。実装は安全側で
  停止するので事故にはならない。→ Circle の sign/message レスポンスの
  `signature` 値と、送った message hex を記録して調査(transport の修正が必要)。

### A-3. Step 2: 資金投入

Step 1 で表示されたエージェントアドレスへ **USDC (Solana mainnet) を 1.02 以上**送金
(Circle コンソールの transfer でも任意のウォレットでも可)。SOL は送らない。

### A-4. Step 3: owner setup + deposit 【未知数①③の本丸】

```bash
node packages/pay/dist/setup-link.js --initial-deposit 1010000   # 1.01 USDC
# → 出力の setupUrl をスマホで開き、Face ID / パスキーで確認
node packages/pay/dist/setup-status.js st_<sessionId>            # completed を確認
node packages/pay/dist/deposit.js 1010000                        # 事前承認が自動で拾われる
```

- **deposit が confirmed**: sponsor が fee payer の Kamino deposit tx に Circle が
  署名した = **未知数①③クリア**。実質ここでテストの山は越えている。
- **失敗パターンは下のトラブルシューティング表**へ。`RemoteSigningError` の
  `detail`(プロバイダのエラーボディ)を必ず記録すること。

### A-5. Step 4: x402 支払い(@x402/svm レグ、facilitator feePayer)

支払いは **spendable yield が立ってから**(1.01 USDC だと数日単位。急ぐ場合は
ops の basis seeding で前倒し可 → `docs/operations.md`)。

```bash
node packages/pay/dist/pay.js "https://seller.demo.sublyfi.com/api/premium"
```

- `paid: true` = 全レグ(realize → withdraw → x402 exact 支払い)がカストディ署名で完走。

### A-6. Step 5: withdraw(退出経路の確認)

```bash
node packages/pay/dist/withdraw.js 500000   # 0.5 USDC
```

## Part B — Privy (server wallets)

### B-0. アカウント準備(初回のみ、Privy Dashboard)

1. <https://dashboard.privy.io> → アプリ作成 → **App ID / App Secret** を控える。
2. Wallets → **Solana** の server wallet を作成 → `walletId` を控える。
   - **agentic wallet(authorization key 付き)も可**: その場合は authorization
     private key(`wallet-auth:` プレフィックス付き base64)も控え、
     `PRIVY_AUTHORIZATION_KEY` に設定する(下記 B-1)。テストとしては
     **むしろ authorization key 付きで実施するのが本命**(Privy の
     エージェント向け推奨構成のため)。

### B-1. 環境変数

```bash
export SUBLY_SIGNER_PROVIDER=privy
export PRIVY_APP_ID=<app id>
export PRIVY_APP_SECRET=<app secret>
export PRIVY_WALLET_ID=<walletId>
export PRIVY_AUTHORIZATION_KEY=<wallet-auth:...>  # owner-key wallet の場合のみ
```

### B-2. Step 1〜5

Part A の A-2 〜 A-6 とコマンドは完全に同一(env の差し替えのみ)。
Privy の検証ポイントは実質①のみ: Step 3 の deposit が通れば完了とみなしてよい。

## 期待結果まとめ

| Step | コマンド | 検証対象 | 成功条件 |
|---|---|---|---|
| 1 | `setup-link`(引数なし) | transport 初期化・未知数② | agent アドレス表示 + setupUrl JSON |
| 2 | USDC 送金 | — | 残高反映 |
| 3 | `setup-link --initial-deposit` → Face ID → `deposit` | **未知数①③** | depositId + status confirmed |
| 4 | `pay fetch` | x402 レグ(facilitator feePayer) | `paid: true` |
| 5 | `withdraw` | 退出経路 | status confirmed |

## トラブルシューティング

| エラー | 原因 | 対処 |
|---|---|---|
| `[circle] GET /v1/w3s/wallets/... failed with 401` | API キー不正 / sandbox キー | LIVE キーか確認 |
| `[circle] wallet ... is on SOL-DEVNET, expected SOL` | devnet ウォレット | mainnet (`SOL`) で作り直し |
| `[circle] entity secret must be 32 bytes of hex` | entity secret の形式 | 64 桁 hex を確認 |
| `[circle] signature did not verify for wallet ...` (Step 1) | **未知数②黒** | 署名レスポンスを記録して transport 調査へ |
| `[circle/privy] ... sign/transaction failed with 4xx` / `signed transaction is missing the signature` (Step 3) | **未知数① or ③黒**: 非 fee-payer or 複雑 tx を拒否 | `RemoteSigningError.detail` を記録。x402 レグ(Step 4)だけでも通るか切り分け |
| `[privy] wallet ... is ethereum, expected solana` | チェーン違い | Solana wallet で作り直し |
| `[privy] POST .../rpc failed with 4xx`(authorization 系) | owner-key wallet なのに `PRIVY_AUTHORIZATION_KEY` 未設定、または key 不一致 | 正しい authorization key を設定 |
| `[privy] authorization key is not a base64 PKCS#8 ...` | key の形式(`wallet-auth:` 付き base64 PKCS#8 を期待) | dashboard から出力された値をそのまま設定 |
| `CIRCLE_API_KEY (or SUBLY_CIRCLE_API_KEY) is required ...` | env 未設定 / 空文字 | export を確認 |
| deposit 時 `mandate_required_for_deposit` | setup 未完了 | Step 3 の setup-link からやり直し |
| pay 時 yield 不足系 refusal | yield 未発生 | 待つ or basis seeding (`docs/operations.md`) |

## 結果の記録とクリーンアップ

- 各 Step の成否・tx signature・エラー detail を下の Run Log に追記。
- 3 つの未知数の結論が出たら memory(subly-custody-wallet-signers)にも反映し、
  クリアなら README / ドキュメントの「実機未検証」注記を外して announce 可。
- クリーンアップ: `withdraw` で全額退出 → ウォレットから USDC を回収 →
  テスト専用クレデンシャルなら API キー / entity secret を無効化。

## Run Log

| 日付 | Provider | Step 1 | Step 3 | Step 4 | Step 5 | 未知数①②③ | メモ |
|---|---|---|---|---|---|---|---|
| — | — | — | — | — | — | — | 未実施 |
