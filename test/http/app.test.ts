import { request } from "node:http";
import { extractWWWAuthenticateParams, UnauthorizedError } from "@modelcontextprotocol/client";
import { describe, expect, it } from "vitest";
import { TEST_TOKEN } from "../helpers.js";
import {
  connectClient,
  ERAS,
  httpFixture,
  makeKey,
  READ,
  READ_WRITE,
  rawPost,
  signToken,
  startIssuer,
  textOf,
  WIRE_VERSION,
} from "./support.js";

const fx = httpFixture();
const now = () => Math.floor(Date.now() / 1000);

function rawStatus(url: URL, host: string): Promise<number> {
  // fetch() drops a custom Host header, so node:http directly.
  return new Promise((resolve, reject) => {
    const req = request(url, { method: "POST", headers: { host } }, (res) => {
      res.resume();
      resolve(res.statusCode ?? 0);
    });
    req.on("error", reject);
    req.end("{}");
  });
}

describe("token validation at the bearer gate", () => {
  it.each(ERAS)("valid token: a tool call succeeds via the MCP client (%s)", async (era) => {
    const server = await fx.server();
    const token = await signToken(fx.iss, server.resourceUrl.href);
    const { client, responses } = await fx.client(server.resourceUrl, token, era);
    const result = await client.callTool({ name: "get_account_info", arguments: {} });
    expect(result.isError).toBeFalsy();
    expect(responses.at(-1)?.protocolVersion).toBe(WIRE_VERSION[era]);
  });

  it("wrong aud, iss, typ, alg, key, expired and garbage tokens: 401", async () => {
    const server = await fx.server();
    const aud = server.resourceUrl.href;
    const es = await makeKey(fx.iss.key.kid, "ES256");
    const tokens = {
      wrongAud: await signToken(fx.iss, "http://127.0.0.1:1/mcp"),
      wrongIssuer: await signToken(fx.iss, aud, { issuer: "http://127.0.0.1:2" }),
      noTyp: await signToken(fx.iss, aud, { typ: null }),
      wrongTyp: await signToken(fx.iss, aud, { typ: "JWT" }),
      wrongAlg: await signToken(fx.iss, aud, { key: es }),
      expired: await signToken(fx.iss, aud, { expiresIn: now() - 120 }),
      wrongKeySameKid: await signToken(fx.iss, aud, { key: await makeKey(fx.iss.key.kid) }),
      wrongKeyOtherKid: await signToken(fx.iss, aud, { key: await makeKey("other") }),
      garbage: "not-a-jwt",
    };
    for (const [name, token] of Object.entries(tokens)) {
      const response = await rawPost(server.resourceUrl, token);
      expect(response.status, name).toBe(401);
      const challenge = extractWWWAuthenticateParams(response);
      expect(challenge.resourceMetadataUrl?.href, name).toBe(server.app.resourceMetadataUrl);
    }
  });

  it("clock skew edges: exp 10 s ago -> 401 (SDK checks strictly), nbf in 10 s ok, nbf in 60 s -> 401", async () => {
    const server = await fx.server();
    const aud = server.resourceUrl.href;
    const expired = await rawPost(
      server.resourceUrl,
      await signToken(fx.iss, aud, { expiresIn: now() - 10 }),
    );
    expect(expired.status).toBe(401);
    const soon = await rawPost(
      server.resourceUrl,
      await signToken(fx.iss, aud, { claims: { nbf: now() + 10 } }),
    );
    expect(soon.status).not.toBe(401);
    expect(soon.status).toBeLessThan(400);
    const later = await rawPost(
      server.resourceUrl,
      await signToken(fx.iss, aud, { claims: { nbf: now() + 60 } }),
    );
    expect(later.status).toBe(401);
  });

  it("the MCP client surfaces a 401 as UnauthorizedError", async () => {
    const server = await fx.server();
    await expect(
      connectClient(server.resourceUrl, await signToken(fx.iss, "http://127.0.0.1:1/mcp")),
    ).rejects.toBeInstanceOf(UnauthorizedError);
  });

  it("missing header: 401 with resource_metadata; discovery leads to the RFC 9728 document", async () => {
    const server = await fx.server();
    const response = await rawPost(server.resourceUrl);
    expect(response.status).toBe(401);
    const challenge = extractWWWAuthenticateParams(response);
    const origin = server.resourceUrl.origin;
    expect(challenge.resourceMetadataUrl?.href).toBe(
      `${origin}/.well-known/oauth-protected-resource/mcp`,
    );

    const metadata = await (await fetch(challenge.resourceMetadataUrl as URL)).json();
    expect(metadata).toEqual({
      resource: server.resourceUrl.href,
      authorization_servers: [fx.iss.issuer],
      scopes_supported: ["sevdesk:read", "sevdesk:write", "sevdesk:irreversible"],
      bearer_methods_supported: ["header"],
      resource_name: "sevdesk-mcp",
    });
    const root = await fetch(`${origin}/.well-known/oauth-protected-resource`);
    expect(root.status).toBe(200);
    expect(await root.json()).toEqual(metadata);
    const post = await fetch(`${origin}/.well-known/oauth-protected-resource/mcp`, {
      method: "POST",
    });
    expect(post.status).toBe(405);
  });

  it("JWKS unreachable: fails closed with 500, not 200", async () => {
    const server = await fx.server({ OAUTH_JWKS_URL: "http://127.0.0.1:1/jwks" });
    const response = await rawPost(
      server.resourceUrl,
      await signToken(fx.iss, server.resourceUrl.href),
    );
    expect(response.status).toBe(500);
    // The bare 500 says nothing; the log names the cause.
    expect(server.logLines.join("")).toContain('"msg":"token verification failed"');
  });

  it("a token from another issuer with its own keys: 401", async () => {
    const other = await startIssuer();
    try {
      const server = await fx.server();
      const token = await signToken(other, server.resourceUrl.href);
      expect((await rawPost(server.resourceUrl, token)).status).toBe(401);
    } finally {
      await other.close();
    }
  });

  it("foreign Host header is refused before auth (DNS rebinding guard); MCP_ALLOWED_HOSTS widens it", async () => {
    const server = await fx.server();
    expect(await rawStatus(server.resourceUrl, "evil.example")).toBe(403);
    expect(await rawStatus(server.resourceUrl, `127.0.0.1:${server.port}`)).toBe(401);

    const proxied = await fx.server({ MCP_ALLOWED_HOSTS: "mcp.example.test, 127.0.0.1" });
    expect(await rawStatus(proxied.resourceUrl, "mcp.example.test")).toBe(401);
    expect(await rawStatus(proxied.resourceUrl, "evil.example")).toBe(403);
  });

  it("only the MCP path, health and metadata exist; AS metadata is not mirrored", async () => {
    const server = await fx.server();
    const origin = server.resourceUrl.origin;
    expect((await fetch(`${origin}/other`)).status).toBe(404);
    expect((await fetch(`${origin}/mcp/other`)).status).toBe(404);
    expect((await fetch(`${origin}/.well-known/oauth-authorization-server`)).status).toBe(404);
    expect((await fetch(`${origin}/.well-known/oauth-protected-resource/other`)).status).toBe(404);
  });

  it("health answers without auth and without the Host check", async () => {
    const server = await fx.server();
    const health = await fetch(`${server.resourceUrl.origin}/healthz`);
    expect(health.status).toBe(200);
    expect(await health.json()).toEqual({ status: "ok" });
    const status = await new Promise<number>((resolve, reject) => {
      const req = request(
        `${server.resourceUrl.origin}/healthz`,
        { headers: { host: "10.0.0.7:3000" } },
        (res) => {
          res.resume();
          resolve(res.statusCode ?? 0);
        },
      );
      req.on("error", reject);
      req.end();
    });
    expect(status).toBe(200);
    expect((await fetch(`${server.resourceUrl.origin}/healthz`, { method: "POST" })).status).toBe(
      405,
    );
  });
});

describe("scopes (the write-only rule)", () => {
  it("gate: a token without sevdesk:read gets 403 insufficient_scope naming sevdesk:read", async () => {
    const server = await fx.server();
    const response = await rawPost(
      server.resourceUrl,
      await signToken(fx.iss, server.resourceUrl.href, { scope: "openid" }),
    );
    expect(response.status).toBe(403);
    const challenge = extractWWWAuthenticateParams(response);
    expect(challenge.error).toBe("insufficient_scope");
    expect(challenge.scope).toBe("sevdesk:read");
    expect(challenge.resourceMetadataUrl).toBeDefined();
  });

  it("a write-only token is refused at the gate with scope=sevdesk:read (no implied read)", async () => {
    const server = await fx.server({ SEVDESK_MODE: "full" });
    const token = await signToken(fx.iss, server.resourceUrl.href, {
      scope: "sevdesk:write sevdesk:irreversible",
    });
    const response = await rawPost(server.resourceUrl, token);
    expect(response.status).toBe(403);
    expect(extractWWWAuthenticateParams(response).scope).toBe("sevdesk:read");
  });
});

describe("no token passthrough", () => {
  it("sevdesk only ever sees the server's API token, never the MCP token", async () => {
    const server = await fx.server();
    const token = await signToken(fx.iss, server.resourceUrl.href);
    const { client } = await fx.client(server.resourceUrl, token);
    await client.callTool({ name: "get_account_info", arguments: {} });
    expect(fx.sevdesk.seen.length).toBeGreaterThan(0);
    for (const seen of fx.sevdesk.seen) {
      expect(seen.headers.authorization).toBe(TEST_TOKEN);
      expect(JSON.stringify(seen)).not.toContain(token);
    }
  });

  it("logs neither the MCP token nor the server's secrets", async () => {
    const server = await fx.server();
    const token = await signToken(fx.iss, server.resourceUrl.href, { scope: READ_WRITE });
    const { client } = await fx.client(server.resourceUrl, token);
    await client.callTool({ name: "get_account_info", arguments: {} });
    await rawPost(server.resourceUrl, "garbage-token-value");
    const log = server.logLines.join("");
    expect(log).toContain('"msg":"http request"');
    expect(log).not.toContain(token);
    expect(log).not.toContain("garbage-token-value");
    expect(log).not.toContain(TEST_TOKEN);
    expect(log).not.toContain("redis-password");
  });
});

describe("read tools on every mode", () => {
  it("a read token sees and calls the read tools", async () => {
    const server = await fx.server({ SEVDESK_MODE: "read" });
    const { client } = await fx.client(
      server.resourceUrl,
      await signToken(fx.iss, server.resourceUrl.href, { scope: READ }),
    );
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name)).toContain("get_account_info");
    expect(textOf(await client.callTool({ name: "get_account_info", arguments: {} }))).toContain(
      "2.0",
    );
  });
});

describe("Origin allowlist on the MCP endpoint", () => {
  it("refuses a browser origin outside the allowed hosts; same host or no Origin passes", async () => {
    const server = await fx.server();
    const token = await signToken(fx.iss, server.resourceUrl.href);
    const post = (origin?: string) =>
      fetch(server.resourceUrl, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
          authorization: `Bearer ${token}`,
          ...(origin && { origin }),
        },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
      });
    expect((await post("https://evil.example")).status).toBe(403);
    expect((await post("null")).status).toBe(403);
    expect((await post(`http://127.0.0.1:${server.port}`)).status).toBe(200);
    expect((await post()).status).toBe(200);
    // Discovery stays reachable from anywhere: it is public metadata.
    const metadata = await fetch(server.app.resourceMetadataUrl, {
      headers: { origin: "https://evil.example" },
    });
    expect(metadata.status).toBe(200);
  });
});

describe("streams end when the token expires", () => {
  it.each(ERAS)(
    "lets a tool call answer run to the end past exp (%s)",
    async (era) => {
      const server = await fx.server();
      const exp = Math.floor(Date.now() / 1000) + 2;
      const token = await signToken(fx.iss, server.resourceUrl.href, { expiresIn: exp });
      const { client } = await fx.client(server.resourceUrl, token, era);
      // sevdesk answers only after the token has expired.
      fx.sevdesk.delayMs = Math.max(0, exp * 1000 - Date.now()) + 500;
      const result = await client.callTool({ name: "get_account_info", arguments: {} });
      expect(Date.now()).toBeGreaterThan(exp * 1000);
      expect(result.isError).toBeFalsy();
      expect(textOf(result)).toContain("2.0");
    },
    10_000,
  );

  it("closes an open subscriptions/listen stream at exp", async () => {
    const server = await fx.server();
    const exp = Math.floor(Date.now() / 1000) + 2;
    const token = await signToken(fx.iss, server.resourceUrl.href, { expiresIn: exp });
    const { client } = await fx.client(server.resourceUrl, token);
    const subscription = await client.listen({ toolsListChanged: true });
    const ended = await Promise.race([
      subscription.closed,
      new Promise((resolve) => setTimeout(() => resolve("still open"), 5000)),
    ]);
    expect(ended).toBe("remote");
    expect(Date.now()).toBeGreaterThanOrEqual(exp * 1000 - 50);
  }, 10_000);
});
