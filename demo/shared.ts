/** Shared helpers for the demo buyer and seller programs. */

export function fail(message: string): never {
  console.error(message);
  process.exit(1);
}

export function requireEnv(name: string): string {
  const value = process.env[name];
  if (value === undefined || value.length === 0) {
    fail(`Missing required environment variable: ${name}`);
  }
  return value;
}

/** Formats raw USDC units (6 decimals) as a human-readable decimal string. */
export function formatRawUsdc(raw: string): string {
  const units = BigInt(raw);
  const whole = units / 1_000_000n;
  const fraction = (units % 1_000_000n).toString().padStart(6, "0");
  return `${whole}.${fraction}`;
}
