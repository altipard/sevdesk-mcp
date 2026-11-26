import type { RedisCommands } from "../../src/policy/redis-nonce-store.js";

/**
 * In-memory stand-in for the Redis commands the nonce store uses, with
 * Redis semantics for SET NX [PX], GET and DEL. `isReady`, `failNext`,
 * `hang` and `flush` simulate a lost connection, a Redis that stops
 * answering and a Redis that lost its data.
 */
export class FakeRedis implements RedisCommands {
  isReady = true;
  /** While true, every command stays pending forever (a paused Redis). */
  hang = false;
  readonly calls: Array<{ command: string; key: string; options?: unknown }> = [];
  readonly #entries = new Map<string, { value: string; expiresAt: number }>();
  #fail: Error | undefined;
  now: () => number = Date.now;

  /** The next command rejects with this error, as on a socket error. */
  failNext(error: Error): void {
    this.#fail = error;
  }

  /** Drops every key, as a restart without persistence or FLUSHALL would. */
  flush(): void {
    this.#entries.clear();
  }

  async set(
    key: string,
    value: string,
    options: { condition: "NX"; expiration?: { type: "PX"; value: number } },
  ): Promise<"OK" | null> {
    this.calls.push({ command: "SET", key, options });
    await this.#gate();
    if (options.condition !== "NX") throw new Error("FakeRedis only implements SET NX");
    const ttl = options.expiration;
    if (
      ttl !== undefined &&
      (ttl.type !== "PX" || !Number.isInteger(ttl.value) || ttl.value <= 0)
    ) {
      throw new Error("ERR invalid expire time in 'set' command");
    }
    if (this.#live(key) !== undefined) return null;
    this.#entries.set(key, {
      value,
      expiresAt: ttl === undefined ? Number.POSITIVE_INFINITY : this.now() + ttl.value,
    });
    return "OK";
  }

  async get(key: string): Promise<string | null> {
    this.calls.push({ command: "GET", key });
    await this.#gate();
    return this.#live(key) ?? null;
  }

  async del(key: string): Promise<number> {
    this.calls.push({ command: "DEL", key });
    await this.#gate();
    return this.#entries.delete(key) ? 1 : 0;
  }

  keys(): string[] {
    return [...this.#entries.keys()];
  }

  /** Overwrites a key, e.g. a sentinel written by another instance after a data loss. */
  put(key: string, value: string): void {
    this.#entries.set(key, { value, expiresAt: Number.POSITIVE_INFINITY });
  }

  #live(key: string): string | undefined {
    const entry = this.#entries.get(key);
    return entry !== undefined && entry.expiresAt > this.now() ? entry.value : undefined;
  }

  async #gate(): Promise<void> {
    if (this.hang) await new Promise<never>(() => {});
    const error = this.#fail;
    this.#fail = undefined;
    if (error) throw error;
  }
}
