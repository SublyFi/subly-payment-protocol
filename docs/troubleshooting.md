# Troubleshooting

Start with `npx -y @subly_fi/pay@0.8.1 doctor` and record the exact client version with `npx -y @subly_fi/pay@0.8.1 --version`. Continue only after `doctor` reports `"ok": true`; this checks configuration and reachability, not balances, yield, simulation support or vault safety. For first-time setup, use the [client guide](../packages/pay/README.md), [日本語ガイド](getting-started.ja.md) or [AI setup prompts](ai-setup-prompts.md).

The guide uses `npx`, so a global `pay` command is not required. Replace placeholder IDs below with the IDs from your original result. Operators can check `docker compose ps`, `docker compose logs --tail=100 relayer`, `/healthz` and `/readyz`. Remove credentials and capability URLs before sharing logs.

## Installation and configuration

| Symptom | Action |
| --- | --- |
| Cannot find Node / unsupported engine | Install Node.js 24+ with npm from the [official download page](https://nodejs.org/en/download). Open a new terminal and restart the MCP host so it sees the new PATH. |
| `pay: command not found` | Use the versioned invocation, for example `npx -y @subly_fi/pay@0.8.1 status <intentId>`. Older output may show a bare command; do not repeat a deposit or withdrawal just to get new instructions. |
| `solana-keygen` not found | It is a separate prerequisite for local wallet creation. Follow the [official Solana CLI installation guide](https://solana.com/docs/intro/installation); Windows uses WSL for that CLI. An existing dedicated 64-byte Solana JSON keypair or supported custody signer also works. |
| PowerShell rejects `export` or blocks `npx.ps1` | Use `$env:NAME = "value"` as shown in the client guide. If the script launcher is blocked, invoke `npx.cmd` with the same arguments. Do not change machine-wide execution policy just for this guide. |
| Missing signer / unreadable keypair | Set the absolute keypair path or custody variables in the actual CLI/MCP environment. Terminal exports may not reach desktop apps. Windows and WSL paths differ; JSON does not expand shell variables. Never paste the keypair, recovery phrase or API secrets into chat. |
| MCP host rejects the sample JSON | The `mcpServers` example is only for hosts supporting that format. Use the host's MCP settings and documented launcher; Codex has its own configuration. Match the command, arguments, environment and absolute pending-state path, restart the host and check for nine Subly tools. |
| Relayer or RPC is unreachable | Replace placeholder endpoints with your trusted operator/RPC URLs, check mainnet configuration and run `npx -y @subly_fi/pay@0.8.1 doctor` again. This guide supplies no guaranteed public relayer. |
| Catalogue mismatch / unknown vault | Compare the reviewed local and operator catalogue, set the reviewed file and selected vault, then restart the clients after changes. Never copy anchors from a prepared transaction. |

## Owner approval and spending

| Symptom | Action |
| --- | --- |
| `mandate_required_for_deposit` | Run `npx -y @subly_fi/pay@0.8.1 setup-link --initial-deposit <rawAmount>`, have the owner approve, then run `npx -y @subly_fi/pay@0.8.1 setup-status <sessionId>`. Continue only on `status: completed`; deposit the same amount while the initial approval is valid. |
| Setup status is `pending` / `expired` | `pending` means the owner has not finished approval. For `expired`, create a fresh setup link. Exit zero alone does not mean setup is complete. |
| Browser says approved but nothing happens | Approval saves authorization; it does not restart a CLI command. Return to the terminal and retry the exact operation with its approval ID. With MCP, tell the agent approval is complete so it can check and resume. |
| `approvalRequired` / `approval_required` | Open the original `approveUrl`, approve, and retry the same operation with its `apr_...` ID. For example: `npx -y @subly_fi/pay@0.8.1 deposit 1010000 apr_YOUR_APPROVAL_ID`. For API payment, keep the same URL, method, body, headers and cap. Replace the example ID. |
| Existing passkey owner blocks another setup link / want to change limits | The setup page cannot update an existing active or revoked passkey mandate, and CLI/MCP has no policy-update or owner-recovery command. Contact the operator for the supported low-level procedure. A new credential or repeated setup link does not override the existing owner. |
| `mandate_revoked` / `mandate_changed` | Inspect the current policy with the operator. Revocation also blocks relayer withdrawals. Restore the intended authorization before a new operation; CLI/MCP has no passkey revoke-reversal workflow. |
| Passkey fails / credential lost | Use the original operator HTTPS domain and credential. Operators should verify URL bases and WebAuthn RP/origins. For a lost credential, contact the operator: low-level recovery has an authorization/delay process, not a one-click CLI/MCP reset. Preserve the agent key and ledger. |
| `insufficient_yield` | Run `npx -y @subly_fi/pay@0.8.1 budget` and inspect `spendableYieldRawUsdc`. Principal cannot fund API payments. Wait for sufficient yield plus fees; there is no guaranteed waiting time and retries do not create yield. A small setup deposit is not an immediate paid-call demo. |
| Unsupported x402 rail | Seller must offer mainnet Solana USDC exact with `extra.feePayer`. EVM, unsupported tokens and missing sponsorship are refused. Obtain a compatible real URL; `seller.example.com` is a placeholder. |
| Withdrawal simulation unavailable/mismatched | Check RPC support for `simulateTransaction` with parsed inner instructions, blockhash freshness and liquidity. Re-prepare only after a known pre-submit failure; never bypass validation. |

## Interrupted operations

Preserve the original wallet, selected vault, relayer and pending-state path. CLI and MCP on the same machine must share the pending file for the same wallet. Another path or machine does not coordinate with an existing payment.

| Symptom | Action |
| --- | --- |
| `submitted` / confirmation timeout | Run `npx -y @subly_fi/pay@0.8.1 status <intentId>` or MCP `check_subly_vault_operation` with the original `dep_...` or `wdr_...` ID. Requires relayer 0.8.0 or newer; reconciles without rebroadcasting. `confirmed` / `done` is success; `submitted` / `check_again` means check that same ID later. Never repeat a deposit or withdrawal while it may still confirm. |
| Status exits zero but operation failed | Exit zero means the lookup worked. Inspect `status`, `nextAction` and `errorCode`. For `reconcile_with_operator`, retain the ID and ask the operator to reconcile before a new operation. `prepared` does not mean this command will submit it. |
| `vault_flow_pending` during sync | Reconcile the IDs in the error details with `npx -y @subly_fi/pay@0.8.1 status <intentId>` or the MCP status tool, then refresh the budget. Sync will not classify those funds as an external deposit or withdrawal. |
| Status reports a different wallet/vault or intent ID | Restore the original wallet, selected vault and relayer configuration. Status refuses to return another operation's result. |
| `stale_position_snapshot` | Refresh with `npx -y @subly_fi/pay@0.8.1 budget`. Another operation updated the ledger during the old read, or the RPC is behind the ledger's last observed slot. If it persists, ask the operator to check the RPC and ledger. |
| `payment_outcome_unknown` / `external_outcome_unknown` | Preserve pending JSON. Investigate seller/facilitator status and the chain before any new charge. Operator assistance may be required. Never delete state or force a new payment to bypass uncertainty. |
| Interrupted yield realization during a fetch request | Preserve state and retry the same request with the same wallet, vault, relayer, body and headers. A saved checkpoint reconciles or resumes its original withdrawal. If no ID was saved, or it ended unsuccessfully, ask the operator to reconcile it. `forceNewPayment` does not discard unfinished realization. |
| `realize_underfunded` | A withdrawal landed but its receipt was below the exact API price. No seller payment was attempted. Preserve state and reconcile the original withdrawal; do not force a new payment or fill the gap with unrelated wallet funds. Upgrade both client and relayer for rounding headroom and the pre-sign minimum-output check. |
| Payment state locked | Stop all CLI/MCP clients using the file. After confirming none is running, remove only a stale `.lock` from a crash. Preserve JSON. |
| `needs_baseline_reset` | External share movement changed accounting. The operator can chain-sync conservatively; accrued budget may be lost. Backups matter. |

## Operator checks

| Symptom | Action |
| --- | --- |
| Transaction exceeds 1232 bytes | Configure suitable vault-specific lookup tables. The LUT setup script spends sponsor SOL. |
| Relayer refuses production startup | Configure RPC, sponsor key, admin token and PostgreSQL. Check mounted key permissions (container UID 1000) and DB readiness. |
| `stale_oracle` / Hermes authentication failed | Set `SUBLY_HERMES_API_KEY` (or `PYTH_API_KEY`) and restart the relayer. Verify the HTTPS provider and key; `/readyz` checks the database, not oracle availability. Never use a stale/static price to bypass a failing live oracle. |
| Sponsor runs low | Fund the sponsor, inspect fee/rent costs and monitoring. Recorded fee debt is not collected revenue. |

Never share private keys, recovery phrases, API tokens, signed authentication headers, database connection strings or approval links in public issues. Use [private security reporting](../SECURITY.md) for vulnerabilities and [Discussions](https://github.com/SublyFi/subly-payment-protocol/discussions) for usage questions.
