import { describe, expect, it } from "vitest";
import { address, communicationWay, contact, list, person } from "../../fixtures/sevdesk.js";
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

type Search = {
  contacts: Array<Record<string, unknown>>;
  page: Record<string, unknown>;
  scan?: Record<string, unknown>;
};

describe("search_contacts", () => {
  it("lists contacts page by page without filters", async () => {
    api.server.use(
      http.get(sevdeskUrl("/Contact"), () => HttpResponse.json(list([contact(), person()], 2))),
    );
    const c = await connect();
    const data = structured<Search>(await c.call("search_contacts", {}));
    expect(queryOf(api.requests[0])).toEqual({
      depth: "1",
      limit: "25",
      offset: "0",
      countAll: "true",
    });
    expect(data.contacts).toEqual([
      {
        id: 2001,
        customerNumber: "10001",
        name: "Muster GmbH",
        isPerson: false,
        firstName: null,
        lastName: null,
        organisationId: null,
        categoryId: 3,
        status: 1000,
        statusName: "active",
        vatNumber: "DE000000000",
      },
      expect.objectContaining({
        id: 2002,
        name: "Erika Beispiel",
        isPerson: true,
        organisationId: 2001,
      }),
    ]);
    expect(data.page).toEqual({ offset: 0, limit: 25, count: 2, total: 2, hasMore: false });
    expect(data.scan).toBeUndefined();
  });

  it("filters by customer number through the API", async () => {
    api.server.use(http.get(sevdeskUrl("/Contact"), () => HttpResponse.json(list([contact()], 1))));
    const c = await connect();
    await c.call("search_contacts", { customerNumber: "10001", includePersons: false });
    expect(queryOf(api.requests[0])).toMatchObject({ customerNumber: "10001", depth: "0" });
  });

  it("filters by name in the server, accent- and case-insensitive", async () => {
    api.server.use(
      http.get(sevdeskUrl("/Contact"), () =>
        HttpResponse.json(
          list([
            contact(),
            contact({ id: "2010", name: "Müller & Söhne OHG", customerNumber: "10010" }),
            person({ id: "2011", surename: "Hans", familyname: "Mueller" }),
          ]),
        ),
      ),
    );
    const c = await connect();
    const result = await c.call("search_contacts", { query: "MULLER" });
    const data = structured<Search>(result);
    expect(queryOf(api.requests[0])).toEqual({ depth: "1", limit: "100", offset: "0" });
    expect(data.contacts.map((x) => x.id)).toEqual([2010]);
    expect(data.scan).toEqual({ mode: "name", checked: 3, truncated: false });
    expect(textOf(result).split("\n")[0]).toBe(
      "1 of 1 matching contacts (offset 0). Checked 3 contacts.",
    );
    const full = structured<Search>(await c.call("search_contacts", { query: "hans muel" }));
    expect(full.contacts.map((x) => x.id)).toEqual([2011]);
  });

  it("stops after the scan limit and says so", async () => {
    api.server.use(
      http.get(sevdeskUrl("/Contact"), ({ request }) => {
        const offset = Number(new URL(request.url).searchParams.get("offset"));
        return HttpResponse.json(
          list(Array.from({ length: 100 }, (_, i) => contact({ id: String(offset + i + 1) }))),
        );
      }),
    );
    const c = await connect();
    const data = structured<Search>(await c.call("search_contacts", { query: "muster", limit: 5 }));
    expect(api.requests).toHaveLength(5);
    expect(data.scan).toMatchObject({ checked: 500, truncated: true });
    expect(String(data.scan?.note)).toContain("first 500 contacts");
    expect(data.page).toEqual({ offset: 0, limit: 5, count: 5, total: 500, hasMore: true });
  });

  it("searches e-mail addresses for a query with @", async () => {
    api.server.use(
      http.get(sevdeskUrl("/CommunicationWay"), () =>
        HttpResponse.json(
          list([
            communicationWay(),
            communicationWay({ id: "6002", value: "info@other.example", contact: { id: "2005" } }),
          ]),
        ),
      ),
      http.get(sevdeskUrl("/Contact/2001"), () => HttpResponse.json(list([contact()]))),
    );
    const c = await connect();
    const data = structured<Search>(await c.call("search_contacts", { query: "@MUSTER.example" }));
    expect(api.requests.map(pathOf)).toEqual(["/CommunicationWay", "/Contact/2001"]);
    expect(queryOf(api.requests[0])).toEqual({ type: "EMAIL" });
    expect(data.contacts).toEqual([
      expect.objectContaining({ id: 2001, matchedEmail: "buchhaltung@muster.example" }),
    ]);
    expect(data.scan).toEqual({ mode: "email", checked: 2, truncated: false });
  });

  it("says when the e-mail answer may have been cut", async () => {
    api.server.use(
      http.get(sevdeskUrl("/CommunicationWay"), () =>
        HttpResponse.json(
          list(
            Array.from({ length: 100 }, (_, i) =>
              communicationWay({ id: String(7000 + i), value: `x${i}@other.example` }),
            ),
          ),
        ),
      ),
    );
    const c = await connect();
    const data = structured<Search>(await c.call("search_contacts", { query: "@muster" }));
    expect(data.contacts).toEqual([]);
    expect(data.scan).toMatchObject({ mode: "email", checked: 100, truncated: true });
    expect(String(data.scan?.note)).toContain("may have more");
  });

  it("rejects query and customerNumber together, and short queries", async () => {
    const c = await connect();
    const both = await c.call("search_contacts", { query: "ab", customerNumber: "1" });
    expect(textOf(both)).toBe("Use either query or customerNumber, not both.");
    expect((await c.call("search_contacts", { query: "a" })).isError).toBe(true);
    expect(api.requests).toEqual([]);
  });

  it("reports 401, 404 and 429 as tool errors", async () => {
    await expectHttpErrors(api, "get", "/Contact", "search_contacts", {});
  });
});

describe("get_contact", () => {
  it("returns master data, embedded addresses and communication ways", async () => {
    api.server.use(
      http.get(sevdeskUrl("/Contact/2001"), () =>
        HttpResponse.json(list([{ ...contact(), addresses: [address()] }])),
      ),
      http.get(sevdeskUrl("/CommunicationWay"), () =>
        HttpResponse.json(
          list([
            communicationWay(),
            communicationWay({ id: "6003", type: "PHONE", value: "+49 30 000000", main: "0" }),
          ]),
        ),
      ),
    );
    const c = await connect();
    const result = await c.call("get_contact", { contactId: 2001 });
    const data = structured<{
      contact: Record<string, unknown>;
      addresses: unknown[];
      communicationWays: unknown[];
      note?: string;
    }>(result);
    expect(queryOf(api.requests[0])).toEqual({ embed: "addresses" });
    expect(queryOf(api.requests[1])).toEqual({
      "contact[id]": "2001",
      "contact[objectName]": "Contact",
    });
    expect(data.contact).toMatchObject({ id: 2001, defaultTimeToPay: 14, exemptVat: false });
    expect(data.addresses).toEqual([
      {
        id: 4001,
        street: "Beispielweg 1",
        zip: "12345",
        city: "Musterstadt",
        countryId: 1,
        name: null,
        categoryId: 47,
      },
    ]);
    expect(data.communicationWays).toEqual([
      { id: 6001, type: "EMAIL", value: "buchhaltung@muster.example", main: true },
      { id: 6003, type: "PHONE", value: "+49 30 000000", main: false },
    ]);
    expect(data.note).toBeUndefined();
    expect(textOf(result).split("\n")[0]).toBe(
      "Contact Muster GmbH: 1 addresses, 2 communication ways.",
    );
  });

  it("treats an empty answer as not found", async () => {
    api.server.use(http.get(sevdeskUrl("/Contact/8"), () => HttpResponse.json({ objects: [] })));
    const c = await connect();
    const result = await c.call("get_contact", { contactId: 8 });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toBe("sevdesk has no contact with ID 8.");
    expect(api.requests).toHaveLength(1);
  });

  it("says so when sevdesk does not embed the addresses", async () => {
    api.server.use(
      http.get(sevdeskUrl("/Contact/2001"), () => HttpResponse.json(list([contact()]))),
      http.get(sevdeskUrl("/CommunicationWay"), () => HttpResponse.json(list([]))),
    );
    const c = await connect();
    const data = structured<{ addresses: unknown[]; note?: string }>(
      await c.call("get_contact", { contactId: 2001 }),
    );
    expect(data.addresses).toEqual([]);
    expect(data.note).toContain("did not embed the addresses");
  });

  it("reports 401, 404 and 429 as tool errors", async () => {
    await expectHttpErrors(api, "get", "/Contact/9", "get_contact", { contactId: 9 });
  });
});
