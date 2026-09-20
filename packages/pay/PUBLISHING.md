# Publishing @subly_fi/pay

Follow the [canonical release process](../../RELEASE.md) for validation,
immutable tags, trusted publishing and recovery of interrupted releases.
These notes cover the client package only. Publishing the package does not
deploy a relayer.

## Prerequisites and build inputs

Use Node.js 24 and npm 11. Normal publication uses the configured GitHub Actions
trusted publisher for `@subly_fi/pay`; a local maintainer fallback requires an
account authorized to publish that package and registry authentication.

The client bundles shared source from the repository, so install both dependency
graphs from the repository root before following the release checks:

```bash
npm ci --ignore-scripts
npm ci --prefix packages/pay --ignore-scripts
```

- `dist/` is gitignored. The client build and `prepack` clear and rebuild it; the package's
  `files` allowlist includes the resulting bundles, README and license.
- Runtime dependencies stay external. The package contains client code, without
  the relayer, seller, Kamino server SDK or PostgreSQL dependency.
- Keep root/client manifest and lockfile versions aligned as required by the
  release checklist. Review package contents with the prescribed tarball checks.

## Verify the exact published version

After publication, run the registry verifier from the repository root, using
the exact released version:

```bash
node scripts/verify-published-package.mjs --version 0.8.6 --require-provenance
```

The verifier waits for registry availability, installs the exact public version
in isolation, and checks artifact integrity, CLI startup and MCP discovery.
It sends no transactions. Set `RELEASE_COMMIT` to the expected full commit hash
to check source identity too; the release workflow does this automatically.
The canonical process documents the bounded wait and failed-verification recovery.

The authenticated local fallback in the release process does not generate
GitHub provenance. Omit `--require-provenance` only when inspecting that fallback,
and record the publication method in its release notes. Neither a local dry run
nor provenance metadata alone establishes cryptographic attestation verification.
