# Troubleshooting

Start with `npx -y @subly_fi/pay@0.8.0 doctor` and record the exact client version. For operators, check `docker compose ps`, `docker compose logs --tail=100 relayer`, `/healthz` and `/readyz`. Remove credentials and capability URLs before sharing logs.

| Symptom | Action |
| --- | --- |
| Cannot find Node / unsupported engine | Install Node.js 24+ and restart the MCP host so it sees the new PATH. |
| Missing signer | Set the agent keypair path or custody provider variables in the actual MCP process environment; a terminal export may not reach a desktop app. |
| Catalogue mismatch / unknown vault | Compare the reviewed local and operator catalogue; restart both after changes. Never copy anchors from a prepared transaction. |
| `mandate_required_for_deposit` | Run `setup-link --initial-deposit <amount>`, have the owner approve, check `setup-status`, then deposit. |
| `approvalRequired` | Open the original approval URL, approve, and retry the same operation with the approval ID. |
| `mandate_revoked` / `mandate_changed` | Inspect the owner's current policy. Re-prepare only after restoring the intended authorization. Revocation also blocks relayer exits. |
| Passkey fails | Use the same operator HTTPS domain and credential; verify setup/approve URL bases and WebAuthn RP/origins. See owner recovery controls in the mandate design. |
| `insufficient_yield` | Check `budget`; principal is not available as a payment budget. Wait for yield and account for fees. Repeated retries do not create yield. |
| Withdrawal simulation unavailable/mismatched | Check RPC support for `simulateTransaction` with parsed inner instructions, blockhash freshness and liquidity. Re-prepare after a known pre-submit failure; never bypass validation. |
| Unsupported x402 rail | Seller must offer mainnet Solana USDC exact with `extra.feePayer`. EVM or missing fee sponsorship is not supported. |
| `submitted` / confirmation timeout | Run `pay status <dep_... or wdr_...>` or MCP `check_subly_vault_operation(intentId)` with the original wallet, selected vault and relayer. Requires relayer 0.8.0 or newer: the authenticated `resubmit=false` option reconciles the original transaction without rebroadcasting it. Upgrade older relayers first. If still submitted, check the same ID later; do not repeat the deposit or withdrawal. |
| `vault_flow_pending` during sync | Reconcile the submitted deposit/withdrawal IDs in the error details with `pay status <intentId>` or `check_subly_vault_operation(intentId)`, then refresh the budget. Sync will not classify those funds as an external deposit or withdrawal. |
| Status reports a different wallet/vault or intent ID | Restore the original wallet, selected vault and relayer configuration. Status lookup refuses to return another operation’s result. |
| `stale_position_snapshot` | Fetch a new chain snapshot. Another operation updated the ledger while the old read was in flight, or the RPC is behind the ledger's last observed slot. |
| `payment_outcome_unknown` | Preserve pending JSON. Investigate seller/facilitator status and chain before any new charge. Operator assistance may be required. |
| Interrupted yield realization during `fetch` | Keep the pending file and retry the same request with the same wallet, vault, relayer, body and headers. A saved withdrawal checkpoint is reconciled or resumed using its original ID. If no ID was saved, or that withdrawal ended unsuccessfully, ask the operator to reconcile it. `forceNewPayment` does not discard an unfinished realization. |
| `realize_underfunded` | A withdrawal landed but its USDC receipt was below the exact API price. No seller payment was attempted. Preserve pending state and reconcile the original withdrawal; do not blindly force a new payment or fill the gap from unrelated wallet funds. Upgrade both client and relayer for bounded rounding headroom and the pre-sign minimum-output check. |
| Payment state locked | Stop concurrent clients. After confirming no process is using the state file, remove only a stale `.lock` from a crash. Keep JSON intact. |
| `needs_baseline_reset` | External share movement changed accounting. The operator can chain-sync conservatively; accrued budget may be lost. Backups matter. |
| Transaction exceeds 1232 bytes | Operator must configure suitable vault-specific lookup tables. The LUT setup script spends sponsor SOL. |
| Relayer refuses production startup | Configure RPC, sponsor key, admin token and PostgreSQL. Check mounted key permissions (container UID 1000) and DB readiness. |
| `stale_oracle` / Hermes authentication failed | Set the operator's `SUBLY_HERMES_API_KEY` (or `PYTH_API_KEY`) and restart the relayer. Hosted Hermes requires authentication. Verify the selected HTTPS provider and key; `/readyz` only checks the database, not oracle availability. Never use a stale/static price to bypass a failing live oracle. |
| Sponsor runs low | Fund the operator sponsor, inspect fee/rent costs and monitoring. Recorded fee debt is not collected revenue. |

Never share private keys, API tokens, signed authentication headers, database connection strings or approval links in public issues. Use [private security reporting](../SECURITY.md) for vulnerabilities and [Discussions](https://github.com/SublyFi/subly-payment-protocol/discussions) for usage questions.
