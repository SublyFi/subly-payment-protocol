/** Maximum client-approved deviation from a withdrawal request (0.00001 USDC). */
export const WITHDRAWAL_ROUNDING_RAW_USDC = 10n;

/**
 * Aim inside the client's allowance so whole-share rounding cannot routinely
 * underfund an exact x402 payment. The client still verifies the simulated
 * output, and the server charges this headroom against yield before preparing.
 */
export const YIELD_REALIZE_ROUNDING_RAW_USDC = WITHDRAWAL_ROUNDING_RAW_USDC / 2n;
