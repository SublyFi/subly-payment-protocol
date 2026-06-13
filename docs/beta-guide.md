# Subly クローズドβ 参加者ガイド

あなたのエージェント (Claude Code / OpenClaw 等) が、預けた USDC の**元本に
手を付けず、運用利回り (yield) だけで**有料 API に支払うことを体験する
クローズドβです。**リポジトリの clone は不要** — npm パッケージ
`@subly_fi/pay` を `npx` で使います。

> **免責**: これは実験的ソフトウェアであり、実際の資金が Solana mainnet 上で
> 動きます。**失っても困らない少額のみ**を使用し、参加は自己責任で
> お願いします。スマートコントラクト (Kamino)・本ソフトウェアの不具合に
> よる損失の補償はありません。

## 仕組み (1分版)

1. あなたの USDC を Kamino の利回り vault に預ける (出し入れ自由)
2. エージェントが有料 API を叩くと HTTP 402 が返る
3. クライアントが facilitator 経由で支払いを準備し、**あなたの手元の鍵**で署名
4. vault の蓄積 yield から決済され、コンテンツとレシートが返る
5. **spendable yield を超える支払いは facilitator が拒否する** — 元本は減らない

秘密鍵は常にあなたの手元に残ります (非カストディアル)。リクエストは鍵の
署名で認証され、API トークンや事前登録はありません (標準 x402 と同じ考え方)。

## 必要なもの

- Node.js 20+
- Solana のキーペア (自分で用意。`solana-keygen` か手持ちウォレットの export)
- USDC (Solana mainnet、推奨 50〜500 USDC) を入れた既存ウォレット
- 運営から受け取る: 有料デモ API の URL (facilitator URL は既定値で OK)

## セットアップ (clone 不要)

```bash
# 1. agent ウォレットの鍵を用意 (Subly は鍵を作りません — 標準ツールで)
mkdir -p ~/.subly
solana-keygen new --no-bip39-passphrase -o ~/.subly/agent.json
#   → 表示される公開鍵があなたの agent ウォレットアドレス
export SUBLY_DEMO_AGENT_KEYPAIR_PATH=~/.subly/agent.json

# 2. その公開鍵宛てに USDC を送金 (Phantom 等から。SOL は不要 — 手数料は
#    運営の sponsor が立て替える)

# 3. vault に deposit (最小 1 USDC。deposit がウォレット登録も自動で行う)
npx -y @subly_fi/pay deposit 100000000      # = 100 USDC
```

`solana-keygen` が無い環境なら、手持ちの Solana ウォレットから秘密鍵を
64 バイト JSON 形式で export して同じパスに置いても構いません。

## エージェントから支払う

### Claude Code (MCP)

```bash
claude mcp add subly -- npx -y @subly_fi/pay mcp
```

`SUBLY_DEMO_AGENT_KEYPAIR_PATH` を環境に設定した状態で新しい Claude Code
セッションを開き、`subly` サーバーを承認 → 「<有料 API の URL> のデータを
取ってきて」と頼むだけ。ツール実行の許可プロンプトが**あなたの決済承認**に
あたります (`fetch_with_subly_payment` を「常に許可」にはしない)。

### OpenClaw (スキル)

OpenClaw 同梱用スキルは [ClawHub / git から install](https://docs.openclaw.ai/cli/skills)
できます。スキルは内部で `npx -y @subly_fi/pay fetch <url>` を呼ぶだけなので、
これも clone 不要です。`SUBLY_DEMO_AGENT_KEYPAIR_PATH` を設定し、エージェントに
同じ依頼をすれば yield から支払ってレシートを返します。

### CLI で直接

```bash
npx -y @subly_fi/pay fetch https://seller.demo.sublyfi.com/api/premium/alpha
```

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
| `payment_outcome_unknown` / `payment_already_settled` | 前回の支払いの結果が不明 / 既に決済済み。ツールが自動で facilitator に照会し、未 settle 確定なら次の呼び出しで安全に再購入される。`payment_already_settled` の場合の `forceNewPayment=true` は「同じものに二重に払う」明示なので安易に使わない |
| `deposit_below_minimum` | vault の最小 deposit は 1 USDC (`1000000` raw) |
| 429 (rate limited) | レート制限。少し待つ |
| resource mismatch | URL は 402 を返した URL と完全一致が必要 (末尾スラッシュ等に注意) |

## 引き出し

預けた USDC はいつでも自分で引き出せます (instant withdraw、運営への依頼は不要):

```bash
npx -y @subly_fi/pay withdraw 1000000  # 1 USDC
```

注意点:

- 引き出し額には vault の引き出しペナルティ (固定 0.001 USDC + 端数) が
  かかる
- **引き出すと、その時点で蓄積していた spendable yield は元本扱いに
  繰り入れられ、支払い予算はゼロから再蓄積になる** (資金は失われないが、
  次の支払いまでまた待つことになる)。退出時以外の引き出しは計画的に
- 全額引き出し (退出) は deposit 額 + 蓄積 yield がまとめて agent
  ウォレットの USDC ATA に戻る
