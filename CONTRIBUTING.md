# Contributing

Subly welcomes bug reports, documentation fixes and code contributions under the MIT license. Discuss changes to signing, accounting, owner policies or public APIs in an issue first. Report vulnerabilities privately via [SECURITY.md](SECURITY.md). See the [Code of conduct](CODE_OF_CONDUCT.md).

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

## PostgreSQL integration tests

Use a **disposable** database. Each test creates and drops its own schema. Tests are skipped unless `SUBLY_TEST_POSTGRES_URL` is set; CI always runs them against PostgreSQL 16.

```bash
docker run --rm --name subly-test-db -e POSTGRES_PASSWORD=local-test -e POSTGRES_DB=subly_test -p 127.0.0.1:55432:5432 -d postgres:16-alpine
SUBLY_TEST_POSTGRES_URL=postgres://postgres:local-test@127.0.0.1:55432/subly_test npm test
docker stop subly-test-db
```

Wait for the database to become ready before testing. Fixtures use generated/test-only keys, never real funded keys. For deployment testing use [the operator guide](deploy/README.md); scripts that create lookup tables or invest vault funds are real transactions.

## Repository map

- `packages/pay/`: published CLI/MCP entry points and package build.
- `src/client/`: reusable client flows, signer adapters and transaction validation.
- `src/api/`, `src/domain/`: relayer HTTP API, ledger and state machines.
- `src/kamino/`, `src/solana/`: vault integration and transaction engine.
- `tests/`: offline unit/regression tests plus opt-in database tests.
- `deploy/`: source-built Docker Compose deployment.
- `docs/`: current guides and focused implementation references.

Keep changes focused, add tests for behavioral fixes, and update the relevant guide and changelog. Do not commit credentials, local env files, generated `dist`, database dumps or payment-state files. Pull requests should explain the user-visible change, validation performed and any migration/compatibility risks. Maintainers review and release using [RELEASE.md](RELEASE.md).
