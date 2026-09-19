# @subly_fi/pay

CLI and stdio MCP client for paying compatible x402 APIs with Kamino USDC vault yield on Solana. MIT licensed. Works with your own [Subly relayer](https://github.com/SublyFi/subly-payment-protocol/tree/main/deploy); no Subly account is required.

Version 0.8 is beta software and has not had an external security audit. Vault operations use real mainnet funds. Yield accounting and owner policies depend on your relayer operator. Read the [security model](https://github.com/SublyFi/subly-payment-protocol/blob/main/docs/security-model.md).

[Getting started](https://github.com/SublyFi/subly-payment-protocol/blob/main/docs/getting-started.md) · [Set up with an AI assistant](https://github.com/SublyFi/subly-payment-protocol/blob/main/docs/ai-setup-prompts.md)

## Quick start

Follow the steps in order. Every Subly command below uses `npx`; no repository
clone or global `pay` installation is needed. Replace example URLs, paths and IDs
with your own values. For completed release checks and their scope, see the
[validation records](https://github.com/SublyFi/subly-payment-protocol/blob/main/docs/validation.md).

### 1. Prepare the software and endpoints

- Install **Node.js 24+ with npm** from the [official download page](https://nodejs.org/en/download). Open a new terminal and check `node --version` and `npm --version`.
- Obtain a **trusted relayer's HTTPS URL**, running version 0.8.3 or newer for the concurrency fixes and owner management in this guide. This guide supplies no guaranteed public endpoint. To operate one yourself, use the [operator guide](https://github.com/SublyFi/subly-payment-protocol/tree/main/deploy).
- Obtain a **Solana mainnet RPC URL** supporting transaction simulation with inner instructions. Keep RPC credentials in local configuration, not public issues or chat.
- Use a **dedicated agent wallet** with USDC on Solana mainnet. This wallet holds funds and signs transactions. The human owner's passkey or separate wallet approves spending controls. Supported custody signers are described under [Configuration](#configuration).

```sh
npx -y @subly_fi/pay@0.8.4 --version
npx -y @subly_fi/pay@0.8.4 --help
```

The version should be `0.8.4`. A help screen alone does not check your wallet or endpoints.

### 2. Prepare and fund the agent wallet

If you already have a dedicated **64-byte Solana JSON keypair**, use its absolute file path and skip creation. Do not overwrite an existing keypair.

To create one, install the Solana CLI using its [official installation guide](https://solana.com/docs/intro/installation). Subly does not install that CLI. On Windows, the official guide uses WSL: you can keep this entire terminal workflow in WSL and use the macOS/Linux examples below. Native PowerShell settings are also shown for a keypair accessible to Windows.

Run wallet creation yourself in a **private terminal**, not through an AI tool that records command output: `solana-keygen new` displays the recovery phrase. Do not copy its output into chat. In a macOS, Linux or WSL terminal:

```sh
(
set -eu
command -v solana-keygen >/dev/null
umask 077
mkdir -p "$HOME/.subly"
if [ -e "$HOME/.subly/agent.json" ]; then
  printf '%s\n' 'Keypair already exists; use it or choose another path.' >&2
  exit 1
fi
solana-keygen new --outfile "$HOME/.subly/agent.json"
chmod 600 "$HOME/.subly/agent.json"
solana-keygen pubkey "$HOME/.subly/agent.json"
)
```

The last command prints the **public receiving address**. Save the recovery phrase privately; never paste it, the JSON file contents or a private key into an AI chat. The keypair file contains signing secrets even if wallet creation asked for a recovery passphrase. Restrict it to your OS account; for an existing Windows file, review its Security properties.

Send **USDC on Solana mainnet** to that public address from your existing wallet or exchange, and confirm arrival. The example below deposits **1.01 USDC**; the selected vault's minimum may differ. Subly does not fund wallets. The relayer sponsor pays vault transaction fees; the seller's facilitator supplies the final API payment's fee payer. Ask the operator if sponsorship is unavailable.

### 3. Configure this terminal and check it

Choose one environment example. Settings apply to the current terminal; a new terminal or desktop MCP host needs its own configuration. Keep the same wallet, selected vault, relayer and pending-state path when continuing a payment. RPC URLs often contain API keys: enter the URL yourself at the hidden prompt in your private terminal, not in an AI chat or AI tool input. These examples keep it out of the command text and shell history.

macOS/Linux/WSL (Bash or zsh):

```sh
export SUBLY_RELAYER_URL="https://your-relayer.example.com"
printf 'Solana mainnet RPC URL (hidden): '
read -r -s SOLANA_RPC_URL
printf '\n'
export SOLANA_RPC_URL
export SUBLY_DEMO_AGENT_KEYPAIR_PATH="$HOME/.subly/agent.json"
export SUBLY_MCP_STATE_PATH="$HOME/.subly/standard-x402-pending.json"
```

Windows PowerShell, with a keypair already stored at this Windows path:

```powershell
$env:SUBLY_RELAYER_URL = "https://your-relayer.example.com"
$sublyRpcSecret = Read-Host "Solana mainnet RPC URL" -AsSecureString
$env:SOLANA_RPC_URL = [System.Net.NetworkCredential]::new("", $sublyRpcSecret).Password
Remove-Variable sublyRpcSecret
$env:SUBLY_DEMO_AGENT_KEYPAIR_PATH = "$env:USERPROFILE\.subly\agent.json"
$env:SUBLY_MCP_STATE_PATH = "$env:USERPROFILE\.subly\standard-x402-pending.json"
```

Use absolute paths valid where the client runs. Windows and WSL home directories differ; switching must not silently create a second pending-state file for the same wallet. If PowerShell blocks `npx.ps1`, invoke `npx.cmd` with the same arguments instead of changing the machine's execution policy.

For a custom operator catalogue, review and install the file, then set `SUBLY_VAULTS_FILE` to its absolute path using your shell's syntax above. `SUBLY_VAULT_ADDRESS` selects one listed vault. Configure this before checking the relayer; never install transaction trust anchors merely because a remote response says to.

```sh
npx -y @subly_fi/pay@0.8.4 doctor
npx -y @subly_fi/pay@0.8.4 vaults
```

Continue when `doctor` returns `"ok": true` and the selected local vault matches the operator's catalogue. It checks configuration and reachability, not balance, simulation support, available yield or vault safety. Review the vault's curator, fees, minimum deposit and liquidity with the operator. `vaults` prints trusted local metadata, not a live balance.

### 4. Register the owner and approve the first deposit

Use the same raw amount for setup and deposit. Amounts are six-decimal USDC integers: `1000000` = 1 USDC, `1010000` = 1.01 USDC, `10000` = 0.01 USDC.

```sh
npx -y @subly_fi/pay@0.8.4 setup-link --initial-deposit 1010000
```

The result contains `sessionId` and `setupUrl`. Open `setupUrl` on your device, review the wallet, vault and limits, then approve with your passkey or owner wallet. Links expire in 10 minutes. Treat them as private capabilities: the first person completing initial setup becomes the owner for that wallet/vault.

After approval, **return to this terminal**, replacing the placeholder with the returned ID:

```sh
npx -y @subly_fi/pay@0.8.4 setup-status st_YOUR_SESSION_ID
```

Continue only on `"status": "completed"`. `pending` means approval is unfinished; `expired` means create a fresh setup link. On first registration, `initialDepositApproval` should be present and approved. Deposit promptly: it lasts about 15 minutes. Browser approval saves authorization; it does not run a CLI command. With MCP, tell the agent that approval is complete so it can check and continue.

Review policy options **before first registration**:

```sh
npx -y @subly_fi/pay@0.8.4 setup-link --help
```

For an existing owner, use [owner management](#manage-the-owner-and-recover-access) to change policy or restore a revoked mandate with the same credential. A new setup link cannot override an active or revoked owner. Policy replacement requires a separate deposit approval.

### 5. Deposit and inspect the budget

```sh
npx -y @subly_fi/pay@0.8.4 deposit 1010000
```

Success prints `status: confirmed`, a `depositId`, a transaction link and the confirmed amount. Keep the ID. For `submitted`, use the [status procedure](#check-an-interrupted-deposit-or-withdrawal); the transaction may still land, so do not deposit again.

```sh
npx -y @subly_fi/pay@0.8.4 budget
```

Inspect `spendableYieldRawUsdc`. A new deposit does **not** immediately provide a payment budget; principal is not spendable yield. Wait until yield covers the API price and vault fees, then check again. There is no guaranteed waiting time: performance, fees, deposited amount and liquidity matter. The 1.01 USDC example demonstrates setup and deposit, not an immediate paid call. A budget read can return the last synced view if refresh fails; live payment checks still decide whether it can proceed.

### 6. Request a compatible paid API

Obtain a real paid URL from its seller; the hostname below is a placeholder. Supported offers are **Solana mainnet USDC `exact`** with `extra.feePayer`. EVM, other tokens and unsponsored rails are refused. A seller name alone does not prove compatibility.

```sh
npx -y @subly_fi/pay@0.8.4 fetch https://seller.example.com/paid-resource
```

The default client cap is **0.01 USDC**. An explicit cap of 0.02 USDC looks like this:

```sh
npx -y @subly_fi/pay@0.8.4 fetch https://seller.example.com/paid-resource 20000
```

The owner policy may impose stricter limits. A successful paid call returns `"paid": true`, an HTTP 2xx `status` and the API response `body`. `paid: false` is not a confirmed paid call; read its reason or HTTP response. If the endpoint did not require payment, no payment was made.

For `approval_required`, open the returned `approveUrl`, approve, return to the terminal, and repeat the **same URL, request and cap** with the returned approval ID:

```sh
npx -y @subly_fi/pay@0.8.4 fetch https://seller.example.com/paid-resource 20000 apr_YOUR_APPROVAL_ID
```

Replace the placeholder ID. For MCP, tell the agent approval is complete and ask it to resume the same operation with that ID. An unknown payment outcome is not an approval retry; follow [Recovery and troubleshooting](#recovery-and-troubleshooting).

### 7. Withdraw to the agent wallet

A withdrawal can include principal and is subject to liquidity, fees and owner policy. This requests 1 USDC back to the **same agent wallet**:

```sh
npx -y @subly_fi/pay@0.8.4 withdraw 1000000
```

Success prints `status: confirmed`, a `withdrawalId`, a transaction link and the confirmed amount. An approval-required result includes `approveUrl` and `approvalId`. After approval, repeat the same amount with that ID:

```sh
npx -y @subly_fi/pay@0.8.4 withdraw 1000000 apr_YOUR_APPROVAL_ID
```

Later deposits use the same approval pattern:

```sh
npx -y @subly_fi/pay@0.8.4 deposit 1010000 apr_YOUR_APPROVAL_ID
```

Only use an ID issued for that exact operation. Moving withdrawn funds onward to another wallet is a separate action outside this CLI.

### Check an interrupted deposit or withdrawal

Keep the original `depositId` (`dep_...`) or `withdrawalId` (`wdr_...`). Replace this placeholder with its full ID:

```sh
npx -y @subly_fi/pay@0.8.4 status wdr_YOUR_WITHDRAWAL_ID
```

Use the original wallet, selected vault and relayer. Status requires **relayer 0.8.0 or newer** and reconciles with `?resubmit=false`: it does not prepare, sign or send another transaction. Wallet-auth message signing is required, but no client RPC call is needed.

| Result | What to do |
| --- | --- |
| `confirmed` / `nextAction: done` | The original operation is confirmed; inspect `actualAmountRawUsdc` and `txSignature`. |
| `submitted` / `nextAction: check_again` | Check the **same ID** later; do not repeat the deposit or withdrawal. |
| `prepared` | Status does not submit it. Keep the ID and ask the operator to reconcile before a new operation. |
| `nextAction: reconcile_with_operator` | Keep the ID and error code; ask the operator to reconcile the failed or expired operation. |

Exit zero means the status lookup worked, even if the operation is pending or failed. Inspect `status` and `nextAction`. An interrupted API payment uses its saved pending-state checkpoint instead, as described below.

## MCP configuration

Use your host's **documented MCP configuration format**. This JSON is for hosts accepting an `mcpServers` object; it is not universal. Codex uses its own MCP settings/configuration: translate the command, arguments and environment into that interface. The [AI setup prompts](https://github.com/SublyFi/subly-payment-protocol/blob/main/docs/ai-setup-prompts.md) help you configure the selected host.

Replace every example value. Use the **same absolute pending-state path as the CLI** for the same wallet. Shell exports may not reach a desktop app; supply variables to the MCP process itself. JSON does not expand `$HOME` or `$env:USERPROFILE`. Use paths such as `/Users/your-name/...`, `/home/your-name/...`, or escaped Windows paths such as `C:\\Users\\your-name\\.subly\\agent.json`.

```json
{
  "mcpServers": {
    "subly": {
      "command": "npx",
      "args": ["-y", "@subly_fi/pay@0.8.4", "mcp"],
      "env": {
        "SUBLY_RELAYER_URL": "https://your-relayer.example.com",
        "SOLANA_RPC_URL": "https://your-mainnet-rpc.example.com",
        "SUBLY_DEMO_AGENT_KEYPAIR_PATH": "/absolute/path/to/.subly/agent.json",
        "SUBLY_MCP_STATE_PATH": "/absolute/path/to/.subly/standard-x402-pending.json",
        "SUBLY_MCP_MAX_AMOUNT_RAW_USDC": "10000"
      }
    }
  }
}
```

Restart the host after configuration changes and confirm it exposes all thirteen Subly tools. Some Windows hosts require a documented command wrapper for `npx.cmd`; follow the host's instructions rather than assuming the Unix launcher works unchanged.

Tools: `list_subly_vaults`, `select_subly_vault`, `create_subly_setup_link`, `check_subly_setup`, `check_subly_vault_operation`, `create_subly_owner_link`, `check_subly_owner_session`, `get_subly_owner_status`, `start_subly_owner_recovery`, `deposit_to_subly_vault`, `get_subly_yield_budget`, `withdraw_from_subly_vault`, `fetch_with_subly_payment`. Ask the agent to list vaults and follow owner setup before depositing. Each selected vault has its own mandate and accounting; changing selection never moves funds. Stdio stdout is reserved for MCP messages.

## Configuration

| Variable | Meaning |
| --- | --- |
| `SUBLY_RELAYER_URL` | Chosen operator's HTTPS URL. Set explicitly; the historical demo fallback has no availability promise. |
| `SOLANA_RPC_URL` | Your trusted mainnet RPC; fallback is the rate-limited public mainnet RPC. Used to verify lookup tables and simulate withdrawals before signing. |
| `SUBLY_DEMO_AGENT_KEYPAIR_PATH` | Local Solana 64-byte JSON keypair; the historical `DEMO` name also applies in production. |
| `SUBLY_DEMO_AGENT_KEYPAIR` | Alternative base58 64-byte secret; if set, takes precedence over the file. Avoid putting secrets in shell history or chat. |
| `SUBLY_SIGNER_PROVIDER` | `local` (default), `circle` or `privy`. |
| `SUBLY_VAULTS_FILE` | Reviewed local vault catalogue. Without it, the built-in vault is used. |
| `SUBLY_VAULT_ADDRESS` | Selected catalogue entry (or custom single-vault address with matching share mint/farm settings). |
| `SUBLY_MCP_MAX_AMOUNT_RAW_USDC` | Client payment cap; default `10000`. |
| `SUBLY_MCP_STATE_PATH` | Persistent pending-payment file. Default `~/.subly/standard-x402-pending.json`. Use one shared file for all CLI/MCP clients paying from the same wallet on this machine. Different machines do not coordinate payments. |
| `SUBLY_PAY_METHOD` / `SUBLY_PAY_BODY` | Optional HTTP method and body for CLI `fetch`; MCP accepts these as tool arguments. |

For Circle set `SUBLY_SIGNER_PROVIDER=circle` and configure `CIRCLE_API_KEY`, `CIRCLE_ENTITY_SECRET`, `CIRCLE_WALLET_ID`. For Privy set `SUBLY_SIGNER_PROVIDER=privy` and use `PRIVY_APP_ID`, `PRIVY_APP_SECRET`, `PRIVY_WALLET_ID`, and `PRIVY_AUTHORIZATION_KEY` when required by wallet ownership. Each accepts a `SUBLY_` prefix which takes precedence. These providers need a Solana mainnet wallet, not an EVM wallet; a local keypair is not required. The [provider implementation notes](https://github.com/SublyFi/subly-payment-protocol/blob/main/docs/agent-wallet-providers.md) describe supported transports and unimplemented proposals; they are not a wallet-creation tutorial.

Only sellers offering **Solana mainnet USDC `exact`** with `extra.feePayer` are supported. EVM, unsupported tokens and unsponsored rails are refused. A supported seller does not need a Subly integration. Yield realization and x402 payment are separate transactions: if the payment fails after realization, USDC may remain in the agent wallet.

## Manage the owner and recover access

These commands require both client and relayer **0.8.3 or newer**. Keep the original
operator domain, wallet and selected vault. They sign API messages or owner policy
messages, never token transactions.

```sh
npx -y @subly_fi/pay@0.8.4 recovery-status
npx -y @subly_fi/pay@0.8.4 owner-link --per-payment-cap 2000000
npx -y @subly_fi/pay@0.8.4 owner-status st_YOUR_SESSION_ID
```

The cap above is an example, not a recommended policy. Omitted policy fields and
the current expiry stay unchanged. `owner-link --help` lists all policy options,
including deposit/withdrawal approval, monthly caps and allowed payees. Threshold
`0` requires approval for every payment. `none` disables a nullable cap or approval
threshold, and `--allowed-payees any` removes the payee restriction. Review these
changes carefully; the page displays current and proposed values before signing.

Open the private `ownerUrl` and use the **existing** passkey or registered owner
wallet to approve changes, restore a revoked mandate, revoke access, or cancel a
pending recovery. The link lasts ten minutes and works once. A policy or lifecycle
change invalidates older links. No replacement passkey is created for ordinary
policy updates. A replacement mandate invalidates previous approvals; it does not
automatically approve another deposit. To renew an expired policy, explicitly set
`--ttl-days` when creating the link.

If the owner credential is lost, the agent wallet can request the existing delayed
recovery process:

```sh
npx -y @subly_fi/pay@0.8.4 recovery-start
npx -y @subly_fi/pay@0.8.4 recovery-status
```

Wait until `effectiveStatus` is `recovery_elapsed` after the 72-hour deadline;
then create a normal `setup-link` to register a new owner. The current owner can
cancel recovery with a fresh owner link during that window. Explicitly revoked
mandates **cannot** be reset by the agent: the same owner must restore them. If
both that owner credential and its backup are lost, contact the operator about
direct wallet access; do not delete the ledger or manufacture a new principal
baseline. Agent keys still control on-chain vault shares outside Subly.

MCP provides `create_subly_owner_link`, `check_subly_owner_session`,
`get_subly_owner_status`, and `start_subly_owner_recovery`. An assistant should
start recovery only when the user asks, and return the owner link for the human
to approve personally.

## Recovery and troubleshooting

- Preserve pending-state JSON across restarts, upgrades and CLI/MCP changes. An `external_outcome_unknown` record blocks another payment until you investigate the seller/facilitator outcome. Never delete the file to bypass it.
- For interrupted yield realization, retry the same request with the same wallet, vault, relayer, method, body and headers. A saved checkpoint resumes the original withdrawal and reuses its confirmed funds; even `forceNewPayment` cannot replace an unfinished realization. If no withdrawal ID was saved or it ended unsuccessfully, ask the operator to reconcile it before a new payment.
- Older pending records without a resumable withdrawal remain blocked for investigation. Keep the file; do not downgrade while a realization is pending.
- Concurrent clients sharing the state file serialize payments with a `.lock` file. After a crash, stop **all** clients using it before removing only a stale `.lock`. Preserve the JSON. Another path or machine cannot coordinate with the old file.
- For an interrupted manual deposit or withdrawal, use `npx -y @subly_fi/pay@0.8.4 status <intentId>` or MCP `check_subly_vault_operation` with the original ID and configuration, rather than repeating the financial operation.
- A withdrawal preview failure is a refusal to sign. Check RPC simulation support and liquidity; do not disable validation.
- Passkeys bind to the operator's domain. Use `owner-link` with the existing credential for policy updates or reactivation, and `recovery-start` / `recovery-status` for delayed lost-credential recovery. These require client and relayer 0.8.3+. Explicit revocation cannot be bypassed by the agent.

[Full troubleshooting](https://github.com/SublyFi/subly-payment-protocol/blob/main/docs/troubleshooting.md) · [Support](https://github.com/SublyFi/subly-payment-protocol/blob/main/SUPPORT.md) · [Private security reports](https://github.com/SublyFi/subly-payment-protocol/security/advisories/new)

## Build from source

For development or testing a reviewed source checkout, run these commands from
the repository root:

```sh
npm ci --ignore-scripts
npm ci --prefix packages/pay --ignore-scripts
npm run check --prefix packages/pay
node packages/pay/dist/cli.js --version
node packages/pay/dist/cli.js --help
npm run test:package
```

For local testing, replace the `npx -y @subly_fi/pay@0.8.4` prefix in this guide
with `node packages/pay/dist/cli.js`. For MCP, launch `node` with the absolute path
to that file followed by `mcp`. Run a compatible source relayer for the commands
you are testing.

`test:package` verifies a packed installation outside the checkout, including
the MCP handshake. The package contains the client only; it does not include the
relayer or Kamino server SDK.
