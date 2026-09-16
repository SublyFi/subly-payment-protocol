# Relayer API

The supported user interface is the CLI/MCP client. Integrations can reuse `VaultFlowClient` and `walletAuthHeaders` in `src/client/` from a pinned source checkout; the npm package currently exposes executable commands, not a stable JavaScript library API. Source schemas in `src/api/schemas.ts` and routes in `src/api/server.ts` define the exact wire contract.

## Authentication

Buyer endpoints accept `x-subly-wallet`, `x-subly-signed-at` (Unix milliseconds) and `x-subly-signature` (base58 Ed25519). Sign the UTF-8 message:

```text
subly-api:{UPPERCASE_METHOD}:{path_including_query}:{sha256_hex_exact_body_or_empty}:{signedAtMs}
```

The timestamp must be within five minutes of server time. Serialize the body once, sign those bytes, then send those same bytes. The client helper implements this. TLS remains necessary: this is request authentication, not a globally single-use nonce. A caller may act only on its own wallet. Admin endpoints instead use `Authorization: Bearer <SUBLY_ADMIN_API_TOKEN>`. Never distribute the admin token to clients.

## Main routes

| Method and path | Purpose | Authentication |
| --- | --- | --- |
| `GET /healthz` | Process liveness | Public |
| `GET /readyz` | Ledger schema/database readiness | Public |
| `GET /v1/vaults` | Configured vault metadata | Public |
| `POST /v1/wallets/agent` | Self-register a signing wallet | Wallet/admin |
| `POST /v1/wallets/:wallet/sync` | Refresh from chain (`{"source":"chain"}`) | Wallet/admin; manual values require admin |
| `GET /v1/wallets/:wallet/budget` | Principal/value/yield budget | Wallet/admin |
| `POST /v1/deposits/prepare` | Prepare a deposit | Wallet/admin |
| `POST /v1/deposits/submit` | Submit the exact agent-signed prepared transaction | Wallet/admin + transaction signature |
| `GET /v1/deposits/:depositId` | Read/reconcile deposit status | Wallet/admin |
| `POST /v1/withdrawals/prepare` | Prepare `normal` exit or `yield_realize` | Wallet/admin |
| `POST /v1/withdrawals/submit` | Submit the exact agent-signed prepared transaction | Wallet/admin + transaction signature |
| `GET /v1/withdrawals/:withdrawalId` | Read/reconcile withdrawal status | Wallet/admin |
| `POST /v1/setup-sessions` | Create owner onboarding session | Wallet/admin |
| `GET /v1/setup-sessions/:sessionId` | Read setup status | Capability ID |
| `GET /setup/:sessionId`, `/approve/:approvalId`, `/revoke/:wallet` | Human owner pages | Subsequent actions verify owner credentials |
| `GET /v1/admin/monitoring` | Process counters and sponsor balance | Admin |
| `POST /v1/admin/settlements/recover` | Recover stored pending settlement transactions | Admin |

Prepare bodies include `wallet`, positive integer string `amountRawUsdc`, optional `vault` and optional `approvalId`. A yield realization also binds the intended external payment. Use the client implementation for the full binding rather than inventing values. Submit bodies include the returned intent ID, serialized transaction and agent signature. Poll the same intent ID after a timeout; do not blindly prepare a replacement.

Select a vault with body `vault` for registration/sync/prepare/setup, or `?vault=<address>` for budget/mandate views. Submit/status/approval actions use the vault already bound to the stored intent/session. The [operator guide](../deploy/README.md#api-selection) details all selectors.

## Errors and approvals

Errors use `{"error":{"code":"...","message":"...","details":{...}}}`. A 409 with `deposit_approval_required`, `withdrawal_approval_required` or payment approval information means the owner must approve the returned capability URL. The challenge is durable in PostgreSQL. Retry the same operation with its approval ID after approval. A changed/revoked mandate or expired approval requires a new prepare step; it does not authorize silently changing the operation.

`insufficient_yield`, unavailable liquidity, simulation failure and an unknown external payment outcome are deliberate refusals. [Troubleshooting](troubleshooting.md) explains recovery. `/v1/x402/*` is the disabled-by-default legacy seller rail; new sellers use standard x402 and their own facilitator.
