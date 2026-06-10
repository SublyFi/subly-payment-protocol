export function parseRawUnits(value: unknown, fieldName: string): bigint {
  if (typeof value !== "string" || !/^(0|[1-9]\d*)$/.test(value)) {
    throw new Error(`${fieldName} must be a non-negative raw integer string`);
  }

  return BigInt(value);
}

export function parsePositiveRawUnits(value: unknown, fieldName: string): bigint {
  const parsed = parseRawUnits(value, fieldName);
  if (parsed <= 0n) {
    throw new Error(`${fieldName} must be greater than zero`);
  }

  return parsed;
}

export function rawUnitsToString(value: bigint): string {
  if (value < 0n) {
    throw new Error("raw unit values must not be negative");
  }

  return value.toString();
}

export function parseDecimalToRawUnits(
  value: string,
  decimals: number,
  fieldName: string
): bigint {
  if (!Number.isInteger(decimals) || decimals < 0) {
    throw new Error("decimals must be a non-negative integer");
  }

  if (!/^(0|[1-9]\d*)(\.\d+)?$/.test(value)) {
    throw new Error(`${fieldName} must be a non-negative decimal string`);
  }

  const [whole = "0", fraction = ""] = value.split(".");
  const paddedFraction = fraction.padEnd(decimals, "0");
  const extraPrecision = paddedFraction.slice(decimals);

  if (extraPrecision.replace(/0/g, "").length > 0) {
    throw new Error(`${fieldName} has more than ${decimals} decimal places`);
  }

  const raw = `${whole}${paddedFraction.slice(0, decimals)}`.replace(
    /^0+(?=\d)/,
    ""
  );

  return BigInt(raw || "0");
}

export function maxBigInt(a: bigint, b: bigint): bigint {
  return a >= b ? a : b;
}

export function minBigInt(a: bigint, b: bigint): bigint {
  return a <= b ? a : b;
}

export function clampToZero(value: bigint): bigint {
  return value < 0n ? 0n : value;
}

export function ceilDiv(numerator: bigint, denominator: bigint): bigint {
  if (denominator <= 0n) {
    throw new Error("denominator must be positive");
  }

  if (numerator < 0n) {
    throw new Error("numerator must be non-negative");
  }

  return (numerator + denominator - 1n) / denominator;
}

export function mulDivFloor(
  multiplicand: bigint,
  multiplier: bigint,
  denominator: bigint
): bigint {
  if (multiplicand < 0n || multiplier < 0n) {
    throw new Error("multiplicand and multiplier must be non-negative");
  }

  if (denominator <= 0n) {
    throw new Error("denominator must be positive");
  }

  return (multiplicand * multiplier) / denominator;
}

export function mulDivCeil(
  multiplicand: bigint,
  multiplier: bigint,
  denominator: bigint
): bigint {
  return ceilDiv(multiplicand * multiplier, denominator);
}
