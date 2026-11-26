import { describe, expect, it } from "vitest";
import { InMemoryNonceStore } from "../../src/policy/nonce-store.js";

describe("InMemoryNonceStore", () => {
  it("declares itself process-local, so HTTP refuses it", () => {
    expect(new InMemoryNonceStore().shared).toBe(false);
  });

  it("consumes a key once", async () => {
    const store = new InMemoryNonceStore();
    expect(await store.consume("a", 1000)).toBe(true);
    expect(await store.consume("a", 1000)).toBe(false);
    expect(await store.consume("b", 1000)).toBe(true);
  });

  it("lets exactly one of many concurrent consumers win", async () => {
    const store = new InMemoryNonceStore();
    const results = await Promise.all(Array.from({ length: 20 }, () => store.consume("k", 1000)));
    expect(results.filter(Boolean)).toHaveLength(1);
  });

  it("frees a key after its TTL and on release", async () => {
    let now = 0;
    const store = new InMemoryNonceStore({ now: () => now });
    await store.consume("a", 100);
    now = 99;
    expect(await store.consume("a", 100)).toBe(false);
    now = 100;
    expect(await store.consume("a", 100)).toBe(true);
    await store.release("a");
    expect(await store.consume("a", 100)).toBe(true);
  });

  it("sweeps expired entries once it grows large", async () => {
    let now = 0;
    const store = new InMemoryNonceStore({ now: () => now });
    for (let i = 0; i < 10_000; i++) await store.consume(`k${i}`, 10);
    now = 20;
    await store.consume("fresh", 10);
    expect(store.size).toBe(1);
  });

  it.each([0, -1, Number.NaN])("rejects the TTL %s", async (ttl) => {
    await expect(new InMemoryNonceStore().consume("a", ttl)).rejects.toThrow(RangeError);
  });
});
