import { fileURLToPath } from "node:url";
import { auditDependencies } from "./npm-checks.mjs";

try {
  await auditDependencies({ cwd: fileURLToPath(new URL("../packages/pay", import.meta.url)), level: "high" });
  console.log("Client audit rejects high and critical vulnerabilities; no exceptions.");
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
