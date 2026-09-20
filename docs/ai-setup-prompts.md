# AI setup prompts

Choose a prompt and paste it into your assistant. Leave missing details as
`[unknown]`. These prompts target **Subly 0.8.5**.

- **A:** [Client guide](../packages/pay/README.md). Connect to an existing relayer. Get its URL and reviewed vault catalogue from your operator.
- **B:** [Operator guide](../deploy/README.md). Run your own relayer. This requires a server, domain and database.

The assistant needs terminal access to run commands. Without it, it can guide
you through the steps. Never paste secrets or complete environment files into
chat. Neither prompt authorizes spending real funds.

## A Use an existing relayer

```text
Set up Subly 0.8.5 for my AI assistant or CLI. Keep explanations short.

Known details (no secrets):
- OS and MCP host, or CLI only: [unknown]
- Trusted relayer HTTPS URL without credentials: [unknown]
- Signer type and absolute keypair file path: [unknown]
- RPC configuration file location: [unknown]
- Reviewed vault catalogue location and chosen vault: [unknown]

1. Read packages/pay/README.md, docs/security-model.md and docs/troubleshooting.md from the
   pay-v0.8.5 tag of https://github.com/SublyFi/subly-payment-protocol. Use Node.js 24+ and
   @subly_fi/pay@0.8.5. Verify the installed version; do not silently switch versions. Use the
   command prefix npx -y @subly_fi/pay@0.8.5 unless a local installation is verified.

2. Inspect available tools and existing configuration. Ask together for missing non-secret details,
   then complete reversible local setup. Without terminal access, give me one command and success
   check at a time; never claim execution. If I lack a relayer, help me choose an operator or
   self-hosting before continuing. Do not assume a free public relayer exists.

3. Never display or request keys, recovery phrases, tokens, credential-bearing RPC URLs or complete
   environment files. I enter secrets and generate keys in my private terminal, outside AI capture;
   solana-keygen new displays a recovery phrase. Preserve existing keys, configuration and unrelated
   MCP entries. Keep secret files and backups private and out of logs, shell history and Git. Check
   for secret environment overrides without printing their values.

4. Follow my MCP host's official setup instructions and OS-specific launch method. If local stdio
   MCP is unsupported, use the CLI. Verify the desktop app's environment. Align CLI/MCP wallet,
   relayer, reviewed vault and persistent SUBLY_MCP_STATE_PATH. Reuse existing pending state; one
   local file cannot coordinate other machines. Do not replace trusted vault metadata from a remote
   response or choose a vault by APY. Run version/help, doctor, vault listing and, for MCP,
   initialization and discovery of all thirteen tools. Add no telemetry.

5. Before owner setup, agree on the vault, deposit amount, spending limits, approval conditions and
   expiry. Keep setup/approval links private. I check the domain, wallet, vault and policy and
   approve personally with my passkey or owner wallet. Explain that the first completed setup claims
   ownership and passkeys bind to the operator's domain. A localhost link must be opened on the
   relayer machine, not a phone or another computer. Setup CLI/MCP omits payee allowlist, monthly
   cap and withdrawal-policy controls; use owner management if those are needed. A new setup does
   not inherit old restrictions. The client cap does not set the mandate. After I confirm approval, run
   check_subly_setup or npx -y @subly_fi/pay@0.8.5 setup-status <sessionId>; continue only when
   completed. Use owner-link for existing-owner changes. Explain expiry, revocation and recovery
   limits from the guide; start the 72-hour recovery only at my request. It cannot bypass explicit
   revocation.

6. This prompt does not authorize funding, deposits, withdrawals or paid requests. Obtain my asset,
   amount and destination, or API URL and payment cap; reuse any specific authorization already
   given. Example amounts are not permission. Explain that 1000000 raw USDC is 1 USDC. Check that
   accrued spendable yield covers payment and fees. Only x402 Solana mainnet USDC exact with
   extra.feePayer is supported. Do not test with an unauthorized payment.

7. If an outcome is submitted or unknown, preserve its intent ID and pending JSON. For
   deposits/withdrawals, use npx -y @subly_fi/pay@0.8.5 status <intentId> with the original wallet,
   vault and relayer supporting resubmit=false. For fetch, follow the documented recovery steps;
   interrupted yield realization and unknown external payments need different handling. Never bypass
   uncertainty with a new operation, deleted state, forceNewPayment, another wallet/vault or weaker
   accounting/validation. Seek operator reconciliation when needed.

Finish with completed checks, remaining actions and unverified items. Include versions, changed file
paths, public wallet address, selected vault and pending file path; redact endpoint credentials and
omit capability links. Configuration, doctor and MCP discovery do not verify balances, vault safety,
mainnet transactions or an external security audit.
```

## B Operate your own relayer

```text
Set up a Subly 0.8.5 relayer. Keep explanations short.

Known details (no secrets):
- New installation or upgrade: [unknown]
- OS and SSH host alias: [unknown]
- Domain, DNS status and installation directory: [unknown]
- Docker Compose availability: [unknown]
- RPC/Pyth configuration and sponsor keypair file locations: [unknown]
- Existing database/backups and chosen vaults: [unknown]

1. Read deploy/README.md, packages/pay/README.md, docs/security-model.md, docs/validation.md and
   docs/troubleshooting.md from the pay-v0.8.5 tag of
   https://github.com/SublyFi/subly-payment-protocol. Use that tag's templates and
   @subly_fi/pay@0.8.5; verify versions and do not silently substitute another release.

2. Check available terminal/SSH tools and the target host. Ask together for missing non-secret
   details, then complete reversible preparation. Without execution tools, give me one command and
   success check at a time; never claim execution. Before disrupting an existing service, prepare
   the change and recovery plan for any required confirmation.

3. Never display or request keys, recovery phrases, tokens, passwords, credential-bearing URLs or
   complete environment files. I enter secrets and generate keys in my private terminal, outside AI
   capture; solana-keygen new displays a recovery phrase. Preserve keys and restrict secret
   files/backups to the required users. Check settings without printing secrets or expanding them in
   command output. Keep secrets out of Git, images, history and logs. Add no telemetry or external
   analytics.

4. Follow the deployment guide for Node.js 24+, Docker Compose, dedicated mainnet RPC, Pyth access,
   a separate sponsor wallet, PostgreSQL and Caddy HTTPS. Use my domain consistently for owner links
   and WebAuthn; preserve it during upgrades because passkeys bind to that hostname. Localhost
   links only work on the relayer machine and local deployment still uses real mainnet funds. Set SUBLY_MANDATE_ENFORCEMENT=on, keep admin tokens server-side and
   database/relayer ports private, and follow the documented proxy topology. Confirm before buying
   services.

5. Preserve existing configuration, databases, Compose project names, vaults and pending records. For upgrades, prepare
   database backup/restoration and migration checks before stopping the old process. Do not run both
   versions together, initialize an existing database or reset principal accounting. A binary-only
   rollback may be unsafe after new writes. Review vault metadata and chain accounts, then let me
   choose. Retain vaults holding funds or pending operations; follow the retirement procedure. Use
   the multi-vault Compose files consistently when needed.

6. Validate configuration without exposing secrets, then check HTTPS, healthz, readyz, vault
   listing, database persistence, backup/restoration preparation and sponsor balance/monitoring. Run
   read-only validate:mainnet when prerequisites are available; report missing inputs as unverified.
   Give clients the public URL and reviewed catalogue. Follow their MCP host's official
   configuration; align CLI/MCP wallet, vault, relayer and persistent pending state. Use npx -y
   @subly_fi/pay@0.8.5 unless a local installation is verified.

7. This prompt does not authorize funding, deposits, withdrawals, paid requests, LUT creation or
   invest. Obtain the target and amount or operation scope/fee limit; reuse specific authorization
   already given. Do not schedule financial operations without permission. Add a LUT only if the
   current withdrawal path requires it. I personally approve owner setup on the correct domain;
   check setup status afterward. Follow the owner-management and recovery guide, and start recovery
   only at my request. Explicit revocation cannot be bypassed. Payments need accrued yield plus fees
   and x402 Solana mainnet USDC exact with extra.feePayer. Sponsor gas and rent are costs; fee-debt
   accounting does not reimburse them.

8. Preserve submitted/unknown intent IDs and pending JSON. Check ordinary deposits/withdrawals with
   npx -y @subly_fi/pay@0.8.5 status <intentId>, the original wallet/vault/relayer and supported
   resubmit=false behavior. Follow the fetch recovery procedure for payments. Never bypass
   uncertainty by preparing another operation, deleting state, forceNewPayment, switching wallets or
   weakening accounting/validation. Do not promise cancellation of broadcast transactions,
   reconstruction of principal accounting or immediate credential recovery.

Finish with configured/running items, remaining actions and unverified items. Include the
tag/commit, client version, changed paths, public URL, catalogue, backup location and redacted check
results. Omit secrets and capability links. Distinguish local development, disposable fork tests,
read-only checks and funded mainnet execution. Do not claim unperformed transactions or an external
security audit.
```
