export const PAYMENT_SCHEME = "subly-yield-exact" as const;

export const SOLANA_MAINNET_NETWORK =
  "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp" as const;

export const SPL_TOKEN_PROGRAM_ID =
  "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA" as const;

export const ASSOCIATED_TOKEN_PROGRAM_ID =
  "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL" as const;

export const SUBLY_VAULT = {
  name: "Subly USDC Payment Vault Alpha",
  address: "5kfkpQZ6AkQgizHVThqkxD4J3db2i7pE3mHdPNRbx7jr",
  programId: "KvauGMspG5k6rtzrqqn7WNn3oZdyKqLKwK2XWQ8FLjd",
  usdcMint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
  shareMint: "7hGX49So539MU9Rrah8nBNVYXswWVwEJvgWNYeBDYq3a",
  lookupTable: "7UbXhDnpK7WVnwsfivzQRENoqKqAULQ5s19gS1xJrQEo",
  farm: "E2Ct77LowkDAH1T9ubwPpb84pU2GSGrUdgH3KeTTpLX"
} as const;

export const USDC_DECIMALS = 6;
export const SHARE_DECIMALS = 6;

// Exchange rates are represented as fixed-point integers.
export const RATE_SCALE = 1_000_000_000_000n;

export const DEFAULT_PAYMENT_EXPIRY_SECONDS = 120;
export const DEFAULT_ESTIMATED_FEE_DEBT_RAW_USDC = 100n;
