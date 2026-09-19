# Running your own Subly relayer (operator guide)

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

## Stack

```text
caddy (443, auto-TLS)
└─ relayer :3000       <- your domain
   └─ postgres          <- ledger (schema auto-creates)
secrets/sponsor.json    <- sponsor key (host only, never baked into the image)
```

## Prerequisites

- A host with Docker Compose and a domain whose DNS A record points at it.
  Inbound TCP **80 and 443** must be open in the host firewall / cloud
  security group — Caddy provisions TLS automatically and needs port 80 for
  certificate issuance.
- Node.js 24+ with npm, on the server or your workstation, for the
  one-time on-chain setup scripts below (the relayer itself runs in Docker).
- A **dedicated / paid Solana RPC endpoint** — the public RPC is not
  sufficient for the settlement path.
- A **Pyth Hermes API key** for live SOL/USDC fee pricing. Set `SUBLY_HERMES_API_KEY`
  (or `PYTH_API_KEY`) in the relayer environment. Since the
  [August 2026 Hermes upgrade](https://docs.pyth.network/price-feeds/core/upgrade/preparing),
  the hosted service requires authentication. The default endpoint is
  `https://pyth.dourolabs.app/hermes`; `SUBLY_HERMES_BASE_URL` supports a compatible
  operator-selected provider. Keep this credential on the server, out of client
  configuration and URLs.
- A **sponsor wallet**: create it and fund it with SOL (size its balance for expected gas and rent; the default alert threshold is 0.1 SOL):

  ```bash
  solana-keygen new --no-bip39-passphrase -o sponsor.json
  # fund the printed address with SOL
  ```

  The sponsor is a hot wallet — the server signs with it. Keep only working
  capital on it, never large funds.

> Planning to offer **multiple USDC Kamino vaults** or change the default? Read [Advanced: your own Kamino vault](#advanced-your-own-kamino-vault)
> *before* the one-time on-chain setup — the settlement lookup table is
> vault-specific.

## Get the code onto the host

Use the reviewed `pay-v0.8.0` source tag. You can clone anonymously:

```bash
git clone --branch pay-v0.8.0 --depth 1 https://github.com/SublyFi/subly-payment-protocol.git
```

Alternatively ship a tarball from that tag. Everything below assumes the repo lives at `/opt/subly`:

```bash
# locally
git archive --format=tar.gz -o /tmp/subly.tar.gz pay-v0.8.0
scp /tmp/subly.tar.gz <user>@<host>:/tmp/
# on the server
sudo mkdir -p /opt/subly && sudo tar xzf /tmp/subly.tar.gz -C /opt/subly
```

## First-time setup

On the server:

```bash
cd /opt/subly/deploy
cp relayer.production.env.example relayer.production.env   # fill in (see notes below)
cp Caddyfile.example Caddyfile                              # set your domain
mkdir -p secrets                                            # copy sponsor key to secrets/sponsor.json
# The relayer runs as UID 1000. Allow that user to read only this key:
sudo chown 1000:1000 secrets/sponsor.json
sudo chmod 600 secrets/sponsor.json
echo "POSTGRES_PASSWORD=$(openssl rand -hex 24)" > .env
chmod 600 .env relayer.production.env
docker compose config --quiet
docker compose up -d --build --wait
curl --fail https://<your-domain>/readyz                       # {"ok":true}
```

The runtime image is non-root, read-only, and installs production dependencies with lifecycle scripts disabled. It drains requests on SIGTERM and closes PostgreSQL. `/healthz` checks liveness; `/readyz` checks the database and initialized schema. Neither guarantees RPC liquidity or sponsor funding.

On a fresh database, the schema auto-creates before HTTP startup. For an
existing deployment, read the migration notes under [vault configuration](#existing-deployments-and-retiring-vaults). Notes on `relayer.production.env`:

- **`SUBLY_APPROVE_URL_BASE` / `SUBLY_SETUP_URL_BASE` must point at your own
  domain.** The relayer itself serves the owner pages (`/setup/:id`,
  `/approve/:id`, `/revoke/:wallet`) on any domain, but these bases build the
  links agents hand to owners *and* derive the WebAuthn rpId/origins — leave
  them at someone else's domain and owner passkeys will fail verification.
- **`SUBLY_MANDATE_ENFORCEMENT=on` is the right setting for a new
  deployment.** It is also the secure default in the current source; `warn`
  is an explicit staged-rollout compromise for pre-existing clients.
- `SUBLY_EXTRA_LOOKUP_TABLES` stays unset for the first boot — you create
  the table in the next section, then set it and restart.
- `SUBLY_ADMIN_API_TOKEN` is for you, the operator. Your users never need a
  token — buyer requests are authenticated by wallet signature.

## One-time on-chain setup

Both scripts run **from the repo root** on a machine with Node 24+ after
`npm ci` — either the server or your workstation. They read the sponsor key
from `SUBLY_SPONSOR_KEYPAIR_PATH` (file) or `SUBLY_SPONSOR_KEYPAIR` (base58
secret), so from a workstation you need one of the two available locally.
Note: scripts read only process environment variables —
`relayer.production.env` feeds the container, not these scripts.

**Additional lookup table, when needed.** The current standard x402 flow
uses separate withdrawal and payment transactions. It first uses the vault's
existing lookup table. Run the read-only validation below before creating
another table: only create one if your actual transactions exceed Solana's
1232-byte limit. The retired atomic settlement diagnostic can exceed this
limit even when current withdrawals fit; that alone is not a reason to spend
SOL creating a table.

```bash
cd /opt/subly && npm ci
SOLANA_RPC_URL=<rpc> SUBLY_SPONSOR_KEYPAIR_PATH=<sponsor.json> \
  npx tsx scripts/create-settlement-lut.ts
# set the printed address as SUBLY_EXTRA_LOOKUP_TABLES in
# relayer.production.env, then: docker compose up -d relayer
```

The sponsor pays the table's rent and owns it. The script always creates a
*new* table (there is no in-place extend) — if you later re-run it to include
new agent wallets' share accounts, append the new address to the
comma-separated `SUBLY_EXTRA_LOOKUP_TABLES` list.

**Invest crank.** Deposited USDC only earns yield once it is invested into
the vault's lending reserves. The Kamino vault program's ("kvault") `invest`
instruction is permissionless — run it after significant deposits (or on a
schedule):

```bash
SOLANA_RPC_URL=<rpc> SUBLY_SPONSOR_KEYPAIR_PATH=<sponsor.json> \
  npx tsx scripts/invest-vault.ts
```

Uninvested funds sit idle and drag the vault's effective APY down — cheap
insurance for your users' yield pace.

## Verify before onboarding users

Run the read-only validation harness for the current withdrawal path. It
checks mainnet identity, Pyth pricing, pinned vault metadata, normal and
yield-realize transaction output and a delayed client preview. It loads
`.env` automatically and also accepts `SOLANA_MAINNET_RPC_URL` as a fallback
for `SOLANA_RPC_URL` (other runtime commands still use `SOLANA_RPC_URL`):

```bash
SUBLY_VALIDATE_WALLET=<public wallet holding vault shares> npm run validate:mainnet
```

Keep RPC and Pyth credentials in the local secret environment or ignored `.env`,
not command history. Set `SUBLY_VALIDATE_SPONSOR` to a funded public address if
the selected share owner has no SOL. The command never loads a keypair or sends
a transaction; missing shares, oversize transactions, preview failures and
oracle errors exit nonzero. Passing does not certify owner approval, deposit
execution, the deployed ledger's yield provenance or an external seller.
Use [the disposable fork test](../CONTRIBUTING.md#mainnet-fork-integration-test)
to exercise the full local HTTP/client/transaction pipeline without real funds.

Then do one end-to-end **real-funds smoke test** against your live relayer with your own
wallet before inviting anyone else (the test wallet needs a little USDC; see
the client README's "Wallet" section for keypair options):

```bash
export SUBLY_RELAYER_URL=https://<your-domain>
export SUBLY_DEMO_AGENT_KEYPAIR_PATH=<test wallet keypair.json>
npx -y @subly_fi/pay@0.8.0 setup-link --initial-deposit 1010000   # owner signs on your domain
npx -y @subly_fi/pay@0.8.0 deposit 1010000
# ...once yield has accrued: npx -y @subly_fi/pay@0.8.0 fetch <x402 url>
npx -y @subly_fi/pay@0.8.0 withdraw 1000000
```

The payment step needs enough verified yield for the price, vault charges and
fee headroom. A new ledger treats pre-existing vault value conservatively as
principal, so a funded vault does not necessarily have a spendable budget.
Keep the ledger between runs and allow yield to accrue. Check confirmed
USDC/share changes and stored receipts before declaring the test successful;
do not lower the baseline to bypass an insufficient-yield result. See
[validation status](../docs/validation.md) for the checks already completed
and their limits.

## Monitoring and backups

`GET /v1/admin/monitoring` (admin bearer token) returns error counters,
settlement latency percentiles, and the sponsor balance vs.
`SUBLY_MIN_SPONSOR_BALANCE_LAMPORTS`. Nothing halts automatically when the
sponsor runs low — flows simply start failing once it is empty — so run the
alert cron (needs `python3` on the host):

```bash
*/10 * * * * cd /opt/subly && SUBLY_RELAYER_URL=https://<your-domain> \
  SUBLY_ADMIN_API_TOKEN=<token> SUBLY_ALERT_WEBHOOK_URL=<webhook> \
  bash scripts/check-sponsor-balance.sh >> /var/log/subly-monitor.log 2>&1
```

**Back up Postgres.** The ledger holds each wallet's principal basis — the
line between "principal" and "spendable yield" — and that split is **not
reconstructible from chain** (a chain re-sync conservatively resets the
basis, forfeiting users' accrued yield). Run the backup as a host user with
Docker access and a private, writable backup directory:

```bash
/bin/bash /opt/subly/scripts/backup-postgres.sh --backup-dir /backups/subly
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

For hourly execution, install this as **one crontab line**. Configure the
scheduler to report failures and monitor the age of the latest successful
backup; writing a cron entry alone does not provide alerting:

```cron
0 * * * * /bin/bash /opt/subly/scripts/backup-postgres.sh --backup-dir /backups/subly >> /var/log/subly-backup.log 2>&1
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
SUBLY_RELAYER_URL=https://<your-domain> npx -y @subly_fi/pay@0.8.0 fetch <url>
# or put SUBLY_RELAYER_URL in the MCP server's env block
```

No API token — buyer requests are wallet-signature authenticated. With
`SUBLY_MANDATE_ENFORCEMENT=on` (recommended above), a user's **first action
is the owner setup link** (`npx -y @subly_fi/pay@0.8.0 setup-link
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
changing files. Use `@subly_fi/pay@0.8.0` or a newer compatible client on every machine.

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

Ship a fresh tarball exactly as in
[Get the code onto the host](#get-the-code-onto-the-host), then rebuild:

```bash
# on the server
echo <commit> | sudo tee /opt/subly/DEPLOYED_COMMIT
cd /opt/subly/deploy
docker compose build relayer && docker compose up -d --remove-orphans relayer
curl -s https://<domain>/healthz   # {"ok":true}
```

Host-only files (`relayer.production.env`, `.env`, `Caddyfile`, `secrets/`)
are untracked, so the untar never overwrites them.

## Legacy

The retired seller-side `subly-yield-exact` endpoints
(`/v1/x402/supported|verify|settle`) stay disabled unless the relayer env
sets `SUBLY_ENABLE_LEGACY_X402=1` plus `SUBLY_SELLER_API_TOKEN`. Leave them
off.
