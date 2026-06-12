---
name: subly-beta-setup
description: Subly クローズドβのセットアップを対話的に進める。参加者が「βのセットアップ」「subly を使えるようにして」などを依頼したときに使う。
---

# Subly closed-beta setup

You are helping a beta participant set up Subly agent payments (an agent
pays for paid APIs from Kamino vault yield; the principal is never spent).
Full participant docs: `docs/beta-guide.md`.

There is NO API token and NO operator pre-registration: requests are
authenticated by the wallet's own signature (same principle as standard
x402), and the wallet self-registers at the facilitator on first use.

## Steps

1. Optionally ask the user for their own Solana RPC URL (a free
   Alchemy/Helius endpoint). If they don't have one, the public RPC is fine
   for the beta — just skip the question.
2. Run the setup script (non-interactive when env values are set):

   ```bash
   SOLANA_RPC_URL=<rpc url or omit> bash demo/setup-beta.sh
   ```

   It installs deps, generates the agent keypair (`demo/env/keys/agent-beta.json`),
   writes `demo/env/buyer.mainnet.env`, and registers the `subly` MCP server
   in Claude Code. It is idempotent.
3. Show the user their AGENT WALLET ADDRESS printed by the script and tell
   them to send USDC (mainnet, recommended 50–500 USDC) to it. No SOL is
   needed — fees are sponsored.
4. After the USDC arrives, run the deposit (amount in raw units, 6 decimals).
   This also auto-registers the wallet at the facilitator:

   ```bash
   source demo/env/buyer.mainnet.env && npm run demo:deposit -- <amountRawUsdc>
   ```

5. Tell the user that yield must accrue before the first payment (hours,
   depending on deposit size — see the table in `docs/beta-guide.md`).
6. The MCP tool `fetch_with_subly_payment` becomes available in the NEXT
   Claude Code session (after approving the `subly` server). The user can
   then ask Claude to fetch the paid demo API URL from their invite.

## Guardrails

- NEVER print, read, or transmit the contents of `demo/env/keys/*.json`
  (private keys). Only the wallet address printed by the script is shared.
- Do not raise `SUBLY_MCP_MAX_AMOUNT_RAW_USDC` unless the user explicitly
  asks after understanding it is a per-call payment cap.
- If a payment tool call fails, read the error's `reason` field; the
  troubleshooting table in `docs/beta-guide.md` maps each reason to an
  action. In particular `delivery_failed_payment_pending` means: call the
  same URL again — do NOT treat it as unpaid.
