import { spawnSync } from "node:child_process";
import { setTimeout } from "node:timers/promises";

const transientCodes = new Set([
  "E429", "E500", "E502", "E503", "E504", "ECONNRESET", "ECONNREFUSED",
  "ETIMEDOUT", "ESOCKETTIMEDOUT", "EAI_AGAIN", "ENOTFOUND", "ENETUNREACH", "EHOSTUNREACH"
]);
const severities = ["info", "low", "moderate", "high", "critical"];
const isObject = value => value !== null && typeof value === "object" && !Array.isArray(value);

export function runNpm(args, options = {}) {
  // npm's own CLI path avoids invoking a .cmd file on Windows when called by npm.
  const cli = process.env.npm_execpath;
  return spawnSync(cli ? process.execPath : process.platform === "win32" ? "npm.cmd" : "npm",
    cli ? [cli, ...args] : args, {
      encoding: "utf8", timeout: 45_000, maxBuffer: 16 * 1024 * 1024,
      shell: !cli && process.platform === "win32", ...options
    });
}

export function parseJson(output) {
  try { return JSON.parse(output); } catch { return undefined; }
}

export function isTransientNpmFailure(result, report = parseJson(result.stdout)) {
  // Never reinterpret a vulnerability report (even a malformed one) as an outage.
  if (report?.vulnerabilities !== undefined || report?.metadata?.vulnerabilities !== undefined) return false;
  const codes = [result.error?.code, report?.code, report?.error?.code];
  if (codes.some(code => transientCodes.has(code))) return true;
  if ([429, 500, 502, 503, 504].includes(report?.statusCode)) return true;
  const diagnostics = [report?.message, report?.error?.summary, result.stderr].filter(value => typeof value === "string").join("\n");
  return /\b(?:E429|E500|E502|E503|E504|ECONNRESET|ECONNREFUSED|ETIMEDOUT|ESOCKETTIMEDOUT|EAI_AGAIN|ENOTFOUND|ENETUNREACH|EHOSTUNREACH)\b/.test(diagnostics) ||
    /(?:^|npm (?:warn|error) audit )(?:429|500|502|503|504)\b/m.test(diagnostics);
}

export async function withNpmRetries(operation, {
  retryable = isTransientNpmFailure, delays = [5_000, 15_000, 30_000],
  sleep = setTimeout, log = console.error
} = {}) {
  for (let attempt = 0; ; attempt++) {
    const result = await operation();
    if (!retryable(result) || attempt === delays.length) return result;
    log(`npm registry temporarily unavailable; retry ${attempt + 1}/${delays.length} in ${delays[attempt] / 1000}s.`);
    await sleep(delays[attempt]);
  }
}

export function validateAuditReport(result) {
  const report = parseJson(result.stdout);
  if (result.error || result.signal || ![0, 1].includes(result.status) || !isObject(report) ||
      report.error || report.auditReportVersion !== 2 || !isObject(report.vulnerabilities) ||
      !isObject(report.metadata?.vulnerabilities)) {
    throw new Error("npm audit failed to retrieve valid vulnerability data; release remains blocked.");
  }
  const counts = report.metadata.vulnerabilities;
  const entries = Object.values(report.vulnerabilities);
  if (![...severities, "total"].every(key => Number.isSafeInteger(counts[key]) && counts[key] >= 0) ||
      counts.total !== entries.length || counts.total !== severities.reduce((total, severity) => total + counts[severity], 0) ||
      entries.some(entry => !isObject(entry) || !severities.includes(entry.severity) || !Array.isArray(entry.via)) ||
      severities.some(severity => counts[severity] !== entries.filter(entry => entry.severity === severity).length)) {
    throw new Error("npm audit returned inconsistent vulnerability data; release remains blocked.");
  }
  return report;
}

export async function auditDependencies({ cwd = process.cwd(), level = "all", run = runNpm, log = console.log, ...retryOptions } = {}) {
  if (!["all", "high"].includes(level)) throw new Error("Audit level must be all or high");
  const result = await withNpmRetries(() => run([
    "audit", "--omit=dev", "--json", `--audit-level=${level === "all" ? "low" : level}`,
    "--fetch-retries=0", "--fetch-timeout=15000"
  ], { cwd }), { ...retryOptions, log });
  const report = validateAuditReport(result);
  const advisories = new Map();
  for (const dependency of Object.values(report.vulnerabilities)) {
    for (const via of dependency.via) {
      if (isObject(via)) advisories.set(via.url, via);
    }
  }
  for (const [url, advisory] of advisories) log(`${advisory.severity}: ${advisory.title} — ${url}`);
  log(JSON.stringify(report.metadata.vulnerabilities));
  const counts = report.metadata.vulnerabilities;
  if (result.status !== 0 || (level === "all" ? counts.total > 0 : counts.high + counts.critical > 0)) {
    throw new Error(`Dependency audit failed the ${level === "all" ? "zero-vulnerability" : "high-severity"} gate.`);
  }
  return report;
}
