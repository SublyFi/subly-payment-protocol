# Dependency status

Reviewed 2026-09-19 against the npm lockfiles. Registry advisories can change after this date. The client and relayer use separate dependency graphs and Solana Kit versions; do not assume a successful client audit covers the server.

| Distribution | `npm audit --omit=dev` at review | Release policy |
| --- | --- | --- |
| `@subly_fi/pay` | 0 vulnerabilities | CI/release gate at high severity; no exceptions |
| Root relayer | 0 vulnerabilities | `node scripts/audit-relayer.mjs` rejects every reported vulnerability and audit retrieval failure; no exceptions |

The relayer previously had 14 affected package entries representing four distinct advisories. Three exact, parent-scoped dependency overrides remove their affected implementations without migrating Kamino or Solana SDK versions. They are compatibility exceptions to the upstream dependency ranges, so keep the tests below when upgrading. The root's full audit, including development dependencies, also reports zero vulnerabilities at review.

| Advisory | Resolved dependency | Compatibility and scope |
| --- | --- | --- |
| [GHSA-3gc7-fjrx-p6mg](https://github.com/advisories/GHSA-3gc7-fjrx-p6mg) | Under `@solana/buffer-layout-utils`, alias `bigint-buffer` to `npm:@exodus/bigint-buffer@1.1.5-exodus.1` | Exodus's fork removes the native binding and retains the four existing JavaScript conversion APIs. Both layout-utils 0.3 and legacy 0.2 resolve it. The vulnerable native code is absent, including when lifecycle scripts are enabled. |
| [GHSA-82x6-q7mm-w9cf](https://github.com/advisories/GHSA-82x6-q7mm-w9cf), [GHSA-v5mp-jgw5-2x6j](https://github.com/advisories/GHSA-v5mp-jgw5-2x6j) | Under `@coral-xyz/anchor`, `toml@4.2.0` | This upstream release includes both fixes. Anchor uses the retained CommonJS `parse(string)` API for workspace configuration. Version 4.2 supports TOML 1.1; Subly has no public TOML upload/parser endpoint. Node >=20 is within Subly's Node >=24 requirement. |
| [GHSA-528h-pc64-c93x](https://github.com/advisories/GHSA-528h-pc64-c93x) | Under `@solana/web3.js`, `jayson@5.0.0` | The upstream release removes `stream-json` entirely. Its breaking transport change concerns delimiters on TCP/TLS streams; Subly's Web3 connection uses `jayson/lib/client/browser` over HTTP. Request IDs now use native crypto instead of `uuid`. |

## Source and distributed code review

All three registry tarballs were downloaded and inspected at the pinned versions. Their registry repository metadata points to the public projects below, and their lockfile entries record the registry URLs and SHA-512 integrity hashes. This is a source/distribution review, not a claim of verified build provenance or an independent security audit.

| Package | Public source / license | Inspected distribution |
| --- | --- | --- |
| `@exodus/bigint-buffer@1.1.5-exodus.1` | [Exodus fork](https://github.com/ExodusMovement/bigint-buffer), Apache-2.0 | Exactly six files: package metadata, README, license, declarations, and the Node/browser JavaScript builds. Both builds use the previous pure-JavaScript conversions; no native binaries, native source, binding loader, runtime dependencies, or install/postinstall hook is shipped. |
| `toml@4.2.0` | [BinaryMuse/toml-node](https://github.com/BinaryMuse/toml-node), MIT; [release history](https://github.com/BinaryMuse/toml-node/blob/master/CHANGELOG.md) | CommonJS entry and generated JavaScript parser, with the protected table handling and default maximum nesting depth of 500; no runtime dependencies. We pin 4.2.0 rather than adopting later changes unrelated to these fixes. |
| `jayson@5.0.0` | [tedeh/jayson](https://github.com/tedeh/jayson), MIT | Browser client retains request generation, callbacks, batching, error propagation, and response parsing. The relevant functional change is its local crypto ID generator. Neither `stream-json` nor `uuid` remains in its dependency list. |

## GitHub alias identity correction

At review, GitHub's dependency-graph API reports the installed alias as `pkg:npm/bigint-buffer@1.1.5-exodus.1` rather than `pkg:npm/%40exodus/bigint-buffer@1.1.5-exodus.1`, incorrectly attaching the original package's native-code advisory. The registry tarball and lockfile `name` identify the reviewed Exodus fork. This false positive is separate from npm audit, which reports no vulnerabilities and has no advisory exceptions.

The Dependency Review job runs `scripts/review-bigint-buffer-alias.mjs` before the upstream action. It inspects every tracked npm lockfile, requiring every bigint-buffer entry to match the reviewed fork's name, exact version, registry tarball URL, and SHA-512 integrity. Native packages, a new fork version, changed integrity, changed override, install hooks, unsupported package-manager locks, or missing npm locks fail the job. Only a successful match emits the single `GHSA-3gc7-fjrx-p6mg` correction for the action. Removing the aliases emits no exception. This does not permit that advisory for an arbitrary version or let the original native package return.

`tests/dependency-review-alias.test.ts` verifies the allowed artifact and those rejection cases. Remove the correction when GitHub resolves the alias identity, or replace it with a verified complete dependency submission. The [current action consumes GitHub's comparison response](https://github.com/actions/dependency-review-action/blob/main/src/dependency-graph.ts), so upgrading the action alone does not repair the returned package identity. GitHub's [dependency submission API](https://docs.github.com/en/rest/dependency-graph/dependency-submission) can supply correct package URLs and takes precedence over static analysis; adopting it requires complete manifest coverage and write permission.

## Compatibility validation and limits

`tests/dependency-compatibility.test.ts` exercises the installed resolver paths rather than separate copies of the replacements:

- Both Solana layout-utils versions encode/decode unsigned 64/128/192/256-bit fields in each byte order, including zero, one, maximum values, nonuniform bytes, and nonzero offsets. The tests verify that surrounding account bytes and decoded input are unchanged, and that the replacement handles empty buffers and rejects null inputs with exceptions.
- Anchor's parser reads representative workspace/provider/program configuration and rejects prototype traversal and excessive nesting payloads without prototype mutation or stack exhaustion.
- Web3's real `Connection` class uses an in-memory HTTP fetch fixture for balance reads, public transaction batches, generated request IDs, RPC errors, and malformed JSON. No network call or on-chain transaction is required.

These tests cover Subly's dependency usage, not every API offered by those packages. In particular, Jayson TCP/TLS transports are outside Subly's tested scope. The normal relayer and client suites, typecheck, build, and package isolation checks remain release requirements. A clean audit is not proof that dependencies have no undisclosed defects.

The existing Kamino graph still contains Solana Kit/sysvars and optional `utf-8-validate` peer-range mismatches reported by `npm ls --all --omit=dev --package-lock-only`. The same three invalid-peer reports were reproduced from the pre-change manifest and lockfile in a separate directory; these overrides did not introduce them. `npm ls --depth=0` is clean, but does not validate the whole transitive graph. Resolving those upstream peer ranges requires a separately tested SDK alignment rather than changing transaction SDK majors solely to silence diagnostics.

Docker keeps `--ignore-scripts` as an installation policy; the bigint fix no longer depends on suppressing native compilation. The Security workflow runs weekly; Dependabot checks root/client/Actions independently.

Do not copy the root Kamino SDK into the published client. `npm run test:package` checks the tarball allowlist and installs it separately. See [security model](security-model.md) and [release process](../RELEASE.md).
