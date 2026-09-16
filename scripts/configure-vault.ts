/** Read-only: resolves a selected Kamino Earn vault into client/relayer settings. */
import { formatVaultConfigEnv, readVaultConfig } from "../src/kamino/vault-config.js";
import { createRpcFromEnv } from "../src/solana/rpc.js";

async function main() {
  const args = process.argv.slice(2);
  if (args.length !== 1 || args[0] === "--help") {
    console.error("Usage: SOLANA_RPC_URL=<rpc> npm run configure:vault -- <vault-address>");
    process.exitCode = args[0] === "--help" ? 0 : 1;
    return;
  }
  const config = await readVaultConfig(createRpcFromEnv(), args[0]!);
  console.error("Use these settings on BOTH the relayer and each CLI/MCP client. One vault per deployment.");
  console.log(formatVaultConfigEnv(config));
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
