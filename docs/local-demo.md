# Run Subly locally with Docker and Claude Desktop

Use the same Docker Compose stack as the Linux server: PostgreSQL, Relayer and
Caddy. On your Mac, use `http://localhost` and bind the published ports to
loopback. Claude Desktop runs the Subly MCP client locally.

**This is a mainnet relayer running locally, not a devnet or a simulated vault.**
Deposits, withdrawals and API payments use real funds. No external security
audit has been performed. Read the [security model](security-model.md) before
funding it. For a no-funds API demonstration, use [detached local startup](../README.md#try-it-locally).

Open owner and approval links in a browser on this same Mac. On a phone or
another computer, `localhost` points to that device and cannot reach this
relayer. Passkeys bind to the original hostname; changing it later requires
planning owner access, not just editing the URL.

## 1. Prepare

Start Docker Desktop. Install Git, Node.js 24+ with npm, and ensure `curl` and
`openssl` are available for the commands below. You need
a mainnet RPC URL, a [Pyth API key](https://pythdata.app/) and a dedicated sponsor
key. Use an existing key or follow [sponsor key setup](../deploy/README.md#prepare-the-sponsor-key).
The sponsor needs SOL before on-chain operations can succeed.

```sh
docker version
docker compose version
node --version
npm --version
```

For a new checkout:

```sh
git clone --branch pay-v0.8.6 --depth 1 https://github.com/SublyFi/subly-payment-protocol.git
cd subly-payment-protocol
```

For an existing checkout, preserve local settings, the ledger and pending state.
Review the [upgrade procedure](../deploy/README.md#updating-a-running-deployment)
before changing its source version. Keep the same Compose project name: changing
it selects different volumes and can appear to lose the ledger. Open the chosen
checkout, then:

```sh
cd deploy
```

## 2. Configure localhost

For a new installation, replace `sponsor_source` and run this once. It refuses
to replace existing settings or keys. For an existing installation, keep those
files and edit only the settings described below.

```sh
(
  set -eu
  set -o noclobber
  umask 077
  sponsor_source="/absolute/path/to/sponsor.json"
  test -f "$sponsor_source"
  for target in relayer.production.env Caddyfile .env secrets/sponsor.json; do
    if [ -e "$target" ] || [ -L "$target" ]; then
      echo "Keep the existing $target; edit the existing installation."
      exit 1
    fi
  done
  mkdir -m 700 -p secrets
  cat relayer.production.env.example > relayer.production.env
  printf 'POSTGRES_PASSWORD=%s\nCOMPOSE_PROJECT_NAME=subly-local\nSUBLY_BIND_ADDRESS=127.0.0.1\n' "$(openssl rand -hex 24)" > .env
  cat > Caddyfile <<'EOF'
http://localhost {
    reverse_proxy relayer:3000
}
EOF
  cat "$sponsor_source" > secrets/sponsor.json
  chmod 600 secrets/sponsor.json
)
nano relayer.production.env
```

Set these values in `relayer.production.env`:

```dotenv
SOLANA_RPC_URL=REPLACE_WITH_MAINNET_RPC_URL
SUBLY_HERMES_API_KEY=REPLACE_WITH_PYTH_API_KEY
SUBLY_ADMIN_API_TOKEN=REPLACE_WITH_RANDOM_ADMIN_TOKEN
SUBLY_SETUP_URL_BASE=http://localhost/setup/
SUBLY_APPROVE_URL_BASE=http://localhost/approve/
```

Create the admin token with a password manager. Keep `NODE_ENV=production` and
`SUBLY_MANDATE_ENFORCEMENT=on`. Leave WebAuthn overrides unset so they follow the
localhost URLs. Compose supplies the database URL and sponsor key path.

For existing files, also set `SUBLY_BIND_ADDRESS=127.0.0.1` in `deploy/.env`
and use the Caddyfile shown above. Keep the original database password and
Compose project name. Do not add
`COMPOSE_PROJECT_NAME=subly-local` to an existing deployment with another project
name. Never run `docker compose down -v` to fix startup.

## 3. Build and check the key

These commands set the copied key's container permissions on macOS or Linux,
then verify that the normal relayer user can read it:

```sh
docker compose config --quiet
docker compose build relayer
docker compose run --rm --no-deps --user 0 \
  --cap-add CHOWN --cap-add FOWNER --cap-add DAC_OVERRIDE \
  --volume "$PWD/secrets:/secrets" --entrypoint sh relayer \
  -c 'chown 1000:1000 /secrets/sponsor.json && chmod 600 /secrets/sponsor.json'
docker compose run --rm --no-deps --entrypoint node relayer \
  -e "require('node:fs').accessSync('/run/subly/sponsor.json', require('node:fs').constants.R_OK)"
docker compose run --rm --no-deps caddy \
  caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile
```

The extra capabilities apply only to the temporary permission-fixing container;
the running relayer keeps its restricted user and `cap_drop: [ALL]`. Each command
must exit successfully. For custom vaults, apply the same reviewed
[vault configuration](../deploy/README.md#advanced-your-own-kamino-vault) to the
relayer and client before continuing.

**Existing agent wallet and ledger:** retain its database history. If moving
from a different local PostgreSQL instance, stop the old relayer, back up that
ledger, and restore into a new, empty Compose database before starting this
relayer:

```sh
docker compose up -d --wait postgres
docker compose exec -T postgres pg_restore \
  --exit-on-error --single-transaction --no-owner --no-privileges \
  -U postgres -d subly < /absolute/path/to/ledger.dump
```

Skip the restore for a new wallet or an existing Compose ledger. A fresh ledger
cannot recover the historical principal/yield split of an existing position;
it conservatively treats existing value as principal. This restore must target
an empty database and will fail on conflicting existing objects. Keep the old
backup and database until verified; run only one relayer against the ledger.
See [database backups](../deploy/README.md#back-up-the-ledger) for backup steps.

## 4. Start

```sh
docker compose up -d --build --wait
docker compose ps
curl --fail http://localhost/healthz
curl --fail http://localhost/readyz
curl --fail http://localhost/v1/vaults
docker compose logs --tail=30 relayer
```

Expected: PostgreSQL and relayer are healthy, Caddy is running, both health
checks return `{"ok":true}`, and the relayer log shows `"mode":"mainnet"`.
The vault endpoint returns the configured vaults. These checks do not validate
funds, available yield or an API payment.

For later starts, run `docker compose up -d --wait`. Stop with
`docker compose stop`; keep the database volume and original settings.

## 5. Connect Claude Desktop

Prepare an agent wallet using the [client guide](../packages/pay/README.md#2-prepare-the-agent-wallet).
Use the same agent key and pending-state file if you already use Subly.

In Claude Desktop, open **Settings → Developer → Edit Config**. On macOS this is
`~/Library/Application Support/Claude/claude_desktop_config.json`.
Add `subly` to the existing `mcpServers` object, preserving other entries:

```json
{
  "mcpServers": {
    "subly": {
      "command": "npx",
      "args": ["-y", "@subly_fi/pay@0.8.6", "mcp"],
      "env": {
        "SUBLY_RELAYER_URL": "http://localhost",
        "SOLANA_RPC_URL": "REPLACE_WITH_MAINNET_RPC_URL",
        "SUBLY_DEMO_AGENT_KEYPAIR_PATH": "/absolute/path/to/agent.json",
        "SUBLY_MCP_STATE_PATH": "/absolute/path/to/standard-x402-pending.json",
        "SUBLY_MCP_MAX_AMOUNT_RAW_USDC": "10000"
      }
    }
  }
}
```

Use absolute paths and your real RPC URL. Quit and reopen Claude Desktop;
it should expose 13 Subly tools. The config contains RPC credentials, so restrict
its permissions and redact them before sharing diagnostics. If Node is installed through a version manager,
make its Node 24 binary directory available in the MCP process's `PATH`.

The localhost URL is the relayer address inside the MCP environment. Subly MCP
uses stdio; the relayer URL is not a remote MCP connector URL.

## 6. Run the demo

Ask Claude to list vaults and check your budget. For a new wallet, ask it to
create a setup link for your chosen deposit amount, explicit spending caps and
expiry. Review the [setup defaults and available policy controls](../packages/pay/README.md#4-approve-and-deposit);
the 0.01 USDC client cap does not configure the owner mandate. Open the returned
`http://localhost/setup/...` link and approve it yourself. Then ask Claude to
check setup status and submit the approved deposit.

Use a paid API only when the owner policy permits it and the available yield
covers the API price and fees. A fresh deposit does not immediately provide
spendable yield. The default payment cap is 0.01 USDC.

For a seller such as Nansen, confirm the endpoint, method, body schema and price
from that seller's official documentation before authorizing a call. Give Claude
the exact request and payment cap. A malformed paid request can still cost the
payment; an application error is not proof that no funds moved. Success is `paid: true`, an HTTP 2xx
status and the API response. Tool discovery alone does not validate payment.
