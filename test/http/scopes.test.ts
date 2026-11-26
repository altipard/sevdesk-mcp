import { extractWWWAuthenticateParams, InsufficientScopeError } from "@modelcontextprotocol/client";
import { describe, expect, it } from "vitest";
import {
  ALL_SCOPES,
  ERAS,
  httpFixture,
  READ,
  READ_WRITE,
  rawPost,
  signToken,
  textOf,
  WIRE_VERSION,
} from "./support.js";

// The curated tools are all class R so far; the generic fallback with a
// released operation of each class covers W, W+ and X end to end.
const R_OP = "bookkeepingSystemVersion";
const W_OP = "createContact";
const W_PLUS_OP = "updateCheckAccountTransaction";
const X_OP = "deleteContact";
const API_ALLOW = [R_OP, W_OP, W_PLUS_OP, X_OP].join(",");

const fx = httpFixture();

const createContact = {
  name: "sevdesk_api_request",
  arguments: {
    operationId: W_OP,
    body: { name: "Example GmbH", category: { id: 3, objectName: "Category" } },
  },
};
const deleteContact = {
  name: "sevdesk_api_request",
  arguments: { operationId: X_OP, params: { contactId: 7 } },
};

async function server(mode: "read" | "write" | "full") {
  return fx.server({ SEVDESK_MODE: mode, SEVDESK_API_ALLOW: API_ALLOW });
}

async function token(resourceUrl: URL, scope: string, sub = "user-1") {
  return signToken(fx.iss, resourceUrl.href, { scope, claims: { sub } });
}

/** Outcome of a call: "403 <scope>", "error" (refused by the server) or "ok". */
async function outcome(call: () => Promise<unknown>): Promise<string> {
  try {
    const result = await call();
    return (result as { isError?: boolean }).isError ? "error" : "ok";
  } catch (error) {
    if (error instanceof InsufficientScopeError) return `403 ${error.requiredScope}`;
    return "error";
  }
}

function operationIds(tools: Array<{ name: string; inputSchema: unknown }>): string[] {
  const generic = tools.find((t) => t.name === "sevdesk_api_request");
  const schema = generic?.inputSchema as { properties?: { operationId?: { enum?: string[] } } };
  return [...(schema?.properties?.operationId?.enum ?? [])].sort();
}

describe("registration follows the mode, not the token", () => {
  it.each([
    ["read", [R_OP]],
    ["write", [R_OP, W_OP, W_PLUS_OP]],
    ["full", [R_OP, W_OP, W_PLUS_OP, X_OP]],
  ] as const)(
    "mode %s lists the same tools for a read token and a full token",
    async (mode, ops) => {
      const s = await server(mode);
      for (const scope of [READ, ALL_SCOPES]) {
        const { client } = await fx.client(s.resourceUrl, await token(s.resourceUrl, scope));
        const { tools } = await client.listTools();
        expect(operationIds(tools), `${mode} ${scope}`).toEqual([...ops].sort());
      }
    },
  );
});

describe("missing scope on a call: 403 insufficient_scope naming the scopes", () => {
  it.each(ERAS)("a read token calling a W operation gets 403 for read+write (%s)", async (era) => {
    const s = await server("write");
    const { client, responses } = await fx.client(
      s.resourceUrl,
      await token(s.resourceUrl, READ),
      era,
    );
    const error = await client.callTool(createContact).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(InsufficientScopeError);
    expect((error as InsufficientScopeError).requiredScope).toBe("sevdesk:read sevdesk:write");
    const last = responses.at(-1);
    expect(last?.protocolVersion).toBe(WIRE_VERSION[era]);
    expect(last?.status).toBe(403);
    expect(last?.wwwAuthenticate).toContain('error="insufficient_scope"');
    expect(last?.wwwAuthenticate).toContain("resource_metadata=");
    expect(fx.sevdesk.seen.filter((r) => r.method === "POST")).toEqual([]);
    // Reading keeps working with the same token.
    expect(textOf(await client.callTool({ name: "get_account_info", arguments: {} }))).toContain(
      "2.0",
    );
  });

  it("a raw legacy POST without handshake is behind the same gate and scope challenge", async () => {
    const s = await server("write");
    const call = { jsonrpc: "2.0", id: 7, method: "tools/call", params: createContact };
    expect((await rawPost(s.resourceUrl, undefined, call)).status).toBe(401);
    const denied = await rawPost(s.resourceUrl, await token(s.resourceUrl, READ), call);
    expect(denied.status).toBe(403);
    expect(extractWWWAuthenticateParams(denied).scope).toBe("sevdesk:read sevdesk:write");
  });

  it("an unknown or missing operationId raises no challenge and runs nothing", async () => {
    const s = await server("full");
    const { client, responses } = await fx.client(s.resourceUrl, await token(s.resourceUrl, READ));
    for (const args of [{ operationId: "noSuchOperation" }, {}, { operationId: 42 }]) {
      const result = await outcome(() =>
        client.callTool({ name: "sevdesk_api_request", arguments: args }),
      );
      expect(result, JSON.stringify(args)).toBe("error");
    }
    expect(responses.some((r) => r.status === 403)).toBe(false);
    expect(fx.sevdesk.seen).toEqual([]);
  });
});

describe("effective rights = minimum of SEVDESK_MODE and token scopes", () => {
  // [mode, token scopes, W outcome, X outcome]
  const matrix = [
    ["read", READ, "error", "error"],
    ["read", READ_WRITE, "error", "error"],
    ["read", ALL_SCOPES, "error", "error"],
    ["write", READ, "403 sevdesk:read sevdesk:write", "error"],
    ["write", READ_WRITE, "ok", "error"],
    ["write", ALL_SCOPES, "ok", "error"],
    [
      "full",
      READ,
      "403 sevdesk:read sevdesk:write",
      "403 sevdesk:read sevdesk:write sevdesk:irreversible",
    ],
    ["full", READ_WRITE, "ok", "403 sevdesk:read sevdesk:write sevdesk:irreversible"],
    // X with all scopes passes the challenge and gets the confirmation preview first.
    ["full", ALL_SCOPES, "ok", "ok"],
  ] as const;

  it.each(matrix)("mode %s, scopes %s: W %s, X %s", async (mode, scope, w, x) => {
    const s = await server(mode);
    const { client } = await fx.client(s.resourceUrl, await token(s.resourceUrl, scope));
    expect(await outcome(() => client.callTool(createContact))).toBe(w);
    const posts = fx.sevdesk.seen.filter((r) => r.method === "POST" && r.url.endsWith("/Contact"));
    expect(posts).toHaveLength(w === "ok" ? 1 : 0);

    const xResult = await client.callTool(deleteContact).catch((e: unknown) => e);
    expect(
      await outcome(async () => {
        if (xResult instanceof Error) throw xResult;
        return xResult;
      }),
    ).toBe(x);
    if (x === "ok") expect(textOf(xResult)).toContain("confirmation_required");
    // Nothing irreversible ever runs in this matrix: X stops at the preview.
    expect(fx.sevdesk.seen.filter((r) => r.method === "DELETE")).toEqual([]);
  });
});

describe("the token subject flows into confirmation tokens and the audit trail", () => {
  const update = (confirmation_token?: string) => ({
    name: "sevdesk_api_request",
    arguments: {
      operationId: W_PLUS_OP,
      params: { checkAccountTransactionId: 11 },
      body: { status: 100 },
      ...(confirmation_token && { confirmation_token }),
    },
  });

  it("binds the confirmation to sub, uses the nonce once in Redis and audits the subject", async () => {
    const s = await server("write");
    const alice = await fx.client(s.resourceUrl, await token(s.resourceUrl, READ_WRITE, "alice"));
    const bob = await fx.client(s.resourceUrl, await token(s.resourceUrl, READ_WRITE, "bob"));

    const preview = JSON.parse(textOf(await alice.client.callTool(update())));
    expect(preview.status).toBe("confirmation_required");
    const confirmation = preview.confirmation_token as string;

    const stolen = await bob.client.callTool(update(confirmation));
    expect(stolen.isError).toBe(true);
    expect(textOf(stolen)).toContain("different user");

    const done = await alice.client.callTool(update(confirmation));
    expect(done.isError).toBeFalsy();
    expect(fx.sevdesk.seen.filter((r) => r.method === "PUT")).toHaveLength(1);
    expect(s.redis.keys().some((key) => key.startsWith("sevdesk-mcp:nonce:"))).toBe(true);

    const replay = await alice.client.callTool(update(confirmation));
    expect(replay.isError).toBe(true);
    expect(textOf(replay)).toContain("already used");
    expect(fx.sevdesk.seen.filter((r) => r.method === "PUT")).toHaveLength(1);

    const audit = s.audit();
    expect(audit.map((e) => [e.subject, e.outcome, e.reason])).toEqual([
      ["sub:alice", "confirmation_issued", undefined],
      ["sub:bob", "denied", "wrong_subject"],
      ["sub:alice", "ok", undefined],
      ["sub:alice", "denied", "replay"],
    ]);
  });

  it("fails closed when Redis is unreachable: nothing is executed", async () => {
    const s = await server("write");
    const { client } = await fx.client(s.resourceUrl, await token(s.resourceUrl, READ_WRITE));
    const preview = JSON.parse(textOf(await client.callTool(update())));
    s.redis.isReady = false;
    const result = await client.callTool(update(preview.confirmation_token));
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("replay protection store is unavailable");
    expect(fx.sevdesk.seen.filter((r) => r.method === "PUT")).toEqual([]);
    expect(s.audit().at(-1)).toMatchObject({
      outcome: "denied",
      reason: "nonce_store_unavailable",
    });
  });
});
