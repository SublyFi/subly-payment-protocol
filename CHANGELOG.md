# Changelog

All notable changes to the repository and the published client are recorded here. The project did not maintain a complete changelog before this file was added; older history is available in Git and npm.

## 0.7.0 — 2026-09-16

- Publish the selectable mainnet USDC vault catalogue and per-vault mandates/accounting in the npm client.
- Add CLI help/version, read-only `doctor`, local `vaults` and `budget` commands; test actual packed installs and the MCP tool handshake.
- Bind deposits and withdrawals to caller intent, reject duplicate deposit instructions, and independently simulate withdrawal receipts before signing.
- Recheck mandate revocation/replacement/expiry and owner approvals before sponsor signing; persist owner approval challenges across PostgreSQL transaction boundaries.
- Serialize shared client payment-state access and reload pending outcomes before paying; bind legacy payment intents to the original request.
- Ship a non-root production container, readiness checks, graceful shutdown and tested PostgreSQL CI; gate releases on the full CI workflow.
- Refresh dependency locks, document remaining server advisories and rebuild guides around client, operator and contributor workflows. Remove superseded beta/marketing documents.

Compatibility: Node.js 24+ is now required. Withdrawal RPCs must support simulation with parsed inner instructions. Preserve payment-state JSON and follow the database migration/rollback notes. This is a beta release, not an external security audit or mainnet deployment certification.

## [Unreleased]

## [0.6.2] - 2026-08-20

- Harden transaction-intent validation for Kamino Farms instructions and bind wallet authentication to the full request path, including the query string.
- Make mandate enforcement secure by default, cap outstanding approvals, prune terminal approvals, and add browser security headers.
- Add OSS support, governance, release, dependency-update, and security-automation metadata.

## [0.6.1]

- Published client baseline before the OSS release-readiness work.

[0.6.2]: https://github.com/SublyFi/subly-payment-protocol/compare/pay-v0.6.1...pay-v0.6.2
[Unreleased]: https://github.com/SublyFi/subly-payment-protocol/compare/pay-v0.6.2...HEAD
