import { USDC_DECIMALS } from "../config/constants.js";
import { parseDecimalToRawUnits } from "../lib/raw-units.js";
import { normalizeKaminoDecimalField } from "../domain/kamino-normalization.js";
import type { ProvenancedRawValue } from "../domain/models.js";

export interface KaminoPnlSnapshot {
  /** Remaining-position cost basis in raw USDC, when derivable. */
  costBasisRawUsdc: bigint | null;
  provenance: ProvenancedRawValue[];
}

/**
 * Kamino public API client. Used only for P&L / cost-basis, history, and
 * reconciliation per the design; payment-critical state comes from on-chain
 * reads. Returns null cost basis when the response cannot be normalized so
 * callers fall back to a conservative baseline reset.
 */
export class KaminoApiClient {
  private readonly baseUrl: string;

  constructor(baseUrl = "https://api.kamino.finance") {
    this.baseUrl = baseUrl.replace(/\/$/, "");
  }

  async getUserVaultPnl(params: {
    wallet: string;
    vault: string;
  }): Promise<KaminoPnlSnapshot | null> {
    const endpoint = `${this.baseUrl}/kvaults/users/${params.wallet}/vaults/${params.vault}/pnl`;
    let body: Record<string, unknown>;
    try {
      const response = await fetch(endpoint, {
        signal: AbortSignal.timeout(8_000)
      });
      if (!response.ok) {
        return null;
      }
      body = (await response.json()) as Record<string, unknown>;
    } catch {
      return null;
    }

    const observedAt = new Date().toISOString();
    const provenance: ProvenancedRawValue[] = [];
    // The cost-basis field name is defensive: Kamino has shipped both
    // `costBasis` and `totalCostBasis` shaped responses for user P&L.
    const costBasisField = ["totalCostBasis", "costBasis", "netDeposits"].find(
      (field) => typeof body[field] === "string"
    );
    if (costBasisField === undefined) {
      return { costBasisRawUsdc: null, provenance };
    }

    const rawValue = body[costBasisField] as string;
    try {
      parseDecimalToRawUnits(rawValue, USDC_DECIMALS, costBasisField);
    } catch {
      return { costBasisRawUsdc: null, provenance };
    }

    const normalized = normalizeKaminoDecimalField({
      sourceEndpoint: endpoint,
      fieldPath: costBasisField,
      rawValue,
      unitKind: "decimal_usdc",
      observedAt
    });
    provenance.push(normalized);

    return {
      costBasisRawUsdc: normalized.normalizedRawUnits,
      provenance
    };
  }
}
