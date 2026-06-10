const MAX_LATENCY_SAMPLES = 512;

/**
 * In-process operational metrics for the launch checklist: settlement
 * outcomes and latency, simulation failures, liquidity rejections, and fee
 * oracle rejections. Exposed via GET /v1/admin/monitoring; alerting is the
 * operator's polling layer on top of that endpoint.
 */
export class OperationalMetrics {
  private readonly counters = new Map<string, number>();
  private readonly settlementLatenciesMs: number[] = [];

  increment(name: string, by = 1): void {
    this.counters.set(name, (this.counters.get(name) ?? 0) + by);
  }

  observeSettlementLatencyMs(durationMs: number): void {
    if (!Number.isFinite(durationMs) || durationMs < 0) {
      return;
    }
    this.settlementLatenciesMs.push(durationMs);
    if (this.settlementLatenciesMs.length > MAX_LATENCY_SAMPLES) {
      this.settlementLatenciesMs.shift();
    }
  }

  snapshot(): {
    counters: Record<string, number>;
    settlementLatencyMs: {
      count: number;
      p50: number | null;
      p95: number | null;
      max: number | null;
    };
  } {
    const sorted = [...this.settlementLatenciesMs].sort((a, b) => a - b);
    const percentile = (q: number): number | null => {
      if (sorted.length === 0) {
        return null;
      }
      const index = Math.min(
        sorted.length - 1,
        Math.floor(q * (sorted.length - 1))
      );
      return sorted[index] ?? null;
    };

    return {
      counters: Object.fromEntries(
        [...this.counters.entries()].sort(([a], [b]) => a.localeCompare(b))
      ),
      settlementLatencyMs: {
        count: sorted.length,
        p50: percentile(0.5),
        p95: percentile(0.95),
        max: sorted.length === 0 ? null : sorted[sorted.length - 1]!
      }
    };
  }
}

/** Error codes tracked individually because the launch checklist alerts on them. */
export const TRACKED_ERROR_CODES: ReadonlySet<string> = new Set([
  "simulation_failed",
  "budget_illiquid",
  "withdraw_illiquid",
  "insufficient_yield",
  "stale_oracle",
  "fee_cap_exceeded",
  "needs_baseline_reset",
  "post_state_principal_invariant_failed",
  "settlement_result_invalid"
]);
