# @subly_fi/pay

CLI and stdio MCP client for paying compatible x402 APIs with Kamino USDC vault yield on Solana. MIT licensed. Works with your own [Subly relayer](https://github.com/SublyFi/subly-payment-protocol/tree/main/deploy); no Subly account is required.

Version 0.7 is beta software and has not had an external security audit. Vault operations use real mainnet funds. Yield accounting and owner policies depend on your relayer operator. Read the [security model](https://github.com/SublyFi/subly-payment-protocol/blob/main/docs/security-model.md).

## Quick start

You need **Node.js 24+**, a Solana agent wallet with mainnet USDC, a trusted relayer URL, and a mainnet RPC endpoint that supports transaction simulation with inner instructions. Your wallet can be a local keypair or a supported custody signer. The owner who approves spending controls can use a passkey or a separate Solana wallet.

```bash
npx -y @subly_fi/pay@0.7.0 --help
export SUBLY_RELAYER_URL=https://your-relayer.example.com
export SOLANA_RPC_URL=https://your-mainnet-rpc.example.com
export SUBLY_DEMO_AGENT_KEYPAIR_PATH=/absolute/path/to/agent.json
npx -y @subly_fi/pay@0.7.0 doctor
npx -y @subly_fi/pay@0.7.0 vaults
```

Use an existing dedicated agent wallet, or create one with `solana-keygen new -o agent.json`. Keep its recovery material private and restrict the file to its owner (`chmod 600 agent.json`). Fund its public address with **USDC on Solana mainnet**. Subly does not create or fund wallets. Vault fees require a funded relayer sponsor; the final API payment requires the seller's facilitator fee payer.

1. Review the selected vault, its curator, fees and liquidity. For a catalogue supplied by your operator, install the reviewed file locally and set `SUBLY_VAULTS_FILE=/absolute/path/vaults.json`. `SUBLY_VAULT_ADDRESS` selects one listed vault for CLI commands. Never install transaction trust anchors merely because a remote response says to.
2. Create an owner setup link. This example pre-approves a **1.01 USDC** deposit; the selected vault's minimum can differ:

   ```bash
   npx -y @subly_fi/pay@0.7.0 setup-link --initial-deposit 1010000
   ```

   Open the returned `setupUrl`, review the wallet, vault and limits, then approve with your passkey or wallet. Links expire in 10 minutes. Treat setup and approval links as private capabilities. The first person completing an initial setup becomes the owner for that wallet/vault.
3. Check completion and deposit promptly; initial deposit approval lasts about 15 minutes:

   ```bash
   npx -y @subly_fi/pay@0.7.0 setup-status <sessionId>
   npx -y @subly_fi/pay@0.7.0 deposit 1010000
   npx -y @subly_fi/pay@0.7.0 budget
   ```

4. Wait until **spendable yield** covers the price and vault fees. A new deposit does not immediately provide a payment budget. Then request a compatible API:

   ```bash
   npx -y @subly_fi/pay@0.7.0 fetch https://seller.example.com/paid-resource
   ```

5. Withdraw funds back to the same agent wallet when needed:

   ```bash
   npx -y @subly_fi/pay@0.7.0 withdraw 1000000
   ```

All amounts are raw USDC integers: `1000000` = 1 USDC. `fetch` defaults to a **0.01 USDC cap**, configurable with `SUBLY_MCP_MAX_AMOUNT_RAW_USDC` or `fetch <URL> <capRawUSDC>`. The owner mandate may set stricter limits. `setup-link --help` lists policy options. A withdrawal can include principal and is subject to liquidity, fees and the owner's policy. A revoked mandate also blocks relayer withdrawals.

A subsequent deposit/payment/withdrawal may return `approvalRequired` with an `approveUrl`. After the owner approves, retry the same operation with the returned `apr_...` as a trailing argument. Never automatically retry a transaction reported as submitted or an API payment with an unknown outcome.

## MCP configuration

Add this to the MCP configuration of your editor or agent host. Replace all example values with your own absolute paths and endpoints. Pinning the version keeps upgrades explicit.

```json
{
  "mcpServers": {
    "subly": {
      "command": "npx",
      "args": ["-y", "@subly_fi/pay@0.7.0", "mcp"],
      "env": {
        "SUBLY_RELAYER_URL": "https://your-relayer.example.com",
        "SOLANA_RPC_URL": "https://your-mainnet-rpc.example.com",
        "SUBLY_DEMO_AGENT_KEYPAIR_PATH": "/absolute/path/to/agent.json",
        "SUBLY_MCP_STATE_PATH": "/absolute/path/to/subly-pending.json",
        "SUBLY_MCP_MAX_AMOUNT_RAW_USDC": "10000"
      }
    }
  }
}
```

Tools: `list_subly_vaults`, `select_subly_vault`, `create_subly_setup_link`, `check_subly_setup`, `deposit_to_subly_vault`, `get_subly_yield_budget`, `withdraw_from_subly_vault`, `fetch_with_subly_payment`. Ask the agent to list vaults and follow owner setup before depositing. Each selected vault has its own mandate and accounting; changing selection never moves funds. Stdio stdout is reserved for MCP messages.

## Configuration

| Variable | Meaning |
| --- | --- |
| `SUBLY_RELAYER_URL` | Chosen operator's HTTPS URL. Set explicitly; the historical demo fallback has no availability promise. |
| `SOLANA_RPC_URL` | Your trusted mainnet RPC; fallback is the rate-limited public mainnet RPC. Used to verify lookup tables and simulate withdrawals before signing. |
| `SUBLY_DEMO_AGENT_KEYPAIR_PATH` | Local Solana 64-byte JSON keypair; the historical `DEMO` name also applies in production. |
| `SUBLY_DEMO_AGENT_KEYPAIR` | Alternative base58 64-byte secret; if set, takes precedence over the file. Avoid putting secrets in shell history. |
| `SUBLY_SIGNER_PROVIDER` | `local` (default), `circle` or `privy`. |
| `SUBLY_VAULTS_FILE` | Reviewed local vault catalogue. Without it, the built-in vault is used. |
| `SUBLY_VAULT_ADDRESS` | Selected catalogue entry (or custom single-vault address with matching share mint/farm settings). |
| `SUBLY_MCP_MAX_AMOUNT_RAW_USDC` | Client payment cap; default `10000`. |
| `SUBLY_MCP_STATE_PATH` | Persistent pending-payment file. Default `~/.subly/standard-x402-pending.json`. Use one shared file for all clients paying from the same wallet. |
| `SUBLY_PAY_METHOD` / `SUBLY_PAY_BODY` | Optional HTTP method and body for CLI `fetch`; MCP accepts these as tool arguments. |

For Circle configure `CIRCLE_API_KEY`, `CIRCLE_ENTITY_SECRET`, `CIRCLE_WALLET_ID`. For Privy use `PRIVY_APP_ID`, `PRIVY_APP_SECRET`, `PRIVY_WALLET_ID`, and `PRIVY_AUTHORIZATION_KEY` when required by wallet ownership. Each accepts a `SUBLY_` prefix which takes precedence. See [provider details](https://github.com/SublyFi/subly-payment-protocol/blob/main/docs/agent-wallet-providers.md).

Only sellers offering **Solana mainnet USDC `exact`** with `extra.feePayer` are supported. EVM, unsupported tokens and unsponsored rails are refused. A supported seller does not need a Subly integration. Yield realization and x402 payment are separate transactions: if the payment fails after realization, USDC may remain in the agent wallet.

## Recovery and troubleshooting

- `doctor` performs read-only configuration, relayer/vault and RPC checks. It never signs or transacts; it does not prove vault safety or available yield.
- A withdrawal preview failure is a refusal to sign. Check your RPC's simulation support and liquidity; do not disable transaction validation.
- Preserve the pending-state JSON across restarts and upgrades. An `external_outcome_unknown` record blocks a second payment until you investigate the seller/facilitator outcome.
- Concurrent clients using the same state file serialize payments with a `.lock` file. After a crash, stop **all** clients using that file before removing only the stale `.lock`. Preserve the JSON. A new file or another machine cannot coordinate with the old one.
- `submitted` means the transaction may still confirm. Poll the original intent ID / transaction instead of preparing another deposit or withdrawal.
- Setup passkeys bind to the operator's domain. Use the original domain and device credential; follow the documented recovery delay if access is lost.

[Full troubleshooting](https://github.com/SublyFi/subly-payment-protocol/blob/main/docs/troubleshooting.md) · [Support](https://github.com/SublyFi/subly-payment-protocol/blob/main/SUPPORT.md) · [Private security reports](https://github.com/SublyFi/subly-payment-protocol/security/advisories/new)

## Build from source

In the repository root: `npm ci`, then `npm ci --prefix packages/pay` and `npm run check --prefix packages/pay`. `npm run test:package` verifies a packed installation from outside the checkout, including the MCP handshake. The published package contains the client only; it does not include the relayer or Kamino server SDK.
