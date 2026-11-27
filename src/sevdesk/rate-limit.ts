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
  /**
   * Holds back new requests of this token for `ms`, e.g. after sevdesk
   * answered 429 with Retry-After. Slots already reserved are kept.
   */
  pause(ms: number): void;
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
  rate: number;
  capacity: number;
  /** May go negative: each waiting request has reserved its slot. */
  tokens: number;
  updated: number;
  /**
   * Time of the last acquisition. Buckets are kept in this order in the
   * map, which lets eviction stop at the first recent one.
   */
  lastUsed: number;
}

const disabled: RateLimiter = { acquire: async () => true, pause: () => {} };

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

/**
 * One bucket per token, whatever the rate: clients asking for another rate
 * switch the shared bucket to it. In practice every client passes the same
 * config.rateLimit.
 */
function keyOf(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
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
   * request sees the same state as with a fresh bucket. A bucket with
   * pending reservations or a pause is not full. Stops at the first bucket
   * used recently, since the map is ordered by last use.
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
      if (bucket.rate !== rate) {
        refill(bucket, at);
        bucket.rate = rate;
        bucket.capacity = capacityFor(rate);
        bucket.tokens = Math.min(bucket.tokens, bucket.capacity);
      }
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
    // A bucket with waiters is not full, so eviction keeps it anyway.
    bucket.lastUsed = at;
    if (waitMs === 0) return true;
    try {
      await untilAborted(sleep(waitMs, signal), signal);
    } catch (error) {
      bucket.tokens = Math.min(bucket.capacity, bucket.tokens + 1);
      throw error;
    }
    return true;
  }

  function pause(key: string, rate: number, ms: number): void {
    if (!(ms > 0)) return;
    const at = now();
    const bucket = bucketFor(key, rate, at);
    refill(bucket, at);
    // The next slot opens `ms` from now: (1 - tokens) / rate seconds.
    bucket.tokens = Math.min(bucket.tokens, 1 - (ms / 1000) * bucket.rate);
    bucket.lastUsed = at;
  }

  return {
    limiterFor(token, requestsPerSecond) {
      if (!(requestsPerSecond > 0) || !Number.isFinite(requestsPerSecond)) return disabled;
      const key = keyOf(token);
      return {
        acquire: (signal, maxWaitMs) => acquire(key, requestsPerSecond, signal, maxWaitMs),
        pause: (ms) => pause(key, requestsPerSecond, ms),
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
