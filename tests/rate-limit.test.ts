import { describe, expect, it } from "vitest";
import { TokenBucketRateLimiter } from "../src/x402/rate-limit.js";

describe("TokenBucketRateLimiter", () => {
  it("allows bursts up to capacity, then limits", () => {
    let now = 0;
    const limiter = new TokenBucketRateLimiter({
      capacity: 3,
      refillPerSecond: 1,
      nowMs: () => now
    });

    expect(limiter.tryTake("ip")).toBe(true);
    expect(limiter.tryTake("ip")).toBe(true);
    expect(limiter.tryTake("ip")).toBe(true);
    expect(limiter.tryTake("ip")).toBe(false);
    expect(limiter.retryAfterSeconds("ip")).toBe(1);
  });

  it("refills over time up to capacity", () => {
    let now = 0;
    const limiter = new TokenBucketRateLimiter({
      capacity: 2,
      refillPerSecond: 1,
      nowMs: () => now
    });
    expect(limiter.tryTake("ip")).toBe(true);
    expect(limiter.tryTake("ip")).toBe(true);
    expect(limiter.tryTake("ip")).toBe(false);

    now = 1_000;
    expect(limiter.tryTake("ip")).toBe(true);
    expect(limiter.tryTake("ip")).toBe(false);

    // Long idle never exceeds capacity.
    now = 100_000;
    expect(limiter.tryTake("ip")).toBe(true);
    expect(limiter.tryTake("ip")).toBe(true);
    expect(limiter.tryTake("ip")).toBe(false);
  });

  it("isolates keys", () => {
    const limiter = new TokenBucketRateLimiter({
      capacity: 1,
      refillPerSecond: 0.001
    });
    expect(limiter.tryTake("a")).toBe(true);
    expect(limiter.tryTake("a")).toBe(false);
    expect(limiter.tryTake("b")).toBe(true);
  });

  it("bounds the bucket map by evicting idle keys first", () => {
    let now = 0;
    const limiter = new TokenBucketRateLimiter({
      capacity: 2,
      refillPerSecond: 1,
      maxKeys: 2,
      nowMs: () => now
    });
    expect(limiter.tryTake("limited")).toBe(true);
    expect(limiter.tryTake("limited")).toBe(true);
    expect(limiter.tryTake("limited")).toBe(false);
    expect(limiter.tryTake("idle")).toBe(true);

    // "idle" refills to full and is evicted in favor of the new key, while
    // the exhausted "limited" bucket survives.
    now = 2_000;
    expect(limiter.tryTake("new")).toBe(true);
    expect(limiter.tryTake("limited")).toBe(true); // refilled 2s * 1/s
    expect(limiter.tryTake("limited")).toBe(true);
    expect(limiter.tryTake("limited")).toBe(false);
  });

  it("rejects non-positive configuration", () => {
    expect(
      () => new TokenBucketRateLimiter({ capacity: 0, refillPerSecond: 1 })
    ).toThrowError();
    expect(
      () => new TokenBucketRateLimiter({ capacity: 1, refillPerSecond: 0 })
    ).toThrowError();
  });
});
