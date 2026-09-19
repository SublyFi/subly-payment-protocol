import { describe, expect, it, vi } from "vitest";
import { readPublishedMetadata, validatePublishedMetadata } from "../scripts/verify-published-package.mjs";

const metadata = {
  name: "@subly_fi/pay", version: "1.2.3", gitHead: "a".repeat(40),
  dist: { integrity: "sha512-YWJj", tarball: "https://registry.npmjs.org/@subly_fi/pay/-/pay-1.2.3.tgz",
    attestations: { url: "https://registry.npmjs.org/-/npm/v1/attestations/example", provenance: { predicateType: "https://slsa.dev/provenance/v1" } } }
};
const options = { version: "1.2.3", commit: "a".repeat(40), requireProvenance: true };
const found = { status: 0, stdout: JSON.stringify(metadata) };
const missing = { status: 1, stdout: '{"error":{"code":"E404"}}' };
const unavailable = { status: 1, stdout: '{"error":{"code":"E503"}}' };

function clock() {
  let elapsed = 0;
  return {
    now: () => elapsed,
    sleep: vi.fn(async delay => { elapsed += delay; }),
    advance: duration => { elapsed += duration; }
  };
}

describe("published release verification", () => {
  it("requires the exact immutable version, commit, registry integrity and provenance metadata", () => {
    expect(validatePublishedMetadata(metadata, options)).toEqual(metadata);
    for (const change of [
      { version: "1.2.2" }, { gitHead: "b".repeat(40) }, { name: "other" },
      { dist: { ...metadata.dist, integrity: "" } },
      { dist: { ...metadata.dist, tarball: "https://other.test/package.tgz" } },
      { dist: { ...metadata.dist, attestations: undefined } }
    ]) expect(() => validatePublishedMetadata({ ...metadata, ...change }, options)).toThrow();
  });

  it("allows only an explicit registry E404 to report an unpublished version", async () => {
    const run = vi.fn().mockReturnValue(missing);
    const time = clock();
    await expect(readPublishedMetadata({ ...options, allowMissing: true, run, ...time })).resolves.toBeNull();
    expect(run).toHaveBeenCalledTimes(1);
    expect(time.sleep).not.toHaveBeenCalled();
    await expect(readPublishedMetadata({ ...options, allowMissing: true, run: () => ({ status: 1, stdout: '{"error":{"code":"E401"}}' }) })).rejects.toThrow();
    await expect(readPublishedMetadata({ ...options, allowMissing: true, run: () => ({ status: 0, stdout: "{}" }) })).rejects.toThrow();
  });

  it("waits for asynchronous scanning beyond the old retry window, tolerating an intervening outage", async () => {
    const time = clock();
    const run = vi.fn(() => time.now() < 5 * 60_000 ? missing : time.now() < 330_000 ? unavailable : found);
    await expect(readPublishedMetadata({ ...options, run, ...time, log: vi.fn() })).resolves.toEqual(metadata);
    expect(run).toHaveBeenCalledTimes(12);
    expect(time.now()).toBe(330_000);
    expect(time.sleep.mock.calls.every(([delay]) => delay === 30_000)).toBe(true);
    expect(run.mock.calls.every(([args, config]) => args.includes("--fetch-timeout=15000") && config.timeout === 15_000)).toBe(true);
  });

  it("fails at the 20-minute deadline while counting slow requests and shortening the final sleep", async () => {
    const time = clock();
    const run = vi.fn(() => { time.advance(15_000); return missing; });
    await expect(readPublishedMetadata({ ...options, run, ...time, log: vi.fn() })).rejects.toThrow("timed out after 20 minutes for @subly_fi/pay@1.2.3");
    expect(time.now()).toBe(20 * 60_000);
    expect(run).toHaveBeenCalledTimes(27);
    expect(time.sleep.mock.calls.at(-1)).toEqual([15_000]);
  });

  it("caps the last request to the remaining deadline and does not accept an overdue response", async () => {
    const time = clock();
    const run = vi.fn((_args, config) => {
      time.advance(Math.min(3300, config.timeout));
      return config.timeout < 15_000 ? found : missing;
    });
    await expect(readPublishedMetadata({ ...options, run, ...time, log: vi.fn() })).rejects.toThrow("do not republish or move the tag");
    expect(time.now()).toBe(20 * 60_000);
    expect(run.mock.calls.at(-1)[1].timeout).toBe(1200);
    expect(run.mock.calls.at(-1)[0]).toContain("--fetch-timeout=1200");
  });

  it.each([false, true])("immediately rejects permanent errors and malformed/mismatched metadata (prepublish=%s)", async allowMissing => {
    for (const response of [
      { status: 1, stdout: '{"error":{"code":"E401"}}' },
      { status: 1, stdout: '{"error":{"code":"E403"}}' },
      { status: 1, stdout: '{"error":{"code":"E401","summary":"Previous E503"}}', stderr: "npm error E503" },
      { status: 1, stdout: '{"error":{"code":"E403"}}', stderr: "npm error E503" },
      { status: 1, stdout: '{"error":{"code":"ENEEDAUTH"}}', stderr: "npm error E503" },
      { status: 1, stdout: '{"statusCode":400}', stderr: "npm error E503" },
      { status: 1, stdout: "not json", stderr: "npm error E503" },
      { status: 1, stdout: "{}", stderr: "npm error E503" },
      { status: 0, stdout: "{}", stderr: "npm error E503" },
      { status: 0, stdout: JSON.stringify({ ...metadata, error: { code: "E503" } }) },
      { status: 0, stdout: JSON.stringify({ ...metadata, version: "1.2.4" }) },
      { status: 0, stdout: JSON.stringify({ ...metadata, gitHead: "b".repeat(40) }) },
      { status: 0, stdout: JSON.stringify({ ...metadata, dist: { ...metadata.dist, attestations: undefined } }) }
    ]) {
      const time = clock();
      const run = vi.fn(() => response);
      await expect(readPublishedMetadata({ ...options, allowMissing, run, ...time, log: vi.fn() })).rejects.toThrow();
      expect(run).toHaveBeenCalledTimes(1);
      expect(time.sleep).not.toHaveBeenCalled();
    }
  });

  it("never interprets an interrupted E404 lookup as an unpublished version", async () => {
    const time = clock();
    const run = vi.fn(() => ({ ...missing, signal: "SIGTERM" }));
    await expect(readPublishedMetadata({ ...options, allowMissing: true, run, ...time, log: vi.fn() })).rejects.toThrow();
    expect(run).toHaveBeenCalledTimes(1);
    expect(time.sleep).not.toHaveBeenCalled();
  });

  it("fails closed for prolonged outages rather than treating them as an available version", async () => {
    const run = vi.fn().mockReturnValue({ status: 1, stdout: '{"error":{"code":"E503"}}' });
    await expect(readPublishedMetadata({ ...options, allowMissing: true, run, sleep: vi.fn(), log: vi.fn() })).rejects.toThrow();
    expect(run).toHaveBeenCalledTimes(4);
  });

  it("refuses to resume publication when the version belongs to another commit", async () => {
    await expect(readPublishedMetadata({ ...options, commit: "b".repeat(40), allowMissing: true, run: () => found })).rejects.toThrow("different commit");
  });
});
