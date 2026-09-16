import { closeSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import type {
  StandardX402PendingPaymentRecord,
  StandardX402StateStore
} from "./standard-x402-payer.js";

export function fileStandardX402StateStore(path: string): StandardX402StateStore {
  return {
    async withExclusiveLock<T>(operation: () => Promise<T>): Promise<T> {
      mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
      const lockPath = `${path}.lock`;
      let fd: number;
      try {
        fd = openSync(lockPath, "wx", 0o600);
      } catch (error) {
        if (error && typeof error === "object" && "code" in error && error.code === "EEXIST") {
          throw new Error(`Payment state is locked: ${lockPath}. Another client may be paying. After a crash, stop all clients before removing only this .lock file; preserve the payment state JSON.`);
        }
        throw error;
      }
      try {
        writeFileSync(fd, JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }));
        return await operation();
      } finally {
        closeSync(fd);
        unlinkSync(lockPath);
      }
    },
    load(): StandardX402PendingPaymentRecord[] {
      let text: string;
      try {
        text = readFileSync(path, "utf8");
      } catch (error) {
        if (isMissingFileError(error)) {
          return [];
        }
        throw error;
      }

      const parsed: unknown = JSON.parse(text);
      if (!Array.isArray(parsed)) {
        throw new Error(`pending payment state is not an array: ${path}`);
      }
      for (const [index, record] of parsed.entries()) {
        if (!isPendingPaymentRecord(record)) {
          throw new Error(
            `pending payment state has an invalid record at index ${index}: ${path}`
          );
        }
      }
      return parsed;
    },
    save(records: StandardX402PendingPaymentRecord[]): void {
      const directory = dirname(path);
      mkdirSync(directory, { recursive: true, mode: 0o700 });
      const tempPath = join(
        directory,
        `.${basename(path)}.${process.pid}.${Date.now()}.tmp`
      );
      writeFileSync(tempPath, JSON.stringify(records, null, 2), { mode: 0o600, flag: "wx" });
      renameSync(tempPath, path);
    }
  };
}

function isMissingFileError(error: unknown): boolean {
  return (
    error !== null &&
    typeof error === "object" &&
    "code" in error &&
    error.code === "ENOENT"
  );
}

function isPendingPaymentRecord(
  value: unknown
): value is StandardX402PendingPaymentRecord {
  if (value === null || typeof value !== "object") {
    return false;
  }
  const record = value as Record<string, unknown>;
  return (
    typeof record.key === "string" &&
    typeof record.url === "string" &&
    typeof record.method === "string" &&
    typeof record.requestBodyHash === "string" &&
    typeof record.amountRawUsdc === "string" &&
    typeof record.payTo === "string" &&
    (record.feePayer === null || typeof record.feePayer === "string") &&
    typeof record.realizedRawUsdc === "string" &&
    (record.realizeTxSignature === null ||
      typeof record.realizeTxSignature === "string") &&
    (record.status === "realized" ||
      record.status === "external_outcome_unknown") &&
    typeof record.createdAtMs === "number" &&
    typeof record.updatedAtMs === "number"
  );
}
