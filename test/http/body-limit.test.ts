import { request } from "node:http";
import { describe, expect, it } from "vitest";
import { HTTP_MAX_REQUEST_BODY_BYTES } from "../../src/http/app.js";
import { MAX_VOUCHER_FILE_BYTES } from "../../src/tools/voucher-writes.js";
import { pdfAtLimit, voucherArguments } from "../support/voucher-upload.js";
import { httpFixture, READ, READ_WRITE, signToken, type TestServer, textOf } from "./support.js";

const fx = httpFixture();

interface RawAnswer {
  status: number;
  /** Bytes of the body written before the answer arrived. */
  sentBeforeAnswer: number;
}

/**
 * POST that declares `declared` bytes but only ever writes the first 64 KiB
 * and keeps the body open: an answer can only arrive if the server decided
 * without reading the body to its end.
 */
function openEndedPost(url: URL, declared: number, token?: string): Promise<RawAnswer> {
  return new Promise((resolve, reject) => {
    let sent = 0;
    const req = request(
      url,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
          "content-length": String(declared),
          ...(token && { authorization: `Bearer ${token}` }),
        },
      },
      (res) => {
        res.resume();
        resolve({ status: res.statusCode ?? 0, sentBeforeAnswer: sent });
        req.destroy();
      },
    );
    req.on("error", (error) => {
      if (!req.destroyed) reject(error);
    });
    const chunk = Buffer.alloc(64 * 1024, 0x20);
    sent += chunk.length;
    req.write(chunk);
  });
}

function mcpRequest(
  server: TestServer,
  init: { token?: string; host?: string; origin?: string; method?: string; path?: string } = {},
) {
  const url = new URL(init.path ?? server.resourceUrl.pathname, server.resourceUrl);
  return new Request(url, {
    method: init.method ?? "POST",
    headers: {
      host: init.host ?? url.host,
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      ...(init.origin && { origin: init.origin }),
      ...(init.token && { authorization: `Bearer ${init.token}` }),
    },
    ...((init.method ?? "POST") === "POST" && {
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
    }),
  });
}

describe("screening before the body is read", () => {
  it("answers every case screen() decides exactly as fetch() does without it", async () => {
    const server = await fx.server();
    const aud = server.resourceUrl.href;
    const cases: Array<[string, Parameters<typeof mcpRequest>[1], number]> = [
      ["health GET", { method: "GET", path: "/healthz" }, 200],
      ["health POST", { path: "/healthz" }, 405],
      ["metadata", { method: "GET", path: "/.well-known/oauth-protected-resource" }, 200],
      ["metadata POST", { path: "/.well-known/oauth-protected-resource" }, 405],
      ["unknown path", { path: "/other", token: await signToken(fx.iss, aud) }, 404],
      ["foreign Host", { host: "evil.example", token: await signToken(fx.iss, aud) }, 403],
      [
        "foreign Origin",
        { origin: "https://evil.example", token: await signToken(fx.iss, aud) },
        403,
      ],
      ["no token", {}, 401],
      ["bad token", { token: "not-a-jwt" }, 401],
      ["wrong audience", { token: await signToken(fx.iss, "http://127.0.0.1:1/mcp") }, 401],
      [
        "write-only token",
        { token: await signToken(fx.iss, aud, { scope: "sevdesk:write" }) },
        403,
      ],
    ];
    for (const [name, init, status] of cases) {
      const screened = await server.app.screen(mcpRequest(server, init));
      expect(screened, name).toBeInstanceOf(Response);
      const direct = await server.app.fetch(mcpRequest(server, init));
      expect((screened as Response).status, name).toBe(status);
      expect(direct.status, name).toBe(status);
      expect((screened as Response).headers.get("www-authenticate"), name).toBe(
        direct.headers.get("www-authenticate"),
      );
    }
    // An authorized request passes the screen with its verified token, and fetch serves it.
    const ok = { token: await signToken(fx.iss, aud, { scope: READ }) };
    const passed = await server.app.screen(mcpRequest(server, ok));
    expect(passed).not.toBeInstanceOf(Response);
    expect(passed).toMatchObject({ scopes: [READ] });
    expect((await server.app.fetch(mcpRequest(server, ok))).status).toBe(200);

    server.app.startDraining();
    const draining = await server.app.screen(mcpRequest(server, ok));
    expect((draining as Response).status).toBe(503);
    expect((await server.app.fetch(mcpRequest(server, ok))).status).toBe(503);
  });

  it("refuses a bad token with 401 without reading a large body", async () => {
    const server = await fx.server();
    const declared = HTTP_MAX_REQUEST_BODY_BYTES;
    for (const token of [undefined, "not-a-jwt"]) {
      const answer = await openEndedPost(server.resourceUrl, declared, token);
      expect(answer.status, String(token)).toBe(401);
      expect(answer.sentBeforeAnswer).toBeLessThan(declared);
    }
    // A foreign Host is refused the same way.
    const foreign = await new Promise<number>((resolve, reject) => {
      const req = request(
        server.resourceUrl,
        { method: "POST", headers: { host: "evil.example", "content-length": String(declared) } },
        (res) => {
          res.resume();
          resolve(res.statusCode ?? 0);
          req.destroy();
        },
      );
      req.on("error", (error) => {
        if (!req.destroyed) reject(error);
      });
      req.write(Buffer.alloc(1024));
    });
    expect(foreign).toBe(403);
  });

  it("refuses an authorized body over the limit with 413 before reading it", async () => {
    const server = await fx.server();
    const token = await signToken(fx.iss, server.resourceUrl.href, { scope: READ_WRITE });
    const answer = await openEndedPost(server.resourceUrl, HTTP_MAX_REQUEST_BODY_BYTES + 1, token);
    expect(answer.status).toBe(413);
  });

  it("takes a voucher file at the limit through the real listener", async () => {
    const server = await fx.server();
    const token = await signToken(fx.iss, server.resourceUrl.href, { scope: READ_WRITE });
    const { client } = await fx.client(server.resourceUrl, token);
    const result = await client.callTool(
      { name: "create_voucher", arguments: voucherArguments(pdfAtLimit()) },
      { timeout: 30_000 },
    );
    expect(result.isError, textOf(result).slice(0, 500)).toBeFalsy();
    expect(result.structuredContent).toMatchObject({ file: { bytes: MAX_VOUCHER_FILE_BYTES } });
    const upload = fx.sevdesk.seen.find((r) => r.url.endsWith("/Voucher/Factory/uploadTempFile"));
    expect(upload?.body.length).toBeGreaterThan(MAX_VOUCHER_FILE_BYTES);
  }, 60_000);
});
