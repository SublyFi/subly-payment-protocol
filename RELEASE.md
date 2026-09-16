# Release process

The relayer is distributed as tagged source and a source-built Docker image. `@subly_fi/pay` is the public client npm package. Node.js 24 / npm 11 and committed lockfiles are required.

## Verify a release candidate

1. Update root/client versions, both lockfiles, changelog and pinned command examples. Review for credentials or generated files.
2. Run `npm ci --ignore-scripts`, `npm ci --prefix packages/pay --ignore-scripts`, `npm run check`, `npm run check --prefix packages/pay`, `npm run test:package` and `node scripts/audit-relayer.mjs`.
3. Run all tests with a disposable `SUBLY_TEST_POSTGRES_URL`, including migration and approval persistence regressions.
4. Run `npm audit --prefix packages/pay --omit=dev --audit-level=high` and review [known relayer advisories](docs/dependencies.md).
5. Build the Docker image, check its non-root detached health endpoint, and test SIGTERM shutdown. Inspect the package tarball allowlist. No keys, source server SDK or local state belong in the npm package.
6. Merge a reviewed PR after CI, dependency review and CodeQL complete. Record any limits to mainnet validation in release notes. Automated tests never substitute for an external security audit.

## Publish

Tag the merged commit as `pay-v<package version>`. The release workflow calls the full reusable CI workflow (PostgreSQL, client tarball/MCP, Docker, audit) before publishing. npm uses GitHub OIDC trusted publishing; configure the package's trusted publisher as organization `SublyFi`, repository `subly-payment-protocol`, workflow filename `release-pay.yml`. Node 24's npm supports this flow. No long-lived npm token is stored in GitHub.

```bash
git tag -a pay-v0.7.2 -m "Subly 0.7.2"
git push origin pay-v0.7.2
```

The publisher checks tag/version equality and uses `npm publish --access public --provenance`. If publication fails, inspect the workflow and npm trusted-publisher settings; do not move an existing public tag. Re-run the failed job after fixing configuration. Publishing the same npm version twice is not possible.

Verify trusted publishing with an actual version release through this workflow and then verify its registry provenance. Saving the npm settings, `npm whoami`, and `npm publish --dry-run` do not prove publishing works. Use npm CLI's supported OIDC handling; never log or persist exchanged credentials in custom diagnostic scripts.

An authorized local maintainer can use `npm publish --access public` after the same checks and any required registry authentication. GitHub provenance cannot be generated from a normal local shell; never claim provenance for that fallback. Record the publication method in release notes.

After publication verify `npm view @subly_fi/pay version dist-tags dist.attestations --json`, install the exact registry version in a clean directory, and check `--version`, `--help` and MCP initialization. Create a GitHub release for the immutable matching tag with release notes and optional npm tarball/checksum.

## Operator upgrade

Publication does not deploy a live relayer. Operators back up the ledger, stop old instances, update to the reviewed tag, validate their own vault/RPC/sponsor configuration and follow the [migration and rollback instructions](deploy/README.md#existing-deployments-and-retiring-vaults). Do not roll back only the binary after the vault-mandate table migration. Preserve pending client state. Sponsor funding, liquidity and the two-transaction payment flow need operator validation on each deployment.
