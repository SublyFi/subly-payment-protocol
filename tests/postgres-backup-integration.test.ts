import { expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { randomBytes } from "node:crypto";
import { spawnSync } from "node:child_process";

// A separate Compose project with no host ports or production credentials.
// Enable in Docker-equipped CI; the ordinary offline suite never starts Docker.
it.skipIf(process.env.SUBLY_TEST_BACKUP_COMPOSE !== "1" || process.platform === "win32")(
  "backs up and restores a real disposable PostgreSQL 16 database", () => {
    const directory = mkdtempSync(join(tmpdir(), "subly-backup-integration-"));
    const project = `subly-backup-test-${randomBytes(6).toString("hex")}`;
    const composeFile = join(directory, "docker-compose.yml");
    const env = { ...process.env, COMPOSE_PROJECT_NAME: project };
    writeFileSync(composeFile, `services:
  postgres:
    image: postgres:16-alpine@sha256:cf78e76683b9ca8c5733cbbdce6c9262b45b6767934dd0a95e671f9a0fc20685
    environment:
      POSTGRES_PASSWORD: disposable-test-only
      POSTGRES_DB: subly
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U postgres"]
      interval: 1s
      timeout: 3s
      retries: 30
`);
    const composeArgs = ["compose", "--project-directory", directory, "--file", composeFile];
    const docker = (args: string[], input?: string | Buffer) => {
      const result = spawnSync("docker", [...composeArgs, ...args], { env, encoding: "utf8", input, timeout: 120_000 });
      if (result.status !== 0) throw new Error(`Disposable PostgreSQL command failed: ${result.stderr || result.error?.message}`);
      return result.stdout;
    };
    try {
      docker(["up", "-d", "--wait", "postgres"]);
      docker(["exec", "-T", "postgres", "psql", "-U", "postgres", "-d", "subly", "-v", "ON_ERROR_STOP=1", "-c",
        "CREATE TABLE backup_fixture (wallet text PRIMARY KEY, principal bigint, fee_debt bigint); INSERT INTO backup_fixture VALUES ('test-wallet', 1000000, 1250);"]);
      const backup = spawnSync("bash", [resolve("scripts/backup-postgres.sh"), "--backup-dir", join(directory, "backups"), "--deploy-dir", directory], {
        env, encoding: "utf8", timeout: 120_000
      });
      expect(backup.status, backup.stderr).toBe(0);
      const archive = readFileSync(backup.stdout.trim());
      expect(archive.subarray(0, 5).toString()).toBe("PGDMP");
      docker(["exec", "-T", "postgres", "createdb", "-U", "postgres", "subly_restore_check"]);
      docker(["exec", "-T", "postgres", "pg_restore", "--exit-on-error", "--single-transaction", "--no-owner", "--no-privileges",
        "--username=postgres", "--dbname=subly_restore_check"], archive);
      const rows = docker(["exec", "-T", "postgres", "psql", "-U", "postgres", "-d", "subly_restore_check", "-At", "-c",
        "SELECT wallet, principal, fee_debt FROM backup_fixture"]);
      expect(rows.trim()).toBe("test-wallet|1000000|1250");
    } finally {
      const cleanup = spawnSync("docker", [...composeArgs, "down", "--volumes", "--remove-orphans"], { env, encoding: "utf8", timeout: 30_000 });
      rmSync(directory, { recursive: true, force: true });
      if (cleanup.status !== 0) throw new Error(`Could not remove disposable backup test project ${project}: ${cleanup.stderr}`);
    }
  }, 180_000
);
