import { describe, expect, it } from "vitest";
import { MAX_AUDIT_DOCUMENTS, MAX_AUDIT_POSITIONS } from "../../src/tools/audit-common.js";
import { addDays, berlinDateTime, todayIso, unixSeconds } from "../../src/tools/format.js";
import { TOOLS } from "../../src/tools/index.js";
import { BOOKKEEPING_1_MESSAGE } from "../../src/tools/tax-rules.js";
import {
  address,
  contact,
  invoice,
  list,
  receiptGuide,
  transaction,
  voucher,
  voucherPosition,
} from "../fixtures/sevdesk.js";
import {
  connect,
  HttpResponse,
  http,
  mockSevdesk,
  pathOf,
  queryOf,
  sevdeskError,
  sevdeskUrl,
  structured,
  textOf,
} from "../support/harness.js";

const api = mockSevdesk();

const ref = (id: number, objectName: string) => ({ id: String(id), objectName });
const MARCH = { startDate: "2026-03-01", endDate: "2026-03-31" };
const AUDIT_TOOLS = [
  "summarize_documents",
  "audit_vat",
  "reverse_charge_report",
  "find_duplicate_vouchers",
  "find_subscription_gaps",
  "reconcile_transactions",
];

const version = (v: string) =>
  http.get(sevdeskUrl("/Tools/bookkeepingSystemVersion"), () =>
    HttpResponse.json({ objects: { version: v } }),
  );

/** One page per offset from `all`, as sevdesk pages with limit/offset. */
const paged =
  (all: unknown[]) =>
  ({ request }: { request: Request }) => {
    const q = new URL(request.url).searchParams;
    const offset = Number(q.get("offset") ?? 0);
    const limit = Number(q.get("limit") ?? 100);
    return HttpResponse.json(list(all.slice(offset, offset + limit)));
  };

const requestsTo = (path: string) => api.requests.filter((r) => pathOf(r) === path);

describe("audit tool definitions", () => {
  it("are registered read tools with their operations declared", () => {
    for (const name of AUDIT_TOOLS) {
      const tool = TOOLS.find((t) => t.name === name);
      expect(tool, name).toBeDefined();
      expect(tool?.class, name).toBe("R");
      expect(tool?.annotations.readOnlyHint, name).toBe(true);
      expect(tool?.description, name).toMatch(/^[\x20-\x7e]+$/);
    }
    expect(TOOLS.find((t) => t.name === "audit_vat")?.operations).toEqual(
      expect.arrayContaining(["getVoucherPositions", "getContactById", "forAllAccounts"]),
    );
  });

  it("refuse a reversed period before anything is sent", async () => {
    const c = await connect();
    for (const name of AUDIT_TOOLS) {
      const args: Record<string, unknown> = { startDate: "2026-03-31", endDate: "2026-03-01" };
      if (name === "summarize_documents") args.documentType = "vouchers";
      const result = await c.call(name, args);
      expect(result.isError, name).toBe(true);
      expect(textOf(result), name).toContain("startDate must not be after endDate");
    }
    expect(api.requests).toHaveLength(0);
  });

  it("reject impossible dates in the schema", async () => {
    const c = await connect();
    const result = await c.call("audit_vat", { startDate: "2026-02-30", endDate: "2026-03-01" });
    expect(result.isError).toBe(true);
    expect(api.requests).toHaveLength(0);
  });
});

describe("audit_vat", () => {
  it("finds a foreign subscription booked as domestic expense and suggests reverse charge", async () => {
    api.server.use(
      version("2.0"),
      http.get(sevdeskUrl("/Voucher"), () =>
        HttpResponse.json(
          list([
            voucher({
              id: "8001",
              supplier: ref(2003, "Contact"),
              supplierName: "Cloud Ltd",
              description: "INV-77",
              sumNet: "20",
              sumTax: "0",
              sumGross: "20",
              taxRule: ref(9, "TaxRule"),
            }),
            voucher({ id: "8002", supplier: ref(2004, "Contact"), supplierName: "Papier KG" }),
          ]),
        ),
      ),
      http.get(sevdeskUrl("/ReceiptGuidance/forAllAccounts"), () =>
        HttpResponse.json(
          list([
            receiptGuide({
              accountDatevId: 6815,
              allowedTaxRules: [
                { id: 9, name: "x", description: "x", taxRates: ["ZERO", "SEVEN", "NINETEEN"] },
                { id: 14, name: "y", description: "y", taxRates: ["ZERO"] },
              ],
            }),
          ]),
        ),
      ),
      http.get(sevdeskUrl("/VoucherPos"), ({ request }) => {
        const id = new URL(request.url).searchParams.get("voucher[id]");
        return HttpResponse.json(
          list([
            id === "8001"
              ? voucherPosition({
                  voucher: ref(8001, "Voucher"),
                  taxRate: "0",
                  sumNet: "20",
                  sumTax: "0",
                  sumGross: "20",
                })
              : voucherPosition({ voucher: ref(8002, "Voucher") }),
          ]),
        );
      }),
      http.get(sevdeskUrl("/Contact/2003"), () =>
        HttpResponse.json(
          list([
            contact({
              id: "2003",
              name: "Cloud Ltd",
              vatNumber: "IE1234567X",
              addresses: [address({ country: ref(13, "StaticCountry") })],
            }),
          ]),
        ),
      ),
    );
    const c = await connect();
    const result = await c.call("audit_vat", MARCH);
    const data = structured<{
      findings: Array<Record<string, unknown>>;
      findingCounts: Record<string, number>;
      checked: Record<string, unknown>;
      truncated: boolean;
      disclaimer: string;
      bookkeepingVersion: string;
    }>(result);

    expect(queryOf(requestsTo("/Voucher")[0])).toEqual({
      startDate: String(unixSeconds("2026-03-01")),
      endDate: String(unixSeconds("2026-03-31", true)),
      limit: "100",
      offset: "0",
    });
    // Only the supplier of the suspicious voucher is looked up.
    expect(requestsTo("/Contact/2003")).toHaveLength(1);
    expect(requestsTo("/Contact/2004")).toHaveLength(0);
    expect(queryOf(requestsTo("/Contact/2003")[0])).toEqual({ embed: "addresses" });
    expect(data.bookkeepingVersion).toBe("2.0");
    expect(data.checked).toEqual({
      vouchers: 2,
      positionsRead: 2,
      suppliersLookedUp: 1,
      guidanceRead: true,
    });
    expect(data.findings).toEqual([
      expect.objectContaining({
        severity: "high",
        code: "FOREIGN_SUPPLIER_DOMESTIC_RULE",
        suggestedTaxRules: [14, 8],
        document: {
          type: "voucher",
          id: 8001,
          date: "2026-03-01",
          number: "INV-77",
          contactId: 2003,
          contactName: "Cloud Ltd",
          amount: 20,
          foreignCurrency: null,
          foreignAmount: null,
        },
      }),
    ]);
    expect(data.findingCounts).toEqual({ high: 1, medium: 0, low: 0 });
    expect(data.truncated).toBe(false);
    expect(data.disclaimer).toContain("not tax advice");
    expect(textOf(result).split("\n")[0]).toBe(
      "2 vouchers 2026-03-01 to 2026-03-31: 1 high, 0 medium, 0 low findings.",
    );
  });

  it("refuses bookkeeping 1.0 accounts", async () => {
    api.server.use(version("1.0"));
    const c = await connect();
    const result = await c.call("audit_vat", MARCH);
    expect(result.isError).toBe(true);
    expect(textOf(result)).toBe(BOOKKEEPING_1_MESSAGE);
    expect(requestsTo("/Voucher")).toHaveLength(0);
  });

  it("goes on as 2.0 with a note when the version cannot be read; empty period", async () => {
    api.server.use(
      http.get(sevdeskUrl("/Tools/bookkeepingSystemVersion"), () => sevdeskError(500)),
      http.get(sevdeskUrl("/Voucher"), () => HttpResponse.json(list([]))),
    );
    const c = await connect();
    const data = structured<{ note: string; truncated: boolean; findings: unknown[] }>(
      await c.call("audit_vat", MARCH),
    );
    expect(data.findings).toEqual([]);
    expect(data.truncated).toBe(false);
    expect(data.note).toContain("bookkeeping 2.0 was assumed");
    expect(data.note).toContain("No vouchers in the period.");
    expect(requestsTo("/ReceiptGuidance/forAllAccounts")).toHaveLength(0);
  });

  it("checks headers only and says so when guidance and contacts are missing", async () => {
    api.server.use(
      version("2.0"),
      http.get(sevdeskUrl("/Voucher"), () =>
        HttpResponse.json(
          list([
            voucher({ id: "8001", taxRule: ref(1, "TaxRule"), supplier: null, currency: "USD" }),
          ]),
        ),
      ),
      http.get(sevdeskUrl("/ReceiptGuidance/forAllAccounts"), () => sevdeskError(503)),
      http.get(sevdeskUrl("/VoucherPos"), () => sevdeskError(404)),
    );
    const c = await connect();
    const data = structured<{
      findings: Array<{ code: string }>;
      note: string;
      truncated: boolean;
    }>(await c.call("audit_vat", MARCH));
    expect(data.findings.map((f) => f.code).sort()).toEqual([
      "FOREIGN_CURRENCY",
      "WRONG_SIDE_TAX_RULE",
    ]);
    expect(data.truncated).toBe(true);
    expect(data.note).toContain("Reading tax guidance failed");
    expect(data.note).toContain("Reading voucher positions failed");
    expect(data.note).toContain("Booking accounts were not checked");
  });

  it(`reads positions for at most ${MAX_AUDIT_POSITIONS} vouchers and marks the answer truncated`, async () => {
    const vouchers = Array.from({ length: MAX_AUDIT_POSITIONS + 1 }, (_, i) =>
      voucher({ id: String(10_000 + i) }),
    );
    api.server.use(
      version("2.0"),
      http.get(sevdeskUrl("/Voucher"), paged(vouchers)),
      http.get(sevdeskUrl("/ReceiptGuidance/forAllAccounts"), () => HttpResponse.json(list([]))),
      http.get(sevdeskUrl("/VoucherPos"), ({ request }) => {
        const id = Number(new URL(request.url).searchParams.get("voucher[id]"));
        return HttpResponse.json(list([voucherPosition({ voucher: ref(id, "Voucher") })]));
      }),
    );
    const c = await connect();
    const data = structured<{
      checked: { positionsRead: number };
      truncated: boolean;
      note: string;
    }>(await c.call("audit_vat", MARCH));
    expect(requestsTo("/VoucherPos")).toHaveLength(MAX_AUDIT_POSITIONS);
    expect(data.checked.positionsRead).toBe(MAX_AUDIT_POSITIONS);
    expect(data.truncated).toBe(true);
    expect(data.note).toContain(`first ${MAX_AUDIT_POSITIONS} of ${MAX_AUDIT_POSITIONS + 1}`);
  }, 30_000);
});

describe("reverse_charge_report", () => {
  it("sums vouchers and invoices per category", async () => {
    api.server.use(
      version("2.0"),
      http.get(sevdeskUrl("/Voucher"), () =>
        HttpResponse.json(
          list([
            voucher({ id: "1", taxRule: ref(12, "TaxRule"), sumNet: "100" }),
            voucher({ id: "2", taxRule: ref(13, "TaxRule"), sumNet: "40" }),
            voucher({ id: "3", taxRule: ref(9, "TaxRule"), sumNet: "999" }),
          ]),
        ),
      ),
      http.get(sevdeskUrl("/Invoice"), () =>
        HttpResponse.json(
          list([
            invoice({
              id: "5",
              invoiceDate: "2026-03-10T00:00:00+01:00",
              taxRule: ref(5, "TaxRule"),
              sumNet: "500",
            }),
            invoice({ id: "6", invoiceDate: "2026-03-10T00:00:00+01:00" }),
          ]),
        ),
      ),
      http.get(sevdeskUrl("/CreditNote"), () =>
        HttpResponse.json(
          list([
            {
              id: "70",
              objectName: "CreditNote",
              creditNoteNumber: "GU-70",
              creditNoteDate: "2026-03-12T00:00:00+01:00",
              contact: ref(2001, "Contact"),
              status: "200",
              taxRule: ref(5, "TaxRule"),
              currency: "EUR",
              sumNet: "50",
              sumTax: "0",
              sumGross: "50",
            },
          ]),
        ),
      ),
    );
    const c = await connect();
    const result = await c.call("reverse_charge_report", MARCH);
    const data = structured<{
      totals: Array<Record<string, unknown>>;
      documents: Array<Record<string, unknown>>;
      page: { total: number };
    }>(result);
    expect(data.totals.map((t) => [t.category, t.documents, t.net])).toEqual([
      ["nets_to_zero", 1, 100],
      ["payable", 1, 40],
      ["revenue", 2, 450],
    ]);
    expect(data.page.total).toBe(4);
    expect(queryOf(requestsTo("/CreditNote")[0])).toEqual({
      startDate: String(unixSeconds("2026-03-01")),
      endDate: String(unixSeconds("2026-03-31", true)),
    });
    expect((result.structuredContent as { disclaimer: string }).disclaimer).toContain(
      "document date",
    );
    expect(textOf(result).split("\n")[0]).toBe(
      "13b 2026-03-01 to 2026-03-31 (EUR net): nets to zero 100, payable 40, own revenue 450; 4 documents.",
    );
  });

  it("keeps the voucher part when a later scan fails", async () => {
    api.server.use(
      version("2.0"),
      http.get(sevdeskUrl("/Voucher"), () =>
        HttpResponse.json(list([voucher({ id: "1", taxRule: ref(12, "TaxRule"), sumNet: "100" })])),
      ),
      http.get(sevdeskUrl("/Invoice"), () => sevdeskError(500)),
      http.get(sevdeskUrl("/CreditNote"), () => HttpResponse.json(list([]))),
    );
    const c = await connect();
    const data = structured<{ truncated: boolean; note: string; totals: Array<{ net: number }> }>(
      await c.call("reverse_charge_report", MARCH),
    );
    expect(data.truncated).toBe(true);
    expect(data.note).toContain("Reading invoices failed");
    expect(data.totals[0]?.net).toBe(100);
  });

  it("refuses bookkeeping 1.0", async () => {
    api.server.use(version("1.0"));
    const c = await connect();
    const result = await c.call("reverse_charge_report", MARCH);
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("bookkeeping 1.0");
  });
});

describe("find_duplicate_vouchers", () => {
  it("reports the same number per supplier", async () => {
    api.server.use(
      http.get(sevdeskUrl("/Voucher"), () =>
        HttpResponse.json(
          list([
            voucher({ id: "1", description: "R-1" }),
            voucher({ id: "2", description: "R-1", voucherDate: "2026-03-02T00:00:00+01:00" }),
          ]),
        ),
      ),
    );
    const c = await connect();
    const data = structured<{ findings: Array<{ code: string }>; checkedVouchers: number }>(
      await c.call("find_duplicate_vouchers", MARCH),
    );
    expect(data.checkedVouchers).toBe(2);
    expect(data.findings.map((f) => f.code)).toEqual(["SAME_NUMBER"]);
  });
});

describe("find_subscription_gaps", () => {
  it("reads expense vouchers from historyMonths before the period", async () => {
    api.server.use(http.get(sevdeskUrl("/Voucher"), () => HttpResponse.json(list([]))));
    const c = await connect();
    const data = structured<{ readFrom: string; gaps: unknown[]; note: string }>(
      await c.call("find_subscription_gaps", { ...MARCH, historyMonths: 3 }),
    );
    expect(data.readFrom).toBe("2025-12-01");
    expect(queryOf(api.requests[0])).toMatchObject({
      startDate: String(unixSeconds("2025-12-01")),
      creditDebit: "D",
    });
    expect(data.gaps).toEqual([]);
    expect(data.note).toContain("No expense vouchers");
  });
});

describe("reconcile_transactions", () => {
  it("matches an open transaction with an unpaid voucher and lists the rest", async () => {
    api.server.use(
      http.get(sevdeskUrl("/CheckAccountTransaction"), () =>
        HttpResponse.json(
          list([
            transaction({
              id: "1",
              valueDate: "2026-03-05T00:00:00+01:00",
              amount: "-50",
              paymtPurpose: "Druckerpapier",
              payeePayerName: "Bürobedarf Beispiel KG",
            }),
            transaction({ id: "2", valueDate: "2026-03-06T00:00:00+01:00", amount: "-9.99" }),
            transaction({ id: "3", valueDate: "2026-03-07T00:00:00+01:00", status: "400" }),
          ]),
        ),
      ),
      http.get(sevdeskUrl("/Voucher"), () =>
        HttpResponse.json(
          list([
            voucher({ id: "8001" }),
            voucher({ id: "8002", sumGross: "77", currency: "USD" }),
            voucher({ id: "8003", sumGross: "12", voucherDate: "2026-03-20T00:00:00+01:00" }),
          ]),
        ),
      ),
      http.get(sevdeskUrl("/Invoice"), () => HttpResponse.json(list([]))),
    );
    const c = await connect();
    const data = structured<{
      counts: Record<string, number>;
      matches: Array<Record<string, unknown>>;
      paymentsWithoutDocument: Array<{ id: number }>;
      documentsWithoutPayment: Array<{ id: number }>;
    }>(await c.call("reconcile_transactions", { ...MARCH, windowDays: 10 }));
    expect(queryOf(requestsTo("/CheckAccountTransaction")[0])).toMatchObject({
      startDate: berlinDateTime("2026-03-01"),
      endDate: berlinDateTime("2026-03-31", true),
    });
    expect(queryOf(requestsTo("/Voucher")[0]).startDate).toBe(String(unixSeconds("2026-02-19")));
    expect(queryOf(requestsTo("/Voucher")[0]).endDate).toBe(
      String(unixSeconds("2026-04-10", true)),
    );
    expect(data.counts).toEqual({
      openTransactions: 2,
      bookedTransactions: 1,
      openDocuments: 2,
      foreignCurrencySkipped: 1,
      matches: 1,
      paymentsWithoutDocument: 1,
      documentsWithoutPayment: 1,
    });
    expect(data.matches[0]).toMatchObject({
      confidence: "high",
      transaction: { id: 1 },
      document: { type: "voucher", id: 8001 },
      daysApart: 4,
    });
    expect(data.paymentsWithoutDocument.map((t) => t.id)).toEqual([2]);
    expect(data.documentsWithoutPayment.map((d) => d.id)).toEqual([8003]);
  });
});

describe("summarize_documents", () => {
  it("sums invoices per month, leaving out drafts and reminders", async () => {
    api.server.use(
      http.get(sevdeskUrl("/Invoice"), () =>
        HttpResponse.json(
          list([
            invoice({ id: "1", invoiceDate: "2026-04-05T00:00:00+02:00" }),
            invoice({ id: "2", invoiceDate: "2026-05-05T00:00:00+02:00", status: "1000" }),
            invoice({ id: "3", invoiceDate: "2026-05-06T00:00:00+02:00", status: "100" }),
            invoice({ id: "4", invoiceDate: "2026-05-07T00:00:00+02:00", invoiceType: "MA" }),
            invoice({
              id: "5",
              invoiceDate: "2026-06-01T00:00:00+02:00",
              invoiceType: "SR",
              sumNet: "-100",
              sumTax: "-19",
              sumGross: "-119",
            }),
          ]),
        ),
      ),
      http.get(sevdeskUrl("/CreditNote"), () =>
        HttpResponse.json(
          list([
            {
              id: "70",
              objectName: "CreditNote",
              creditNoteDate: "2026-06-02T00:00:00+02:00",
              status: "1000",
              currency: "EUR",
              sumNet: "10",
              sumTax: "1.9",
              sumGross: "11.9",
            },
            {
              id: "71",
              objectName: "CreditNote",
              creditNoteDate: "2026-06-03T00:00:00+02:00",
              status: "100",
              sumNet: "99",
              sumTax: "0",
              sumGross: "99",
            },
          ]),
        ),
      ),
    );
    const c = await connect();
    const result = await c.call("summarize_documents", {
      documentType: "invoices",
      startDate: "2026-04-01",
      endDate: "2026-06-30",
    });
    const data = structured<{
      groups: Array<Record<string, unknown>>;
      totals: unknown[];
      documents: number;
    }>(result);
    expect(data.documents).toBe(4);
    expect(data.groups.map((g) => [g.group, g.count, g.gross])).toEqual([
      ["2026-04", 1, 119],
      ["2026-05", 1, 119],
      ["2026-06", 2, -130.9],
    ]);
    expect(data.totals).toEqual([
      {
        creditDebit: null,
        count: 4,
        net: 90,
        tax: 17.1,
        gross: 107.1,
        foreignCurrencyDocuments: 0,
      },
    ]);
    expect(textOf(result).split("\n")[0]).toBe(
      "4 invoices 2026-04-01 to 2026-06-30, gross 107.1 EUR.",
    );
  });

  it("sums income and expense vouchers separately", async () => {
    api.server.use(
      http.get(sevdeskUrl("/Voucher"), () =>
        HttpResponse.json(
          list([
            voucher({ id: "1", creditDebit: "D", sumGross: "50" }),
            voucher({ id: "2", creditDebit: "C", sumGross: "500", currency: "CHF" }),
          ]),
        ),
      ),
    );
    const c = await connect();
    const result = await c.call("summarize_documents", { documentType: "vouchers", ...MARCH });
    const data = structured<{ totals: Array<Record<string, unknown>>; note: string }>(result);
    expect(data.totals.map((t) => [t.creditDebit, t.gross, t.foreignCurrencyDocuments])).toEqual([
      ["C", 500, 1],
      ["D", 50, 0],
    ]);
    expect(data.note).toContain("euro amounts");
    expect(textOf(result).split("\n")[0]).toBe(
      "2 vouchers 2026-03-01 to 2026-03-31, gross income 500 EUR, expenses 50 EUR.",
    );
  });

  it("marks the answer truncated when sevdesk returns a full unpaged list of credit notes", async () => {
    api.server.use(
      http.get(sevdeskUrl("/Invoice"), () => HttpResponse.json(list([]))),
      http.get(sevdeskUrl("/CreditNote"), () =>
        HttpResponse.json(
          list(
            Array.from({ length: 100 }, (_, i) => ({
              id: String(i + 1),
              creditNoteDate: "2026-03-05T00:00:00+01:00",
              status: "200",
              sumNet: "1",
              sumTax: "0",
              sumGross: "1",
            })),
          ),
        ),
      ),
    );
    const c = await connect();
    const data = structured<{ documents: number; truncated: boolean; note: string }>(
      await c.call("summarize_documents", { documentType: "invoices", ...MARCH }),
    );
    expect(data.documents).toBe(100);
    expect(data.truncated).toBe(true);
    expect(data.note).toContain("100 credit notes");
  });

  it("refuses creditDebit for invoices", async () => {
    const c = await connect();
    const result = await c.call("summarize_documents", {
      documentType: "invoices",
      creditDebit: "D",
      ...MARCH,
    });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("creditDebit applies to vouchers only");
  });

  it(`stops at ${MAX_AUDIT_DOCUMENTS} documents and marks the answer truncated`, async () => {
    api.server.use(
      http.get(sevdeskUrl("/Voucher"), () =>
        HttpResponse.json(list(Array.from({ length: 100 }, () => voucher()))),
      ),
    );
    const c = await connect();
    const data = structured<{ documents: number; truncated: boolean; note: string }>(
      await c.call("summarize_documents", { documentType: "vouchers", ...MARCH }),
    );
    // 20 pages plus one probe of a single object after the cap.
    expect(requestsTo("/Voucher")).toHaveLength(MAX_AUDIT_DOCUMENTS / 100 + 1);
    expect(queryOf(requestsTo("/Voucher").at(-1))).toMatchObject({
      limit: "1",
      offset: String(MAX_AUDIT_DOCUMENTS),
    });
    expect(data.documents).toBe(MAX_AUDIT_DOCUMENTS);
    expect(data.truncated).toBe(true);
    expect(data.note).toContain(`first ${MAX_AUDIT_DOCUMENTS} vouchers`);
  });

  it("does not report the cap when exactly the cap exists", async () => {
    const vouchers = Array.from({ length: MAX_AUDIT_DOCUMENTS }, (_, i) =>
      voucher({ id: String(i + 1) }),
    );
    api.server.use(http.get(sevdeskUrl("/Voucher"), paged(vouchers)));
    const c = await connect();
    const data = structured<{ documents: number; truncated: boolean }>(
      await c.call("summarize_documents", { documentType: "vouchers", ...MARCH }),
    );
    expect(data.documents).toBe(MAX_AUDIT_DOCUMENTS);
    expect(data.truncated).toBe(false);
  });

  it("keeps what was read when a later page fails, fails when the first does", async () => {
    api.server.use(
      http.get(sevdeskUrl("/Voucher"), ({ request }) =>
        new URL(request.url).searchParams.get("offset") === "0"
          ? HttpResponse.json(list(Array.from({ length: 100 }, () => voucher())))
          : sevdeskError(500),
      ),
    );
    const c = await connect();
    const data = structured<{ documents: number; truncated: boolean; note: string }>(
      await c.call("summarize_documents", { documentType: "vouchers", ...MARCH }),
    );
    expect(data.documents).toBe(100);
    expect(data.truncated).toBe(true);
    expect(data.note).toMatch(/Reading vouchers failed \(\w+ 500\)/);

    api.server.use(http.get(sevdeskUrl("/Voucher"), () => sevdeskError(500)));
    const failed = await c.call("summarize_documents", { documentType: "vouchers", ...MARCH });
    expect(failed.isError).toBe(true);
  });
});

describe("list_open_receivables aging", () => {
  it("adds an aging bucket per receivable and open amounts per bucket", async () => {
    const today = todayIso();
    const dated = (days: number) => `${addDays(today, -days)}T00:00:00+01:00`;
    api.server.use(
      http.get(sevdeskUrl("/Invoice"), ({ request }) =>
        HttpResponse.json(
          new URL(request.url).searchParams.get("status") === "200"
            ? list([
                invoice({ id: "1", invoiceDate: dated(0), timeToPay: "14" }),
                invoice({ id: "2", invoiceDate: dated(54), timeToPay: "14" }),
                invoice({ id: "3", invoiceDate: dated(124), timeToPay: "14", sumGross: "200" }),
              ])
            : list([]),
        ),
      ),
    );
    const c = await connect();
    const data = structured<{
      receivables: Array<{ id: number; agingBucket: string; daysOverdue: number }>;
      aging: Array<{ bucket: string; count: number; openAmount: number }>;
    }>(await c.call("list_open_receivables", {}));
    expect(data.receivables.map((r) => [r.id, r.agingBucket, r.daysOverdue])).toEqual([
      [3, "over_90", 110],
      [2, "31-60", 40],
      [1, "not_due", 0],
    ]);
    expect(data.aging.map((a) => [a.bucket, a.count, a.openAmount])).toEqual([
      ["not_due", 1, 119],
      ["0-30", 0, 0],
      ["31-60", 1, 119],
      ["61-90", 0, 0],
      ["over_90", 1, 200],
    ]);
  });
});
