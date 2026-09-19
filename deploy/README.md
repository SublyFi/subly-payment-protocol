# Running your own Subly relayer (operator guide)

The commands below describe release 0.8.3. Verify its immutable source tag
and npm availability before deploying. For candidate evaluation, use this reviewed source checkout
instead of attempting to clone a tag that does not yet exist. Preserve existing
deployments until the release checks pass.

This `deploy/` directory is a Docker Compose bundle for the Subly relayer —
the buyer-side vault / budget / yield-realize API. Anyone can run one: the
relayer needs no permission from Subly, and nothing in the on-chain
settlement path is exclusive to Subly's own deployment.

The relayer is **not an x402 facilitator**. Facilitators are chosen by
sellers (Nansen uses PayAI, Base sellers use Coinbase CDP, ...). A relayer
operator provides exactly three things:

- **Gas sponsorship** — a sponsor keypair fronts the network fees for every
  deposit / withdraw / yield-realize transaction, when sponsorship is available.
- **The ledger** — a Postgres database tracking each wallet's principal
  basis, accrued yield, and fee debt.
- **The yield-only guard** — the server-side rule that `yield_realize`
  withdrawals never exceed spendable yield, according to the relayer ledger.

The x402 payment transaction itself is fee-paid by the *seller's* facilitator
(`extra.feePayer`), not by your sponsor — budget roughly one sponsored
transaction per payment (the realize), plus deposits and withdrawals.

For a new installation, follow [prerequisites](#prerequisites) →
[get the code](#get-the-code-onto-the-host) → [first-time setup](#first-time-setup) →
[validation](#verify-before-onboarding-users) → [monitoring and backups](#monitoring-and-backups).
Then [connect your users](#pointing-users-at-your-relayer). Existing operators
should start at [updating a running deployment](#updating-a-running-deployment).

## Stack

```text
caddy (443, auto-TLS)
└─ relayer :3000       <- your domain
   └─ postgres          <- ledger (schema auto-creates)
secrets/sponsor.json    <- sponsor key (host only, never baked into the image)
```

## Prerequisites

These commands assume a **dedicated Linux host and a normal operator account
with sudo and Docker access**, using Bash. Keep using that account for source
files, Compose, logs and cron; only the mounted sponsor key is owned by container
UID 1000. For an assisted walkthrough, see the [getting-started guide](../docs/getting-started.md)
and [AI setup prompts](../docs/ai-setup-prompts.md). Never paste key files, API
keys, admin tokens or private environment files into an AI conversation.

- Install [Docker Engine](https://docs.docker.com/engine/install/) and the
  [Compose plugin](https://docs.docker.com/compose/install/linux/) from Docker's
  official instructions for your distribution. On Ubuntu, use the
  [official apt repository procedure](https://docs.docker.com/engine/install/ubuntu/).
  Complete the [Linux post-installation steps](https://docs.docker.com/engine/install/linux-postinstall/)
  so this operator can run Docker without sudo, then log out and back in.
  Docker-group access grants administrative control over the host.
- Install Git, Bash, curl, OpenSSL, Python 3 and a cron service using your
  distribution's package manager. The examples use GNU `install`/`tar` and
  `crontab`; verify those commands are available too.
- Install [Node.js 24 with npm](https://nodejs.org/en/download) on the host or
  your workstation for validation and optional on-chain scripts. The relayer
  itself runs in Docker. The examples below run those scripts on the host.
- Have a domain whose DNS A record points at the host. Open inbound TCP
  **80 and 443** in the host firewall/cloud security group for Caddy HTTPS.
  If the domain has an AAAA record, it must also reach this host; remove stale
  records before trying certificate issuance.
- Obtain a **dedicated Solana mainnet RPC endpoint**. The public RPC is not
  sufficient for the settlement path.
- Obtain a **Pyth Hermes API key** from [Pyth](https://pythdata.app/). Set
  `SUBLY_HERMES_API_KEY` (or `PYTH_API_KEY`) in the server configuration. The
  hosted service requires authentication following the
  [August 2026 Hermes upgrade](https://docs.pyth.network/price-feeds/core/upgrade/preparing).
  The default endpoint is `https://pyth.dourolabs.app/hermes`;
  `SUBLY_HERMES_BASE_URL` supports a compatible operator-selected provider.

Check the local tools before proceeding:

```bash
docker version
docker compose version
node --version                    # v24.x or newer
npm --version
git --version
python3 --version
command -v bash curl openssl install tar crontab
```

### Prepare the sponsor key

The sponsor is a hot wallet that pays gas and account rent. Install the
[Solana CLI](https://solana.com/docs/intro/installation) for `solana-keygen`,
then create a dedicated key on the host under your operator account:

Run this yourself in a private terminal: `solana-keygen` displays the recovery
phrase. Do not run it through an AI tool, screen sharing or a captured terminal
session. Store the recovery phrase and key backup securely before continuing.

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

If you already have a dedicated sponsor key, use that file instead of creating
another. If it was created on your workstation, securely copy it to the host's
`$HOME/.config/subly/sponsor.json` without replacing an existing key. Fund only
the printed **public address** with SOL after deciding your operating budget;
the default low-balance alert threshold is 0.1 SOL. No command in the initial
configuration steps transfers funds. Preserve a secure backup of this key.

> Offering multiple vaults or changing the default? Review
> [Advanced: your own Kamino vault](#advanced-your-own-kamino-vault) before boot.
> Vault metadata must match the clients. Additional lookup tables are optional
> and are only created after validation shows they are needed.

## Get the code onto the host

Use the reviewed `pay-v0.8.3` source tag. **Choose one** of the following
methods. Both install into `/opt/subly`, owned by the operator account, and
stop if that path already exists. For an existing installation use
[Updating a running deployment](#updating-a-running-deployment); do not repeat
first-time initialization or regenerate its database password.

Clone anonymously on the host:

```bash
(
  set -euo pipefail
  if [ -e /opt/subly ] || [ -L /opt/subly ]; then
    echo '/opt/subly already exists; inspect it or use the upgrade procedure.' >&2
    exit 1
  fi
  sudo install -d -o "$(id -u)" -g "$(id -g)" -m 0750 /opt/subly
  git clone --branch pay-v0.8.3 --depth 1 https://github.com/SublyFi/subly-payment-protocol.git /opt/subly
)
```

Alternatively, create an archive **from a local checkout containing that tag**
and transfer it:

```bash
# On your workstation, in the repository:
git archive --format=tar.gz -o /tmp/subly-pay-v0.8.3.tar.gz pay-v0.8.3
scp /tmp/subly-pay-v0.8.3.tar.gz <operator>@<host>:/tmp/
```

Then extract as the operator, not as root:

```bash
(
  set -euo pipefail
  test -f /tmp/subly-pay-v0.8.3.tar.gz
  if [ -e /opt/subly ] || [ -L /opt/subly ]; then
    echo '/opt/subly already exists; inspect it or use the upgrade procedure.' >&2
    exit 1
  fi
  sudo install -d -o "$(id -u)" -g "$(id -g)" -m 0750 /opt/subly
  tar --no-same-owner -xzf /tmp/subly-pay-v0.8.3.tar.gz -C /opt/subly
)
```

If cloning or extraction is interrupted, inspect that incomplete directory
before retrying; these examples deliberately refuse to overwrite it.

## First-time setup

### 1. Create private files without starting services

Run this on the host as the same operator. Change `sponsor_source` if your
existing key is elsewhere. The block refuses to replace any existing
configuration or deployed key; if an earlier run stopped partway through,
inspect the created files and resume configuration instead of overwriting them.

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

The copied key is now readable by the container's UID 1000. Its source remains
in your private operator directory. Keep `deploy/.env` (database password),
`deploy/relayer.production.env` and the sponsor key out of version control.
Never regenerate `POSTGRES_PASSWORD` on an existing PostgreSQL volume: changing
this file does not change the database's stored password. Do not use
`docker compose down -v` to troubleshoot an existing deployment.

### 2. Fill in configuration, then check it

Use a local editor, so credentials do not enter shell history:

```bash
cd /opt/subly/deploy
nano relayer.production.env Caddyfile
```

Use your preferred editor if `nano` is not installed. Before starting:

- Fill `SOLANA_RPC_URL`, `SUBLY_HERMES_API_KEY` and a unique
  `SUBLY_ADMIN_API_TOKEN` in `relayer.production.env`. Generate the admin token
  with a password manager or `openssl rand -hex 24`, then paste it into the
  private file. The admin token is for operators; buyers use wallet signatures.
- Replace `relayer.example.com` in **all three places**: `Caddyfile`,
  `SUBLY_APPROVE_URL_BASE` and `SUBLY_SETUP_URL_BASE`. For example, the bases
  are `https://your-domain/approve/` and `https://your-domain/setup/`.
  These hostnames determine owner passkey origins/rpId as well as the links
  sent to users. Keep explicit WebAuthn overrides unset for this single-host
  deployment. Use a real HTTPS domain you control.
- Keep `SUBLY_MANDATE_ENFORCEMENT=on`. Leave the legacy seller API off.
- Leave `SUBLY_EXTRA_LOOKUP_TABLES` unset unless validation has shown the current
  withdrawal path needs an additional table. It is not a first-boot requirement.
- If serving a custom/multiple-vault catalogue, finish the
  [catalogue installation](#2-install-on-the-relayer-and-clients) and use both
  Compose files for the checks and startup below.

Validate without printing the expanded environment or key:

```bash
cd /opt/subly/deploy
docker compose config --quiet
sudo test -f secrets/sponsor.json
sudo stat -c 'sponsor key owner=%u:%g mode=%a' secrets/sponsor.json   # 1000:1000, 600
docker compose run --rm --no-deps caddy caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile
```

These check file/Compose/Caddy syntax, not RPC credentials, SOL funding,
DNS reachability, or the correctness of your chosen domain. Correct those
values before the next step; a syntax check cannot detect a valid but wrong URL.

### 3. Start the relayer

```bash
cd /opt/subly/deploy
docker compose up -d --build --wait
curl --fail https://<your-domain>/readyz
```

Expected result: Compose reports healthy services and `/readyz` returns
`{"ok":true}`. On a fresh database the schema is created before HTTP startup.
If startup fails, inspect `docker compose ps` and `docker compose logs --tail=100
relayer caddy postgres` locally; redact credentials before sharing diagnostics.

The runtime image is non-root and read-only, installs dependencies with
lifecycle scripts disabled, drains requests on SIGTERM and closes PostgreSQL.
`/healthz` checks liveness; `/readyz` checks the database and initialized schema.
**Healthy does not mean a payment has been tested**: it does not certify live
oracle access, sponsor funding, liquidity, owner approval or seller settlement.
Complete the validation stages below before onboarding users.

## Verify before onboarding users

### Read-only validation first

The validation harness checks mainnet identity, Pyth pricing, pinned vault
metadata, normal/yield-realize transaction output and a delayed client preview.
It **never loads a keypair or sends a transaction**. It runs from the repository
root and loads `/opt/subly/.env`, which is different from both deployment files:
`deploy/.env` holds the database password and `deploy/relayer.production.env`
feeds the container. Neither is automatically loaded by host scripts.

```bash
cd /opt/subly
npm ci
# Create an empty private host-script environment only if none exists:
(umask 077; set -o noclobber; : > .env) 2>/dev/null || test -f .env
chmod 600 .env
nano .env
```

In that private file, set `SOLANA_RPC_URL` and `SUBLY_HERMES_API_KEY` to the
same provider settings you reviewed for the container. Set
`SUBLY_VALIDATE_WALLET` to a **public wallet address already holding shares in
the selected vault**. Set `SUBLY_VALIDATE_SPONSOR` to a funded public address
if that share owner has no SOL. No private key belongs in this validation file.
For a custom vault, include the same catalogue/default-vault configuration,
using a host path such as `SUBLY_VAULTS_FILE=/opt/subly/deploy/vaults.json`
instead of the container's `/run/subly/` path.

```bash
cd /opt/subly
npm run validate:mainnet
```

The harness also accepts `SOLANA_MAINNET_RPC_URL` as a fallback, but runtime
commands use `SOLANA_RPC_URL`. Missing shares, oversize transactions, preview
failures and oracle errors exit nonzero. On a completely fresh vault or test
wallet there may be no shares yet: this is an incomplete withdrawal check,
not a deployment failure. Use a known existing share-holder's public address,
or return to this check after your separately authorized first deposit below.
For a zero-funds end-to-end exercise, use
[the disposable fork test](../CONTRIBUTING.md#mainnet-fork-integration-test).

Passing this harness does not certify owner approval, deposit execution, the
deployed ledger's yield provenance or an external seller. Its success criteria
are the reported RPC/oracle/configuration/withdrawal-preview checks only.

### Optional on-chain maintenance

These commands **sign and send real mainnet transactions using the sponsor**.
Run them only after you, the operator, explicitly choose the operation and its
SOL budget. An AI following this guide must ask before running them; preparing
configuration and running read-only validation do not authorize spending.
They use the host `.env` above and the original operator-owned sponsor key.

**Additional lookup table, only when needed.** The current standard x402 flow
uses separate withdrawal and payment transactions and first uses the vault's
existing lookup table. Only create another table if read-only validation of
your actual current withdrawal transactions shows they exceed Solana's 1232-byte
limit. The retired atomic-settlement diagnostic exceeding that limit is not a
reason to create a table. Skip this step unless that evidence exists.

```bash
cd /opt/subly
SUBLY_SPONSOR_KEYPAIR_PATH="$HOME/.config/subly/sponsor.json" \
  node --env-file=.env --import tsx scripts/create-settlement-lut.ts
```

The sponsor pays rent and owns the table. The script always creates a **new**
table; it does not extend an existing one. Record its address before deciding
whether to run it again. Add the printed address to the appropriate vault's
`extraLookupTables` entry, or to `SUBLY_EXTRA_LOOKUP_TABLES` in both the host
`.env` and `deploy/relayer.production.env`. Preserve existing entries. Then
restart from the **deployment directory** and repeat read-only validation:

```bash
cd /opt/subly/deploy
docker compose up -d --wait relayer
cd /opt/subly
npm run validate:mainnet
```

For a catalogue deployment, use both Compose files for that restart:
`docker compose -f docker-compose.yml -f docker-compose.vaults.yml up -d --wait relayer`.

**Invest crank.** Deposited USDC earns lending yield after it is invested into
the vault's reserves. Check the vault's existing curator/keeper arrangements
before adding your own maintenance. If you choose to run the permissionless
invest operation after significant deposits, it submits transactions per reserve
and spends sponsor SOL:

```bash
cd /opt/subly
SUBLY_SPONSOR_KEYPAIR_PATH="$HOME/.config/subly/sponsor.json" \
  node --env-file=.env --import tsx scripts/invest-vault.ts
```

Review each reserve's reported outcome; a completed script is not evidence that
every reserve was invested. Decide separately whether you need a schedule.
Vault selection for both maintenance scripts is described under
[Advanced: your own Kamino vault](#advanced-your-own-kamino-vault).

### Authorized real-funds smoke test

Before inviting users, the operator and test-wallet owner must explicitly choose
a small real-funds deposit, later withdrawal, and (when enough yield exists) a
paid API request. These are separate from read-only validation. An AI must get
that authorization before submitting any of them. The owner approval page
must show your domain and the agreed policy/amount; never approve on someone's
behalf. The wallet needs USDC; see the [client wallet instructions](../packages/pay/README.md#quick-start).

After authorization, the illustrative sequence is:

```bash
export SUBLY_RELAYER_URL=https://<your-domain>
export SUBLY_DEMO_AGENT_KEYPAIR_PATH=/absolute/path/to/test-agent.json
# Read the client RPC credential without putting it in shell history:
read -r -s -p 'Client Solana RPC URL: ' SOLANA_RPC_URL; printf '\n'
export SOLANA_RPC_URL
npx -y @subly_fi/pay@0.8.3 doctor && \
npx -y @subly_fi/pay@0.8.3 setup-link --initial-deposit 1010000
```

Stop here. The owner opens the returned `setupUrl`, reviews the domain, policy
and initial deposit, and approves. Then replace `st_SESSION_ID` below with the
returned setup session ID (or pass the complete setup URL):

```bash
npx -y @subly_fi/pay@0.8.3 setup-status st_SESSION_ID
```

Continue only when setup status is `completed` and the agreed initial deposit
is approved. This next command sends the deposit:

```bash
npx -y @subly_fi/pay@0.8.3 deposit 1010000
```

After the deposit is confirmed, check the budget and let yield accrue:

```bash
npx -y @subly_fi/pay@0.8.3 budget
```

Only when sufficient verified yield exists and the specific purchase is
authorized, run the paid request in a separate step:

```bash
npx -y @subly_fi/pay@0.8.3 fetch <compatible-x402-url>
```

Verify that request's outcome before continuing. At the separately agreed time,
test the withdrawal; if it requests owner approval, complete that approval and
retry the original command with its approval ID:

```bash
npx -y @subly_fi/pay@0.8.3 withdraw 1000000
```

The example deposit minimum depends on the selected vault. Check confirmed
USDC/share changes and stored receipts. For a submitted/timeout result, retain
the original ID and run `npx -y @subly_fi/pay@0.8.3 status <dep_or_wdr_id>` with
the same wallet, vault and relayer; do not submit the same operation again.

The payment needs verified yield for the price, vault fees and fee headroom.
A fresh ledger conservatively treats existing vault value as principal, so
funding a wallet or depositing does not immediately create spendable yield.
Keep the ledger between runs, check the budget, and allow yield to accrue; do
not lower the baseline to force a payment. Do not call the complete payment
flow successful until the original realization and the seller's delivery and
settlement have been checked. See [validation status](../docs/validation.md)
for the project's completed checks and their limits.

## Monitoring and backups

`GET /v1/admin/monitoring` (admin bearer token) returns error counters,
settlement latency percentiles and sponsor balance against
`SUBLY_MIN_SPONSOR_BALANCE_LAMPORTS`. Nothing halts automatically when the
sponsor runs low. Plan SOL replenishment; recorded fee debt does not reimburse
the operator.

### Install sponsor monitoring under the operator account

Use the same normal account that runs Compose. Verify `python3`, `curl`, Docker
access and an enabled cron service on the host. For example, on Debian/Ubuntu
check `systemctl is-active cron`; other distributions may name it `crond`.
Create private, operator-writable configuration, logs and backup directories:

```bash
(
  set -euo pipefail
  umask 077
  mkdir -p "$HOME/.config/subly" "$HOME/.local/state/subly" "$HOME/.local/share/subly/backups"
  chmod 700 "$HOME/.config/subly" "$HOME/.local/state/subly" "$HOME/.local/share/subly/backups"
  if [ ! -e "$HOME/.config/subly/monitor.env" ]; then
    set -o noclobber
    cat > "$HOME/.config/subly/monitor.env" <<'ENV'
SUBLY_RELAYER_URL='https://your-domain'
SUBLY_ADMIN_API_TOKEN='replace-in-editor'
SUBLY_ALERT_WEBHOOK_URL='replace-in-editor'
ENV
  fi
  chmod 600 "$HOME/.config/subly/monitor.env"
)
nano "$HOME/.config/subly/monitor.env"
```

Replace the placeholders in that private file with your relayer URL, existing
admin token and your alert webhook. It is a shell environment file: retain the
single quotes around literal values. Do not put credentials in a crontab, a
command-line assignment, or a pasted support transcript. Existing files and
backups are retained by these steps.

Test once locally (this sends an alert to the configured webhook if a problem
is found):

```bash
/bin/bash -c 'set -ae; . "$HOME/.config/subly/monitor.env"; set +a; exec /bin/bash /opt/subly/scripts/check-sponsor-balance.sh'
```

Expect `sponsor balance ok`, or investigate the reported alert before
scheduling. Run `crontab -e` **without sudo**, preserve existing jobs, and add
this as **one physical line**:

```cron
*/10 * * * * /bin/bash -c 'set -ae; . "$HOME/.config/subly/monitor.env"; set +a; exec /bin/bash /opt/subly/scripts/check-sponsor-balance.sh' >> "$HOME/.local/state/subly/monitor.log" 2>&1
```

Use `crontab -l` to confirm the entry, then inspect the private log after a
scheduled run. A failed webhook delivery is logged; configure cron/job-failure
alerting independently so you are not relying on a single notification path.
Set log rotation/retention for these files as part of host operations.

### Back up the ledger

The ledger holds each wallet's principal basis — the line between principal
and spendable yield — and that split is **not reconstructible from chain**.
A chain re-sync conservatively resets the basis, forfeiting accrued yield.
The private backup directory above is outside the source checkout and writable
by the operator. Run:

```bash
/bin/bash /opt/subly/scripts/backup-postgres.sh --backup-dir "$HOME/.local/share/subly/backups"
```

The script uses the repository's `deploy/` directory by default; pass
`--deploy-dir /absolute/path/deploy` for another installation. It uses the
deployment's Compose settings, including `COMPOSE_PROJECT_NAME` when set.
It reads the `subly` database and never restores or modifies it. The same
PostgreSQL container supplies `pg_dump` and `pg_restore`, avoiding client/server
version mismatches. No password needs to appear in the command or crontab.

Archives use PostgreSQL's compressed custom format (`.dump`), not `.sql.gz`.
New directories are private (mode 700), archives are mode 600, and existing
directory permissions are left unchanged. Use a dedicated private directory on
a filesystem with regular-file hard-link support. A partial dump is hidden in
that directory; only a successful dump and a complete archive read publish a
final name. Failures exit nonzero and remove the partial file. Existing backups
are never overwritten. Standard output contains the completed archive's path.
Archive readability does not replace a restore rehearsal.

For hourly execution, use the same operator's `crontab -e` and add this as
**one physical line**, preserving the monitoring entry and existing jobs. Configure the
scheduler to report failures and monitor the age of the latest successful
backup; writing a cron entry alone does not provide alerting:

```cron
0 * * * * /bin/bash /opt/subly/scripts/backup-postgres.sh --backup-dir "$HOME/.local/share/subly/backups" >> "$HOME/.local/state/subly/backup.log" 2>&1
```

Copy successful archives to a separate host or encrypted backup storage and
set retention for your recovery requirements. A local file on the relayer host
does not protect against losing that host. Archives contain private ledger and
owner data; retain restrictive access permissions when transferring them.

### Rehearse a restore without touching the running ledger

Run this Bash block on a Docker host, replacing `backup_file` with the absolute
path of a completed archive. It restores into a **new disposable container**
with no network access or published ports. The trap removes only that created
container and its anonymous volume, including when restoration fails. Use a
PostgreSQL image matching the version that created the archive (16 in this
deployment):

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

Successful restoration and expected rows establish that this archive can be
read back. Compare representative principal, fee debt, receipt and approval
records with the expected backup-time state; row counts alone do not validate
financial accounting. Repeat the rehearsal after changing PostgreSQL or the
backup process. The automated disposable PostgreSQL test is available with
`SUBLY_TEST_BACKUP_COMPOSE=1 npx vitest run tests/postgres-backup-integration.test.ts`.

For a real recovery, stop relayer traffic first and restore into a deliberately
created **empty recovery database**. Preserve the old database and pending
client state. Reconcile chain activity since the backup before directing the
relayer to the recovered database and resuming traffic. Never use `--clean` or
merge a dump into an operating ledger. The [upgrade notes](#updating-a-running-deployment)
also apply when restoring a pre-migration backup.

Routine recovery: if a wallet's position flips to `needs_baseline_reset`
(external share movement), re-sync it with
`POST /v1/wallets/<wallet>/sync` body `{"source":"chain"}` (or
`scripts/onboard-agent.sh`). `POST /v1/admin/settlements/recover` only
replays stored transaction bytes — it never builds new transactions.
Wallet flows are serialized by per-wallet Postgres advisory locks, so
multiple relayer instances sharing one Postgres won't corrupt the ledger —
but monitoring counters are in-process (each instance reports only its own
traffic), so a single instance keeps operations simple.

## Pointing users at your relayer

Your users run the standard published client — they just override the
relayer URL:

```bash
SUBLY_RELAYER_URL=https://<your-domain> npx -y @subly_fi/pay@0.8.3 fetch <url>
# or put SUBLY_RELAYER_URL in the MCP server's env block
```

No API token — buyer requests are wallet-signature authenticated. With
`SUBLY_MANDATE_ENFORCEMENT=on` (recommended above), a user's **first action
is the owner setup link** (`npx -y @subly_fi/pay@0.8.3 setup-link
--initial-deposit 1010000`, or the `create_subly_setup_link` MCP tool): the
owner signs the spending mandate and pre-approves the first deposit with one
passkey approval. Replacing an existing mandate requires a separate deposit
approval. A bare first deposit is refused with `mandate_required_for_deposit`,
and later deposits also require owner approval under the default policy.

Things worth telling your users up front: the minimum deposit depends on the vault (the example uses `1010000` raw), each payment needs
price plus the selected vault's fees and relayer headroom,
they need fee sponsorship from both the relayer and seller facilitator, and only x402 sellers offering a Solana USDC `exact`
rail with facilitator `extra.feePayer` support are payable.

## Operator economics (honest)

Your sponsor pays gas for every vault flow: ~10,000 lamports per flow at
default compute pricing (two 5,000-lamport signature fees — agent + sponsor
— plus a ~1-lamport priority fee). It also fronts one-time token-account
rent (~0.002 SOL per associated token account created on a wallet's first
deposit/withdraw), which is never charged back. The ledger records each
landed transaction fee as `feeDebt` against the user's position (converted
SOL→USDC at the Pyth oracle), which **reduces the user's spendable yield —
but no USDC ever flows back to you**. There is no fee-collection mechanism
in the code today: fee debt is an accounting offset, not revenue, and a user
who exits takes the offset value with them. Run the numbers accordingly —
sponsored gas is currently an operating cost, and any revenue model (e.g. a
performance fee on realized yield) is yours to implement.

## Advanced: your own Kamino vault

One relayer can serve **multiple mainnet USDC Kamino Earn vaults**. Operators
configure a local catalogue; users choose a vault in MCP for setup, deposits,
budget reads, withdrawals, and API payments. You can use existing public vaults
managed by other curators. Creating or owning a vault is not required.

### 1. Generate and review the USDC catalogue

From the repository root, with `npm ci` completed:

```bash
SOLANA_RPC_URL=<rpc> npm run --silent configure:vaults -- <default-vault-address> > vaults.next.json
```

Choose the default address from [Kamino Earn / Lend](https://kamino.com/earn/lend).
The command uses Kamino's [official listed-vault API](https://kamino.com/docs/build/api-reference/earn/vault-data/vaults-list)
(`type=live`), filters mainnet USDC, then fetches each account from chain to verify
the Kamino program/discriminator, SPL Token program, and 6 decimal token/share
units. It reads metadata only and requires no wallet or transaction.

Review the generated file and remove vaults you do not intend to offer. The
`defaultVault` must remain in the list. The file is a snapshot: nothing
silently adds future vaults or changes a user's selection. Names come from
on-chain metadata and can differ from the website. APY is not stored or used
for automatic selection.

[`vaults.example.json`](vaults.example.json) is a public metadata example,
verified on 2026-09-16 (11 USDC entries); its default is an example, not a vault
recommendation. Regenerate and verify before using it. Configuration checks
are not deposit/withdrawal execution tests or a measure of curator risk.
SOL/USDT, Token-2022 vaults, other share decimals, and Kamino Liquidity strategies
are outside this integration.

### 2. Install on the relayer and clients

After review, install the file as `deploy/vaults.json`. For Docker Compose:

```bash
cd deploy
docker compose -f docker-compose.yml -f docker-compose.vaults.yml up -d --build
```

The override mounts the file read-only and sets `SUBLY_VAULTS_FILE` inside the
container. Use **both Compose files** for subsequent updates as well. For a
process running directly, set `SUBLY_VAULTS_FILE=/absolute/path/to/vaults.json`.
The mainnet relayer validates every configured vault against chain at startup
and again when refreshing its state. Detached development mode serves only
the default vault and has no on-chain flows.

Copy the reviewed catalogue to each MCP/CLI machine and add these to the MCP
server's `env` block alongside its wallet credentials:

```json
{
  "SUBLY_RELAYER_URL": "https://your-relayer.example.com",
  "SUBLY_VAULTS_FILE": "/absolute/path/to/vaults.json"
}
```

Both processes need configuration. The relayer uses it to build transactions;
the client uses its own copy to validate exactly which vault/share mint/farm
it signs for. `GET /v1/vaults` advertises relayer support; it does not install
or replace the signer's local trust anchors. Client catalogues can be a subset,
but metadata must match for every selected vault. Restart processes after
changing files. Use `@subly_fi/pay@0.8.3` or a newer compatible client on every machine.

### 3. Let the user choose

MCP now exposes:

- `list_subly_vaults`: show the local candidates and current selection.
- `select_subly_vault(vaultAddress)`: check matching relayer support and choose
  the vault for subsequent tools. Selection lasts until changed or MCP restarts.
- Existing setup, deposit, budget, withdrawal and payment tools use that selection.
  In-flight operations retain their original vault. Payment deduplication and
  unknown-outcome protection remain shared across all selections.

The user chooses the vault, then creates an owner setup link for that vault.
Mandates, spending limits, approvals, principal basis, fee debt and yield are
separate per `(wallet, vault)`. Revoking one vault's mandate affects that vault.
Selecting another vault does not transfer funds or combine yield balances.
To exit an earlier vault, select it again. The client does not switch based on
APY, and selection alone does not deposit funds.

For one-shot CLI/scripts, `SUBLY_VAULT_ADDRESS=<listed-address>` overrides the
catalogue's default before process startup; it must name a catalogue entry.
The file supplies the matching share mint and farm. `create-settlement-lut.ts`
and `invest-vault.ts` use the same selection: export `SUBLY_VAULTS_FILE` and
`SUBLY_VAULT_ADDRESS` in the shell. Lookup tables can differ per vault; store
additional addresses in that entry's `extraLookupTables` array. The global
`SUBLY_EXTRA_LOOKUP_TABLES` remains supported. Vault limits, withdrawal fees,
reserve routes and available liquidity vary and require per-vault validation.

### API selection

| Operation | Vault selection |
| --- | --- |
| Register wallet, signing policy, chain/manual sync, prepare deposit/withdrawal/payment, create setup session | Optional `vault` in the JSON body; defaults to the relayer's configured default |
| Budget, sync events, mandate, mandate summary, approvals, spending log, recovery revoke | Optional `?vault=<address>` query |
| Register mandate | The vault inside the owner-signed document |
| Submit/poll/reconcile an intent, report a payment | The original vault stored with the intent ID |
| Owner approval, setup completion, revoke/cancel | The vault bound to the stored session or mandate hash |

The owner kill-switch URL is `/revoke/<wallet>?vault=<address>`. Unknown vaults
are refused. A caller cannot reroute a prepared transaction by passing another
vault at submission.

### Existing deployments and retiring vaults

Back up Postgres and stop old relayer instances before upgrading. On first
connection this version creates `vault_spending_mandates` with a compound
wallet/vault key and copies legacy `spending_mandates` records into their signed
vaults. The legacy table is retained; later starts do not overwrite migrated
records. New writes go to the new table. Do not mix old/new server versions or
roll back without a data migration: the old table is no longer kept current.
Other position and intent records already carry their vault and stay in place.

Keep every vault with existing funds or pending operations in the catalogue.
To stop new deposits and new payment realizations, set `depositsEnabled: false`
on that entry. Normal withdrawals, status checks and submission/reconciliation
of already prepared operations remain available, subject to the owner's
mandate and chain liquidity. Regenerating the official list can omit older
vaults: merge these retired entries into the new file instead of overwriting
an operating catalogue. Never copy principal basis or yield between vaults.

### Single-vault compatibility

Without `SUBLY_VAULTS_FILE`, the legacy Subly vault remains the default. A
single custom vault still works with:

```bash
SOLANA_RPC_URL=<rpc> npm run --silent configure:vault -- <vault-address> > vault.env
```

Set the generated `SUBLY_VAULT_ADDRESS`, `SUBLY_VAULT_SHARE_MINT`,
`SUBLY_VAULT_USDC_MINT`, and `SUBLY_VAULT_FARM` on relayer and clients. A custom
address requires an explicit share mint and farm; the no-farm value is
`11111111111111111111111111111111`. When a catalogue is configured its metadata
takes precedence over those individual mint/farm variables.

## Updating a running deployment

Stop traffic and take a tested database backup before upgrading. Do not mix old/new relayer versions across the vault-mandate migration. A binary rollback alone is unsafe after new writes: restore the pre-upgrade database into an empty database, reconcile chain activity, then resume. Preserve client pending-state JSON across upgrades.


For multi-vault deployments, include `-f docker-compose.yml -f docker-compose.vaults.yml`
in the Compose commands below.

Use the same operator account and retain the existing database volume,
`deploy/.env`, `deploy/relayer.production.env`, `deploy/Caddyfile`, sponsor key,
and vault catalogue. **Do not rerun the first-time file-creation blocks.** Stop
relayer traffic and create a fresh backup before replacing the source:

```bash
cd /opt/subly/deploy
docker compose stop relayer
/bin/bash /opt/subly/scripts/backup-postgres.sh --backup-dir "$HOME/.local/share/subly/backups"
```

For a Git installation, first inspect `git -C /opt/subly status --short` and
resolve any local source modifications deliberately. Fetch the reviewed target
tag and check it out without a forced reset:

```bash
cd /opt/subly
git fetch --depth 1 origin tag pay-v0.8.3
git checkout --detach pay-v0.8.3
```

For an archive installation, create and transfer the reviewed tag's archive
using the workstation commands above. After the backup, extract it as the
operator into the existing source directory (do not repeat the new-directory
check or use sudo for extraction):

```bash
tar --no-same-owner -xzf /tmp/subly-pay-v0.8.3.tar.gz -C /opt/subly
```

A `git archive` from the reviewed source tag contains no host-only environment
files or sponsor key, so this source update preserves them. It does not migrate
or replace a PostgreSQL volume. Recheck configuration, then rebuild and verify:

```bash
cd /opt/subly/deploy
docker compose config --quiet
docker compose build relayer
docker compose up -d --wait --remove-orphans relayer
curl --fail https://<your-domain>/readyz
printf '%s\n' 'pay-v0.8.3' > /opt/subly/DEPLOYED_VERSION
```

Readiness still only checks the ledger/schema. Repeat the relevant read-only
validation and your approved smoke-test plan before restoring user traffic.
If startup or validation fails, retain the backup and diagnose locally; do not
replace credentials, delete volumes, or force a binary rollback across a schema
migration to make the health check green.

## Legacy

The retired seller-side `subly-yield-exact` endpoints
(`/v1/x402/supported|verify|settle`) stay disabled unless the relayer env
sets `SUBLY_ENABLE_LEGACY_X402=1` plus `SUBLY_SELLER_API_TOKEN`. Leave them
off.
