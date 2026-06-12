/**
 * Token-bucket rate limiter for seller-side challenge issuance. Challenges
 * are issued to unauthenticated requests and held in a bounded in-memory
 * store, so without a rate limit a cheap request flood pins the store at its
 * cap and starves legitimate buyers with 503s (see demo/README.md).
 *
 * Keys are caller-defined (client IP for the per-client limit, a constant for
 * the global limit). The bucket map is bounded: when full, idle (full)
 * buckets are pruned first, then the oldest entry — evicting a bucket only
 * ever resets a client's allowance, never blocks anyone.
 */
export interface TokenBucketConfig {
  /** Burst size: maximum takes allowed instantly per key. */
  capacity: number;
  /** Sustained refill rate per key. */
  refillPerSecond: number;
  maxKeys?: number;
  nowMs?: () => number;
}

interface Bucket {
  tokens: number;
  lastRefillMs: number;
}

const DEFAULT_MAX_KEYS = 10_000;

export class TokenBucketRateLimiter {
  private readonly capacity: number;
  private readonly refillPerSecond: number;
  private readonly maxKeys: number;
  private readonly nowMs: () => number;
  private readonly buckets = new Map<string, Bucket>();

  constructor(config: TokenBucketConfig) {
    if (config.capacity <= 0 || config.refillPerSecond <= 0) {
      throw new Error("capacity and refillPerSecond must be positive");
    }
    this.capacity = config.capacity;
    this.refillPerSecond = config.refillPerSecond;
    this.maxKeys = config.maxKeys ?? DEFAULT_MAX_KEYS;
    this.nowMs = config.nowMs ?? (() => Date.now());
  }

  /** Takes one token for the key; false when the key is rate limited. */
  tryTake(key: string): boolean {
    const now = this.nowMs();
    let bucket = this.buckets.get(key);
    if (bucket === undefined) {
      this.evictIfFull();
      bucket = { tokens: this.capacity, lastRefillMs: now };
      this.buckets.set(key, bucket);
    } else {
      const elapsedSeconds = Math.max(0, now - bucket.lastRefillMs) / 1000;
      bucket.tokens = Math.min(
        this.capacity,
        bucket.tokens + elapsedSeconds * this.refillPerSecond
      );
      bucket.lastRefillMs = now;
    }

    if (bucket.tokens < 1) {
      return false;
    }
    bucket.tokens -= 1;
    return true;
  }

  /** Seconds until the key has a token again (0 when not limited). */
  retryAfterSeconds(key: string): number {
    const bucket = this.buckets.get(key);
    if (bucket === undefined || bucket.tokens >= 1) {
      return 0;
    }
    return Math.ceil((1 - bucket.tokens) / this.refillPerSecond);
  }

  private evictIfFull(): void {
    if (this.buckets.size < this.maxKeys) {
      return;
    }
    for (const [key, bucket] of this.buckets) {
      const elapsedSeconds =
        Math.max(0, this.nowMs() - bucket.lastRefillMs) / 1000;
      if (
        bucket.tokens + elapsedSeconds * this.refillPerSecond >=
        this.capacity
      ) {
        this.buckets.delete(key);
        if (this.buckets.size < this.maxKeys) {
          return;
        }
      }
    }
    const oldest = this.buckets.keys().next();
    if (!oldest.done) {
      this.buckets.delete(oldest.value);
    }
  }
}
