import { HttpResponse, http } from "msw";
import { setupServer } from "msw/node";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
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
