# Getting started with Subly

Subly is open-source software that lets an agent pay compatible APIs using yield from a Kamino USDC vault on Solana. A vault is where the USDC is invested. **Version 0.8.3 is beta software** and has not had an external security audit. Mainnet deposits and withdrawals use real funds; neither principal nor yield is guaranteed.

Choose how much infrastructure you want to manage.

| What you want to do | Start here | Expected result |
| --- | --- | --- |
| Use an operator's relayer from an AI assistant or CLI | [Use an existing relayer](#use-an-existing-relayer), then [prompt A](ai-setup-prompts.md#a-use-an-existing-relayer) | Local client configuration, connection checks and owner setup preparation |
| Run your own relayer | [Operate a relayer](#operate-a-relayer), then [prompt B](ai-setup-prompts.md#b-operate-your-own-relayer) | A relayer at your own URL, a database, HTTPS and operational preparation |
| Explore the API without funds | [Local development](../README.md#try-it-locally) | A detached API; deposits, withdrawals and payments are unavailable |
| Contribute to the implementation | [Contributor guide](../CONTRIBUTING.md) | Development environment and tests |

The official repository is [SublyFi/subly-payment-protocol](https://github.com/SublyFi/subly-payment-protocol). This guide describes the 0.8.3 source candidate. Verify both `pay-v0.8.3` and npm availability before using a published release. Until then, use the reviewed checkout's [source-build instructions](../packages/pay/README.md#run-an-unpublished-source-checkout). The [client guide](../packages/pay/README.md) and [operator guide](../deploy/README.md) contain the canonical commands and configuration.

## Use an existing relayer

Start by checking which prerequisites you already have.

| Requirement | What to check |
| --- | --- |
| A computer with Node.js 24+ | Use the launch method appropriate for macOS, Windows or Linux |
| A trusted relayer's HTTPS URL | Obtain it from your chosen operator. No Subly account is needed; do not assume a permanent free public relayer is available |
| A dedicated agent wallet | Local Solana keypairs, Circle and Privy are supported. Subly does not automatically create or fund the wallet |
| Mainnet RPC configuration | The endpoint must support the simulation and inner instructions needed for transaction checks before signing |
| Reviewed vault information | Local configuration must match the operator's metadata. Choose the vault yourself when several are available |
| An owner passkey or separate owner wallet | You personally review and approve spending conditions |
| An MCP host or the CLI | Check whether the app can launch a local stdio MCP server. A ChatGPT conversation without connected tools cannot do this alone |

**Do not paste private keys, seed phrases or API keys into AI chat.** An RPC URL may also contain credentials. Give the assistant file locations or configuration status, and enter secrets privately. [Prompt A](ai-setup-prompts.md#a-use-an-existing-relayer) helps an assistant work through missing details. Without terminal access, it can only guide you.

Create new keys in your own terminal, outside AI output capture. `solana-keygen new` displays a recovery seed by default; do not paste its output or a screenshot into chat.

The path to a first payment is:

1. **Configure and check the connection.** Pin version 0.8.3. Run `npx -y @subly_fi/pay@0.8.3 doctor`, check the vault list, and verify tool discovery if using MCP. Keep the wallet, vault, relayer and pending file path consistent between CLI and MCP. Configuration locations and JSON formats depend on the host app.
2. **Register your spending policy.** Choose the vault, initial deposit amount, limits, approval conditions and expiry, then create a setup link. Review it on the correct operator domain and approve personally with your passkey or owner wallet. Return to chat and tell the assistant you have approved so it can call `check_subly_setup`. From the CLI, use `npx -y @subly_fi/pay@0.8.3 setup-status <sessionId>`. Asking an assistant to set up Subly does not replace your approval.
3. **Deposit an amount you authorized.** Obtain mainnet USDC, confirm the vault and amount, then make the deposit. Initial setup can include deposit approval, but execution is a separate step. Example amounts are not recommendations. `1000000` raw USDC equals 1 USDC.
4. **Wait for spendable yield.** A new deposit does not necessarily create a payment budget immediately. Use `npx -y @subly_fi/pay@0.8.3 budget` to check that spendable yield covers the price and fees. Repeated retries do not produce yield.
5. **Pay a compatible API.** The seller must offer x402 Solana mainnet USDC `exact` with `extra.feePayer`. Arbitrary URLs and other chains are not supported. The default client cap is 0.01 USDC per payment; your owner policy may be stricter.
6. **Withdraw when needed.** A withdrawal can include principal and returns funds to the same agent wallet. Liquidity, fees and owner approval conditions may limit it.

A working configuration is separate from a completed real-fund transaction. MCP connectivity or a successful `doctor` check does not establish successful deposits, withdrawals or payments, or vault safety.

## Ownership and approvals

The agent wallet signs transactions; the owner approves spending conditions. A passkey approves the policy enforced by the relayer, rather than adding a second on-chain signature to every payment. It does not stop someone holding the agent key from transacting outside Subly. Use a dedicated wallet and an operator you trust.

The first person to complete initial setup becomes the owner for that wallet/vault pair. Keep setup and approval links private. Setup links expire after ten minutes, and initial deposit approval also expires shortly afterward. Follow the current procedure again when an approval has expired.

Passkeys bind to the operator's domain. Access may not carry over immediately when devices or domains change. Changes to an active policy require the same owner's approval, and recovery has limitations including a 72-hour grace period. Revocation also blocks withdrawals through the relayer and cannot cancel an already broadcast transaction. Expired mandates fall back to the default policy; they are not an on-chain freeze. See the [security model](security-model.md).

Client and relayer 0.8.3+ provide `owner-link` for current-owner policy changes, reactivation, revocation and recovery cancellation. `recovery-start` / `recovery-status` expose the existing 72-hour lost-credential process. Explicit revocation still requires the same owner to restore access. See [owner management](../packages/pay/README.md#manage-the-owner-and-recover-access); repeating initial setup cannot override the existing owner.

Selecting another vault does not move funds. Policies, principal and yield are separate for each wallet/vault pair. Select the original vault again to withdraw from it.

## If an operation stops

`submitted` does not mean a transaction has failed. Repeating a deposit or withdrawal that is still awaiting confirmation can create a separate transaction.

| Situation | Next step |
| --- | --- |
| Deposit or withdrawal awaits confirmation | Keep the original `dep_...` / `wdr_...` ID. Use `npx -y @subly_fi/pay@0.8.3 status <intentId>` or MCP `check_subly_vault_operation` with the original wallet, vault and relayer. Relayer 0.8.0+ supports reconciling without rebroadcasting |
| Payment stops while realizing yield | Preserve pending JSON and follow the [recovery procedure](../packages/pay/README.md#recovery-and-troubleshooting) to resume or reconcile the original operation |
| External API payment outcome is unknown | Do not pay again. Check the original outcome with the seller, facilitator and operator |
| `insufficient_yield` | Check spendable yield and wait. Do not reclassify principal as a payment budget |

Do not bypass the pending record by deleting it, selecting another state file or forcing a new payment. Yield realization and the API payment are separate transactions, so USDC may remain in the wallet after an API payment fails. Follow the [troubleshooting guide](troubleshooting.md).

## Operate a relayer

Running a relayer adds server operations to client setup. The relayer sponsors vault transaction fees and stores principal/yield accounting in PostgreSQL. It has a different role from the seller's x402 facilitator.

You need a host with Docker Compose, your own domain and HTTPS, dedicated mainnet RPC, Pyth pricing configuration, a sponsor wallet funded with SOL, a persistent database and backups. In [prompt B](ai-setup-prompts.md#b-operate-your-own-relayer), specify whether this is a new installation or an upgrade.

Work through environment checks, tagged source and secret file placement, vault catalogue review, HTTPS/database startup, read-only validation, backups and monitoring. Detailed steps are in the [operator guide](../deploy/README.md). Do not initialize an existing database or overwrite its configuration. Keep vaults with existing funds in the catalogue.

Funding, LUT creation, invest, real deposits/withdrawals and paid API tests require an agreed target and amount or fee budget. Not every vault needs an extra LUT. Gas and account creation fees are operating costs. Current fee-debt accounting adjusts the spending budget; it does not reimburse the operator or collect revenue.

Health/readiness checks, read-only validation, a disposable local fork and real-fund mainnet tests establish different things. Read the [validation status](validation.md) and do not advertise a check as completed if you have not performed it in your deployment.

For help, record the version, error code and stage where the operation stopped, remove secrets, and use [support](../SUPPORT.md). Report security issues through the [private reporting process](../SECURITY.md).
