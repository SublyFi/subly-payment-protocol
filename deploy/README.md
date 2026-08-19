# Running your own Subly relayer (operator guide)

This `deploy/` directory is a Docker Compose bundle for the Subly relayer —
the buyer-side vault / budget / yield-realize API. Anyone can run one: the
relayer needs no permission from Subly, and nothing in the on-chain
settlement path is exclusive to Subly's own deployment.

The relayer is **not an x402 facilitator**. Facilitators are chosen by
sellers (Nansen uses PayAI, Base sellers use Coinbase CDP, ...). A relayer
operator provides exactly three things:

- **Gas sponsorship** — a sponsor keypair fronts the network fees for every
  deposit / withdraw / yield-realize transaction, so end users never need SOL.
- **The ledger** — a Postgres database tracking each wallet's principal
  basis, accrued yield, and fee debt.
- **The yield-only guard** — the server-side rule that `yield_realize`
  withdrawals never exceed spendable yield, so payments never spend principal.

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
- Node.js >= 20 with npm, on the server or your workstation, for the
  one-time on-chain setup scripts below (the relayer itself runs in Docker).
- A **dedicated / paid Solana RPC endpoint** — the public RPC is not
  sufficient for the settlement path.
- A **sponsor wallet**: create it and fund it with SOL (~0.5 SOL is a
  comfortable start; the default alert threshold is 0.1 SOL):

  ```bash
  solana-keygen new --no-bip39-passphrase -o sponsor.json
  # fund the printed address with SOL
  ```

  The sponsor is a hot wallet — the server signs with it. Keep only working
  capital on it, never large funds.

> Planning to run your **own Kamino vault** instead of the default public
> one? Read [Advanced: your own Kamino vault](#advanced-your-own-kamino-vault)
> *before* the one-time on-chain setup — the settlement lookup table is
> vault-specific.

## Get the code onto the host

No git credentials belong on the server — ship a tarball (or `git clone` if
you prefer). Everything below assumes the repo lives at `/opt/subly`:

```bash
# locally
git archive --format=tar.gz -o /tmp/subly.tar.gz HEAD
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
mkdir -p secrets                                            # sponsor key -> secrets/sponsor.json
echo "POSTGRES_PASSWORD=$(openssl rand -hex 24)" > .env
docker compose up -d --build
curl -s https://<your-domain>/healthz                       # {"ok":true}
```

There is no migration step — the Postgres schema auto-creates on first
connection. Notes on `relayer.production.env`:

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

Both scripts run **from the repo root** on a machine with Node >= 20 after
`npm ci` — either the server or your workstation. They read the sponsor key
from `SUBLY_SPONSOR_KEYPAIR_PATH` (file) or `SUBLY_SPONSOR_KEYPAIR` (base58
secret), so from a workstation you need one of the two available locally.
Note: scripts read only process environment variables —
`relayer.production.env` feeds the container, not these scripts.

**Settlement lookup table.** Vault transactions can exceed Solana's
1232-byte limit (farm-staked withdrawals measured 1326 bytes) unless the
accounts are in an address lookup table:

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

Run the read-only validation harness (simulates the full settlement path,
including your lookup table; moves no funds):

```bash
SOLANA_RPC_URL=<rpc> SUBLY_EXTRA_LOOKUP_TABLES=<your LUT> npm run validate:mainnet
```

Then do one end-to-end dry run against your live relayer with your own
wallet before inviting anyone else (the test wallet needs a little USDC; see
the client README's "Wallet" section for keypair options):

```bash
export SUBLY_RELAYER_URL=https://<your-domain>
export SUBLY_DEMO_AGENT_KEYPAIR_PATH=<test wallet keypair.json>
npx -y @subly_fi/pay setup-link --initial-deposit 1010000   # owner signs on your domain
npx -y @subly_fi/pay deposit 1010000
# ...once yield has accrued: npx -y @subly_fi/pay fetch <x402 url>
npx -y @subly_fi/pay withdraw 1000000
```

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
basis, forfeiting users' accrued yield). Ship a dump off-host regularly:

```bash
0 * * * * cd /opt/subly/deploy && docker compose exec -T postgres \
  pg_dump -U postgres subly | gzip > /backups/subly-$(date +\%F-\%H).sql.gz
# restore: gunzip -c <dump> | docker compose exec -T postgres psql -U postgres subly
```

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
SUBLY_RELAYER_URL=https://<your-domain> npx -y @subly_fi/pay fetch <url>
# or put SUBLY_RELAYER_URL in the MCP server's env block
```

No API token — buyer requests are wallet-signature authenticated. With
`SUBLY_MANDATE_ENFORCEMENT=on` (recommended above), a user's **first action
is the owner setup link** (`npx -y @subly_fi/pay setup-link
--initial-deposit 1010000`, or the `create_subly_setup_link` MCP tool): the
owner signs the spending mandate and pre-approves the first deposit with one
Face ID. A bare first deposit is refused with `mandate_required_for_deposit`,
and later deposits also require owner approval under the default policy.

Things worth telling your users up front: minimum deposit is just over
1 USDC (`1010000` raw — exactly `1000000` is refused), each payment needs
price + ~0.0035 USDC of spendable yield (withdrawal penalty + fee headroom),
they never need SOL, and only x402 sellers offering a Solana USDC `exact`
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
performance fee on realized yield, per
[`docs/business-model.md`](../docs/business-model.md)) is yours to implement.

## Advanced: your own Kamino vault

By default every deployment settles against Subly's public Kamino USDC vault
(`5kfkpQZ6AkQgizHVThqkxD4J3db2i7pE3mHdPNRbx7jr`). That is fine for third
parties — vault shares sit under each agent wallet's own authority and
nothing about the vault is operator-exclusive — but an independent business
may want its own vault (its own curator, allocation weights, and fee
switches).

Set the vault via environment variables (defaults are Subly's vault):

```bash
SUBLY_VAULT_ADDRESS=<your kvault address>
SUBLY_VAULT_SHARE_MINT=<its share mint>
SUBLY_VAULT_USDC_MINT=EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v
```

Things to know:

- **Decide before the one-time on-chain setup**, and export these variables
  in the shell whenever you run `create-settlement-lut.ts` or
  `invest-vault.ts` — the scripts read process env, not
  `relayer.production.env`. A lookup table created against the default vault
  is useless for yours; create a new one with the variables set.
- The same variables must be set on **both** the relayer and every client
  process, present in the environment *before* the process starts (shell
  env / MCP `env` block — not a late `dotenv.config()`). The client's intent
  validation deliberately checks prepared transactions against its *local*
  vault config — it never trusts the relayer's word on which vault its
  shares leave. Users should therefore only ever set these to a vault they
  independently verified or control: a relayer asking them to change these
  variables is asking them to move their validator's trust anchor.
- A wrong share/USDC mint does not fail at boot — it surfaces at request
  time as `share_mint_mismatch` / `asset_mismatch` intent rejections.
- npm releases of `@subly_fi/pay` up to and including 0.6.1 have the
  defaults compiled in without the env override, so custom-vault deployments
  need a client built from this repo (or the next release published to npm).

You (or your curator) manage the vault's reserve allocation on Kamino;
creating and operating a kvault is Kamino-side work outside this repo.

## Updating a running deployment

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
