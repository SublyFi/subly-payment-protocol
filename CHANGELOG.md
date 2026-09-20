# Changelog

All notable changes to the repository and the published client are recorded here. The project did not maintain a complete changelog before this file was added; older history is available in Git and npm.

## [Unreleased]

## 0.8.5 — 2026-09-21

- Rebuild the published client from an empty output directory and reject unexpected tarball contents; stale files from earlier builds cannot survive into a release.
- Run security checks on merged `main` commits, disable dependency lifecycle scripts in the audit workflow, and fail the container smoke check when readiness never succeeds.
- Add HTTP regressions for the existing API rate limiter before authentication and database access, forwarded-address handling, and health probes.
- Review and simplify client/operator setup guides, document existing policy defaults and setup limits, and provide a pinned localhost Docker guide with optional loopback-only port binding.
- Correct CLI/MCP instructions for localhost approval links and accurately describe local and custody-provider signing. Expand support/reporting redaction guidance.
- Record the completed 0.8.4 mainnet accrued-yield Nansen payment, its independently checked transactions, and the limits of its retained audit evidence.

Payment rules, owner-policy behavior, dependencies and database schema are
unchanged. This release adds no product features and has no external security
audit. Preserve the ledger, credentials and client pending-state files when
upgrading. Publishing this release does not upgrade any running relayer.

## 0.8.4 — 2026-09-20

- Make setup and owner-management continuation instructions use version-pinned `npx` commands, so users do not need a global `pay` installation.
- Remove obsolete candidate-installation and superseded-release instructions from current onboarding guides. Clarify separate client and relayer installation, and list all thirteen MCP tools together.
- Align browser, CLI and MCP wording with conditional initial-deposit approval, vault-specific revocation and unresolved submission outcomes. Update the bundled agent skill to the current payment result format and recovery procedure.
- Wait up to 20 minutes for npm's post-publication scanning and registry availability, without changing dependency audit gates. Fail immediately on invalid metadata or permanent errors, and report prolonged unavailability instead of creating a release.

Update the client for corrected terminal instructions and rebuild the relayer for
the owner-page wording. Payment rules, dependencies
and database schema are unchanged. Preserve the ledger and pending-payment files.
Publication and verification are recorded separately in the release workflow and
[validation status](docs/validation.md).

## 0.8.3 — 2026-09-20

- Preserve confirmed deposit and withdrawal receipts when a delayed simulation or status request fails. Reconcile ambiguous submissions by their existing signature; keep them pending until receipt or expiry evidence is available. Add concurrent submit/recovery/expiry regression tests for both operations.
- Add owner management links, browser reuse of the existing passkey or wallet, and CLI/MCP commands for policy updates, reactivation, revocation, recovery cancellation and the existing 72-hour lost-credential recovery process. Preserve policy fields and expiry unless changed explicitly. Stale management links fail closed; the agent cannot override an owner's revocation.
- Retry transient npm audit failures with a bounded delay while still rejecting vulnerabilities according to the existing thresholds. Verify registry availability, artifact integrity, source commit and provenance metadata, and clean CLI/MCP installation before creating a GitHub release.
- Correct the security policy's outdated dependency-status wording and provide a source-build path when the candidate is not yet available on npm.

Upgrade the relayer and client together. Preserve the ledger and pending-payment
files. No database schema migration is needed. A failed simulation after durable
submission may now remain `submitted` until reconciliation; check the original
intent instead of repeating the operation. Release availability is verified by the publishing workflow. These checks do not
establish a real-yield external payment or an independent audit.

## 0.8.2 — 2026-09-20

- Standardize current repository documentation and setup prompts on English for an international audience.
- Replace the Japanese getting-started guide with `docs/getting-started.md` and consolidate the AI setup instructions into two complete English prompts: one for users and one for operators.
- Translate the wallet-provider and spending-mandate design references, demo guide, environment comments and script messages. Preserve the distinction between historical design proposals and implemented behavior.
- Update navigation, package documentation and contribution guidance to use English consistently.

This was a source-only documentation and wording release; npm publication did not complete, and 0.8.3 superseded it. Payment behavior, dependencies and database schema were unchanged.

## 0.8.1 — 2026-09-19

- Reorganize first-time setup into ordered user and operator guides with expected outcomes, Windows configuration, and clear approval and recovery steps.
- Add Japanese getting-started documentation and Japanese/English setup prompts for Claude Code, Codex and ChatGPT. Prompts distinguish local execution from guided instructions, protect existing configuration and secrets, and require an explicit decision before real-funds operations.
- Correct operator installation paths, file ownership, sponsor-key copying, Compose working directories and monitoring cron instructions.
- Make CLI recovery commands copyable without a global install and pin them to the running package version. Owner pages now direct users back to their chat or terminal instead of promising automatic continuation.

Upgrade the client for the corrected CLI guidance and rebuild the relayer for the owner-page wording. Payment rules, transaction behavior, dependencies and database schema are unchanged. Preserve pending-payment files.

## 0.8.0 — 2026-09-19

- Prevent wallet synchronization from counting a submitted deposit or withdrawal as an external balance change. Reject stale chain snapshots when ledger accounting has changed during the read.
- Persist yield-realization progress before submission and resume the original withdrawal after a timeout or restart, without preparing another withdrawal for the same API request.
- Accept successful HTTP 2xx API responses, including 201, 202 and 204. Keep retry protection for failed or malformed payment receipts.
- Align the package's local publishing fallback with the release checklist; GitHub provenance is provided by the publishing workflow.
- Add `pay status <intentId>` and MCP `check_subly_vault_operation` to reconcile an original deposit or withdrawal without preparing or sending another transaction. Return only outcome fields and check the wallet, vault and intent ID.
- Replace the backup pipeline with a private, checked PostgreSQL archive that is published only after success. Add failure-path tests, an isolated restore rehearsal and a disposable PostgreSQL backup/restore check in CI.
- Check packaged clients on Linux, macOS and Windows, and run the actual owner pages in Chromium with a virtual passkey and a generated wallet. Cover registration, approval, denial, revocation and expired setup links without real funds.
- Replace vulnerable transitive parser/RPC/big-integer dependencies with pinned, compatibility-tested versions. The big-integer replacement contains no native code. See the dependency status document for the exact overrides and verification scope.

Upgrade both relayer and client for these accounting and recovery fixes. Preserve pending-payment state across upgrades; no database migration is required. Do not downgrade the client while a yield realization is pending.

## 0.7.3 — 2026-09-17

- Correct owner setup pages that described a deposit as approved when replacing an existing mandate. First-deposit approval is issued only on the first registration; replacements now explain the separate approval both before and after setup.
- Explain that passkey providers may synchronize credentials across devices. Subly receives the public key and signatures, never the passkey private key.
- Record real Chrome passkey registration/approval/revocation, separate-sponsor mainnet vault operations, and a finalized external PayAI Echo payment/refund using the package's official x402 transport. The external test used a normal withdrawal; actual yield-funded external payment remains unverified. No artificial mainnet yield or principal baseline reduction was used to fund it.

Rebuild the relayer for the owner-page fix. Client transaction behavior, dependencies and database schema are unchanged.

## 0.7.2 — 2026-09-17

- Reserve bounded rounding headroom for yield realization; refuse a preview or confirmed receipt that cannot fund the exact API price. Preserve the pending withdrawal record so retries cannot realize twice or silently use unrelated wallet USDC.
- Read the standard x402 v2 `PAYMENT-RESPONSE` receipt, retaining legacy header compatibility, so payment signatures are reported to the relayer and checked on-chain.
- Validate the current separate withdrawal/payment integration instead of requiring the retired atomic settlement transaction to fit. Additional lookup tables are needed only when current transactions exceed the size limit.
- Add an opt-in disposable Surfpool integration test covering wallet-authenticated HTTP onboarding, simulated passkey approval, deposit, fee accounting with Pyth, yield realization, the official x402 client, a local seller settlement and normal withdrawal. It uses generated keys and synthetic local balances/yield, never user key files or mainnet transactions.
- Load ignored `.env` settings in the validation commands and accept `SOLANA_MAINNET_RPC_URL` for mainnet validation. Document exactly what live read-only checks and fork tests do and do not establish.

Upgrade both relayer and client together for the rounding fix. No database migration. Mainnet read-only previews and authenticated Pyth requests were verified; real-funded end-to-end payments and public server deployment remain operator checks.

## 0.7.1 — 2026-09-16

- Support authenticated Pyth Hermes fee pricing after the August 2026 API upgrade. Operators set `SUBLY_HERMES_API_KEY` (or `PYTH_API_KEY`); credentials require HTTPS and redirects are rejected.
- Return a failing exit status when mainnet validation is incomplete or a delayed simulation fails. Use the same oracle connection settings as the relayer.
- Keep the relayer alive when an idle PostgreSQL connection drops, reconnect on the next query, and bound pool connection waits. Avoid dumping connection internals in unhandled error logs.
- Fix client `doctor` to compare the full mainnet genesis hash instead of the truncated x402 chain reference, and check database readiness instead of liveness alone.
- Clarify that npm Trusted Publisher verification requires an actual version release and registry provenance checks. Tag releases continue to run full CI before publication.
- Update operator configuration and troubleshooting guidance. Client payment behavior and database schema are unchanged.

## 0.7.0 — 2026-09-16

- Publish the selectable mainnet USDC vault catalogue and per-vault mandates/accounting in the npm client.
- Add CLI help/version, read-only `doctor`, local `vaults` and `budget` commands; test actual packed installs and the MCP tool handshake.
- Bind deposits and withdrawals to caller intent, reject duplicate deposit instructions, and independently simulate withdrawal receipts before signing.
- Recheck mandate revocation/replacement/expiry and owner approvals before sponsor signing; persist owner approval challenges across PostgreSQL transaction boundaries.
- Serialize shared client payment-state access and reload pending outcomes before paying; bind legacy payment intents to the original request.
- Ship a non-root production container, readiness checks, graceful shutdown and tested PostgreSQL CI; gate releases on the full CI workflow.
- Refresh dependency locks, document remaining server advisories and rebuild guides around client, operator and contributor workflows. Remove superseded beta/marketing documents.

Compatibility: Node.js 24+ is now required. Withdrawal RPCs must support simulation with parsed inner instructions. Preserve payment-state JSON and follow the database migration/rollback notes. This is a beta release, not an external security audit or mainnet deployment certification.

## [0.6.2] - 2026-08-20

- Harden transaction-intent validation for Kamino Farms instructions and bind wallet authentication to the full request path, including the query string.
- Make mandate enforcement secure by default, cap outstanding approvals, prune terminal approvals, and add browser security headers.
- Add OSS support, governance, release, dependency-update, and security-automation metadata.

## [0.6.1]

- Published client baseline before the OSS release-readiness work.

[0.6.2]: https://github.com/SublyFi/subly-payment-protocol/compare/pay-v0.6.1...pay-v0.6.2
[Unreleased]: https://github.com/SublyFi/subly-payment-protocol/compare/pay-v0.8.4...HEAD
