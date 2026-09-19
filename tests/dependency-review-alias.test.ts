import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const script = resolve("scripts/review-bigint-buffer-alias.mjs");
const rootLock = JSON.parse(readFileSync("package-lock.json", "utf8"));
const rootPackage = JSON.parse(readFileSync("package.json", "utf8"));
const clientLock = JSON.parse(readFileSync("packages/pay/package-lock.json", "utf8"));
const clientPackage = JSON.parse(readFileSync("packages/pay/package.json", "utf8"));
const aliasPaths = Object.keys(rootLock.packages).filter(path => rootLock.packages[path].name === "@exodus/bigint-buffer");
const directories: string[] = [];
afterEach(() => { for (const dir of directories.splice(0)) rmSync(dir, { recursive: true, force: true }); });

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "subly-alias-review-")); directories.push(dir);
  mkdirSync(join(dir, "packages/pay"), { recursive: true });
  const lock = structuredClone(rootLock);
  const client = structuredClone(clientLock);
  const pkg = structuredClone(rootPackage);
  const output = join(dir, "github-output");
  execFileSync("git", ["init", "--quiet"], { cwd: dir });
  return {
    dir, lock, client, pkg,
    run() {
      for (const [file, value] of [["package.json", pkg], ["package-lock.json", lock],
        ["packages/pay/package.json", clientPackage], ["packages/pay/package-lock.json", client]] as const) {
        writeFileSync(join(dir, file), JSON.stringify(value));
      }
      execFileSync("git", ["add", "."], { cwd: dir });
      const result = spawnSync(process.execPath, [script], { cwd: dir, encoding: "utf8",
        env: { ...process.env, GITHUB_OUTPUT: output } });
      return { ...result, output: existsSync(output) ? readFileSync(output, "utf8") : "" };
    }
  };
}

describe("GitHub dependency review alias identity guard", () => {
  it("allows only the one false-positive advisory after validating both installed aliases", () => {
    expect(aliasPaths).toHaveLength(2);
    const result = fixture().run();
    expect(result.status, result.stderr).toBe(0);
    expect(result.output).toBe("allow-ghsas=GHSA-3gc7-fjrx-p6mg\n");
  });

  it.each([
    ["name", "bigint-buffer"], ["version", "1.1.5-exodus.2"], ["version", "1.1.5"],
    ["resolved", "https://registry.npmjs.org/bigint-buffer/-/bigint-buffer-1.1.5.tgz"],
    ["resolved", "https://unreviewed.example/bigint-buffer.tgz"], ["integrity", "sha512-different"],
    ["hasInstallScript", true]
  ])("rejects a changed %s without emitting an exception", (field, value) => {
    const f = fixture(); f.lock.packages[aliasPaths[1]!][field] = value;
    const result = f.run();
    expect(result.status).not.toBe(0); expect(result.output).toBe("");
  });

  it.each(["root", "client", "renamed-alias"])("rejects native bigint-buffer added to %s", location => {
    const f = fixture();
    const lock = location === "client" ? f.client : f.lock;
    lock.packages[`node_modules/${location === "renamed-alias" ? "hidden-native" : "bigint-buffer"}`] = {
      version: "1.1.5", resolved: "https://registry.npmjs.org/bigint-buffer/-/bigint-buffer-1.1.5.tgz", integrity: "sha512-native"
    };
    const result = f.run();
    expect(result.status).not.toBe(0); expect(result.output).toBe("");
  });

  it("rejects a changed override even if the old lock entry is retained", () => {
    const f = fixture(); f.pkg.overrides["@solana/buffer-layout-utils"]["bigint-buffer"] = "^1.1.5";
    const result = f.run(); expect(result.status).not.toBe(0); expect(result.output).toBe("");
  });

  it("emits no exception when the dependency is removed", () => {
    const f = fixture(); for (const path of aliasPaths) delete f.lock.packages[path];
    delete f.pkg.overrides["@solana/buffer-layout-utils"];
    const result = f.run(); expect(result.status, result.stderr).toBe(0); expect(result.output).toBe("allow-ghsas=\n");
  });

  it.each(["extra/package.json", "yarn.lock"])("fails closed for unreviewed manifest coverage: %s", file => {
    const f = fixture(); mkdirSync(join(f.dir, "extra")); writeFileSync(join(f.dir, file), "{}");
    const result = f.run(); expect(result.status).not.toBe(0); expect(result.output).toBe("");
  });
});
