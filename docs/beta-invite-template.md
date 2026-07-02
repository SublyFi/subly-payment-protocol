# β招待メッセージ テンプレート (運営用)

> Superseded: このテンプレートは hosted Seller β向けの古い案内である。
> 現在のデモ/配布導線では、既存 standard x402 Seller に対する
> Buyer-side yield payment を案内する。

参加者に送る案内。clone も API トークンも参加者ごとの登録作業も不要
(`npx @subly_fi/pay` + ウォレット署名認証 + 初回自動登録)。

---

Subly クローズドβへようこそ!

あなたの AI エージェント (Claude Code 等) が、預けた USDC の**元本に
手を付けずに運用利回りだけで**有料 API に支払う、を体験できます。
リポジトリの clone は不要です。

**必要なもの**: Node.js 20+ / Solana のキーペア / USDC (Solana, 50〜500 USDC 推奨)

**セットアップ (5 分・clone なし)**:

```bash
# 1. agent ウォレットの鍵を用意 (Subly は鍵を作りません)
mkdir -p ~/.subly && solana-keygen new --no-bip39-passphrase -o ~/.subly/agent.json
export SUBLY_DEMO_AGENT_KEYPAIR_PATH=~/.subly/agent.json

# 2. 表示された公開鍵に USDC を送金 (SOL 不要)、deposit (登録も自動)
npx -y @subly_fi/pay deposit 100000000      # = 100 USDC

# 3. Claude Code に登録
claude mcp add subly -- npx -y @subly_fi/pay mcp
```

**試す**: 新しい Claude Code セッションで `subly` サーバーを承認して、

> https://seller.demo.sublyfi.com/api/premium/alpha のデータを取ってきて

と頼むと、エージェントが 402 を受けて yield から 0.0001 USDC を支払い、
コンテンツとオンチェーンレシートを返します。支払いは Claude のツール
許可プロンプトであなたが都度承認します。

CLI で直接試す: `npx -y @subly_fi/pay fetch https://seller.demo.sublyfi.com/api/premium/alpha`

詳細・OpenClaw・トラブルシュート・引き出し: `docs/beta-guide.md`

注意: 実験的ソフトウェアです。失っても困らない少額のみでお願いします。
秘密鍵 (`~/.subly/agent.json`) は絶対に共有しないでください。

---
