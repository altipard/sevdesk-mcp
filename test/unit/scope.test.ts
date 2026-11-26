import { describe, expect, it } from "vitest";
import { z } from "zod";
import { silentAuditLog } from "../../src/policy/audit.js";
import {
  defineTool,
  type ToolDefinition,
  ToolDefinitionError,
  withOperations,
} from "../../src/policy/registry.js";
import {
  type ClientScope,
  checkRequest,
  classWithin,
  createScopeGate,
  genericScope,
  scopeProblems,
  toolScope,
} from "../../src/policy/scope.js";
import {
  createSevdeskClient,
  restrictClient,
  type SevdeskClient,
} from "../../src/sevdesk/client.js";
import { DEFAULT_API_ALLOW } from "../../src/tools/generic.js";
import { TOOLS } from "../../src/tools/index.js";
import { captureLogger, MOCK_BASE_URL, TEST_TOKEN } from "../helpers.js";

const BASE = MOCK_BASE_URL;
const url = (path: string) => `${BASE}${path}`;
const readScope: ClientScope = {
  tool: "t",
  class: "R",
  operations: new Set(["getInvoices", "getInvoiceById"]),
};

describe("checkRequest", () => {
  it("allows a declared operation within class and rights", () => {
    expect(checkRequest(readScope, "read", BASE, "GET", url("/Invoice/12"))).toEqual({
      ok: true,
      operationId: "getInvoiceById",
      class: "R",
    });
  });

  it.each([
    ["POST", "/Invoice/Factory/saveInvoice", "class_exceeded"],
    ["GET", "/Export/invoiceCsv", "class_exceeded"],
    ["GET", "/Contact", "not_declared"],
    ["GET", "/Nope", "unmapped"],
    ["PATCH", "/Invoice/1", "unmapped"],
    ["GET", "/Invoice/1;x", "unmapped"],
    ["GET", "/Invoice/%31", "unmapped"],
    ["GET", "/Invoice//1", "unmapped"],
    ["GET", "/Invoice/", "unmapped"],
  ])("refuses %s %s as %s", (method, path, reason) => {
    expect(checkRequest(readScope, "full", BASE, method, url(path))).toMatchObject({
      ok: false,
      reason,
    });
  });

  it.each([
    "https://other.mock/api/v1/Invoice",
    "http://sevdesk.mock/api/v1/Invoice",
    "https://sevdesk.mock/api/v2/Invoice",
    "https://sevdesk.mock/Invoice",
    "https://user:pw@sevdesk.mock/api/v1/Invoice",
    "not a url",
  ])("refuses %s as outside the base URL", (target) => {
    expect(checkRequest(readScope, "full", BASE, "GET", target)).toMatchObject({
      ok: false,
      reason: "outside_base_url",
    });
  });

  it("caps by the effective rights in addition to the class", () => {
    const writeScope: ClientScope = {
      tool: "w",
      class: "W",
      operations: new Set(["createContact"]),
    };
    expect(checkRequest(writeScope, "read", BASE, "POST", url("/Contact"))).toMatchObject({
      ok: false,
      reason: "rights_exceeded",
      operationId: "createContact",
    });
    expect(checkRequest(writeScope, "write", BASE, "POST", url("/Contact")).ok).toBe(true);
  });

  it("matches the method case-insensitively, as openapi-fetch's request() passes it", () => {
    expect(checkRequest(readScope, "read", BASE, "get", url("/Invoice")).ok).toBe(true);
  });
});

describe("classWithin", () => {
  it("orders R < R+ < W < W+ < X", () => {
    expect(classWithin("R", "R")).toBe(true);
    expect(classWithin("R+", "R")).toBe(false);
    expect(classWithin("W", "R+")).toBe(false);
    expect(classWithin("W+", "X")).toBe(true);
  });
});

describe("tool declarations", () => {
  const base = {
    name: "probe",
    title: "probe",
    description: "probe",
    class: "R",
    inputSchema: z.object({}),
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    handler: async () => ({}),
  } as const satisfies Partial<ToolDefinition>;

  it("refuses an operationId above the tool's class", () => {
    expect(() => defineTool({ ...base, operationId: "createContact" })).toThrow(
      /operationId: createContact is class W, above the tool's R/,
    );
  });

  it("refuses extra operations above the class or unclassified", () => {
    const tool = defineTool({ ...base, operationId: "getContacts" });
    expect(() => withOperations(tool, ["exportContact"])).toThrow(ToolDefinitionError);
    expect(() => withOperations(tool, ["dropDatabase" as unknown as "getContacts"])).toThrow(
      /dropDatabase is not a classified sevdesk operation/,
    );
  });

  it("merges extra operations without duplicates", () => {
    const tool = withOperations(defineTool({ ...base, operationId: "getContacts" }), [
      "getContactById",
    ]);
    expect(withOperations(tool, ["getContactById", "getCommunicationWays"]).operations).toEqual([
      "getContactById",
      "getCommunicationWays",
    ]);
  });

  it("declares only operations within each registered tool's class", () => {
    for (const tool of TOOLS) {
      expect(scopeProblems(tool), tool.name).toEqual([]);
      expect(toolScope(tool).operations.size, tool.name).toBeGreaterThan(0);
    }
  });
});

describe("genericScope", () => {
  it("holds exactly the released operations the rights allow", () => {
    const scope = genericScope(
      "g",
      ["getInvoices", "createContact", "deleteContact", "x"],
      "write",
    );
    expect([...scope.operations]).toEqual(["getInvoices", "createContact"]);
    expect(scope.class).toBe("W");
  });

  it("stays at R for the default allowlist", () => {
    const scope = genericScope("g", DEFAULT_API_ALLOW, "full");
    expect(scope.class).toBe("R");
    expect(scope.operations.size).toBe(DEFAULT_API_ALLOW.length);
  });
});

describe("restrictClient", () => {
  const gate = (scope: ClientScope) =>
    createScopeGate({
      scope,
      rights: "full",
      baseUrl: BASE,
      subject: "stdio",
      audit: silentAuditLog,
      logger: captureLogger().logger,
    });

  it("refuses clients it did not build instead of passing them on unchecked", () => {
    const foreign = {
      api: {},
      apiSingleAttempt: {},
      call: async () => ({}),
    } as unknown as SevdeskClient;
    expect(() => restrictClient(foreign, gate(readScope))).toThrow(TypeError);
  });

  it("only narrows: a restricted client restricted again keeps its first scope", async () => {
    const wide: ClientScope = { tool: "wide", class: "X", operations: new Set(["getContacts"]) };
    const narrow = restrictClient(
      createSevdeskClient({ baseUrl: BASE, token: TEST_TOKEN }),
      gate(readScope),
    );
    const again = restrictClient(narrow, gate(wide));
    await expect(again.call(again.api.GET("/Contact"))).rejects.toMatchObject({
      kind: "policy",
      message: expect.stringContaining("t may not call"),
    });
  });

  it("does not let callers swap the openapi-fetch methods", () => {
    const client = createSevdeskClient({ baseUrl: BASE, token: TEST_TOKEN });
    expect(Object.isFrozen(client)).toBe(true);
    expect(Object.isFrozen(client.api)).toBe(true);
  });
});
