import { assertSolanaAddress } from "../lib/solana-address.js";

export const MAINNET_USDC_MINT =
  "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
export const KAMINO_VAULT_PROGRAM_ID =
  "KvauGMspG5k6rtzrqqn7WNn3oZdyKqLKwK2XWQ8FLjd";
export const NO_VAULT_FARM = "11111111111111111111111111111111";

export interface VaultConfig {
  address: string;
  programId: string;
  usdcMint: string;
  shareMint: string;
  farm: string;
}

export const DEFAULT_VAULT_CONFIG: Readonly<VaultConfig> = Object.freeze({
  address: "5kfkpQZ6AkQgizHVThqkxD4J3db2i7pE3mHdPNRbx7jr",
  programId: KAMINO_VAULT_PROGRAM_ID,
  usdcMint: MAINNET_USDC_MINT,
  shareMint: "7hGX49So539MU9Rrah8nBNVYXswWVwEJvgWNYeBDYq3a",
  farm: "E2Ct77LowkDAH1T9ubwPpb84pU2GSGrUdgH3KeTTpLX"
});

/** Local trust anchors shared by the relayer and client, never supplied by a prepared transaction. */
export function vaultConfigFromEnv(
  env: NodeJS.ProcessEnv = process.env
): Readonly<VaultConfig> {
  const value = (name: string) => env[name]?.trim() || undefined;
  const vaultAddress = value("SUBLY_VAULT_ADDRESS") ?? DEFAULT_VAULT_CONFIG.address;
  const customVault = vaultAddress !== DEFAULT_VAULT_CONFIG.address;
  const anchor = (name: string, fallback: string): string => {
    const configured = value(name);
    if (customVault && configured === undefined) {
      throw new Error(
        `${name} is required for a custom vault. Generate its settings with npm run configure:vault -- <vault-address>; use ${NO_VAULT_FARM} for a vault without a farm.`
      );
    }
    return assertSolanaAddress(configured ?? fallback, name);
  };
  const usdcMint = value("SUBLY_VAULT_USDC_MINT") ?? MAINNET_USDC_MINT;
  if (usdcMint !== MAINNET_USDC_MINT) {
    throw new Error(
      "SUBLY_VAULT_USDC_MINT must be mainnet USDC; other deposit assets are not supported"
    );
  }
  return Object.freeze({
    address: assertSolanaAddress(vaultAddress, "SUBLY_VAULT_ADDRESS"),
    programId: KAMINO_VAULT_PROGRAM_ID,
    usdcMint,
    shareMint: anchor("SUBLY_VAULT_SHARE_MINT", DEFAULT_VAULT_CONFIG.shareMint),
    farm: anchor("SUBLY_VAULT_FARM", DEFAULT_VAULT_CONFIG.farm)
  });
}
