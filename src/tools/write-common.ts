import { z } from "zod";
import type { StrictToolAnnotations, ToolCall } from "../policy/registry.js";
import { SevdeskError } from "../sevdesk/errors.js";
import {
  amount,
  asRecord,
  badInput,
  cents,
  entityId,
  INVOICE_STATUS,
  integer,
  isoDateOf,
  notFound,
  objectsOf,
  type Raw,
  refId,
  statusOf,
  text,
} from "./format.js";

/**
 * Shared parts of the curated write tools: annotations, reference IDs
 * sevdesk needs but the spec offers no lookup for, the tax-rule check,
 * contact addresses for documents and honest errors for writes that
 * stopped half-way.
 */

// ---------------------------------------------------------------------------
// Annotations

/** Creates something new; a repeat creates it again. */
export const CREATE_ANNOTATIONS: StrictToolAnnotations = {
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: false,
  openWorldHint: true,
};

/** Overwrites existing values; the same call twice leaves the same state. */
export const UPDATE_ANNOTATIONS: StrictToolAnnotations = {
  readOnlyHint: false,
  destructiveHint: true,
  idempotentHint: true,
  openWorldHint: true,
};

// ---------------------------------------------------------------------------
// Reference IDs without a lookup operation in the spec

/** Contact category "Kunde" (customer), the example value of the spec. */
export const CUSTOMER_CATEGORY_ID = 3;
/** Contact address category "Rechnungsadresse" (invoice address). */
export const INVOICE_ADDRESS_CATEGORY_ID = 47;
/** StaticCountry Germany, the example value of the spec. */
export const GERMANY_COUNTRY_ID = 1;
/** CommunicationWayKey "Arbeit" (work). */
export const WORK_COMMUNICATION_KEY_ID = 2;
/** Unity "Stück" (piece), the example value of the spec. */
export const PIECE_UNITY_ID = 1;

export const ref = (id: number, objectName: string) => ({ id, objectName });

// ---------------------------------------------------------------------------
// Values

/** dd.mm.yyyy, a date format sevdesk documents for document dates. */
export function sevdeskDate(iso: string): string {
  const [y, m, d] = iso.split("-");
  return `${d}.${m}.${y}`;
}

/** Trimmed text input with a length cap; no hidden characters into sevdesk. */
export const inputText = (max: number) =>
  z
    .string()
    .trim()
    .min(1)
    .max(max)
    .refine((value) => !/[\p{Cc}\p{Cf}\p{Co}\p{Cn}]/u.test(value.replace(/[\t\n\r]/g, "")), {
      error: "contains control or invisible characters",
    });

export const emailInput = z.email().max(254);

export const phoneInput = z
  .string()
  .trim()
  .min(3)
  .max(50)
  .regex(/^\+?[0-9 ()/.-]+$/, { error: "must be a phone number (digits, spaces, + ( ) / . -)" });

export const currencyInput = z
  .string()
  .regex(/^[A-Z]{3}$/, { error: "must be an ISO 4217 code like EUR" })
  .default("EUR");

// ---------------------------------------------------------------------------
// Errors

/**
 * Error for a multi-step write that failed after earlier steps succeeded.
 * Names what exists now, so nobody repeats the whole call and creates it
 * twice. Kind and status of the failing step are kept.
 */
export function afterPartialWrite(done: string, failedStep: string, error: unknown): SevdeskError {
  const reason =
    error instanceof SevdeskError
      ? error.message
      : "Internal error in sevdesk-mcp. Details are in the server log.";
  const status = error instanceof SevdeskError ? error.status : undefined;
  return new SevdeskError(
    error instanceof SevdeskError ? error.kind : "http_error",
    `${done} But ${failedStep} failed: ${reason} Do not repeat the whole call; ` +
      "check the contact in sevdesk and fix the rest with update_contact.",
    status === undefined ? {} : { status },
  );
}

// ---------------------------------------------------------------------------
// Tax rules (sevdesk-Update 2.0, revenue; from the "Tax Rules" section of the spec)

export interface TaxRuleInfo {
  readonly name: string;
  /** Allowed position tax rates; null where they depend on the country (OSS). */
  readonly rates: readonly number[] | null;
}

export const REVENUE_TAX_RULES: Readonly<Record<number, TaxRuleInfo>> = {
  1: { name: "Umsatzsteuerpflichtige Umsätze", rates: [0, 7, 19] },
  2: { name: "Ausfuhren", rates: [0] },
  3: { name: "Innergemeinschaftliche Lieferungen", rates: [0, 7, 19] },
  4: { name: "Steuerfreie Umsätze §4 UStG", rates: [0] },
  5: { name: "Reverse Charge gem. §13b UStG", rates: [0] },
  11: { name: "Steuer nicht erhoben nach §19 UStG (Kleinunternehmer)", rates: [0] },
  17: { name: "Nicht im Inland steuerbare Leistung", rates: [0] },
  18: { name: "One Stop Shop (Waren)", rates: null },
  19: { name: "One Stop Shop (elektronische Dienstleistungen)", rates: null },
  20: { name: "One Stop Shop (sonstige Dienstleistungen)", rates: null },
  21: { name: "Reverse Charge gem. §18b UStG", rates: [0] },
};

export const REVENUE_TAX_RULE_IDS = Object.keys(REVENUE_TAX_RULES).map(Number);

export const taxRuleInput = z
  .number()
  .int()
  .refine((id) => REVENUE_TAX_RULE_IDS.includes(id), {
    error: `must be a revenue tax rule: ${REVENUE_TAX_RULE_IDS.join(", ")}`,
  })
  .default(1)
  .describe(
    "sevdesk tax rule (bookkeeping 2.0): 1 taxable sales (0/7/19 %), 2 exports, 3 EU deliveries, " +
      "4 tax-free §4 UStG, 5 reverse charge §13b, 11 small business §19 UStG, 17 not taxable in " +
      "Germany, 18-20 One Stop Shop, 21 reverse charge §18b. Default 1.",
  );

const GUIDANCE_RATES: Readonly<Record<string, number>> = {
  ZERO: 0,
  FIVE: 5,
  SEVEN: 7,
  SIXTEEN: 16,
  NINETEEN: 19,
};

export const taxCheckSchema = z.object({
  id: z.number().int(),
  name: z.string(),
  checkedAgainst: z
    .enum(["guidance", "documented_rules"])
    .describe(
      "guidance: the account's ReceiptGuidance; documented_rules: sevdesk's documented table only.",
    ),
});
export type TaxCheck = z.infer<typeof taxCheckSchema>;

const ratesText = (rates: readonly number[]) => rates.map((rate) => `${rate} %`).join(", ");

/**
 * Checks a tax rule and the position rates before anything is sent:
 * first against the rules sevdesk documents, then against the account's
 * own ReceiptGuidance for revenue (which, e.g., only allows rule 11 for
 * small businesses). If the guidance cannot be read, the documented rules
 * alone decide and a warning says so.
 */
export async function checkTax(
  { sevdesk }: ToolCall,
  taxRule: number,
  rates: readonly number[],
  warnings: string[],
): Promise<TaxCheck> {
  const rule = REVENUE_TAX_RULES[taxRule];
  if (rule === undefined) {
    throw badInput(`Tax rule ${taxRule} is not a revenue tax rule sevdesk documents.`);
  }
  const used = [...new Set(rates)].sort((a, b) => a - b);
  const allowedByRule = rule.rates;
  if (allowedByRule !== null) {
    const wrong = used.filter((rate) => !allowedByRule.includes(rate));
    if (wrong.length > 0) {
      throw badInput(
        `Tax rule ${taxRule} (${rule.name}) allows tax rates ${ratesText(allowedByRule)} in ` +
          `positions, not ${ratesText(wrong)}. Change the tax rate of those positions or ` +
          "choose another tax rule (see get_tax_guidance).",
      );
    }
  }

  let body: unknown;
  try {
    body = await sevdesk.call(sevdesk.api.GET("/ReceiptGuidance/forRevenue"));
  } catch (error) {
    if (error instanceof SevdeskError && error.kind !== "policy") {
      warnings.push(
        `sevdesk's tax guidance could not be read (${error.kind}); the tax rule was checked ` +
          "against the documented sevdesk rules only.",
      );
      return { id: taxRule, name: rule.name, checkedAgainst: "documented_rules" };
    }
    throw error;
  }
  // Rule ID -> rates sevdesk allows with it; null if a rate name is unknown.
  const allowed = new Map<number, Set<number> | null>();
  for (const account of objectsOf(body)) {
    const list = Array.isArray(account.allowedTaxRules) ? account.allowedTaxRules : [];
    for (const entry of list) {
      const raw = asRecord(entry);
      const id = integer(raw.id);
      if (id === null) continue;
      const known = allowed.has(id) ? (allowed.get(id) ?? null) : new Set<number>();
      if (known === null) continue;
      let readable = true;
      for (const name of Array.isArray(raw.taxRates) ? raw.taxRates : []) {
        const rate = typeof name === "string" ? GUIDANCE_RATES[name] : undefined;
        if (rate === undefined) readable = false;
        else known.add(rate);
      }
      allowed.set(id, readable ? known : null);
    }
  }
  if (allowed.size === 0) {
    warnings.push(
      "sevdesk's tax guidance listed no tax rules for revenue; the tax rule was checked " +
        "against the documented sevdesk rules only.",
    );
    return { id: taxRule, name: rule.name, checkedAgainst: "documented_rules" };
  }
  if (!allowed.has(taxRule)) {
    throw badInput(
      `This sevdesk account does not allow tax rule ${taxRule} (${rule.name}) for revenue. ` +
        `Allowed: ${[...allowed.keys()].sort((a, b) => a - b).join(", ")} (see get_tax_guidance).`,
    );
  }
  const guided = allowed.get(taxRule);
  if (guided !== null && guided !== undefined && guided.size > 0) {
    const wrong = used.filter((rate) => !guided.has(rate));
    if (wrong.length > 0) {
      throw badInput(
        `sevdesk allows tax rates ${ratesText([...guided].sort((a, b) => a - b))} with tax rule ` +
          `${taxRule} (${rule.name}) on this account, not ${ratesText(wrong)}.`,
      );
    }
  }
  return { id: taxRule, name: rule.name, checkedAgainst: "guidance" };
}

/** Default taxText per rule, as sevdesk prints it below the sums. */
export function defaultTaxText(taxRule: number): string {
  return taxRule === 1 ? "Umsatzsteuer" : (REVENUE_TAX_RULES[taxRule]?.name ?? "Umsatzsteuer");
}

// ---------------------------------------------------------------------------
// Positions

export const MAX_POSITIONS = 100;

export const positionInput = z.object({
  partId: entityId
    .optional()
    .describe("sevdesk article (search_parts). Name, price, tax rate and unit default to it."),
  name: inputText(250).optional().describe("Position name; required without partId."),
  text: inputText(2000).optional().describe("Description below the name."),
  quantity: z.number().positive().max(1_000_000_000),
  priceNet: z
    .number()
    .min(-1_000_000_000)
    .max(1_000_000_000)
    .optional()
    .describe("Net unit price; required without partId."),
  taxRate: z
    .number()
    .min(0)
    .max(100)
    .optional()
    .describe("Tax rate in percent (e.g. 19, 7, 0); required without partId."),
  unityId: entityId.optional().describe(`sevdesk unit ID; default ${PIECE_UNITY_ID} (Stück).`),
});
export type PositionInput = z.infer<typeof positionInput>;

export const positionsInput = z
  .array(positionInput)
  .min(1)
  .max(MAX_POSITIONS)
  .describe(`1-${MAX_POSITIONS} positions.`);

export interface ResolvedPosition {
  readonly partId: number | undefined;
  readonly name: string;
  readonly text: string | undefined;
  readonly quantity: number;
  readonly priceNet: number;
  readonly taxRate: number;
  readonly unityId: number;
}

/**
 * Positions with every value set: free positions as given, article
 * positions completed from the article. Missing values are an input error.
 */
export async function resolvePositions(
  { sevdesk }: ToolCall,
  positions: readonly PositionInput[],
): Promise<ResolvedPosition[]> {
  const parts = new Map<number, Raw>();
  const resolved: ResolvedPosition[] = [];
  for (const [index, position] of positions.entries()) {
    let part: Raw | undefined;
    if (position.partId !== undefined) {
      part = parts.get(position.partId);
      if (part === undefined) {
        const body = await sevdesk.call(
          sevdesk.api.GET("/Part/{partId}", { params: { path: { partId: position.partId } } }),
        );
        part = objectsOf(body)[0];
        if (part === undefined) throw notFound("article", position.partId);
        parts.set(position.partId, part);
      }
    }
    const name = position.name ?? (part ? text(part.name) : null);
    const priceNet = position.priceNet ?? (part ? amount(part.priceNet ?? part.price) : null);
    const taxRate = position.taxRate ?? (part ? amount(part.taxRate) : null);
    const missing = [
      name === null && "name",
      priceNet === null && "priceNet",
      taxRate === null && "taxRate",
    ].filter((field): field is string => typeof field === "string");
    if (name === null || priceNet === null || taxRate === null) {
      throw badInput(
        `Position ${index + 1} needs ${missing.join(", ")}` +
          `${position.partId === undefined ? "" : " (the article has no value for it)"}.`,
      );
    }
    resolved.push({
      partId: position.partId,
      name,
      text: position.text,
      quantity: position.quantity,
      priceNet,
      taxRate,
      unityId: position.unityId ?? (part ? refId(part.unity) : null) ?? PIECE_UNITY_ID,
    });
  }
  return resolved;
}

/** Position body for saveInvoice/saveOrder: the net price in price and priceNet. */
export function positionBody(position: ResolvedPosition, objectName: string, index: number) {
  return {
    objectName,
    mapAll: true,
    ...(position.partId !== undefined && { part: ref(position.partId, "Part") }),
    quantity: position.quantity,
    price: position.priceNet,
    priceNet: position.priceNet,
    taxRate: position.taxRate,
    name: position.name,
    ...(position.text !== undefined && { text: position.text }),
    unity: ref(position.unityId, "Unity"),
    positionNumber: index + 1,
  };
}

/** Net sum of the positions, rounded to cents. */
export function netSum(positions: readonly ResolvedPosition[]): number {
  return cents(positions.reduce((sum, p) => sum + p.quantity * p.priceNet, 0));
}

/** Warning if sevdesk's net sum differs from ours (e.g. prices read as gross). */
export function sumWarning(expected: number, actual: number | null): string | undefined {
  if (actual === null || Math.abs(actual - expected) < 0.005) return undefined;
  return (
    `sevdesk reports a net sum of ${actual}, but the positions add up to ${expected} net. ` +
    "The account may treat prices as gross; check the draft in sevdesk before sending it."
  );
}

// ---------------------------------------------------------------------------
// Contacts for documents

export interface ContactForDocument {
  readonly name: string | null;
  readonly address: string | null;
  readonly addressId: number | null;
  readonly countryId: number;
}

/** Organisation name, or first and last name of a person. */
export function contactName(raw: Raw): string | null {
  const organisation = text(raw.name);
  if (organisation !== null) return organisation;
  const person = [text(raw.surename), text(raw.familyname)].filter(Boolean).join(" ");
  return person === "" ? null : person;
}

/** The contact with its addresses embedded; throws not_found for an unknown ID. */
export async function readContact({ sevdesk }: ToolCall, contactId: number): Promise<Raw> {
  const body = await sevdesk.call(
    sevdesk.api.GET("/Contact/{contactId}", {
      params: { path: { contactId }, query: { embed: "addresses" } },
    }),
  );
  const raw = objectsOf(body)[0];
  if (raw === undefined) throw notFound("contact", contactId);
  return raw;
}

/**
 * Recipient address for an invoice or order from the contact: its invoice
 * address (category 47) if it has one, otherwise its first address.
 */
export async function contactForDocument(
  call: ToolCall,
  contactId: number,
  warnings: string[],
): Promise<ContactForDocument> {
  const raw = await readContact(call, contactId);
  const name = contactName(raw);
  const addresses = Array.isArray(raw.addresses) ? raw.addresses.map(asRecord) : [];
  const chosen =
    addresses.find((a) => refId(a.category) === INVOICE_ADDRESS_CATEGORY_ID) ?? addresses[0];
  if (chosen === undefined) {
    warnings.push(
      `Contact ${contactId} has no address in sevdesk (or sevdesk did not list it); the draft ` +
        "carries only the contact name as address. Add the address before sending.",
    );
    return { name, address: name, addressId: null, countryId: GERMANY_COUNTRY_ID };
  }
  if (addresses.length > 1 && refId(chosen.category) !== INVOICE_ADDRESS_CATEGORY_ID) {
    warnings.push(
      `Contact ${contactId} has ${addresses.length} addresses and none is marked as invoice ` +
        `address; address ${integer(chosen.id) ?? "?"} was used.`,
    );
  }
  const cityLine = [text(chosen.zip), text(chosen.city)].filter(Boolean).join(" ");
  const lines = [text(chosen.name) ?? name, text(chosen.street), cityLine].filter(
    (line): line is string => line !== null && line !== "",
  );
  return {
    name,
    address: lines.length > 0 ? lines.join("\n") : null,
    addressId: integer(chosen.id),
    countryId: refId(chosen.country) ?? GERMANY_COUNTRY_ID,
  };
}

// ---------------------------------------------------------------------------
// contactPerson (SevUser): required by sevdesk, no lookup in the spec

export const contactPersonSchema = z.object({
  id: z.number().int(),
  source: z
    .enum(["input", "invoice", "order"])
    .describe("input: given by the caller; invoice/order: taken from that existing document."),
  sourceId: z.number().int().optional().describe("ID of the document it was taken from."),
});
export type ContactPerson = z.infer<typeof contactPersonSchema>;

export const contactPersonInput = entityId
  .optional()
  .describe(
    "sevdesk user shown as contact person on the document. Default: the contact person of " +
      "the first invoice (or order) sevdesk lists; the answer says which one was used.",
  );

/** Readable form for summaries: "3001 (from invoice 1001)". */
export function contactPersonText(person: ContactPerson): string {
  return person.source === "input"
    ? `${person.id} (given)`
    : `${person.id} (from ${person.source} ${person.sourceId})`;
}

/**
 * The contact person to use: the given one, or the one of an existing
 * document. sevdesk has no user lookup in its spec, so this is the only
 * way to find a valid ID without asking.
 */
export async function resolveContactPerson(
  { sevdesk }: ToolCall,
  given: number | undefined,
  prefer: "invoice" | "order",
): Promise<ContactPerson> {
  if (given !== undefined) return { id: given, source: "input" };
  const fromInvoice = async (): Promise<ContactPerson | undefined> => {
    const body = await sevdesk.call(
      sevdesk.api.GET("/Invoice", { params: { query: { limit: 1, offset: 0 } } }),
    );
    const raw = objectsOf(body)[0];
    const id = raw ? refId(raw.contactPerson) : null;
    return raw && id !== null
      ? { id, source: "invoice", sourceId: integer(raw.id) ?? 0 }
      : undefined;
  };
  const fromOrder = async (): Promise<ContactPerson | undefined> => {
    const body = await sevdesk.call(
      sevdesk.api.GET("/Order", { params: { query: { limit: 1, offset: 0 } } }),
    );
    const raw = objectsOf(body)[0];
    const id = raw ? refId(raw.contactPerson) : null;
    return raw && id !== null ? { id, source: "order", sourceId: integer(raw.id) ?? 0 } : undefined;
  };
  const order = prefer === "invoice" ? [fromInvoice, fromOrder] : [fromOrder, fromInvoice];
  for (const find of order) {
    const found = await find();
    if (found) return found;
  }
  throw badInput(
    "No contactPersonId given, and there is no existing invoice or order to take one from. " +
      "Pass contactPersonId: the ID of the sevdesk user who is the contact person.",
  );
}

// ---------------------------------------------------------------------------
// Invoices as the write tools return them

export const invoiceStateSchema = z.object({
  id: z.number().int(),
  invoiceNumber: z.string().nullable(),
  invoiceType: z.string().nullable(),
  status: z.number().int().nullable(),
  statusName: z.string().nullable(),
  invoiceDate: z.string().nullable(),
  contactId: z.number().int().nullable(),
  currency: z.string().nullable(),
  sumNet: z.number().nullable(),
  sumGross: z.number().nullable(),
  paidAmount: z.number().nullable(),
  openAmount: z
    .number()
    .nullable()
    .describe("sumGross minus paidAmount for open and partially paid invoices, 0 when paid."),
});
export type InvoiceState = z.infer<typeof invoiceStateSchema>;

export function mapInvoiceState(raw: Raw): InvoiceState {
  const status = statusOf(raw.status, INVOICE_STATUS);
  const sumGross = amount(raw.sumGross);
  const paidAmount = amount(raw.paidAmount);
  let openAmount: number | null = null;
  if (status.status === 1000) openAmount = 0;
  else if ((status.status === 200 || status.status === 750) && sumGross !== null) {
    openAmount = cents(sumGross - (paidAmount ?? 0));
  }
  return {
    id: integer(raw.id) ?? 0,
    invoiceNumber: text(raw.invoiceNumber),
    invoiceType: text(raw.invoiceType),
    ...status,
    invoiceDate: isoDateOf(raw.invoiceDate),
    contactId: refId(raw.contact),
    currency: text(raw.currency),
    sumNet: amount(raw.sumNet),
    sumGross,
    paidAmount,
    openAmount,
  };
}

/** The invoice by ID; throws not_found for an unknown ID. */
export async function readInvoice({ sevdesk }: ToolCall, invoiceId: number): Promise<Raw> {
  const body = await sevdesk.call(
    sevdesk.api.GET("/Invoice/{invoiceId}", { params: { path: { invoiceId } } }),
  );
  const raw = objectsOf(body)[0];
  if (raw === undefined) throw notFound("invoice", invoiceId);
  return raw;
}

/** Name of a contact, or null if it cannot be read (previews only). */
export async function contactNameOf(
  { sevdesk }: ToolCall,
  contactId: number | null,
): Promise<string | null> {
  if (contactId === null) return null;
  try {
    const body = await sevdesk.call(
      sevdesk.api.GET("/Contact/{contactId}", { params: { path: { contactId } } }),
    );
    const raw = objectsOf(body)[0];
    return raw ? contactName(raw) : null;
  } catch (error) {
    if (error instanceof SevdeskError && error.kind !== "policy") return null;
    throw error;
  }
}

/** "RE-1001 (ID 1001)", or "ID 1001 (no number yet)" for drafts. */
export function invoiceLabel(invoice: InvoiceState): string {
  return invoice.invoiceNumber
    ? `${invoice.invoiceNumber} (ID ${invoice.id})`
    : `ID ${invoice.id} (no number yet)`;
}

/** "119 EUR"; only ISO codes go into summaries, never free text. */
export function money(value: number | null, currency: string | null): string {
  if (value === null) return "unknown amount";
  return /^[A-Z]{3}$/.test(currency ?? "") ? `${value} ${currency}` : String(value);
}
