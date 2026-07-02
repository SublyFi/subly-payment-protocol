import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { fileStandardX402StateStore } from "../src/client/standard-x402-state-store.js";
import type { StandardX402PendingPaymentRecord } from "../src/client/standard-x402-payer.js";

function statePath(): string {
  return join(mkdtempSync(join(tmpdir(), "subly-x402-state-")), "pending.json");
}

function record(): StandardX402PendingPaymentRecord {
  return {
    key: "GET:https://seller.test/resource:empty",
    url: "https://seller.test/resource",
    method: "GET",
    requestBodyHash: "empty",
    amountRawUsdc: "10000",
    payTo: "seller",
    feePayer: null,
    realizedRawUsdc: "10000",
    realizeTxSignature: "sig",
    status: "external_outcome_unknown",
    createdAtMs: 1,
    updatedAtMs: 2
  };
}

describe("fileStandardX402StateStore", () => {
  it("loads empty state when the file does not exist", () => {
    expect(fileStandardX402StateStore(statePath()).load()).toEqual([]);
  });

  it("round-trips pending records", () => {
    const store = fileStandardX402StateStore(statePath());
    const pending = [record()];
    store.save(pending);
    expect(store.load()).toEqual(pending);
  });

  it("fails closed when persisted state is corrupt", () => {
    const path = statePath();
    writeFileSync(path, "{not-json");
    expect(() => fileStandardX402StateStore(path).load()).toThrow();
  });
});
