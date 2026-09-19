import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { appendFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import nacl from "tweetnacl";
import { isTransientNpmFailure, parseJson, runNpm, withNpmRetries } from "./npm-checks.mjs";

const packageName = "@subly_fi/pay";
const registry = "https://registry.npmjs.org";
const packageDirectory = fileURLToPath(new URL("../packages/pay/", import.meta.url));
const isNotFound = result => !result.error && !result.signal && result.status === 1 && parseJson(result.stdout)?.error?.code === "E404";

export function validatePublishedMetadata(metadata, { version, commit, requireProvenance = false }) {
  assert.equal(metadata?.name, packageName, "Unexpected registry package");
  assert.equal(metadata.version, version, "Registry version does not match the requested version");
  assert.match(metadata.dist?.integrity ?? "", /^sha512-[A-Za-z0-9+/]+={0,2}$/, "Missing registry SHA-512 integrity");
  assert.equal(new URL(metadata.dist?.tarball).origin, registry, "Unexpected tarball registry");
  if (commit) assert.equal(metadata.gitHead, commit, "Published version belongs to a different commit; never replace a release tag");
  if (requireProvenance) {
    assert.equal(metadata.dist?.attestations?.provenance?.predicateType, "https://slsa.dev/provenance/v1", "Missing npm provenance metadata");
    assert.equal(new URL(metadata.dist.attestations.url).origin, registry, "Unexpected attestation registry");
  }
  return metadata;
}

export async function readPublishedMetadata({ version, commit, requireProvenance = false, allowMissing = false, run = runNpm, ...retryOptions }) {
  assert.match(version, /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/, "An exact release version is required");
  const result = await withNpmRetries(() => run([
    "view", `${packageName}@${version}`, "name", "version", "gitHead", "dist", "--json",
    `--registry=${registry}`, "--fetch-retries=0", "--fetch-timeout=15000"
  ]), {
    ...retryOptions,
    // A newly published immutable version may need a short registry propagation delay.
    retryable: result => isTransientNpmFailure(result) || (!allowMissing && isNotFound(result))
  });
  if (allowMissing && isNotFound(result)) return null;
  assert(!result.error && !result.signal && result.status === 0, "Could not verify exact version availability in the npm registry");
  return validatePublishedMetadata(parseJson(result.stdout), { version, commit, requireProvenance });
}

export async function verifyRegistryInstall(metadata) {
  const directory = mkdtempSync(join(tmpdir(), "subly-registry-"));
  let transport;
  try {
    // Keep registry credentials, existing wallets, and project configuration out of this smoke test.
    const osEnv = Object.fromEntries(["PATH", "SystemRoot", "WINDIR", "ComSpec", "PATHEXT", "TEMP", "TMP", "TMPDIR"].flatMap(name => {
      const key = Object.keys(process.env).find(key => key.toLowerCase() === name.toLowerCase());
      return key && process.env[key] !== undefined ? [[name, process.env[key]]] : [];
    }));
    const userConfig = join(directory, "npm-user.ini");
    const globalConfig = join(directory, "npm-global.ini");
    writeFileSync(userConfig, "");
    writeFileSync(globalConfig, "");
    const env = { ...osEnv, npm_config_userconfig: userConfig, npm_config_globalconfig: globalConfig,
      npm_config_cache: join(directory, "npm-cache") };
    writeFileSync(join(directory, "package.json"), JSON.stringify({ name: "subly-registry-verification", private: true, version: "1.0.0" }));
    const installed = await withNpmRetries(() => runNpm([
      "install", `${packageName}@${metadata.version}`, "--ignore-scripts", "--no-audit", "--no-fund",
      `--registry=${registry}`, "--fetch-retries=0", "--fetch-timeout=15000"
    ], { cwd: directory, env, timeout: 180_000 }));
    assert(!installed.error && !installed.signal && installed.status === 0, "Clean installation of the exact registry version failed");
    const packagePath = join(directory, "node_modules/@subly_fi/pay");
    const installedPackage = JSON.parse(readFileSync(join(packagePath, "package.json"), "utf8"));
    assert.equal(installedPackage.version, metadata.version);
    const installedLock = JSON.parse(readFileSync(join(directory, "package-lock.json"), "utf8"));
    assert.equal(installedLock.packages["node_modules/@subly_fi/pay"].integrity, metadata.dist.integrity, "Installed artifact does not match registry integrity");
    const cli = join(packagePath, "dist/cli.js");
    const keyPath = join(directory, "smoke-agent.json");
    writeFileSync(keyPath, JSON.stringify(Array.from(nacl.sign.keyPair().secretKey)), { mode: 0o600 });
    const cliEnv = { ...env, SUBLY_RELAYER_URL: "http://127.0.0.1:1", SOLANA_RPC_URL: "http://127.0.0.1:1", SUBLY_MCP_STATE_PATH: join(directory, "pending.json"), SUBLY_DEMO_AGENT_KEYPAIR_PATH: keyPath };
    const run = args => execFileSync(process.execPath, [cli, ...args], { cwd: directory, env: cliEnv, encoding: "utf8", timeout: 15_000 });
    assert.equal(run(["--version"]).trim(), metadata.version);
    assert.match(run(["--help"]), /doctor/);
    transport = new StdioClientTransport({ command: process.execPath, args: [cli, "mcp"], cwd: directory, env: cliEnv, stderr: "pipe" });
    const client = new Client({ name: "registry-release-verification", version: "1.0.0" });
    await client.connect(transport, { timeout: 15_000 });
    const { tools } = await client.listTools({}, { timeout: 15_000 });
    const [major, minor, patch] = metadata.version.split(".").map(Number);
    const ownerTools = major > 0 || minor > 8 || (minor === 8 && patch >= 3)
      ? ["create_subly_owner_link", "check_subly_owner_session", "get_subly_owner_status", "start_subly_owner_recovery"] : [];
    for (const name of ["list_subly_vaults", "select_subly_vault", "create_subly_setup_link", "check_subly_setup", "check_subly_vault_operation", "deposit_to_subly_vault", "get_subly_yield_budget", "withdraw_from_subly_vault", "fetch_with_subly_payment", ...ownerTools]) {
      assert(tools.some(tool => tool.name === name), `Published MCP server is missing ${name}`);
    }
    await client.close();
    console.log(`Verified registry ${packageName}@${metadata.version}: SHA-512 integrity, CLI version/help, and ${tools.length} MCP tools. No chain transactions were sent.`);
  } finally {
    await transport?.close();
    rmSync(directory, { recursive: true, force: true });
  }
}

async function main() {
  const args = process.argv.slice(2);
  const versionIndex = args.indexOf("--version");
  const version = versionIndex >= 0 ? args[versionIndex + 1] : JSON.parse(readFileSync(join(packageDirectory, "package.json"), "utf8")).version;
  const checkState = args.includes("--check-publish-state");
  const metadata = await readPublishedMetadata({ version, commit: process.env.RELEASE_COMMIT, requireProvenance: args.includes("--require-provenance"), allowMissing: checkState });
  if (checkState) {
    assert(process.env.RELEASE_COMMIT, "Publish state checks require RELEASE_COMMIT");
    if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `published=${metadata !== null}\n`);
    console.log(metadata ? `Exact version is already published from ${process.env.RELEASE_COMMIT}; verifying instead of republishing.` : `Exact version ${version} is available for publication.`);
  } else {
    await verifyRegistryInstall(metadata);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  await main().catch(error => { console.error(error.message); process.exitCode = 1; });
}
