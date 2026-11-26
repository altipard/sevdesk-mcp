import { connect } from "node:net";
import { describe, expect, it } from "vitest";
import { HTTP_MAX_REQUEST_BODY_BYTES } from "../../src/http/app.js";
import {
  HTTP_HEADERS_TIMEOUT_MS,
  HTTP_KEEP_ALIVE_TIMEOUT_MS,
  HTTP_REQUEST_TIMEOUT_MS,
  LARGE_BODY_BYTES,
  MAX_CONCURRENT_LARGE_BODIES,
} from "../../src/http/start.js";
import { httpFixture, READ, signToken, type TestServer } from "./support.js";

// The real listener over a raw socket: what an HTTP client library would
// normalise away (methods, duplicate headers, odd paths, chunked bodies,
// Expect: 100-continue) reaches the server exactly as written here.

const fx = httpFixture();
const TOOLS_LIST = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} });

interface RawAnswer {
  /** Everything the server wrote, as text. */
  text: string;
  status: number;
  headers: Record<string, string>;
  /** The server closed the connection. */
  closed: boolean;
}

function parse(text: string, closed: boolean): RawAnswer {
  // Skip interim 1xx answers to find the final one.
  const blocks = text.split("\r\n\r\n");
  const head = blocks.find((block) => /^HTTP\/1\.1 [2-5]\d\d/.test(block)) ?? "";
  const [statusLine = "", ...lines] = head.split("\r\n");
  const headers: Record<string, string> = {};
  for (const line of lines) {
    const at = line.indexOf(":");
    if (at > 0) headers[line.slice(0, at).toLowerCase()] = line.slice(at + 1).trim();
  }
  return { text, status: Number(statusLine.split(" ")[1] ?? 0), headers, closed };
}

/**
 * Writes `head` (and `body` chunks), then waits until the server closes or
 * `waitMs` passed. The socket is destroyed afterwards either way.
 */
function raw(
  server: TestServer,
  head: string,
  options: { body?: string | Buffer; waitMs?: number; keepSending?: boolean } = {},
): Promise<RawAnswer> {
  return new Promise((resolve) => {
    const socket = connect(server.port, "127.0.0.1");
    let text = "";
    let done = false;
    const finish = (closed: boolean) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      socket.destroy();
      resolve(parse(text, closed));
    };
    const timer = setTimeout(() => finish(false), options.waitMs ?? 2000);
    socket.on("data", (chunk) => {
      text += chunk.toString("latin1");
    });
    socket.on("end", () => finish(true));
    socket.on("close", () => finish(true));
    socket.on("error", () => finish(true));
    socket.write(head);
    if (options.body !== undefined) socket.write(options.body);
  });
}

const request = (
  server: TestServer,
  method: string,
  path: string,
  headers: Record<string, string> = {},
) =>
  `${method} ${path} HTTP/1.1\r\n` +
  Object.entries({ host: server.resourceUrl.host, ...headers })
    .map(([name, value]) => `${name}: ${value}\r\n`)
    .join("") +
  "\r\n";

/** The status app.fetch gives the same request without the listener and its screening. */
async function directStatus(
  server: TestServer,
  method: string,
  path: string,
  headers: Record<string, string> = {},
): Promise<number> {
  const response = await server.app.fetch(
    new Request(`http://${server.resourceUrl.host}${path}`, {
      method,
      headers: { host: server.resourceUrl.host, ...headers },
      ...(method === "POST" && { body: TOOLS_LIST }),
    }),
  );
  await response.body?.cancel();
  return response.status;
}

describe("listener and screening agree (raw socket)", () => {
  it.each([
    ["HEAD", "/mcp", false],
    ["OPTIONS", "/mcp", false],
    ["HEAD", "/mcp", true],
    ["OPTIONS", "/mcp", true],
    ["POST", "//mcp", true],
    ["POST", "/mcp/", true],
    ["POST", "/mcp%2F", true],
    ["POST", "/%2Fmcp", true],
    ["GET", "/healthz", false],
    ["HEAD", "/.well-known/oauth-protected-resource", false],
  ] as const)("%s %s (token: %s)", async (method, path, withToken) => {
    const server = await fx.server();
    const token = await signToken(fx.iss, server.resourceUrl.href, { scope: READ });
    const headers: Record<string, string> = {
      accept: "application/json, text/event-stream",
      "content-type": "application/json",
      connection: "close",
      ...(withToken && { authorization: `Bearer ${token}` }),
    };
    const body = method === "POST" ? TOOLS_LIST : undefined;
    const answer = await raw(
      server,
      request(server, method, path, {
        ...headers,
        ...(body && { "content-length": String(Buffer.byteLength(body)) }),
      }),
      body === undefined ? {} : { body },
    );
    expect(answer.status).toBeGreaterThan(0);
    expect(answer.status).toBe(await directStatus(server, method, path, headers));
    if (path !== "/mcp" && path !== "/healthz" && !path.startsWith("/.well-known")) {
      expect(answer.status).toBe(404);
    }
  });

  it("refuses a request with two Host headers", async () => {
    const server = await fx.server();
    const answer = await raw(
      server,
      `GET /healthz HTTP/1.1\r\nhost: ${server.resourceUrl.host}\r\nhost: evil.example\r\nconnection: close\r\n\r\n`,
    );
    expect(answer.status).toBe(400);
  });

  it.each(["TRACE", "TRACK", "PROPFIND", "PUT", "FOO", "CONNECT"])(
    "answers %s with 405 and no error log",
    async (method) => {
      const server = await fx.server();
      const target = method === "CONNECT" ? server.resourceUrl.host : "/mcp";
      const answer = await raw(server, request(server, method, target, { connection: "close" }));
      expect(answer.status).toBe(405);
      expect(answer.headers.allow).toBe("GET, HEAD, POST, DELETE, OPTIONS");
      expect(server.logLines.filter((line) => line.includes('"level":"error"'))).toEqual([]);
    },
  );
});

describe("bodies the screening refuses", () => {
  it("closes the connection after refusing a request whose body is still coming", async () => {
    const server = await fx.server();
    const answer = await raw(
      server,
      request(server, "POST", "/mcp", { "content-length": String(HTTP_MAX_REQUEST_BODY_BYTES) }),
      { body: Buffer.alloc(1024, 0x20), waitMs: 3000 },
    );
    expect(answer.status).toBe(401);
    expect(answer.headers.connection).toBe("close");
    expect(answer.closed).toBe(true);
  });

  it("sends no 100 Continue before refusing, and one after admitting", async () => {
    const server = await fx.server();
    const refused = await raw(
      server,
      request(server, "POST", "/mcp", {
        "content-length": String(TOOLS_LIST.length),
        expect: "100-continue",
        authorization: "Bearer not-a-jwt",
      }),
      { waitMs: 3000 },
    );
    expect(refused.status).toBe(401);
    expect(refused.text).not.toContain("100 Continue");
    expect(refused.closed).toBe(true);

    const token = await signToken(fx.iss, server.resourceUrl.href, { scope: READ });
    const admitted = await new Promise<RawAnswer>((resolve) => {
      const socket = connect(server.port, "127.0.0.1");
      let text = "";
      socket.on("data", (chunk) => {
        text += chunk.toString("latin1");
        // Send the body only once the server asked for it.
        if (text.includes("100 Continue") && !text.includes("tools")) socket.write(TOOLS_LIST);
        if (/HTTP\/1\.1 200/.test(text) && text.includes('"tools"')) {
          socket.destroy();
          resolve(parse(text, false));
        }
      });
      socket.write(
        request(server, "POST", "/mcp", {
          "content-length": String(TOOLS_LIST.length),
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
          expect: "100-continue",
          authorization: `Bearer ${token}`,
        }),
      );
    });
    expect(admitted.text.startsWith("HTTP/1.1 100 Continue")).toBe(true);
    expect(admitted.status).toBe(200);
  });

  it("handles chunked bodies without Content-Length: 401, 200 and 413", async () => {
    const server = await fx.server();
    const chunked = (data: string | Buffer) => {
      const bytes = Buffer.isBuffer(data) ? data : Buffer.from(data);
      return Buffer.concat([
        Buffer.from(`${bytes.length.toString(16)}\r\n`),
        bytes,
        Buffer.from("\r\n"),
      ]);
    };
    const headers = {
      "transfer-encoding": "chunked",
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
    };
    const refused = await raw(server, request(server, "POST", "/mcp", headers), {
      body: chunked("{"),
      waitMs: 3000,
    });
    expect(refused.status).toBe(401);
    expect(refused.closed).toBe(true);

    const token = await signToken(fx.iss, server.resourceUrl.href, { scope: READ });
    const authorized = { ...headers, authorization: `Bearer ${token}` };
    const ok = await raw(
      server,
      request(server, "POST", "/mcp", { ...authorized, connection: "close" }),
      {
        body: Buffer.concat([chunked(TOOLS_LIST), Buffer.from("0\r\n\r\n")]),
        waitMs: 3000,
      },
    );
    expect(ok.status).toBe(200);
    expect(ok.text).toContain('"tools"');

    const tooLarge = await raw(server, request(server, "POST", "/mcp", authorized), {
      body: chunked(Buffer.alloc(HTTP_MAX_REQUEST_BODY_BYTES + 1, 0x20)),
      waitMs: 10_000,
    });
    expect(tooLarge.status).toBe(413);
  }, 20_000);
});

describe("limits of the listener", () => {
  it("sets explicit timeouts", async () => {
    const server = await fx.server();
    expect(server.server.headersTimeout).toBe(HTTP_HEADERS_TIMEOUT_MS);
    expect(server.server.requestTimeout).toBe(HTTP_REQUEST_TIMEOUT_MS);
    expect(server.server.keepAliveTimeout).toBe(HTTP_KEEP_ALIVE_TIMEOUT_MS);
    expect(HTTP_HEADERS_TIMEOUT_MS).toBeLessThan(HTTP_REQUEST_TIMEOUT_MS);
  });

  it("answers 408 when headers or the body do not arrive in time", async () => {
    const server = await fx.server({}, { timeouts: { headersMs: 300, requestMs: 600 } });
    const started = Date.now();
    const headersMissing = await raw(server, "POST /mcp HTTP/1.1\r\nhost: x\r\n", { waitMs: 5000 });
    expect(headersMissing.status).toBe(408);
    expect(headersMissing.closed).toBe(true);
    expect(Date.now() - started).toBeLessThan(4000);

    const token = await signToken(fx.iss, server.resourceUrl.href, { scope: READ });
    const bodyMissing = await raw(
      server,
      request(server, "POST", "/mcp", {
        "content-length": "1000",
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        authorization: `Bearer ${token}`,
      }),
      { body: "{", waitMs: 5000 },
    );
    expect(bodyMissing.status).toBe(408);
    expect(bodyMissing.closed).toBe(true);
  }, 15_000);

  it(`admits at most ${MAX_CONCURRENT_LARGE_BODIES} large bodies at once`, async () => {
    const server = await fx.server();
    const token = await signToken(fx.iss, server.resourceUrl.href, { scope: READ });
    const sockets = [];
    const head = request(server, "POST", "/mcp", {
      "content-length": String(LARGE_BODY_BYTES + 1),
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      authorization: `Bearer ${token}`,
    });
    try {
      // Admitted ones wait for the rest of their body.
      for (let i = 0; i < MAX_CONCURRENT_LARGE_BODIES; i++) {
        const socket = connect(server.port, "127.0.0.1");
        sockets.push(socket);
        socket.write(head);
        socket.write("{");
      }
      await new Promise((resolve) => setTimeout(resolve, 300));
      const busy = await raw(server, head, { body: "{", waitMs: 3000 });
      expect(busy.status).toBe(503);
      expect(busy.headers["retry-after"]).toBe("5");
      expect(busy.closed).toBe(true);
    } finally {
      for (const socket of sockets) socket.destroy();
    }
    // Capacity comes back once they are gone; a small body never counts.
    await new Promise((resolve) => setTimeout(resolve, 200));
    const small = await raw(
      server,
      request(server, "POST", "/mcp", {
        "content-length": String(TOOLS_LIST.length),
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        authorization: `Bearer ${token}`,
        connection: "close",
      }),
      { body: TOOLS_LIST },
    );
    expect(small.status).toBe(200);
  });
});
