# Validation status

This records what was exercised on **0.7.2**, source commit
`3d3d719a787da15cd8a0b891594f3006d47be554`, on 2026-09-17. A successful run
checks that configuration and chain state at that time; each operator must
validate their own deployment.

| Check | Evidence and scope |
| --- | --- |
| Automated checks | 387 tests, including PostgreSQL; root/client type checks, builds, package installation, CLI and eight MCP tools. [CI run](https://github.com/SublyFi/subly-payment-protocol/actions/runs/35131509253). |
| Published package | npm Trusted Publishing with provenance; clean registry installation verified 150 package signatures and 56 attestations. [Release](https://github.com/SublyFi/subly-payment-protocol/releases/tag/pay-v0.7.2). |
| Live dependencies | Authenticated Pyth pricing and dedicated mainnet RPC; pinned vault configuration and unsigned withdrawal simulations passed. |
| Real mainnet funds | A small withdrawal and redeposit through the actual HTTP client and relayer both finalized successfully. USDC and share changes matched the confirmed receipts. The two transactions cost 10,002 lamports total (0.000010002 SOL); this is the observed network fee, not a future fee quote or total investment cost. |
| Accounting and authorization | PostgreSQL stored confirmed receipts, chain-derived principal and Pyth-converted fee debt. The exact-amount deposit approval was consumed after confirmation. Records survived a database restart. |
| Principal protection | A fresh ledger conservatively treated the existing vault value as principal. A yield-realization request with insufficient yield was rejected before signing or sending. No artificial yield was introduced on mainnet. |
| Full payment pipeline in a local fork | Generated keys, simulated passkey approval, deposit, synthetic yield fixture, official x402 transport, local seller settlement, v2 receipt report-back and withdrawal. See the [reproducible fork test](../CONTRIBUTING.md#mainnet-fork-integration-test). |

The real-funds run used the same wallet as agent, owner and fee payer, with an
Ed25519 owner signature and a dedicated local relayer/database. It verifies
real chain execution and receipt accounting. It does not verify separate
mainnet sponsor custody, browser passkey UX, an external seller/facilitator,
actual yield-funded payment, or a public relayer deployment. Its temporary
mandate was revoked after the run. Wallet keys, private RPC URLs, database
dumps and wallet-specific evidence are not published in this repository.

The project remains beta and has not undergone an external security audit.
The client production dependency audit passed; four known relayer dependency
advisories remain tracked with mitigations in [dependency status](dependencies.md).

## Repeat the checks for your deployment

1. Run the [automated and local fork checks](../CONTRIBUTING.md), then the
   operator guide's [mainnet validation](../deploy/README.md). The
   `validate:mainnet` command is read-only and never loads a wallet key.
2. With an owner-authorized small amount, use the [client](../packages/pay/README.md)
   against your relayer. Check the wallet, selected vault, network, recipient
   and fee payer before signing. A normal withdrawal returns funds to the
   wallet and may withdraw principal. If funding a redeposit from that
   withdrawal, wait for confirmation and use its actual received amount.
3. Compare confirmed USDC and share deltas with the ledger's receipt, principal
   and fee records. Reopen the database and check those records persist.
   Keep the database backup and transaction references privately.
4. Test a paid API only after the budget shows enough independently accrued
   yield for the payment, vault charges and fee headroom. Follow the
   [operator smoke test](../deploy/README.md). Preserve pending payment state
   during a retry. Never lower the principal baseline to make a real-funds
   payment test pass.

The fork's synthetic yield fixture must remain local. A completed deposit and
withdrawal is not proof of successful yield-funded API payment.
