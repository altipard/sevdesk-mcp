import { describe, expect, it } from "vitest";
import { httpFixture, rawPost, signToken } from "./support.js";

const fx = httpFixture();
const tick = (ms = 50) => new Promise((resolve) => setTimeout(resolve, ms));

describe("graceful shutdown", () => {
  it("idle: stops listening, closes Redis and logs the stop", async () => {
    const server = await fx.server();
    expect((await fetch(`${server.resourceUrl.origin}/healthz`)).status).toBe(200);
    expect(await server.shutdown("SIGTERM")).toEqual({ forced: false });
    expect(server.server.listening).toBe(false);
    expect(server.redisClosed()).toBe(true);
    await expect(fetch(`${server.resourceUrl.origin}/healthz`)).rejects.toThrow();
    const messages = server.logLines.map((line) => JSON.parse(line).msg);
    expect(messages).toContain("sevdesk-mcp stopping");
    expect(messages.at(-1)).toBe("sevdesk-mcp stopped");
  });

  it("lets an in-flight request finish before it stops", async () => {
    const server = await fx.server({}, { shutdownTimeoutMs: 5000 });
    const token = await signToken(fx.iss, server.resourceUrl.href);
    // The gate waits for the issuer's keys, so the request stays in flight.
    const release = fx.iss.hold();
    const pending = rawPost(server.resourceUrl, token);
    await tick();

    let stopped = false;
    const stopping = server.shutdown("SIGTERM").then((result) => {
      stopped = true;
      return result;
    });
    await tick();
    expect(stopped).toBe(false);
    expect(server.server.listening).toBe(false);

    release();
    const response = await pending;
    expect(response.status).toBe(200);
    // The legacy path answers as an event stream; the result is complete.
    expect(await response.text()).toContain('"tools":[');
    expect(await stopping).toEqual({ forced: false });
  });

  it("cuts connections that are still busy after the timeout", async () => {
    const server = await fx.server({}, { shutdownTimeoutMs: 200 });
    const token = await signToken(fx.iss, server.resourceUrl.href);
    const release = fx.iss.hold();
    try {
      const pending = rawPost(server.resourceUrl, token).then(
        (r) => r.status,
        () => "cut",
      );
      await tick();
      const started = Date.now();
      expect(await server.shutdown("SIGTERM")).toEqual({ forced: true });
      expect(Date.now() - started).toBeLessThan(2000);
      expect(await pending).toBe("cut");
      expect(server.redisClosed()).toBe(true);
      expect(server.logLines.join("")).toContain("shutdown timeout reached");
    } finally {
      release();
    }
  });

  it("a second signal does not start a second shutdown", async () => {
    const server = await fx.server();
    const first = server.shutdown("SIGTERM");
    const second = server.shutdown("SIGINT");
    expect(second).toBe(first);
    await first;
    const stopping = server.logLines.filter((line) =>
      line.includes('"msg":"sevdesk-mcp stopping"'),
    );
    expect(stopping).toHaveLength(1);
  });

  it("while draining, health reports 503 and the MCP endpoint refuses new requests", async () => {
    const server = await fx.server();
    server.app.startDraining();
    const origin = server.resourceUrl.origin;
    const health = await server.app.fetch(new Request(`${origin}/healthz`));
    expect(health.status).toBe(503);
    expect(await health.json()).toEqual({ status: "draining" });
    const mcp = await server.app.fetch(
      new Request(server.resourceUrl, {
        method: "POST",
        headers: { host: server.resourceUrl.host },
      }),
    );
    expect(mcp.status).toBe(503);
  });
});
