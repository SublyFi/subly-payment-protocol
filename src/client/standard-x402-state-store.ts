import { closeSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import type {
  StandardX402PendingPaymentRecord,
  StandardX402StateStore
} from "./standard-x402-payer.js";
import { standardExactRequirementSchema } from "../x402/standard-requirements.js";

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
      if (new Set(parsed.map((record) => record.key)).size !== parsed.length) {
        throw new Error(`pending payment state has duplicate request keys: ${path}`);
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
      try {
        const fd = openSync(tempPath, "wx", 0o600);
        try {
          writeFileSync(fd, JSON.stringify(records, null, 2));
          fsyncSync(fd);
        } finally { closeSync(fd); }
        renameSync(tempPath, path);
        // Windows cannot open directory handles through this Node API.
        // File contents are flushed everywhere; Unix also persists the rename.
        if (process.platform !== "win32") {
          const directoryFd = openSync(directory, "r");
          try { fsyncSync(directoryFd); }
          finally { closeSync(directoryFd); }
        }
      } finally {
        try { unlinkSync(tempPath); } catch { /* Rename succeeded, or preserve the original I/O error. */ }
      }
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
    (record.status === "realizing" || record.status === "realized" ||
      record.status === "external_outcome_unknown") &&
    (record.recovery === undefined || (isRecoveryRecord(record.recovery) &&
      record.key === `${record.method}:${record.url}:${record.requestBodyHash}` &&
      /^\d+$/.test(String(record.realizedRawUsdc)) && /^\d+$/.test(String(record.amountRawUsdc)))) &&
    typeof record.createdAtMs === "number" &&
    typeof record.updatedAtMs === "number"
  );
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** New recovery records opt into auto-resume, so validate their entire envelope. */
function isRecoveryRecord(value: unknown): boolean {
  if (!isObject(value) || value.version !== 1 || !isObject(value.context)) return false;
  const context = value.context;
  if (!["wallet", "vault", "relayerBaseUrl"].every((key) => typeof context[key] === "string" && context[key] !== "") ||
      typeof value.requestHeadersHash !== "string" || !/^[0-9a-f]{64}$/.test(value.requestHeadersHash) ||
      !standardExactRequirementSchema.safeParse(value.requirement).success) return false;
  if (value.prepared === undefined) return true;
  const prepared = value.prepared;
  if (!isObject(prepared) || !isObject(prepared.signingIntent) || prepared.purpose !== "yield_realize" ||
      !["withdrawalId", "serializedTransaction", "destinationUsdcAta", "requestedWithdrawRawUsdc"].every((key) => typeof prepared[key] === "string" && prepared[key] !== "")) return false;
  const intent = prepared.signingIntent;
  return intent.allowFullExit === false &&
    ["wallet", "vault", "farm", "shareMint", "asset", "destinationUsdcAta", "maxSharesToRedeemRaw", "feePayer", "expiresAt", "preparedMessageHash"]
      .every((key) => typeof intent[key] === "string" && intent[key] !== "");
}
