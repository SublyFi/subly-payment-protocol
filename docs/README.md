# Documentation

| Audience | Guide |
| --- | --- |
| First-time users and operators using an AI assistant | [Copyable Claude Code / Codex / ChatGPT setup prompts](ai-setup-prompts.md) |
| First-time users choosing a setup path | [Getting started](getting-started.md) |
| CLI and MCP users | [Client quick start](../packages/pay/README.md) |
| Relayer operators | [Deployment, vault configuration, backups and upgrades](../deploy/README.md) |
| Contributors | [Development and tests](../CONTRIBUTING.md) |
| Integrators | [API reference](api.md) · [Architecture](architecture.md) |
| Everyone | [Validation status](validation.md) · [Security model](security-model.md) · [Troubleshooting](troubleshooting.md) |
| Maintainers | [Release process](../RELEASE.md) · [Dependency status](dependencies.md) |

Detailed implementation references: [custody wallet providers](agent-wallet-providers.md), [spending mandates](spending-mandate-design.md). These describe internals; start with the guides above. Source and tests are authoritative where older design notes differ.

This project supports Solana **mainnet-beta USDC Kamino Earn vaults**. The detached local development API has no on-chain actions. It is not a devnet deployment of the Kamino integration.

Superseded beta plans, product pitches and exploratory architecture documents remain in Git history.
