import { describe, expect, it } from "vitest";
import { checkAccount, list, part, receiptGuide, transaction } from "../../fixtures/sevdesk.js";
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

describe("list_bank_accounts", () => {
  it("returns accounts with balance and status", async () => {
    api.server.use(
      http.get(sevdeskUrl("/CheckAccount"), () =>
        HttpResponse.json(
          list(
            [
              checkAccount(),
              checkAccount({
                id: "9002",
                name: "Kasse",
                type: "register",
                status: "0",
                balance: "",
              }),
            ],
            2,
          ),
        ),
      ),
    );
    const c = await connect();
    const result = await c.call("list_bank_accounts", {});
    const data = structured<{ accounts: Array<Record<string, unknown>> }>(result);
    expect(queryOf(api.requests[0])).toEqual({ limit: "25", offset: "0", countAll: "true" });
    expect(data.accounts[0]).toEqual({
      id: 9001,
      name: "Geschäftskonto",
      iban: "DE00 0000 0000 0000 0000 00",
      bic: "XXXXDEXXXXX",
      type: "online",
      currency: "EUR",
      balance: 12345.67,
      status: 100,
      statusName: "active",
      defaultAccount: true,
      accountingNumber: "1800",
      lastSync: "2026-03-01",
    });
    expect(data.accounts[1]).toMatchObject({ statusName: "archived", balance: null });
    expect(textOf(result).split("\n")[0]).toBe(
      "2 of 2 accounts (offset 0). Geschäftskonto: 12345.67 EUR.",
    );
  });

  it("reports 401, 404 and 429 as tool errors", async () => {
    await expectHttpErrors(api, "get", "/CheckAccount", "list_bank_accounts", {});
  });
});

describe("search_transactions", () => {
  it("maps filters, sends date-times and adds the account currency", async () => {
    api.server.use(
      http.get(sevdeskUrl("/CheckAccountTransaction"), () =>
        HttpResponse.json(
          list([transaction(), transaction({ id: "9502", amount: "-50", status: "400" })], 2),
        ),
      ),
      http.get(sevdeskUrl("/CheckAccount"), () => HttpResponse.json(list([checkAccount()]))),
    );
    const c = await connect();
    const data = structured<{ transactions: Array<Record<string, unknown>> }>(
      await c.call("search_transactions", {
        checkAccountId: 9001,
        startDate: "2026-02-01",
        endDate: "2026-08-31",
        purpose: "RE-1001",
        payeePayerName: "Muster",
        booked: false,
        direction: "incoming",
      }),
    );
    expect(api.requests.map(pathOf)).toEqual(["/CheckAccountTransaction", "/CheckAccount"]);
    expect(queryOf(api.requests[0])).toEqual({
      "checkAccount[id]": "9001",
      "checkAccount[objectName]": "CheckAccount",
      startDate: "2026-02-01T00:00:00+01:00",
      endDate: "2026-08-31T23:59:59+02:00",
      paymtPurpose: "RE-1001",
      payeePayerName: "Muster",
      isBooked: "false",
      onlyCredit: "true",
      limit: "25",
      offset: "0",
      countAll: "true",
    });
    expect(data.transactions[0]).toEqual({
      id: 9501,
      valueDate: "2026-02-28",
      entryDate: "2026-02-28",
      amount: 119,
      currency: "EUR",
      purpose: "RE-1001 Muster GmbH",
      payeePayerName: "Muster GmbH",
      payeePayerAccount: "DE00000000000000000000",
      checkAccountId: 9001,
      status: 100,
      statusName: "created",
      enshrined: false,
    });
    expect(data.transactions[1]).toMatchObject({ amount: -50, statusName: "booked" });
  });

  it("asks sevdesk for outgoing money only and skips the account lookup when empty", async () => {
    api.server.use(
      http.get(sevdeskUrl("/CheckAccountTransaction"), () => HttpResponse.json(list([], 0))),
    );
    const c = await connect();
    await c.call("search_transactions", { direction: "outgoing", booked: true });
    expect(queryOf(api.requests[0])).toMatchObject({ onlyDebit: "true", isBooked: "true" });
    expect(api.requests).toHaveLength(1);
  });

  it("reports 401, 404 and 429 as tool errors", async () => {
    await expectHttpErrors(api, "get", "/CheckAccountTransaction", "search_transactions", {});
  });
});

describe("search_parts", () => {
  it("filters by number and name and maps prices", async () => {
    api.server.use(http.get(sevdeskUrl("/Part"), () => HttpResponse.json(list([part()], 1))));
    const c = await connect();
    const data = structured<{ parts: unknown[] }>(
      await c.call("search_parts", { partNumber: "ART-001", name: "Beratung" }),
    );
    expect(queryOf(api.requests[0])).toEqual({
      partNumber: "ART-001",
      name: "Beratung",
      limit: "25",
      offset: "0",
      countAll: "true",
    });
    expect(data.parts).toEqual([
      {
        id: 9801,
        partNumber: "ART-001",
        name: "Beratungsstunde",
        text: "Eine Stunde Beratung",
        unityId: 9,
        priceNet: 100,
        priceGross: 119,
        pricePurchase: null,
        taxRate: 19,
        stock: 0,
        stockEnabled: false,
        status: 100,
        statusName: "active",
      },
    ]);
  });

  it("reports 401, 404 and 429 as tool errors", async () => {
    await expectHttpErrors(api, "get", "/Part", "search_parts", {});
  });
});

describe("get_tax_guidance", () => {
  it("calls the endpoint for each scope and pages the list itself", async () => {
    const guides = Array.from({ length: 30 }, (_, i) => receiptGuide({ accountDatevId: i + 1 }));
    for (const path of [
      "forAllAccounts",
      "forRevenue",
      "forExpense",
      "forAccountNumber",
      "forTaxRule",
    ]) {
      api.server.use(
        http.get(sevdeskUrl(`/ReceiptGuidance/${path}`), () =>
          HttpResponse.json({ objects: guides }),
        ),
      );
    }
    const c = await connect();
    const all = structured<{ accounts: Array<Record<string, unknown>>; page: unknown }>(
      await c.call("get_tax_guidance", { limit: 10, offset: 20 }),
    );
    expect(all.page).toEqual({ offset: 20, limit: 10, count: 10, total: 30, hasMore: false });
    expect(all.accounts[0]).toEqual({
      accountDatevId: 21,
      accountNumber: "4400",
      accountName: "Erlöse 19 % USt",
      description: "Einnahmen aus dem Verkauf von Waren und Dienstleistungen",
      allowedTaxRules: [
        {
          id: 1,
          name: "USTPFL_UMS_EINN",
          description: "Umsatzsteuerpflichtige Umsätze",
          taxRates: ["NINETEEN"],
        },
      ],
      allowedReceiptTypes: ["REVENUE"],
    });
    await c.call("get_tax_guidance", { scope: "revenue" });
    await c.call("get_tax_guidance", { scope: "expense" });
    await c.call("get_tax_guidance", { scope: "account", accountNumber: 4400 });
    await c.call("get_tax_guidance", { scope: "tax_rule", taxRule: 9 });
    expect(api.requests.map(pathOf)).toEqual([
      "/ReceiptGuidance/forAllAccounts",
      "/ReceiptGuidance/forRevenue",
      "/ReceiptGuidance/forExpense",
      "/ReceiptGuidance/forAccountNumber",
      "/ReceiptGuidance/forTaxRule",
    ]);
    expect(queryOf(api.requests[3])).toEqual({ accountNumber: "4400" });
    expect(queryOf(api.requests[4])).toEqual({ taxRule: "9" });
  });

  it("requires the parameter of a narrowed scope", async () => {
    const c = await connect();
    expect(textOf(await c.call("get_tax_guidance", { scope: "account" }))).toBe(
      "scope account needs accountNumber.",
    );
    expect(textOf(await c.call("get_tax_guidance", { scope: "tax_rule" }))).toBe(
      "scope tax_rule needs taxRule.",
    );
    expect(api.requests).toEqual([]);
  });

  it("reports 401, 404 and 429 as tool errors", async () => {
    await expectHttpErrors(api, "get", "/ReceiptGuidance/forAllAccounts", "get_tax_guidance", {});
  });
});
