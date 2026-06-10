const BASE58_ALPHABET =
  "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
const BASE58_LOOKUP = new Map(
  [...BASE58_ALPHABET].map((character, index) => [character, BigInt(index)])
);

export function assertSolanaAddress(value: string, fieldName: string): string {
  if (value.length < 32 || value.length > 44) {
    throw new Error(`${fieldName} must be a valid Solana public key`);
  }

  if (decodeBase58(value).length !== 32) {
    throw new Error(`${fieldName} must be a valid Solana public key`);
  }

  return value;
}

function decodeBase58(value: string): Uint8Array {
  if (value.length === 0) {
    return new Uint8Array();
  }

  let decoded = 0n;
  for (const character of value) {
    const digit = BASE58_LOOKUP.get(character);
    if (digit === undefined) {
      return new Uint8Array();
    }
    decoded = decoded * 58n + digit;
  }

  const bytes: number[] = [];
  while (decoded > 0n) {
    bytes.push(Number(decoded & 0xffn));
    decoded >>= 8n;
  }

  for (const character of value) {
    if (character !== "1") {
      break;
    }
    bytes.push(0);
  }

  return Uint8Array.from(bytes.reverse());
}
