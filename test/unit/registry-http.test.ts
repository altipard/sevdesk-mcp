import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { type AuthInfo, McpServer, type ScopeChallengeHandler } from "@modelcontextprotocol/server";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import type { Mode } from "../../src/config.js";
import {
  argumentScopeChallenge,
  scopeChallengeFor,
  scopesFor,
} from "../../src/http/scope-challenge.js";
import type { OperationClass } from "../../src/policy/classification.js";
import { defineTool, registerTools, type ToolDefinition } from "../../src/policy/registry.js";
import type { Rights } from "../../src/policy/rights.js";
import { createPolicyRuntime, requestPolicy } from "../../src/policy/runtime.js";
import { createSevdeskClient } from "../../src/sevdesk/client.js";
import {
  captureLogger,
  MOCK_BASE_URL,
  sharedNonceStore,
  TEST_TOKEN,
  testConfig,
} from "../helpers.js";

const executed: string[] = [];
const rw = {
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: false,
  openWorldHint: true,
};

function tool(name: string, cls: OperationClass): ToolDefinition {
  const reading = cls === "R" || cls === "R+";
  return defineTool({
    name,
    title: name,
    description: name,
    class: cls,
    inputSchema: z.object({ id: z.number() }),
    annotations: reading
      ? { ...rw, readOnlyHint: true, idempotentHint: true }
      : { ...rw, destructiveHint: cls === "X" },
    ...(cls === "W+" || cls === "X" ? { preview: async () => ({}) } : {}),
    ...(cls === "X" ? { targetId: (a: { id: number }) => a.id } : {}),
    handler: async () => {
      executed.push(name);
      return { ok: true };
    },
  });
}

const TOOLS = [
  tool("read_it", "R"),
  tool("write_it", "W"),
  tool("confirm_it", "W+"),
  tool("delete_it", "X"),
];

const auth = (scopes: string[]): AuthInfo => ({
  token: "t",
  clientId: "c",
  scopes,
  extra: { sub: "alice" },
});

function build(
  mode: Mode,
  scopes: string[],
  extra: {
    registrationRights?: Rights;
    scopeChallenge?: (d: ToolDefinition) => ScopeChallengeHandler;
  } = {},
) {
  const config = testConfig({ mode, enableTools: ["delete_it"] });
  const runtime = createPolicyRuntime(config, {
    transport: "http",
    secret: Buffer.from("x".repeat(32)),
    nonces: sharedNonceStore(),
  });
  const server = new McpServer({ name: "t", version: "0" }, { capabilities: { tools: {} } });
  const challenges = new Map<string, unknown>();
  const register = server.registerTool.bind(server);
  server.registerTool = ((name: string, config: { scopeChallenge?: unknown }, cb: never) => {
    challenges.set(name, config.scopeChallenge);
    return register(name, config as never, cb);
  }) as typeof server.registerTool;
  const names = registerTools(
    {
      server,
      policy: requestPolicy(config, runtime, auth(scopes)),
      deps: {
        config,
        sevdesk: createSevdeskClient({ baseUrl: MOCK_BASE_URL, token: TEST_TOKEN }),
        logger: captureLogger().logger,
      },
      ...extra,
    },
    TOOLS,
  );
  return { server, names, challenges };
}

describe("registerTools registration hooks", () => {
  it("registers by policy.rights by default (stdio and existing callers unchanged)", () => {
    expect(build("full", ["sevdesk:read"]).names).toEqual(["read_it"]);
  });

  it("registers by registrationRights when given", () => {
    expect(build("full", ["sevdesk:read"], { registrationRights: "full" }).names).toEqual([
      "read_it",
      "write_it",
      "confirm_it",
      "delete_it",
    ]);
  });

  it("never registers above the mode, whatever registrationRights says", () => {
    expect(build("write", ["sevdesk:read"], { registrationRights: "full" }).names).toEqual([
      "read_it",
      "write_it",
      "confirm_it",
    ]);
    expect(build("read", [], { registrationRights: "full" }).names).toEqual(["read_it"]);
  });

  it("attaches the scope challenge per tool, and none without the hook", () => {
    const withHook = build("full", ["sevdesk:read"], {
      registrationRights: "full",
      scopeChallenge: (d) => scopeChallengeFor(d.class),
    });
    for (const name of withHook.names)
      expect(typeof withHook.challenges.get(name)).toBe("function");
    const without = build("full", ["sevdesk:read"], { registrationRights: "full" });
    for (const name of without.names) expect(without.challenges.get(name)).toBeUndefined();
  });

  it("still denies in the handler when no transport challenge ran (defense in depth)", async () => {
    executed.length = 0;
    // Registered for the mode, but the token only reads, and the in-memory
    // request carries no HTTP authInfo at all.
    const { server } = build("full", ["sevdesk:read"], { registrationRights: "full" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const handle = serveStdio(() => server, { transport: serverTransport });
    const client = new Client({ name: "t", version: "0" });
    await client.connect(clientTransport);
    try {
      const result = await client.callTool({ name: "write_it", arguments: { id: 1 } });
      expect(result.isError).toBe(true);
      expect(executed).toEqual([]);
    } finally {
      await client.close();
      await handle.close();
    }
  });
});

describe("scope challenges", () => {
  const call = (name: string, args: unknown) => ({
    jsonrpc: "2.0" as const,
    id: 1,
    method: "tools/call",
    params: { name, arguments: args },
  });

  it("name the whole scope ladder for the class", () => {
    expect(scopesFor("none")).toEqual(["sevdesk:read"]);
    expect(scopesFor("read")).toEqual(["sevdesk:read"]);
    expect(scopesFor("write")).toEqual(["sevdesk:read", "sevdesk:write"]);
    expect(scopesFor("full")).toEqual(["sevdesk:read", "sevdesk:write", "sevdesk:irreversible"]);
  });

  it.each([
    ["R", ["sevdesk:read"], undefined],
    ["W", ["sevdesk:read"], ["sevdesk:read", "sevdesk:write"]],
    ["W+", ["sevdesk:read", "sevdesk:write"], undefined],
    [
      "X",
      ["sevdesk:read", "sevdesk:write"],
      ["sevdesk:read", "sevdesk:write", "sevdesk:irreversible"],
    ],
    [
      "X",
      ["sevdesk:write", "sevdesk:irreversible"],
      ["sevdesk:read", "sevdesk:write", "sevdesk:irreversible"],
    ],
  ] as const)("class %s with %j challenges %j", async (cls, scopes, expected) => {
    const challenge = await scopeChallengeFor(cls)({
      request: call("t", {}),
      authInfo: auth([...scopes]),
    });
    expect(challenge?.scopes).toEqual(expected);
  });

  it("derives the class from the arguments and stays silent when no step-up helps", async () => {
    const seen: unknown[] = [];
    const handler = argumentScopeChallenge((args) => {
      seen.push(args);
      return args.op === "w" ? "W" : undefined;
    });
    const reader = auth(["sevdesk:read"]);
    expect((await handler({ request: call("g", { op: "w" }), authInfo: reader }))?.scopes).toEqual([
      "sevdesk:read",
      "sevdesk:write",
    ]);
    expect(await handler({ request: call("g", { op: "x" }), authInfo: reader })).toBeUndefined();
    expect(
      await handler({ request: call("g", "not an object"), authInfo: reader }),
    ).toBeUndefined();
    expect(await handler({ request: call("g", ["w"]), authInfo: reader })).toBeUndefined();
    expect(seen.slice(2)).toEqual([{}, {}]);
  });
});
