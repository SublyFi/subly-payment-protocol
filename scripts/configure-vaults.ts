/** Generate a reviewable local allowlist; never signs or submits a transaction. */
import { address } from "@solana/kit";
import { VaultState } from "@kamino-finance/klend-sdk";
import { MAINNET_USDC_MINT, KAMINO_VAULT_PROGRAM_ID } from "../src/config/vault.js";
import { parseVaultCatalog } from "../src/config/vault-catalog.js";
import { assertSupportedVaultState } from "../src/kamino/vault-config.js";
import { createRpcFromEnv } from "../src/solana/rpc.js";
import { z } from "zod";

async function main() {
  const [defaultVault, ...extra] = process.argv.slice(2);
  if (!defaultVault || extra.length || defaultVault === "--help") {
    console.error("Usage: SOLANA_RPC_URL=<rpc> npm run --silent configure:vaults -- <default-vault-address> > vaults.json");
    process.exitCode = defaultVault === "--help" ? 0 : 1;
    return;
  }
  const response = await fetch("https://api.kamino.finance/kvaults/vaults?type=live", {
    signal: AbortSignal.timeout(10_000)
  });
  if (!response.ok) throw new Error(`Kamino vault list returned ${response.status}`);
  const listed = z.array(z.object({ address: z.string(), state: z.object({ tokenMint: z.string() }) }))
    .max(1000).parse(await response.json());
  const candidates = listed.filter((vault) => vault.state.tokenMint === MAINNET_USDC_MINT);
  const states = await VaultState.fetchMultiple(createRpcFromEnv(), candidates.map((v) => address(v.address)));
  const vaults = candidates.flatMap((candidate, i) => {
    const state = states[i];
    try {
      if (!state) throw new Error("Vault does not exist");
      assertSupportedVaultState(state);
      const name = Buffer.from(state.name).toString("utf8").replace(/\0+$/, "").trim();
      return [{
        address: candidate.address, programId: KAMINO_VAULT_PROGRAM_ID,
        usdcMint: MAINNET_USDC_MINT, shareMint: state.sharesMint, farm: state.vaultFarm,
        ...(name ? { name } : {}), depositsEnabled: true
      }];
    } catch (error) {
      console.error(`Skipping ${candidate.address}: ${error instanceof Error ? error.message : String(error)}`);
      return [];
    }
  });
  const catalog = parseVaultCatalog({ version: 1, defaultVault, vaults });
  console.error(`Verified ${vaults.length} listed USDC vaults. Review and install this file on relayer and clients; it is a snapshot, not an automatic update.`);
  console.log(JSON.stringify(catalog, null, 2));
}
main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
