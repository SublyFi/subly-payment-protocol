# Subly クローズドβ デプロイ手順 (VPS + Docker Compose)

facilitator + ホスト版 seller + Postgres を 1 台の VPS に置き、Caddy で
自動 HTTPS を終端する構成。Cloud Run 等を使う場合はルートの `Dockerfile`
を単体で使い、Postgres と TLS はマネージドに置き換える。

前提: Docker / Docker Compose の入った VPS、ドメイン 2 つ
(facilitator 用 / seller 用) の A レコードがその VPS を向いていること。

## 1. 準備

```bash
git clone <このリポジトリ> /opt/subly && cd /opt/subly/deploy

cp facilitator.production.env.example facilitator.production.env
cp seller.production.env.example seller.production.env
cp Caddyfile.example Caddyfile        # ドメインを実値に
echo "POSTGRES_PASSWORD=$(openssl rand -hex 24)" > .env

# API トークン 2 種を生成して facilitator.production.env に記入
openssl rand -hex 24   # seller / admin それぞれ (buyer はトークン不要)
```

- **sponsor 鍵**: 本番用に新規生成を推奨 (`solana-keygen new -s -o secrets/sponsor.json`
  → `mkdir -p secrets` 配下)。SOL を入金 (まず 0.5 SOL 程度)。
  ファイル権限を `chmod 600` に。Secret Manager のある環境ならそちらを正とし、
  起動時に取り出して配置する。
- **settlement LUT**: デモで使った LUT は誰でも参照できるためそのまま使える。
  sponsor を新規にした場合も LUT 自体は再作成不要
  (`SUBLY_EXTRA_LOOKUP_TABLES` に既存アドレスを設定)。
- **seller 受取ウォレット**: USDC ATA を事前に作成しておく
  (settlement は ATA を作らない)。

## 2. 起動と初期化

```bash
docker compose up -d --build
docker compose logs facilitator | grep '"mode"'   # "mainnet" を確認

# liquidity policy の初期登録 + 運営用テストウォレットのオンボード
SUBLY_FACILITATOR_URL=https://<facilitator domain> \
SUBLY_ADMIN_API_TOKEN=<admin token> \
bash ../scripts/onboard-agent.sh --with-policy <テスト agent pubkey>
```

## 3. 起動前チェック

- [ ] `curl https://<facilitator>/healthz` → `{"ok":true}`
- [ ] デプロイ先の env で `npm run validate:mainnet` FULL PASS
      (リポジトリを clone した作業マシンから、本番 RPC + LUT で実行可)
- [ ] 運営テストウォレットで実決済 1 回成功 (deposit → yield 蓄積 → buyer)
- [ ] facilitator 再起動 (`docker compose restart facilitator`) 後に
      position が保持されている (Postgres 永続化)
- [ ] sponsor 残高監視が動く (下記)

## 4. 監視

cron で 10 分おきに sponsor 残高と死活を確認、しきい値割れで webhook 通知:

```cron
*/10 * * * * cd /opt/subly && SUBLY_FACILITATOR_URL=https://<facilitator domain> SUBLY_ADMIN_API_TOKEN=<admin token> SUBLY_ALERT_WEBHOOK_URL=<Slack/Discord webhook> bash scripts/check-sponsor-balance.sh >> /var/log/subly-monitor.log 2>&1
```

アラートが来たら sponsor アドレスに SOL を補充する (決済 1 回 ~15000
lamports の立替なので、0.5 SOL で数万決済分)。

台帳のバックアップ (毎日 / 7 世代):

```cron
0 4 * * * cd /opt/subly/deploy && docker compose exec -T postgres pg_dump -U postgres subly | gzip > /var/backups/subly-$(date +\%u).sql.gz
```

## 5. 参加者オンボーディング

参加者ごとの運営作業は**ありません**。利用手順は
`packages/pay/README.md` を案内する。ウォレット登録・activate・sync は
参加者側のクライアントがウォレット署名認証で自動実行する (deposit 時および
MCP サーバー起動時)。`scripts/onboard-agent.sh` は手動での再 sync 等の
運用ツールとして残っている (admin トークンで任意のウォレットに実行可)。

## 障害対応

`docs/operations.md` の「失敗時の挙動」を参照。設計の正は
`docs/technical-design.md`。
