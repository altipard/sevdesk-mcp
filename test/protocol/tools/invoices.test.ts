import { describe, expect, it } from "vitest";
import { unixSeconds } from "../../../src/tools/format.js";
import { invoice, invoicePosition, list } from "../../fixtures/sevdesk.js";
import {
  connect,
  expectHttpErrors,
  HttpResponse,
  http,
  mockSevdesk,
  pathOf,
  queryOf,
  sevdeskUrl,
  structured,
  textOf,
} from "../../support/harness.js";

const api = mockSevdesk();

describe("search_invoices", () => {
  it("maps filters to sevdesk query parameters and returns compact invoices", async () => {
    api.server.use(
      http.get(sevdeskUrl("/Invoice"), () =>
        HttpResponse.json(
          list([invoice(), invoice({ id: "1002", status: "1000", paidAmount: 119 })], 57),
        ),
      ),
    );
    const c = await connect();
    const result = await c.call("search_invoices", {
      status: "open",
      startDate: "2026-01-01",
      endDate: "2026-01-31",
      contactId: 2001,
      limit: 2,
      offset: 10,
    });
    const data = structured<{ invoices: Array<Record<string, unknown>>; page: unknown }>(result);

    expect(queryOf(api.requests[0])).toEqual({
      status: "200",
      startDate: String(unixSeconds("2026-01-01")),
      endDate: String(unixSeconds("2026-01-31", true)),
      "contact[id]": "2001",
      "contact[objectName]": "Contact",
      limit: "2",
      offset: "10",
      countAll: "true",
    });
    // 2026-01-01 00:00 in Berlin is 2025-12-31 23:00 UTC.
    expect(unixSeconds("2026-01-01")).toBe(Date.UTC(2025, 11, 31, 23) / 1000);
    expect(data.page).toEqual({ offset: 10, limit: 2, count: 2, total: 57, hasMore: true });
    expect(data.invoices[0]).toEqual({
      id: 1001,
      invoiceNumber: "RE-1001",
      invoiceType: "RE",
      invoiceTypeName: "invoice",
      status: 200,
      statusName: "open",
      invoiceDate: "2026-01-15",
      dueDate: "2026-01-29",
      contactId: 2001,
      header: "Rechnung Nr. RE-1001",
      currency: "EUR",
      sumNet: 100,
      sumGross: 119,
      paidAmount: 0,
      openAmount: 119,
    });
    expect(data.invoices[1]).toMatchObject({ id: 1002, statusName: "paid", openAmount: 0 });
    const text = textOf(result);
    expect(text.split("\n")[0]).toBe("2 of 57 invoices (offset 10, more available).");
    expect(JSON.parse(text.split("\n")[1] ?? "")).toEqual(result.structuredContent);
  });

  it("uses defaults, sends no empty filters and survives null fields", async () => {
    api.server.use(
      http.get(sevdeskUrl("/Invoice"), () =>
        HttpResponse.json({
          objects: [
            invoice({
              invoiceDate: null,
              timeToPay: null,
              sumGross: "",
              contact: null,
              currency: null,
            }),
          ],
        }),
      ),
    );
    const c = await connect();
    const data = structured<{ invoices: Array<Record<string, unknown>>; page: unknown }>(
      await c.call("search_invoices", {}),
    );
    expect(queryOf(api.requests[0])).toEqual({ limit: "25", offset: "0", countAll: "true" });
    expect(data.invoices[0]).toMatchObject({
      invoiceDate: null,
      dueDate: null,
      sumGross: null,
      contactId: null,
      openAmount: null,
    });
    expect(data.page).toEqual({ offset: 0, limit: 25, count: 1, total: null, hasMore: false });
  });

  it("rejects bad input before calling sevdesk", async () => {
    const c = await connect();
    for (const args of [
      { limit: 101 },
      { startDate: "2026-02-30" },
      { startDate: "01.01.2026" },
      { status: "200" },
      { contactId: 0 },
    ]) {
      const result = await c.call("search_invoices", args);
      expect(result.isError, JSON.stringify(args)).toBe(true);
      expect(textOf(result), JSON.stringify(args)).not.toContain("Internal error");
    }
    const reversed = await c.call("search_invoices", {
      startDate: "2026-02-01",
      endDate: "2026-01-01",
    });
    expect(textOf(reversed)).toContain("startDate must not be after endDate");
    expect(api.requests).toEqual([]);
  });

  it("reports 401, 404 and 429 as tool errors", async () => {
    await expectHttpErrors(api, "get", "/Invoice", "search_invoices", {});
  });
});

describe("get_invoice", () => {
  it("returns the invoice with its positions", async () => {
    api.server.use(
      http.get(sevdeskUrl("/Invoice/1001"), () =>
        HttpResponse.json(
          list([
            invoice({
              enshrined: "2026-02-01T00:00:00+01:00",
              payDate: "2026-02-03T00:00:00+01:00",
            }),
          ]),
        ),
      ),
      http.get(sevdeskUrl("/Invoice/1001/getPositions"), () =>
        HttpResponse.json(
          list([
            invoicePosition(),
            invoicePosition({ id: "5002", positionNumber: "2", quantity: "1.5" }),
          ]),
        ),
      ),
    );
    const c = await connect();
    const result = await c.call("get_invoice", { invoiceId: 1001 });
    const data = structured<{
      invoice: Record<string, unknown>;
      positions: unknown[];
      positionsTruncated: boolean;
    }>(result);
    expect(api.requests.map(pathOf)).toEqual(["/Invoice/1001", "/Invoice/1001/getPositions"]);
    expect(queryOf(api.requests[1])).toEqual({ limit: "100" });
    expect(data.invoice).toMatchObject({
      id: 1001,
      enshrined: true,
      payDate: "2026-02-03",
      sumTax: 19,
      taxRuleId: 1,
      timeToPay: 14,
    });
    expect(data.positions[0]).toEqual({
      id: 5001,
      positionNumber: 1,
      name: "Beratung",
      text: "Workshop, halber Tag",
      quantity: 2,
      unityId: 9,
      partId: null,
      priceNet: 50,
      priceGross: 59.5,
      taxRate: 19,
      discount: null,
    });
    expect(data.positionsTruncated).toBe(false);
    expect(textOf(result).split("\n")[0]).toBe("Invoice 1001 (open), 2 positions.");
  });

  it("flags positions beyond the first 100", async () => {
    api.server.use(
      http.get(sevdeskUrl("/Invoice/1001"), () => HttpResponse.json(list([invoice()]))),
      http.get(sevdeskUrl("/Invoice/1001/getPositions"), () =>
        HttpResponse.json(
          list(Array.from({ length: 100 }, (_, i) => invoicePosition({ id: String(6000 + i) }))),
        ),
      ),
    );
    const c = await connect();
    const result = await c.call("get_invoice", { invoiceId: 1001 });
    expect(structured<{ positionsTruncated: boolean }>(result).positionsTruncated).toBe(true);
    expect(textOf(result).split("\n")[0]).toBe("Invoice 1001 (open), 100+ positions.");
  });

  it("treats an empty answer as not found", async () => {
    api.server.use(http.get(sevdeskUrl("/Invoice/5"), () => HttpResponse.json({ objects: [] })));
    const c = await connect();
    const result = await c.call("get_invoice", { invoiceId: 5 });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toBe("sevdesk has no invoice with ID 5.");
  });

  it("reports 401, 404 and 429 as tool errors", async () => {
    await expectHttpErrors(api, "get", "/Invoice/7", "get_invoice", { invoiceId: 7 });
  });
});

describe("list_open_receivables", () => {
  it("scans open and partially paid invoices, computes overdue and totals", async () => {
    api.server.use(
      http.get(sevdeskUrl("/Invoice"), ({ request }) => {
        const status = new URL(request.url).searchParams.get("status");
        if (status === "200") {
          return HttpResponse.json(
            list([
              invoice({ id: "1", invoiceDate: "2020-01-01T00:00:00+01:00", timeToPay: "10" }),
              invoice({ id: "2", invoiceDate: "2999-01-01T00:00:00+01:00", sumGross: "50" }),
              invoice({
                id: "3",
                currency: "USD",
                invoiceDate: "2020-02-01T00:00:00+01:00",
                sumGross: "10",
              }),
            ]),
          );
        }
        return HttpResponse.json(
          list([
            invoice({
              id: "4",
              status: "750",
              paidAmount: 100,
              invoiceDate: "2020-01-05T00:00:00+01:00",
            }),
          ]),
        );
      }),
    );
    const c = await connect();
    const result = await c.call("list_open_receivables", { limit: 2 });
    const data = structured<{
      receivables: Array<Record<string, unknown>>;
      totals: unknown[];
      page: unknown;
      truncated: boolean;
    }>(result);

    expect(api.requests.map((r) => queryOf(r).status)).toEqual(["200", "750"]);
    expect(queryOf(api.requests[0])).toEqual({ status: "200", limit: "100", offset: "0" });
    expect(data.receivables.map((r) => r.id)).toEqual([1, 4]);
    expect(data.receivables[0]).toMatchObject({
      overdue: true,
      dueDate: "2020-01-11",
      openAmount: 119,
    });
    expect(data.receivables[1]).toMatchObject({ openAmount: 19, statusName: "partially_paid" });
    expect(data.page).toEqual({ offset: 0, limit: 2, count: 2, total: 4, hasMore: true });
    expect(data.totals).toEqual([
      { currency: "EUR", count: 3, openAmount: 188, overdueCount: 2, overdueAmount: 138 },
      { currency: "USD", count: 1, openAmount: 10, overdueCount: 1, overdueAmount: 10 },
    ]);
    expect(data.truncated).toBe(false);

    const overdue = structured<{ receivables: Array<{ id: number }> }>(
      await c.call("list_open_receivables", { overdueOnly: true }),
    );
    expect(overdue.receivables.map((r) => r.id)).toEqual([1, 4, 3]);
  });

  it("leaves reminders and cancellations out by default and splits totals by type", async () => {
    api.server.use(
      http.get(sevdeskUrl("/Invoice"), ({ request }) => {
        if (new URL(request.url).searchParams.get("status") === "750") {
          return HttpResponse.json(list([]));
        }
        return HttpResponse.json(
          list([
            invoice({ id: "1", invoiceType: "RE" }),
            invoice({ id: "2", invoiceType: "MA", sumGross: "124" }),
            invoice({ id: "3", invoiceType: "SR", sumGross: "50" }),
            invoice({ id: "4", invoiceType: "AR", sumGross: "30" }),
            invoice({ id: "5", invoiceType: null }),
          ]),
        );
      }),
    );
    const c = await connect();
    type Out = {
      receivables: Array<{ id: number }>;
      totals: Array<Record<string, unknown>>;
      totalsByType: Array<Record<string, unknown>>;
    };
    const standard = structured<Out>(await c.call("list_open_receivables", {}));
    expect(standard.receivables.map((r) => r.id).sort()).toEqual([1, 4]);
    expect(standard.totals).toEqual([
      expect.objectContaining({ currency: "EUR", count: 2, openAmount: 149 }),
    ]);
    expect(standard.totalsByType).toEqual([
      expect.objectContaining({
        invoiceType: "AR",
        invoiceTypeName: "advance",
        count: 1,
        openAmount: 30,
      }),
      expect.objectContaining({
        invoiceType: "RE",
        invoiceTypeName: "invoice",
        count: 1,
        openAmount: 119,
      }),
    ]);

    const reminders = structured<Out>(
      await c.call("list_open_receivables", { invoiceTypes: ["MA"] }),
    );
    expect(reminders.receivables.map((r) => r.id)).toEqual([2]);
    expect(reminders.totalsByType).toEqual([
      expect.objectContaining({ invoiceType: "MA", invoiceTypeName: "reminder", openAmount: 124 }),
    ]);

    for (const invoiceTypes of [[], ["XX"]]) {
      expect((await c.call("list_open_receivables", { invoiceTypes })).isError).toBe(true);
    }
  });

  it("pages through sevdesk and stops at the scan limit with a note", async () => {
    api.server.use(
      http.get(sevdeskUrl("/Invoice"), ({ request }) => {
        const params = new URL(request.url).searchParams;
        if (params.get("status") === "750") return HttpResponse.json(list([]));
        const offset = Number(params.get("offset"));
        return HttpResponse.json(
          list(Array.from({ length: 100 }, (_, i) => invoice({ id: String(offset + i + 1) }))),
        );
      }),
    );
    const c = await connect();
    const data = structured<{ truncated: boolean; note?: string; page: { total: number } }>(
      await c.call("list_open_receivables", { contactId: 2001 }),
    );
    expect(api.requests).toHaveLength(11);
    expect(queryOf(api.requests[9])).toMatchObject({ offset: "900", "contact[id]": "2001" });
    expect(data.truncated).toBe(true);
    expect(data.note).toContain("first 1000 invoices");
    expect(data.page.total).toBe(1000);
  });

  it("reports 401, 404 and 429 as tool errors", async () => {
    await expectHttpErrors(api, "get", "/Invoice", "list_open_receivables", {});
  });
});
