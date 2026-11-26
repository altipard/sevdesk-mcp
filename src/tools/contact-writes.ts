import { z } from "zod";
import { defineTool, type ToolCall } from "../policy/registry.js";
import { SevdeskError } from "../sevdesk/errors.js";
import {
  asRecord,
  badInput,
  CONTACT_STATUS,
  codeFor,
  entityId,
  integer,
  objectsOf,
  type Raw,
  refId,
  statusNames,
  text,
} from "./format.js";
import { present } from "./result.js";
import {
  afterPartialWrite,
  CREATE_ANNOTATIONS,
  CUSTOMER_CATEGORY_ID,
  emailInput,
  GERMANY_COUNTRY_ID,
  INVOICE_ADDRESS_CATEGORY_ID,
  inputText,
  phoneInput,
  readContact,
  ref,
  UPDATE_ANNOTATIONS,
  WORK_COMMUNICATION_KEY_ID,
} from "./write-common.js";

// ---------------------------------------------------------------------------
// Shared input parts

const masterData = {
  description: inputText(2000).optional(),
  vatNumber: inputText(30).optional().describe("VAT ID (USt-IdNr.)."),
  taxNumber: inputText(30).optional(),
  defaultTimeToPay: z.number().int().min(0).max(365).optional().describe("Payment term in days."),
  buyerReference: inputText(100).optional().describe("Leitweg-ID for e-invoices to authorities."),
};

const addressFields = {
  street: inputText(200).optional(),
  zip: inputText(20).optional(),
  city: inputText(100).optional(),
  countryId: entityId
    .optional()
    .describe(`sevdesk country ID; default ${GERMANY_COUNTRY_ID} (DE).`),
};

const STATUS_NAMES = statusNames(CONTACT_STATUS);

/** Fields of Model_Contact / Model_ContactUpdate the tools set. */
function masterBody(args: {
  description?: string | undefined;
  vatNumber?: string | undefined;
  taxNumber?: string | undefined;
  defaultTimeToPay?: number | undefined;
  buyerReference?: string | undefined;
}): Record<string, unknown> {
  return {
    ...(args.description !== undefined && { description: args.description }),
    ...(args.vatNumber !== undefined && { vatNumber: args.vatNumber }),
    ...(args.taxNumber !== undefined && { taxNumber: args.taxNumber }),
    ...(args.defaultTimeToPay !== undefined && { defaultTimeToPay: args.defaultTimeToPay }),
    ...(args.buyerReference !== undefined && { buyerReference: args.buyerReference }),
  };
}

const wayTypeSchema = z.enum(["EMAIL", "PHONE"]);
type WayType = z.infer<typeof wayTypeSchema>;

const wayResultSchema = z.object({
  id: z.number().int().nullable(),
  type: wayTypeSchema,
  value: z.string(),
  action: z.enum(["created", "updated"]),
});

const addressResultSchema = z.object({
  id: z.number().int().nullable(),
  action: z.enum(["created", "updated"]),
});

const idOf = (body: unknown) => integer(objectsOf(body)[0]?.id);

// ---------------------------------------------------------------------------
// create_contact

const createInput = z.object({
  organisation: inputText(250)
    .optional()
    .describe("Organisation name. Give this or firstName/lastName, not both."),
  firstName: inputText(100).optional().describe("First name of a person."),
  lastName: inputText(100).optional().describe("Last name of a person."),
  organisationId: entityId.optional().describe("Organisation a person belongs to (persons only)."),
  categoryId: entityId
    .default(CUSTOMER_CATEGORY_ID)
    .describe(`sevdesk contact category; default ${CUSTOMER_CATEGORY_ID} (Kunde, customer).`),
  customerNumber: inputText(50)
    .optional()
    .describe("Customer number; default for customers: the next free number from sevdesk."),
  ...masterData,
  address: z
    .object({
      street: inputText(200),
      zip: inputText(20),
      city: inputText(100),
      countryId: addressFields.countryId,
    })
    .optional()
    .describe(`Invoice address (category ${INVOICE_ADDRESS_CATEGORY_ID}).`),
  email: emailInput.optional().describe("Main e-mail address."),
  phone: phoneInput.optional(),
});

export const createContact = defineTool({
  name: "create_contact",
  title: "Create a sevdesk contact",
  description:
    "Creates an organisation or a person in sevdesk, by default as customer (category 3) with " +
    "the next free customer number, optionally with an invoice address, e-mail and phone. " +
    "Check with search_contacts first that the contact does not exist yet. Address, e-mail " +
    "and phone are separate sevdesk objects: if one of them fails, the contact exists anyway " +
    "and the error names its ID; complete it with update_contact instead of creating it again.",
  class: "W",
  operationId: "createContact",
  operations: ["getNextCustomerNumber", "createContactAddress", "createCommunicationWay"],
  inputSchema: createInput,
  outputSchema: z.object({
    contactId: z.number().int(),
    name: z.string(),
    isPerson: z.boolean(),
    customerNumber: z.string().nullable(),
    categoryId: z.number().int(),
    address: addressResultSchema.optional(),
    communicationWays: z.array(wayResultSchema),
  }),
  annotations: CREATE_ANNOTATIONS,
  async handler(args, call) {
    const isPerson = args.firstName !== undefined || args.lastName !== undefined;
    if (args.organisation !== undefined && isPerson) {
      throw badInput("Give either organisation or firstName/lastName, not both.");
    }
    if (args.organisation === undefined && !isPerson) {
      throw badInput("Give organisation, or firstName and/or lastName for a person.");
    }
    if (args.organisationId !== undefined && !isPerson) {
      throw badInput("organisationId is only for persons.");
    }
    const { sevdesk } = call;
    let customerNumber = args.customerNumber ?? null;
    if (customerNumber === null && args.categoryId === CUSTOMER_CATEGORY_ID) {
      const next = await sevdesk.call(sevdesk.api.GET("/Contact/Factory/getNextCustomerNumber"));
      customerNumber = text(asRecord(next).objects);
    }
    const body = {
      ...(args.organisation !== undefined && { name: args.organisation }),
      ...(args.firstName !== undefined && { surename: args.firstName }),
      ...(args.lastName !== undefined && { familyname: args.lastName }),
      ...(args.organisationId !== undefined && {
        parent: ref(args.organisationId, "Contact"),
      }),
      category: ref(args.categoryId, "Category"),
      ...(customerNumber !== null && { customerNumber }),
      ...masterBody(args),
    };
    const created = await sevdesk.call(sevdesk.api.POST("/Contact", { body: body as never }));
    const contactId = idOf(created);
    if (contactId === null) {
      throw new SevdeskError(
        "http_error",
        "sevdesk accepted the contact but returned no ID; check sevdesk before creating it again.",
      );
    }
    const name =
      args.organisation ?? [args.firstName, args.lastName].filter(Boolean).join(" ").trim();
    const done = (extra: string) => `Contact ${contactId} (${name}) was created${extra}.`;

    let address: z.infer<typeof addressResultSchema> | undefined;
    if (args.address) {
      try {
        const result = await sevdesk.call(
          sevdesk.api.POST("/ContactAddress", {
            body: {
              contact: ref(contactId, "Contact"),
              street: args.address.street,
              zip: args.address.zip,
              city: args.address.city,
              country: ref(args.address.countryId ?? GERMANY_COUNTRY_ID, "StaticCountry"),
              category: ref(INVOICE_ADDRESS_CATEGORY_ID, "Category"),
            } as never,
          }),
        );
        address = { id: idOf(result), action: "created" };
      } catch (error) {
        throw afterPartialWrite(done(""), "adding the address", error);
      }
    }

    const communicationWays: Array<z.infer<typeof wayResultSchema>> = [];
    const wanted: Array<[WayType, string | undefined]> = [
      ["EMAIL", args.email],
      ["PHONE", args.phone],
    ];
    for (const [type, value] of wanted) {
      if (value === undefined) continue;
      try {
        const result = await sevdesk.call(
          sevdesk.api.POST("/CommunicationWay", {
            body: {
              contact: ref(contactId, "Contact"),
              type,
              value,
              key: ref(WORK_COMMUNICATION_KEY_ID, "CommunicationWayKey"),
              main: true,
            } as never,
          }),
        );
        communicationWays.push({ id: idOf(result), type, value, action: "created" });
      } catch (error) {
        const soFar = [
          address && "with its address",
          ...communicationWays.map((way) => `with ${way.type.toLowerCase()} ${way.value}`),
        ].filter(Boolean);
        throw afterPartialWrite(
          done(soFar.length > 0 ? ` ${soFar.join(", ")}` : ""),
          `adding the ${type === "EMAIL" ? "e-mail address" : "phone number"}`,
          error,
        );
      }
    }

    return present(
      {
        contactId,
        name,
        isPerson,
        customerNumber,
        categoryId: args.categoryId,
        ...(address && { address }),
        communicationWays,
      },
      {
        summary:
          `Created contact ${contactId}${customerNumber ? ` (customer number ${customerNumber})` : ""}` +
          `${address ? " with address" : ""}` +
          `${communicationWays.length > 0 ? `, ${communicationWays.length} communication ways` : ""}.`,
      },
    );
  },
});

// ---------------------------------------------------------------------------
// update_contact

const updateInput = z.object({
  contactId: entityId.describe("sevdesk ID of the contact (search_contacts)."),
  organisation: inputText(250).optional().describe("New organisation name (organisations only)."),
  firstName: inputText(100).optional().describe("New first name (persons only)."),
  lastName: inputText(100).optional().describe("New last name (persons only)."),
  customerNumber: inputText(50).optional(),
  categoryId: entityId.optional().describe("New contact category (3 = customer)."),
  status: z.enum(STATUS_NAMES).optional(),
  ...masterData,
  address: z
    .object({
      addressId: entityId
        .optional()
        .describe("Address to change; needed when the contact has more than one."),
      ...addressFields,
    })
    .optional()
    .describe(
      "Change the contact's address. Without addressId: the only address is changed; with no " +
        "address yet one is created (then street, zip and city are required).",
    ),
  email: z
    .object({
      communicationWayId: entityId
        .optional()
        .describe("E-mail entry to change; needed when the contact has more than one."),
      value: emailInput,
    })
    .optional(),
  phone: z
    .object({
      communicationWayId: entityId
        .optional()
        .describe("Phone entry to change; needed when the contact has more than one."),
      value: phoneInput,
    })
    .optional(),
});
type UpdateArgs = z.infer<typeof updateInput>;

type AddressPlan =
  | { action: "updated"; id: number }
  | { action: "created"; street: string; zip: string; city: string };

/** What to do with the address, decided before anything is written. */
function planAddress(contactId: number, raw: Raw, input: NonNullable<UpdateArgs["address"]>) {
  if (!Array.isArray(raw.addresses)) {
    throw badInput(
      `sevdesk did not list the addresses of contact ${contactId}, so the address cannot be ` +
        "matched safely. Nothing was changed.",
    );
  }
  const addresses = raw.addresses.map(asRecord);
  const ids = addresses.map((a) => integer(a.id)).filter((id): id is number => id !== null);
  if (input.addressId !== undefined) {
    if (!ids.includes(input.addressId)) {
      throw badInput(
        `Address ${input.addressId} does not belong to contact ${contactId}` +
          `${ids.length > 0 ? ` (its addresses: ${ids.join(", ")})` : ""}. Nothing was changed.`,
      );
    }
    return { action: "updated", id: input.addressId } satisfies AddressPlan;
  }
  if (ids.length > 1) {
    const list = addresses
      .map((a) => `${integer(a.id)}: ${[text(a.street), text(a.city)].filter(Boolean).join(", ")}`)
      .join("; ");
    throw badInput(
      `Contact ${contactId} has ${ids.length} addresses (${list}). Say which one to change ` +
        "with address.addressId. Nothing was changed.",
    );
  }
  if (ids.length === 1) return { action: "updated", id: ids[0] as number } satisfies AddressPlan;
  if (input.street === undefined || input.zip === undefined || input.city === undefined) {
    throw badInput(
      `Contact ${contactId} has no address yet; a new one needs street, zip and city. ` +
        "Nothing was changed.",
    );
  }
  return {
    action: "created",
    street: input.street,
    zip: input.zip,
    city: input.city,
  } satisfies AddressPlan;
}

type WayPlan = { type: WayType; value: string } & (
  | { action: "updated"; id: number }
  | { action: "created" }
);

async function planWay(
  { sevdesk }: ToolCall,
  contactId: number,
  type: WayType,
  input: { communicationWayId?: number | undefined; value: string },
): Promise<WayPlan> {
  const body = await sevdesk.call(
    sevdesk.api.GET("/CommunicationWay", {
      params: {
        query: { "contact[id]": String(contactId), "contact[objectName]": "Contact", type },
      },
    }),
  );
  const ways = objectsOf(body).filter(
    (way) => refId(way.contact) === contactId && text(way.type) === type,
  );
  const ids = ways.map((way) => integer(way.id)).filter((id): id is number => id !== null);
  const label = type === "EMAIL" ? "e-mail" : "phone";
  const field = type === "EMAIL" ? "email" : "phone";
  if (input.communicationWayId !== undefined) {
    if (!ids.includes(input.communicationWayId)) {
      throw badInput(
        `${label} entry ${input.communicationWayId} does not belong to contact ${contactId}` +
          `${ids.length > 0 ? ` (its ${label} entries: ${ids.join(", ")})` : ""}. Nothing was changed.`,
      );
    }
    return { type, value: input.value, action: "updated", id: input.communicationWayId };
  }
  if (ids.length > 1) {
    const list = ways.map((way) => `${integer(way.id)}: ${text(way.value) ?? "?"}`).join("; ");
    throw badInput(
      `Contact ${contactId} has ${ids.length} ${label} entries (${list}). Say which one to ` +
        `change with ${field}.communicationWayId. Nothing was changed.`,
    );
  }
  if (ids.length === 1) {
    return { type, value: input.value, action: "updated", id: ids[0] as number };
  }
  return { type, value: input.value, action: "created" };
}

export const updateContact = defineTool({
  name: "update_contact",
  title: "Update a sevdesk contact",
  description:
    "Changes master data of a contact and, if given, its address, e-mail or phone. An address " +
    "or communication entry is only changed when it is unambiguous: without an ID, the " +
    "contact's single entry is changed, a missing one is created (reported as created), and " +
    "with several entries the call fails with their IDs so you can pick one. All of this is " +
    "checked before anything is written. Use get_contact to see the current values.",
  class: "W",
  operationId: "updateContact",
  operations: [
    "getContactById",
    "createContactAddress",
    "updateContactAddress",
    "getCommunicationWays",
    "createCommunicationWay",
    "UpdateCommunicationWay",
  ],
  inputSchema: updateInput,
  outputSchema: z.object({
    contactId: z.number().int(),
    updatedFields: z.array(z.string()).describe("Master data fields sent to sevdesk."),
    address: addressResultSchema.optional(),
    communicationWays: z.array(wayResultSchema),
  }),
  annotations: UPDATE_ANNOTATIONS,
  async handler(args, call) {
    const { sevdesk } = call;
    const { contactId } = args;
    const contact = {
      ...(args.organisation !== undefined && { name: args.organisation }),
      ...(args.firstName !== undefined && { surename: args.firstName }),
      ...(args.lastName !== undefined && { familyname: args.lastName }),
      ...(args.customerNumber !== undefined && { customerNumber: args.customerNumber }),
      ...(args.categoryId !== undefined && { category: ref(args.categoryId, "Category") }),
      ...(args.status !== undefined && { status: codeFor(CONTACT_STATUS, args.status) }),
      ...masterBody(args),
    };
    const updatedFields = Object.keys(contact);
    if (
      updatedFields.length === 0 &&
      args.address === undefined &&
      args.email === undefined &&
      args.phone === undefined
    ) {
      throw badInput("Nothing to change: give at least one field.");
    }

    // Everything is checked first; writes start only when the plan is clear.
    const raw = await readContact(call, contactId);
    const isOrganisation = text(raw.name) !== null;
    if (isOrganisation && (args.firstName !== undefined || args.lastName !== undefined)) {
      throw badInput(
        `Contact ${contactId} is an organisation; firstName/lastName are for persons. Nothing was changed.`,
      );
    }
    if (!isOrganisation && args.organisation !== undefined) {
      throw badInput(
        `Contact ${contactId} is a person; setting an organisation name would turn it into an ` +
          "organisation. Nothing was changed.",
      );
    }
    const addressPlan = args.address ? planAddress(contactId, raw, args.address) : undefined;
    const wayPlans: WayPlan[] = [];
    if (args.email) wayPlans.push(await planWay(call, contactId, "EMAIL", args.email));
    if (args.phone) wayPlans.push(await planWay(call, contactId, "PHONE", args.phone));

    const steps: string[] = [];
    const doneText = () =>
      steps.length === 0
        ? `Nothing of contact ${contactId} was changed yet.`
        : `For contact ${contactId}, ${steps.join(", ")}.`;

    if (updatedFields.length > 0) {
      await sevdesk.call(
        sevdesk.api.PUT("/Contact/{contactId}", {
          params: { path: { contactId } },
          body: contact as never,
        }),
      );
      steps.push(`the master data (${updatedFields.join(", ")}) was updated`);
    }

    let address: z.infer<typeof addressResultSchema> | undefined;
    if (addressPlan && args.address) {
      const input = args.address;
      try {
        if (addressPlan.action === "updated") {
          await sevdesk.call(
            sevdesk.api.PUT("/ContactAddress/{contactAddressId}", {
              params: { path: { contactAddressId: addressPlan.id } },
              body: {
                ...(input.street !== undefined && { street: input.street }),
                ...(input.zip !== undefined && { zip: input.zip }),
                ...(input.city !== undefined && { city: input.city }),
                ...(input.countryId !== undefined && {
                  country: ref(input.countryId, "StaticCountry"),
                }),
              } as never,
            }),
          );
          address = { id: addressPlan.id, action: "updated" };
        } else {
          const result = await sevdesk.call(
            sevdesk.api.POST("/ContactAddress", {
              body: {
                contact: ref(contactId, "Contact"),
                street: addressPlan.street,
                zip: addressPlan.zip,
                city: addressPlan.city,
                country: ref(input.countryId ?? GERMANY_COUNTRY_ID, "StaticCountry"),
                category: ref(INVOICE_ADDRESS_CATEGORY_ID, "Category"),
              } as never,
            }),
          );
          address = { id: idOf(result), action: "created" };
        }
      } catch (error) {
        if (steps.length === 0) throw error;
        throw afterPartialWrite(doneText(), "changing the address", error);
      }
      steps.push(`the address was ${address.action}`);
    }

    const communicationWays: Array<z.infer<typeof wayResultSchema>> = [];
    for (const plan of wayPlans) {
      const label = plan.type === "EMAIL" ? "e-mail" : "phone";
      try {
        if (plan.action === "updated") {
          await sevdesk.call(
            sevdesk.api.PUT("/CommunicationWay/{communicationWayId}", {
              params: { path: { communicationWayId: plan.id } },
              body: { value: plan.value } as never,
            }),
          );
          communicationWays.push({
            id: plan.id,
            type: plan.type,
            value: plan.value,
            action: "updated",
          });
        } else {
          const result = await sevdesk.call(
            sevdesk.api.POST("/CommunicationWay", {
              body: {
                contact: ref(contactId, "Contact"),
                type: plan.type,
                value: plan.value,
                key: ref(WORK_COMMUNICATION_KEY_ID, "CommunicationWayKey"),
                main: true,
              } as never,
            }),
          );
          communicationWays.push({
            id: idOf(result),
            type: plan.type,
            value: plan.value,
            action: "created",
          });
        }
      } catch (error) {
        if (steps.length === 0) throw error;
        throw afterPartialWrite(doneText(), `changing the ${label}`, error);
      }
      steps.push(`the ${label} was ${plan.action}`);
    }

    return present(
      {
        contactId,
        updatedFields,
        ...(address && { address }),
        communicationWays,
      },
      {
        summary: `Contact ${contactId}: ${steps.join(", ")}.`,
      },
    );
  },
});
