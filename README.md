# Subly

**Pay for x402 APIs with yield from a Kamino USDC vault on Solana.**

[![CI](https://github.com/SublyFi/subly-payment-protocol/actions/workflows/ci.yml/badge.svg)](https://github.com/SublyFi/subly-payment-protocol/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/%40subly_fi%2Fpay)](https://www.npmjs.com/package/@subly_fi/pay)
[![MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

Subly includes a CLI/MCP client and a self-hosted relayer. Deposit USDC into a supported Kamino vault, let it earn yield, then use that yield to pay compatible APIs. Sellers use standard x402 and need no Subly integration.

| Goal | Guide |
| --- | --- |
| Use Subly with an agent or CLI | [Client setup](packages/pay/README.md#quick-start) |
| Run a relayer | [Operator setup](deploy/README.md) |
| Run a relayer locally and connect Claude Desktop | [Local Docker setup](docs/local-demo.md) |
| Try the API without funds | [Local startup](#try-it-locally) |
| Set up with an AI assistant | [Copy a setup prompt](docs/ai-setup-prompts.md) |

**Beta (0.8.6), no external security audit.** Mainnet operations use real funds. Principal and yield are not guaranteed. Owner approvals and principal accounting are enforced by the relayer; an agent key can transact outside Subly. See the [security model](docs/security-model.md) and [validation status](docs/validation.md).

## Try it locally

Requires Git, Node.js 24 and npm 11. Run these commands in macOS, Linux or Windows WSL:

```bash
git clone https://github.com/SublyFi/subly-payment-protocol.git
cd subly-payment-protocol
npm ci
HOST=127.0.0.1 npm run dev
```

Keep that terminal open. In a second terminal:

```bash
curl --fail http://127.0.0.1:3000/healthz
curl --fail http://127.0.0.1:3000/v1/vaults
```

Success: `/healthz` returns `{"ok":true}` and `/v1/vaults` returns a vault list. Stop the server with `Ctrl+C`.

With no RPC or sponsor environment variables set, this starts an in-memory API (`mode: detached`). No wallet, funds or database are needed. Deposits, withdrawals and payments are unavailable in this mode. `npm run dev` does not load `.env` automatically.

## Use the client

Requires Node.js 24+, an operator's relayer URL, mainnet RPC and a dedicated agent wallet. Obtain the relayer URL from your operator; this project does not provide a guaranteed public endpoint.

```bash
npx -y @subly_fi/pay@0.8.6 --help
```

Follow the [client setup](packages/pay/README.md#quick-start) to configure the client, approve a spending policy, deposit and check your budget. No repository clone is needed. **A fresh deposit must earn enough yield before it can pay an API.**

Supported APIs must offer x402 **Solana mainnet USDC `exact`** with `extra.feePayer`. The default payment cap is 0.01 USDC. Amounts in commands use raw units: `1000000` = 1 USDC.

## Operate a relayer

The [operator guide](deploy/README.md) covers Docker Compose, PostgreSQL, HTTPS, RPC and sponsor configuration. You need a domain and a sponsor wallet funded with SOL.

The relayer sponsors vault transactions; the seller's x402 facilitator handles API payment settlement. These are separate transactions. Sponsor gas and account rent are operator costs; recorded fee debt reduces the user's budget but does not reimburse the operator.

## Development and documentation

See [Contributing](CONTRIBUTING.md) for tests and development setup, or the [documentation index](docs/README.md) for API, architecture and troubleshooting guides.

- [Questions](https://github.com/SublyFi/subly-payment-protocol/discussions) · [Bug reports](https://github.com/SublyFi/subly-payment-protocol/issues) · [Support](SUPPORT.md)
- [Security reporting](SECURITY.md) · [Code of conduct](CODE_OF_CONDUCT.md) · [Governance](GOVERNANCE.md)
- [Changelog](CHANGELOG.md) · [Release process](RELEASE.md) · [Dependency status](docs/dependencies.md) · [MIT license](LICENSE)
