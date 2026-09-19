import { afterEach, describe, expect, it } from "vitest";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

const temporaryDirectories: string[] = [];
afterEach(() => { for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true }); });
const script = resolve("scripts/backup-postgres.sh");

function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "subly-backup-"))); temporaryDirectories.push(root);
  const bin = join(root, "bin"); const deploy = join(root, "deploy with spaces");
  const backups = join(root, "private backups $(not-a-command)"); const log = join(root, "calls.jsonl");
  mkdirSync(bin); mkdirSync(deploy);
  writeFileSync(join(deploy, "docker-compose.yml"), "services: {}\n");
  const docker = join(bin, "docker");
  writeFileSync(docker, `#!${process.execPath}
const fs = require("node:fs");
fs.appendFileSync(process.env.BACKUP_TEST_LOG, JSON.stringify(process.argv.slice(2)) + "\\n");
if (process.argv.includes("pg_dump")) {
  if (process.env.BACKUP_TEST_MODE !== "empty") process.stdout.write("PGDMP-complete-test-archive");
  if (process.env.BACKUP_TEST_MODE === "dump-failure") process.exitCode = 19;
  if (process.env.BACKUP_TEST_MODE === "interrupted") process.kill(process.ppid, "SIGTERM");
} else if (process.argv.includes("pg_restore")) {
  const data = fs.readFileSync(0, "utf8");
  if (data !== "PGDMP-complete-test-archive" || process.env.BACKUP_TEST_MODE === "validation-failure") process.exitCode = 23;
} else { process.exitCode = 99; }
`);
  chmodSync(docker, 0o755);
  writeFileSync(join(bin, "ln"), '#!/bin/sh\n[ "$BACKUP_TEST_MODE" != "publish-failure" ] || exit 37\nexec /bin/ln "$@"\n');
  chmodSync(join(bin, "ln"), 0o755);
  const run = (mode = "ok", args = ["--backup-dir", backups, "--deploy-dir", deploy]) => spawnSync("bash", [script, ...args], {
    encoding: "utf8", env: { ...process.env, PATH: `${bin}${delimiter}${process.env.PATH ?? ""}`, BACKUP_TEST_LOG: log, BACKUP_TEST_MODE: mode }
  });
  const calls = (): string[][] => existsSync(log) ? readFileSync(log, "utf8").trim().split("\n").map(line => JSON.parse(line) as string[]) : [];
  return { root, backups, deploy, run, calls };
}

describe.skipIf(process.platform === "win32")("PostgreSQL backup operator script", () => {
  it("publishes only a checked archive, uses literal paths, and restricts permissions", () => {
    const f = fixture(); const result = f.run();
    expect(result.status, result.stderr).toBe(0);
    const archive = result.stdout.trim();
    expect(archive.startsWith(`${f.backups}/subly-`)).toBe(true);
    expect(archive.endsWith(".dump")).toBe(true);
    expect(readFileSync(archive, "utf8")).toBe("PGDMP-complete-test-archive");
    expect(statSync(archive).mode & 0o777).toBe(0o600);
    expect(statSync(f.backups).mode & 0o777).toBe(0o700);
    expect(readdirSync(f.backups)).toHaveLength(1);
    expect(f.calls()).toEqual([
      ["compose", "--project-directory", f.deploy, "--file", join(f.deploy, "docker-compose.yml"), "exec", "-T", "postgres", "pg_dump", "--username=postgres", "--dbname=subly", "--format=custom", "--no-owner", "--no-privileges"],
      ["compose", "--project-directory", f.deploy, "--file", join(f.deploy, "docker-compose.yml"), "exec", "-T", "postgres", "pg_restore", "--no-owner", "--no-privileges", "--file=/dev/null"]
    ]);
  });

  it.each(["dump-failure", "empty", "validation-failure", "publish-failure", "interrupted"])("fails and removes incomplete files on %s while preserving older backups", mode => {
    const f = fixture(); mkdirSync(f.backups); writeFileSync(join(f.backups, "existing.dump"), "keep");
    const result = f.run(mode);
    expect(result.status).not.toBe(0); expect(result.stdout).toBe("");
    expect(readdirSync(f.backups)).toEqual(["existing.dump"]);
    expect(readFileSync(join(f.backups, "existing.dump"), "utf8")).toBe("keep");
    expect(f.calls()).toHaveLength(["validation-failure", "publish-failure"].includes(mode) ? 2 : 1);
  });

  it("uses a fresh name on repeated runs instead of overwriting a successful backup", () => {
    const f = fixture(); const first = f.run(); const second = f.run();
    expect(first.status).toBe(0); expect(second.status).toBe(0);
    expect(first.stdout).not.toBe(second.stdout); expect(readdirSync(f.backups)).toHaveLength(2);
  });

  it.each([[], ["--backup-dir"], ["--unknown"], ["--backup-dir", "relative"], ["--backup-dir", "/tmp/bad\npath"]].map(args => ({ args })))("rejects invalid arguments before invoking Docker: $args", ({ args }) => {
    const f = fixture(); const result = f.run("ok", [...args, "--deploy-dir", f.deploy]);
    expect(result.status).not.toBe(0); expect(f.calls()).toEqual([]);
  });

  it("prints help without accessing the database", () => {
    const f = fixture(); const result = f.run("ok", ["--help"]);
    expect(result.status).toBe(0); expect(result.stdout).toContain("Usage:"); expect(f.calls()).toEqual([]);
  });
});
