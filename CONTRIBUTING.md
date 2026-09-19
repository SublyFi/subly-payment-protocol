# Contributing

Subly welcomes bug reports, documentation fixes and code contributions under the MIT license. Discuss changes to signing, accounting, owner policies or public APIs in an issue first. Report vulnerabilities privately via [SECURITY.md](SECURITY.md). See the [Code of conduct](CODE_OF_CONDUCT.md).

Write documentation, setup prompts, examples, code comments and user-facing messages in English for an international audience.

## Local development

Use Node.js 24 and npm 11 (`.nvmrc` pins the development major).

```bash
git clone https://github.com/SublyFi/subly-payment-protocol.git
cd subly-payment-protocol
npm ci
npm ci --prefix packages/pay
npm run dev
```

Without RPC/sponsor settings, development starts a detached in-memory API at port 3000. Check `/healthz` and `/v1/vaults`. It performs no on-chain vault operations. No keys or mainnet funds are needed for the standard test suite.

```bash
npm run check
npm run check --prefix packages/pay
npm run test:package
npm audit --prefix packages/pay --omit=dev --audit-level=high
```

`test:package` packs the client, installs it into a temporary directory outside the repository, verifies help/version/commands, and performs an MCP initialize/list-tools exchange with a disposable generated key. It does not send transactions. See [dependency status](docs/dependencies.md) for the separate relayer audit.

## Owner browser tests

```bash
npx playwright install chromium
npm run test:browser
```

This starts the actual owner pages and API on loopback with an in-memory ledger.
Chromium's virtual WebAuthn authenticator exercises passkey registration,
approval, denial and revocation through the server's signature verification.
A generated wallet also checks the Solana wallet signing path. The test uses no
funded keys, database credentials or RPC requests. CI runs this browser check
and tests the packaged CLI/MCP on Linux, macOS and Windows. Virtual authenticators
do not replace checks with real devices and the operator's HTTPS origin.

## PostgreSQL integration tests

Use a **disposable** database. Each test creates and drops its own schema. Tests are skipped unless `SUBLY_TEST_POSTGRES_URL` is set; CI always runs them against PostgreSQL 16.

```bash
docker run --rm --name subly-test-db -e POSTGRES_PASSWORD=local-test -e POSTGRES_DB=subly_test -p 127.0.0.1:55432:5432 -d postgres:16-alpine
SUBLY_TEST_POSTGRES_URL=postgres://postgres:local-test@127.0.0.1:55432/subly_test npm test
docker stop subly-test-db
```

Wait for the database to become ready before testing. Fixtures use generated/test-only keys, never real funded keys. For deployment testing use [the operator guide](deploy/README.md); scripts that create lookup tables or invest vault funds are real transactions.

## Mainnet fork integration test

With Surfpool installed and root/client dependencies installed, start a
**disposable** fork in a separate terminal. Use an environment variable for
your dedicated upstream RPC so its credential is not placed in shell history:

```bash
node --env-file=.env --input-type=module -e '
  const { spawn } = await import("node:child_process");
  const rpc = process.env.SOLANA_RPC_URL || process.env.SOLANA_MAINNET_RPC_URL;
  if (!rpc) throw new Error("Configure the mainnet RPC in .env");
  const child = spawn("surfpool", ["start", "--port", "18899", "--ws-port", "18900",
    "--no-deploy", "--no-tui", "--no-studio", "--airdrop-amount", "0", "--db", ":memory:", "--log-level", "warn"],
    { stdio: "inherit", env: { ...process.env, SURFPOOL_DATASOURCE_RPC_URL: rpc } });
  child.on("exit", code => process.exit(code ?? 1));
'
```

Then run `npm run test:fork`. The test requires a working Pyth key in `.env`
and a numeric loopback Surfpool endpoint (default `http://127.0.0.1:18899`;
override with `SUBLY_FORK_RPC_URL`). It verifies Surfpool before changing state.
All agent, sponsor and seller keys are generated in memory; existing wallet
files are never loaded. Keep normal transaction signature verification enabled.

The test runs wallet-authenticated HTTP onboarding, a simulated passkey owner
approval, a sponsored deposit, receipt/fee accounting, yield realization from
a zero USDC wallet balance, the published client's official x402 transport and
a local seller settlement, then a normal withdrawal. Test balances are local
faucet balances. A **synthetic in-memory ledger yield fixture** is used for the
payment: this verifies transaction/policy behavior, not actual accrued yield
or a third-party facilitator. Stop the fork afterward to discard its state.
It is opt-in because it needs a current mainnet datasource and Pyth access.

For the published verification scope and guidance on a separately authorized
real-funds check, see [validation status](docs/validation.md). Mainnet payment
tests must use real accrued yield; never apply the fork's ledger fixture to
a mainnet relayer.

## Repository map

- `packages/pay/`: published CLI/MCP entry points and package build.
- `src/client/`: reusable client flows, signer adapters and transaction validation.
- `src/api/`, `src/domain/`: relayer HTTP API, ledger and state machines.
- `src/kamino/`, `src/solana/`: vault integration and transaction engine.
- `tests/`: offline unit/regression tests plus opt-in database tests.
- `deploy/`: source-built Docker Compose deployment.
- `docs/`: current guides and focused implementation references.

Keep changes focused, add tests for behavioral fixes, and update the relevant guide and changelog. Do not commit credentials, local env files, generated `dist`, database dumps or payment-state files. Pull requests should explain the user-visible change, validation performed and any migration/compatibility risks. Maintainers review and release using [RELEASE.md](RELEASE.md).
