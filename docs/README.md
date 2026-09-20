# Documentation

| Audience | Guide |
| --- | --- |
| First-time users and operators using an AI assistant | [Copyable Claude Code / Codex / ChatGPT setup prompts](ai-setup-prompts.md) |
| First-time users choosing a setup path | [Getting started](getting-started.md) |
| CLI and MCP users | [Client quick start](../packages/pay/README.md) |
| Relayer operators | [Deployment, vault configuration, backups and upgrades](../deploy/README.md) |
| Local relayer and Claude Desktop | [Local Docker setup](local-demo.md) |
| Contributors | [Development and tests](../CONTRIBUTING.md) |
| Integrators | [API reference](api.md) · [Architecture](architecture.md) · [Spending mandates](spending-mandate-design.md) |
| Everyone | [Testing and verification](validation.md) · [Security model](security-model.md) · [Troubleshooting](troubleshooting.md) |
| Maintainers | [Release process](../RELEASE.md) · [Dependency status](dependencies.md) |

For supported custody signers, see [wallet providers](agent-wallet-providers.md).

This project supports Solana **mainnet-beta USDC Kamino Earn vaults**. The local Docker deployment also uses mainnet funds; `localhost` describes where the relayer runs. The detached local development API has no on-chain actions. It is not a devnet deployment of the Kamino integration.
