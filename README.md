# Subly

**Pay for x402 APIs with the yield from a Kamino USDC vault on Solana.**

[![CI](https://github.com/SublyFi/subly-payment-protocol/actions/workflows/ci.yml/badge.svg)](https://github.com/SublyFi/subly-payment-protocol/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/%40subly_fi%2Fpay)](https://www.npmjs.com/package/@subly_fi/pay)
[![MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

Subly provides an open-source relayer and an MCP/CLI client. An agent deposits USDC into a selected Kamino Earn vault. When an API returns `402 Payment Required`, the client asks the relayer to realize enough accrued yield, then pays the seller using standard x402. Sellers do not need to integrate Subly.

| I want to… | Start here |
| --- | --- |
| Set up with Claude Code, Codex or ChatGPT | [Copy a user or operator setup prompt](docs/ai-setup-prompts.md) |
| 日本語で始める | [利用者・運営者のスタートガイド](docs/getting-started.ja.md) |
| Use Subly with an agent or the CLI | [Client quick start](packages/pay/README.md#quick-start) |
| Operate my own relayer | [Operator guide](deploy/README.md) |
| Try the API locally without funds | [Local development](#try-it-locally) |
| Contribute a change | [Contributing](CONTRIBUTING.md) |

**Status:** MIT-licensed OSS, version `0.x` (beta). Mainnet vault operations use real funds. There has been no external security audit. Yield limits and owner mandates are enforced by the relayer; they do not guarantee principal value or prevent an agent with its own key from transacting elsewhere. See the [security model](docs/security-model.md) and [dependency status](docs/dependencies.md).

Real-funds mainnet checks cover vault operations, browser passkey approval,
separate fee sponsorship and an external x402 test payment/refund. The complete
yield-funded payment flow has been exercised in a disposable local fork.
See [validation status](docs/validation.md) for the evidence and remaining checks.

## What is included

- **Client:** `@subly_fi/pay` exposes setup, deposits, budgets, withdrawals and paid API requests through CLI and stdio MCP.
- **Relayer:** Fastify API with wallet-signature authentication, sponsored vault transactions, owner spending controls and a PostgreSQL ledger.
- **Self-hosting:** Docker Compose with PostgreSQL and Caddy HTTPS; no Subly account, operator allowlist or proprietary service is required.
- **Vault choice:** a reviewed local catalogue of compatible mainnet USDC Kamino Earn vaults, with separate accounting and mandates for each vault.

```mermaid
sequenceDiagram
    participant Client as Agent / Subly client
    participant Relayer as Your relayer
    participant Vault as Kamino USDC vault
    participant Seller as Standard x402 seller
    Client->>Seller: Request API
    Seller-->>Client: 402 + price and payment rail
    Client->>Relayer: Request yield realization
    Relayer-->>Client: Prepared withdrawal
    Client->>Client: Validate and sign
    Client->>Relayer: Signed transaction
    Relayer->>Vault: Sponsor and submit
    Vault-->>Client: USDC to agent wallet
    Client->>Seller: Standard x402 payment
    Seller-->>Client: API response
```

The relayer and the seller's **x402 facilitator** have different roles. The relayer sponsors vault transactions; the seller's facilitator sponsors the final x402 payment. Realization and payment are separate transactions, so the flow is not atomic.

## Use the client

Start with the [step-by-step client guide](packages/pay/README.md#quick-start), or paste a [setup prompt](docs/ai-setup-prompts.md) into your AI assistant. No repository clone is needed. The guide prepares a dedicated agent wallet and mainnet USDC, configures your chosen operator and RPC, and checks them before requesting any transaction. It includes macOS/Linux and Windows instructions.

With Node.js 24 or later installed, you can view the available commands without configuring a wallet:

```bash
npx -y @subly_fi/pay@0.8.1 --help
```

After configuration, follow the guide to review the vault, create an owner setup link, approve the policy, deposit, and check the budget before buying an API call. An approval page records permission; tell your chat agent you finished, or return to the terminal and continue the original command as instructed. A fresh deposit needs time to earn a spendable budget.

Supported sellers must offer **Solana mainnet USDC `exact`** with `extra.feePayer`. The client checks the challenge at runtime; a seller name alone is not proof of compatibility. Amounts use six-decimal raw USDC units: `1000000` means 1 USDC. The default API payment cap is `10000` (0.01 USDC).

## Try it locally

Node.js 24 and npm 11 are the development baseline:

```bash
git clone https://github.com/SublyFi/subly-payment-protocol.git
cd subly-payment-protocol
npm ci
npm run dev
```

In another terminal:

```bash
curl --fail http://127.0.0.1:3000/healthz
curl --fail http://127.0.0.1:3000/v1/vaults
```

With no RPC or sponsor configured, explicit development mode uses an in-memory **detached** API. It requires no wallet, funds or database. On-chain deposit, withdrawal and settlement are unavailable in this mode. Production refuses this fallback.

```bash
npm run check                  # types, tests, build and documentation links
npm ci --prefix packages/pay
npm run check --prefix packages/pay
npm run test:package           # install the tarball and exercise CLI + MCP
```

The [contributor guide](CONTRIBUTING.md) explains PostgreSQL tests and repository structure.

## Operate a relayer

Follow the [operator guide](deploy/README.md) or use the [operator setup prompt](docs/ai-setup-prompts.md). The guide separates preparation, configuration, startup, validation and ongoing operations. It covers sponsor funding, reviewed vault metadata, lookup tables, HTTPS, health checks, backups and upgrades. The deployment is built from a tagged source checkout. Publish your relayer URL and reviewed vault catalogue to your users.

Sponsor gas and account rent are operator costs. Recorded fee debt reduces a user's spending budget; the current code does **not** collect reimbursement for the operator.

## Documentation and community

The [documentation index](docs/README.md) links the current architecture, API, security and troubleshooting guides. Old beta plans, pitch materials and superseded designs are available in Git history rather than the onboarding path.

- [Questions and discussions](https://github.com/SublyFi/subly-payment-protocol/discussions) · [Bug reports](https://github.com/SublyFi/subly-payment-protocol/issues)
- [Security reporting](SECURITY.md) · [Support](SUPPORT.md)
- [Contributing](CONTRIBUTING.md) · [Code of conduct](CODE_OF_CONDUCT.md) · [Governance](GOVERNANCE.md)
- [Changelog](CHANGELOG.md) · [Release process](RELEASE.md) · [MIT license](LICENSE)
