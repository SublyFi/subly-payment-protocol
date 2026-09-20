# Run a Subly relayer

This guide installs Subly **0.8.6** from the `pay-v0.8.6` source tag on Linux.
The relayer provides the vault API, gas sponsorship and PostgreSQL ledger.
Sellers use their own x402 facilitator. This is unaudited beta software that
uses real mainnet funds. The relayer enforces owner policy and principal
accounting off chain; it does not prevent an agent key from transacting outside
Subly. Review the [security model](../docs/security-model.md) before operating it.

To run the same Docker stack on a Mac with Claude Desktop, use [local Docker setup](../docs/local-demo.md).

For a new installation, complete steps 1–5, then validate and set up backups.
For an existing installation, use [Updating a running deployment](#updating-a-running-deployment).

## 1. Prepare the host

Use Bash and one operator account with sudo and Docker access. Install:

- [Docker Engine and the Compose plugin](https://docs.docker.com/engine/install/).
  Complete the [Linux post-installation steps](https://docs.docker.com/engine/install/linux-postinstall/)
  so the operator can run Docker without sudo, then log in again.
- Git, curl, OpenSSL, Python 3, GNU `install`/`tar`, and a cron service.
- [Node.js 24 or newer, with npm](https://nodejs.org/en/download), for validation scripts.
- [Solana CLI](https://solana.com/docs/intro/installation), for sponsor key creation.

You also need:

- A domain pointing to this host, with inbound TCP **80 and 443** open.
  Remove any stale DNS AAAA record.
- A dedicated Solana mainnet RPC endpoint.
- A [Pyth Hermes API key](https://pythdata.app/). The default provider is
  `https://pyth.dourolabs.app/hermes`; a compatible HTTPS provider can be set
  with `SUBLY_HERMES_BASE_URL`.

Check before proceeding. `docker version` must show both Client and Server:

```bash
docker version
docker compose version
node --version                    # v24.x or newer
npm --version
git --version
python3 --version
command -v bash curl openssl install tar crontab solana-keygen
```

### Prepare the sponsor key

The sponsor pays SOL for transaction fees and account rent. Create a dedicated
key in a **private terminal**; `solana-keygen` displays its recovery phrase.
Do not run this through an AI tool or share its output.

```bash
(
  set -euo pipefail
  umask 077
  mkdir -p "$HOME/.config/subly"
  test ! -e "$HOME/.config/subly/sponsor.json"
  test ! -L "$HOME/.config/subly/sponsor.json"
  solana-keygen new --no-bip39-passphrase -o "$HOME/.config/subly/sponsor.json"
  chmod 600 "$HOME/.config/subly/sponsor.json"
)
```

If you already have a dedicated key, use it instead. Back up the key and
recovery phrase securely. Fund only its **public address**, within your chosen
operating budget. The default low-balance alert threshold is 0.1 SOL.
Never share keys, admin tokens or private environment files.

## 2. Get the code

This creates `/opt/subly`, owned by the operator. It stops if that path exists:

```bash
(
  set -euo pipefail
  if [ -e /opt/subly ] || [ -L /opt/subly ]; then
    echo '/opt/subly already exists; inspect it or use the upgrade procedure.' >&2
    exit 1
  fi
  sudo install -d -o "$(id -u)" -g "$(id -g)" -m 0750 /opt/subly
  git clone --branch pay-v0.8.6 --depth 1 https://github.com/SublyFi/subly-payment-protocol.git /opt/subly
)
```

If cloning stops partway through, inspect the directory before retrying.

<details>
<summary>Alternative: transfer a source archive</summary>

From a workstation checkout containing `pay-v0.8.6`, replace `OPERATOR@HOST`:

```bash
git archive --format=tar.gz -o /tmp/subly-pay-v0.8.6.tar.gz pay-v0.8.6
scp /tmp/subly-pay-v0.8.6.tar.gz OPERATOR@HOST:/tmp/
```

On the host, extract as the operator:

```bash
(
  set -euo pipefail
  test -f /tmp/subly-pay-v0.8.6.tar.gz
  test ! -e /opt/subly
  test ! -L /opt/subly
  sudo install -d -o "$(id -u)" -g "$(id -g)" -m 0750 /opt/subly
  tar --no-same-owner -xzf /tmp/subly-pay-v0.8.6.tar.gz -C /opt/subly
)
```

</details>

## 3. Create private configuration

Run once, using the same operator account. Change `sponsor_source` if needed.
The block refuses to replace existing files; after a partial failure, inspect
and resume instead of rerunning initialization.

```bash
(
  set -euo pipefail
  set -o noclobber
  umask 077
  cd /opt/subly/deploy
  sponsor_source="$HOME/.config/subly/sponsor.json"
  test -f "$sponsor_source"
  for target in relayer.production.env Caddyfile .env secrets/sponsor.json; do
    if [ -e "$target" ] || [ -L "$target" ]; then
      echo "Refusing to replace $target; inspect the existing installation." >&2
      exit 1
    fi
  done
  install -d -m 0700 secrets
  cat relayer.production.env.example > relayer.production.env
  cat Caddyfile.example > Caddyfile
  printf 'POSTGRES_PASSWORD=%s\n' "$(openssl rand -hex 24)" > .env
  sudo install -o 1000 -g 1000 -m 0600 "$sponsor_source" secrets/sponsor.json
)
```

The deployed key must be readable by container UID 1000. Keep these private
files out of Git. **Never regenerate `POSTGRES_PASSWORD` for an existing
database or run `docker compose down -v` as a repair.** Changing the environment
file does not change the database's stored password.

## 4. Set your credentials and domain

Open these files in an editor (`nano`, or your preferred editor):

```bash
cd /opt/subly/deploy
nano relayer.production.env Caddyfile
```

| File | Set |
| --- | --- |
| `relayer.production.env` | `SOLANA_RPC_URL`: dedicated mainnet RPC URL |
| `relayer.production.env` | `SUBLY_HERMES_API_KEY`: Pyth key |
| `relayer.production.env` | `SUBLY_ADMIN_API_TOKEN`: unique random token |
| `relayer.production.env` | `SUBLY_APPROVE_URL_BASE=https://YOUR_DOMAIN/approve/` |
| `relayer.production.env` | `SUBLY_SETUP_URL_BASE=https://YOUR_DOMAIN/setup/` |
| `Caddyfile` | Replace `relayer.example.com` with `YOUR_DOMAIN` |

Replace `YOUR_DOMAIN` with your real hostname everywhere in this guide.
Generate the admin token with a password manager or `openssl rand -hex 24`.
Keep an existing installation's hostname stable; changing domains changes passkey
access and requires an owner credential migration plan. The same hostname must serve both owner pages: their URLs also determine the
passkey origin. Leave WebAuthn overrides unset for this deployment.

Keep `SUBLY_MANDATE_ENFORCEMENT=on` and legacy x402 endpoints disabled.
Leave `SUBLY_EXTRA_LOOKUP_TABLES` unset unless validation shows it is needed.
For custom vaults, complete [vault configuration](#advanced-your-own-kamino-vault)
before starting.

## 5. Check and start

```bash
cd /opt/subly/deploy
docker compose config --quiet
sudo test -f secrets/sponsor.json
sudo stat -c 'sponsor key owner=%u:%g mode=%a' secrets/sponsor.json   # 1000:1000, 600
docker compose run --rm --no-deps caddy caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile
docker compose up -d --build --wait
curl --fail https://YOUR_DOMAIN/readyz
```

Expected: Postgres and relayer are healthy, Caddy is running, and `/readyz`
returns `{"ok":true}`. The schema is created automatically. These checks do not
prove oracle access, sponsor funding, liquidity or payment completion.

If a command fails, stop and inspect locally:

```bash
cd /opt/subly/deploy
docker compose ps
docker compose logs --tail=100 relayer caddy postgres
```

| Symptom | Check |
| --- | --- |
| Cannot connect to Docker | Start the Docker service and check operator access |
| Missing environment file or Compose variable | Complete steps 3–4 |
| Cannot read sponsor key | Check file ownership `1000:1000` and mode `600` |
| Database password rejected | Restore the original `deploy/.env`; do not generate a new password |
| Vault/RPC initialization fails | Check the RPC URL and configured vault metadata |
| HTTPS fails | Check DNS, ports 80/443, Caddyfile and Caddy logs |

Redact credentials before sharing logs. See [troubleshooting](../docs/troubleshooting.md).

## Verify before onboarding users

### Read-only validation first

This checks mainnet RPC, Pyth prices, vault metadata and unsigned withdrawal
previews. It does not load a keypair or send a transaction.

Host scripts read `/opt/subly/.env`. This is separate from `deploy/.env`
(database password) and `deploy/relayer.production.env` (container settings).

```bash
cd /opt/subly
npm ci
(umask 077; set -o noclobber; : > .env) 2>/dev/null || test -f .env
chmod 600 .env
nano .env
```

Set these in the private host file:

- `SOLANA_RPC_URL` and `SUBLY_HERMES_API_KEY`: same providers as the relayer.
- `SUBLY_VALIDATE_WALLET`: a **public address already holding shares** in the selected vault.
- `SUBLY_VALIDATE_SPONSOR`: a funded public address if that share owner has no SOL.
- For custom vaults: matching vault configuration, with a host path such as
  `SUBLY_VAULTS_FILE=/opt/subly/deploy/vaults.json`.

Do not put a private key in this validation file.

```bash
cd /opt/subly
npm run validate:mainnet
```

Missing shares, oracle errors and failed previews exit nonzero. If no wallet
holds shares yet, the withdrawal check remains incomplete; repeat after an
authorized first deposit. For a disposable test, see
[the fork test](../CONTRIBUTING.md#mainnet-fork-integration-test).

### Authorized real-funds smoke test

The operator and wallet owner must choose the deposit, withdrawal and purchase
amounts before submission. An AI must obtain that authorization separately.
The owner reviews and approves the setup page themselves.

Follow the [client quick start](../packages/pay/README.md#quick-start) with
`SUBLY_RELAYER_URL=https://YOUR_DOMAIN`, then verify:

1. `doctor` passes and owner setup reaches `completed`.
2. The approved deposit confirms; `budget` shows the position.
3. After enough verified yield accrues, an authorized `fetch` completes and
   the seller delivers the response.
4. The separately approved withdrawal confirms.

Check USDC/share changes and stored receipts. For a submitted or timed-out
operation, use `status` with its original ID and the same wallet, vault and
relayer. Do not submit it again.

A new ledger treats existing vault value as principal. Depositing does not
immediately create spendable yield. Retain the ledger and wait for yield;
never lower its baseline to force a payment. See [validation records](../docs/validation.md)
for completed project checks and their limits.

### Optional on-chain maintenance

These scripts **spend sponsor SOL on mainnet**. Skip them during initial setup.
Run only after the operator chooses the operation and budget; an AI needs
explicit authorization. They use the host `.env` and original sponsor key.

Create an additional lookup table only when current withdrawal validation
shows a transaction exceeds Solana's 1232-byte limit:

```bash
cd /opt/subly
SUBLY_SPONSOR_KEYPAIR_PATH="$HOME/.config/subly/sponsor.json" \
  node --env-file=.env --import tsx scripts/create-settlement-lut.ts
```

Each run creates a new table. Record the address; add it to the selected vault's
`extraLookupTables`, or `SUBLY_EXTRA_LOOKUP_TABLES` in both host and relayer
configuration. Preserve existing entries. Restart the relayer and repeat validation:

```bash
cd /opt/subly/deploy
docker compose up -d --wait relayer
cd /opt/subly
npm run validate:mainnet
```

For invest maintenance, first check whether the vault already has a keeper.
This submits transactions per reserve to invest deposited USDC:

```bash
cd /opt/subly
SUBLY_SPONSOR_KEYPAIR_PATH="$HOME/.config/subly/sponsor.json" \
  node --env-file=.env --import tsx scripts/invest-vault.ts
```

Review each reserve's result. A completed script does not mean every reserve
succeeded. For custom vaults, use the same catalogue and selected vault as the relayer.

## Monitoring and backups

### Monitor the sponsor

`GET /v1/admin/monitoring` requires the admin bearer token and reports errors,
latency and sponsor balance. Low balance does not automatically stop service.
Sponsor gas and account rent are operating costs: recorded `feeDebt` reduces
user yield but does not reimburse you.

Use the same operator account. Create private monitoring files and directories:

```bash
(
  set -euo pipefail
  umask 077
  mkdir -p "$HOME/.config/subly" "$HOME/.local/state/subly" "$HOME/.local/share/subly/backups"
  chmod 700 "$HOME/.config/subly" "$HOME/.local/state/subly" "$HOME/.local/share/subly/backups"
  if [ ! -e "$HOME/.config/subly/monitor.env" ]; then
    set -o noclobber
    cat > "$HOME/.config/subly/monitor.env" <<'ENV'
SUBLY_RELAYER_URL='https://YOUR_DOMAIN'
SUBLY_ADMIN_API_TOKEN='replace-in-editor'
SUBLY_ALERT_WEBHOOK_URL='replace-in-editor'
ENV
  fi
  chmod 600 "$HOME/.config/subly/monitor.env"
)
nano "$HOME/.config/subly/monitor.env"
```

Replace the placeholders and retain the single quotes. Test locally; this sends
a webhook alert if a problem is found:

```bash
/bin/bash -c 'set -ae; . "$HOME/.config/subly/monitor.env"; set +a; exec /bin/bash /opt/subly/scripts/check-sponsor-balance.sh'
```

Expect `sponsor balance ok`. Check that the cron service is active. Run
`crontab -e` without sudo and add this as one line, preserving existing jobs:

```cron
*/10 * * * * /bin/bash -c 'set -ae; . "$HOME/.config/subly/monitor.env"; set +a; exec /bin/bash /opt/subly/scripts/check-sponsor-balance.sh' >> "$HOME/.local/state/subly/monitor.log" 2>&1
```

Confirm with `crontab -l` and inspect the log after a scheduled run. Configure
log retention and separate job-failure alerts, including failed webhook delivery.

### Back up the ledger

The principal/yield split **cannot be reconstructed from chain**. Chain re-sync
conservatively resets the basis and forfeits accrued yield. Back it up:

```bash
/bin/bash /opt/subly/scripts/backup-postgres.sh --backup-dir "$HOME/.local/share/subly/backups"
```

The script uses this repository's `deploy/` by default; use `--deploy-dir` for
another installation. It creates a private `.dump` archive, verifies it is
readable, and prints its path. Failed runs publish no archive; existing backups
are not replaced. The backup directory needs regular-file hard-link support.

For hourly backups, add one line to the operator's crontab:

```cron
0 * * * * /bin/bash /opt/subly/scripts/backup-postgres.sh --backup-dir "$HOME/.local/share/subly/backups" >> "$HOME/.local/state/subly/backup.log" 2>&1
```

Monitor failed jobs and backup age. Copy successful archives to encrypted
storage on another host, retain restrictive permissions, and set retention.

### Rehearse a restore

Replace `backup_file` below. This restores into a new, isolated PostgreSQL 16
container, then removes only that container and its anonymous volume:

```bash
(
  set -euo pipefail
  backup_file=/absolute/path/to/subly-backup.dump
  test -f "$backup_file"
  restore_container=''
  trap 'if [ -n "$restore_container" ]; then docker rm -fv "$restore_container" >/dev/null; fi' EXIT
  restore_container=$(docker run -d --network none \
    -e POSTGRES_HOST_AUTH_METHOD=trust \
    postgres:16-alpine@sha256:cf78e76683b9ca8c5733cbbdce6c9262b45b6767934dd0a95e671f9a0fc20685)
  ready=false
  for attempt in $(seq 1 30); do
    if docker exec "$restore_container" pg_isready -U postgres >/dev/null 2>&1; then ready=true; break; fi
    sleep 1
  done
  if [ "$ready" != true ]; then echo 'Restore database did not become ready' >&2; exit 1; fi
  docker exec "$restore_container" createdb -U postgres subly_restore_check
  docker exec -i "$restore_container" pg_restore --exit-on-error --single-transaction \
    --no-owner --no-privileges --username=postgres --dbname=subly_restore_check < "$backup_file"
  docker exec "$restore_container" psql -U postgres -d subly_restore_check -v ON_ERROR_STOP=1 \
    -c "SELECT 'wallet_positions' AS table_name, count(*) FROM wallet_positions
        UNION ALL SELECT 'deposit_intents', count(*) FROM deposit_intents
        UNION ALL SELECT 'withdrawal_intents', count(*) FROM withdrawal_intents
        UNION ALL SELECT 'vault_spending_mandates', count(*) FROM vault_spending_mandates
        UNION ALL SELECT 'payment_approvals', count(*) FROM payment_approvals;"
)
```

Compare principal, fee debt, receipts and approvals with the backup-time state;
row counts alone do not validate accounting. Repeat after backup or PostgreSQL
changes. The automated test is
`SUBLY_TEST_BACKUP_COMPOSE=1 npx vitest run tests/postgres-backup-integration.test.ts`.

For real recovery, stop traffic, preserve the old database and client pending
state, and restore into an **empty recovery database**. Reconcile chain activity
since the backup before resuming. Never merge a dump into the live ledger or
use `--clean` there. Follow the [migration notes](#existing-deployments-and-retiring-vaults)
when restoring an older backup.

For `needs_baseline_reset` after external share movement, use
`POST /v1/wallets/WALLET/sync` with `{"source":"chain"}`.
`POST /v1/admin/settlements/recover` replays stored transaction bytes only.

## Pointing users at your relayer

Give users your HTTPS URL and the [client quick start](../packages/pay/README.md#quick-start).
They set `SUBLY_RELAYER_URL=https://YOUR_DOMAIN` in their CLI or MCP environment.
Buyer requests use wallet signatures; do not give buyers the admin token.

Owner links must be reachable on the user's browser device. `localhost` links
work only on the relayer machine; never advertise them as phone-accessible.

Owner setup comes before the first deposit. Later deposits require approval
under the default policy. Payments need sufficient verified yield for the price,
vault fees and fee headroom. Supported sellers offer Solana USDC `exact` with
facilitator `extra.feePayer` sponsorship.

## Advanced: your own Kamino vault

One relayer can offer multiple mainnet USDC Kamino Earn vaults. Creating your
own vault is optional. Configure custom vaults **before step 5**.

### 1. Generate and review the catalogue

Read the RPC URL privately and replace `DEFAULT_VAULT_ADDRESS` with your
chosen [Kamino Earn vault](https://kamino.com/earn/lend):

```bash
cd /opt/subly
npm ci
read -r -s -p 'Solana RPC URL: ' SOLANA_RPC_URL; printf '\n'
export SOLANA_RPC_URL
npm run --silent configure:vaults -- DEFAULT_VAULT_ADDRESS > vaults.next.json
```

The command reads Kamino's listed-vault API and checks supported USDC vault
accounts on chain. It sends no transactions. Review the result, remove vaults
you do not offer, and keep `defaultVault` in the list.

[`vaults.example.json`](vaults.example.json) is an example; regenerate before
use. The catalogue is a snapshot, without automatic additions or APY selection.
SOL/USDT, Token-2022, other share decimals and Liquidity strategies are unsupported.
Metadata checks do not establish liquidity or successful transactions.

### 2. Install on the relayer and clients

For a new catalogue, install the reviewed file:

```bash
(
  set -euo pipefail
  cd /opt/subly
  test ! -e deploy/vaults.json
  test ! -L deploy/vaults.json
  install -m 0644 vaults.next.json deploy/vaults.json
)
```

For an existing catalogue, merge deliberately; retain vaults with funds or
pending operations. The override mounts the file read-only. For **every**
Compose check, start, restart and upgrade, use both files:

```bash
cd /opt/subly/deploy
docker compose -f docker-compose.yml -f docker-compose.vaults.yml config --quiet
docker compose -f docker-compose.yml -f docker-compose.vaults.yml up -d --build --wait
```

Copy the reviewed catalogue to each client and add to its MCP `env`:

```json
{
  "SUBLY_RELAYER_URL": "https://YOUR_DOMAIN",
  "SUBLY_VAULTS_FILE": "/absolute/path/to/vaults.json"
}
```

Use `@subly_fi/pay@0.8.6` or a compatible newer client. Restart after changes.
The relayer and client independently verify metadata; `GET /v1/vaults` does not
install client trust settings. Client catalogues may be subsets, but selected
vault metadata must match.

### 3. Choose a vault

Use `list_subly_vaults`, then `select_subly_vault(vaultAddress)` in MCP. Selection
lasts until changed or MCP restarts. Create the owner setup link for that vault.
Mandates, approvals, principal, debt and yield are separate per wallet/vault.
Selection neither moves funds nor combines balances. Pending operations keep
their original vault; select an earlier vault again to exit it.

For CLI or maintenance scripts, export `SUBLY_VAULTS_FILE` and optionally
`SUBLY_VAULT_ADDRESS` before startup. The address must be in the catalogue.
Store per-vault lookup tables in `extraLookupTables`; global
`SUBLY_EXTRA_LOOKUP_TABLES` is also supported. Validate each vault's fees and liquidity.

### API selection

| Operation | Vault selection |
| --- | --- |
| Register wallet, signing policy, chain/manual sync, prepare deposit/withdrawal/payment, create setup session | Optional `vault` in JSON body; defaults to relayer default |
| Budget, sync events, mandate, mandate summary, approvals, spending log, recovery revoke | Optional `?vault=ADDRESS` |
| Register mandate | Vault in the owner-signed document |
| Submit/poll/reconcile an intent, report payment | Original vault stored with the intent ID |
| Owner approval, setup completion, revoke/cancel | Vault bound to the stored session or mandate hash |

The owner kill-switch URL is `/revoke/WALLET?vault=ADDRESS`. Unknown vaults
are refused; submission cannot reroute an existing intent to another vault.

### Existing deployments and retiring vaults

Back up Postgres and stop old instances before upgrading. First startup creates
`vault_spending_mandates` and copies legacy mandates into their signed vaults.
New writes do not update the old table. **Do not mix old/new server versions
or roll back the binary alone.** Rollback requires restoring a pre-upgrade
backup into an empty database and reconciling chain activity.

Retain every vault with funds or pending operations. Set `depositsEnabled: false`
to stop new deposits and payment realizations while allowing withdrawals and
existing-operation recovery, subject to owner policy and liquidity. When
regenerating a catalogue, preserve retired entries. Never copy principal or
yield between vaults.

### Single-vault compatibility

Without a catalogue, the legacy Subly vault is the default. To configure one
custom vault, first export `SOLANA_RPC_URL` as above:

```bash
cd /opt/subly
npm run --silent configure:vault -- VAULT_ADDRESS > vault.env
```

Set the generated `SUBLY_VAULT_ADDRESS`, `SUBLY_VAULT_SHARE_MINT`,
`SUBLY_VAULT_USDC_MINT` and `SUBLY_VAULT_FARM` on both relayer and clients.
The no-farm value is `11111111111111111111111111111111`. A catalogue takes
precedence over individual mint/farm variables.

## Updating a running deployment

Retain the database volume, private configuration, sponsor key, vault catalogue
and client pending state. **Do not repeat first-time initialization.**
Stop traffic, then stop the relayer and back up:

```bash
cd /opt/subly/deploy
docker compose stop relayer
/bin/bash /opt/subly/scripts/backup-postgres.sh --backup-dir "$HOME/.local/share/subly/backups"
```

Use both Compose files for custom catalogues. For Git installations, inspect
`git -C /opt/subly status --short` and resolve local modifications before updating:

```bash
cd /opt/subly
git fetch --depth 1 origin tag pay-v0.8.6
git checkout --detach pay-v0.8.6
```

For archive installations, transfer the reviewed tag's archive as in step 2,
then extract as the operator into the existing source directory:

```bash
tar --no-same-owner -xzf /tmp/subly-pay-v0.8.6.tar.gz -C /opt/subly
```

The source archive does not contain host-only configuration or keys. Rebuild:

```bash
cd /opt/subly/deploy
docker compose config --quiet
docker compose build relayer
docker compose up -d --wait relayer
curl --fail https://YOUR_DOMAIN/readyz
printf '%s\n' 'pay-v0.8.6' > /opt/subly/DEPLOYED_VERSION
```

Repeat read-only validation and the authorized smoke test before restoring
traffic. If either fails, preserve the backup and diagnose; do not delete the
database, replace credentials or bypass the migration rollback requirements.
