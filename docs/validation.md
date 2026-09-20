# Testing and verification

Subly is beta software without an external security audit. Automated tests and
observed payments establish the behavior exercised; they do not guarantee
principal, yield or an operator's deployment. See the [security model](security-model.md).

## Automated coverage

[CI](https://github.com/SublyFi/subly-payment-protocol/actions/workflows/ci.yml)
checks the relayer with disposable PostgreSQL, backup/restore, owner approvals,
transaction accounting and recovery regressions. It also checks client builds
and clean package installation on Linux, macOS and Windows, all thirteen MCP
tools, Chromium owner flows with a virtual WebAuthn authenticator, documentation
links and the detached Docker container. These browser checks do not emulate a
physical biometric device or validate a deployment's public passkey origin.

The [release workflow](https://github.com/SublyFi/subly-payment-protocol/actions/workflows/release-pay.yml)
runs those checks before publishing, then verifies the exact npm version,
source commit, package integrity, provenance metadata and clean CLI/MCP startup.
Provenance metadata checks are not a separate cryptographic attestation verifier.
[Dependency checks](dependencies.md) cover the client and relayer independently.

The [local fork test](../CONTRIBUTING.md#mainnet-fork-integration-test) exercises
deposit, synthetic-yield realization, x402 settlement with a local seller,
report-back and withdrawal using disposable keys. Synthetic fork balances do
not establish organically accrued mainnet yield or external seller delivery.

## Observed mainnet payment

On **2026-09-21 JST**, an operator used the Subly client and a local **0.8.4**
Docker/PostgreSQL relayer to make an owner-approved deposit, accrue yield and
purchase Nansen Token Screener data for **0.01 USDC**.

| Result | Evidence |
| --- | --- |
| Deposit | The ledger recorded the approved deposit and corresponding principal increase. |
| Yield-funded payment | Yield realization delivered 10,004 raw USDC; a separate seller transaction transferred 10,000 raw USDC (0.01 USDC). |
| Principal accounting | Recorded principal was unchanged by yield realization. |
| Completion | The deposit, realization and payment transactions were independently checked as finalized without errors. The operator supplied the successful API response; client pending state was empty afterward. |

The ledger retained the payment transaction with verification status `reported`.
Subsequent read-only RPC verification confirmed the transfer but did not change
that stored label. The seller response was not fetched again. Payment receipts
do not verify the seller's data quality or fulfillment in other requests.

This run exercised the normal payment path at the configured daily cap with
mandate enforcement enabled. It did not exercise payee-allowlist or monthly-cap
rejection. The agent paid vault-operation network fees; the seller payment used
a separate fee payer. The relayer version was observed, without a source-build
attestation. This is evidence for that run, not a mainnet test of every release
or every failure and recovery path.

## Reproducing checks

Use [CONTRIBUTING.md](../CONTRIBUTING.md) for automated and disposable-fork tests,
and the [operator guide](../deploy/README.md) for deployment checks. The
`validate:mainnet` command is read-only and never loads a wallet key. Any test
that transfers mainnet funds needs an owner-authorized amount. Paid API tests
also need sufficient actual yield. Never change the principal baseline to make a payment test pass.

Keep wallet-specific transaction evidence, capability URLs, credentials and
database backups private. Preserve pending payment state when investigating
uncertain outcomes; use the original intent ID to reconcile them.
