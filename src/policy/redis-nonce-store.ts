import type { NonceStore } from "./nonce-store.js";

/**
 * The two Redis commands the store needs, in node-redis's call shape. The
 * real client is passed in production; tests pass a fake.
 */
export interface RedisCommands {
  /** false while disconnected; commands are not queued then (fail closed). */
  readonly isReady: boolean;
  set(
    key: string,
    value: string,
    options: { condition: "NX"; expiration: { type: "PX"; value: number } },
  ): Promise<unknown>;
  del(key: string): Promise<unknown>;
}

export const DEFAULT_KEY_PREFIX = "sevdesk-mcp:";

export class NonceStoreUnavailableError extends Error {
  override readonly name = "NonceStoreUnavailableError";
}

/**
 * Nonce store in Redis, shared by every instance of the server.
 *
 * consume is `SET key 1 NX PX ttl`: Redis runs it atomically, so of two
 * concurrent calls with the same key across all instances exactly one gets
 * "OK". release is `DEL`. Every failure rejects (not connected, timeout,
 * unexpected reply), and the guard then does not execute: fail closed.
 */
export class RedisNonceStore implements NonceStore {
  readonly shared = true;
  readonly #redis: RedisCommands;
  readonly #prefix: string;

  constructor(redis: RedisCommands, options: { keyPrefix?: string } = {}) {
    this.#redis = redis;
    this.#prefix = options.keyPrefix ?? DEFAULT_KEY_PREFIX;
  }

  async consume(key: string, ttlMs: number): Promise<boolean> {
    if (!Number.isFinite(ttlMs) || ttlMs <= 0) {
      throw new RangeError("ttlMs must be a positive number");
    }
    this.#assertReady();
    const reply = await this.#redis.set(`${this.#prefix}${key}`, "1", {
      condition: "NX",
      // PX takes whole milliseconds; rounding up never shortens the lock.
      expiration: { type: "PX", value: Math.ceil(ttlMs) },
    });
    if (reply === "OK") return true;
    if (reply === null) return false;
    throw new NonceStoreUnavailableError("unexpected reply from Redis to SET NX");
  }

  async release(key: string): Promise<void> {
    this.#assertReady();
    await this.#redis.del(`${this.#prefix}${key}`);
  }

  #assertReady(): void {
    if (!this.#redis.isReady) throw new NonceStoreUnavailableError("Redis is not connected");
  }
}
