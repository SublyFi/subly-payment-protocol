# AI setup prompts

These prompts target **Subly 0.8.3**. This source checkout prepares that candidate;
verify registry publication before following the release prompts. If unavailable,
evaluate the reviewed [source build](../packages/pay/README.md#run-an-unpublished-source-checkout).
Choose your route in the [getting started guide](getting-started.md), then copy
the appropriate prompt into your assistant. You can leave placeholders as `[unknown]`.
The [client guide](../packages/pay/README.md) and [operator guide](../deploy/README.md)
are the canonical configuration references.

Never paste private keys, seed phrases, API keys, tokens, or complete environment files into chat. An RPC URL can contain credentials too. Share file locations or whether a setting exists, not its secret value.

- **Use A to connect to an existing relayer.** Obtain its HTTPS URL and reviewed vault information from an operator you trust.
- **Use B to run your own relayer.** Installing the client does not deploy a server.
- An assistant with execution tools can configure and check your local environment. Without connected terminal or MCP tools, an assistant can only guide you through the steps. An AI subscription does not by itself provide local MCP support.

Neither prompt authorizes transactions with real funds. You choose the amounts and destinations, and personally approve owner requests with your passkey or wallet.

## A Use an existing relayer

```text
Set up Subly 0.8.3 so I can use it through my AI assistant or the CLI. Explain the process in clear English for a beginner and finish the available configuration and checks.

Known details (no secrets):
- Operating system: [unknown]
- MCP host name, or CLI only: [unknown]
- Trusted relayer HTTPS URL without credentials: [unknown]
- Agent wallet signer type and absolute keypair file path: [unknown]
- RPC configuration file location: [unknown]
- Reviewed vault catalogue location and desired vault: [unknown]

First check which tools you actually have. If you can use a terminal, inspect my OS and existing configuration, then proceed with reversible local setup. Without connected tools, give me one step and its success check at a time, wait for my result, and never claim you ran it. Ask together for only the missing non-secret information.

1. Verify the official repository https://github.com/SublyFi/subly-payment-protocol, its published pay-v0.8.3 tag, and the matching npm package @subly_fi/pay@0.8.3. Read packages/pay/README.md, docs/security-model.md and docs/troubleshooting.md at that tag. Consult deploy/README.md and docs/agent-wallet-providers.md where needed. Do not invent commands or silently switch to latest or another version if publication cannot be verified. If I have no relayer, explain the need to choose an operator or self-host; do not assume a permanent free public service exists.

2. Never request private keys, seeds, API keys, credential-bearing RPC URLs or complete configuration in chat. I enter secrets in my own private terminal, outside AI capture. Do not dump secret files, environment variables or authentication headers, or leave secrets in logs, shell history or Git. solana-keygen new displays a recovery seed by default: key generation must take place in my private terminal, not an AI execution tool, and you must not ask me to paste its output. Preserve existing keys and explain secure storage and backup. Preserve existing files and unrelated MCP entries, update only the necessary settings, and protect backups that contain secrets.

3. Use Node.js 24 or newer and consult the selected MCP host's current official setup documentation. Generic JSON and local stdio MCP support are not universal; offer a supported host or CLI if needed. Use paths and launch commands appropriate for my OS, and verify the environment seen by the desktop app rather than assuming it inherits terminal exports. Align CLI and MCP on the same wallet, relayer, reviewed vault catalogue and selection, and persistent SUBLY_MCP_STATE_PATH. Check whether existing secret environment variables override the key file without printing their values. Do not create another pending file for the same wallet. Explain that a local file cannot coordinate clients on other machines. Never replace local transaction trust anchors solely from a remote response or select a vault automatically by APY.

4. Begin with read-only checks: the pinned client's version/help, doctor, vault listing, and MCP initialization/tool listing where applicable. Use the full npx -y @subly_fi/pay@0.8.3 command prefix unless a local executable installation has been verified. Do not add telemetry or external analytics. A successful doctor check does not prove sufficient balances or yield, vault safety, or successful transactions.

5. Agree with me on the vault, initial deposit amount, spending limits, approval conditions and expiry before creating owner setup. Do not adopt example amounts without permission. Share setup/approval links only with me and keep them out of public logs. I personally check the correct domain, wallet, vault and policy, and approve with my passkey or owner wallet; do not approve for me. When I return to chat and say I have approved, use check_subly_setup or npx -y @subly_fi/pay@0.8.3 setup-status <sessionId> to confirm completion, then continue with a deposit only if I authorized it. The first person completing initial setup becomes the owner, and passkeys bind to the operator's domain. Explain expiry, revocation and recovery limits. With matching client and relayer 0.8.3+, use owner-link for existing-owner policy changes or reactivation, and recovery-status to inspect access. Only start the 72-hour recovery process when I request it; it cannot override explicit owner revocation. I personally approve current-owner changes.

6. This prompt alone does not authorize real-fund operations. Funding a wallet, depositing, paid fetch and withdrawing require my explicit asset, amount and target authorization; for an API payment, obtain its URL and payment cap. Do not repeatedly ask about the same specifically authorized operation. Explain that 1000000 raw USDC equals 1 USDC. A new deposit may have no payment budget: spendable yield must accrue and cover fees. Only x402 APIs offering Solana mainnet USDC exact with extra.feePayer are supported, not arbitrary URLs. Do not use an unauthorized paid request as a test.

7. For submitted or unknown outcomes, do not start another copy of the operation. Preserve original dep_/wdr_ IDs and check ordinary deposits/withdrawals with npx -y @subly_fi/pay@0.8.3 status <intentId>, using the original wallet, vault and relayer. Verify that the relayer supports resubmit=false status checks. For fetch, preserve pending JSON and follow the guide, distinguishing interrupted yield realization from an unknown external payment. Never bypass uncertainty by deleting state, forceNewPayment, switching wallets/vaults, altering principal accounting or disabling validation. Wait for reconciliation with the operator when necessary.

Finish with separate lists of completed items, actions awaiting me, and unverified items. Include actual versions, changed file paths, credential-redacted endpoints, public wallet address, selected vault, pending file path, passed checks and the next step. Do not repeat secrets or capability links. Configuration and read-only checks must not be reported as verified mainnet deposits, withdrawals, payments or an external security audit.
```

## B Operate your own relayer

```text
Help me operate a Subly 0.8.3 relayer using the official deployment guide. Explain the process in clear English for a beginner and complete the available configuration, startup, read-only checks and operational preparation.

Known details (no secrets):
- New installation or existing deployment upgrade: [unknown]
- Workstation/server OS and SSH host alias: [unknown]
- My domain, DNS status and installation directory: [unknown]
- Docker Compose availability: [unknown]
- RPC/Pyth configuration and sponsor keypair file locations: [unknown]
- Existing database/backups and desired vaults: [unknown]

Check the terminal/SSH tools and connection targets you actually have. If execution is available, proceed with reads and reversible preparation. Without connected tools, give me one step and its success check at a time, wait for my result, and never claim execution. Before disrupting an existing service, prepare the concrete change and recovery plan for any necessary confirmation. Ask only for missing non-secret information.

1. Verify the official repository https://github.com/SublyFi/subly-payment-protocol, its published pay-v0.8.3 tag, and matching npm package @subly_fi/pay@0.8.3. Read deploy/README.md, packages/pay/README.md, docs/security-model.md, docs/validation.md, docs/troubleshooting.md and deployment templates at that tag. Do not invent commands or mix future main-branch instructions with old design notes. If publication cannot be verified, report that and offer the documented reviewed-source build; do not claim a release exists or silently use another version.

2. Never request private keys, seeds, SSH private keys, API keys, database passwords, credential-bearing RPC URLs or complete .env files in chat. I enter secrets into local/server files from my private terminal, outside AI capture. Check presence and format without displaying values or dumping secret files/environment variables. Keep secrets out of Git, images, history and logs. solana-keygen new displays a seed by default: have me generate keys privately, never through captured AI tools or by pasting output. Do not overwrite keys; explain secure storage and backup. Treat monitoring webhooks as secrets. Do not add telemetry or external analytics.

3. Distinguish a fresh install from an upgrade. Preserve existing configuration, databases, vault entries and pending records; do not blindly overwrite files with example copy/redirection commands. For an upgrade, establish database backup/restoration, the old-process shutdown plan and migration consequences before proceeding. Do not run old and new versions together, initialize an existing database or reset principal accounting. A binary-only rollback is not necessarily safe after new data has been written.

4. Follow the guide for Node.js 24+, Docker Compose, dedicated mainnet RPC, Pyth price access, a dedicated sponsor key file, PostgreSQL and Caddy HTTPS. The sponsor wallet is separate from the agent wallet. Restrict secret files to the required runtime user. Use my own domain consistently for setup/approval URLs and WebAuthn, and set SUBLY_MANDATE_ENFORCEMENT=on. Keep admin tokens server-side and database/relayer ports private. Trust proxy headers only in the documented topology. Confirm the specifics before incurring new cloud subscriptions or other purchases.

5. Read and validate official vault metadata and chain accounts, then let me choose the vaults. Do not replace a running catalogue with regenerated entries alone; preserve vaults holding funds or pending operations. Follow the guide for retiring vaults. Use the multi-vault Compose files consistently when applicable and distribute reviewed metadata to clients. Check configuration without expanding secrets, then verify HTTPS, healthz, readyz, vault listing, database storage, backup/restoration preparation and sponsor balance/monitoring. Run read-only validate:mainnet only when prerequisites are available; record missing shares or other inputs as unverified. Health checks do not establish liquidity or transaction success.

6. This prompt alone does not authorize real-fund operations. Funding sponsor/agent wallets, deposits, paid fetch, withdrawals, LUT creation and invest require my explicit target plus amount or operation scope/fee limit. Existing specific authorization remains valid. Do not schedule financial operations without permission. Consider an additional LUT only when the current withdrawal path requires it, not because an obsolete atomic diagnostic is oversized. I personally check and approve owner setup on the correct domain; do not act as me. After I return and confirm approval, check setup status before any authorized deposit. Spendable yield including fees may take time to accrue; never weaken accounting or validation to pass a test.

7. Give users the public relayer URL and reviewed catalogue and verify clients pinned to 0.8.3. Consult the chosen MCP host's current official configuration; generic JSON does not prove a working connection. Align CLI/MCP wallet, vault, relayer and persistent pending state path. Use the full npx -y @subly_fi/pay@0.8.3 command prefix unless a local executable installation has been verified. APIs must offer Solana mainnet USDC exact with extra.feePayer. Sponsor gas and account rent are operating costs; fee-debt accounting is not reimbursement or revenue in the current code.

8. For submitted or unknown outcomes, preserve original intent IDs and pending JSON. Use npx -y @subly_fi/pay@0.8.3 status <intentId> with the same wallet/vault/relayer and supported resubmit=false behavior, or the documented fetch recovery procedure. Do not bypass uncertainty through new preparation, state deletion, forceNewPayment or switching wallets. Do not promise cancellation of broadcast transactions, reconstruction of principal accounting or immediate passkey recovery. Matching 0.8.3+ client/server supports owner-link for current-owner changes and recovery-start/recovery-status for the 72-hour lost-credential process. Explicit revocation still requires the same owner to restore access. Repeating initial setup does not bypass it.

Finish with separate lists of configured/running items, actions still needed, and unverified items. Include actual tag/commit/package version, changed file paths, public URL, catalogue, backup location, credential-redacted check results and the next step. Exclude secrets and capability links. Distinguish detached development, a disposable local fork, read-only checks and actual funded mainnet execution. Never claim unperformed deposits/payments or an external security audit.
```
