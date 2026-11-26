import { HttpResponse, http } from "msw";
import { setupServer } from "msw/node";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { classOf } from "../../src/policy/classification.js";
import {
  BODY_PINS,
  checkBodyPins,
  enforceRequestPins,
  matchOperation,
  PinViolation,
  pinQueryParam,
} from "../../src/policy/pins.js";
import { createSevdeskClient } from "../../src/sevdesk/client.js";
import { SevdeskError } from "../../src/sevdesk/errors.js";
import { MOCK_BASE_URL, TEST_TOKEN } from "../helpers.js";

describe("matchOperation", () => {
  it("prefers literal paths over templates", () => {
    expect(matchOperation("GET", "/Contact/Factory/getNextCustomerNumber")).toBe(
      "getNextCustomerNumber",
    );
    expect(matchOperation("GET", "/Contact/5")).toBe("getContactById");
    expect(matchOperation("get", "/Invoice/7/getPdf")).toBe("invoiceGetPdf");
    expect(matchOperation("PUT", "/Invoice/7/getPdf")).toBeUndefined();
    expect(matchOperation("GET", "/Nope")).toBeUndefined();
  });
});

describe("pinQueryParam", () => {
  it("pins true explicitly and false by omission", () => {
    expect(pinQueryParam("preventSendBy", undefined)).toEqual({ omit: false, value: true });
    expect(pinQueryParam("preventSendBy", "true")).toEqual({ omit: false, value: true });
    expect(pinQueryParam("enshrine", false)).toEqual({ omit: true });
    expect(pinQueryParam("limit", 5)).toBeUndefined();
  });

  it("rejects the other value", () => {
    expect(() => pinQueryParam("preventSendBy", false)).toThrow(PinViolation);
    expect(() => pinQueryParam("enshrineDocuments", "true")).toThrow(
      "enshrineDocuments is always false on this server",
    );
  });
});

describe("enforceRequestPins", () => {
  const req = (path: string, method = "GET") => new Request(`${MOCK_BASE_URL}${path}`, { method });

  it("adds preventSendBy=true to getPdf", async () => {
    const out = await enforceRequestPins(req("/Invoice/1/getPdf?download=true"), MOCK_BASE_URL);
    expect(new URL(out.url).searchParams.get("preventSendBy")).toBe("true");
    expect(new URL(out.url).searchParams.get("download")).toBe("true");
  });

  it("drops enshrine flags set to false and rejects true", async () => {
    const out = await enforceRequestPins(
      req("/Export/createDatevCsvZipExportJob?startDate=1&enshrineDocuments=false"),
      MOCK_BASE_URL,
    );
    expect(new URL(out.url).searchParams.has("enshrineDocuments")).toBe(false);
    await expect(
      enforceRequestPins(req("/Export/datevCSV?enshrine=true"), MOCK_BASE_URL),
    ).rejects.toThrow(PinViolation);
  });

  it("passes requests without pins through untouched", async () => {
    const original = req("/Contact?limit=1");
    expect(await enforceRequestPins(original, MOCK_BASE_URL)).toBe(original);
    const outside = req("/stall");
    expect(await enforceRequestPins(outside, MOCK_BASE_URL)).toBe(outside);
  });
});

describe("pins in the sevdesk client (every call path)", () => {
  const api = setupServer();
  const urls: string[] = [];
  beforeAll(() => {
    api.listen({ onUnhandledFrame: "error" });
    api.events.on("request:start", ({ request }) => {
      urls.push(request.url);
    });
  });
  afterEach(() => {
    api.resetHandlers();
    urls.length = 0;
  });
  afterAll(() => api.close());

  const client = () => createSevdeskClient({ baseUrl: MOCK_BASE_URL, token: TEST_TOKEN });

  it("sends preventSendBy=true even when a caller forgets it", async () => {
    api.use(
      http.get(`${MOCK_BASE_URL}/Invoice/:id/getPdf`, () => HttpResponse.json({ objects: {} })),
    );
    const c = client();
    await c.call(c.api.GET("/Invoice/{invoiceId}/getPdf", { params: { path: { invoiceId: 1 } } }));
    expect(new URL(urls[0] ?? "").searchParams.get("preventSendBy")).toBe("true");
  });

  it("refuses preventSendBy=false before anything is sent", async () => {
    const c = client();
    const error = await c
      .call(
        c.api.GET("/Invoice/{invoiceId}/getPdf", {
          params: { path: { invoiceId: 1 }, query: { preventSendBy: false } },
        }),
      )
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(SevdeskError);
    expect((error as SevdeskError).kind).toBe("policy");
    expect((error as SevdeskError).message).toBe("preventSendBy is always true on this server");
    expect(urls).toEqual([]);
  });
});

describe("body pins", () => {
  it("cover the W operations that can set status or send fields", () => {
    expect(Object.keys(BODY_PINS).sort()).toEqual(
      [
        "createInvoiceByFactory",
        "createOrder",
        "createTransaction",
        "createcreditNote",
        "updateOrder",
        "voucherFactorySaveVoucher",
      ].sort(),
    );
    for (const id of Object.keys(BODY_PINS)) expect(classOf(id), id).toBe("W");
  });

  it("allow drafts and absent fields", () => {
    expect(() =>
      checkBodyPins("createInvoiceByFactory", { invoice: { status: "100" } }),
    ).not.toThrow();
    expect(() =>
      checkBodyPins("createInvoiceByFactory", { invoice: { status: 100, sendDate: null } }),
    ).not.toThrow();
    expect(() => checkBodyPins("createInvoiceByFactory", { invoicePosSave: [] })).not.toThrow();
    expect(() => checkBodyPins("createInvoiceByFactory", undefined)).not.toThrow();
    expect(() =>
      checkBodyPins("voucherFactorySaveVoucher", { voucher: { status: 50 } }),
    ).not.toThrow();
    expect(() => checkBodyPins("createTransaction", { status: 100 })).not.toThrow();
    expect(() => checkBodyPins("getInvoices", { anything: 1 })).not.toThrow();
  });

  it.each([
    [
      "createInvoiceByFactory",
      { invoice: { status: "200" } },
      "invoice.status may only be 100 (draft)",
    ],
    [
      "createInvoiceByFactory",
      { invoice: { status: 1000 } },
      "invoice.status may only be 100 (draft)",
    ],
    [
      "createInvoiceByFactory",
      { invoice: { sendDate: "2026-11-26" } },
      "invoice.sendDate must not be set",
    ],
    ["createInvoiceByFactory", { invoice: { sendType: "VM" } }, "invoice.sendType must not be set"],
    [
      "createInvoiceByFactory",
      { invoice: { enshrined: "2026-11-26" } },
      "invoice.enshrined must not be set",
    ],
    ["createcreditNote", { creditNote: { status: "1000" } }, "creditNote.status may only be 100"],
    [
      "createcreditNote",
      { creditNote: { sendType: "VPR" } },
      "creditNote.sendType must not be set",
    ],
    ["createOrder", { order: { status: 200 } }, "order.status may only be 100"],
    ["createOrder", { order: { sendDate: "x" } }, "order.sendDate must not be set"],
    ["updateOrder", { status: 1000 }, "updateOrder: status may only be 100"],
    ["updateOrder", { sendType: "VM" }, "updateOrder: sendType must not be set"],
    ["voucherFactorySaveVoucher", { voucher: { status: 100 } }, "voucher.status may only be 50"],
    ["voucherFactorySaveVoucher", { voucher: { status: "abc" } }, "voucher.status may only be 50"],
    ["createTransaction", { status: 400 }, "createTransaction: status may only be 100"],
  ] as const)("reject %s with %j", (id, body, message) => {
    expect(() => checkBodyPins(id, body)).toThrow(PinViolation);
    expect(() => checkBodyPins(id, body)).toThrow(message);
  });

  it("are enforced by the client before anything is sent", async () => {
    const out = new Request(`${MOCK_BASE_URL}/Invoice/Factory/saveInvoice`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ invoice: { status: 1000 } }),
    });
    await expect(enforceRequestPins(out, MOCK_BASE_URL)).rejects.toThrow(
      "invoice.status may only be 100",
    );
    const form = new Request(`${MOCK_BASE_URL}/Invoice/Factory/saveInvoice`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: "invoice[status]=1000",
    });
    await expect(enforceRequestPins(form, MOCK_BASE_URL)).rejects.toThrow("body must be JSON");
    const ok = new Request(`${MOCK_BASE_URL}/Invoice/Factory/saveInvoice`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ invoice: { status: 100 } }),
    });
    const passed = await enforceRequestPins(ok, MOCK_BASE_URL);
    expect(await passed.json()).toEqual({ invoice: { status: 100 } });
  });
});
