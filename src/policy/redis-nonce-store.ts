import { randomUUID } from "node:crypto";
import type { NonceStore } from "./nonce-store.js";

/**
 * The Redis commands the store needs, in node-redis's call shape. The real
 * client is passed in production; tests pass a fake.
 */
export interface RedisCommands {
  /** false while disconnected; commands are not queued then (fail closed). */
  readonly isReady: boolean;
  set(
    key: string,
    value: string,
    options: { condition: "NX"; expiration?: { type: "PX"; value: number } },
  ): Promise<unknown>;
  get(key: string): Promise<unknown>;
  del(key: string): Promise<unknown>;
}

export const DEFAULT_KEY_PREFIX = "sevdesk-mcp:";
/** Upper bound for one store operation, including a Redis that accepts but never answers. */
export const DEFAULT_OPERATION_TIMEOUT_MS = 2000;
/** Key that proves Redis still holds what this process saw at startup. */
export const SENTINEL_KEY = "sentinel";

export class NonceStoreUnavailableError extends Error {
  override readonly name: string = "NonceStoreUnavailableError";
}

/**
 * Redis lost its data while the server was running (restart without
 * persistence, eviction, FLUSHALL): nonces consumed before could be valid
 * again. Raised until this process is restarted on purpose.
 */
export class NonceStoreStateLostError extends NonceStoreUnavailableError {
  override readonly name: string = "NonceStoreStateLostError";
}

export interface RedisNonceStoreOptions {
  keyPrefix?: string;
  operationTimeoutMs?: number;
  /** Called once when the loss of the sentinel is detected, for the operator log. */
  onStateLost?: () => void;
}

/**
 * Nonce store in Redis, shared by every instance of the server.
 *
 * consume is `SET key 1 NX PX ttl`: Redis runs it atomically, so of two
 * concurrent calls with the same key across all instances exactly one gets
 * "OK". has is `GET`, release is `DEL`. Every failure rejects (not connected, no answer
 * within the timeout, unexpected reply), and the guard then does not
 * execute: fail closed.
 *
 * A sentinel key, written at startup with a random value, guards against
 * Redis losing its data under a running server: if it is gone or changed,
 * every further consume rejects until the process is restarted, which
 * writes the sentinel again as a deliberate act.
 */
export class RedisNonceStore implements NonceStore {
  readonly shared = true;
  readonly #redis: RedisCommands;
  readonly #prefix: string;
  readonly #timeoutMs: number;
  readonly #onStateLost: (() => void) | undefined;
  #sentinel: string | undefined;
  #stateLost = false;

  constructor(redis: RedisCommands, options: RedisNonceStoreOptions = {}) {
    this.#redis = redis;
    this.#prefix = options.keyPrefix ?? DEFAULT_KEY_PREFIX;
    this.#timeoutMs = options.operationTimeoutMs ?? DEFAULT_OPERATION_TIMEOUT_MS;
    this.#onStateLost = options.onStateLost;
  }

  /**
   * Writes the sentinel unless another instance already did, and remembers
   * its value. Must run once before the store is used.
   */
  async initialize(): Promise<void> {
    this.#assertReady();
    const key = `${this.#prefix}${SENTINEL_KEY}`;
    const value = `${new Date().toISOString()} ${randomUUID()}`;
    await this.#bounded(this.#redis.set(key, value, { condition: "NX" }));
    const stored = await this.#bounded(this.#redis.get(key));
    if (typeof stored !== "string" || stored === "") {
      throw new NonceStoreUnavailableError("Redis did not keep the sentinel key");
    }
    this.#sentinel = stored;
  }

  async consume(key: string, ttlMs: number): Promise<boolean> {
    if (!Number.isFinite(ttlMs) || ttlMs <= 0) {
      throw new RangeError("ttlMs must be a positive number");
    }
    this.#assertReady();
    await this.#assertStateKept();
    const reply = await this.#bounded(
      this.#redis.set(`${this.#prefix}${key}`, "1", {
        condition: "NX",
        // PX takes whole milliseconds; rounding up never shortens the lock.
        expiration: { type: "PX", value: Math.ceil(ttlMs) },
      }),
    );
    if (reply === "OK") return true;
    if (reply === null) return false;
    throw new NonceStoreUnavailableError("unexpected reply from Redis to SET NX");
  }

  /**
   * `GET key`: true while the key exists. Behind the same checks as
   * consume, so a store whose state was lost answers nothing (fail closed).
   */
  async has(key: string): Promise<boolean> {
    this.#assertReady();
    await this.#assertStateKept();
    const reply = await this.#bounded(this.#redis.get(`${this.#prefix}${key}`));
    if (reply === null) return false;
    if (typeof reply === "string") return true;
    throw new NonceStoreUnavailableError("unexpected reply from Redis to GET");
  }

  async release(key: string): Promise<void> {
    this.#assertReady();
    await this.#bounded(this.#redis.del(`${this.#prefix}${key}`));
  }

  #assertReady(): void {
    if (!this.#redis.isReady) throw new NonceStoreUnavailableError("Redis is not connected");
  }

  async #assertStateKept(): Promise<void> {
    if (this.#sentinel === undefined) {
      throw new NonceStoreUnavailableError("nonce store used before initialize()");
    }
    if (!this.#stateLost) {
      const stored = await this.#bounded(this.#redis.get(`${this.#prefix}${SENTINEL_KEY}`));
      if (stored === this.#sentinel) return;
      // Latched: a sentinel that reappears (another instance restarted)
      // does not bring back what this process may have seen consumed.
      this.#stateLost = true;
      this.#onStateLost?.();
    }
    throw new NonceStoreStateLostError(
      "Redis lost its data while the server was running (sentinel key missing or changed); " +
        "confirmations are refused until the server is restarted. Check Redis persistence " +
        "(appendonly yes) and maxmemory-policy noeviction first.",
    );
  }

  /**
   * node-redis's command timeout does not cover a command already sent to a
   * Redis that stops answering, so every call gets its own deadline. A SET
   * that lands after the deadline only locks a key longer; it never lets an
   * action through.
   */
  #bounded<T>(command: Promise<T>): Promise<T> {
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(
        () => reject(new NonceStoreUnavailableError("Redis did not answer in time")),
        this.#timeoutMs,
      );
    });
    // A late rejection of the command must not surface as unhandled.
    command.catch(() => {});
    return Promise.race([command, timeout]).finally(() => clearTimeout(timer));
  }
}
