# Subly Demo: 有料APIをvault yieldで決済するBuyer / Seller

`402 -> sign -> retry -> settle -> API response` のフローを最小構成で見せるデモ。

- `seller.ts`: 有料API (`GET /api/premium/alpha`) をホストするSeller。
  `SublySellerGate` で402チャレンジを発行し、retry時にfacilitatorの
  `/verify` → `/settle` を通過した場合だけレスポンスを返す
  (settle-before-deliver)。
- `buyer.ts`: Agent側のBuyer CLI。402を受けてfacilitatorでprepare →
  structured-intent検証 → ローカル署名 → `PAYMENT-SIGNATURE` 付きretry。
  支払い原資はagent walletのKamino vault yield。

## ドキュメントの読み分け

- **デモを動かす** → 本書だけでよい。
- **facilitatorの環境変数の意味・本番デプロイ・障害対応** →
  `docs/operations.md` (本書からは必要箇所のみ参照する)。
- **設計の正** → `docs/technical-design.md`。

## 環境変数の設定方法

dotenvは使っていない (各プロセスが `process.env` を直接読む)。
プロセスは facilitator / seller / buyer の3つで、**ターミナルを3つ開き、
それぞれで対応するenvファイルを `source` してから起動する**。
envファイルは `demo/env/` に用意済み:

| ファイル | 用途 |
|---|---|
| `facilitator.detached.env` / `seller.detached.env` / `buyer.detached.env` | 予行演習用。そのまま使える (資金・RPC・実鍵不要) |
| `*.mainnet.env.example` | フルフロー用テンプレ。`*.mainnet.env` にコピーして実値を埋める (gitignore済み) |

使い方 (必ずリポジトリルートから):

```bash
source demo/env/facilitator.detached.env && npm run dev          # ターミナル1
source demo/env/seller.detached.env && npm run demo:seller       # ターミナル2
source demo/env/buyer.detached.env && npm run demo:buyer         # ターミナル3
```

`source` はそのターミナル(シェル)内だけで有効。値を変えたら同じターミナルで
`source` し直す。detached用の使い捨て鍵は `demo/env/keys/` に置く
(`agent-detached.json` / `seller-detached.json`。なければ
`solana-keygen new --no-bip39-passphrase -s -o demo/env/keys/agent-detached.json`
で再生成。ディレクトリごとgitignore済み)。

## 付属スクリプト (mainnet フルフロー用)

- `npm run demo:deposit -- <amountRawUsdc>`: agent walletのUSDCをvaultへ
  deposit (facilitator経由: prepare → intent検証 → ローカル署名 → submit。
  手数料/rentはsponsor立替えなのでagentにSOLは不要)。
- `npx tsx scripts/invest-vault.ts`: vaultのidle資金をreserveへ投資する
  パーミッションレスクランク (sponsor鍵で実行)。**investしないとyieldは
  発生しない**。reserveごとに1トランザクション送信する。
- facilitatorを再起動しても台帳が消えないよう、フルフロー時は
  `DATABASE_URL` (ローカルPostgresで可) を設定すること。未設定の
  インメモリ台帳で再起動すると、chain syncのconservative resetで
  蓄積済みyieldが原本に繰り入れられて消える。

## 前提

`/settle` は実際のKamino redeemを伴うため、**フルフローはmainnetモードの
facilitatorでしか完走しない** (`docs/operations.md` 参照)。事前に:

1. Facilitatorをmainnetモードで起動 (`SOLANA_RPC_URL` + sponsor鍵 +
   3種のAPIトークン)。settlement LUT (`SUBLY_EXTRA_LOOKUP_TABLES`) と
   sponsor SOLが必要。
2. Seller向けliquidity policyを登録 (`POST /v1/admin/liquidity-policies`)。
   `expectedPaymentSizeRawUsdc` はデモ価格以上にすること
   (下回ると `amount_exceeds_policy` で拒否)。
3. Agentウォレットを登録 (`POST /v1/wallets/agent`) して
   `POST /v1/wallets/{wallet}/sync` body `{"source":"chain"}` で同期。
   Agent walletにvault shares (yield発生済み) が必要。
   activeにするには `signerProvider` の指定が必須で、position sync後に
   `activateForPayments: true` で再登録する (sync前はobserved_onlyのまま)。
4. 検証はdust額で。デフォルト価格は 0.01 USDC (`10000` raw units)。

## 起動

### 1. Facilitator

```bash
NODE_ENV=development SOLANA_RPC_URL=... SUBLY_SPONSOR_KEYPAIR_PATH=... \
SUBLY_EXTRA_LOOKUP_TABLES=<settlement LUT> \
SUBLY_SELLER_API_TOKEN=dev-seller \
SUBLY_CLIENT_API_TOKEN=dev-client \
SUBLY_ADMIN_API_TOKEN=dev-admin \
npm run dev
```

### 2. Seller (別ターミナル)

```bash
SUBLY_SELLER_API_TOKEN=dev-seller \
SUBLY_DEMO_SELLER_WALLET=<USDCを受け取るsellerウォレット> \
npm run demo:seller
```

オプション: `SUBLY_FACILITATOR_URL` (default `http://localhost:3000`)、
`SUBLY_DEMO_SELLER_PORT` (default `4021`)、`SUBLY_DEMO_SELLER_BASE_URL`、
`SUBLY_DEMO_PRICE_RAW_USDC` (default `10000`)。

### 3. Buyer (別ターミナル)

```bash
SUBLY_CLIENT_API_TOKEN=dev-client \
SOLANA_RPC_URL=... \
SUBLY_DEMO_AGENT_KEYPAIR_PATH=<agent walletのkeypair JSON> \
SUBLY_ADMIN_API_TOKEN=dev-admin \
npm run demo:buyer
```

`SUBLY_ADMIN_API_TOKEN` は任意。設定すると決済前後のyield budget
(position価値とspendable yield) を表示し、決済でbudgetが減るのを確認できる。
`SUBLY_DEMO_AGENT_KEYPAIR` (base58) でも鍵を渡せる。

成功すると、Buyer側に402受信 → 署名 → retry → premiumレスポンス →
settlementレシート (Solscanリンク) が、Seller側にチャレンジ発行 →
verify/settle → 配信のログがステップごとに出る。

## ローカル予行演習 (資金移動なし・detachedモード)

RPC/sponsor鍵なしのdetached facilitatorでも、402発行 → チャレンジ解析 →
prepare認証 → budget検証までの全トランスポートを予行できる
(Kamino transaction builder直前の `transaction_builder_unavailable` で停止する)。

```bash
# ターミナル1: facilitator (detached)
source demo/env/facilitator.detached.env && npm run dev

# ターミナル2: seller
source demo/env/seller.detached.env && npm run demo:seller

# ターミナル3: セットアップ (wallet登録 → policy登録 → 手動sync → activate) → buyer
bash demo/setup-detached.sh
source demo/env/buyer.detached.env && npm run demo:buyer
```

セットアップの中身 (個別に叩きたい場合は `demo/setup-detached.sh` を参照):
agentウォレット登録 → liquidity policy登録 → 手動syncでposition seed
(100 USDC相当 + exchange rate 1.1 = spendable yield 10 USDC) →
sync後に `signerProvider` 付きで `activateForPayments: true` 再登録。

この状態でbuyerを実行すると、budget表示 → 402 → prepare →
`transaction_builder_unavailable` まで進む。
`SUBLY_DEMO_PRICE_RAW_USDC` をspendable yield (上記seedでは10 USDC) より
大きくしてsellerを起動し直すと、`insufficient_yield` での拒否
(spendable / required の内訳付き) が確認できる。

## 注意

- BuyerのリクエストURLと、Sellerが402に入れる `resource`
  (`SUBLY_DEMO_SELLER_BASE_URL` + path) は完全一致が必要。`localhost` と
  `127.0.0.1` の混在はresource mismatchになる。
- Facilitatorは `canonicalResourceUrl` にhttpsを要求する。例外は
  `NODE_ENV=development` / `test` かつloopback (`localhost` / `127.0.0.1`)
  のhttpのみ (このデモ用に許可。productionでは常にhttps必須)。
- Sellerのチャレンジはin-memory保持 (TTL 120秒、上限1000件)。402を受けてから
  120秒以内にretryすること (これを超えるとfacilitator側に決済予約が残ったまま
  新しい402が発行され、二重予約になり得る)。Seller再起動後は古いチャレンジに
  対するretryは新しい402になる。上限到達時は503 `too_many_open_challenges`。
- 決済成功後もチャレンジはTTLまで保持される: 配信レスポンスが途中で失われても、
  **同じ `PAYMENT-SIGNATURE` でretryすれば** facilitatorの冪等な `/settle` が
  同じレシートを返し、コンテンツが再配信される (新しい402からやり直すと
  二重支払いになるため、必ず同じヘッダでretryすること)。Sellerがfacilitatorに
  到達できない場合は502 `facilitator_unreachable` (30秒タイムアウト)、同一
  チャレンジへの並行retryは409 `settlement_in_progress`。
- このSellerはlocalhostデモ用で、公開インターネットに置く想定ではない。
  チャレンジ発行は未認証GETごとに行われるため、公開すると安価なリクエストで
  上限1000件を占有され続け、正規のbuyerが503になる (レート制限等は未実装)。
- Budget超過デモ: `SUBLY_DEMO_PRICE_RAW_USDC` をspendable yieldより大きくして
  Buyerを実行すると、facilitatorがprepareを拒否して支払いが行われないことを
  見せられる (元本に手を付けない、というプロダクトクレームの実演)。
