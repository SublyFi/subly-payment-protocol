---
name: subly-beta-setup
description: Subly クローズドβのセットアップを対話的に進める。参加者が「βのセットアップ」「subly を使えるようにして」などを依頼したときに使う。
---

# Subly closed-beta setup

You are helping a beta participant set up Subly agent payments (an agent pays
for paid APIs from Kamino vault yield; the principal is never spent). Full
participant docs: `docs/beta-guide.md`.

No repo clone, no API token, no operator pre-registration. The client is the
published npm package `@sublyfi/pay`, run via `npx`. Requests authenticate
with the wallet's own signature, and the wallet self-registers at the
facilitator on first deposit / MCP boot.

## Steps

1. Ensure a Solana keypair exists (Subly does NOT create wallets). If the user
   has none, create one with the standard tool:

   ```bash
   mkdir -p ~/.subly && solana-keygen new --no-bip39-passphrase -o ~/.subly/agent.json
   export SUBLY_DEMO_AGENT_KEYPAIR_PATH=~/.subly/agent.json
   ```

   Show the printed public key — that is the agent wallet address. Never read
   or print the private key file.
2. Tell the user to send USDC (Solana mainnet, recommended 50–500 USDC) to that
   address. No SOL needed — fees are sponsored.
3. Deposit into the vault (minimum 1 USDC; this also self-registers the wallet):

   ```bash
   npx -y @sublyfi/pay deposit 100000000   # 100 USDC, in raw units (6 decimals)
   ```

4. Register the MCP server in Claude Code (no clone):

   ```bash
   claude mcp add subly -- npx -y @sublyfi/pay mcp
   ```

5. Tell the user yield must accrue before the first payment (hours, depending
   on deposit size — see the table in `docs/beta-guide.md`). Then in a NEW
   Claude Code session they approve the `subly` server and ask Claude to fetch
   the paid demo API URL from their invite.

## Guardrails

- NEVER read, print, or transmit the agent keypair file. Only the public
  address is shared.
- Do not raise `SUBLY_MCP_MAX_AMOUNT_RAW_USDC` unless the user explicitly asks
  after understanding it is a per-call payment cap.
- On a failed payment, read the error `reason`; the troubleshooting table in
  `docs/beta-guide.md` maps each to an action. `delivery_failed_payment_pending`
  means call the same URL again — do NOT treat it as unpaid.
