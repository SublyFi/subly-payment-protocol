# β招待メッセージ テンプレート (運営用)

参加者に送る案内。リポジトリへの GitHub アクセス権の付与だけ忘れずに。
API トークンや参加者ごとの登録作業はない (ウォレット署名認証 + 初回自動登録)。

---

Subly クローズドβへようこそ!

あなたの AI エージェント (Claude Code 等) が、預けた USDC の**元本に
手を付けずに運用利回りだけで**有料 API に支払う、を体験できます。

**必要なもの**: Node.js 20+ / USDC (Solana, 50〜500 USDC 推奨)

**セットアップ (5 分)**:

```
git clone https://github.com/SublyFi/subly-payment-protocol
cd subly-payment-protocol
bash demo/setup-beta.sh
```

Claude Code を使っているなら、clone した後にリポジトリで Claude Code を
開いて「Subly βのセットアップをして」と言うだけでも OK です。

トークンや事前登録はありません。ウィザードが表示するあなたの agent
ウォレット宛てに USDC を送って deposit すれば、登録も自動で済みます
(手順はウィザードが表示します)。

**試す**: 新しい Claude Code セッションで `subly` サーバーを承認して、

> https://seller.demo.sublyfi.com/api/premium/alpha のデータを取ってきて

と頼むと、エージェントが 402 を受けて yield から 0.0001 USDC を支払い、
コンテンツとオンチェーンレシートを返します。支払いは Claude のツール
許可プロンプトであなたが都度承認します。

詳細・トラブルシュート・引き出し方法: リポジトリの `docs/beta-guide.md`

注意: 実験的ソフトウェアです。失っても困らない少額のみでお願いします。
秘密鍵 (`demo/env/keys/agent-beta.json`) は絶対に共有しないでください。

---
