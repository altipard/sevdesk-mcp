import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { HttpResponse, http } from "msw";
import { setupServer } from "msw/node";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import type { Config } from "../../src/config.js";
import { createAuditLog } from "../../src/policy/audit.js";
import { createPolicyRuntime } from "../../src/policy/runtime.js";
import { createServer } from "../../src/server.js";
import { createSevdeskClient } from "../../src/sevdesk/client.js";
import { captureLogger, MOCK_BASE_URL, TEST_TOKEN, testConfig } from "../helpers.js";

const api = setupServer();
const seen: Request[] = [];
beforeAll(() => {
  api.listen({ onUnhandledFrame: "error" });
  api.events.on("request:start", ({ request }) => {
    seen.push(request.clone());
  });
});
afterEach(() => {
  api.resetHandlers();
  seen.length = 0;
});
afterAll(() => api.close());

async function connect(overrides: Partial<Config> = {}, answer?: "accept" | "decline") {
  const config = testConfig(overrides);
  const auditLines: string[] = [];
  const { logger } = captureLogger();
  const runtime = createPolicyRuntime(config, {
    transport: "stdio",
    secret: Buffer.from("z".repeat(32)),
    audit: createAuditLog({ write: (l) => auditLines.push(l) }),
  });
  const sevdesk = createSevdeskClient({
    baseUrl: MOCK_BASE_URL,
    token: TEST_TOKEN,
    logger,
    sleep: async () => {},
  });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const handle = serveStdio(() => createServer(config, { logger, sevdesk, runtime }), {
    transport: serverTransport,
  });
  const client = new Client(
    { name: "generic-test", version: "0" },
    { capabilities: answer ? { elicitation: { form: {} } } : {} },
  );
  if (answer) {
    client.setRequestHandler("elicitation/create", async () =>
      answer === "accept"
        ? { action: "accept", content: { confirm: true } }
        : { action: "decline" },
    );
  }
  await client.connect(clientTransport);
  return {
    client,
    audit: () => auditLines.map((l) => JSON.parse(l) as Record<string, unknown>),
    close: async () => {
      await client.close();
      await handle.close();
    },
  };
}

type Conn = Awaited<ReturnType<typeof connect>>;
const conns: Conn[] = [];
afterEach(async () => {
  for (const c of conns.splice(0)) await c.close();
});
async function open(overrides: Partial<Config> = {}, answer?: "accept" | "decline") {
  const c = await connect(overrides, answer);
  conns.push(c);
  return c;
}

const call = (c: Conn, args: Record<string, unknown>) =>
  c.client.callTool({ name: "sevdesk_api_request", arguments: args });
const text = (r: Awaited<ReturnType<typeof call>>) =>
  (r.content as Array<{ text?: string }>).map((x) => x.text ?? "").join("\n");
const body = (r: Awaited<ReturnType<typeof call>>) =>
  r.structuredContent as Record<string, unknown>;

async function operationIds(c: Conn): Promise<string[]> {
  const { tools } = await c.client.listTools();
  const tool = tools.find((t) => t.name === "sevdesk_api_request");
  return (tool?.inputSchema.properties?.operationId as { enum?: string[] } | undefined)?.enum ?? [];
}

describe("sevdesk_api_request allowlist", () => {
  it("offers the curated read list by default, read-only", async () => {
    const c = await open();
    const ids = await operationIds(c);
    expect(ids).toContain("getInvoices");
    expect(ids).not.toContain("invoiceGetPdf");
    expect(ids).not.toContain("exportContact");
    expect(ids).not.toContain("createContact");
    const { tools } = await c.client.listTools();
    expect(tools.find((t) => t.name === "sevdesk_api_request")?.annotations).toMatchObject({
      readOnlyHint: true,
      destructiveHint: false,
    });
  });

  it("refuses an operation outside the allowlist", async () => {
    const c = await open({ mode: "full" });
    const result = await call(c, { operationId: "deleteContact", params: { contactId: 1 } });
    expect(result.isError).toBe(true);
    expect(seen).toEqual([]);
  });

  it("offers only operations within the rights, even if listed", async () => {
    const c = await open({
      mode: "read",
      apiAllow: ["getContacts", "createContact", "deleteContact"],
    });
    expect(await operationIds(c)).toEqual(["getContacts"]);
  });

  it("is not registered when nothing usable is listed or it is denied", async () => {
    const none = await open({ mode: "read", apiAllow: ["createContact"] });
    expect((await none.client.listTools()).tools.map((t) => t.name)).toEqual(["get_account_info"]);
    const denied = await open({ deniedTools: ["sevdesk_api_request"] });
    expect((await denied.client.listTools()).tools.map((t) => t.name)).toEqual([
      "get_account_info",
    ]);
  });
});

describe("sevdesk_api_request requests", () => {
  it("builds the URL from the spec and returns the data", async () => {
    api.use(
      http.get(`${MOCK_BASE_URL}/Invoice`, () => HttpResponse.json({ objects: [{ id: "1" }] })),
    );
    const c = await open();
    const result = await call(c, { operationId: "getInvoices", params: { status: 200 } });
    expect(result.isError).toBeFalsy();
    expect(body(result)).toEqual({
      operationId: "getInvoices",
      appliedDefaults: { limit: 50 },
      data: { objects: [{ id: "1" }] },
    });
    expect(seen.map((r) => r.url)).toEqual([`${MOCK_BASE_URL}/Invoice?status=200&limit=50`]);
    expect(seen[0]?.headers.get("authorization")).toBe(TEST_TOKEN);
    expect(c.audit()).toEqual([]);
  });

  it("rejects injection attempts before any request", async () => {
    const c = await open();
    for (const params of [
      { invoiceId: "../../SevUser" },
      { invoiceId: "1?x=1" },
      { invoiceId: 1, "embed&admin": "1" },
    ]) {
      const result = await call(c, { operationId: "getInvoiceById", params });
      expect(result.isError).toBe(true);
    }
    expect(seen).toEqual([]);
  });

  it("enforces preventSendBy=true for an allowed getPdf", async () => {
    api.use(
      http.get(`${MOCK_BASE_URL}/Invoice/9/getPdf`, () => HttpResponse.json({ objects: {} })),
    );
    const c = await open({ apiAllow: ["invoiceGetPdf"] });
    const refused = await call(c, {
      operationId: "invoiceGetPdf",
      params: { invoiceId: 9, preventSendBy: false },
    });
    expect(text(refused)).toContain("preventSendBy is always true");
    expect(seen).toEqual([]);
    await call(c, { operationId: "invoiceGetPdf", params: { invoiceId: 9 } });
    expect(new URL(seen[0]?.url ?? "").searchParams.get("preventSendBy")).toBe("true");
  });

  it("refuses a body for an operation without one", async () => {
    const c = await open();
    const result = await call(c, { operationId: "getTags", body: { a: 1 } });
    expect(text(result)).toContain("takes no request body");
  });

  it("cuts large lists", async () => {
    const objects = Array.from({ length: 2000 }, (_, i) => ({ id: i, name: "n".repeat(80) }));
    api.use(http.get(`${MOCK_BASE_URL}/Contact`, () => HttpResponse.json({ objects })));
    const c = await open();
    const result = await call(c, { operationId: "getContacts", params: { limit: 1000 } });
    expect(body(result).truncated).toBe(true);
    expect(JSON.stringify(result.structuredContent).length).toBeLessThanOrEqual(100_000);
  });
});

describe("sevdesk_api_request class rules", () => {
  it("runs a W operation once, without retries, and audits it", async () => {
    let calls = 0;
    api.use(
      http.get(`${MOCK_BASE_URL}/Export/createDatevCsvZipExportJob`, () => {
        calls++;
        return HttpResponse.json({}, { status: 503 });
      }),
    );
    const c = await open({ mode: "write", apiAllow: ["exportDatevCSV"] });
    const result = await call(c, {
      operationId: "exportDatevCSV",
      params: { startDate: 1, endDate: 2, scope: "E" },
    });
    expect(result.isError).toBe(true);
    expect(calls).toBe(1);
    expect(c.audit()).toEqual([
      expect.objectContaining({
        tool: "sevdesk_api_request",
        operationId: "exportDatevCSV",
        class: "W",
        outcome: "error",
        status: 503,
      }),
    ]);
  });

  it("refuses W bodies that would mark a document as sent or booked", async () => {
    const c = await open({ mode: "write", apiAllow: ["createInvoiceByFactory"] });
    const result = await call(c, {
      operationId: "createInvoiceByFactory",
      body: { invoice: { status: "1000", sendType: "VM" } },
    });
    expect(result.isError).toBe(true);
    expect(text(result)).toContain("invoice.status may only be 100 (draft)");
    expect(seen).toEqual([]);
  });

  it("passes a draft body through", async () => {
    api.use(
      http.post(`${MOCK_BASE_URL}/Invoice/Factory/saveInvoice`, () =>
        HttpResponse.json({ objects: { invoice: { id: "1" } } }),
      ),
    );
    const c = await open({ mode: "write", apiAllow: ["createInvoiceByFactory"] });
    const result = await call(c, {
      operationId: "createInvoiceByFactory",
      body: { invoice: { status: "100" } },
    });
    expect(result.isError).toBeFalsy();
    expect(await seen[0]?.json()).toEqual({ invoice: { status: "100" } });
  });

  it("requires the confirmation token for W+", async () => {
    api.use(
      http.put(`${MOCK_BASE_URL}/Invoice/4/sendBy`, () => HttpResponse.json({ objects: {} })),
    );
    const c = await open({ mode: "write", apiAllow: ["invoiceSendBy"] });
    const args = {
      operationId: "invoiceSendBy",
      params: { invoiceId: 4 },
      body: { sendType: "VPR" },
    };
    const first = await call(c, args);
    expect(body(first)).toMatchObject({
      status: "confirmation_required",
      preview: {
        operationId: "invoiceSendBy",
        method: "PUT",
        path: "/Invoice/4/sendBy",
        class: "W+",
      },
    });
    expect(seen).toEqual([]);

    const tampered = await call(c, {
      ...args,
      body: { sendType: "VM" },
      confirmation_token: body(first).confirmation_token,
    });
    expect(text(tampered)).toContain("different arguments");
    expect(seen).toEqual([]);

    const second = await call(c, { ...args, confirmation_token: body(first).confirmation_token });
    expect(second.isError).toBeFalsy();
    expect(seen).toHaveLength(1);
    expect(await seen[0]?.json()).toEqual({ sendType: "VPR" });
    expect(c.audit().map((e) => [e.outcome, e.targetId])).toEqual([
      ["confirmation_issued", "4"],
      ["denied", "4"],
      ["ok", "4"],
    ]);
  });

  it("asks for approval for X and runs it once", async () => {
    api.use(http.delete(`${MOCK_BASE_URL}/Tag/3`, () => HttpResponse.json({ objects: [null] })));
    const c = await open({ mode: "full", apiAllow: ["deleteTag"] }, "accept");
    const args = { operationId: "deleteTag", params: { tagId: 3 } };
    const first = await call(c, args);
    const token = body(first).confirmation_token;
    const done = await call(c, { ...args, confirmation_token: token });
    expect(done.isError).toBeFalsy();
    const replay = await call(c, { ...args, confirmation_token: token });
    expect(text(replay)).toContain("already used");
    expect(seen).toHaveLength(1);
  });

  it("treats different spellings of the same ID as the same target", async () => {
    api.use(http.delete(`${MOCK_BASE_URL}/Tag/3`, () => HttpResponse.json({ objects: [null] })));
    const c = await open({ mode: "full", apiAllow: ["deleteTag"] });
    const run = async (tagId: unknown) => {
      const args = { operationId: "deleteTag", params: { tagId } };
      const first = await call(c, args);
      return call(c, { ...args, confirmation_token: body(first).confirmation_token });
    };
    expect((await run(3)).isError).toBeFalsy();
    const again = await run("003");
    expect(text(again)).toContain("already ran for this target");
    expect(seen).toHaveLength(1);
    expect(c.audit().at(-1)).toMatchObject({
      outcome: "denied",
      reason: "duplicate",
      targetId: "3",
    });
  });

  it("treats SEVDESK_API_ALLOW as the operator's release for X when the client cannot ask", async () => {
    api.use(http.delete(`${MOCK_BASE_URL}/Tag/3`, () => HttpResponse.json({ objects: [null] })));
    // No elicitation capability and no answer handler: nobody can be asked.
    const c = await open({ mode: "full", apiAllow: ["deleteTag"] });
    const args = { operationId: "deleteTag", params: { tagId: 3 } };
    const first = await call(c, args);
    expect(body(first).status).toBe("confirmation_required");
    expect(seen).toEqual([]);

    const done = await call(c, { ...args, confirmation_token: body(first).confirmation_token });

    expect(done.isError).toBeFalsy();
    expect(body(done)).toMatchObject({ operationId: "deleteTag" });
    expect(seen.map((r) => `${r.method} ${new URL(r.url).pathname}`)).toEqual([
      "DELETE /api/v1/Tag/3",
    ]);
    expect(c.audit().map((e) => e.outcome)).toEqual(["confirmation_issued", "ok"]);
  });

  it("does not run X when the user declines", async () => {
    const c = await open({ mode: "full", apiAllow: ["deleteTag"] }, "decline");
    const args = { operationId: "deleteTag", params: { tagId: 3 } };
    const first = await call(c, args);
    const result = await call(c, { ...args, confirmation_token: body(first).confirmation_token });
    expect(text(result)).toContain("did not approve");
    expect(seen).toEqual([]);
  });

  it("is destructive in its annotations once X operations are listed", async () => {
    const c = await open({ mode: "full", apiAllow: ["getTags", "deleteTag"] });
    const { tools } = await c.client.listTools();
    const tool = tools.find((t) => t.name === "sevdesk_api_request");
    expect(tool?.annotations).toMatchObject({
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
    });
    expect(Object.keys(tool?.inputSchema.properties ?? {})).toContain("confirmation_token");
  });
});
