import { spawnSync } from "node:child_process";
const known = new Set(["GHSA-3gc7-fjrx-p6mg", "GHSA-82x6-q7mm-w9cf", "GHSA-v5mp-jgw5-2x6j", "GHSA-528h-pc64-c93x"]);
const audit = spawnSync("npm",["audit","--omit=dev","--json"],{encoding:"utf8"});
if(audit.error) throw audit.error;
let report;
try {report=JSON.parse(audit.stdout);} catch {throw new Error("npm audit did not return JSON");}
if(report.error || !report.vulnerabilities) throw new Error("npm audit failed to retrieve vulnerability data");
const advisories=new Map();
for(const dependency of Object.values(report.vulnerabilities))for(const via of dependency.via)if(typeof via === "object")advisories.set(via.url.split("/").at(-1),via);
let unexpected=false;
for(const [id, advisory] of advisories) {
  console.log(`${known.has(id)?"TRACKED":"NEW"} ${advisory.severity}: ${id} — ${advisory.title}`);
  if(!known.has(id)) unexpected=true;
}
console.log(JSON.stringify(report.metadata.vulnerabilities));
console.log("Known relayer advisories and mitigations: docs/dependencies.md. Client audit has no exceptions.");
if(unexpected)process.exitCode=1;
