# @subly_fi/pay

Subly client for [x402](https://x402.org)-style HTTP payments funded by
**Kamino vault yield** — your agent pays for paywalled APIs from the yield on
deposited USDC, and the principal is never spent. Non-custodial: it signs
locally with your own Solana key; Subly never holds it.

Current payments target standard x402 sellers that offer a Solana USDC `exact`
rail with facilitator `extra.feePayer` support.

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
  / `pay setup-status <sessionId>` — owner onboarding for CLI/skill harnesses
  (same flow as the MCP setup tools)

## Wallet

Subly does not create wallets — bring your own Solana keypair:

```bash
solana-keygen new --no-bip39-passphrase -o ~/.subly/agent.json
export SUBLY_DEMO_AGENT_KEYPAIR_PATH=~/.subly/agent.json
```

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

## Environment

| Var | Required | Default |
|---|---|---|
| `SUBLY_DEMO_AGENT_KEYPAIR_PATH` | yes (or `SUBLY_DEMO_AGENT_KEYPAIR` base58) | — |
| `SUBLY_RELAYER_URL` | no | `https://api.demo.sublyfi.com` |
| `SOLANA_RPC_URL` | no | public mainnet RPC |
| `SUBLY_MCP_MAX_AMOUNT_RAW_USDC` | no | `10000` (0.01 USDC) per-payment cap |

Requests authenticate with a signature from your wallet key — there is no API
token. `SUBLY_FACILITATOR_URL` is still accepted as a legacy fallback for
`SUBLY_RELAYER_URL`. Spending is bounded twice: the client cap, and the
relayer's server-side guard that refuses to realize anything beyond the
spendable yield — the deposited principal is never touched by a payment.
(A plain `pay withdraw` is the exit path and may of course move principal
back to your wallet.)
