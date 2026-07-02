# Subly Relayer Deployment

この `deploy/` ディレクトリは、現行の Subly relayer(buyer 側の
vault/budget/yield-realize API)を docker compose で立てる bundle。

Subly relayer は **x402 facilitator ではない**。x402 facilitator は
Seller が選ぶもの(Nansen なら PayAI、Base なら Coinbase CDP)。
relayer の仕事は次の3つだけ:

- sponsor 鍵で deposit / withdraw / realize のガスを立て替える
- 台帳(principal basis / yield / feeDebt)を持つ
- `purpose: "yield_realize"` の withdraw を spendable yield 以内に強制する

## 構成

```text
caddy (443, auto-TLS)
└─ relayer :3000   ← api.demo.sublyfi.com
   └─ postgres     ← ledger
secrets/sponsor.json  ← sponsor 鍵 (ホストのみ、イメージに焼かない)
```

## 初回セットアップ

```bash
cd deploy
cp relayer.production.env.example relayer.production.env   # 値を埋める
cp Caddyfile.example Caddyfile                              # ドメインを設定
mkdir -p secrets && <sponsor鍵を secrets/sponsor.json に配置>
echo "POSTGRES_PASSWORD=$(openssl rand -hex 24)" > .env
docker compose up -d --build
```

## 更新デプロイ(コード反映)

サーバーに git credential を置かないため、`git archive` で配布する:

```bash
# ローカル
git archive --format=tar.gz -o /tmp/subly.tar.gz HEAD
scp -i ~/.ssh/lightsail-tokyo.pem /tmp/subly.tar.gz ubuntu@<host>:/tmp/
# サーバー
sudo tar xzf /tmp/subly.tar.gz -C /opt/subly
echo <commit> | sudo tee /opt/subly/DEPLOYED_COMMIT
cd /opt/subly/deploy
docker compose build relayer && docker compose up -d --remove-orphans relayer
curl -s https://<domain>/healthz   # {"ok":true}
```

ホスト側専用ファイル(`relayer.production.env`, `.env`, `Caddyfile`,
`secrets/`)は untracked なので tar 展開で上書きされない。

## Legacy

旧 `subly-yield-exact` の Seller 向けエンドポイント(`/v1/x402/supported|verify|settle`)は
デフォルトで無効。過去の検証を再現する場合のみ relayer env に
`SUBLY_ENABLE_LEGACY_X402=1` と `SUBLY_SELLER_API_TOKEN` を設定する。
hosted seller(demo/seller.ts)の compose サービスは撤去済み。
