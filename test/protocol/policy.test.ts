import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { McpServer } from "@modelcontextprotocol/server";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { type Config, ConfigError } from "../../src/config.js";
import { createAuditLog } from "../../src/policy/audit.js";
import { InMemoryNonceStore, type NonceStore } from "../../src/policy/nonce-store.js";
import { defineTool, registerTools, type ToolDefinition } from "../../src/policy/registry.js";
import {
  createPolicyRuntime,
  type PolicyRuntime,
  requestPolicy,
} from "../../src/policy/runtime.js";
import { createServer } from "../../src/server.js";
import { createSevdeskClient } from "../../src/sevdesk/client.js";
import { SevdeskError } from "../../src/sevdesk/errors.js";
import {
  captureLogger,
  MOCK_BASE_URL,
  sharedNonceStore,
  TEST_TOKEN,
  testConfig,
} from "../helpers.js";
import { READ_TOOLS } from "../support/tool-names.js";

// Test-only tools for the W, W+ and X paths. Production tools of these
// classes do not exist yet; the guard is the same for all of them.

const SECRET = Buffer.from("x".repeat(32));
const executed: Array<{ tool: string; args: unknown }> = [];
let failNext: Error | undefined;

const annotationsFor = {
  W: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  "W+": { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
  X: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
} as const;

function testTool(name: string, cls: "W" | "W+" | "X", extra: Partial<ToolDefinition> = {}) {
  return defineTool({
    name,
    title: name,
    description: `test tool ${name}`,
    class: cls,
    inputSchema: z.object({ invoiceId: z.number().int(), note: z.string().optional() }),
    annotations: annotationsFor[cls],
    targetId: (args) => args.invoiceId,
    summary: (args) => `${name} for invoice ${args.invoiceId}.`,
    ...(cls !== "W" && {
      preview: async (args: { invoiceId: number }) => ({ invoiceId: args.invoiceId, effect: name }),
    }),
    handler: async (args) => {
      if (failNext) {
        const error = failNext;
        failNext = undefined;
        throw error;
      }
      executed.push({ tool: name, args });
      return { done: name, invoiceId: args.invoiceId };
    },
    ...extra,
  } as ToolDefinition);
}

const TEST_TOOLS = [
  testTool("create_draft", "W"),
  testTool("mark_sent", "W+"),
  testTool("send_email", "X"),
];

type Era = "legacy" | "modern";
type Answer = "accept" | "decline" | "cancel" | "accept-false";

interface Harness {
  client: Client;
  audit: Array<Record<string, unknown>>;
  elicitations: string[];
  close: () => Promise<void>;
}

const open: Harness[] = [];
afterEach(async () => {
  executed.length = 0;
  failNext = undefined;
  for (const h of open.splice(0)) await h.close();
});

async function harness(options: {
  config?: Partial<Config>;
  era?: Era;
  answer?: Answer;
  runtime?: PolicyRuntime;
  nonces?: NonceStore;
  now?: () => number;
  tools?: readonly ToolDefinition[];
}): Promise<Harness> {
  // send_email is X and therefore off unless enabled; most tests need it.
  const config = testConfig({ mode: "full", enableTools: ["send_email"], ...options.config });
  const auditLines: string[] = [];
  const runtime =
    options.runtime ??
    createPolicyRuntime(config, {
      transport: "stdio",
      secret: SECRET,
      audit: createAuditLog({ redact: [TEST_TOKEN], write: (line) => auditLines.push(line) }),
      ...(options.nonces && { nonces: options.nonces }),
      ...(options.now && { now: options.now }),
    });
  const { logger } = captureLogger();
  const sevdesk = createSevdeskClient({ baseUrl: MOCK_BASE_URL, token: TEST_TOKEN });
  const build = () => {
    const server = new McpServer(
      { name: "policy-test", version: "0.0.0" },
      { capabilities: { tools: {} } },
    );
    registerTools(
      {
        server,
        policy: requestPolicy(config, runtime, undefined),
        deps: { config, sevdesk, logger },
      },
      options.tools ?? TEST_TOOLS,
    );
    return server;
  };

  const elicitations: string[] = [];
  const client = new Client(
    { name: "policy-test", version: "0.0.0" },
    {
      capabilities: options.answer ? { elicitation: { form: {} } } : {},
      ...(options.era === "modern" && { versionNegotiation: { mode: { pin: "2026-07-28" } } }),
    },
  );
  if (options.answer) {
    const answer = options.answer;
    client.setRequestHandler("elicitation/create", async (request) => {
      elicitations.push(String((request.params as { message?: string }).message));
      if (answer === "accept") return { action: "accept", content: { confirm: true } };
      if (answer === "accept-false") return { action: "accept", content: { confirm: false } };
      return { action: answer };
    });
  }
  // serveStdio over an in-memory wire: the same serving path as
  // production stdio, answering both protocol eras.
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const handle = serveStdio(build, { transport: serverTransport });
  await client.connect(clientTransport);
  const h: Harness = {
    client,
    audit: [],
    elicitations,
    close: async () => {
      await client.close();
      await handle.close();
    },
  };
  Object.defineProperty(h, "audit", {
    get: () => auditLines.map((line) => JSON.parse(line) as Record<string, unknown>),
  });
  open.push(h);
  return h;
}

type ToolResult = Awaited<ReturnType<Client["callTool"]>>;
const text = (result: ToolResult) =>
  (result.content as Array<{ text?: string }>).map((c) => c.text ?? "").join("\n");
const structured = (result: ToolResult) => result.structuredContent as Record<string, unknown>;

async function preview(h: Harness, name: string, args: Record<string, unknown>) {
  const result = await h.client.callTool({ name, arguments: args });
  expect(result.isError).toBeFalsy();
  const body = structured(result);
  expect(body.status).toBe("confirmation_required");
  return body.confirmation_token as string;
}

describe("registration by mode", () => {
  it.each([
    ["read", []],
    ["write", ["create_draft", "mark_sent"]],
    ["full", ["create_draft", "mark_sent", "send_email"]],
  ] as const)("%s mode with send_email enabled registers %j", async (mode, expected) => {
    const h = await harness({ config: { mode } });
    const { tools } = await h.client.listTools();
    expect(tools.map((t) => t.name)).toEqual(expected);
  });

  it("does not register an X tool that SEVDESK_ENABLE_TOOLS does not list", async () => {
    const h = await harness({ config: { mode: "full", enableTools: [] } });
    const { tools } = await h.client.listTools();
    expect(tools.map((t) => t.name)).toEqual(["create_draft", "mark_sent"]);
  });

  it("does not let SEVDESK_ALLOWED_TOOLS switch on an X tool", async () => {
    const h = await harness({
      config: { mode: "full", enableTools: [], allowedTools: ["send_email", "mark_sent"] },
    });
    const { tools } = await h.client.listTools();
    expect(tools.map((t) => t.name)).toEqual(["mark_sent"]);
  });

  it("read mode of the real server registers no writing tools", async () => {
    const config = testConfig({ mode: "read" });
    const server = createServer(config, {
      logger: captureLogger().logger,
      runtime: createPolicyRuntime(config, { transport: "stdio" }),
    });
    const client = new Client({ name: "t", version: "0" });
    const [a, b] = InMemoryTransport.createLinkedPair();
    await server.connect(b);
    await client.connect(a);
    try {
      const { tools } = await client.listTools();
      for (const tool of tools) expect(tool.annotations?.readOnlyHint).toBe(true);
      expect(tools.map((t) => t.name)).toEqual([...READ_TOOLS, "sevdesk_api_request"]);
    } finally {
      await client.close();
      await server.close();
    }
  });

  it("refuses to build a server without a policy runtime", () => {
    const config = testConfig();
    const deps = { logger: captureLogger().logger } as unknown as Parameters<
      typeof createServer
    >[1];
    expect(() => createServer(config, deps)).toThrow("per-process policy runtime");
    expect(() => (createServer as unknown as (c: unknown) => unknown)(config)).toThrow(
      "per-process policy runtime",
    );
  });

  it("adds an optional confirmation_token only to W+ and X tools", async () => {
    const h = await harness({});
    const { tools } = await h.client.listTools();
    const props = (name: string) =>
      Object.keys(tools.find((t) => t.name === name)?.inputSchema.properties ?? {});
    expect(props("create_draft")).not.toContain("confirmation_token");
    expect(props("mark_sent")).toContain("confirmation_token");
    expect(props("send_email")).toContain("confirmation_token");
    expect(tools.find((t) => t.name === "send_email")?.annotations).toEqual(annotationsFor.X);
  });
});

describe("class W", () => {
  it("executes directly and writes an audit event", async () => {
    const h = await harness({});
    const result = await h.client.callTool({ name: "create_draft", arguments: { invoiceId: 7 } });
    expect(structured(result)).toEqual({ done: "create_draft", invoiceId: 7 });
    expect(h.audit).toEqual([
      expect.objectContaining({
        audit: true,
        tool: "create_draft",
        targetId: "7",
        class: "W",
        outcome: "ok",
        subject: "stdio",
      }),
    ]);
  });
});

describe("class W+ confirmation", () => {
  it("returns a preview first and executes only with the token", async () => {
    const h = await harness({});
    const token = await preview(h, "mark_sent", { invoiceId: 1 });
    expect(executed).toEqual([]);

    const result = await h.client.callTool({
      name: "mark_sent",
      arguments: { invoiceId: 1, confirmation_token: token },
    });
    expect(structured(result)).toEqual({ done: "mark_sent", invoiceId: 1 });
    expect(executed).toHaveLength(1);
    expect(h.audit.map((e) => e.outcome)).toEqual(["confirmation_issued", "ok"]);
  });

  it("accepts each token only once", async () => {
    const h = await harness({});
    const token = await preview(h, "mark_sent", { invoiceId: 1 });
    const call = () =>
      h.client.callTool({
        name: "mark_sent",
        arguments: { invoiceId: 1, confirmation_token: token },
      });
    expect((await call()).isError).toBeFalsy();
    const replay = await call();
    expect(replay.isError).toBe(true);
    expect(text(replay)).toContain("already used");
    expect(executed).toHaveLength(1);
    expect(h.audit.at(-1)).toMatchObject({ outcome: "denied", reason: "replay" });
  });

  it("allows a new confirmation for the same target (no idempotency lock for W+)", async () => {
    const h = await harness({});
    for (let i = 0; i < 2; i++) {
      const token = await preview(h, "mark_sent", { invoiceId: 1 });
      const result = await h.client.callTool({
        name: "mark_sent",
        arguments: { invoiceId: 1, confirmation_token: token },
      });
      expect(result.isError).toBeFalsy();
    }
    expect(executed).toHaveLength(2);
  });

  it("fails closed when the nonce store is down", async () => {
    const broken: NonceStore = {
      shared: false,
      consume: () => Promise.reject(new Error("store down")),
      release: () => Promise.resolve(),
    };
    const h = await harness({ nonces: broken });
    const token = await preview(h, "mark_sent", { invoiceId: 1 });
    const result = await h.client.callTool({
      name: "mark_sent",
      arguments: { invoiceId: 1, confirmation_token: token },
    });
    expect(text(result)).toContain("not executed");
    expect(executed).toEqual([]);
  });

  it("binds the token to the arguments", async () => {
    const h = await harness({});
    const token = await preview(h, "mark_sent", { invoiceId: 1 });
    const result = await h.client.callTool({
      name: "mark_sent",
      arguments: { invoiceId: 2, confirmation_token: token },
    });
    expect(result.isError).toBe(true);
    expect(text(result)).toContain("issued for different arguments");
    expect(executed).toEqual([]);
    expect(h.audit.at(-1)).toMatchObject({ outcome: "denied", reason: "wrong_arguments" });
  });

  it("binds the token to the tool", async () => {
    const h = await harness({ answer: "accept" });
    const token = await preview(h, "mark_sent", { invoiceId: 1 });
    const result = await h.client.callTool({
      name: "send_email",
      arguments: { invoiceId: 1, confirmation_token: token },
    });
    expect(text(result)).toContain("issued for a different action");
    expect(executed).toEqual([]);
  });

  it("rejects an expired token", async () => {
    let clock = 1_000_000;
    const h = await harness({ now: () => clock });
    const token = await preview(h, "mark_sent", { invoiceId: 1 });
    clock += 300_001;
    const result = await h.client.callTool({
      name: "mark_sent",
      arguments: { invoiceId: 1, confirmation_token: token },
    });
    expect(text(result)).toContain("has expired");
    expect(executed).toEqual([]);
  });

  it("rejects a manipulated token", async () => {
    const h = await harness({});
    const token = await preview(h, "mark_sent", { invoiceId: 1 });
    const [v, payload, sig] = token.split(".") as [string, string, string];
    const claims = JSON.parse(Buffer.from(payload, "base64url").toString());
    claims.e += 3_600_000;
    const forged = `${v}.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.${sig}`;
    const result = await h.client.callTool({
      name: "mark_sent",
      arguments: { invoiceId: 1, confirmation_token: forged },
    });
    expect(text(result)).toContain("invalid signature");
    expect(executed).toEqual([]);
  });

  it("never writes the token or arguments into the audit log", async () => {
    const h = await harness({});
    const token = await preview(h, "mark_sent", { invoiceId: 1, note: "secret-note" });
    await h.client.callTool({
      name: "mark_sent",
      arguments: { invoiceId: 1, note: "secret-note", confirmation_token: token },
    });
    const raw = JSON.stringify(h.audit);
    expect(raw).not.toContain(token);
    expect(raw).not.toContain(token.split(".")[2]);
    expect(raw).not.toContain("secret-note");
    for (const event of h.audit) {
      expect(Object.keys(event).sort()).toEqual(
        ["audit", "class", "level", "msg", "outcome", "subject", "targetId", "time", "tool"].sort(),
      );
    }
  });
});

describe.each(["legacy", "modern"] as const)("class X over the %s protocol", (era) => {
  it("executes after the user approves the elicitation", async () => {
    const h = await harness({ era, answer: "accept" });
    const token = await preview(h, "send_email", { invoiceId: 5 });
    const result = await h.client.callTool({
      name: "send_email",
      arguments: { invoiceId: 5, confirmation_token: token },
    });
    expect(result.isError).toBeFalsy();
    expect(structured(result)).toEqual({ done: "send_email", invoiceId: 5 });
    expect(h.elicitations).toEqual([
      "send_email for invoice 5. This cannot be undone. Execute it?",
    ]);
    expect(h.audit.map((e) => e.outcome)).toEqual([
      "confirmation_issued",
      "approval_requested",
      "ok",
    ]);
  });

  it.each(["decline", "cancel", "accept-false"] as const)(
    "does not execute when the user answers %s",
    async (answer) => {
      const h = await harness({ era, answer });
      const token = await preview(h, "send_email", { invoiceId: 5 });
      const result = await h.client.callTool({
        name: "send_email",
        arguments: { invoiceId: 5, confirmation_token: token },
      });
      expect(result.isError).toBe(true);
      expect(text(result)).toContain("did not approve");
      expect(executed).toEqual([]);
      expect(h.audit.at(-1)).toMatchObject({ outcome: "declined" });
    },
  );

  it("treats SEVDESK_ENABLE_TOOLS as the release when the client cannot ask", async () => {
    const h = await harness({ era });
    const token = await preview(h, "send_email", { invoiceId: 5 });
    const result = await h.client.callTool({
      name: "send_email",
      arguments: { invoiceId: 5, confirmation_token: token },
    });
    expect(structured(result)).toEqual({ done: "send_email", invoiceId: 5 });
  });
});

describe("class X single use and idempotency", () => {
  const allowed = { enableTools: ["send_email"] };

  it("rejects a replayed token", async () => {
    const h = await harness({ config: allowed });
    const token = await preview(h, "send_email", { invoiceId: 5 });
    const call = () =>
      h.client.callTool({
        name: "send_email",
        arguments: { invoiceId: 5, confirmation_token: token },
      });
    expect((await call()).isError).toBeFalsy();
    const replay = await call();
    expect(replay.isError).toBe(true);
    expect(text(replay)).toContain("already used");
    expect(executed).toHaveLength(1);
    expect(h.audit.at(-1)).toMatchObject({ outcome: "denied", reason: "replay" });
  });

  it("runs an action only once per target, even with a fresh token", async () => {
    const h = await harness({ config: allowed });
    for (const expectError of [false, true]) {
      const token = await preview(h, "send_email", { invoiceId: 5 });
      const result = await h.client.callTool({
        name: "send_email",
        arguments: { invoiceId: 5, confirmation_token: token },
      });
      expect(Boolean(result.isError)).toBe(expectError);
    }
    expect(executed).toHaveLength(1);
    expect(h.audit.at(-1)).toMatchObject({ outcome: "denied", reason: "duplicate" });

    const other = await preview(h, "send_email", { invoiceId: 6 });
    const result = await h.client.callTool({
      name: "send_email",
      arguments: { invoiceId: 6, confirmation_token: other },
    });
    expect(result.isError).toBeFalsy();
  });

  it("frees the target again after sevdesk definitely rejected the action", async () => {
    const h = await harness({ config: allowed });
    failNext = new SevdeskError("validation", "sevdesk could not process the data (422)", {
      status: 422,
    });
    const first = await preview(h, "send_email", { invoiceId: 5 });
    const rejected = await h.client.callTool({
      name: "send_email",
      arguments: { invoiceId: 5, confirmation_token: first },
    });
    expect(rejected.isError).toBe(true);
    expect(h.audit.at(-1)).toMatchObject({ outcome: "error", reason: "validation", status: 422 });

    const second = await preview(h, "send_email", { invoiceId: 5 });
    const retried = await h.client.callTool({
      name: "send_email",
      arguments: { invoiceId: 5, confirmation_token: second },
    });
    expect(retried.isError).toBeFalsy();
  });

  it("keeps the target blocked when the outcome is unknown", async () => {
    const h = await harness({ config: allowed });
    failNext = new SevdeskError("timeout", "sevdesk did not answer. The outcome is unknown.");
    const first = await preview(h, "send_email", { invoiceId: 5 });
    await h.client.callTool({
      name: "send_email",
      arguments: { invoiceId: 5, confirmation_token: first },
    });

    const second = await preview(h, "send_email", { invoiceId: 5 });
    const retried = await h.client.callTool({
      name: "send_email",
      arguments: { invoiceId: 5, confirmation_token: second },
    });
    // Still blocked, but the message must not claim that it ran.
    expect(text(retried)).toContain("may already have run for this target");
    expect(text(retried)).toContain("unknown outcome");
    expect(text(retried)).not.toContain("already ran");
    expect(executed).toEqual([]);
    expect(h.audit.at(-1)).toMatchObject({
      outcome: "denied",
      reason: "duplicate_outcome_unknown",
    });
  });

  it("fails closed when the nonce store is down", async () => {
    const broken: NonceStore = {
      shared: false,
      consume: () => Promise.reject(new Error("store down")),
      release: () => Promise.resolve(),
    };
    const h = await harness({ config: allowed, nonces: broken });
    const token = await preview(h, "send_email", { invoiceId: 5 });
    const result = await h.client.callTool({
      name: "send_email",
      arguments: { invoiceId: 5, confirmation_token: token },
    });
    expect(result.isError).toBe(true);
    expect(text(result)).toContain("not executed");
    expect(executed).toEqual([]);
    expect(h.audit.at(-1)).toMatchObject({ outcome: "denied", reason: "nonce_store_unavailable" });
  });
});

describe("HTTP policy", () => {
  const config = testConfig({ mode: "full" });
  const authInfo = {
    token: "t",
    clientId: "c",
    scopes: ["sevdesk:read", "sevdesk:write"],
    extra: { sub: "alice" },
  };

  it("requires an explicit nonce store", () => {
    expect(() => createPolicyRuntime(config, { transport: "http", secret: SECRET })).toThrow(
      ConfigError,
    );
    expect(() => createPolicyRuntime(config, { transport: "http", secret: SECRET })).toThrow(
      "HTTP transport needs a shared NonceStore",
    );
    expect(() =>
      createPolicyRuntime(config, {
        transport: "http",
        secret: SECRET,
        nonces: new InMemoryNonceStore(),
      }),
    ).toThrow("HTTP transport needs a shared NonceStore");
    expect(() =>
      createPolicyRuntime(config, {
        transport: "http",
        secret: SECRET,
        nonces: sharedNonceStore(),
      }),
    ).not.toThrow();
    expect(() => createPolicyRuntime(config, { transport: "stdio", secret: SECRET })).not.toThrow();
  });

  it("binds tokens to the subject", () => {
    const runtime = createPolicyRuntime(config, {
      transport: "http",
      secret: SECRET,
      nonces: sharedNonceStore(),
    });
    const policy = requestPolicy(config, runtime, authInfo);
    expect(policy.subject).toBe("sub:alice");
    expect(policy.rights).toBe("write");
    const { token } = runtime.signer.issue({
      tool: "mark_sent",
      args: { invoiceId: 1 },
      subject: policy.subject,
    });
    expect(
      runtime.signer.verify(token, {
        tool: "mark_sent",
        args: { invoiceId: 1 },
        subject: "sub:mallory",
      }),
    ).toEqual({ ok: false, reason: "wrong_subject" });
  });

  it("refuses a call that carries no verified token, whatever the server was built for", async () => {
    const auditLines: string[] = [];
    const runtime = createPolicyRuntime(config, {
      transport: "http",
      secret: SECRET,
      nonces: sharedNonceStore(),
      audit: createAuditLog({ write: (line) => auditLines.push(line) }),
    });
    const build = () => {
      const server = new McpServer({ name: "t", version: "0" }, { capabilities: { tools: {} } });
      registerTools(
        {
          server,
          policy: requestPolicy(config, runtime, authInfo),
          deps: {
            config,
            sevdesk: createSevdeskClient({ baseUrl: MOCK_BASE_URL, token: TEST_TOKEN }),
            logger: captureLogger().logger,
          },
        },
        TEST_TOOLS,
      );
      return server;
    };
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const handle = serveStdio(build, { transport: serverTransport });
    const client = new Client({ name: "t", version: "0" });
    await client.connect(clientTransport);
    try {
      // Registered for the token's rights (write), but the in-memory request
      // has no ctx.http.authInfo, so the guard must deny.
      const { tools } = await client.listTools();
      expect(tools.map((t) => t.name)).toEqual(["create_draft", "mark_sent"]);
      const result = await client.callTool({ name: "create_draft", arguments: { invoiceId: 1 } });
      expect(result.isError).toBe(true);
      expect(executed).toEqual([]);
      expect(JSON.parse(auditLines[0] ?? "{}")).toMatchObject({
        outcome: "denied",
        reason: "insufficient_rights",
        subject: "unidentified",
      });
    } finally {
      await client.close();
      await handle.close();
    }
  });
});
