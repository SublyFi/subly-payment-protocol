# Release checklist

This repository contains a source-distributed relayer and the published `@subly_fi/pay` client. A release must be reproducible from a clean checkout and must not require private keys in CI.

## Before tagging

- [ ] Review the diff and confirm no secrets, local env files, keypairs, database dumps, or generated `dist/` files are committed.
- [ ] Update `CHANGELOG.md` and the client version in `packages/pay/package.json`.
- [ ] Regenerate `packages/pay/package-lock.json` with the same npm major used by CI.
- [ ] Run `npm ci`, `npm run typecheck`, `npm test`, and `npm run build` at the repository root.
- [ ] Run `npm ci`, `npm run typecheck`, `npm run build`, and `npm run pack:check` in `packages/pay/`.
- [ ] Inspect the dry-run tarball contents. It must contain `dist/`, `README.md`, and `LICENSE`, and must not contain source key material, `.env` files, or server code.
- [ ] Review `npm audit --omit=dev --audit-level=high` output. Do not suppress a finding; document an unavoidable upstream finding and its mitigation before release.

## Publish the client

The recommended path is the GitHub Actions workflow, triggered by a tag such as `pay-v0.6.2`. Configure npm trusted publishing for the repository and workflow before using it; the workflow requests only `id-token: write` and publishes with provenance.

For a local maintainer release, use an account authorized for the `@subly_fi` scope:

```bash
cd packages/pay
npm ci
npm run typecheck
npm run pack:check
npm publish --access public --provenance
```

After publishing:

- [ ] Verify `npm view @subly_fi/pay version dist-tags --json`.
- [ ] Verify the package is public and its provenance is visible on npm.
- [ ] From a clean temporary directory, run `npx -y @subly_fi/pay@<version> --help`.
- [ ] Create the GitHub release for the matching tag and paste the changelog entry.

## Operational release

Relayer deployment is separate from npm publishing. Review the production env example, run the read-only mainnet validation harness where appropriate, deploy the image from the reviewed commit, and confirm health checks, sponsor balance monitoring, database migrations, and rollback instructions before enabling traffic.
