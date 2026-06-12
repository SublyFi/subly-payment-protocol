# Subly クローズドβ計画

最終更新: 2026-06-12

限定した第三者に Subly (yield-funded x402 決済) を使ってもらうための計画。
一般公開はしない。設計の正は `technical-design.md`、運用手順は
`operations.md`、デモ手順は `demo/README.md` を参照。

## 目的

- 第三者の agent 開発者に **Buyer 体験**(自分のエージェントが vault yield
  で有料 API に支払う)を提供し、プロダクト仮説を検証する。
- 体験の最小化のため、**Seller は当面 Subly 側でホストする**。第三者が
  自分で seller を立てるのは Phase C 以降。

## 前提条件 (β着手前に完了していること)

- [ ] mainnet フルフロー完走の実証 (402 → 署名 → 実 settle → 受取先着金)。
      ※ 2026-06-12 時点で yield 蓄積待ち、完了見込み
- [ ] `validate:mainnet` が運用予定の RPC + LUT で FULL PASS

## フェーズ概要

| Phase | 内容 | 第三者に渡すもの |
|---|---|---|
| A | Facilitator + ホスト版 Seller を https で公開 | なし (基盤構築) |
| B | Buyer オンボーディングキット (MCP ラッパーが目玉) | MCP サーバー / CLI / client トークン |
| C | Seller 向け一式 | seller gate npm パッケージ |

---

## Phase A: Facilitator + ホスト版 Seller の公開

β開始の条件。A と B が揃った時点で最初の参加者を入れる。
**デプロイ一式は `deploy/` に用意済み (2026-06-12)**: Dockerfile +
docker-compose (Postgres/Caddy 込み) + production env テンプレ +
手順書 (`deploy/README.md`)。監視は `scripts/check-sponsor-balance.sh`
(cron + webhook)。残る作業はホスティング先の決定と実デプロイのみ。

### Facilitator デプロイ

- `NODE_ENV=production` で起動する (detached 起動拒否・https 必須が
  有効になる)。小さめの常駐ホスト (Cloud Run / Fly.io / VPS) で足りる。
- DB は managed Postgres (`DATABASE_URL`)。インメモリ台帳は再起動時の
  conservative reset で蓄積 yield が消えるため**β では禁止**。
- sponsor 鍵をローカル JSON から Secret Manager / KMS 管理へ移行。
  sponsor は全参加者の決済 fee を立て替える単一障害点なので、
  SOL 残高の監視 (`SUBLY_MIN_SPONSOR_BALANCE_LAMPORTS` + アラート) と
  補充手順を運用に乗せる (`operations.md` の監視節参照)。
- RPC は専用エンドポイント (Alchemy 等)。レート制限はプラン上限を確認。
- settlement LUT をデプロイ先 env に設定 (`SUBLY_EXTRA_LOOKUP_TABLES`)。

### Vault の改善 (資金を預かる前に必須)

- 閉鎖中 reserve (`GYaaVSmduEok8sZi4Le33PgGH8NH8SXbv9y9zHBEw4io`,
  weight 50, klend deposit limit 0) への配分を curator 権限で再配分する。
  現状 AUM の過半が遊休で実効利回りが名目の半分以下。第三者の deposit を
  受ける前に解消する。
- 再配分後、`scripts/invest-vault.ts` で invest し、yield 蓄積ペースを
  再実測して Phase B の deposit ガイダンスに反映する。
- **引き出しペナルティは下げられない (2026-06-12 検証済み)**: kvault は
  vault 設定と Kamino GlobalConfig の大きい方を採用し、グローバル値が
  固定 1000 raw (0.001 USDC)。curator が vault 側を 10 raw に下げても
  実効値は 1000 のまま。**決済 1 回あたり最低 1000 raw のペナルティ +
  fee debt (~1300–3500 raw) は不可避の固定コスト**として、Phase B の
  価格ガイダンス (推奨最低価格) と収支モデルに織り込むこと。

### ホスト版 Seller

- 簡易 seller (`demo/seller.ts` ベース) を facilitator と同居デプロイ。
  受取先は Subly 運用ウォレットの USDC ATA (事前作成必須。settlement は
  ATA を作らない)。
- チャレンジ発行レート制限は組み込み済み (2026-06-12): IP 別 + 全体の
  トークンバケットで 429 を返す (`SUBLY_DEMO_CHALLENGE_RATE_PER_MIN` 等)。
  **リバースプロキシ配下では `SUBLY_DEMO_TRUST_PROXY=1` が必須** (でないと
  全クライアントが 1 つの IP に合算される)。プロキシ側のレート制限は
  多層防御として推奨。チャレンジ状態の外部化は Phase C。
- 価格はデモ用の極小額 (~10–1000 raw) から開始。fee 見積
  (`SUBLY_ESTIMATED_FEE_LAMPORTS`) は実費に近づけすぎない
  (見積 < 実費になると sponsor が回収不足になる)。

### Phase A 完了チェック

- [ ] https で facilitator `/healthz` が外部から見える
- [ ] ホスト seller に対し、運用側 agent ウォレットでフルフロー成功
- [ ] facilitator 再起動後も台帳が保持される (Postgres)
- [ ] sponsor 残高アラートが発火することを確認
- [ ] curator 再配分 + 再 invest 完了、yield ペース再実測

---

## Phase B: Buyer オンボーディングキット

### MCP ラッパー (目玉) — 実装済み (`demo/mcp-server.ts`, 2026-06-12)

`SublyX402Client` (`src/x402/client.ts`) を薄い MCP サーバーに包み、
Claude Code / OpenClaw / Cursor 等の MCP クライアントから
「有料 API のデータ取得 → 402 → yield で支払い → 結果 + レシート」を
会話一発で見せられるようにする。

- ツールは最小 1 個: `fetch_with_subly_payment(url)` —
  402 でなければそのまま返し、402 なら prepare → structured-intent
  検証 → ローカル署名 → retry し、本文と `PAYMENT-RESPONSE` レシート
  (Solscan リンク) を返す。
- 鍵・トークンは MCP サーバーの env で渡す (agent keypair / client token /
  RPC URL / facilitator URL)。**鍵はエージェントのコンテキストに出さない**。
- 配布は npm 公開前は GitHub 参照で十分 (`npx` 起動)。
- OpenClaw 向けには同じ CLI を `SKILL.md` 付きスキルとしても用意する
  (OpenClaw は MCP も使えるが、スキル形式の方がネイティブ)。

### オンボーディング手順 (admin 手動・セルフサーブ化しない)

**参加者向けガイドは `docs/beta-guide.md`、env テンプレは
`demo/env/buyer.beta.env.example`、運用側の登録は
`scripts/onboard-agent.sh` (動作検証済み) に用意済み (2026-06-12)。**

参加者 1 名あたり、運用側が実施:

1. agent ウォレット登録 (`POST /v1/wallets/agent`) と liquidity policy 確認
2. 参加者が deposit (SDK の deposit コマンド。fee/rent は sponsor 立替え)
3. chain sync (`POST /v1/wallets/{wallet}/sync`, `{"source":"chain"}`)
4. `signerProvider` 付きで `activateForPayments: true` 再登録
5. client トークンを共有 (βは参加者間で共有トークン可。署名は各自の
   手元の鍵で行われ、トークンは API アクセスのゲートでしかない)

### 参加者向けガイダンス (キットの README に明記)

- 必要なもの: agent keypair (自分で生成・自分で保管)、deposit 用 USDC、
  RPC URL、client トークン。
- **deposit 額と初決済までの待ち時間の期待値**を最初に伝える。
  再配分後の実測 (2026-06-12、60 USDC) で ~3,100 raw/時 (不均一・
  保守的には数百〜1000 raw/時/100USDC を想定)。期待値表は
  `docs/beta-guide.md` に掲載済み。
- **決済 1 回あたりの固定オーバーヘッド**: 必要 spendable は
  「価格 + vault 引き出しペナルティ + fee debt 見積」。現 vault の
  ペナルティは固定 1000 raw (0.001 USDC) + 1bps、fee debt は SOL 価格
  次第で ~1300–3500 raw。つまり価格 100 raw の決済でも spendable
  ~2500 raw が要る。少額決済はペナルティ支配になるため、価格設定の
  下限ガイダンスに含めること (vault の最小 net 引き出し 10 raw 超も必須)。
- 鍵は非カストディアル: facilitator は預からない。signer 側 validation が
  改ざんトランザクションへの署名を拒否する (`technical-design.md` の
  Signer Policy 参照)。
- 元本保全がプロダクトクレームであること: spendable yield を超える決済は
  facilitator が `insufficient_yield` で拒否する。

### Phase B 完了チェック

- [ ] Claude Code から MCP ツール経由でフルフロー成功
- [ ] OpenClaw からスキル経由でフルフロー成功
- [ ] 参加者オンボーディングを 1 回通しで実施 (所要時間を記録)

---

## Phase C: Seller 向け一式 (βのフィードバック後)

- `SublySellerGate` (`src/x402/seller.ts`) の npm パッケージ化
  (Fastify / Express ミドルウェア)。
- チャレンジ状態の外部化 (発行レート制限は組み込み済み。in-memory の
  チャレンジ保持が seller 多重化・再起動に耐えるようにする)。
- テナント別 API キーの発行・失効 (固定 3 トークンからの脱却)。
- 決済状態照会の client スコープ開放 (`GET /v1/payments/:paymentId` は
  現在 admin 専用)。MCP ツールの「配信ロスト後の自動解決」が admin
  トークンなしでも効くようになり、β参加者の二重払い防御が完全になる。
- seller 向けドキュメント: 価格設定、payTo ATA の事前作成、
  同一 `PAYMENT-SIGNATURE` での冪等 retry ルール
  (`demo/README.md` の注意節が下敷き)。

---

## β期間中の運用ルールと既知の制約

- 参加者は手動招待のみ。client トークン共有は β 限定の割り切り。
- 預かり規模の上限を決めておく (例: 参加者あたり deposit 上限、全体 AUM
  上限)。hot wallet 運用 (sponsor / seller 受取) は小額維持。
- 既知の制約:
  - seller チャレンジ in-memory 問題 (Phase C で本対策)
  - 単一 vault ハードコード (`src/config/constants.ts`)。マルチ vault は
    βスコープ外
  - admin 操作 (登録 / sync / activate) はセルフサーブ化しない
  - kVault の固定引き出しペナルティ 1000 raw は protocol floor で回避不能。
    βでは推奨最低価格で吸収する。少額決済を本気でやる場合の将来課題:
    (a) 複数決済を 1 redeem に償却する設計 (yield を agent ATA にまとめて
    引き出し、決済は SPL transfer にする — settle 時直接引き出しの信頼
    モデル変更を伴う)、(b) kVault を外して klend reserve 直接 supply
    (固定ペナルティなしのはず・要検証)、(c) 他プロトコルへの移行
- インシデント時の参照先: `operations.md` の「失敗時の挙動」節。

## 成功基準 (βで検証したいこと)

1. 第三者が自分の鍵・自分の資金で、運用ドキュメントだけを頼りに
   初決済まで到達できるか (オンボーディング摩擦の計測)。
2. 「元本に手を付けず yield で払う」というクレームが刺さるか
   (insufficient_yield 拒否のデモ込みで反応を見る)。
3. MCP / スキル経由のエージェント決済が実用に足る成功率・レイテンシか
   (settle 所要時間と失敗率を記録)。
4. sponsor 立替えモデルの収支 (fee debt 回収と SOL 補充の実コスト)。
