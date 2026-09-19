import { spawnSync } from "node:child_process";

const audit = spawnSync("npm", ["audit", "--omit=dev", "--json"], { encoding: "utf8" });
if (audit.error) throw audit.error;
let report;
try {
  report = JSON.parse(audit.stdout);
} catch {
  throw new Error("npm audit did not return JSON");
}
if (report.error || !report.vulnerabilities || !report.metadata?.vulnerabilities) {
  throw new Error("npm audit failed to retrieve vulnerability data");
}

const advisories = new Map();
for (const dependency of Object.values(report.vulnerabilities)) {
  for (const via of dependency.via) {
    if (typeof via === "object") advisories.set(via.url, via);
  }
}
for (const [url, advisory] of advisories) {
  console.log(`${advisory.severity}: ${advisory.title} — ${url}`);
}
console.log(JSON.stringify(report.metadata.vulnerabilities));
console.log("Relayer audit has no exceptions. Dependency review: docs/dependencies.md.");
if (audit.status !== 0 || Object.keys(report.vulnerabilities).length > 0 || report.metadata.vulnerabilities.total !== 0) {
  process.exitCode = 1;
}
