# Security Policy

Subly moves real funds on Solana mainnet. We take vulnerability reports seriously and appreciate responsible disclosure.

## Reporting a vulnerability

**Please do not open a public GitHub issue for security vulnerabilities.**

Report privately via [GitHub Security Advisories](https://github.com/SublyFi/subly-payment-protocol/security/advisories/new) ("Report a vulnerability" on the repository's Security tab). If the advisory form is ever unavailable, contact the maintainer directly instead: [@yukikm](https://github.com/yukikm) on GitHub or [@subly_fi](https://x.com/subly_fi) via DM. We aim to acknowledge reports within five business days, keep you informed of progress, and credit you in the fix release unless you prefer otherwise; this is a best-effort target, not an SLA.

Please include: the affected component and version/commit, a reproduction or proof of concept, your assessment of impact, and any mitigation you have tested. Remove private keys, seed phrases, API tokens, wallet signatures, signed transactions, database URLs, setup/owner/approval capability URLs, and personal data from the report. Use disposable test credentials when a reproduction requires them.

## Scope

Reports are especially valuable for:

- **Relayer authentication** — wallet-signature auth (`x-subly-wallet` / `x-subly-signed-at` / `x-subly-signature`), admin/seller token scoping, rate limiting.
- **The yield-only guard** — any way a `yield_realize` withdrawal could spend deposited principal.
- **Spending-mandate enforcement** — cap bypasses, approval replay, mandate/approval signature forgery, setup-session or capability-URL weaknesses.
- **Client-side signing** — transaction-intent validation (signing something other than the validated intent), custody-signature verification, x402 payment construction, double-payment protection.
- **Sponsored-transaction abuse** — draining or griefing the sponsor wallet.

Report vulnerabilities in upstream programs or dependencies to their maintainers as well. If an upstream issue is exploitable through Subly, report that integration impact here. Do not test denial of service against shared infrastructure.

## Supported versions

Security fixes land on `main` and in the latest published `@subly_fi/pay` release. Older npm releases and untagged forks are not patched retroactively. The root relayer is source-distributed; operators are responsible for deploying a reviewed commit and keeping their dependencies current.

## Disclosure

Please give us a reasonable window to ship a fix before public disclosure. This project has not yet undergone an external security audit; the [security model](docs/security-model.md) documents the current trust assumptions honestly.

## Dependency status

The published client dependency lock is checked by CI and must pass a high-severity npm audit before release. The source-distributed relayer has a separate dependency graph and rejects every reported production dependency vulnerability, at any severity. Reviewed dependency overrides remove the previously reported upstream advisories; their scope and compatibility tests are documented below. A clean client audit must not be interpreted as a clean relayer audit.

Both audit gates retry temporary registry, network and rate-limit failures a bounded number of times. Missing, malformed or inconsistent vulnerability data and persistent outages block the release; retries never waive findings or lower severity thresholds. Dependabot, CI and the weekly security workflow check the two dependency graphs independently. The release workflow creates a GitHub release only after publication and clean installation of the exact registry version pass verification.

See the versioned [dependency status and mitigations](docs/dependencies.md).
