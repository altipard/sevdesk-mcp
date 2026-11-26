import { createServer, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createSevdeskClient, type SevdeskClient } from "../../src/sevdesk/client.js";
import { SevdeskError } from "../../src/sevdesk/errors.js";
import { TEST_TOKEN } from "../helpers.js";

// A body that stalls after the headers needs a real socket: msw's socket
// emulation finishes the response after the client aborted, which undici
// does not expect. This file therefore runs without msw.

let server: Server;
let baseUrl: string;
let requests = 0;
let endlessBytes = 0;
let endlessClosed = false;
const open = new Set<ServerResponse>();

beforeAll(async () => {
  server = createServer((req, res) => {
    requests++;
    if (req.url?.endsWith("/endless")) {
      // Streams without content-length until the client hangs up.
      res.writeHead(200, { "content-type": "application/json" });
      open.add(res);
      const chunk = "x".repeat(1024);
      const pump = () => {
        if (res.destroyed || endlessBytes > 50 * 1024 * 1024) return;
        endlessBytes += chunk.length;
        if (res.write(chunk)) setImmediate(pump);
        else res.once("drain", pump);
      };
      res.on("close", () => {
        endlessClosed = true;
        open.delete(res);
      });
      pump();
      return;
    }
    res.writeHead(200, { "content-type": "application/json" });
    if (req.url?.endsWith("/stall-once") && requests > 1) {
      res.end(JSON.stringify({ objects: [] }));
      return;
    }
    // Headers and the start of the JSON, then nothing.
    res.write('{"objects":');
    open.add(res);
    res.on("close", () => open.delete(res));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  for (const res of open) res.destroy();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

function client(maxRetries: number) {
  const sleeps: number[] = [];
  const sevdesk = createSevdeskClient({
    baseUrl,
    token: TEST_TOKEN,
    timeoutMs: 250,
    retry: { maxRetries },
    sleep: async (ms) => {
      sleeps.push(ms);
    },
  });
  return { sevdesk, sleeps };
}

// The paths are not part of the sevdesk spec, so the typed client is
// bypassed with a cast; only the transport behaviour matters here.
type UntypedGet = (path: string) => Parameters<SevdeskClient["call"]>[0];

describe("body that stalls after the headers", () => {
  it("becomes a SevdeskError timeout", async () => {
    requests = 0;
    const { sevdesk } = client(0);
    const get = sevdesk.api.GET as unknown as UntypedGet;

    const error = await sevdesk.call(get("/stall")).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(SevdeskError);
    expect((error as SevdeskError).kind).toBe("timeout");
    expect((error as SevdeskError).message).toBe("sevdesk did not answer within 250 ms.");
  });

  it("is retried for GET", async () => {
    requests = 0;
    const { sevdesk, sleeps } = client(2);
    const get = sevdesk.api.GET as unknown as UntypedGet;

    await expect(sevdesk.call(get("/stall-once"))).resolves.toEqual({ objects: [] });
    expect(requests).toBe(2);
    expect(sleeps).toHaveLength(1);
  });
});

describe("body larger than the byte limit", () => {
  it("stops reading and frees the connection instead of buffering it all", async () => {
    const sevdesk = createSevdeskClient({
      baseUrl,
      token: TEST_TOKEN,
      timeoutMs: 5000,
      maxResponseBytes: 64 * 1024,
      retry: { maxRetries: 2 },
      sleep: async () => {},
    });
    const get = sevdesk.api.GET as unknown as UntypedGet;
    requests = 0;

    const error = await sevdesk.call(get("/endless")).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(SevdeskError);
    expect((error as SevdeskError).kind).toBe("response_too_large");
    expect(requests).toBe(1);
    await expect.poll(() => endlessClosed).toBe(true);
    expect(endlessBytes).toBeLessThan(10 * 1024 * 1024);
  });
});
