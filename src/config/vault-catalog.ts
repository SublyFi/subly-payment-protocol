import { readFileSync } from "node:fs";
import { z } from "zod";
import { assertSolanaAddress } from "../lib/solana-address.js";
import {
  KAMINO_VAULT_PROGRAM_ID,
  MAINNET_USDC_MINT,
  vaultConfigFromEnv,
  type VaultConfig
} from "./vault.js";

const publicKey = z.string().refine((value) => {
  try { assertSolanaAddress(value, "vault catalog address"); return true; }
  catch { return false; }
}, "Invalid Solana public key");

const catalogSchema = z.object({
  version: z.literal(1),
  defaultVault: publicKey,
  vaults: z.array(z.object({
    address: publicKey,
    programId: z.literal(KAMINO_VAULT_PROGRAM_ID),
    usdcMint: z.literal(MAINNET_USDC_MINT),
    shareMint: publicKey,
    farm: publicKey,
    name: z.string().min(1).max(128).optional(),
    depositsEnabled: z.boolean().optional(),
    extraLookupTables: z.array(publicKey).max(16).optional()
  }).strict()).min(1).max(100)
}).strict();

export interface ConfiguredVault extends VaultConfig {
  name?: string;
  /** False retires new deposits/payments while preserving exits and reconciliation. */
  depositsEnabled?: boolean;
  extraLookupTables?: string[];
}
export interface VaultCatalog {
  version: 1;
  defaultVault: string;
  vaults: Readonly<ConfiguredVault>[];
}

export function parseVaultCatalog(value: unknown): VaultCatalog {
  const catalog = catalogSchema.parse(value) as VaultCatalog;
  const addresses = new Set(catalog.vaults.map((vault) => vault.address));
  if (addresses.size !== catalog.vaults.length) throw new Error("Duplicate vault in catalog");
  if (!addresses.has(catalog.defaultVault)) throw new Error("defaultVault must be in the vault catalog");
  return { ...catalog, vaults: catalog.vaults.map((vault) => Object.freeze(vault)) };
}

/** File contents are local signer trust anchors; never load a catalog from a relayer response. */
export function vaultCatalogFromEnv(env: NodeJS.ProcessEnv = process.env): VaultCatalog {
  const path = env.SUBLY_VAULTS_FILE?.trim();
  if (!path) {
    const vault = vaultConfigFromEnv(env);
    return { version: 1, defaultVault: vault.address, vaults: [vault] };
  }
  const catalog = parseVaultCatalog(JSON.parse(readFileSync(path, "utf8")));
  const selected = env.SUBLY_VAULT_ADDRESS?.trim() || catalog.defaultVault;
  if (!catalog.vaults.some((vault) => vault.address === selected)) {
    throw new Error("SUBLY_VAULT_ADDRESS must be in SUBLY_VAULTS_FILE");
  }
  return { ...catalog, defaultVault: selected };
}

export function defaultCatalogVault(catalog: VaultCatalog): Readonly<ConfiguredVault> {
  return catalog.vaults.find((vault) => vault.address === catalog.defaultVault)!;
}
