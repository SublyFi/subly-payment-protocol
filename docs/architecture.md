# Architecture

Subly is a buyer-side relayer plus a locally signing client. It uses existing Kamino and Solana programs; this repository does not deploy a new on-chain program.

| Component | Responsibility | Source |
| --- | --- | --- |
| Published CLI/MCP | Setup, local/custody signing, x402 seller payments | `packages/pay/`, `src/client/` |
| HTTP API | Wallet-signature auth, owner pages, admin scopes and rate limiting | `src/api/` |
| Domain services | Vault flow state machines, yield budget, owner mandates, reconciliation | `src/domain/` |
| PostgreSQL ledger | Positions, prepared/submitted/terminal intents, approvals, setup sessions | `src/domain/postgres-ledger.ts` |
| Kamino adapter | Read and validate configured vaults, build vault instructions | `src/kamino/` |
| Transaction engine | Simulation, sponsored submission and confirmation | `src/solana/` |

A paid call probes the seller's 402 challenge, validates the rail/price/cap, requests a bound yield withdrawal from the relayer, validates and signs it, then pays through the seller's standard x402 facilitator. These are separate transactions. Recovery retains intent IDs and transaction bytes; a timeout is not proof of failure.

`prepare → submitted → confirmed/failed/expired` transitions and per-wallet/vault database advisory locks protect accounting. Owner approval requests are persisted even though the API returns a 409 refusal requiring human action. Unknown programming/database failures roll back. Mandates and approvals are checked again before sponsor signing.

Vault metadata is a local trust anchor on both sides. The public vault endpoint advertises compatibility; it cannot install signer policy. Different vaults have separate balances, mandates and budgets. Retired catalogue entries must remain available for exits and reconciliation.

Development without an RPC/sponsor is explicitly detached with an in-memory ledger. Production requires an RPC, sponsor, operator authentication and persistent PostgreSQL. Liveness (`/healthz`) and database readiness (`/readyz`) are separate. SIGTERM drains HTTP requests and closes the database pool.

See [API](api.md), [operator guide](../deploy/README.md), and [security boundaries](security-model.md).
