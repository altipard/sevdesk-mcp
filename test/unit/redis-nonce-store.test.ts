import { describe, expect, it } from "vitest";
import { silentLogger } from "../../src/logger.js";
import {
  NonceStoreStateLostError,
  NonceStoreUnavailableError,
  type RedisCommands,
  RedisNonceStore,
} from "../../src/policy/redis-nonce-store.js";
import { FakeRedis } from "../support/fake-redis.js";

async function ready(redis = new FakeRedis(), options = {}) {
  const store = new RedisNonceStore(redis, { operationTimeoutMs: 100, ...options });
  await store.initialize();
  redis.calls.length = 0;
  return { redis, store };
}

const sets = (redis: FakeRedis) => redis.calls.filter((c) => c.command === "SET");

describe("RedisNonceStore", () => {
  it("declares itself shared, as the HTTP transport demands", () => {
    expect(new RedisNonceStore(new FakeRedis()).shared).toBe(true);
  });

  it("consumes with SET NX PX under the key prefix, once", async () => {
    const { redis, store } = await ready();
    expect(await store.consume("nonce:abc", 1500)).toBe(true);
    expect(await store.consume("nonce:abc", 1500)).toBe(false);
    expect(await store.consume("nonce:def", 1500)).toBe(true);
    expect(sets(redis)[0]).toEqual({
      command: "SET",
      key: "sevdesk-mcp:nonce:abc",
      options: { condition: "NX", expiration: { type: "PX", value: 1500 } },
    });
  });

  it("lets exactly one of many concurrent consumers win", async () => {
    const { store } = await ready();
    const results = await Promise.all(Array.from({ length: 20 }, () => store.consume("k", 1000)));
    expect(results.filter(Boolean)).toHaveLength(1);
  });

  it("rounds PX up to whole milliseconds", async () => {
    const { redis, store } = await ready();
    await store.consume("k", 0.2);
    expect(sets(redis)[0]?.options).toEqual({
      condition: "NX",
      expiration: { type: "PX", value: 1 },
    });
  });

  it("frees a key after its TTL and on release (DEL)", async () => {
    let now = 0;
    const redis = new FakeRedis();
    redis.now = () => now;
    const { store } = await ready(redis, { keyPrefix: "p:" });
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
      const { redis, store } = await ready();
      await expect(store.consume("a", ttl)).rejects.toThrow(RangeError);
      expect(redis.calls).toEqual([]);
    },
  );

  describe("fails closed", () => {
    it("rejects while disconnected, without sending anything", async () => {
      const { redis, store } = await ready();
      redis.isReady = false;
      await expect(store.consume("a", 1000)).rejects.toThrow(NonceStoreUnavailableError);
      await expect(store.release("a")).rejects.toThrow(NonceStoreUnavailableError);
      expect(redis.calls).toEqual([]);
    });

    it("rejects when a command fails (socket error)", async () => {
      const { redis, store } = await ready();
      redis.failNext(new Error("Socket closed unexpectedly"));
      await expect(store.consume("a", 1000)).rejects.toThrow("Socket closed unexpectedly");
      redis.failNext(new Error("Socket closed unexpectedly"));
      await expect(store.release("a")).rejects.toThrow("Socket closed unexpectedly");
    });

    it("rejects within its own timeout when Redis never answers", async () => {
      const { redis, store } = await ready();
      redis.hang = true;
      const started = Date.now();
      await expect(store.consume("a", 1000)).rejects.toThrow("Redis did not answer in time");
      await expect(store.release("a")).rejects.toThrow(NonceStoreUnavailableError);
      expect(Date.now() - started).toBeLessThan(1000);
    });

    it("rejects an unexpected reply instead of reading it as success", async () => {
      let sentinel: string | null = null;
      const redis: RedisCommands = {
        isReady: true,
        set: async (_key, value, options) => {
          if (options.expiration === undefined) {
            sentinel = value;
            return "OK";
          }
          return "QUEUED";
        },
        get: async () => sentinel,
        del: async () => 1,
      };
      const store = new RedisNonceStore(redis);
      await store.initialize();
      await expect(store.consume("a", 1000)).rejects.toThrow(NonceStoreUnavailableError);
    });

    it("rejects an unexpected reply to has() instead of reading it as absent", async () => {
      const redis: RedisCommands = {
        isReady: true,
        set: async () => "OK",
        get: async (key) => (key.endsWith("sentinel") ? "s" : 1),
        del: async () => 1,
      };
      const store = new RedisNonceStore(redis);
      await store.initialize();
      await expect(store.has("a")).rejects.toThrow(NonceStoreUnavailableError);
    });

    it("refuses to consume before initialize()", async () => {
      await expect(new RedisNonceStore(new FakeRedis()).consume("a", 1000)).rejects.toThrow(
        "before initialize",
      );
    });
  });

  describe("has", () => {
    it("reads with GET under the key prefix and never writes", async () => {
      const { redis, store } = await ready();
      expect(await store.has("marker")).toBe(false);
      await store.consume("marker", 1000);
      expect(await store.has("marker")).toBe(true);
      expect(sets(redis)).toHaveLength(1);
      expect(redis.calls.filter((c) => c.command === "DEL")).toEqual([]);
      expect(redis.calls.filter((c) => c.command === "GET").map((c) => c.key)).toContain(
        "sevdesk-mcp:marker",
      );
    });

    it("fails closed: disconnected, no answer in time, lost data", async () => {
      const { redis, store } = await ready();
      redis.isReady = false;
      await expect(store.has("a")).rejects.toThrow(NonceStoreUnavailableError);
      redis.isReady = true;
      redis.hang = true;
      await expect(store.has("a")).rejects.toThrow("Redis did not answer in time");
      redis.hang = false;
      redis.flush();
      await expect(store.has("a")).rejects.toThrow(NonceStoreStateLostError);
    });

    it("refuses before initialize()", async () => {
      await expect(new RedisNonceStore(new FakeRedis()).has("a")).rejects.toThrow(
        "before initialize",
      );
    });
  });

  describe("sentinel", () => {
    it("is written once without expiry; a second instance adopts it", async () => {
      const redis = new FakeRedis();
      const first = new RedisNonceStore(redis);
      await first.initialize();
      const second = new RedisNonceStore(redis);
      await second.initialize();
      expect(redis.keys()).toEqual(["sevdesk-mcp:sentinel"]);
      expect(await first.consume("a", 1000)).toBe(true);
      expect(await second.consume("a", 1000)).toBe(false);
    });

    it("refuses every consume after Redis lost its data, until a new process", async () => {
      let lost = 0;
      const { redis, store } = await ready(new FakeRedis(), { onStateLost: () => lost++ });
      expect(await store.consume("nonce:a", 60_000)).toBe(true);
      redis.flush();
      // Without the check, the used nonce would be accepted again here.
      await expect(store.consume("nonce:a", 60_000)).rejects.toThrow(NonceStoreStateLostError);
      expect(sets(redis)).toHaveLength(1);
      // Another instance restarting writes a new sentinel; this one stays closed.
      const restarted = new RedisNonceStore(redis);
      await restarted.initialize();
      await expect(store.consume("nonce:b", 60_000)).rejects.toThrow(/restarted/);
      expect(lost).toBe(1);
      // The restarted process works again, deliberately.
      expect(await restarted.consume("nonce:b", 60_000)).toBe(true);
    });

    it("treats a changed sentinel as lost data", async () => {
      const { redis, store } = await ready();
      redis.put("sevdesk-mcp:sentinel", "written by someone else");
      await expect(store.consume("a", 1000)).rejects.toThrow(NonceStoreStateLostError);
    });

    it("fails initialize when Redis does not answer", async () => {
      const redis = new FakeRedis();
      redis.hang = true;
      await expect(
        new RedisNonceStore(redis, { operationTimeoutMs: 50 }).initialize(),
      ).rejects.toThrow(NonceStoreUnavailableError);
    });
  });
});

// Optional: against a real Redis, only when REDIS_URL is set (e.g. compose).
describe.skipIf(!process.env.REDIS_URL)("RedisNonceStore against Redis (REDIS_URL)", () => {
  it("rejects in time and closes in time while Redis is paused", async () => {
    const { createClient } = await import("redis");
    const { connectRedisNonceStore, REDIS_COMMAND_TIMEOUT_MS } = await import(
      "../../src/http/redis.js"
    );
    const connection = await connectRedisNonceStore(process.env.REDIS_URL ?? "", silentLogger);
    const admin = createClient({ url: process.env.REDIS_URL ?? "" });
    await admin.connect();
    try {
      // Redis keeps the connection but answers nobody for 4 s.
      await admin.sendCommand(["CLIENT", "PAUSE", "4000", "ALL"]);
      let started = Date.now();
      await expect(connection.store.consume(`paused:${Date.now()}`, 1000)).rejects.toThrow(
        NonceStoreUnavailableError,
      );
      expect(Date.now() - started).toBeLessThan(REDIS_COMMAND_TIMEOUT_MS + 1000);
      started = Date.now();
      await connection.close();
      expect(Date.now() - started).toBeLessThan(2000);
    } finally {
      await admin.sendCommand(["CLIENT", "UNPAUSE"]).catch(() => {});
      await admin.close();
    }
  }, 15_000);

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

describe("checkEvictionPolicy", () => {
  async function warnings(read: () => Promise<unknown>, timeoutMs?: number) {
    const { checkEvictionPolicy } = await import("../../src/http/redis.js");
    const lines: Array<{ msg: string; fields: unknown }> = [];
    const logger = {
      ...silentLogger,
      warn: (msg: string, fields?: unknown) => void lines.push({ msg, fields }),
    };
    await checkEvictionPolicy(read, logger, timeoutMs);
    return lines;
  }

  it("is silent for noeviction", async () => {
    expect(await warnings(async () => ({ "maxmemory-policy": "noeviction" }))).toEqual([]);
  });

  it("warns for any other policy and names it", async () => {
    const lines = await warnings(async () => ({ "maxmemory-policy": "allkeys-lru" }));
    expect(lines).toHaveLength(1);
    expect(lines[0]?.msg).toContain("not noeviction");
    expect(lines[0]?.fields).toMatchObject({ policy: "allkeys-lru" });
    expect((await warnings(async () => ({})))[0]?.fields).toMatchObject({ policy: "unknown" });
  });

  it("only logs when CONFIG GET is refused or hangs; startup goes on", async () => {
    const refused = await warnings(async () => {
      throw new Error("ERR unknown command 'CONFIG'");
    });
    expect(refused[0]?.msg).toContain("could not read");
    const hanging = await warnings(() => new Promise(() => {}), 50);
    expect(hanging[0]?.msg).toContain("could not read");
  });
});
