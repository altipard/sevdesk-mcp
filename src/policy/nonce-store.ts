/**
 * Single-use markers for class X: confirmation nonces and idempotency keys.
 *
 * `consume` must be atomic: of two concurrent calls with the same key,
 * exactly one may resolve true. A store that cannot answer must reject, and
 * callers treat a rejection as "do not execute" (fail closed). A shared
 * backend (e.g. Redis `SET key 1 NX PX ttl`) implements the same interface
 * for several instances; this process-local one serves stdio and tests.
 */
export interface NonceStore {
  /**
   * true only if every instance of the server sees the same entries (e.g.
   * Redis). The HTTP transport refuses a store that is not shared, because a
   * token could otherwise be replayed against another instance or after a
   * restart.
   */
  readonly shared: boolean;
  /** Marks `key` as used for `ttlMs`. Resolves false if it already was. */
  consume(key: string, ttlMs: number): Promise<boolean>;
  /**
   * Whether `key` is currently marked, without marking or freeing it. A
   * store that cannot answer rejects, like consume.
   */
  has(key: string): Promise<boolean>;
  /** Frees a key again, e.g. after sevdesk definitely rejected the action. */
  release(key: string): Promise<void>;
}

const SWEEP_THRESHOLD = 10_000;

export class InMemoryNonceStore implements NonceStore {
  /** Process-local: entries die with the process and are not seen by others. */
  readonly shared = false;
  readonly #entries = new Map<string, number>();
  readonly #now: () => number;

  constructor(options: { now?: () => number } = {}) {
    this.#now = options.now ?? Date.now;
  }

  // Check and set run synchronously between two awaits, so the single JS
  // thread makes them atomic for this process.
  consume(key: string, ttlMs: number): Promise<boolean> {
    if (!Number.isFinite(ttlMs) || ttlMs <= 0) {
      return Promise.reject(new RangeError("ttlMs must be a positive number"));
    }
    const now = this.#now();
    if (this.#entries.size >= SWEEP_THRESHOLD) this.#sweep(now);
    const expiresAt = this.#entries.get(key);
    if (expiresAt !== undefined && expiresAt > now) return Promise.resolve(false);
    this.#entries.set(key, now + ttlMs);
    return Promise.resolve(true);
  }

  has(key: string): Promise<boolean> {
    const expiresAt = this.#entries.get(key);
    return Promise.resolve(expiresAt !== undefined && expiresAt > this.#now());
  }

  release(key: string): Promise<void> {
    this.#entries.delete(key);
    return Promise.resolve();
  }

  get size(): number {
    return this.#entries.size;
  }

  #sweep(now: number): void {
    for (const [key, expiresAt] of this.#entries) {
      if (expiresAt <= now) this.#entries.delete(key);
    }
  }
}
