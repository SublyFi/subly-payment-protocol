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
    await expect(readPublishedMetadata({ ...options, allowMissing: true, run })).resolves.toBeNull();
    expect(run).toHaveBeenCalledTimes(1);
    await expect(readPublishedMetadata({ ...options, allowMissing: true, run: () => ({ status: 1, stdout: '{"error":{"code":"E401"}}' }) })).rejects.toThrow();
    await expect(readPublishedMetadata({ ...options, allowMissing: true, run: () => ({ status: 0, stdout: "{}" }) })).rejects.toThrow();
  });

  it("waits for registry propagation after publishing before marking a release verified", async () => {
    const run = vi.fn().mockReturnValueOnce(missing).mockReturnValueOnce(found);
    const sleep = vi.fn();
    await expect(readPublishedMetadata({ ...options, run, sleep, log: vi.fn() })).resolves.toEqual(metadata);
    expect(run).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledWith(5000);
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
