# Publishing @sublyfi/pay (operator)

The client package that beta participants run via `npx`. Build is reproducible
from the repo; publishing needs npm credentials for the `@sublyfi` org.

## One-time

```bash
npm login                 # an account that is a member of the @sublyfi org
npm org ls sublyfi        # confirm membership (create the org on npmjs.com if new)
```

## Each release

```bash
cd packages/pay
npm version patch          # or minor/major; bumps packages/pay/package.json
node build.mjs             # bundles dist/ from the repo's demo/ + src/
npm publish                # public access is set in package.json publishConfig

# sanity check the published artifact from a clean dir:
cd /tmp && npx -y @sublyfi/pay@latest fetch https://seller.demo.sublyfi.com/api/premium/alpha
```

## Notes

- `dist/` is gitignored and rebuilt by `node build.mjs`; it is included in the
  published tarball via the `files` field. Always build before publish.
- The package bundles only client code (the six runtime deps stay external);
  it must never pull in the facilitator, seller, Kamino SDK, or `pg`. If the
  bundle size jumps, check what new import crossed into the client path.
- Bump the version in lockstep with any change to the client flow so
  `npx -y @sublyfi/pay@latest` picks it up.
