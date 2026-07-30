export const PAYMENT_SCHEME = "subly-yield-exact" as const;

export const SOLANA_MAINNET_NETWORK =
  "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp" as const;

export const SPL_TOKEN_PROGRAM_ID =
  "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA" as const;

export const ASSOCIATED_TOKEN_PROGRAM_ID =
  "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL" as const;

const envOr = (name: string, fallback: string): string => {
  const value = process.env[name]?.trim();
  return value ? value : fallback;
};

// The Kamino vault this deployment settles against. Defaults to Subly's
// public mainnet USDC vault; a third-party operator running against their own
// Kamino vault overrides the SUBLY_VAULT_* variables on BOTH sides — the
// relayer, and every client process — because the client's intent validation
// checks prepared transactions against this local config, never against what
// the relayer claims. lookupTable/farm document the default vault only; the
// transaction-building path loads both from on-chain vault state.
export const SUBLY_VAULT = {
  name: "Subly USDC Payment Vault Alpha",
  address: envOr(
    "SUBLY_VAULT_ADDRESS",
    "5kfkpQZ6AkQgizHVThqkxD4J3db2i7pE3mHdPNRbx7jr"
  ),
  programId: "KvauGMspG5k6rtzrqqn7WNn3oZdyKqLKwK2XWQ8FLjd",
  usdcMint: envOr(
    "SUBLY_VAULT_USDC_MINT",
    "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"
  ),
  shareMint: envOr(
    "SUBLY_VAULT_SHARE_MINT",
    "7hGX49So539MU9Rrah8nBNVYXswWVwEJvgWNYeBDYq3a"
  ),
  lookupTable: "7UbXhDnpK7WVnwsfivzQRENoqKqAULQ5s19gS1xJrQEo",
  farm: "E2Ct77LowkDAH1T9ubwPpb84pU2GSGrUdgH3KeTTpLX"
} as const;

export const USDC_DECIMALS = 6;
export const SHARE_DECIMALS = 6;

// Exchange rates are represented as fixed-point integers.
export const RATE_SCALE = 1_000_000_000_000n;

export const DEFAULT_PAYMENT_EXPIRY_SECONDS = 120;
export const DEFAULT_ESTIMATED_FEE_DEBT_RAW_USDC = 100n;
