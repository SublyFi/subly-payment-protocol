# Getting started

Choose one path. The linked guide contains the commands.

| Goal | Requirements | Guide |
| --- | --- | --- |
| Try the API locally | Git, Node.js 24, npm 11; no funds | [Local startup](../README.md#try-it-locally) |
| Use an existing relayer | Node.js 24+, operator URL, mainnet RPC, agent wallet | [Client setup](../packages/pay/README.md#quick-start) |
| Run your own relayer | Linux server, Docker Compose, domain, RPC, Pyth access, sponsor SOL | [Operator setup](../deploy/README.md) |
| Run a relayer on your Mac with Claude Desktop | Docker Desktop, Node.js 24+, RPC, Pyth access, sponsor and agent wallets | [Local Docker setup](local-demo.md) |
| Contribute | Git, Node.js 24, npm 11 | [Development guide](../CONTRIBUTING.md) |

For help from Claude Code, Codex or ChatGPT, copy an [AI setup prompt](ai-setup-prompts.md).

## Use an existing relayer

Ask your operator for its HTTPS URL and reviewed vault configuration. There is no guaranteed public relayer.

Follow the [client guide](../packages/pay/README.md#quick-start) in this order:

1. Configure a dedicated agent wallet, relayer, mainnet RPC and vault.
2. Run `npx -y @subly_fi/pay@0.8.5 doctor`. Continue when it reports `"ok": true`.
3. Create a setup link and approve the spending policy in your browser. Return to the CLI or tell your agent approval is complete; wait for setup status `completed`.
4. Deposit the approved amount of mainnet USDC.
5. Check `npx -y @subly_fi/pay@0.8.5 budget`. Wait until spendable yield covers the API price and fees.
6. Pay an API that supports x402 Solana mainnet USDC `exact` with `extra.feePayer`.

A successful `doctor` check confirms configuration and connectivity. A fresh deposit does not provide an immediate payment budget. Local detached mode cannot perform these transactions.

The 0.01 USDC client payment cap is separate from the owner policy. Review the
client guide's setup defaults and explicitly set the intended caps and expiry.
A new setup does not inherit an old mandate's restrictions.

Keep keys, seed phrases, credentials and approval links private. Use a passkey or a separate owner wallet to approve the policy. Relayer policies do not prevent someone holding the agent key from transacting outside Subly. Local Docker still uses mainnet funds; open its localhost approval links on the relayer machine.

## If an operation stops

| Result | Action |
| --- | --- |
| Deposit or withdrawal is `submitted` | Run `npx -y @subly_fi/pay@0.8.5 status <intentId>` with the original ID. Do not repeat the transaction while confirmation is pending. |
| Payment is interrupted or its outcome is unknown | Keep the pending JSON file and follow [payment recovery](../packages/pay/README.md#recovery-and-troubleshooting). Do not delete state or force a new payment. |
| `insufficient_yield` | Check the budget and wait for more yield. |
| Owner access or policy needs changing | Follow [owner management and recovery](../packages/pay/README.md#manage-the-owner-and-recover-access). |

Keep the same wallet, vault, relayer and pending-state file across CLI and MCP. See [troubleshooting](troubleshooting.md) for other errors.

## Operate a relayer

Follow the [operator guide](../deploy/README.md) to configure the server, start it and check `/readyz`. Then complete the validation steps before onboarding users. Startup checks alone do not verify deposits or payments.

For upgrades, use the guide's update procedure. Preserve the database, credentials and vaults with existing funds. Sponsor SOL pays gas and account rent; fee-debt accounting does not reimburse the operator.

Subly 0.8.5 is beta software without an external security audit. Mainnet operations use real funds. Read the [security model](security-model.md) and [validation status](validation.md) before depositing.
