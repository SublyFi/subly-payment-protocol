# Changelog

All notable changes to the repository and the published client are recorded here. The project did not maintain a complete changelog before this file was added; older history is available in Git and npm.

## [Unreleased]

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
[Unreleased]: https://github.com/SublyFi/subly-payment-protocol/compare/pay-v0.7.1...HEAD
