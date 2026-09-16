# Dependency status — 0.7.1

Reviewed 2026-09-16 against the committed npm lockfiles. Registry advisories can change after this date. The client and relayer use separate dependency graphs and Solana Kit versions; do not assume a successful client audit covers the server.

| Distribution | `npm audit --omit=dev` at review | Release policy |
| --- | --- | --- |
| `@subly_fi/pay` | 0 vulnerabilities | CI/release gate at high severity; no exceptions |
| Root relayer | 14 affected package entries: 12 high, 2 moderate | Four known advisories tracked below; any unrecognized advisory fails CI |

Counts include transitive dependents; they do not mean 14 independent defects. Patch-compatible dependency updates have been applied. A forced major SDK/parser override is not treated as a verified fix for transaction code.

| Advisory | Dependency / exposure | Current mitigation and remaining work |
| --- | --- | --- |
| [GHSA-3gc7-fjrx-p6mg](https://github.com/advisories/GHSA-3gc7-fjrx-p6mg) | `bigint-buffer` native `toBigIntLE` overflow, pulled through Kamino/Solana SDKs | Runtime Docker installs with `--ignore-scripts`, leaving the supported pure-JS fallback. Do not rebuild native bindings in production. Package remains flagged; replace through a compatibility-tested upstream upgrade. |
| [GHSA-82x6-q7mm-w9cf](https://github.com/advisories/GHSA-82x6-q7mm-w9cf), [GHSA-v5mp-jgw5-2x6j](https://github.com/advisories/GHSA-v5mp-jgw5-2x6j) | Anchor's transitive `toml`: recursion / prototype pollution | Relayer does not expose TOML parsing or Anchor workspaces to HTTP callers. Runtime image contains no Anchor workspace/config upload path. Do not parse untrusted TOML in this process. Await/test compatible parser or SDK update. |
| [GHSA-528h-pc64-c93x](https://github.com/advisories/GHSA-528h-pc64-c93x) | `stream-json` via `jayson`: pathological filtering cost | Use trusted HTTPS RPC upstreams; Subly exposes no streaming JSON filter endpoint. Upstream legacy Web3 dependencies still include the package. Review/remove on SDK migration. |

These are mitigations and reachability observations, **not proof of absence of exploitation**. Operators must assess the residual risk before mainnet use. The ordinary root audit intentionally remains nonzero; `node scripts/audit-relayer.mjs` prints every tracked advisory and rejects additions. The Security workflow runs weekly; Dependabot checks root/client/Actions independently. Exceptions must be reviewed when upgrading or when new reachability evidence appears.

Do not copy the root Kamino SDK into the published client. `npm run test:package` checks the tarball allowlist and installs it separately. See [security model](security-model.md) and [release process](../RELEASE.md).
