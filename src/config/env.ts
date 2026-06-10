/**
 * Production guards fail closed: only an explicit development or test
 * NODE_ENV relaxes them. An unset NODE_ENV on a mainnet deployment must not
 * silently disable signer validation, ledger, oracle, or liquidity checks.
 */
export function isProductionEnv(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.NODE_ENV !== "development" && env.NODE_ENV !== "test";
}
