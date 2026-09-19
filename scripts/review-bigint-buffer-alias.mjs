import { execFileSync } from "node:child_process";
import { appendFileSync, readFileSync } from "node:fs";
import { dirname, posix } from "node:path";

// GitHub's static npm graph currently labels this alias with its install-path
// name instead of the registry identity. Never exempt the native package, a
// different fork/version, or a tarball that has not been reviewed.
const reviewed = {
  name: "@exodus/bigint-buffer",
  version: "1.1.5-exodus.1",
  resolved: "https://registry.npmjs.org/@exodus/bigint-buffer/-/bigint-buffer-1.1.5-exodus.1.tgz",
  integrity: "sha512-FpuaB1YsPC5EJQ7GVQt6oJbxK7Tr3rs/PXshEJgx06hnaU2nFmmtbVi6pqIfXKDOO7whmi/1t5NtBlfC/H0y+w=="
};
const advisory = "GHSA-3gc7-fjrx-p6mg";
const tracked = execFileSync("git", ["ls-files", "-z"], { encoding: "utf8" }).split("\0").filter(Boolean);
const readJson = (file) => JSON.parse(readFileSync(file, "utf8"));
const packageFiles = tracked.filter((file) => posix.basename(file) === "package.json");
const lockFiles = tracked.filter((file) => posix.basename(file) === "package-lock.json");
const otherLocks = tracked.filter((file) => ["npm-shrinkwrap.json", "yarn.lock", "pnpm-lock.yaml", "bun.lock", "bun.lockb"].includes(posix.basename(file)));
if (otherLocks.length > 0) throw new Error(`Alias exception requires review of additional package managers: ${otherLocks.join(", ")}`);
if (packageFiles.length === 0 || lockFiles.length === 0) throw new Error("No tracked npm manifests/lockfiles found");
for (const file of packageFiles) {
  const expectedLock = posix.join(dirname(file), "package-lock.json");
  if (!lockFiles.includes(expectedLock)) throw new Error(`Alias exception requires a reviewed lockfile for ${file}`);
}

let aliases = 0;
for (const file of lockFiles) {
  const lock = readJson(file);
  if (lock.lockfileVersion !== 3 || !lock.packages || typeof lock.packages !== "object") {
    throw new Error(`Unsupported npm lockfile format: ${file}`);
  }
  for (const [path, entry] of Object.entries(lock.packages)) {
    const resolved = typeof entry?.resolved === "string" ? entry.resolved : "";
    // Also catch aliases under a different folder name, scoped forks, and a
    // forged name field pointing at the original native registry tarball.
    if (posix.basename(path) !== "bigint-buffer" &&
        !/(^|\/)bigint-buffer$/.test(entry?.name ?? "") &&
        !resolved.includes("/bigint-buffer/")) continue;
    for (const [field, value] of Object.entries(reviewed)) {
      if (entry[field] !== value) throw new Error(`Unreviewed bigint-buffer ${field} in ${file}: ${path}`);
    }
    if (entry.hasInstallScript === true) throw new Error(`Unexpected install script in ${file}: ${path}`);
    aliases++;
  }
}

// An absent alias needs no exception. Presence requires the exact scoped
// override too, so the manifest and reviewed artifact cannot silently diverge.
if (aliases > 0 && readJson("package.json").overrides?.["@solana/buffer-layout-utils"]?.["bigint-buffer"] !==
    `npm:${reviewed.name}@${reviewed.version}`) {
  throw new Error("The reviewed bigint-buffer override is missing or changed");
}
const allowed = aliases > 0 ? advisory : "";
if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `allow-ghsas=${allowed}\n`);
console.log(allowed
  ? `Verified ${aliases} exact pure-JavaScript aliases; correct only ${advisory}'s GitHub alias false positive.`
  : "No bigint-buffer aliases installed; no dependency-review exception.");
