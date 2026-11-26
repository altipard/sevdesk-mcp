import { delay } from "msw";
import { afterEach, describe, expect, it, vi } from "vitest";
import { NAME_LOOKUP_TIMEOUT_MS } from "../../../src/tools/contacts.js";
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
    // The scan saw every contact, so sevdesk's name filter is not asked.
    expect(api.requests).toHaveLength(1);
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
    // Five scan pages, then one request with sevdesk's name filter.
    expect(api.requests).toHaveLength(6);
    expect(queryOf(api.requests[5])).toEqual({
      depth: "1",
      name: "muster",
      limit: "100",
      offset: "0",
    });
    expect(data.scan).toMatchObject({ checked: 500, truncated: true });
    expect(String(data.scan?.note)).toContain("first 500 contacts");
    expect(data.page).toEqual({ offset: 0, limit: 5, count: 5, total: 500, hasMore: true });
  });

  /** 500 contacts named "Firma n", of which only id 3 matches "muster". */
  const scanPages = (request: Request) => {
    const offset = Number(new URL(request.url).searchParams.get("offset"));
    return HttpResponse.json(
      list(
        Array.from({ length: 100 }, (_, i) => {
          const id = offset + i + 1;
          return contact({ id: String(id), name: id === 3 ? "Muster GmbH" : `Firma ${id}` });
        }),
      ),
    );
  };

  it("adds organisations found by sevdesk's name filter beyond the scan limit", async () => {
    api.server.use(
      http.get(sevdeskUrl("/Contact"), ({ request }) => {
        if (!new URL(request.url).searchParams.has("name")) return scanPages(request);
        return HttpResponse.json(
          list([
            contact({ id: "3", name: "Muster GmbH" }),
            contact({ id: "9001", name: "Zebra Muster AG" }),
            contact({ id: "9002", name: "Unrelated KG" }),
          ]),
        );
      }),
    );
    const c = await connect();
    const data = structured<Search>(
      await c.call("search_contacts", { query: "Müster", includePersons: false }),
    );
    // Sent as typed; only the local re-match folds accents.
    expect(queryOf(api.requests[5])).toMatchObject({ depth: "0", name: "Müster" });
    expect(data.contacts.map((x) => x.id)).toEqual([3, 9001]);
    expect(data.page).toMatchObject({ count: 2, total: 2, hasMore: false });
    expect(data.scan).toMatchObject({ mode: "name", checked: 500, truncated: true });
    expect(String(data.scan?.note)).toContain("name filter found 1 more organisations");
    expect(String(data.scan?.note)).toContain("may miss umlaut and spelling variants");
    expect(String(data.scan?.note)).not.toContain("first 100 results");

    const second = structured<Search>(
      await c.call("search_contacts", { query: "muster", limit: 1, offset: 1 }),
    );
    expect(second.contacts.map((x) => x.id)).toEqual([9001]);
  });

  it("adds no duplicates or false matches if sevdesk ignores the name filter", async () => {
    api.server.use(http.get(sevdeskUrl("/Contact"), ({ request }) => scanPages(request)));
    const c = await connect();
    const data = structured<Search>(await c.call("search_contacts", { query: "muster" }));
    expect(api.requests).toHaveLength(6);
    expect(data.contacts.map((x) => x.id)).toEqual([3]);
    expect(String(data.scan?.note)).toContain(
      "name filter found 0 more organisations beyond them (first 100 results only)",
    );
  });

  it("falls back to the plain scan if sevdesk refuses the name filter", async () => {
    api.server.use(
      http.get(sevdeskUrl("/Contact"), ({ request }) => {
        if (!new URL(request.url).searchParams.has("name")) return scanPages(request);
        return HttpResponse.json({ error: { message: "unknown parameter" } }, { status: 400 });
      }),
    );
    const c = await connect();
    const result = await c.call("search_contacts", { query: "muster" });
    expect(result.isError).toBeFalsy();
    const data = structured<Search>(result);
    expect(api.requests).toHaveLength(6);
    expect(data.contacts.map((x) => x.id)).toEqual([3]);
    expect(data.scan).toEqual({
      mode: "name",
      checked: 500,
      truncated: true,
      note:
        "Checked the first 500 contacts only; later ones may match too. " +
        "Use customerNumber or a more specific query. " +
        "sevdesk's name filter failed (bad_request 400), so only the scan was used.",
    });
  });

  it("falls back to the plain scan on a server error from the name filter", async () => {
    // sevdesk answers some invalid input with 500; the lookup is optional.
    api.server.use(
      http.get(sevdeskUrl("/Contact"), ({ request }) => {
        if (!new URL(request.url).searchParams.has("name")) return scanPages(request);
        return HttpResponse.json({ error: { message: "secret upstream text" } }, { status: 500 });
      }),
    );
    const c = await connect();
    const result = await c.call("search_contacts", { query: "muster" });
    expect(result.isError).toBeFalsy();
    const data = structured<Search>(result);
    expect(data.contacts.map((x) => x.id)).toEqual([3]);
    expect(String(data.scan?.note)).toContain(
      "sevdesk's name filter failed (server_error 500), so only the scan was used.",
    );
    expect(textOf(result)).not.toContain("secret upstream text");
  });

  describe("name filter time limit", () => {
    afterEach(() => {
      vi.restoreAllMocks();
    });

    /** Shortens only the name filter's own limit; the client's timeouts stay real. */
    function shortenLookupLimit(ms: number) {
      const timeout = AbortSignal.timeout.bind(AbortSignal);
      return vi
        .spyOn(AbortSignal, "timeout")
        .mockImplementation((limit) => timeout(limit === NAME_LOOKUP_TIMEOUT_MS ? ms : limit));
    }

    it("falls back to the scan when the name filter hangs", async () => {
      const spy = shortenLookupLimit(50);
      api.server.use(
        http.get(sevdeskUrl("/Contact"), async ({ request }) => {
          if (!new URL(request.url).searchParams.has("name")) return scanPages(request);
          await delay("infinite");
          return HttpResponse.json(list([]));
        }),
      );
      const c = await connect();
      const result = await c.call("search_contacts", { query: "muster" });
      expect(result.isError, textOf(result)).toBeFalsy();
      const data = structured<Search>(result);
      expect(spy).toHaveBeenCalledWith(NAME_LOOKUP_TIMEOUT_MS);
      // One lookup attempt, not retried after the abort.
      expect(api.requests.filter((r) => new URL(r.url).searchParams.has("name"))).toHaveLength(1);
      expect(data.contacts.map((x) => x.id)).toEqual([3]);
      expect(data.scan).toMatchObject({ mode: "name", checked: 500, truncated: true });
      expect(String(data.scan?.note)).toContain(
        "sevdesk's name filter did not answer within 10 s, so only the scan was used.",
      );
    });

    it("does not retry the name filter on a retryable status", async () => {
      api.server.use(
        http.get(sevdeskUrl("/Contact"), ({ request }) => {
          if (!new URL(request.url).searchParams.has("name")) return scanPages(request);
          return HttpResponse.json({ error: { message: "busy" } }, { status: 503 });
        }),
      );
      const c = await connect();
      const data = structured<Search>(await c.call("search_contacts", { query: "muster" }));
      expect(api.requests.filter((r) => new URL(r.url).searchParams.has("name"))).toHaveLength(1);
      expect(data.contacts.map((x) => x.id)).toEqual([3]);
      expect(String(data.scan?.note)).toContain("sevdesk's name filter failed (");
      expect(String(data.scan?.note)).toContain("503), so only the scan was used.");
    });
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
    expect(queryOf(api.requests[0])).toEqual({ type: "EMAIL", limit: "100", offset: "0" });
    expect(data.contacts).toEqual([
      expect.objectContaining({ id: 2001, matchedEmail: "buchhaltung@muster.example" }),
    ]);
    expect(data.scan).toEqual({ mode: "email", checked: 2, truncated: false });
  });

  it("pages through e-mail addresses up to the scan limit and says so", async () => {
    api.server.use(
      http.get(sevdeskUrl("/CommunicationWay"), ({ request }) => {
        const offset = Number(new URL(request.url).searchParams.get("offset"));
        return HttpResponse.json(
          list(
            Array.from({ length: 100 }, (_, i) =>
              communicationWay({
                id: String(7000 + offset + i),
                value: `x${offset + i}@other.example`,
                contact: { id: String(3000 + offset + i), objectName: "Contact" },
              }),
            ),
          ),
        );
      }),
    );
    const c = await connect();
    const data = structured<Search>(await c.call("search_contacts", { query: "@muster" }));
    expect(api.requests.map((r) => queryOf(r).offset)).toEqual(["0", "100", "200", "300", "400"]);
    expect(data.contacts).toEqual([]);
    expect(data.scan).toMatchObject({ mode: "email", checked: 500, truncated: true });
    expect(String(data.scan?.note)).toContain("first 500 e-mail addresses");
  });

  it("skips matches whose contact is gone instead of failing", async () => {
    api.server.use(
      http.get(sevdeskUrl("/CommunicationWay"), () =>
        HttpResponse.json(
          list([
            communicationWay(),
            communicationWay({ id: "6009", value: "alt@muster.example", contact: { id: "2009" } }),
          ]),
        ),
      ),
      http.get(sevdeskUrl("/Contact/2001"), () => HttpResponse.json(list([contact()]))),
      http.get(sevdeskUrl("/Contact/2009"), () =>
        HttpResponse.json({ error: { message: "gone" } }, { status: 404 }),
      ),
    );
    const c = await connect();
    const data = structured<Search>(await c.call("search_contacts", { query: "@muster" }));
    expect(data.contacts.map((x) => x.id)).toEqual([2001]);
    expect(String(data.scan?.note)).toContain("1 matching contacts no longer exist");
  });

  it("leaves persons out when includePersons is false, in every mode", async () => {
    api.server.use(
      http.get(sevdeskUrl("/CommunicationWay"), () =>
        HttpResponse.json(
          list([
            communicationWay({ contact: { id: "2002" }, value: "erika@muster.example" }),
            communicationWay(),
          ]),
        ),
      ),
      http.get(sevdeskUrl("/Contact/2001"), () => HttpResponse.json(list([contact()]))),
      http.get(sevdeskUrl("/Contact/2002"), () => HttpResponse.json(list([person()]))),
      http.get(sevdeskUrl("/Contact"), () => HttpResponse.json(list([contact()]))),
    );
    const c = await connect();
    const withPersons = structured<Search>(await c.call("search_contacts", { query: "@muster" }));
    expect(withPersons.contacts.map((x) => x.id)).toEqual([2001, 2002]);
    const orgsOnly = structured<Search>(
      await c.call("search_contacts", { query: "@muster", includePersons: false }),
    );
    expect(orgsOnly.contacts.map((x) => x.id)).toEqual([2001]);
    expect(orgsOnly.page).toMatchObject({ total: null, hasMore: false });
    await c.call("search_contacts", { query: "muster", includePersons: false });
    expect(queryOf(api.requests.at(-1))).toMatchObject({ depth: "0" });
  });

  it("bounds the contact look-ups when persons are filtered out", async () => {
    api.server.use(
      http.get(sevdeskUrl("/CommunicationWay"), () =>
        HttpResponse.json(
          list(
            Array.from({ length: 99 }, (_, i) =>
              communicationWay({ id: String(i + 1), contact: { id: String(5000 + i) } }),
            ).concat(
              Array.from({ length: 50 }, (_, i) =>
                communicationWay({ id: String(i + 200), contact: { id: String(6000 + i) } }),
              ),
            ),
          ),
        ),
      ),
      http.get(sevdeskUrl("/Contact/:id"), ({ params }) =>
        HttpResponse.json(list([person({ id: String(params.id) })])),
      ),
    );
    const c = await connect();
    const data = structured<Search>(
      await c.call("search_contacts", { query: "@muster", includePersons: false }),
    );
    const lookups = api.requests.filter((r) => /\/Contact\/\d+$/.test(r.url));
    expect(lookups).toHaveLength(100);
    expect(data.contacts).toEqual([]);
    expect(data.scan).toMatchObject({ truncated: true });
    expect(String(data.scan?.note)).toContain("Stopped after looking up 100 contacts");
  });

  describe("includePersons=false beyond the look-up budget", () => {
    // 130 matching organisations, all found by the e-mail scan (no scan cut-off).
    const matches = Array.from({ length: 130 }, (_, i) => i);
    function mockOrganisations() {
      api.server.use(
        http.get(sevdeskUrl("/CommunicationWay"), ({ request }) => {
          const offset = Number(new URL(request.url).searchParams.get("offset"));
          return HttpResponse.json(
            list(
              matches
                .slice(offset, offset + 100)
                .map((i) =>
                  communicationWay({ id: String(i + 1), contact: { id: String(5000 + i) } }),
                ),
            ),
          );
        }),
        http.get(sevdeskUrl("/Contact/:id"), ({ params }) =>
          HttpResponse.json(list([contact({ id: String(params.id) })])),
        ),
      );
    }

    it("says it cannot page further instead of promising more", async () => {
      mockOrganisations();
      const c = await connect();
      const data = structured<Search>(
        await c.call("search_contacts", {
          query: "@muster",
          includePersons: false,
          offset: 100,
          limit: 25,
        }),
      );
      expect(data.contacts).toEqual([]);
      expect(data.page).toMatchObject({ offset: 100, count: 0, total: null, hasMore: false });
      expect(data.scan).toMatchObject({ truncated: true });
      expect(String(data.scan?.note)).toContain("Stopped after looking up 100 contacts");
      expect(String(data.scan?.note)).toContain("cannot be paged to");
      expect(String(data.scan?.note)).toContain("Narrow the query");
    });

    it("returns the reachable part of a page that straddles the budget", async () => {
      mockOrganisations();
      const c = await connect();
      const data = structured<Search>(
        await c.call("search_contacts", {
          query: "@muster",
          includePersons: false,
          offset: 90,
          limit: 25,
        }),
      );
      expect(data.contacts).toHaveLength(10);
      expect(data.page).toMatchObject({ count: 10, hasMore: false });
      expect(data.scan).toMatchObject({ truncated: true });
    });

    it("still reports more when the next page is within the budget", async () => {
      mockOrganisations();
      const c = await connect();
      const data = structured<Search>(
        await c.call("search_contacts", { query: "@muster", includePersons: false, limit: 25 }),
      );
      expect(data.contacts).toHaveLength(25);
      expect(data.page).toMatchObject({ hasMore: true });
      expect(data.scan).toMatchObject({ truncated: false });
    });

    it("offers no next page when the page fills on the last allowed look-up", async () => {
      mockOrganisations();
      const c = await connect();
      const data = structured<Search>(
        await c.call("search_contacts", { query: "@muster", includePersons: false, limit: 100 }),
      );
      // 100 look-ups fill the page; 30 matches remain but cannot be reached.
      expect(data.contacts).toHaveLength(100);
      expect(data.page).toMatchObject({ hasMore: false });
      expect(data.scan).toMatchObject({ truncated: true });
    });
  });

  it("cuts an oversized page to the response budget and says so", async () => {
    const long = "m".repeat(2000);
    api.server.use(
      http.get(sevdeskUrl("/Contact"), () =>
        HttpResponse.json(
          list(
            Array.from({ length: 100 }, (_, i) =>
              contact({ id: String(9000 + i), name: long, surename: long, familyname: long }),
            ),
            250,
          ),
        ),
      ),
    );
    const c = await connect();
    const result = await c.call("search_contacts", { limit: 100 });
    const data = structured<Search & { truncated?: boolean; note?: string }>(result);
    expect(data.contacts.length).toBeGreaterThan(0);
    expect(data.contacts.length).toBeLessThan(100);
    expect(data.truncated).toBe(true);
    expect(data.note).toContain("Answer cut");
    expect(data.page).toMatchObject({ count: data.contacts.length, total: 250, hasMore: true });
    const [first, second] = textOf(result).split("\n");
    expect(first).toContain("cut to fit");
    expect(JSON.parse(second ?? "")).toEqual(data);
    expect(textOf(result).length).toBeLessThanOrEqual(100_000);
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
    expect(textOf(result).split("\n")[0]).toBe("Contact 2001: 1 addresses, 2 communication ways.");
  });

  it("treats an empty answer as not found", async () => {
    api.server.use(http.get(sevdeskUrl("/Contact/8"), () => HttpResponse.json({ objects: [] })));
    const c = await connect();
    const result = await c.call("get_contact", { contactId: 8 });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toBe("sevdesk has no contact with ID 8.");
    expect(api.requests).toHaveLength(1);
  });

  it.each([400, 422])("retries once without the embed when sevdesk answers %i", async (status) => {
    api.server.use(
      http.get(sevdeskUrl("/Contact/2001"), ({ request }) =>
        new URL(request.url).searchParams.has("embed")
          ? HttpResponse.json({ error: { message: "unknown embed" } }, { status })
          : HttpResponse.json(list([contact()])),
      ),
      http.get(sevdeskUrl("/CommunicationWay"), () => HttpResponse.json(list([]))),
    );
    const c = await connect();
    const data = structured<{ contact: { id: number }; addresses: unknown[]; note?: string }>(
      await c.call("get_contact", { contactId: 2001 }),
    );
    expect(api.requests.map((r) => queryOf(r))).toEqual([
      { embed: "addresses" },
      {},
      { "contact[id]": "2001", "contact[objectName]": "Contact" },
    ]);
    expect(data.contact.id).toBe(2001);
    expect(data.addresses).toEqual([]);
    expect(data.note).toContain("refused to embed the addresses");
  });

  it("does not retry other failures and stops after one retry", async () => {
    api.server.use(
      http.get(sevdeskUrl("/Contact/2001"), () =>
        HttpResponse.json({ error: { message: "bad" } }, { status: 400 }),
      ),
    );
    const c = await connect();
    const result = await c.call("get_contact", { contactId: 2001 });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("(400)");
    expect(api.requests).toHaveLength(2);
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
