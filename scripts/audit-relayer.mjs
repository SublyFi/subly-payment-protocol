import { auditDependencies } from "./npm-checks.mjs";

try {
  await auditDependencies();
  console.log("Relayer audit has no exceptions. Dependency review: docs/dependencies.md.");
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
