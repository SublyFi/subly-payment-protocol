import { defaultCatalogVault, vaultCatalogFromEnv } from "./vault-catalog.js";

export const PAYMENT_SCHEME = "subly-yield-exact" as const;

export const SOLANA_MAINNET_NETWORK =
  "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp" as const;

export const SPL_TOKEN_PROGRAM_ID =
  "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA" as const;

export const ASSOCIATED_TOKEN_PROGRAM_ID =
  "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL" as const;

// Initial vault for legacy/default callers and one-shot CLI processes.
// Multi-vault services and MCP sessions pin their own catalogue entry.
// Metadata is local on BOTH relayer and client; relayer responses never
// replace a client's signing policy.
export const SUBLY_VAULT = defaultCatalogVault(vaultCatalogFromEnv());

export const USDC_DECIMALS = 6;
export const SHARE_DECIMALS = 6;

// Exchange rates are represented as fixed-point integers.
export const RATE_SCALE = 1_000_000_000_000n;

export const DEFAULT_PAYMENT_EXPIRY_SECONDS = 120;
export const DEFAULT_ESTIMATED_FEE_DEBT_RAW_USDC = 100n;
