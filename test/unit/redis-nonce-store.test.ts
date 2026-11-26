import { describe, expect, it } from "vitest";
import { silentLogger } from "../../src/logger.js";
import { NonceStoreUnavailableError, RedisNonceStore } from "../../src/policy/redis-nonce-store.js";
import { FakeRedis } from "../support/fake-redis.js";

describe("RedisNonceStore", () => {
  it("declares itself shared, as the HTTP transport demands", () => {
    expect(new RedisNonceStore(new FakeRedis()).shared).toBe(true);
  });

  it("consumes with SET NX PX under the key prefix, once", async () => {
    const redis = new FakeRedis();
    const store = new RedisNonceStore(redis);
    expect(await store.consume("nonce:abc", 1500)).toBe(true);
    expect(await store.consume("nonce:abc", 1500)).toBe(false);
    expect(await store.consume("nonce:def", 1500)).toBe(true);
    expect(redis.calls[0]).toEqual({
      command: "SET",
      key: "sevdesk-mcp:nonce:abc",
      options: { condition: "NX", expiration: { type: "PX", value: 1500 } },
    });
  });

  it("lets exactly one of many concurrent consumers win", async () => {
    const store = new RedisNonceStore(new FakeRedis());
    const results = await Promise.all(Array.from({ length: 20 }, () => store.consume("k", 1000)));
    expect(results.filter(Boolean)).toHaveLength(1);
  });

  it("rounds PX up to whole milliseconds", async () => {
    const redis = new FakeRedis();
    await new RedisNonceStore(redis).consume("k", 0.2);
    expect(redis.calls[0]?.options).toEqual({
      condition: "NX",
      expiration: { type: "PX", value: 1 },
    });
  });

  it("frees a key after its TTL and on release (DEL)", async () => {
    let now = 0;
    const redis = new FakeRedis();
    redis.now = () => now;
    const store = new RedisNonceStore(redis, { keyPrefix: "p:" });
    await store.consume("a", 100);
    now = 99;
    expect(await store.consume("a", 100)).toBe(false);
    now = 100;
    expect(await store.consume("a", 100)).toBe(true);
    await store.release("a");
    expect(redis.calls.at(-1)).toEqual({ command: "DEL", key: "p:a" });
    expect(await store.consume("a", 100)).toBe(true);
  });

  it.each([0, -1, Number.NaN, Number.POSITIVE_INFINITY])(
    "rejects the TTL %s before Redis is asked",
    async (ttl) => {
      const redis = new FakeRedis();
      await expect(new RedisNonceStore(redis).consume("a", ttl)).rejects.toThrow(RangeError);
      expect(redis.calls).toEqual([]);
    },
  );

  describe("fails closed", () => {
    it("rejects while disconnected, without sending anything", async () => {
      const redis = new FakeRedis();
      redis.isReady = false;
      const store = new RedisNonceStore(redis);
      await expect(store.consume("a", 1000)).rejects.toThrow(NonceStoreUnavailableError);
      await expect(store.release("a")).rejects.toThrow(NonceStoreUnavailableError);
      expect(redis.calls).toEqual([]);
    });

    it("rejects when a command fails (timeout, socket error)", async () => {
      const redis = new FakeRedis();
      const store = new RedisNonceStore(redis);
      redis.failNext(new Error("Command timeout"));
      await expect(store.consume("a", 1000)).rejects.toThrow("Command timeout");
      redis.failNext(new Error("Socket closed unexpectedly"));
      await expect(store.release("a")).rejects.toThrow("Socket closed unexpectedly");
    });

    it("rejects an unexpected reply instead of reading it as success", async () => {
      const store = new RedisNonceStore({
        isReady: true,
        set: async () => "QUEUED",
        del: async () => 1,
      });
      await expect(store.consume("a", 1000)).rejects.toThrow(NonceStoreUnavailableError);
    });
  });
});

// Optional: against a real Redis, only when REDIS_URL is set (e.g. compose).
describe.skipIf(!process.env.REDIS_URL)("RedisNonceStore against Redis (REDIS_URL)", () => {
  it("consumes atomically, expires and releases", async () => {
    const { connectRedisNonceStore } = await import("../../src/http/redis.js");
    const connection = await connectRedisNonceStore(process.env.REDIS_URL ?? "", silentLogger);
    try {
      const key = `test:${Date.now()}:${Math.random()}`;
      const results = await Promise.all(
        Array.from({ length: 10 }, () => connection.store.consume(key, 200)),
      );
      expect(results.filter(Boolean)).toHaveLength(1);
      await new Promise((resolve) => setTimeout(resolve, 300));
      expect(await connection.store.consume(key, 1000)).toBe(true);
      await connection.store.release(key);
      expect(await connection.store.consume(key, 1000)).toBe(true);
      await connection.store.release(key);
    } finally {
      await connection.close();
    }
  });
});

describe("connectRedisNonceStore", () => {
  it("gives up at startup when Redis is not reachable, without leaking the password", async () => {
    const { connectRedisNonceStore } = await import("../../src/http/redis.js");
    const lines: string[] = [];
    const logger = {
      ...silentLogger,
      warn: (msg: string, fields?: unknown) => void lines.push(`${msg} ${JSON.stringify(fields)}`),
    };
    const error = await connectRedisNonceStore("redis://:pw-in-url@127.0.0.1:9", logger).catch(
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(Error);
    expect(String((error as Error).message)).not.toContain("pw-in-url");
    expect(lines.length).toBeGreaterThan(0);
  }, 20_000);
});
