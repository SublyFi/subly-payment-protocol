import { describe, expect, it, vi } from "vitest";
import { auditDependencies } from "../scripts/npm-checks.mjs";

function result(severity) {
  const vulnerabilities = severity ? { example: { severity, via: [{ title: "A real vulnerability, even with E503 in its title", severity, url: "https://example.test/advisory" }] } } : {};
  const counts = { info: 0, low: 0, moderate: 0, high: 0, critical: 0, total: severity ? 1 : 0 };
  if (severity) counts[severity] = 1;
  return { status: severity ? 1 : 0, stdout: JSON.stringify({ auditReportVersion: 2, vulnerabilities, metadata: { vulnerabilities: counts } }), stderr: "" };
}

function check(responses, options = {}) {
  const run = vi.fn();
  for (const response of responses) run.mockReturnValueOnce(response);
  const sleep = vi.fn();
  const promise = auditDependencies({ run, sleep, log: vi.fn(), ...options });
  return { run, sleep, promise };
}

describe("npm audit release gates", () => {
  it.each([
    { status: 1, stdout: JSON.stringify({ statusCode: 503, error: { summary: "" } }) },
    { status: 1, stdout: JSON.stringify({ error: { code: "E429" } }) },
    { status: 1, stdout: "", stderr: "npm error code ECONNRESET" },
    { status: null, stdout: "", error: { code: "ETIMEDOUT" } }
  ])("retries transient registry failures then requires a valid clean report: %j", async failure => {
    const f = check([failure, result()]);
    await expect(f.promise).resolves.toHaveProperty("auditReportVersion", 2);
    expect(f.run).toHaveBeenCalledTimes(2);
    expect(f.sleep).toHaveBeenCalledWith(5000);
  });

  it("stops after four attempts and does not waive the audit during maintenance", async () => {
    const f = check(Array.from({ length: 4 }, () => ({ status: 1, stdout: '{"statusCode":503}' })));
    await expect(f.promise).rejects.toThrow("release remains blocked");
    expect(f.run).toHaveBeenCalledTimes(4);
    expect(f.sleep.mock.calls.map(([delay]) => delay)).toEqual([5000, 15000, 30000]);
  });

  it.each(["info", "low", "moderate", "high", "critical"])("rejects %s relayer findings without retry", async severity => {
    const f = check([result(severity)]);
    await expect(f.promise).rejects.toThrow("zero-vulnerability");
    expect(f.run).toHaveBeenCalledTimes(1);
    expect(f.sleep).not.toHaveBeenCalled();
  });

  it.each(["high", "critical"])("rejects %s client findings without retry even if npm exits zero", async severity => {
    const f = check([{ ...result(severity), status: 0 }], { level: "high" });
    await expect(f.promise).rejects.toThrow("high-severity");
    expect(f.run).toHaveBeenCalledTimes(1);
  });

  it.each(["info", "low", "moderate"])("preserves the client gate allowing %s with a successful npm exit", async severity => {
    const f = check([{ ...result(severity), status: 0 }], { level: "high" });
    await expect(f.promise).resolves.toBeDefined();
    expect(f.run.mock.calls[0][0]).toContain("--audit-level=high");
  });

  it.each([
    { status: 0, stdout: "not json" },
    { status: 0, stdout: "{}" },
    { status: 1, stdout: '{"error":{"code":"E401"}}' },
    { ...result(), status: 1 },
    { ...result(), status: 2 },
    { ...result(), signal: "SIGTERM" },
    { status: 0, stdout: result().stdout.replace('"total":0', '"total":1') },
    { status: 0, stdout: result().stdout.replace('"critical":0', '"critical":null') },
    { status: 1, stdout: '{"vulnerabilities":null,"statusCode":503}' }
  ])("fails closed without retry for invalid or unsuccessful audit data: %j", async response => {
    const f = check([response]);
    await expect(f.promise).rejects.toThrow();
    expect(f.run).toHaveBeenCalledTimes(1);
    expect(f.sleep).not.toHaveBeenCalled();
  });
});
