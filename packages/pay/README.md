# @subly_fi/pay

Subly client for [x402](https://x402.org)-style HTTP payments funded by
**Kamino vault yield** — your agent pays for paywalled APIs from the yield on
deposited USDC, and the principal is never spent. Non-custodial: it signs
locally with your own Solana key; Subly never holds it.

Ships one `pay` dispatcher bin with subcommands, all runnable with `npx` (no clone):

- `pay mcp` — an MCP server (Claude Code, Cursor, any MCP client)
- `pay fetch <url>` — one-shot: pay for a URL, print the receipt (used by the
  OpenClaw skill)
- `pay deposit <amountRawUsdc>` / `pay withdraw <amountRawUsdc>` — vault
  deposit / withdraw

## Wallet

Subly does not create wallets — bring your own Solana keypair:

```bash
solana-keygen new --no-bip39-passphrase -o ~/.subly/agent.json
export SUBLY_DEMO_AGENT_KEYPAIR_PATH=~/.subly/agent.json
```

Send USDC (Solana mainnet) to the printed address — no SOL needed, fees are
sponsored — then deposit (vault minimum 1 USDC; deposit self-registers the
wallet):

```bash
npx -y @subly_fi/pay deposit 1000000   # 1 USDC
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
| `SUBLY_FACILITATOR_URL` | no | `https://api.demo.sublyfi.com` |
| `SOLANA_RPC_URL` | no | public mainnet RPC |
| `SUBLY_MCP_MAX_AMOUNT_RAW_USDC` | no | `10000` (0.01 USDC) per-payment cap |

Requests authenticate with a signature from your wallet key — there is no API
token. The cap and the facilitator's yield-budget check both bound spending;
the principal is never touched.
