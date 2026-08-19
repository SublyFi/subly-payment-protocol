# Support

Subly is a beta project that moves real funds on Solana. Read the [README](README.md), the [documentation index](docs/README.md), and the relevant deployment guide before opening a request.

## Where to ask

- **Usage questions:** open a [GitHub discussion or issue](https://github.com/SublyFi/subly-payment-protocol/issues) with the command, expected result, actual result, and relevant logs.
- **Bug reports:** use the [bug report template](https://github.com/SublyFi/subly-payment-protocol/issues/new?template=bug_report.md) and include a minimal reproduction that does not contain secrets.
- **Feature requests:** use the [feature request template](https://github.com/SublyFi/subly-payment-protocol/issues/new?template=feature_request.md) and describe the user problem and proposed behavior.
- **Security vulnerabilities:** do **not** open a public issue. Follow [SECURITY.md](SECURITY.md).

## Before opening a request

1. Reproduce on the latest `main` or latest published `@subly_fi/pay` release.
2. Search existing issues and the [changelog](CHANGELOG.md).
3. Remove private keys, seed phrases, API tokens, wallet signatures, database URLs, and personal data from logs.
4. For transaction problems, include the Solana cluster, public transaction signature if safe, and the exact client/server versions.

This project is maintained on a best-effort basis. There is no guaranteed response or uptime SLA. Hosted beta service support may differ from self-hosted support; never assume the hosted service is production-safe for funds you cannot afford to lose.
