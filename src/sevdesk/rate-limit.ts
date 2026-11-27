import { createHash } from "node:crypto";

/**
 * Client-side pacing of sevdesk requests: one token bucket per API token,
 * shared by every client in the process that uses the same token. In the
 * HTTP transport each session builds its own client; sessions of one token
 * share a bucket, a different token never waits for it.
 */

/** Paces the requests of one API token. */
export interface RateLimiter {
  /**
   * Takes one request slot, waiting for it if the bucket is empty.
   * Resolves `false` without taking a slot (and without waiting) when the
   * wait would be longer than `maxWaitMs`. Rejects with the signal's reason
   * if it aborts before or during the wait; the slot is then given back.
   */
  acquire(signal: AbortSignal, maxWaitMs: number): Promise<boolean>;
}

export interface RateLimiterRegistry {
  /**
   * The limiter for `token` at `requestsPerSecond`. 0 disables pacing.
   * Only a hash of the token is kept.
   */
  limiterFor(token: string, requestsPerSecond: number): RateLimiter;
  /** Number of buckets currently held, for tests and diagnostics. */
  readonly size: number;
}

export interface RateLimiterRegistryOptions {
  now?: () => number;
  /** Waits `ms`; must settle when the signal aborts. */
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
  /** A full bucket unused this long is dropped. */
  idleMs?: number;
  /** Hard cap on buckets; the least recently used one goes first. */
  maxBuckets?: number;
}

export const DEFAULT_IDLE_MS = 10 * 60_000;
export const DEFAULT_MAX_BUCKETS = 1000;

interface Bucket {
  readonly rate: number;
  readonly capacity: number;
  /** May go negative: each waiting request has reserved its slot. */
  tokens: number;
  updated: number;
  lastUsed: number;
}

const disabled: RateLimiter = { acquire: async () => true };

const realSleep = (ms: number, signal: AbortSignal): Promise<void> =>
  new Promise((resolve) => {
    const timer = setTimeout(done, ms);
    function done() {
      clearTimeout(timer);
      signal.removeEventListener("abort", done);
      resolve();
    }
    signal.addEventListener("abort", done, { once: true });
  });

function keyOf(token: string, rate: number): string {
  return `${createHash("sha256").update(token, "utf8").digest("hex")}:${rate}`;
}

/** Burst of up to one second of requests, at least one. */
function capacityFor(rate: number): number {
  return Math.max(1, rate);
}

export function createRateLimiterRegistry(
  options: RateLimiterRegistryOptions = {},
): RateLimiterRegistry {
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? realSleep;
  const idleMs = options.idleMs ?? DEFAULT_IDLE_MS;
  const maxBuckets = options.maxBuckets ?? DEFAULT_MAX_BUCKETS;
  // Insertion order is kept as least recently used first: a bucket in use
  // is moved to the end.
  const buckets = new Map<string, Bucket>();

  function refill(bucket: Bucket, at: number): void {
    const elapsed = Math.max(0, at - bucket.updated);
    bucket.tokens = Math.min(bucket.capacity, bucket.tokens + (elapsed / 1000) * bucket.rate);
    bucket.updated = at;
  }

  /**
   * Drops buckets idle for `idleMs` that are full again, so a later
   * request sees the same state as with a fresh bucket. Stops at the first
   * bucket in use, since the rest were used more recently.
   */
  function evict(at: number): void {
    for (const [key, bucket] of buckets) {
      if (at - bucket.lastUsed < idleMs) break;
      refill(bucket, at);
      if (bucket.tokens >= bucket.capacity) buckets.delete(key);
    }
  }

  function bucketFor(key: string, rate: number, at: number): Bucket {
    // Before the lookup: a dropped bucket was full, so recreating it below
    // changes nothing for this request.
    evict(at);
    let bucket = buckets.get(key);
    if (bucket === undefined) {
      const capacity = capacityFor(rate);
      bucket = { rate, capacity, tokens: capacity, updated: at, lastUsed: at };
    } else {
      buckets.delete(key);
    }
    buckets.set(key, bucket);
    // The cap may have dropped others to make room, never this one.
    while (buckets.size > maxBuckets) {
      const oldest = buckets.keys().next();
      if (oldest.done || oldest.value === key) break;
      buckets.delete(oldest.value);
    }
    return bucket;
  }

  async function acquire(
    key: string,
    rate: number,
    signal: AbortSignal,
    maxWaitMs: number,
  ): Promise<boolean> {
    if (signal.aborted) throw signal.reason;
    const at = now();
    const bucket = bucketFor(key, rate, at);
    refill(bucket, at);
    const waitMs = bucket.tokens >= 1 ? 0 : Math.ceil(((1 - bucket.tokens) / bucket.rate) * 1000);
    if (waitMs > maxWaitMs) return false;
    bucket.tokens -= 1;
    // Counts the reserved slot as use, so a bucket with waiters is not
    // dropped while they wait.
    bucket.lastUsed = at + waitMs;
    if (waitMs === 0) return true;
    try {
      await untilAborted(sleep(waitMs, signal), signal);
    } catch (error) {
      bucket.tokens = Math.min(bucket.capacity, bucket.tokens + 1);
      throw error;
    }
    return true;
  }

  return {
    limiterFor(token, requestsPerSecond) {
      if (!(requestsPerSecond > 0) || !Number.isFinite(requestsPerSecond)) return disabled;
      const key = keyOf(token, requestsPerSecond);
      return {
        acquire: (signal, maxWaitMs) => acquire(key, requestsPerSecond, signal, maxWaitMs),
      };
    },
    get size() {
      return buckets.size;
    },
  };
}

function untilAborted<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(signal.reason);
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
  });
}

/** The registry of this process; every client uses it unless a test injects one. */
export const sharedRateLimiters: RateLimiterRegistry = createRateLimiterRegistry();
