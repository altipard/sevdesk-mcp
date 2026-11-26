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
const open = new Set<ServerResponse>();

beforeAll(async () => {
  server = createServer((req, res) => {
    requests++;
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
