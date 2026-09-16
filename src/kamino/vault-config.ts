import { address } from "@solana/kit";
import { VaultState } from "@kamino-finance/klend-sdk";
import {
  KAMINO_VAULT_PROGRAM_ID,
  MAINNET_USDC_MINT,
  type VaultConfig
} from "../config/vault.js";
import type { SolanaRpc } from "../solana/rpc.js";

/** The SDK verifies the account owner and VaultState discriminator when fetching. */
export async function readVaultConfig(
  rpc: SolanaRpc,
  vaultAddress: string
): Promise<Readonly<VaultConfig>> {
  const state = await VaultState.fetch(
    rpc,
    address(vaultAddress),
    address(KAMINO_VAULT_PROGRAM_ID)
  );
  if (state === null) {
    throw new Error(`Kamino vault ${vaultAddress} does not exist`);
  }
  assertSupportedVaultState(state);
  return Object.freeze({
    address: vaultAddress,
    programId: KAMINO_VAULT_PROGRAM_ID,
    usdcMint: state.tokenMint,
    shareMint: state.sharesMint,
    farm: state.vaultFarm
  });
}

export function assertSupportedVaultState(state: VaultState): void {
  if (state.tokenMint !== MAINNET_USDC_MINT) {
    throw new Error("Only mainnet USDC Kamino Earn vaults are supported");
  }
  if (state.tokenProgram !== "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA") {
    throw new Error("The vault must use the SPL Token program");
  }
  if (
    state.tokenMintDecimals.toString() !== "6" ||
    state.sharesMintDecimals.toString() !== "6"
  ) {
    throw new Error("The vault must use 6 decimal USDC and share units");
  }
}

/** Check the pinned config again whenever live vault state is loaded. */
export function assertVaultConfigMatchesState(
  config: Readonly<VaultConfig>,
  state: VaultState
): void {
  assertSupportedVaultState(state);
  for (const [field, expected, actual] of [
    ["SUBLY_VAULT_USDC_MINT", config.usdcMint, state.tokenMint],
    ["SUBLY_VAULT_SHARE_MINT", config.shareMint, state.sharesMint],
    ["SUBLY_VAULT_FARM", config.farm, state.vaultFarm]
  ]) {
    if (expected !== actual) {
      throw new Error(
        `${field} does not match on-chain vault ${config.address}: expected ${expected}, found ${actual}`
      );
    }
  }
}

export function formatVaultConfigEnv(config: Readonly<VaultConfig>): string {
  return [
    `SUBLY_VAULT_ADDRESS=${config.address}`,
    `SUBLY_VAULT_SHARE_MINT=${config.shareMint}`,
    `SUBLY_VAULT_USDC_MINT=${config.usdcMint}`,
    `SUBLY_VAULT_FARM=${config.farm}`
  ].join("\n");
}
