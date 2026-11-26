import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { McpServer } from "@modelcontextprotocol/server";
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";
import type { Config } from "../../src/config.js";
import { type AuditLog, createAuditLog } from "../../src/policy/audit.js";
import { defineTool, registerTools, type ToolDefinition } from "../../src/policy/registry.js";
import { createPolicyRuntime, requestPolicy } from "../../src/policy/runtime.js";
import { createScopeGate, genericScope } from "../../src/policy/scope.js";
import { createServer } from "../../src/server.js";
import {
  createSevdeskClient,
  restrictClient,
  type SevdeskClient,
} from "../../src/sevdesk/client.js";
import { captureLogger, MOCK_BASE_URL, TEST_TOKEN, testConfig } from "../helpers.js";
import { HttpResponse, http, mockSevdesk, sevdeskUrl, textOf } from "../support/harness.js";

const api = mockSevdesk();

const READ = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: true,
} as const;

type Untyped = (method: string, path: string, init?: Record<string, unknown>) => Promise<never>;
const untyped = (client: SevdeskClient["api"]) => client.request as unknown as Untyped;

/** R tool declared for getInvoices whose handler runs `attempt` against its client. */
function probe(
  name: string,
  attempt: (sevdesk: SevdeskClient) => Promise<unknown>,
  extra: Partial<ToolDefinition> = {},
): ToolDefinition {
  return defineTool({
    name,
    title: name,
    description: `probe ${name}`,
    class: "R",
    operationId: "getInvoices",
    inputSchema: z.object({}),
    annotations: READ,
    handler: async (_args, { sevdesk }) => {
      await sevdesk.call(attempt(sevdesk) as Promise<never>);
      return { done: true };
    },
    ...extra,
  } as ToolDefinition);
}

const PROBES: readonly ToolDefinition[] = [
  probe("post_from_r", (s) =>
    s.api.POST("/Invoice/Factory/saveInvoice", { body: { invoice: {} } as never }),
  ),
  probe("delete_from_r", (s) => untyped(s.apiSingleAttempt)("delete", "/Contact/7")),
  probe("export_from_r", (s) => s.apiSingleAttempt.GET("/Export/contactListCsv" as never)),
  probe("undeclared_read", (s) => s.api.GET("/Contact")),
  probe("unmapped_path", (s) => untyped(s.api)("get", "/Nothing/here")),
  probe("unmapped_put", (s) => untyped(s.api)("put", "/Invoice/1", { body: {} })),
  probe("encoded_path", (s) => untyped(s.api)("get", "/Invoice/1%2FgetPdf")),
  probe("foreign_base_url", (s) =>
    untyped(s.api)("get", "/Invoice", { baseUrl: "https://elsewhere.example/api/v1" }),
  ),
  probe("fetch_override", (s) => untyped(s.api)("get", "/Invoice", { fetch: globalThis.fetch })),
  probe("request_override", (s) =>
    untyped(s.api)("get", "/Invoice", { Request: globalThis.Request }),
  ),
  probe("declared_read", (s) => s.api.GET("/Invoice", { params: { query: { limit: 1 } } })),
  probe("declared_extra", (s) => s.api.GET("/Contact"), { operations: ["getContacts"] }),
];

const open: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const close of open.splice(0)) await close();
});

async function connectServer(server: McpServer): Promise<Client> {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: "scope-test", version: "0.0.0" });
  await client.connect(clientTransport);
  open.push(async () => {
    await client.close();
    await server.close();
  });
  return client;
}

function recordingAudit(): { audit: AuditLog; events: Array<Record<string, unknown>> } {
  const events: Array<Record<string, unknown>> = [];
  return { audit: createAuditLog({ write: (line) => events.push(JSON.parse(line)) }), events };
}

async function harness(options: { audit?: AuditLog; config?: Partial<Config> } = {}) {
  const config = testConfig({ mode: "full", ...options.config });
  const recorded = recordingAudit();
  const runtime = createPolicyRuntime(config, {
    transport: "stdio",
    secret: Buffer.from("s".repeat(32)),
    audit: options.audit ?? recorded.audit,
  });
  const { logger } = captureLogger();
  const sevdesk = createSevdeskClient({ baseUrl: MOCK_BASE_URL, token: TEST_TOKEN });
  const server = new McpServer(
    { name: "scope-test", version: "0" },
    { capabilities: { tools: {} } },
  );
  registerTools(
    {
      server,
      policy: requestPolicy(config, runtime, undefined),
      deps: { config, sevdesk, logger },
    },
    PROBES,
  );
  const client = await connectServer(server);
  return {
    audit: recorded.events,
    call: (name: string) => client.callTool({ name, arguments: {} }),
  };
}

describe("client scope of curated tools", () => {
  it.each([
    ["post_from_r", "createInvoiceByFactory", "class_exceeded"],
    ["delete_from_r", "deleteContact", "class_exceeded"],
    ["export_from_r", "exportContact", "class_exceeded"],
    ["undeclared_read", "getContacts", "not_declared"],
  ])("refuses %s (%s) before the network and audits it", async (tool, operationId, reason) => {
    api.server.use(http.all(sevdeskUrl("/*"), () => HttpResponse.json({ objects: [] })));
    const h = await harness();
    const result = await h.call(tool);
    expect(result.isError).toBe(true);
    expect(api.requests).toEqual([]);
    expect(textOf(result)).toContain(`${tool} may not call sevdesk operation ${operationId}`);
    expect(textOf(result)).toContain("Nothing was sent to sevdesk.");
    expect(h.audit).toEqual([
      expect.objectContaining({
        subject: "stdio",
        tool,
        operationId,
        class: "R",
        outcome: "denied",
        reason: `client_scope:${reason}`,
      }),
    ]);
  });

  it("names the class conflict in the message", async () => {
    const h = await harness();
    const result = await h.call("post_from_r");
    expect(textOf(result)).toBe(
      "post_from_r may not call sevdesk operation createInvoiceByFactory (class W): " +
        "the tool is declared as class R. Nothing was sent to sevdesk.",
    );
  });

  it.each([
    ["unmapped_path", "unmapped"],
    ["unmapped_put", "unmapped"],
    ["encoded_path", "unmapped"],
    ["foreign_base_url", "outside_base_url"],
  ])("refuses %s, which maps to no operation", async (tool, reason) => {
    api.server.use(http.all(sevdeskUrl("/*"), () => HttpResponse.json({ objects: [] })));
    const h = await harness();
    const result = await h.call(tool);
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain(`${tool} may not call this`);
    expect(api.requests).toEqual([]);
    expect(h.audit).toEqual([
      expect.objectContaining({ tool, outcome: "denied", reason: `client_scope:${reason}` }),
    ]);
    expect(h.audit[0]?.operationId).toBeUndefined();
  });

  it.each(["fetch_override", "request_override"])(
    "refuses the per-call option of %s",
    async (tool) => {
      const h = await harness();
      const result = await h.call(tool);
      expect(result.isError).toBe(true);
      expect(textOf(result)).toContain("is not allowed on the sevdesk client");
      expect(api.requests).toEqual([]);
    },
  );

  it.each([
    ["declared_read", "/Invoice"],
    ["declared_extra", "/Contact"],
  ])("lets %s through to sevdesk", async (tool, path) => {
    api.server.use(http.get(sevdeskUrl(path), () => HttpResponse.json({ objects: [] })));
    const h = await harness();
    const result = await h.call(tool);
    expect(result.isError, textOf(result)).toBeFalsy();
    expect(api.requests.map((r) => new URL(r.url).pathname)).toEqual([`/api/v1${path}`]);
    expect(h.audit).toEqual([]);
  });

  it("still refuses when the audit sink fails", async () => {
    const audit: AuditLog = {
      record: () => {
        throw new Error("audit sink down");
      },
    };
    const h = await harness({ audit });
    const result = await h.call("post_from_r");
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("Nothing was sent to sevdesk.");
    expect(api.requests).toEqual([]);
  });
});

describe("client scope of the fallback", () => {
  it("calls released operations through the server", async () => {
    api.server.use(http.get(sevdeskUrl("/Invoice"), () => HttpResponse.json({ objects: [] })));
    const config = testConfig();
    const server = createServer(config, {
      logger: captureLogger().logger,
      runtime: createPolicyRuntime(config, { transport: "stdio" }),
      sevdesk: createSevdeskClient({ baseUrl: MOCK_BASE_URL, token: TEST_TOKEN }),
    });
    const client = await connectServer(server);
    const result = await client.callTool({
      name: "sevdesk_api_request",
      arguments: { operationId: "getInvoices" },
    });
    expect(result.isError, textOf(result)).toBeFalsy();
    expect(api.requests).toHaveLength(1);
  });

  it("runs on a scoped client in the server", async () => {
    // The injected client points elsewhere than the configured base URL,
    // so only a scoped fallback client refuses this call.
    api.server.use(http.get(sevdeskUrl("/Invoice"), () => HttpResponse.json({ objects: [] })));
    const config = testConfig({ baseUrl: "https://configured.mock/api/v1" });
    const { audit, events } = recordingAudit();
    const server = createServer(config, {
      logger: captureLogger().logger,
      runtime: createPolicyRuntime(config, { transport: "stdio", audit }),
      sevdesk: createSevdeskClient({ baseUrl: MOCK_BASE_URL, token: TEST_TOKEN }),
    });
    const client = await connectServer(server);
    const result = await client.callTool({
      name: "sevdesk_api_request",
      arguments: { operationId: "getInvoices" },
    });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("sevdesk_api_request may not call");
    expect(api.requests).toEqual([]);
    expect(events).toEqual([
      expect.objectContaining({
        tool: "sevdesk_api_request",
        outcome: "denied",
        reason: "client_scope:outside_base_url",
      }),
    ]);
  });

  it("keeps its client on the allowlist, below the tool's own checks", async () => {
    // sevdesk_api_request already refuses unreleased operations itself, so
    // this drives the scoped client directly with requests it never builds.
    const { audit, events } = recordingAudit();
    const client = restrictClient(
      createSevdeskClient({ baseUrl: MOCK_BASE_URL, token: TEST_TOKEN }),
      createScopeGate({
        scope: genericScope("sevdesk_api_request", ["getInvoices", "getContactById"], "full"),
        rights: "full",
        baseUrl: MOCK_BASE_URL,
        subject: "stdio",
        audit,
        logger: captureLogger().logger,
      }),
    );
    await expect(client.call(client.api.GET("/Contact"))).rejects.toMatchObject({
      kind: "policy",
      message: expect.stringContaining("not declared for this tool"),
    });
    await expect(
      client.call(
        client.apiSingleAttempt.GET("/Invoice/{invoiceId}/getPdf", {
          params: { path: { invoiceId: 1 } },
        }),
      ),
    ).rejects.toMatchObject({ kind: "policy" });
    expect(api.requests).toEqual([]);
    expect(events.map((event) => [event.operationId, event.reason])).toEqual([
      ["getContacts", "client_scope:not_declared"],
      ["invoiceGetPdf", "client_scope:not_declared"],
    ]);
  });
});
