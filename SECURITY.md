# Security Policy

Subly moves real funds on Solana mainnet. We take vulnerability reports seriously and appreciate responsible disclosure.

## Reporting a vulnerability

**Please do not open a public GitHub issue for security vulnerabilities.**

Report privately via [GitHub Security Advisories](https://github.com/SublyFi/subly-payment-protocol/security/advisories/new) ("Report a vulnerability" on the repository's Security tab). If the advisory form is ever unavailable, contact the maintainer directly instead: [@yukikm](https://github.com/yukikm) on GitHub or [@subly_fi](https://x.com/subly_fi) via DM. We will acknowledge your report as quickly as we can, keep you informed of progress, and credit you in the fix release unless you prefer otherwise.

Please include: the affected component, a reproduction or proof of concept, and your assessment of impact.

## Scope

Reports are especially valuable for:

- **Relayer authentication** — wallet-signature auth (`x-subly-wallet` / `x-subly-signed-at` / `x-subly-signature`), admin/seller token scoping, rate limiting.
- **The yield-only guard** — any way a `yield_realize` withdrawal could spend deposited principal.
- **Spending-mandate enforcement** — cap bypasses, approval replay, mandate/approval signature forgery, setup-session or capability-URL weaknesses.
- **Client-side signing** — transaction-intent validation (signing something other than the validated intent), custody-signature verification, x402 payment construction, double-payment protection.
- **Sponsored-transaction abuse** — draining or griefing the sponsor wallet.

Out of scope: vulnerabilities in third-party dependencies (Kamino, x402 facilitators, Circle/Privy, Solana itself) — please report those upstream; findings on the hosted demo infrastructure that amount to denial of service against a beta service.

## Supported versions

Security fixes land on `main` and in the latest published `@subly_fi/pay` release. Older npm releases are not patched retroactively.

## Disclosure

Please give us a reasonable window to ship a fix before public disclosure. This project has not yet undergone an external security audit; the [README's security model](README.md#security--trust-model) documents the current trust assumptions honestly.
