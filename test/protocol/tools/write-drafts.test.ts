import { describe, expect, it } from "vitest";
import {
  address,
  contact,
  invoice,
  list,
  order,
  part,
  receiptGuide,
} from "../../fixtures/sevdesk.js";
import {
  HttpResponse,
  http,
  queryOf,
  sevdeskError,
  sevdeskUrl,
  structured,
  textOf,
} from "../../support/harness.js";
import {
  bodyOf,
  connectWrites,
  mockSevdeskWrites,
  operations,
} from "../../support/write-harness.js";

const api = mockSevdeskWrites();

const guidance = (rules: Array<{ id: number; taxRates: string[] }>) =>
  http.get(sevdeskUrl("/ReceiptGuidance/forRevenue"), () =>
    HttpResponse.json({
      objects: [
        receiptGuide({
          allowedTaxRules: rules.map((rule) => ({ name: `R${rule.id}`, description: "", ...rule })),
        }),
      ],
    }),
  );
const STANDARD_GUIDANCE = [
  { id: 1, taxRates: ["ZERO", "SEVEN", "NINETEEN"] },
  { id: 2, taxRates: ["ZERO"] },
];

const contactWith = (addresses: unknown[]) =>
  http.get(sevdeskUrl("/Contact/2001"), () =>
    HttpResponse.json(list([{ ...contact(), addresses }])),
  );

const draftInvoice = (overrides: Record<string, unknown> = {}) =>
  invoice({
    id: "1101",
    invoiceNumber: null,
    status: "100",
    sendDate: null,
    sumNet: "250",
    sumGross: "297.5",
    ...overrides,
  });

const savedInvoice = (overrides: Record<string, unknown> = {}) =>
  http.post(sevdeskUrl("/Invoice/Factory/saveInvoice"), () =>
    HttpResponse.json(
      { objects: { invoice: draftInvoice(overrides), invoicePos: [] } },
      { status: 201 },
    ),
  );

const latestInvoice = http.get(sevdeskUrl("/Invoice"), () => HttpResponse.json(list([invoice()])));

const POSITIONS = [
  { name: "Beratung", quantity: 2, priceNet: 100, taxRate: 19 },
  { partId: 9801, quantity: 0.5 },
];

describe("create_invoice_draft", () => {
  it("creates a draft with free and article positions, the contact's address and a derived contact person", async () => {
    api.server.use(
      http.get(sevdeskUrl("/Part/9801"), () => HttpResponse.json(list([part()]))),
      guidance(STANDARD_GUIDANCE),
      contactWith([address()]),
      latestInvoice,
      savedInvoice(),
    );
    const c = await connectWrites({ config: { mode: "write" } });
    const result = await c.call("create_invoice_draft", {
      contactId: 2001,
      positions: POSITIONS,
      invoiceDate: "2026-03-10",
      deliveryDate: "2026-03-09",
      timeToPay: 14,
    });
    const data = structured<Record<string, unknown>>(result);
    expect(operations(api)).toEqual([
      "GET getPartById",
      "GET forRevenue",
      "GET getContactById",
      "GET getInvoices",
      "POST createInvoiceByFactory",
    ]);
    expect(queryOf(api.requests[2])).toEqual({ embed: "addresses" });
    expect(queryOf(api.requests[3])).toEqual({ limit: "1", offset: "0", countAll: "true" });
    expect(await bodyOf(api, "createInvoiceByFactory")).toEqual({
      invoice: {
        objectName: "Invoice",
        mapAll: true,
        contact: { id: 2001, objectName: "Contact" },
        contactPerson: { id: 3001, objectName: "SevUser" },
        status: 100,
        address: "Muster GmbH\nBeispielweg 1\n12345 Musterstadt",
        addressCountry: { id: 1, objectName: "StaticCountry" },
        taxRate: 0,
        taxRule: { id: 1, objectName: "TaxRule" },
        taxText: "Umsatzsteuer",
        currency: "EUR",
        showNet: true,
        invoiceDate: "10.03.2026",
        deliveryDate: "09.03.2026",
        timeToPay: 14,
        discount: 0,
        invoiceType: "RE",
      },
      invoicePosSave: [
        {
          objectName: "InvoicePos",
          mapAll: true,
          quantity: 2,
          price: 100,
          priceNet: 100,
          taxRate: 19,
          name: "Beratung",
          unity: { id: 1, objectName: "Unity" },
          positionNumber: 1,
        },
        {
          objectName: "InvoicePos",
          mapAll: true,
          part: { id: 9801, objectName: "Part" },
          quantity: 0.5,
          price: 100,
          priceNet: 100,
          taxRate: 19,
          name: "Beratungsstunde",
          unity: { id: 9, objectName: "Unity" },
          positionNumber: 2,
        },
      ],
      invoicePosDelete: null,
      discountSave: [],
      discountDelete: null,
      takeDefaultAddress: false,
    });
    expect(data).toMatchObject({
      invoice: { id: 1101, status: 100, statusName: "draft", sumNet: 250 },
      contactId: 2001,
      addressId: 4001,
      contactPerson: { id: 3001, source: "invoice", sourceId: 1001 },
      taxRule: { id: 1, checkedAgainst: "guidance" },
      positions: 2,
      expectedSumNet: 250,
      warnings: [],
    });
    expect(textOf(result).split("\n")[0]).toBe(
      "Created invoice draft ID 1101 (no number yet) for contact 2001: 2 positions, net 250 EUR, " +
        "tax rule 1, contact person 3001 (from invoice 1001).",
    );
  });

  it("uses a given contact person without looking one up and warns on a net sum mismatch", async () => {
    api.server.use(
      guidance(STANDARD_GUIDANCE),
      contactWith([]),
      savedInvoice({ sumNet: "168.07" }),
    );
    const c = await connectWrites({ config: { mode: "write" } });
    const data = structured<{ contactPerson: unknown; warnings: string[] }>(
      await c.call("create_invoice_draft", {
        contactId: 2001,
        contactPersonId: 3005,
        positions: [{ name: "Pauschale", quantity: 1, priceNet: 200, taxRate: 19 }],
      }),
    );
    expect(operations(api)).not.toContain("GET getInvoices");
    expect(data.contactPerson).toEqual({ id: 3005, source: "input" });
    expect(data.warnings).toHaveLength(2);
    expect(data.warnings[0]).toContain("has no address");
    expect(data.warnings[1]).toContain("net sum of 168.07");
    const body = (await bodyOf(api, "createInvoiceByFactory")) as { invoice: { address: string } };
    expect(body.invoice.address).toBe("Muster GmbH");
  });

  it("rejects tax rates the tax rule does not allow, with a readable message and nothing sent", async () => {
    const c = await connectWrites({ config: { mode: "write" } });
    const result = await c.call("create_invoice_draft", {
      contactId: 2001,
      taxRule: 11,
      positions: [{ name: "Leistung", quantity: 1, priceNet: 100, taxRate: 19 }],
    });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toBe(
      "Tax rule 11 (Steuer nicht erhoben nach §19 UStG (Kleinunternehmer)) allows tax rates " +
        "0 % in positions, not 19 %. Change the tax rate of those positions or choose another " +
        "tax rule (see get_tax_guidance).",
    );
    expect(api.requests).toHaveLength(0);
  });

  it("rejects a tax rule the account's guidance does not allow", async () => {
    api.server.use(guidance([{ id: 11, taxRates: ["ZERO"] }]));
    const c = await connectWrites({ config: { mode: "write" } });
    const result = await c.call("create_invoice_draft", {
      contactId: 2001,
      positions: [{ name: "Leistung", quantity: 1, priceNet: 100, taxRate: 19 }],
    });
    expect(textOf(result)).toContain(
      "This sevdesk account does not allow tax rule 1 (Umsatzsteuerpflichtige Umsätze) for revenue. Allowed: 11",
    );
    expect(operations(api)).toEqual(["GET forRevenue"]);
  });

  it("rejects a rate the guidance does not list for the rule", async () => {
    api.server.use(guidance([{ id: 1, taxRates: ["ZERO", "NINETEEN"] }]));
    const c = await connectWrites({ config: { mode: "write" } });
    const result = await c.call("create_invoice_draft", {
      contactId: 2001,
      positions: [{ name: "Buch", quantity: 1, priceNet: 10, taxRate: 7 }],
    });
    expect(textOf(result)).toContain("sevdesk allows tax rates 0 %, 19 % with tax rule 1");
  });

  it("falls back to the documented rules when the guidance cannot be read, and says so", async () => {
    api.server.use(
      http.get(sevdeskUrl("/ReceiptGuidance/forRevenue"), () => sevdeskError(500)),
      contactWith([address()]),
      latestInvoice,
      savedInvoice(),
    );
    const c = await connectWrites({ config: { mode: "write" } });
    const data = structured<{ taxRule: unknown; warnings: string[] }>(
      await c.call("create_invoice_draft", {
        contactId: 2001,
        positions: [{ name: "X", quantity: 1, priceNet: 250, taxRate: 19 }],
      }),
    );
    expect(data.taxRule).toMatchObject({ checkedAgainst: "documented_rules" });
    expect(data.warnings[0]).toContain("could not be read (server_error)");
  });

  it("rejects incomplete positions and invalid input", async () => {
    const c = await connectWrites({ config: { mode: "write" } });
    for (const args of [
      { contactId: 2001, positions: [] },
      { contactId: 2001, positions: [{ name: "X", quantity: 1, taxRate: 19 }] },
      { contactId: 2001, positions: [{ name: "X", quantity: 0, priceNet: 1, taxRate: 19 }] },
      {
        contactId: 2001,
        taxRule: 9,
        positions: [{ name: "X", quantity: 1, priceNet: 1, taxRate: 19 }],
      },
      {
        contactId: 2001,
        invoiceDate: "2026-03-01",
        deliveryDate: "2026-03-02",
        positions: [{ name: "X", quantity: 1, priceNet: 1, taxRate: 19 }],
      },
      { positions: [{ name: "X", quantity: 1, priceNet: 1, taxRate: 19 }] },
    ]) {
      const result = await c.call("create_invoice_draft", args);
      expect(result.isError, JSON.stringify(args)).toBe(true);
      expect(textOf(result)).not.toContain("Internal error");
    }
    expect(api.requests).toHaveLength(0);
  });

  it("asks for a contact person when there is no document to take one from", async () => {
    api.server.use(
      guidance(STANDARD_GUIDANCE),
      contactWith([address()]),
      http.get(sevdeskUrl("/Invoice"), () => HttpResponse.json(list([]))),
      http.get(sevdeskUrl("/Order"), () => HttpResponse.json(list([]))),
    );
    const c = await connectWrites({ config: { mode: "write" } });
    const result = await c.call("create_invoice_draft", {
      contactId: 2001,
      positions: [{ name: "X", quantity: 1, priceNet: 1, taxRate: 19 }],
    });
    expect(textOf(result)).toContain("Pass contactPersonId");
    expect(operations(api)).not.toContain("POST createInvoiceByFactory");
  });

  it("reports sevdesk's validation error and an unknown outcome on server errors", async () => {
    api.server.use(
      guidance(STANDARD_GUIDANCE),
      contactWith([address()]),
      latestInvoice,
      http.post(sevdeskUrl("/Invoice/Factory/saveInvoice"), () => sevdeskError(422, "taxRule")),
    );
    const c = await connectWrites({ config: { mode: "write" } });
    const args = {
      contactId: 2001,
      positions: [{ name: "X", quantity: 1, priceNet: 1, taxRate: 19 }],
    };
    const invalid = await c.call("create_invoice_draft", args);
    expect(textOf(invalid)).toBe("sevdesk could not process the data (422): taxRule");
    api.server.use(http.post(sevdeskUrl("/Invoice/Factory/saveInvoice"), () => sevdeskError(503)));
    const unknown = await c.call("create_invoice_draft", args);
    expect(textOf(unknown)).toContain("The outcome is unknown: check sevdesk before retrying.");
    expect(c.audit().map((e) => e.outcome)).toEqual(["error", "error"]);
  });
});

describe("contact person and sums", () => {
  it("takes the contact person of the newest invoice: the last one sevdesk lists", async () => {
    api.server.use(
      guidance(STANDARD_GUIDANCE),
      contactWith([address()]),
      http.get(sevdeskUrl("/Invoice"), ({ request }) => {
        const offset = new URL(request.url).searchParams.get("offset");
        return offset === "2"
          ? HttpResponse.json(
              list([invoice({ id: "1003", contactPerson: { id: "3009", objectName: "SevUser" } })]),
            )
          : HttpResponse.json(list([invoice()], 3));
      }),
      savedInvoice({ sumNet: "10" }),
    );
    const c = await connectWrites({ config: { mode: "write" } });
    const result = await c.call("create_invoice_draft", {
      contactId: 2001,
      positions: [{ name: "X", quantity: 1, priceNet: 10, taxRate: 19 }],
    });
    const data = structured<{ contactPerson: unknown }>(result);
    const lists = api.requests.filter((r) => new URL(r.url).pathname.endsWith("/Invoice"));
    expect(lists.map(queryOf)).toEqual([
      { limit: "1", offset: "0", countAll: "true" },
      { limit: "1", offset: "2" },
    ]);
    expect(data.contactPerson).toEqual({ id: 3009, source: "invoice", sourceId: 1003 });
    expect(textOf(result).split("\n")[0]).toContain("contact person 3009 (from invoice 1003)");
    const body = (await bodyOf(api, "createInvoiceByFactory")) as {
      invoice: { contactPerson: unknown };
    };
    expect(body.invoice.contactPerson).toEqual({ id: 3009, objectName: "SevUser" });
  });

  it.each([
    // Three positions: up to 3 cents of rounding difference are tolerated.
    ["1.39", false],
    ["1.42", false],
    ["1.36", false],
    ["1.43", true],
    ["1.35", true],
  ])(
    "rounds each position to cents (1.39) and warns about sevdesk's sum %s: %s",
    async (sumNet, warns) => {
      api.server.use(
        guidance(STANDARD_GUIDANCE),
        contactWith([address()]),
        latestInvoice,
        savedInvoice({ sumNet }),
      );
      const c = await connectWrites({ config: { mode: "write" } });
      const data = structured<{ expectedSumNet: number; warnings: string[] }>(
        await c.call("create_invoice_draft", {
          contactId: 2001,
          positions: [
            { name: "A", quantity: 7, priceNet: 0.125, taxRate: 19 },
            { name: "B", quantity: 0.5, priceNet: 0.01, taxRate: 19 },
            { name: "C", quantity: 1.5, priceNet: 0.33, taxRate: 19 },
          ],
        }),
      );
      // 0.875 + 0.005 + 0.495 = 1.375 unrounded; per position 0.88 + 0.01 + 0.50.
      expect(data.expectedSumNet).toBe(1.39);
      expect(data.warnings.length > 0).toBe(warns);
      if (warns) {
        expect(data.warnings[0]).toBe(
          `Sum mismatch: sevdesk reports a net sum of ${Number(sumNet)}, the positions add up to ` +
            "1.39. A possible cause is that the account reads prices as gross instead of net; " +
            "check the draft in sevdesk before sending it.",
        );
      }
    },
  );
});

describe("create_order_draft", () => {
  it("creates an estimate draft and prefers the contact person of an order", async () => {
    api.server.use(
      guidance(STANDARD_GUIDANCE),
      contactWith([address()]),
      http.get(sevdeskUrl("/Order"), () => HttpResponse.json(list([order()]))),
      http.post(sevdeskUrl("/Order/Factory/saveOrder"), () =>
        HttpResponse.json(
          {
            objects: {
              order: order({ id: "7101", orderNumber: null, status: "100", sumNet: "200" }),
              orderPos: [],
            },
          },
          { status: 201 },
        ),
      ),
    );
    const c = await connectWrites({ config: { mode: "write" } });
    const result = await c.call("create_order_draft", {
      contactId: 2001,
      orderDate: "2026-04-01",
      positions: [{ name: "Workshop", quantity: 1, priceNet: 200, taxRate: 19 }],
      paymentTerms: "14 Tage netto",
    });
    const data = structured<Record<string, unknown>>(result);
    expect(operations(api)).toEqual([
      "GET forRevenue",
      "GET getContactById",
      "GET getOrders",
      "POST createOrder",
    ]);
    const body = (await bodyOf(api, "createOrder")) as Record<string, Record<string, unknown>>;
    expect(body.order).toMatchObject({
      objectName: "Order",
      status: 100,
      orderType: "AN",
      header: "Angebot",
      orderDate: "01.04.2026",
      version: 0,
      paymentTerms: "14 Tage netto",
      contactPerson: { id: 3001, objectName: "SevUser" },
    });
    expect(body.order?.sendDate).toBeUndefined();
    expect(body.orderPosSave).toHaveLength(1);
    expect(data).toMatchObject({
      order: { id: 7101, orderType: "AN", status: 100 },
      contactPerson: { id: 3001, source: "order", sourceId: 7001 },
      warnings: [],
    });
    expect(textOf(result).split("\n")[0]).toContain("Created estimate draft ID 7101");
    expect(textOf(result).split("\n")[0]).toContain("contact person 3001 (from order 7001)");
  });
});

describe("create_invoice_from_order", () => {
  it("turns an estimate into an invoice draft", async () => {
    api.server.use(
      http.get(sevdeskUrl("/Order/7001"), () => HttpResponse.json(list([order()]))),
      http.post(sevdeskUrl("/Invoice/Factory/createInvoiceFromOrder"), () =>
        HttpResponse.json({ objects: draftInvoice({ id: "1102", sumGross: "1190" }) }),
      ),
    );
    const c = await connectWrites({ config: { mode: "write" } });
    const result = await c.call("create_invoice_from_order", { orderId: 7001 });
    const data = structured<Record<string, unknown>>(result);
    expect(operations(api)).toEqual(["GET getOrderById", "POST createInvoiceFromOrder"]);
    expect(await bodyOf(api, "createInvoiceFromOrder")).toEqual({
      order: { id: 7001, objectName: "Order" },
    });
    expect(data).toMatchObject({
      orderId: 7001,
      orderType: "AN",
      invoice: { id: 1102, status: 100 },
      warnings: [],
    });
    expect(textOf(result).split("\n")[0]).toBe(
      "Created invoice ID 1102 (no number yet) (draft) from order 7001, gross 1190 EUR.",
    );
  });

  it("sends partial invoice parameters and warns when sevdesk returns no draft", async () => {
    api.server.use(
      http.get(sevdeskUrl("/Order/7001"), () =>
        HttpResponse.json(list([order({ orderType: "AB" })])),
      ),
      http.post(sevdeskUrl("/Invoice/Factory/createInvoiceFromOrder"), () =>
        HttpResponse.json({ objects: draftInvoice({ id: "1103", status: "200" }) }),
      ),
    );
    const c = await connectWrites({ config: { mode: "write" } });
    const data = structured<{ warnings: string[] }>(
      await c.call("create_invoice_from_order", {
        orderId: 7001,
        partialType: "AR",
        amountType: "percentage",
        amount: 30,
      }),
    );
    expect(await bodyOf(api, "createInvoiceFromOrder")).toEqual({
      order: { id: 7001, objectName: "Order" },
      partialType: "AR",
      type: "percentage",
      amount: 30,
    });
    expect(data.warnings[0]).toContain("not draft (100)");
  });

  it("refuses delivery notes and incomplete partial invoices before writing", async () => {
    api.server.use(
      http.get(sevdeskUrl("/Order/7001"), () =>
        HttpResponse.json(list([order({ orderType: "LI" })])),
      ),
    );
    const c = await connectWrites({ config: { mode: "write" } });
    const li = await c.call("create_invoice_from_order", { orderId: 7001 });
    expect(textOf(li)).toContain("is a delivery note (LI)");
    const partial = await c.call("create_invoice_from_order", { orderId: 7001, partialType: "TR" });
    expect(textOf(partial)).toBe("partialType TR needs amountType and amount.");
    expect(operations(api)).toEqual(["GET getOrderById"]);
  });
});

describe("draft tools and modes", () => {
  it("are not registered in read mode and are registered in write mode", async () => {
    const names = async (mode: "read" | "write") => {
      const c = await connectWrites({ config: { mode } });
      return (await c.client.listTools()).tools.map((t) => t.name);
    };
    const drafts = ["create_invoice_draft", "create_order_draft", "create_invoice_from_order"];
    const read = await names("read");
    for (const name of drafts) expect(read).not.toContain(name);
    expect(await names("write")).toEqual(expect.arrayContaining(drafts));
  });
});
