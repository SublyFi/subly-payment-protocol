# Validation status

## 0.8.3 source candidate — 2026-09-20

The candidate passed 584 tests with disposable PostgreSQL 18.6; the one
Docker Compose backup/restore integration test was skipped because the local
Docker daemon was unavailable. Root/client type checks, builds, documentation
links, clean packed CLI installation and all thirteen MCP tools passed. Chromium
with a virtual WebAuthn authenticator verified reuse of the original credential
for policy changes, recovery cancellation, revocation and reactivation.
PostgreSQL reopening and injected write failures verified that owner actions and
session completion persist together or roll back together.

Sixteen new deposit/withdrawal concurrency regressions exercise the original
public submit/status methods with real disposable signatures and mocked chain
responses. They cover a recovery broadcast followed by delayed simulation failure,
concurrent confirmation, and expired-blockhash reconciliation. A confirmed receipt
remains confirmed; ambiguous outcomes remain pending until reconciled.

The full generated-signer Surfpool 1.3.0 local-fork pipeline also passed:
deposit, synthetic-yield realization from a zero wallet USDC balance, official
x402 client/local seller settlement, verified receipt report-back, and withdrawal.
The recorded principal basis remained unchanged by the payment. This is a local
fixture, not evidence of organically accrued mainnet yield or an external seller.

Live read-only mainnet configuration, authenticated Pyth pricing, and unsigned
normal/yield withdrawal previews passed, including repeated previews after a
delay. The previously preserved position's share total still matched, but its
spendable yield after recorded fee debt was about 0.000393 USDC at observation,
below the proposed 0.01 USDC external payment and required headroom. No real-funds
transaction was sent and no principal baseline was changed. Actual yield-funded
external payment remains outstanding; it must wait for adequate real yield and
an authorized operation. An independent security audit also remains outstanding.

The npm advisory endpoint returned maintenance HTTP 503. Both new audit gates
retried four times and correctly refused to approve release. The latest verified
published version was 0.8.1; its clean registry installation, SHA-512 integrity,
CLI and nine MCP tools passed. The 0.8.3 candidate has not been published. Its
release workflow will verify exact registry installation before creating a
GitHub release; a source tag by itself must not be presented as npm availability.

## 0.8.0 verification — 2026-09-19

The release checks cover the relayer with disposable PostgreSQL, client builds,
clean packed installation and all nine MCP tools. The packed status command and
MCP tool use authenticated requests for the original operation; they do not
register, sync, prepare or submit another operation. CI checks the client on
Linux, macOS and Windows, and performs a real PostgreSQL 16 backup/restore in an
isolated Compose project.

The actual owner pages were exercised in Chromium with a virtual WebAuthn
authenticator: registration, approval, denial, revocation and expired setup.
The Solana wallet registration path used a generated test key. Assertions were
verified by the real HTTP handlers. This does not emulate a physical device's
biometric check or verify an operator's public HTTPS configuration.

The disposable Surfpool fork also passed the complete deposit, synthetic-yield
realization, official x402 client/local seller payment, receipt report-back and
normal withdrawal pipeline with the new dependency pins. Principal remained
unchanged by the yield payment. All signers and balances were disposable local
fixtures; no mainnet transaction was sent. A local PostgreSQL 18 backup and
restore preserved sample principal and fee-debt records.

Root and client production dependency audits report zero known vulnerabilities
at review. See [dependency status](dependencies.md) for the three exact
replacements, compatibility tests and remaining upstream peer-range limits.
The changes need both relayer and client upgrades; no database migration is
required. Preserve pending-payment files and do not downgrade a client with an
unfinished yield realization.

## Earlier real-funds checks

The following records what was exercised on **0.7.2**, source commit
`3d3d719a787da15cd8a0b891594f3006d47be554`, on 2026-09-17. A successful run
checks that configuration and chain state at that time; each operator must
validate their own deployment.

Version **0.7.3** adds owner-page wording fixes found during these checks.
Its local verification passed 391 tests, including PostgreSQL, plus root/client
type checks, builds, documentation links, clean package installation and all
eight MCP tools. It does not change transaction behavior or the ledger schema.

| Check | Evidence and scope |
| --- | --- |
| Automated checks | 387 tests, including PostgreSQL; root/client type checks, builds, package installation, CLI and eight MCP tools. [CI run](https://github.com/SublyFi/subly-payment-protocol/actions/runs/35131509253). |
| Published package | npm Trusted Publishing with provenance; clean registry installation verified 150 package signatures and 56 attestations. [Release](https://github.com/SublyFi/subly-payment-protocol/releases/tag/pay-v0.7.2). |
| Live dependencies | Authenticated Pyth pricing and dedicated mainnet RPC; pinned vault configuration and unsigned withdrawal simulations passed. |
| Real mainnet funds | A small withdrawal and redeposit through the actual HTTP client and relayer both finalized successfully. USDC and share changes matched the confirmed receipts. The two transactions cost 10,002 lamports total (0.000010002 SOL); this is the observed network fee, not a future fee quote or total investment cost. |
| Accounting and authorization | PostgreSQL stored confirmed receipts, chain-derived principal and Pyth-converted fee debt. The exact-amount deposit approval was consumed after confirmation. Records survived a database restart. |
| Principal protection | A fresh ledger conservatively treated the existing vault value as principal. A yield-realization request with insufficient yield was rejected before signing or sending. No artificial yield was introduced on mainnet. |
| Real browser passkey | A user operated Chrome's real passkey creation, deposit approval and revocation pages. The server verified the assertions; after revocation, authenticated deposit/withdrawal preparation returned `mandate_revoked`. |
| Separate mainnet sponsor | A dedicated in-memory signer paid for a small withdrawal and redeposit. The agent's SOL balance did not change during those two transactions; the sponsor's remaining SOL was returned and its final balance was zero. |
| External mainnet x402 transport | The package's official SVM transport paid 0.01 USDC to [PayAI's Echo test API](https://x402.payai.network/), received HTTP 200 and a v2 receipt. The payment and the seller's full refund were independently verified as finalized on-chain. Funding came from a normal withdrawal, not accrued yield. |
| Full payment pipeline in a local fork | Generated keys, simulated passkey approval, deposit, synthetic yield fixture, official x402 transport, local seller settlement, v2 receipt report-back and withdrawal. See the [reproducible fork test](../CONTRIBUTING.md#mainnet-fork-integration-test). |

The first real-funds run used the same wallet as agent, owner and fee payer.
A subsequent run used a real browser passkey and a separate sponsor, preserving
the same PostgreSQL principal/fee ledger. Both temporary mandates were revoked.
The second run paid 40,002 lamports in total network fees from user-controlled
wallets, including preparation and recovery of a first sponsor after an unsigned
withdrawal expired. That expired withdrawal was rejected before broadcast.
The external payment and refund fees were paid by the external service.

These checks used a dedicated local relayer/database. They do **not** verify
an actual yield-funded external API payment: available accrued yield was below
the existing fee debt and payment headroom. The external transport test did not
run through Subly's yield realizer or create a yield-payment report-back record.
The Echo service is a refunding test merchant. Public relayer deployment,
production sponsor custody and non-localhost passkey origins remain operator
checks. Wallet keys, private RPC URLs, database dumps and wallet-specific
evidence are not published in this repository.

The project remains beta and has not undergone an external security audit.
The four relayer dependency advisories present in those earlier releases were
resolved in 0.8.0 as described in [dependency status](dependencies.md).

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
