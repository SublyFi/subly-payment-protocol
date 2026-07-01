// Bundles the client entry points (from the repo's demo/) into the
// @sublyfi/pay package. The repo's own TypeScript is inlined; the six runtime
// npm deps stay external (declared in package.json), so the published package
// contains only client code — no facilitator, seller, Kamino SDK, or database
// dependencies. A small hand-written dispatcher (cli.mjs) is the single bin.
import { chmodSync, copyFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "..", "..");

// The paying entries (mcp-server, pay) live in packages/pay/src and build the
// x402 payment on the official @x402/svm client (kit v5). deposit/withdraw have
// no x402 payment and reuse the repo's relayer-flow demo entries as-is.
const entries = {
  "mcp-server": join(here, "src", "mcp-server.ts"),
  pay: join(here, "src", "pay.ts"),
  deposit: join(repoRoot, "demo", "deposit.ts"),
  withdraw: join(repoRoot, "demo", "withdraw.ts")
};

await build({
  entryPoints: entries,
  outdir: join(here, "dist"),
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node20",
  packages: "external",
  logLevel: "info"
});

copyFileSync(join(here, "cli.mjs"), join(here, "dist", "cli.js"));
chmodSync(join(here, "dist", "cli.js"), 0o755);
console.log("built", Object.keys(entries).join(", "), "+ cli dispatcher");
