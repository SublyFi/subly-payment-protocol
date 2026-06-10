import { createHash } from "node:crypto";

type JsonLike =
  | string
  | number
  | boolean
  | null
  | bigint
  | JsonLike[]
  | { [key: string]: JsonLike | undefined };

export const EMPTY_BODY_HASH =
  "sha256-e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";

export function sha256TaggedHex(data: string | Buffer): string {
  return `sha256-${createHash("sha256").update(data).digest("hex")}`;
}

export function stableStringify(value: JsonLike): string {
  if (value === null) {
    return "null";
  }

  if (typeof value === "bigint") {
    return JSON.stringify(value.toString());
  }

  if (
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  ) {
    return JSON.stringify(value);
  }

  if (Array.isArray(value)) {
    return `[${value.map((item) => stableStringify(item)).join(",")}]`;
  }

  const keys = Object.keys(value)
    .filter((key) => value[key] !== undefined)
    .sort();

  return `{${keys
    .map((key) => `${JSON.stringify(key)}:${stableStringify(value[key]!)}`)
    .join(",")}}`;
}

export function hashStableJson(value: JsonLike): string {
  return sha256TaggedHex(stableStringify(value));
}
