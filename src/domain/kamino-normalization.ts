import {
  SHARE_DECIMALS,
  USDC_DECIMALS
} from "../config/constants.js";
import { parseDecimalToRawUnits } from "../lib/raw-units.js";
import type { ProvenancedRawValue } from "./models.js";

export function normalizeKaminoDecimalField(params: {
  sourceEndpoint: string;
  fieldPath: string;
  rawValue: string;
  unitKind: "decimal_usdc" | "decimal_vault_shares";
  observedAt?: string;
  observedSlot?: number;
}): ProvenancedRawValue {
  const decimals =
    params.unitKind === "decimal_usdc" ? USDC_DECIMALS : SHARE_DECIMALS;

  const value: ProvenancedRawValue = {
    sourceEndpoint: params.sourceEndpoint,
    fieldPath: params.fieldPath,
    rawValue: params.rawValue,
    unitKind: params.unitKind,
    normalizedRawUnits: parseDecimalToRawUnits(
      params.rawValue,
      decimals,
      params.fieldPath
    )
  };

  if (params.observedAt !== undefined) {
    value.observedAt = params.observedAt;
  }
  if (params.observedSlot !== undefined) {
    value.observedSlot = params.observedSlot;
  }

  return value;
}
