# Publishing @subly_fi/pay (operator)

The client package that beta participants run via `npx`. Build is reproducible
from the repo; publishing needs npm credentials for the `@subly_fi` org.

## One-time

```bash
npm login                 # an account that is a member of the @subly_fi org
npm org ls subly_fi        # confirm membership (create the org on npmjs.com if new)
```

## Each release

```bash
cd packages/pay
npm version patch          # or minor/major; bumps packages/pay/package.json
node build.mjs             # bundles dist/ from the repo's demo/ + src/
npm publish                # public access is set in package.json publishConfig

# CONFIRM IT IS PUBLIC (scoped packages can publish as restricted despite
# publishConfig; restricted = npx fails for everyone but you):
npm access get status @subly_fi/pay      # must print "public"
# if it prints "restricted", flip it (needs your npm OTP):
#   npm access set status=public @subly_fi/pay

# sanity check the published artifact from a clean dir (allow ~1-2 min for the
# registry/CDN to serve a newly public package before this resolves).
# Resolving + printing usage proves the bin works without spending anything:
cd /tmp && npx -y @subly_fi/pay@latest
# optional paid check against a real standard-x402 seller (0.01 USDC):
#   SUBLY_DEMO_AGENT_KEYPAIR_PATH=... npx -y @subly_fi/pay@latest fetch <x402-url>
```

## Notes

- `dist/` is gitignored and rebuilt by `node build.mjs`; it is included in the
  published tarball via the `files` field. Always build before publish.
- The package bundles only client code (the six runtime deps stay external);
  it must never pull in the facilitator, seller, Kamino SDK, or `pg`. If the
  bundle size jumps, check what new import crossed into the client path.
- Bump the version in lockstep with any change to the client flow so
  `npx -y @subly_fi/pay@latest` picks it up.
- First publish of this package on 2026-06-13 landed as `restricted` despite
  `publishConfig.access: public`; it had to be flipped with
  `npm access set status=public`. Always run the access check above after
  publishing. A newly-public package can 404 for a minute or two while the
  CDN's earlier negative response expires — that is propagation, not failure.
