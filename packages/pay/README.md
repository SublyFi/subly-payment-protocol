# @subly_fi/pay

Subly client for [x402](https://x402.org)-style HTTP payments funded by
**Kamino vault yield** — your agent pays for paywalled APIs from the yield on
deposited USDC, and the principal is never spent. Non-custodial: it signs
locally with your own Solana key; Subly never holds it.

Current payments target standard x402 sellers that offer a Solana USDC `exact`
rail with facilitator `extra.feePayer` support (meaning the seller side
sponsors the payment transaction's network fee — true of common facilitators
such as PayAI and Coinbase CDP).

Ships one `pay` dispatcher bin with subcommands, all runnable with `npx` (no clone):

- `pay mcp` — an MCP server (Claude Code, Cursor, any MCP client) exposing
  the full lifecycle as tools: `create_subly_setup_link` /
  `check_subly_setup` (owner onboarding: the human approves the spending
  mandate + first deposit with one Face ID), `deposit_to_subly_vault`,
  `get_subly_yield_budget`, `fetch_with_subly_payment`,
  `withdraw_from_subly_vault`. Payments above the owner's approval
  threshold, deposits, and (when the mandate opts in) withdrawals return an
  `approveUrl` to paste into chat; retry with the `approvalId` once the
  human approved.
- `pay fetch <url> [maxAmountRawUsdc] [apr_<approvalId>]` — one-shot: pay for
  a URL, print the receipt (used by the OpenClaw skill); retry with the
  `apr_...` id after an `approval_required` refusal
- `pay deposit <amountRawUsdc> [apr_...]` / `pay withdraw <amountRawUsdc>
  [apr_...]` — vault deposit / withdraw with the same owner-approval flow
- `pay setup-link [--initial-deposit <raw>] [--approval-threshold <raw>] ...`
  / `pay setup-status <st_sessionId | setupUrl>` — owner onboarding for
  CLI/skill harnesses (same flow as the MCP setup tools)

## Wallet

Subly does not create wallets — bring your own Solana keypair (`solana-keygen`
ships with the [Solana CLI](https://docs.anza.xyz/cli/install)):

```bash
solana-keygen new --no-bip39-passphrase -o ~/.subly/agent.json
export SUBLY_DEMO_AGENT_KEYPAIR_PATH=~/.subly/agent.json
```

Or bring a custody-held agent wallet — the key then never touches this
machine; every signature is requested from the provider's API and verified
locally before use:

```bash
# Circle developer-controlled wallet (a Solana wallet in your wallet set):
export SUBLY_SIGNER_PROVIDER=circle
export CIRCLE_API_KEY=... CIRCLE_ENTITY_SECRET=... CIRCLE_WALLET_ID=...

# Privy server wallet (Solana), incl. agentic wallets owned by an
# authorization key — pass that key so requests carry the required
# privy-authorization-signature:
export SUBLY_SIGNER_PROVIDER=privy
export PRIVY_APP_ID=... PRIVY_APP_SECRET=... PRIVY_WALLET_ID=...
export PRIVY_AUTHORIZATION_KEY=wallet-auth:...   # only for owner-key wallets
```

Each Circle/Privy credential var also accepts a `SUBLY_`-prefixed form (e.g.
`SUBLY_CIRCLE_API_KEY`) that wins over the plain one, so Subly can use a
different credential than other tooling on the same machine. Note the
`circle` CLI "agent wallet" (email + OTP) is a different Circle product that
exposes no signing API and cannot be used here.

Send USDC (Solana mainnet) to the printed address — no SOL needed, fees are
sponsored — then deposit (vault minimum is just over 1 USDC: share rounding
refuses exactly 1.000000; deposit self-registers the wallet):

```bash
npx -y @subly_fi/pay deposit 1010000   # 1.01 USDC
```

## Use it

```bash
# Claude Code (no clone):
claude mcp add subly -- npx -y @subly_fi/pay mcp

# One-shot pay (also what the OpenClaw skill calls):
npx -y @subly_fi/pay fetch https://seller.example.com/api/premium
```

### Claude Desktop

Prerequisites: [Node.js](https://nodejs.org) 20+ installed, and an agent
keypair (see [Wallet](#wallet) above).

1. Open the config file (create it if it does not exist):
   - macOS: `~/Library/Application Support/Claude/claude_desktop_config.json`
   - Windows: `%APPDATA%\Claude\claude_desktop_config.json`

   Or in the app: **Settings → Developer → Edit Config**.

2. Add the `subly` server. Claude Desktop is a GUI app and does **not**
   inherit your shell environment (`.zshrc`, `.env` files), so every
   variable must go in the `env` block:

   ```json
   {
     "mcpServers": {
       "subly": {
         "command": "npx",
         "args": ["-y", "@subly_fi/pay", "mcp"],
         "env": {
           "SUBLY_DEMO_AGENT_KEYPAIR_PATH": "/Users/you/.subly/agent.json"
         }
       }
     }
   }
   ```

   Use an absolute path for the keypair (`~` is not expanded). For a
   custody wallet, replace the keypair var with the `circle` / `privy`
   variables from [Environment](#environment). Optional vars
   (`SUBLY_MCP_MAX_AMOUNT_RAW_USDC`, `SOLANA_RPC_URL`, …) go in the same
   `env` block.

3. Restart Claude Desktop (quit fully, then reopen). The tools icon under
   the chat input should now list **subly-payments** with the tools above.

   If the server fails to start, the usual cause is that Claude Desktop
   cannot find `npx` (e.g. Node installed via nvm). Point `command` at the
   absolute path instead — run `which npx` in a terminal and use that
   value, e.g. `"command": "/opt/homebrew/bin/npx"`.

4. Use it by chatting. First time: "set up Subly" walks you through the
   owner setup link (spending mandate + first deposit). After that,
   asking for anything behind an x402 paywall ("fetch
   https://seller.example.com/api/premium") pays from vault yield
   automatically and returns the response plus a payment receipt.
   Payments above the owner's approval threshold return an `approveUrl` —
   open it in a browser, approve, then tell Claude to retry.

   Claude Desktop asks for permission on each first tool use. The permission
   prompt is effectively your payment confirmation: "Allow always" on
   `fetch_with_subly_payment` removes that human check and relies entirely on
   the spending-mandate caps — keep per-use approval for payments, and reserve
   "Allow always" for read-only tools like `get_subly_yield_budget`.

## Environment

| Var | Required | Default |
|---|---|---|
| `SUBLY_SIGNER_PROVIDER` | no | `local` (`circle` / `privy` for custody wallets) |
| `SUBLY_DEMO_AGENT_KEYPAIR_PATH` | with `local` (or `SUBLY_DEMO_AGENT_KEYPAIR` base58) | — |
| `CIRCLE_API_KEY` / `CIRCLE_ENTITY_SECRET` / `CIRCLE_WALLET_ID` | with `circle` | — |
| `PRIVY_APP_ID` / `PRIVY_APP_SECRET` / `PRIVY_WALLET_ID` | with `privy` | — |
| `PRIVY_AUTHORIZATION_KEY` | only for owner-key (agentic) Privy wallets | — |
| `SUBLY_RELAYER_URL` | no | `https://api.demo.sublyfi.com` |
| `SOLANA_RPC_URL` | no | public mainnet RPC |
| `SUBLY_MCP_MAX_AMOUNT_RAW_USDC` | no | `10000` (0.01 USDC) per-payment cap |
| `SUBLY_MCP_STATE_PATH` | no | `~/.subly/standard-x402-pending.json` (pending-payment store, double-payment protection) |
| `SUBLY_PAY_METHOD` / `SUBLY_PAY_BODY` | no (`pay fetch` only) | `GET` / — (JSON body for POST-body sellers) |
| `SUBLY_PAY_FORCE_NEW_PAYMENT` | no (`pay fetch` only) | unset (`1` forces a fresh payment — may double-pay) |
| `CIRCLE_BASE_URL` / `PRIVY_BASE_URL` | no | provider API defaults |

Requests authenticate with a signature from your wallet key — there is no API
token. `SUBLY_FACILITATOR_URL` is still accepted as a legacy fallback for
`SUBLY_RELAYER_URL`. Spending is bounded twice: the client cap, and the
relayer's server-side guard that refuses to realize anything beyond the
spendable yield — the deposited principal is never touched by a payment.
(A plain `pay withdraw` is the exit path and may of course move principal
back to your wallet.)
