import type { RedisCommands } from "../../src/policy/redis-nonce-store.js";

/**
 * In-memory stand-in for the two Redis commands the nonce store uses, with
 * Redis semantics for SET NX PX and DEL. `isReady` and `failNext` simulate
 * a lost connection.
 */
export class FakeRedis implements RedisCommands {
  isReady = true;
  readonly calls: Array<{ command: string; key: string; options?: unknown }> = [];
  readonly #entries = new Map<string, number>();
  #fail: Error | undefined;
  now: () => number = Date.now;

  /** The next command rejects with this error, as on a timeout or socket error. */
  failNext(error: Error): void {
    this.#fail = error;
  }

  async set(
    key: string,
    _value: string,
    options: { condition: "NX"; expiration: { type: "PX"; value: number } },
  ): Promise<"OK" | null> {
    this.calls.push({ command: "SET", key, options });
    this.#throwIfFailing();
    if (options.condition !== "NX" || options.expiration.type !== "PX") {
      throw new Error("FakeRedis only implements SET NX PX");
    }
    if (!Number.isInteger(options.expiration.value) || options.expiration.value <= 0) {
      throw new Error("ERR invalid expire time in 'set' command");
    }
    const expiresAt = this.#entries.get(key);
    if (expiresAt !== undefined && expiresAt > this.now()) return null;
    this.#entries.set(key, this.now() + options.expiration.value);
    return "OK";
  }

  async del(key: string): Promise<number> {
    this.calls.push({ command: "DEL", key });
    this.#throwIfFailing();
    return this.#entries.delete(key) ? 1 : 0;
  }

  keys(): string[] {
    return [...this.#entries.keys()];
  }

  #throwIfFailing(): void {
    const error = this.#fail;
    this.#fail = undefined;
    if (error) throw error;
  }
}
