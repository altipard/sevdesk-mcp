import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createRateLimiterRegistry, DEFAULT_IDLE_MS } from "../../src/sevdesk/rate-limit.js";

const TOKEN_A = "a".repeat(32);
const TOKEN_B = "b".repeat(32);
const NO_LIMIT = Number.POSITIVE_INFINITY;

const signal = () => new AbortController().signal;

/** Starts `count` acquisitions and records when each one got its slot. */
function acquireMany(
  acquire: (s: AbortSignal, maxWaitMs: number) => Promise<boolean>,
  count: number,
): { granted: number[]; all: Promise<boolean[]> } {
  const granted: number[] = [];
  const all = Promise.all(
    Array.from({ length: count }, () =>
      acquire(signal(), NO_LIMIT).then((ok) => {
        granted.push(Date.now());
        return ok;
      }),
    ),
  );
  return { granted, all };
}

beforeEach(() => {
  vi.useFakeTimers({ now: 1_000_000 });
});
afterEach(() => {
  vi.useRealTimers();
});

describe("token bucket", () => {
  it("lets a burst of one second of requests through at once", async () => {
    const limiter = createRateLimiterRegistry().limiterFor(TOKEN_A, 4);
    const start = Date.now();
    const { granted, all } = acquireMany(limiter.acquire, 4);
    await vi.advanceTimersByTimeAsync(0);
    expect(await all).toEqual([true, true, true, true]);
    expect(granted).toEqual([start, start, start, start]);
  });

  it("paces requests past the burst at the configured rate", async () => {
    const limiter = createRateLimiterRegistry().limiterFor(TOKEN_A, 2);
    const start = Date.now();
    const { granted, all } = acquireMany(limiter.acquire, 6);
    await vi.advanceTimersByTimeAsync(10_000);
    await all;
    expect(granted.map((at) => at - start)).toEqual([0, 0, 500, 1000, 1500, 2000]);
  });

  it("refills while idle, but never above the burst size", async () => {
    const limiter = createRateLimiterRegistry().limiterFor(TOKEN_A, 2);
    const first = acquireMany(limiter.acquire, 2);
    await vi.advanceTimersByTimeAsync(0);
    await first.all;
    await vi.advanceTimersByTimeAsync(60_000);
    const start = Date.now();
    const second = acquireMany(limiter.acquire, 3);
    await vi.advanceTimersByTimeAsync(10_000);
    await second.all;
    expect(second.granted.map((at) => at - start)).toEqual([0, 0, 500]);
  });

  it("handles rates below one request per second", async () => {
    const limiter = createRateLimiterRegistry().limiterFor(TOKEN_A, 0.5);
    const start = Date.now();
    const { granted, all } = acquireMany(limiter.acquire, 3);
    await vi.advanceTimersByTimeAsync(10_000);
    await all;
    expect(granted.map((at) => at - start)).toEqual([0, 2000, 4000]);
  });

  it("does nothing when disabled", async () => {
    const registry = createRateLimiterRegistry();
    const limiter = registry.limiterFor(TOKEN_A, 0);
    const start = Date.now();
    const { granted, all } = acquireMany(limiter.acquire, 50);
    await vi.advanceTimersByTimeAsync(0);
    await all;
    expect(new Set(granted)).toEqual(new Set([start]));
    expect(registry.size).toBe(0);
  });

  it("refuses without waiting or taking a slot when the wait exceeds maxWaitMs", async () => {
    const limiter = createRateLimiterRegistry().limiterFor(TOKEN_A, 1);
    await expect(limiter.acquire(signal(), 0)).resolves.toBe(true);
    // The next slot is 1000 ms away.
    await expect(limiter.acquire(signal(), 999)).resolves.toBe(false);
    const start = Date.now();
    const next = limiter.acquire(signal(), 1000);
    await vi.advanceTimersByTimeAsync(1000);
    await expect(next).resolves.toBe(true);
    // The refused call reserved nothing, so this one waited 1000 ms, not 2000.
    expect(Date.now() - start).toBe(1000);
  });
});

describe("scope", () => {
  it("shares one bucket between limiters of the same token", async () => {
    const registry = createRateLimiterRegistry();
    const one = registry.limiterFor(TOKEN_A, 1);
    const two = registry.limiterFor(TOKEN_A, 1);
    await expect(one.acquire(signal(), 0)).resolves.toBe(true);
    await expect(two.acquire(signal(), 0)).resolves.toBe(false);
    expect(registry.size).toBe(1);
  });

  it("never makes one token wait for another", async () => {
    const registry = createRateLimiterRegistry();
    const a = registry.limiterFor(TOKEN_A, 1);
    const b = registry.limiterFor(TOKEN_B, 1);
    await expect(a.acquire(signal(), 0)).resolves.toBe(true);
    await expect(a.acquire(signal(), 0)).resolves.toBe(false);
    await expect(b.acquire(signal(), 0)).resolves.toBe(true);
    expect(registry.size).toBe(2);
  });

  it("drops buckets that were idle and are full again", async () => {
    const registry = createRateLimiterRegistry({ idleMs: 60_000 });
    await registry.limiterFor(TOKEN_A, 1).acquire(signal(), 0);
    await vi.advanceTimersByTimeAsync(30_000);
    await registry.limiterFor(TOKEN_B, 1).acquire(signal(), 0);
    expect(registry.size).toBe(2);
    // A has now been idle for 60 s, B only for 30 s.
    await vi.advanceTimersByTimeAsync(30_000);
    await registry.limiterFor("c".repeat(32), 1).acquire(signal(), 0);
    expect(registry.size).toBe(2);
    await vi.advanceTimersByTimeAsync(60_000);
    await registry.limiterFor(TOKEN_A, 1).acquire(signal(), 0);
    expect(registry.size).toBe(1);
  });

  it("keeps an idle bucket whose waiters still hold reservations", async () => {
    const registry = createRateLimiterRegistry({ idleMs: 1000 });
    const slow = registry.limiterFor(TOKEN_A, 0.1);
    await slow.acquire(signal(), 0);
    // Reserves the slot 10 s from now.
    const waiting = slow.acquire(signal(), NO_LIMIT);
    await vi.advanceTimersByTimeAsync(5000);
    await registry.limiterFor(TOKEN_B, 1).acquire(signal(), 0);
    expect(registry.size).toBe(2);
    await vi.advanceTimersByTimeAsync(5000);
    await expect(waiting).resolves.toBe(true);
  });

  it("uses a default idle time well above a refill", () => {
    expect(DEFAULT_IDLE_MS).toBeGreaterThanOrEqual(60_000);
  });

  it("caps the number of buckets, dropping the least recently used", async () => {
    const registry = createRateLimiterRegistry({ maxBuckets: 2 });
    const a = registry.limiterFor(TOKEN_A, 1);
    await a.acquire(signal(), 0);
    await registry.limiterFor(TOKEN_B, 1).acquire(signal(), 0);
    await registry.limiterFor("c".repeat(32), 1).acquire(signal(), 0);
    expect(registry.size).toBe(2);
    // A was dropped, so it starts again with a full bucket.
    await expect(a.acquire(signal(), 0)).resolves.toBe(true);
  });
});

describe("aborting", () => {
  it("rejects at once when the signal aborted before", async () => {
    const limiter = createRateLimiterRegistry().limiterFor(TOKEN_A, 1);
    const controller = new AbortController();
    controller.abort(new Error("stop"));
    await expect(limiter.acquire(controller.signal, NO_LIMIT)).rejects.toThrow("stop");
  });

  it("stops waiting on abort and gives the slot back", async () => {
    const limiter = createRateLimiterRegistry().limiterFor(TOKEN_A, 1);
    await limiter.acquire(signal(), 0);
    const controller = new AbortController();
    const waiting = limiter.acquire(controller.signal, NO_LIMIT);
    const rejected = expect(waiting).rejects.toThrow("stop");
    await vi.advanceTimersByTimeAsync(200);
    controller.abort(new Error("stop"));
    await rejected;
    // The aborted waiter's slot is free again: the next one is 800 ms away
    // (one second after the first request), not 1800 ms.
    const start = Date.now();
    let grantedAt = 0;
    const next = limiter.acquire(signal(), NO_LIMIT).then(() => {
      grantedAt = Date.now();
    });
    await vi.advanceTimersByTimeAsync(2000);
    await next;
    expect(grantedAt - start).toBe(800);
  });
});
