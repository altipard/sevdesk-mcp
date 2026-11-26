import { describe, expect, it } from "vitest";
import { address, communicationWay, contact, list, person } from "../../fixtures/sevdesk.js";
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

const created = (id: number, extra: Record<string, unknown> = {}) =>
  HttpResponse.json({ objects: { id: String(id), ...extra } }, { status: 201 });

describe("create_contact", () => {
  it("creates an organisation as customer with the next customer number, address, e-mail and phone", async () => {
    api.server.use(
      http.get(sevdeskUrl("/Contact/Factory/getNextCustomerNumber"), () =>
        HttpResponse.json({ objects: "10042" }),
      ),
      http.post(sevdeskUrl("/Contact"), () => created(2101)),
      http.post(sevdeskUrl("/ContactAddress"), () => created(4101)),
      http.post(sevdeskUrl("/CommunicationWay"), async ({ request }) => {
        const body = (await request.json()) as { type: string };
        return created(body.type === "EMAIL" ? 6101 : 6102);
      }),
    );
    const c = await connectWrites({ config: { mode: "write" } });
    const result = await c.call("create_contact", {
      organisation: "Neu GmbH",
      vatNumber: "DE123456789",
      address: { street: "Hauptstr. 1", zip: "10115", city: "Berlin" },
      email: "rechnung@neu.example",
      phone: "+49 30 123456",
    });
    const data = structured<Record<string, unknown>>(result);
    expect(operations(api)).toEqual([
      "GET getNextCustomerNumber",
      "POST createContact",
      "POST createContactAddress",
      "POST createCommunicationWay",
      "POST createCommunicationWay",
    ]);
    expect(await bodyOf(api, "createContact")).toEqual({
      name: "Neu GmbH",
      category: { id: 3, objectName: "Category" },
      customerNumber: "10042",
      vatNumber: "DE123456789",
    });
    expect(await bodyOf(api, "createContactAddress")).toEqual({
      contact: { id: 2101, objectName: "Contact" },
      street: "Hauptstr. 1",
      zip: "10115",
      city: "Berlin",
      country: { id: 1, objectName: "StaticCountry" },
      category: { id: 47, objectName: "Category" },
    });
    expect(await bodyOf(api, "createCommunicationWay", 1)).toEqual({
      contact: { id: 2101, objectName: "Contact" },
      type: "PHONE",
      value: "+49 30 123456",
      key: { id: 2, objectName: "CommunicationWayKey" },
      main: true,
    });
    expect(data).toEqual({
      contactId: 2101,
      name: "Neu GmbH",
      isPerson: false,
      customerNumber: "10042",
      categoryId: 3,
      address: { id: 4101, action: "created" },
      communicationWays: [
        { id: 6101, type: "EMAIL", value: "rechnung@neu.example", action: "created" },
        { id: 6102, type: "PHONE", value: "+49 30 123456", action: "created" },
      ],
    });
    const text = textOf(result);
    expect(text.split("\n")[0]).toBe(
      "Created contact 2101 (customer number 10042) with address, 2 communication ways.",
    );
    expect(JSON.parse(text.split("\n")[1] ?? "")).toEqual(result.structuredContent);
    expect(c.audit().map((e) => [e.tool, e.outcome])).toEqual([["create_contact", "ok"]]);
  });

  it("creates a person under an organisation; a supplier gets no customer number", async () => {
    api.server.use(http.post(sevdeskUrl("/Contact"), () => created(2102)));
    const c = await connectWrites({ config: { mode: "write" } });
    const data = structured<Record<string, unknown>>(
      await c.call("create_contact", {
        firstName: "Erika",
        lastName: "Muster",
        organisationId: 2001,
        categoryId: 2,
      }),
    );
    expect(operations(api)).toEqual(["POST createContact"]);
    expect(await bodyOf(api, "createContact")).toEqual({
      surename: "Erika",
      familyname: "Muster",
      parent: { id: 2001, objectName: "Contact" },
      category: { id: 2, objectName: "Category" },
    });
    expect(data).toMatchObject({ contactId: 2102, name: "Erika Muster", isPerson: true });
  });

  it("rejects ambiguous or incomplete input before sending anything", async () => {
    const c = await connectWrites({ config: { mode: "write" } });
    for (const args of [
      {},
      { organisation: "A GmbH", firstName: "Erika" },
      { organisation: "A GmbH", organisationId: 2001 },
      { organisation: "A​GmbH" },
      { organisation: "A GmbH", email: "no-mail" },
    ]) {
      const result = await c.call("create_contact", args);
      expect(result.isError, JSON.stringify(args)).toBe(true);
    }
    expect(api.requests).toHaveLength(0);
  });

  it("names the created contact when adding the address fails, so it is not created twice", async () => {
    api.server.use(
      http.post(sevdeskUrl("/Contact"), () => created(2103)),
      http.post(sevdeskUrl("/ContactAddress"), () => sevdeskError(422, "zip invalid")),
    );
    const c = await connectWrites({ config: { mode: "write" } });
    const result = await c.call("create_contact", {
      organisation: "Teil GmbH",
      customerNumber: "K-1",
      address: { street: "Weg 2", zip: "x", city: "Ort" },
      email: "a@b.example",
    });
    expect(result.isError).toBe(true);
    const text = textOf(result);
    expect(text).toContain("Contact 2103 (Teil GmbH) was created.");
    expect(text).toContain("adding the address failed");
    expect(text).toContain("(422)");
    expect(text).toContain("Do not repeat the whole call");
    expect(operations(api)).toEqual(["POST createContact", "POST createContactAddress"]);
  });

  it("warns that the outcome is unknown when sevdesk fails with a server error", async () => {
    api.server.use(http.post(sevdeskUrl("/Contact"), () => sevdeskError(500)));
    const c = await connectWrites({ config: { mode: "write" } });
    const result = await c.call("create_contact", { organisation: "X GmbH", customerNumber: "1" });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("check sevdesk before retrying");
    expect(c.audit().at(-1)).toMatchObject({ outcome: "error", status: 500 });
  });
});

describe("update_contact", () => {
  const withAddresses = (addresses: unknown[], overrides: Record<string, unknown> = {}) =>
    http.get(sevdeskUrl("/Contact/2001"), () =>
      HttpResponse.json(list([{ ...contact(overrides), addresses }])),
    );
  const ways = (entries: unknown[]) =>
    http.get(sevdeskUrl("/CommunicationWay"), () => HttpResponse.json(list(entries)));

  it("updates master data, the only address and the only e-mail", async () => {
    api.server.use(
      withAddresses([address()]),
      ways([communicationWay()]),
      http.put(sevdeskUrl("/Contact/2001"), () => HttpResponse.json({ objects: contact() })),
      http.put(sevdeskUrl("/ContactAddress/4001"), () => created(4001)),
      http.put(sevdeskUrl("/CommunicationWay/6001"), () => HttpResponse.json({ objects: {} })),
    );
    const c = await connectWrites({ config: { mode: "write" } });
    const result = await c.call("update_contact", {
      contactId: 2001,
      organisation: "Muster AG",
      defaultTimeToPay: 30,
      address: { city: "Neustadt" },
      email: { value: "neu@muster.example" },
    });
    const data = structured<Record<string, unknown>>(result);
    expect(operations(api)).toEqual([
      "GET getContactById",
      "GET getCommunicationWays",
      "PUT updateContact",
      "PUT updateContactAddress",
      "PUT UpdateCommunicationWay",
    ]);
    expect(queryOf(api.requests[1])).toEqual({
      "contact[id]": "2001",
      "contact[objectName]": "Contact",
      type: "EMAIL",
    });
    expect(await bodyOf(api, "updateContact")).toEqual({ name: "Muster AG", defaultTimeToPay: 30 });
    expect(await bodyOf(api, "updateContactAddress")).toEqual({ city: "Neustadt" });
    expect(await bodyOf(api, "UpdateCommunicationWay")).toEqual({ value: "neu@muster.example" });
    expect(data).toEqual({
      contactId: 2001,
      updatedFields: ["name", "defaultTimeToPay"],
      address: { id: 4001, action: "updated" },
      communicationWays: [
        { id: 6001, type: "EMAIL", value: "neu@muster.example", action: "updated" },
      ],
    });
    expect(textOf(result).split("\n")[0]).toBe(
      "Contact 2001: the master data (name, defaultTimeToPay) was updated, the address was " +
        "updated, the e-mail was updated.",
    );
  });

  it("creates a missing address and phone and says so", async () => {
    api.server.use(
      withAddresses([]),
      ways([]),
      http.post(sevdeskUrl("/ContactAddress"), () => created(4102)),
      http.post(sevdeskUrl("/CommunicationWay"), () => created(6103)),
    );
    const c = await connectWrites({ config: { mode: "write" } });
    const result = await c.call("update_contact", {
      contactId: 2001,
      address: { street: "Neuweg 3", zip: "54321", city: "Neuort", countryId: 2 },
      phone: { value: "030 999" },
    });
    const data = structured<Record<string, unknown>>(result);
    expect(operations(api)).toEqual([
      "GET getContactById",
      "GET getCommunicationWays",
      "POST createContactAddress",
      "POST createCommunicationWay",
    ]);
    expect(await bodyOf(api, "createContactAddress")).toMatchObject({
      contact: { id: 2001, objectName: "Contact" },
      country: { id: 2, objectName: "StaticCountry" },
      category: { id: 47, objectName: "Category" },
    });
    expect(data).toMatchObject({
      updatedFields: [],
      address: { id: 4102, action: "created" },
      communicationWays: [{ id: 6103, type: "PHONE", action: "created" }],
    });
    expect(textOf(result)).toContain("the address was created, the phone was created");
  });

  it("asks which address or e-mail is meant when there are several, and writes nothing", async () => {
    api.server.use(
      withAddresses([address(), address({ id: 4002, street: "Zweitweg 2", category: null })]),
      ways([communicationWay(), communicationWay({ id: "6002", value: "info@muster.example" })]),
    );
    const c = await connectWrites({ config: { mode: "write" } });
    const addressResult = await c.call("update_contact", {
      contactId: 2001,
      organisation: "Muster AG",
      address: { city: "X" },
    });
    expect(addressResult.isError).toBe(true);
    expect(textOf(addressResult)).toContain("has 2 addresses (4001: Beispielweg 1, Musterstadt");
    expect(textOf(addressResult)).toContain("address.addressId");
    const emailResult = await c.call("update_contact", {
      contactId: 2001,
      email: { value: "x@muster.example" },
    });
    expect(emailResult.isError).toBe(true);
    expect(textOf(emailResult)).toContain(
      "6001: buchhaltung@muster.example; 6002: info@muster.example",
    );
    expect(api.requests.every((r) => r.method === "GET")).toBe(true);
  });

  it("refuses IDs that belong to another contact", async () => {
    api.server.use(withAddresses([address()]), ways([communicationWay()]));
    const c = await connectWrites({ config: { mode: "write" } });
    const result = await c.call("update_contact", {
      contactId: 2001,
      address: { addressId: 9999, city: "X" },
    });
    expect(textOf(result)).toContain("Address 9999 does not belong to contact 2001");
    const way = await c.call("update_contact", {
      contactId: 2001,
      email: { communicationWayId: 7777, value: "x@y.example" },
    });
    expect(textOf(way)).toContain("e-mail entry 7777 does not belong to contact 2001");
    expect(api.requests.every((r) => r.method === "GET")).toBe(true);
  });

  it("refuses to turn a person into an organisation or to change without fields", async () => {
    api.server.use(
      http.get(sevdeskUrl("/Contact/2001"), () =>
        HttpResponse.json(list([{ ...person({ id: "2001" }), addresses: [] }])),
      ),
    );
    const c = await connectWrites({ config: { mode: "write" } });
    const result = await c.call("update_contact", { contactId: 2001, organisation: "Firma" });
    expect(textOf(result)).toContain("is a person");
    const empty = await c.call("update_contact", { contactId: 2001 });
    expect(textOf(empty)).toContain("Nothing to change");
    expect(operations(api)).toEqual(["GET getContactById"]);
  });

  it("reports what was already written when a later step fails", async () => {
    api.server.use(
      withAddresses([address()]),
      http.put(sevdeskUrl("/Contact/2001"), () => HttpResponse.json({ objects: contact() })),
      http.put(sevdeskUrl("/ContactAddress/4001"), () => sevdeskError(400, "bad zip")),
    );
    const c = await connectWrites({ config: { mode: "write" } });
    const result = await c.call("update_contact", {
      contactId: 2001,
      vatNumber: "DE1",
      address: { zip: "?" },
    });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain(
      "For contact 2001, the master data (vatNumber) was updated. But changing the address failed",
    );
  });
});

describe("contact write tools and modes", () => {
  it("are not registered in read mode", async () => {
    const c = await connectWrites({ config: { mode: "read" } });
    const names = (await c.client.listTools()).tools.map((t) => t.name);
    expect(names).not.toContain("create_contact");
    expect(names).not.toContain("update_contact");
  });

  it("declare correct annotations and an output schema", async () => {
    const c = await connectWrites({ config: { mode: "write" } });
    const tools = (await c.client.listTools()).tools;
    expect(tools.find((t) => t.name === "create_contact")?.annotations).toEqual({
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true,
    });
    expect(tools.find((t) => t.name === "update_contact")?.annotations).toEqual({
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: true,
      openWorldHint: true,
    });
    expect(tools.find((t) => t.name === "create_contact")?.outputSchema).toBeDefined();
  });
});
