import { describe, expect, it } from "vitest";
import { classOf } from "../../src/policy/classification.js";
import { OPERATIONS } from "../../src/policy/operations.js";
import {
  buildRequest,
  DEFAULT_API_ALLOW,
  DEFAULT_LIMIT,
  RequestBuildError,
  shapeResponse,
} from "../../src/tools/generic.js";
import { MOCK_BASE_URL } from "../helpers.js";

const build = (id: Parameters<typeof buildRequest>[1], params?: Record<string, unknown>) =>
  buildRequest(MOCK_BASE_URL, id, params);
const rejects = (
  id: Parameters<typeof buildRequest>[1],
  params: Record<string, unknown>,
  message: string | RegExp,
) =>
  expect(() => build(id, params)).toThrow(
    message instanceof RegExp ? message : new RequestBuildError(message),
  );

describe("DEFAULT_API_ALLOW", () => {
  it("contains only side-effect-free reads", () => {
    for (const id of DEFAULT_API_ALLOW) expect(classOf(id), id).toBe("R");
  });

  it("leaves out getPdf, sendByWithRender, Export and Report operations", () => {
    for (const id of DEFAULT_API_ALLOW) {
      const { path } = OPERATIONS[id];
      expect(path, id).not.toMatch(/\/getPdf$|\/sendByWithRender$|^\/Export\/|^\/Report\//);
    }
  });

  it("has no duplicates", () => {
    expect(new Set(DEFAULT_API_ALLOW).size).toBe(DEFAULT_API_ALLOW.length);
  });
});

describe("buildRequest", () => {
  it("fills the path template and encodes the query", () => {
    expect(build("getInvoiceById", { invoiceId: 42, embed: "contact" })).toMatchObject({
      method: "GET",
      path: "/Invoice/42?embed=contact",
      targetId: "42",
    });
    expect(build("getContacts", { customerNumber: "a&b=c #1" }).path).toBe(
      `/Contact?customerNumber=a%26b%3Dc+%231&limit=${DEFAULT_LIMIT}`,
    );
  });

  it("applies the default limit only where limit is declared", () => {
    const list = build("getInvoices");
    expect(list.path).toBe(`/Invoice?limit=${DEFAULT_LIMIT}`);
    expect(list.appliedDefaults).toEqual({ limit: DEFAULT_LIMIT });
    expect(build("getInvoices", { limit: 5 }).appliedDefaults).toEqual({});
    expect(build("getTags").path).toBe("/Tag");
  });

  it("encodes bracketed reference filters", () => {
    expect(
      build("getInvoices", { "contact[id]": 7, "contact[objectName]": "Contact", limit: 1 }).path,
    ).toBe("/Invoice?contact%5Bid%5D=7&contact%5BobjectName%5D=Contact&limit=1");
  });

  it("serialises object parameters as deep objects", () => {
    const { path } = build("reportInvoice", {
      view: "all",
      sevQuery: {
        modelName: "Invoice",
        objectName: "SevQuery",
        filter: { invoiceType: ["RE", "SR"] },
      },
    });
    expect(decodeURIComponent(path)).toBe(
      "/Report/invoicelist?view=all&sevQuery[modelName]=Invoice&sevQuery[objectName]=SevQuery" +
        "&sevQuery[filter][invoiceType][]=RE&sevQuery[filter][invoiceType][]=SR",
    );
  });

  it("joins array parameters with commas", () => {
    expect(
      build("getInvoicePositionsById", { invoiceId: 1, embed: ["part", "unity"], limit: 2 }).path,
    ).toBe("/Invoice/1/getPositions?limit=2&embed=part%2Cunity");
  });

  it.each([
    ["traversal", "../Contact"],
    ["encoded traversal", "%2e%2e"],
    ["a path", "1/../../x"],
    ["an absolute URL", "https://evil.example/"],
    ["a negative id", -1],
    ["a fraction", 1.5],
    ["an object", { id: 1 }],
    ["an empty string", ""],
  ])("rejects %s as integer path parameter", (_label, value) => {
    rejects("getInvoiceById", { invoiceId: value }, "invoiceId must be a non-negative integer");
  });

  it("accepts a digit string as integer id", () => {
    expect(build("getInvoiceById", { invoiceId: "17" }).path).toBe("/Invoice/17");
  });

  it("canonicalises IDs, so different spellings name the same target", () => {
    const spellings = ["042", "42", 42, 42.0, "0042"];
    const built = spellings.map((invoiceId) => build("getInvoiceById", { invoiceId }));
    for (const b of built) {
      expect(b.path).toBe("/Invoice/42");
      expect(b.targetId).toBe("42");
      expect(b.params).toEqual({ invoiceId: 42 });
    }
    expect(build("getInvoiceById", { invoiceId: "0" }).targetId).toBe("0");
  });

  it("rejects decimal spellings of integer IDs", () => {
    rejects("getInvoiceById", { invoiceId: "42.0" }, "invoiceId must be a non-negative integer");
    rejects("getInvoiceById", { invoiceId: "4e1" }, "invoiceId must be a non-negative integer");
  });

  it("canonicalises query numbers and booleans", () => {
    const a = build("getInvoices", { status: "0200", startDate: "0017", limit: "05" });
    const b = build("getInvoices", { status: 200, startDate: 17, limit: 5 });
    expect(a.path).toBe(b.path);
    expect(a.params).toEqual(b.params);
    expect(build("getTransactions", { isBooked: "true" }).params.isBooked).toBe(true);
  });

  it("rejects undeclared parameters, also ones that look like query injection", () => {
    rejects(
      "getInvoiceById",
      { invoiceId: 1, "embed&x": 1 },
      "getInvoiceById has no parameter embed&x",
    );
    rejects("getTags", { url: "https://evil.example" }, "getTags has no parameter url");
  });

  it("rejects missing required parameters", () => {
    rejects("getInvoiceById", {}, "getInvoiceById needs the parameter invoiceId");
    rejects("getBalanceAtDate", { checkAccountId: 1 }, "getBalanceAtDate needs the parameter date");
  });

  it.each([
    ["boolean", "getTransactions", { isBooked: "yes" }, "isBooked must be true or false"],
    ["integer", "getInvoices", { startDate: "yesterday" }, "startDate must be an integer"],
    [
      "string",
      "getContacts",
      { customerNumber: { $ne: 1 } },
      "customerNumber must be a string, number or boolean",
    ],
    ["object", "reportContact", { sevQuery: "x" }, "sevQuery must be an object"],
    [
      "object key",
      "reportContact",
      { sevQuery: { "a]&b": 1 } },
      "sevQuery contains an invalid key: a]&b",
    ],
    [
      "value length",
      "getContacts",
      { customerNumber: "x".repeat(1001) },
      "customerNumber is longer than 1000 characters",
    ],
  ] as const)("type-checks %s parameters", (_label, id, params, message) => {
    rejects(id, params, message);
  });

  it("rejects objects nested too deeply", () => {
    rejects(
      "reportContact",
      { sevQuery: { a: { b: { c: { d: { e: 1 } } } } } },
      "sevQuery is nested too deeply",
    );
  });

  it("always sends preventSendBy=true for getPdf", () => {
    expect(build("invoiceGetPdf", { invoiceId: 3 }).path).toBe(
      "/Invoice/3/getPdf?preventSendBy=true",
    );
    expect(build("invoiceGetPdf", { invoiceId: 3, preventSendBy: true }).path).toBe(
      "/Invoice/3/getPdf?preventSendBy=true",
    );
    rejects(
      "invoiceGetPdf",
      { invoiceId: 3, preventSendBy: false },
      "preventSendBy is always true on this server",
    );
    rejects(
      "orderGetPdf",
      { orderId: 3, preventSendBy: "false" },
      "preventSendBy is always true on this server",
    );
  });

  it("never lets a DATEV export enshrine documents", () => {
    const csv = build("exportDatevCSV", { startDate: 1, endDate: 2, scope: "EXRN" });
    expect(csv.path).not.toContain("enshrine");
    expect(
      build("exportDatevCSV", { startDate: 1, endDate: 2, scope: "E", enshrineDocuments: false })
        .path,
    ).toBe(csv.path.replace("EXRN", "E"));
    rejects(
      "exportDatevCSV",
      { startDate: 1, endDate: 2, scope: "E", enshrineDocuments: true },
      "enshrineDocuments is always false on this server",
    );
    rejects(
      "exportDatevDepricated",
      { startDate: 1, endDate: 2, scope: "E", enshrine: true },
      "enshrine is always false on this server",
    );
  });

  it("keeps the request below the base URL path", () => {
    const base = "https://sevdesk.mock/api/v1";
    const built = buildRequest(base, "getContactById", { contactId: 5 });
    expect(new URL(`${base}${built.path}`).href).toBe("https://sevdesk.mock/api/v1/Contact/5");
  });
});

describe("shapeResponse", () => {
  it("passes small answers through", () => {
    expect(shapeResponse({ objects: [1, 2] })).toEqual({ data: { objects: [1, 2] } });
    expect(shapeResponse(undefined)).toEqual({ data: null });
  });

  it("cuts long lists to what fits and says so", () => {
    const objects = Array.from({ length: 100 }, (_, i) => ({ id: i, text: "x".repeat(50) }));
    const shaped = shapeResponse({ total: "100", objects }, 2000);
    const kept = (shaped.data as { objects: unknown[] }).objects;
    expect(kept.length).toBeGreaterThan(0);
    expect(kept.length).toBeLessThan(100);
    expect(JSON.stringify(shaped).length).toBeLessThanOrEqual(2000);
    expect(shaped.truncated).toBe(true);
    expect(shaped.note).toContain(`Cut to ${kept.length} of 100 objects`);
    expect((shaped.data as { total: string }).total).toBe("100");
  });

  it("drops other oversized answers with a hint", () => {
    const shaped = shapeResponse({ objects: { content: "x".repeat(5000) } }, 1000);
    expect(shaped).toMatchObject({ data: null, truncated: true });
    expect(shaped.note).toContain("more than the 1000 allowed");
  });
});
