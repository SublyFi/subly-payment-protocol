# Publishing @subly_fi/pay (operator)

The client package that users run via `npx`. The canonical release checklist is
[`../../RELEASE.md`](../../RELEASE.md); this file contains the package-specific
notes. Publishing needs npm credentials for the `@subly_fi` org, or a
configured npm trusted publisher for the GitHub Actions workflow.

## One-time

```bash
npm login                 # an account that is a member of the @subly_fi org
npm org ls subly_fi        # confirm membership (create the org on npmjs.com if new)
```

## Each release (local maintainer path)

```bash
cd packages/pay
npm version patch          # or minor/major; bumps packages/pay/package.json
npm ci
npm run typecheck
npm run pack:check         # builds/inspects the package dry-run tarball
npm publish --access public --provenance

# CONFIRM IT IS PUBLIC (scoped packages can publish as restricted despite
# publishConfig; restricted = npx fails for everyone but you):
npm access get status @subly_fi/pay      # must print "public"
# if it prints "restricted", flip it (needs your npm OTP):
#   npm access set status=public @subly_fi/pay

# sanity check the published artifact from a clean temporary dir (allow ~1-2 min for the
# registry/CDN to serve a newly public package before this resolves).
# Resolving + printing usage proves the bin works without spending anything:
cd /tmp && npx -y @subly_fi/pay@latest --help
# optional paid check against a real standard-x402 seller (0.01 USDC):
#   SUBLY_DEMO_AGENT_KEYPAIR_PATH=... npx -y @subly_fi/pay@latest fetch <x402-url>
```

## Notes

- `dist/` is gitignored and rebuilt by `npm run build`; `prepublishOnly` also
  rebuilds it during `npm publish`. It is included in the published tarball via
  the `files` field.
- The package bundles only client code (the six runtime deps stay external);
  it must never pull in the facilitator, seller, Kamino SDK, or `pg`. If the
  bundle size jumps, check what new import crossed into the client path.
- Bump the version and regenerate `package-lock.json` in lockstep with any
  client-flow change so `npx -y @subly_fi/pay@<version>` is reproducible.
- Scoped packages can still be misconfigured as restricted. Always run the
  access check above after publishing. A newly-public package can 404 briefly
  while the registry/CDN propagates the release.
