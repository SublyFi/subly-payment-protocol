---
name: subly-beta-setup
description: Subly クローズドβのセットアップを対話的に進める。参加者が「βのセットアップ」「subly を使えるようにして」などを依頼したときに使う。
---

# Subly closed-beta setup

You are helping a beta participant set up Subly agent payments (an agent
pays for paid APIs from Kamino vault yield; the principal is never spent).
Full participant docs: `docs/beta-guide.md`.

## Steps

1. Ask the user for the two values they received from the operator-provided
   invite, plus their own RPC endpoint:
   - client API token
   - (optional) facilitator URL — default `https://api.demo.sublyfi.com`
   - their Solana RPC URL (a free Alchemy/Helius endpoint works)
2. Run the setup script non-interactively with those values:

   ```bash
   SUBLY_CLIENT_API_TOKEN=<token> SOLANA_RPC_URL=<rpc url> bash demo/setup-beta.sh
   ```

   It installs deps, generates the agent keypair (`demo/env/keys/agent-beta.json`),
   writes `demo/env/buyer.mainnet.env`, and registers the `subly` MCP server
   in Claude Code. It is idempotent.
3. Show the user the printed AGENT PUBLIC KEY and tell them to send it to
   the operator, then send USDC (mainnet, recommended 50–500 USDC) to that
   address. No SOL is needed — fees are sponsored.
4. After the USDC arrives, run the deposit (amount in raw units, 6 decimals):

   ```bash
   source demo/env/buyer.mainnet.env && npm run demo:deposit -- <amountRawUsdc>
   ```

5. Tell the user to notify the operator that they deposited (the operator
   activates payments), and that yield must accrue before the first payment
   (hours, depending on deposit size — see the table in `docs/beta-guide.md`).
6. The MCP tool `fetch_with_subly_payment` becomes available in the NEXT
   Claude Code session (after approving the `subly` server). The user can
   then ask Claude to fetch the paid demo API URL from their invite.

## Guardrails

- NEVER print, read, or transmit the contents of `demo/env/keys/*.json`
  (private keys). Only the public key printed by the script is shared.
- Do not raise `SUBLY_MCP_MAX_AMOUNT_RAW_USDC` unless the user explicitly
  asks after understanding it is a per-call payment cap.
- If a payment tool call fails, read the error's `reason` field; the
  troubleshooting table in `docs/beta-guide.md` maps each reason to an
  action. In particular `delivery_failed_payment_pending` means: call the
  same URL again — do NOT treat it as unpaid.
