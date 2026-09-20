# Release process

The relayer is distributed as tagged source and a source-built Docker image. `@subly_fi/pay` is the public client npm package. Node.js 24 / npm 11 and committed lockfiles are required.

## Verify a release candidate

1. Update root/client versions, both lockfiles, changelog and pinned command examples. Review for credentials or generated files.
2. Run `npm ci --ignore-scripts`, `npm ci --prefix packages/pay --ignore-scripts`, `npm run check`, `npm run check --prefix packages/pay`, `npm run test:package` and `node scripts/audit-relayer.mjs`.
3. Run all tests with a disposable `SUBLY_TEST_POSTGRES_URL`, including migration and approval persistence regressions.
4. Run `node scripts/audit-client.mjs` and review [relayer dependency status](docs/dependencies.md). Both audit scripts retry only temporary registry/rate-limit/network failures, at most four attempts with 5/15/30-second delays. Invalid reports, persistent outages and vulnerabilities at the configured threshold still fail the release; never bypass the audit to recover publication.
5. Build the Docker image, check its non-root detached health endpoint, and test SIGTERM shutdown. Inspect the package tarball allowlist. No keys, source server SDK or local state belong in the npm package.
6. Run `npx playwright install chromium` and `npm run test:browser`. Wait for all three client OS checks, browser checks, dependency review and CodeQL before merging the reviewed PR. Record any limits to mainnet validation in release notes. Automated tests never substitute for an external security audit.

## Publish

Tag the merged commit as `pay-v<package version>`. The release workflow calls the full reusable CI workflow (PostgreSQL, client tarball/MCP, Docker, audit) before publishing. npm uses GitHub OIDC trusted publishing; configure the package's trusted publisher as organization `SublyFi`, repository `subly-payment-protocol`, workflow filename `release-pay.yml`. Node 24's npm supports this flow. No long-lived npm token is stored in GitHub. Prepare source changes as a new version; an existing public tag always refers to its original commit.

```bash
git tag -a pay-v0.8.6 -m "Subly 0.8.6"
git push origin pay-v0.8.6
```

The publisher checks tag/version equality and uses `npm publish --access public --provenance`. If publication fails, inspect the workflow and npm trusted-publisher settings; do not move an existing public tag. Re-run the failed job after fixing configuration or after an upstream outage ends. Publishing the same npm version twice is not possible. To resume after publication succeeded but verification failed, the workflow skips a second publish only when the registry version has the same `gitHead`, valid integrity metadata and npm provenance metadata. Any different commit or malformed registry response blocks the job.

Verify trusted publishing with an actual version release through this workflow and then verify its registry provenance. Saving the npm settings, `npm whoami`, and `npm publish --dry-run` do not prove publishing works. Use npm CLI's supported OIDC handling; never log or persist exchanged credentials in custom diagnostic scripts.

An authorized local maintainer can use `npm publish --access public` after the same checks and any required registry authentication. GitHub provenance cannot be generated from a normal local shell; never claim provenance for that fallback. Record the publication method in release notes.

After publication the workflow runs `node scripts/verify-published-package.mjs --require-provenance`. It waits up to 20 minutes for exact-version registry availability, polling every 30 seconds with requests bounded to 15 seconds and the remaining deadline. [npm scans newly published packages before making them available](https://github.blog/changelog/2026-07-28-npm-publish-time-malware-scanning-and-dual-use-metadata/); acceptance by `npm publish` does not establish installability. Only an unavailable version or a temporary registry/network error is polled. Invalid metadata, authentication failures and source mismatches fail immediately. A prolonged scan, hold or block fails verification at the deadline; investigate npm's publication status before rerunning verification for the same commit. Do not republish or move the tag. Prepublication checks still return immediately on an explicit missing-version response, and audit gates retain their separate four-attempt policy.

Once available, verification checks registry version/commit/provenance metadata, installs that version in a temporary directory without lifecycle scripts or local credentials, matches installed SHA-512 integrity, and checks `--version`, `--help` and MCP initialization/tool discovery without sending transactions. Provenance metadata presence is checked here; this is not a separate cryptographic attestation verifier. Only successful verification permits the final job to create the GitHub release for the immutable matching tag. Release creation does not change npm versions or deploy the relayer.

For a read-only check of any already published client version, run `node scripts/verify-published-package.mjs --version <exact-version> --require-provenance`. Set `RELEASE_COMMIT` to the expected full commit hash when also checking source identity. A local fallback published without GitHub provenance can be inspected by omitting `--require-provenance`; that does not satisfy the automated workflow's provenance requirement.

## Operator upgrade

Publication does not deploy a live relayer. Operators back up the ledger, stop old instances, update to the reviewed tag, validate their own vault/RPC/sponsor configuration and follow the [migration and rollback instructions](deploy/README.md#existing-deployments-and-retiring-vaults). Do not roll back only the binary after the vault-mandate table migration. Preserve pending client state. Sponsor funding, liquidity and the two-transaction payment flow need operator validation on each deployment.
