# Dependencies

The published client and source relayer have separate dependency graphs and
Solana Kit versions. Check both from the repository root:

```bash
node scripts/audit-client.mjs
node scripts/audit-relayer.mjs
```

## Audit policy

| Distribution | Production dependency audit gate |
| --- | --- |
| `@subly_fi/pay` | Reject high and critical vulnerabilities; no exceptions |
| Root relayer | Reject every reported vulnerability at any severity; no exceptions |

Both scripts fail on invalid audit reports or persistent registry errors. Only
temporary registry/network failures receive bounded retries; findings are never
waived. CI, the release workflow and scheduled security checks enforce these
policies. Dependabot checks both npm graphs and GitHub Actions dependencies.

Both production audits reported zero vulnerabilities for the 0.8.6 lockfiles on
2026-09-21. Advisories can change; rerun the scripts for current results. A clean
audit does not establish that dependencies have no undisclosed defects.

## Pinned relayer overrides

The root manifest applies these exact, parent-scoped overrides. They replace
vulnerable implementations while retaining the SDK interfaces Subly uses.
Keep their compatibility tests when changing dependencies.

| Parent dependency | Replacement and public source | Advisory and compatibility |
| --- | --- | --- |
| `@solana/buffer-layout-utils` | `bigint-buffer` → `npm:@exodus/bigint-buffer@1.1.5-exodus.1`; [Exodus fork](https://github.com/ExodusMovement/bigint-buffer), Apache-2.0 | [GHSA-3gc7-fjrx-p6mg](https://github.com/advisories/GHSA-3gc7-fjrx-p6mg). The reviewed fork retains the JavaScript conversion APIs, without native code, a binding loader or install hooks. Both layout-utils 0.2 and 0.3 resolve it. |
| `@coral-xyz/anchor` | `toml@4.2.0`; [toml-node](https://github.com/BinaryMuse/toml-node), MIT | [GHSA-82x6-q7mm-w9cf](https://github.com/advisories/GHSA-82x6-q7mm-w9cf), [GHSA-v5mp-jgw5-2x6j](https://github.com/advisories/GHSA-v5mp-jgw5-2x6j). Retains the CommonJS `parse(string)` API with protected table handling and bounded nesting. |
| `@solana/web3.js` | `jayson@5.0.0`; [jayson](https://github.com/tedeh/jayson), MIT | [GHSA-528h-pc64-c93x](https://github.com/advisories/GHSA-528h-pc64-c93x). Removes `stream-json`; Subly uses the retained browser client over HTTP. The changed TCP/TLS transports are outside Subly's tested scope. |

Lockfiles record registry tarball URLs and SHA-512 integrity. These replacements
have source/distribution review and compatibility coverage, not an independent
security audit or verified build provenance. Docker and CI install dependencies
with lifecycle scripts disabled; the bigint fix does not depend on that setting.

## GitHub alias correction

GitHub's dependency graph can identify the installed Exodus fork as the original
`bigint-buffer` package and attach its native-code advisory. Before Dependency
Review, [`review-bigint-buffer-alias.mjs`](../scripts/review-bigint-buffer-alias.mjs)
checks every tracked npm lockfile against the reviewed fork's name, exact version,
registry URL and SHA-512 integrity. It also requires the exact override and
rejects native packages, install hooks, unsupported lockfiles and missing locks.

Only a successful match permits the single `GHSA-3gc7-fjrx-p6mg` identity
correction in Dependency Review. npm audit has no advisory exceptions. If the
aliases are removed, the script emits no correction. Remove this CI correction
when GitHub identifies the fork correctly.

## Compatibility checks and limits

[`dependency-compatibility.test.ts`](../tests/dependency-compatibility.test.ts)
exercises actual installed resolver paths:

- Both Solana layout-utils versions: unsigned 64/128/192/256-bit conversions,
  both byte orders, account offsets, unchanged surrounding bytes and invalid input.
- Anchor: workspace configuration parsing, prototype traversal rejection and
  excessive nesting rejection.
- Web3's HTTP connection: account reads, batching, request IDs, RPC errors and
  malformed responses using local fixtures.

[`dependency-review-alias.test.ts`](../tests/dependency-review-alias.test.ts)
checks the approved artifact and rejects altered or incomplete dependency graphs.
These tests cover Subly's usage, not every upstream API.

The Kamino graph has existing Solana Kit/sysvars and optional `utf-8-validate`
peer-range mismatches reported by `npm ls --all --omit=dev --package-lock-only`.
The overrides did not introduce them. `npm ls --depth=0` does not validate
transitive peer compatibility; SDK alignment requires its own compatibility checks.

Keep the root Kamino SDK out of the published client. `npm run test:package`
checks the client tarball allowlist and installs it in isolation. See the
[security model](security-model.md) and [release process](../RELEASE.md).
