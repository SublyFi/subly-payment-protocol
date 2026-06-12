# Subly クローズドβ 参加者ガイド

あなたのエージェント (Claude Code / OpenClaw 等) が、預けた USDC の**元本に
手を付けず、運用利回り (yield) だけで**有料 API に支払うことを体験する
クローズドβです。

> **免責**: これは実験的ソフトウェアであり、実際の資金が Solana mainnet 上で
> 動きます。**失っても困らない少額のみ**を使用し、参加は自己責任で
> お願いします。スマートコントラクト (Kamino)・本ソフトウェアの不具合に
> よる損失の補償はありません。

## 仕組み (1分版)

1. あなたの USDC を Kamino の利回り vault に預ける (出し入れ自由)
2. エージェントが有料 API を叩くと HTTP 402 が返る
3. MCP ツールが facilitator 経由で支払いを準備し、**あなたの手元の鍵**で署名
4. vault の蓄積 yield から決済され、コンテンツとレシートが返る
5. **spendable yield を超える支払いは facilitator が拒否する** — 元本は減らない

秘密鍵は常にあなたの手元に残ります (非カストディアル)。facilitator は
あなたの署名なしに資金を動かせず、署名前にはトランザクション内容の
構造化検証が走り、改ざんされたトランザクションには署名しません。

## 必要なもの

- Node.js 20+ / git / (鍵生成に) solana-keygen
- Solana RPC URL (Alchemy / Helius などの無料枠で十分)
- USDC (Solana mainnet、推奨 50〜500 USDC) を入れた既存ウォレット
- 運営から受け取る: facilitator URL、client トークン、有料デモ API の URL

## セットアップ

```bash
git clone <このリポジトリ> && cd subly-agent-payments
npm ci

# 1. agent 鍵を生成 (このファイルは絶対に共有しない)
solana-keygen new --no-bip39-passphrase -s -o demo/env/keys/agent-beta.json

# 2. 公開鍵を運営に伝える (運営側でウォレット登録される)
solana-keygen pubkey demo/env/keys/agent-beta.json

# 3. env を作る
cp demo/env/buyer.beta.env.example demo/env/buyer.mainnet.env
#    <...> を埋める (facilitator URL / client トークン / RPC URL)

# 4. agent ウォレットに USDC を送る (Phantom 等から公開鍵宛て。SOL は不要 —
#    手数料は運営の sponsor が立て替える)

# 5. vault に deposit (例: 100 USDC = 100000000 raw)
source demo/env/buyer.mainnet.env && npm run demo:deposit -- 100000000

# 6. 運営に「deposit した」と伝える → 運営が sync + activate して完了
```

## エージェントから支払う (MCP)

```bash
# Claude Code に登録 (リポジトリルートで)
claude mcp add subly -- bash "$(pwd)/demo/run-mcp.sh"
```

新しい Claude Code セッションで `subly` サーバーを承認し、
「<有料デモ API の URL> のデータを取ってきて」と頼むだけです。
ツール実行の許可プロンプトが**あなたの決済承認**にあたります —
`fetch_with_subly_payment` を「常に許可」にはしないでください。

OpenClaw 等の他の MCP クライアントには、コマンド
`bash <リポジトリ絶対パス>/demo/run-mcp.sh` の stdio サーバーとして
登録します。CLI で試す場合は
`source demo/env/buyer.mainnet.env && npm run demo:buyer` でも同じ
フローが動きます (`SUBLY_DEMO_RESOURCE_URL` に API の URL を設定)。

## 期待値: いくら預けるとどのくらいで支払えるか

決済 1 回には「価格 + 固定オーバーヘッド ~0.0024 USDC (vault 引き出し
ペナルティ 0.001 + ネットワーク手数料立替分)」の spendable yield が
必要です。yield の蓄積ペースは預入額に比例します:

| deposit | 初決済まで (目安) | 以降の決済間隔 (目安) |
|---|---|---|
| 50 USDC | 数時間〜半日 | 数時間 |
| 100 USDC | 2〜5 時間 | 1〜3 時間 |
| 500 USDC | 1 時間以内 | 約 30 分 |

(2026-06-12 の vault 実測ベースの概算。再配分直後の実測では 60 USDC で
~3,100 raw/時と表より大幅に速かったが、蓄積は reserve の利息更新タイミング
依存で不均一なため、表は保守的な値にしてある。市況で変動します)

## うまくいかないとき

| 症状 | 意味と対処 |
|---|---|
| `insufficient_yield` | spendable yield が必要額未満。details に内訳 (価格 / gross / fee) が出る。**仕様通りの動作** — yield が貯まるまで待つ |
| `amount_exceeds_client_cap` | challenge の価格があなたの上限 (`SUBLY_MCP_MAX_AMOUNT_RAW_USDC`) 超え。意図した価格なら上限を上げる |
| `delivery_failed_payment_pending` | 支払い署名済みで配信だけ失敗。**同じ URL でもう一度呼ぶだけ** (同じ署名で再試行され、二重払いしない) |
| `payment_outcome_unknown` / `payment_already_settled` | 前回の支払いの結果が不明 / 既に決済済み。運営に paymentId を伝えて確認。`forceNewPayment=true` は「二重に払ってよい」という明示なので安易に使わない |
| 429 (rate limited) | チャレンジ発行のレート制限。少し待つ |
| resource mismatch | URL は 402 を返した URL と完全一致が必要 (末尾スラッシュ等に注意) |

## 引き出し

預けた USDC はいつでも引き出せます (instant withdraw、mainnet 検証済み):

```bash
source demo/env/buyer.mainnet.env && npm run demo:withdraw -- 1000000  # 1 USDC
```

注意点:

- 引き出し額には vault の引き出しペナルティ (固定 0.001 USDC + 端数) が
  かかる
- **引き出すと、その時点で蓄積していた spendable yield は元本扱いに
  繰り入れられ、支払い予算はゼロから再蓄積になる** (資金は失われないが、
  次の支払いまでまた待つことになる)。退出時以外の引き出しは計画的に
- 全額引き出し (退出) は deposit 額 + 蓄積 yield がまとめて agent
  ウォレットの USDC ATA に戻る
