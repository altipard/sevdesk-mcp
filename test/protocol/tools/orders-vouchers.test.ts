import { describe, expect, it } from "vitest";
import { unixSeconds } from "../../../src/tools/format.js";
import { list, order, voucher, voucherPosition } from "../../fixtures/sevdesk.js";
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

describe("search_orders", () => {
  it("maps filters and returns orders with type and status names", async () => {
    api.server.use(
      http.get(sevdeskUrl("/Order"), () =>
        HttpResponse.json(
          list([order(), order({ id: "7002", orderType: "AB", status: "500" })], 2),
        ),
      ),
    );
    const c = await connect();
    const result = await c.call("search_orders", {
      status: "accepted",
      startDate: "2026-07-01",
      contactId: 2001,
      orderNumber: "AN-1001",
    });
    const data = structured<{ orders: Array<Record<string, unknown>>; page: unknown }>(result);
    expect(queryOf(api.requests[0])).toEqual({
      status: "500",
      // Summer time: 2026-07-01 00:00 in Berlin is 22:00 UTC the day before.
      startDate: String(Date.UTC(2026, 5, 30, 22) / 1000),
      "contact[id]": "2001",
      "contact[objectName]": "Contact",
      orderNumber: "AN-1001",
      limit: "25",
      offset: "0",
      countAll: "true",
    });
    expect(data.orders[0]).toEqual({
      id: 7001,
      orderNumber: "AN-1001",
      orderType: "AN",
      orderTypeName: "estimate",
      status: 200,
      statusName: "delivered",
      orderDate: "2026-02-01",
      contactId: 2001,
      header: "Angebot AN-1001",
      currency: "EUR",
      sumNet: 1000,
      sumGross: 1190,
      sendDate: null,
    });
    expect(data.orders[1]).toMatchObject({
      orderTypeName: "order_confirmation",
      statusName: "accepted",
    });
    expect(textOf(result).split("\n")[0]).toBe("2 of 2 orders (offset 0).");
  });

  it("filters by order type after fetching and says what page refers to", async () => {
    api.server.use(
      http.get(sevdeskUrl("/Order"), () =>
        HttpResponse.json(
          list(
            [
              order(),
              order({ id: "7002", orderType: "AB" }),
              order({ id: "7003", orderType: "LI" }),
            ],
            40,
          ),
        ),
      ),
    );
    const c = await connect();
    const result = await c.call("search_orders", { orderType: "AB", limit: 3 });
    const data = structured<{
      orders: Array<{ id: number }>;
      page: Record<string, unknown>;
      orderTypeFilter: Record<string, unknown>;
    }>(result);
    // Not sent to sevdesk: the spec declares no orderType parameter.
    expect(queryOf(api.requests[0])).toEqual({ limit: "3", offset: "0", countAll: "true" });
    expect(data.orders.map((o) => o.id)).toEqual([7002]);
    expect(data.page).toEqual({ offset: 0, limit: 3, count: 3, total: 40, hasMore: true });
    expect(data.orderTypeFilter).toMatchObject({ orderType: "AB", fetched: 3, kept: 1 });
    expect(String(data.orderTypeFilter.note)).toContain("applied to this page only");
    expect(textOf(result).split("\n")[0]).toBe(
      "1 of 3 fetched orders are AB (offset 0, more available).",
    );
  });

  it("reports 401, 404 and 429 as tool errors", async () => {
    await expectHttpErrors(api, "get", "/Order", "search_orders", {});
  });
});

describe("search_vouchers", () => {
  it("maps filters, including text and debit/credit", async () => {
    api.server.use(http.get(sevdeskUrl("/Voucher"), () => HttpResponse.json(list([voucher()], 1))));
    const c = await connect();
    const data = structured<{ vouchers: Array<Record<string, unknown>> }>(
      await c.call("search_vouchers", {
        status: "partially_paid",
        endDate: "2026-03-31",
        text: "Papier",
        creditDebit: "D",
        contactId: 2003,
        limit: 10,
      }),
    );
    expect(queryOf(api.requests[0])).toEqual({
      status: "750",
      endDate: String(unixSeconds("2026-03-31", true)),
      descriptionLike: "Papier",
      creditDebit: "D",
      "contact[id]": "2003",
      "contact[objectName]": "Contact",
      limit: "10",
      offset: "0",
      countAll: "true",
    });
    expect(data.vouchers[0]).toEqual({
      id: 8001,
      voucherDate: "2026-03-01",
      description: "Druckerpapier",
      supplierId: 2003,
      supplierName: "Bürobedarf Beispiel KG",
      status: 100,
      statusName: "unpaid",
      creditDebit: "D",
      voucherType: "VOU",
      currency: "EUR",
      sumNet: 42.02,
      sumGross: 50,
      paidAmount: 0,
      openAmount: 50,
      payDate: null,
      paymentDeadline: "2026-03-15",
    });
  });

  it("reports 401, 404 and 429 as tool errors", async () => {
    await expectHttpErrors(api, "get", "/Voucher", "search_vouchers", {});
  });
});

describe("get_voucher", () => {
  it("returns the voucher with its positions", async () => {
    api.server.use(
      http.get(sevdeskUrl("/Voucher/8001"), () =>
        HttpResponse.json(
          list([
            voucher({
              document: { id: "77", objectName: "Document" },
              status: "1000",
              paidAmount: 50,
            }),
          ]),
        ),
      ),
      http.get(sevdeskUrl("/VoucherPos"), () => HttpResponse.json(list([voucherPosition()]))),
    );
    const c = await connect();
    const result = await c.call("get_voucher", { voucherId: 8001 });
    const data = structured<{ voucher: Record<string, unknown>; positions: unknown[] }>(result);
    expect(api.requests.map(pathOf)).toEqual(["/Voucher/8001", "/VoucherPos"]);
    expect(queryOf(api.requests[1])).toEqual({
      "voucher[id]": "8001",
      "voucher[objectName]": "Voucher",
    });
    expect(data.voucher).toMatchObject({
      id: 8001,
      statusName: "paid",
      openAmount: 0,
      hasDocument: true,
      enshrined: false,
      taxRuleId: 9,
      sumTax: 7.98,
    });
    expect(data.positions).toEqual([
      {
        id: 8501,
        accountDatevId: 6815,
        taxRate: 19,
        net: false,
        isAsset: false,
        sumNet: 42.02,
        sumTax: 7.98,
        sumGross: 50,
        comment: null,
      },
    ]);
    expect(textOf(result).split("\n")[0]).toBe("Voucher 8001 (paid), 1 positions.");
  });

  it("treats an empty answer as not found", async () => {
    api.server.use(http.get(sevdeskUrl("/Voucher/3"), () => HttpResponse.json({ objects: [] })));
    const c = await connect();
    expect(textOf(await c.call("get_voucher", { voucherId: 3 }))).toBe(
      "sevdesk has no voucher with ID 3.",
    );
  });

  it("reports 401, 404 and 429 as tool errors", async () => {
    await expectHttpErrors(api, "get", "/Voucher/4", "get_voucher", { voucherId: 4 });
  });
});
