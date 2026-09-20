# @subly_fi/pay

CLI and MCP client for paying compatible x402 APIs with Kamino USDC vault yield on Solana. Requires a running [Subly relayer](https://github.com/SublyFi/subly-payment-protocol/tree/main/deploy); this package does not start one.

Version 0.8 is beta software without an external security audit. Deposits use real mainnet funds. Owner approval is enforced off chain by the relayer; an agent key can transact outside Subly. Read the [security model](https://github.com/SublyFi/subly-payment-protocol/blob/main/docs/security-model.md).

## Quick start

Use Node.js **24+ with npm**. No repository clone or global installation is needed.

Before starting, obtain:

- A trusted relayer's HTTPS URL, running **0.8.3+**. No public endpoint is guaranteed. To host one, follow the [operator guide](https://github.com/SublyFi/subly-payment-protocol/tree/main/deploy).
- A Solana mainnet RPC URL that supports transaction simulation with inner instructions.
- A dedicated agent wallet with **Solana mainnet USDC**. The example deposits **1.01 USDC**; check the selected vault's minimum with the operator.

Replace the example URLs, paths and IDs below. CLI commands run once and exit. For an AI agent, use [MCP configuration](#mcp-configuration).

### 1. Check the client

```sh
node --version
npm --version
npx -y @subly_fi/pay@0.8.5 --version
```

The last command must print `0.8.5`. If Node is missing, [install Node.js 24+](https://nodejs.org/en/download) and open a new terminal. For installation errors, see [troubleshooting](https://github.com/SublyFi/subly-payment-protocol/blob/main/docs/troubleshooting.md).

### 2. Prepare the agent wallet

If you have a dedicated **64-byte Solana JSON keypair**, skip creation and use its absolute path in step 3. Otherwise, install the [Solana CLI](https://solana.com/docs/intro/installation). On Windows, use WSL for wallet creation.

Run this yourself in a **private terminal**: `solana-keygen new` displays the recovery phrase. Never paste it or the keypair contents into chat.

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

Save the recovery phrase privately and restrict the keypair file to your OS account. Send USDC on **Solana mainnet** to the public address printed by the last command, then confirm arrival. Subly does not fund wallets. The relayer and seller's facilitator sponsor transaction fees; confirm sponsorship with the operator.

For Circle or Privy wallets, see [Configuration](#configuration).

### 3. Configure and check the connection

Choose one shell example. Enter the RPC URL at the hidden prompt to keep its credentials out of shell history.

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

Windows PowerShell, with an existing keypair at this Windows path:

```powershell
$env:SUBLY_RELAYER_URL = "https://your-relayer.example.com"
$sublyRpcSecret = Read-Host "Solana mainnet RPC URL" -AsSecureString
$env:SOLANA_RPC_URL = [System.Net.NetworkCredential]::new("", $sublyRpcSecret).Password
Remove-Variable sublyRpcSecret
$env:SUBLY_DEMO_AGENT_KEYPAIR_PATH = "$env:USERPROFILE\.subly\agent.json"
$env:SUBLY_MCP_STATE_PATH = "$env:USERPROFILE\.subly\standard-x402-pending.json"
```

Settings apply to this terminal only. Use absolute paths; Windows and WSL paths differ. If PowerShell blocks `npx.ps1`, use `npx.cmd` with the same arguments.

If your operator uses a custom vault catalogue, review it and set `SUBLY_VAULTS_FILE` to its absolute path. Set `SUBLY_VAULT_ADDRESS` to select a listed vault. Do not copy trust settings from a transaction or an unreviewed remote response.

```sh
npx -y @subly_fi/pay@0.8.5 doctor
npx -y @subly_fi/pay@0.8.5 vaults
```

Continue only when `doctor` prints `"ok": true`. It checks configuration, relayer readiness, vault settings and mainnet RPC access. It does **not** check the keypair contents, funds, yield, simulation support or vault safety. `vaults` prints local settings; review the vault's fees, minimum deposit and liquidity with the operator.

### 4. Approve and deposit

Amounts use six-decimal USDC integers: `1000000` = 1 USDC; `1010000` = 1.01 USDC.

For custom limits, check `npx -y @subly_fi/pay@0.8.5 setup-link --help` before registration. An existing owner must use [owner management](#manage-the-owner-and-recover-access) to change limits.

```sh
npx -y @subly_fi/pay@0.8.5 setup-link --initial-deposit 1010000 \
  --per-payment-cap 10000 --daily-api-cap 10000 \
  --approval-threshold 10000 --daily-deposit-cap 1010000 --ttl-days 30
```

This example sets a 0.01 USDC per-payment and rolling 24-hour API cap, a 1.01 USDC rolling 24-hour deposit cap, and a 30-day mandate. Choose your limits before generating the link. The client's payment cap and the owner's mandate are separate controls.

Without explicit setup flags, the relayer defaults are 10 USDC per payment, 100 USDC per rolling 24 hours, 3,000 USDC of deposits per rolling 24 hours and owner approval above 1 USDC, with a 365-day mandate. Both examples leave the payee allowlist and monthly cap unset and allow normal withdrawals without owner approval.

The setup CLI and MCP tool cannot set the payee allowlist, monthly cap or deposit/withdrawal policy. If you need these controls before depositing, omit `--initial-deposit`, complete setup, then apply them with [owner management](#manage-the-owner-and-recover-access). A subsequent deposit requires its own approval. A replacement setup does not inherit an old mandate's restrictions; inspect every returned policy field.

Open the returned `setupUrl`, review the wallet, vault and limits, then approve with your passkey or owner wallet. Keep this link private: whoever completes initial setup becomes the owner. The link expires in 10 minutes. A `http://localhost/...` link must be opened in a browser on the machine running the relayer; it does not point to that machine from a phone or another computer. Preserve the hostname used to register the passkey.

Return to the terminal and replace the example ID with the returned `sessionId`:

```sh
npx -y @subly_fi/pay@0.8.5 setup-status st_YOUR_SESSION_ID
```

Continue only when `status` is `completed`. For the bundled first deposit above, also confirm that `initialDepositApproval` is approved. If you omitted the initial deposit or replaced an existing owner, this field is absent; the deposit will request a separate approval. For `pending`, finish browser approval. For `expired`, create a new link. Browser approval does not run the deposit; submit the **same amount** within the approval's roughly 15-minute lifetime:

```sh
npx -y @subly_fi/pay@0.8.5 deposit 1010000
```

A successful deposit prints `status: confirmed`. Keep its `depositId`. If it remains `submitted`, use [status](#check-an-interrupted-deposit-or-withdrawal) before doing anything else.

```sh
npx -y @subly_fi/pay@0.8.5 budget
```

Read `spendableYieldRawUsdc` in the budget result. **A new deposit is not an immediate payment budget.** Only accrued yield can pay for APIs; wait until it covers the price and fees. There is no guaranteed waiting time. The 1.01 USDC example demonstrates a deposit, not an immediate paid call. A budget read can return the last synced view if refresh fails.

### 5. Call a paid API

Obtain a real URL from a seller offering **Solana mainnet USDC `exact` with `extra.feePayer`**. Replace this placeholder:

```sh
npx -y @subly_fi/pay@0.8.5 fetch https://seller.example.com/paid-resource
```

The default cap is **0.01 USDC**. To allow up to 0.02 USDC:

```sh
npx -y @subly_fi/pay@0.8.5 fetch https://seller.example.com/paid-resource 20000
```

Raising the client cap does not raise owner limits: the setup example above still refuses a price over 0.01 USDC until the owner updates the policy. Confirm the seller's method and request schema before calling a paid endpoint; a seller may charge even when it returns an application error. Success returns `"paid": true`, an HTTP 2xx `status` and the response `body`. For `paid: false`, read the reason or HTTP response.

If the result says `approval_required`, open `approveUrl`, approve, then repeat the **same request and cap** with its `approvalId`:

```sh
npx -y @subly_fi/pay@0.8.5 fetch https://seller.example.com/paid-resource 20000 apr_YOUR_APPROVAL_ID
```

### 6. Withdraw

This requests 1 USDC back to the **same agent wallet**, subject to liquidity, fees and owner policy:

```sh
npx -y @subly_fi/pay@0.8.5 withdraw 1000000
```

Success prints `status: confirmed`. Keep its `withdrawalId`. If owner approval is required, open the returned `approveUrl`, approve, then repeat the same amount with its `approvalId`:

```sh
npx -y @subly_fi/pay@0.8.5 withdraw 1000000 apr_YOUR_APPROVAL_ID
```

Later deposits use the same pattern: append the returned approval ID to the original deposit command. Each ID is valid only for its exact operation.

### Check an interrupted deposit or withdrawal

Use the original wallet, vault and relayer. Replace this ID with the original `depositId` (`dep_...`) or `withdrawalId` (`wdr_...`):

```sh
npx -y @subly_fi/pay@0.8.5 status wdr_YOUR_WITHDRAWAL_ID
```

This checks the operation without sending another transaction; it requires relayer 0.8.0+. Exit zero only means the lookup worked.

| Result | Next step |
| --- | --- |
| `status: confirmed` / `nextAction: done` | Check `actualAmountRawUsdc` and `txSignature`. |
| `status: submitted` / `nextAction: check_again` | Check the same ID later. Do not repeat the operation. |
| `status: prepared` or `nextAction: reconcile_with_operator` | Keep the ID and ask the operator to reconcile before a new operation. |

## MCP configuration

Complete the wallet and connection steps above. Configure your host to run `npx -y @subly_fi/pay@0.8.5 mcp` with the same environment. The server uses stdio; it does not open a web page or listen on an HTTP port.

For hosts accepting `mcpServers`, use this template. Replace every example value with an absolute path or real URL. JSON does not expand `$HOME` or other shell variables.

```json
{
  "mcpServers": {
    "subly": {
      "command": "npx",
      "args": ["-y", "@subly_fi/pay@0.8.5", "mcp"],
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

Desktop apps may not inherit terminal exports. Supply variables to the MCP process and restart the host. Use the **same pending-state file** as the CLI for the same wallet. For Windows, escape paths (`C:\\Users\\your-name\\...`) and follow the host's `npx.cmd` launcher instructions.

Codex uses a different configuration format. Follow your host's MCP settings or use the [AI setup prompts](https://github.com/SublyFi/subly-payment-protocol/blob/main/docs/ai-setup-prompts.md).

Confirm the host exposes **13 Subly tools**. Ask the agent to list vaults and create a setup link. After browser approval, tell it to check setup status and continue. Selecting another vault does not move funds; each vault requires its own owner setup.

## Configuration

| Variable | Meaning |
| --- | --- |
| `SUBLY_RELAYER_URL` | Your operator's HTTPS URL. Set explicitly. |
| `SOLANA_RPC_URL` | Trusted mainnet RPC. The default public RPC is rate limited. |
| `SUBLY_DEMO_AGENT_KEYPAIR_PATH` | Absolute path to a 64-byte Solana JSON keypair. |
| `SUBLY_DEMO_AGENT_KEYPAIR` | Alternative base58 64-byte secret; overrides the file. Keep secrets out of chat and shell history. |
| `SUBLY_SIGNER_PROVIDER` | `local` (default), `circle` or `privy`. |
| `SUBLY_VAULTS_FILE` | Reviewed local vault catalogue; defaults to the built-in vault. |
| `SUBLY_VAULT_ADDRESS` | Selected catalogue vault. Custom single-vault settings also require matching share mint and farm settings. |
| `SUBLY_MCP_MAX_AMOUNT_RAW_USDC` | Payment cap; default `10000` (0.01 USDC). |
| `SUBLY_MCP_STATE_PATH` | Pending-payment file; default `~/.subly/standard-x402-pending.json`. Share one file across CLI/MCP clients for the same wallet. Different machines do not coordinate payments. |
| `SUBLY_PAY_METHOD` / `SUBLY_PAY_BODY` | HTTP method and body for CLI `fetch`; MCP accepts tool arguments. |

For Circle, set `SUBLY_SIGNER_PROVIDER=circle` and `CIRCLE_API_KEY`, `CIRCLE_ENTITY_SECRET`, `CIRCLE_WALLET_ID`. For Privy, set `SUBLY_SIGNER_PROVIDER=privy` and `PRIVY_APP_ID`, `PRIVY_APP_SECRET`, `PRIVY_WALLET_ID`, plus `PRIVY_AUTHORIZATION_KEY` when required by wallet ownership. Each credential accepts a `SUBLY_` prefix, which takes precedence. Both require a Solana mainnet wallet and need no local keypair. See [provider details](https://github.com/SublyFi/subly-payment-protocol/blob/main/docs/agent-wallet-providers.md).

## Manage the owner and recover access

Requires client and relayer **0.8.3+**. Keep the original operator domain, wallet and vault.

```sh
npx -y @subly_fi/pay@0.8.5 recovery-status
npx -y @subly_fi/pay@0.8.5 owner-link --per-payment-cap 2000000
```

The cap is an example. Open `ownerUrl` and approve with the **existing** passkey or owner wallet, then check the returned session ID:

```sh
npx -y @subly_fi/pay@0.8.5 owner-status st_YOUR_SESSION_ID
```

Omitted policy fields and the existing expiry stay unchanged. Use `npx -y @subly_fi/pay@0.8.5 owner-link --help` for options; set `--ttl-days` to renew an expired policy. Reactivating without a new TTL does not renew an expired mandate. Expiry falls back to the relayer's default policy; it is not a spending freeze. Policy changes invalidate old approvals, including an unused initial-deposit approval, and do not approve a new deposit.

Use `--allowed-payees` with comma-separated verified seller Solana addresses, `--monthly-api-cap` for a rolling 30-day ceiling, and `--withdrawal-policy owner_approval_required` when withdrawals need owner approval. Obtain payee addresses from the seller's official configuration and review the proposed policy on the owner page. `--allowed-payees any` removes the allowlist and cap value `none` removes that ceiling. Approval never raises an absolute cap or bypasses the payee list. The daily caps use rolling 24-hour windows, not a midnight reset; the requested amount plus previous usage may equal the cap. API usage counts confirmed yield realizations, even when the later seller payment fails.

The owner page also supports revocation, reactivation and recovery cancellation. Links expire after 10 minutes or a policy change.

If the owner credential is lost:

```sh
npx -y @subly_fi/pay@0.8.5 recovery-start
npx -y @subly_fi/pay@0.8.5 recovery-status
```

After the **72-hour** deadline, wait for `effectiveStatus: recovery_elapsed`, then use `setup-link` to register a new owner. The current owner can cancel recovery. Explicitly revoked mandates require the **same owner** to restore access. If that credential and its backup are lost, contact the operator; preserve the wallet key and ledger.

## Recovery and troubleshooting

- **Unknown payment outcome:** preserve pending-state JSON. Investigate the seller/facilitator outcome before paying again. Never delete state or force a new payment to bypass uncertainty.
- **Interrupted yield withdrawal:** retry the same request with the same wallet, vault, relayer, method, body and headers. Its saved checkpoint resumes the original withdrawal. If no withdrawal ID was saved or the withdrawal failed, ask the operator to reconcile. Do not downgrade while it is pending.
- **State locked after a crash:** stop all clients using the file before removing only a stale `.lock`. Preserve the JSON.
- **Deposit or withdrawal interrupted:** check the original ID with `status`; do not repeat the financial operation.
- **Withdrawal preview failed:** check RPC simulation support and liquidity. Do not disable validation.

Yield withdrawal and seller payment are separate transactions. If payment fails afterward, withdrawn USDC may remain in the agent wallet.

[Full troubleshooting](https://github.com/SublyFi/subly-payment-protocol/blob/main/docs/troubleshooting.md) · [Support](https://github.com/SublyFi/subly-payment-protocol/blob/main/SUPPORT.md)

## Build from source

From the repository root:

```sh
npm ci --ignore-scripts
npm ci --prefix packages/pay --ignore-scripts
npm run check --prefix packages/pay
node packages/pay/dist/cli.js --version
node packages/pay/dist/cli.js --help
npm run test:package
```

Replace `npx -y @subly_fi/pay@0.8.5` in this guide with `node packages/pay/dist/cli.js`. For MCP, run `node` with the absolute path to that file and `mcp`. A compatible relayer is still required.

`test:package` checks a packed installation and the MCP handshake. See [validation records](https://github.com/SublyFi/subly-payment-protocol/blob/main/docs/validation.md) for the scope of completed checks.
