# Governance

Subly is maintained by SublyFi and is currently in beta. The repository is open for contributions, but the project does not yet have a formal foundation, steering committee, or community voting process.

## Decision making

- Maintainers make release, security, and compatibility decisions.
- Design changes should start as an issue or design document before implementation when they affect funds, signing, protocol compatibility, or public APIs.
- Pull requests are reviewed for correctness, security, tests, and documentation. A maintainer may request additional review for transaction or custody-related changes.
- Security reports are handled privately under [SECURITY.md](SECURITY.md).

## Maintainers

The current maintainer team is represented by the [SublyFi GitHub organization](https://github.com/SublyFi). Maintainer membership and release authority may change as the project grows; changes should be recorded in this file and the changelog.

## Releases

The published client is `@subly_fi/pay`. Releases are made from reviewed tags using the [release checklist](RELEASE.md) and the GitHub Actions npm publishing workflow. The relayer is currently distributed as source and deployment artifacts rather than as a public npm server package.

## Contributions

Contributors retain copyright in their contributions and grant the project the rights described by the repository's [MIT license](LICENSE). See [CONTRIBUTING.md](CONTRIBUTING.md) for the development and review process.
