import { z } from "zod";
import { defineTool, type ToolCall } from "../policy/registry.js";
import { SevdeskError } from "../sevdesk/errors.js";
import {
  asRecord,
  badInput,
  CONTACT_STATUS,
  entityId,
  FOREIGN_DATA_NOTE,
  flag,
  integer,
  isoDateOf,
  notFound,
  objectsOf,
  pageInput,
  pageOf,
  pageQuery,
  pageSchema,
  pageSummary,
  type Raw,
  READ_ANNOTATIONS,
  refId,
  statusFields,
  statusOf,
  text,
  totalOf,
} from "./format.js";
import { present } from "./result.js";

/** Contacts checked one by one by a name search. */
export const MAX_CONTACTS_SCANNED = 500;
const SCAN_PAGE = 100;
/** Contacts taken from sevdesk's own name filter when the scan stopped early. */
export const MAX_NAME_FILTER_RESULTS = 100;
/**
 * Upper bound for the name filter request. It only adds to a scan that
 * already ran, so it gets less time than a normal call and no retries.
 */
export const NAME_LOOKUP_TIMEOUT_MS = 10_000;

// ---------------------------------------------------------------------------
// Mapping

const contactSummarySchema = z.object({
  id: z.number().int(),
  customerNumber: z.string().nullable(),
  name: z.string().nullable().describe("Organisation name, or first and last name of a person."),
  isPerson: z.boolean(),
  firstName: z.string().nullable(),
  lastName: z.string().nullable(),
  organisationId: z.number().int().nullable().describe("Organisation a person belongs to."),
  categoryId: z.number().int().nullable().describe("sevdesk contact category (3 = customer)."),
  ...statusFields,
  vatNumber: z.string().nullable(),
});
type ContactSummary = z.infer<typeof contactSummarySchema>;

export function mapContactSummary(raw: Raw): ContactSummary {
  const firstName = text(raw.surename);
  const lastName = text(raw.familyname);
  const organisation = text(raw.name);
  const isPerson = organisation === null && (firstName !== null || lastName !== null);
  const personName = [firstName, lastName].filter((part) => part !== null).join(" ");
  return {
    id: integer(raw.id) ?? 0,
    customerNumber: text(raw.customerNumber),
    name: organisation ?? (personName === "" ? null : personName),
    isPerson,
    firstName,
    lastName,
    organisationId: refId(raw.parent),
    categoryId: refId(raw.category),
    ...statusOf(raw.status, CONTACT_STATUS),
    vatNumber: text(raw.vatNumber),
  };
}

/** Lower case without accents, so "Müller" matches "muller" and "MÜLLER". */
export function fold(value: string): string {
  return value
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .replace(/ß/g, "ss")
    .toLowerCase();
}

function matchesName(raw: Raw, needle: string): boolean {
  const fields = [raw.name, raw.name2, raw.surename, raw.familyname, raw.customerNumber]
    .map(text)
    .filter((value): value is string => value !== null);
  const full = [text(raw.surename), text(raw.familyname)].filter(Boolean).join(" ");
  return [...fields, full].some((value) => fold(value).includes(needle));
}

// ---------------------------------------------------------------------------
// search_contacts

const searchOutput = z.object({
  contacts: z.array(
    contactSummarySchema.extend({
      matchedEmail: z.string().optional().describe("E-mail address that matched the query."),
    }),
  ),
  page: pageSchema,
  scan: z
    .object({
      mode: z.enum(["name", "email"]),
      checked: z.number().int().describe("Contacts or e-mail addresses checked."),
      truncated: z.boolean().describe("Not everything was checked; results may be missing."),
      note: z.string().optional(),
    })
    .optional()
    .describe("Only for query searches, which sevdesk cannot filter reliably itself."),
});
type SearchOutput = z.infer<typeof searchOutput>;

/**
 * Page over the matches of a scan that stopped early. total is unknown:
 * contacts beyond the scan may match too. hasMore stays true while a page
 * returns matches or more reachable matches follow, so the list never
 * looks complete; the first empty page after them ends paging, because a
 * higher offset cannot reach contacts the scan never saw.
 */
function truncatedPage(
  offset: number,
  limit: number,
  count: number,
  moreReachable: boolean,
): SearchOutput["page"] {
  return pageOf(offset, limit, count, null, moreReachable || count > 0);
}

/** scan.note text for a scan that stopped early. */
function beyondScanNote(checked: number, what: string, narrower: string): string {
  return (
    `Checked the first ${checked} ${what} only; more matching contacts may exist beyond them, ` +
    `so total is unknown and paging ends after the matches found. ${narrower}`
  );
}

async function scanByName(
  { sevdesk }: ToolCall,
  needle: string,
  depth: "0" | "1",
): Promise<{ matches: ContactSummary[]; checked: number; truncated: boolean }> {
  const matches: ContactSummary[] = [];
  let checked = 0;
  for (let offset = 0; offset < MAX_CONTACTS_SCANNED; offset += SCAN_PAGE) {
    const body = await sevdesk.call(
      sevdesk.api.GET("/Contact", { params: { query: { depth, limit: SCAN_PAGE, offset } } }),
    );
    const page = objectsOf(body);
    checked += page.length;
    for (const raw of page) if (matchesName(raw, needle)) matches.push(mapContactSummary(raw));
    if (page.length < SCAN_PAGE) return { matches, checked, truncated: false };
  }
  return { matches, checked, truncated: true };
}

/**
 * Organisations sevdesk itself finds by name, for contacts beyond the scan.
 * The `name` query parameter of GET /Contact is undocumented; the overlay
 * declares it after a live test showed sevdesk honours it for organisation
 * names. Every hit is matched locally again, so a server that ignores the
 * parameter adds no false matches. The lookup is optional: any sevdesk
 * error (sevdesk answers some invalid input with 500) or running out of
 * time yields `failed`, so the caller falls back to the scan; only a local
 * policy refusal is thrown.
 */
async function lookupByName(
  { sevdesk }: ToolCall,
  query: string,
  needle: string,
  depth: "0" | "1",
): Promise<{ matches: Raw[]; full: boolean } | { failed: SevdeskError }> {
  let body: unknown;
  try {
    body = await sevdesk.call(
      // One attempt within its own time limit: retries and the client's
      // longer timeout would let an optional request hold up the answer.
      sevdesk.apiSingleAttempt.GET("/Contact", {
        params: { query: { depth, name: query, limit: MAX_NAME_FILTER_RESULTS, offset: 0 } },
        signal: AbortSignal.timeout(NAME_LOOKUP_TIMEOUT_MS),
      }),
    );
  } catch (error) {
    if (error instanceof SevdeskError && error.kind !== "policy") return { failed: error };
    // The client maps the abort to a timeout; this keeps the fallback if
    // the abort ever surfaces unmapped.
    if (error instanceof Error && error.name === "TimeoutError") {
      return { failed: new SevdeskError("timeout", "sevdesk's name filter did not answer.") };
    }
    throw error;
  }
  const page = objectsOf(body);
  return {
    matches: page.filter((raw) => matchesName(raw, needle)),
    full: page.length >= MAX_NAME_FILTER_RESULTS,
  };
}

/** E-mail addresses checked by an e-mail search, paged like the name scan. */
export const MAX_EMAILS_SCANNED = 500;
/** Contacts fetched one by one for an e-mail search, so one call stays bounded. */
export const MAX_EMAIL_CONTACT_FETCHES = 100;

async function scanEmails(
  { sevdesk }: ToolCall,
  needle: string,
): Promise<{ byContact: Map<number, string>; checked: number; truncated: boolean }> {
  const byContact = new Map<number, string>();
  let checked = 0;
  for (let offset = 0; offset < MAX_EMAILS_SCANNED; offset += SCAN_PAGE) {
    const body = await sevdesk.call(
      sevdesk.api.GET("/CommunicationWay", {
        params: { query: { type: "EMAIL", limit: SCAN_PAGE, offset } },
      }),
    );
    const page = objectsOf(body);
    checked += page.length;
    for (const way of page) {
      const value = text(way.value);
      const contactId = refId(way.contact);
      if (value !== null && contactId !== null && fold(value).includes(needle)) {
        if (!byContact.has(contactId)) byContact.set(contactId, value);
      }
    }
    if (page.length < SCAN_PAGE) return { byContact, checked, truncated: false };
  }
  return { byContact, checked, truncated: true };
}

/** The contact, or undefined if sevdesk no longer has it (404 or empty answer). */
async function contactOrMissing(
  { sevdesk }: ToolCall,
  contactId: number,
): Promise<Raw | undefined> {
  try {
    const body = await sevdesk.call(
      sevdesk.api.GET("/Contact/{contactId}", { params: { path: { contactId } } }),
    );
    return objectsOf(body)[0];
  } catch (error) {
    if (error instanceof SevdeskError && error.kind === "not_found") return undefined;
    throw error;
  }
}

async function searchByEmail(
  call: ToolCall,
  needle: string,
  args: { limit: number; offset: number; includePersons: boolean },
): Promise<SearchOutput> {
  const scan = await scanEmails(call, needle);
  const ids = [...scan.byContact.keys()].sort((a, b) => a - b);
  const contacts: SearchOutput["contacts"] = [];
  let missing = 0;
  let fetches = 0;
  let fetchCapped = false;
  let page: SearchOutput["page"];

  if (args.includePersons) {
    // Every match counts, so total is known and only this page is fetched.
    for (const contactId of ids.slice(args.offset, args.offset + args.limit)) {
      const raw = await contactOrMissing(call, contactId);
      if (raw === undefined) {
        missing++;
        continue;
      }
      contacts.push({
        ...mapContactSummary(raw),
        matchedEmail: scan.byContact.get(contactId) as string,
      });
    }
    // Counted by the end of the slice, not by the contacts returned: those
    // that no longer exist are missing from the page, and offset + count
    // would offer the same slice again.
    const moreAfterSlice = args.offset + args.limit < ids.length;
    page = scan.truncated
      ? truncatedPage(args.offset, args.limit, contacts.length, moreAfterSlice)
      : pageOf(args.offset, args.limit, contacts.length, ids.length, moreAfterSlice);
  } else {
    // Whether a match is a person shows only on the contact itself: walk the
    // matches in order, skip persons, stop when the page is full or the
    // fetch budget is spent. total is unknown then.
    let eligible = 0;
    let index = 0;
    for (; index < ids.length && contacts.length < args.limit; index++) {
      if (fetches >= MAX_EMAIL_CONTACT_FETCHES) break;
      const contactId = ids[index] as number;
      fetches++;
      const raw = await contactOrMissing(call, contactId);
      if (raw === undefined) {
        missing++;
        continue;
      }
      const summary = mapContactSummary(raw);
      if (summary.isPerson) continue;
      eligible++;
      if (eligible > args.offset) {
        contacts.push({ ...summary, matchedEmail: scan.byContact.get(contactId) as string });
      }
    }
    // Every call walks the matches from the start with the same fetch
    // budget, so a later offset reaches nothing this walk did not: once the
    // budget is spent, matches left over cannot be paged to.
    fetchCapped = index < ids.length && fetches >= MAX_EMAIL_CONTACT_FETCHES;
    page = pageOf(
      args.offset,
      args.limit,
      contacts.length,
      null,
      !fetchCapped && (index < ids.length || (scan.truncated && contacts.length > 0)),
    );
  }

  const notes = [
    scan.truncated &&
      beyondScanNote(
        scan.checked,
        "e-mail addresses",
        "Search more specifically: a longer part of the e-mail address, a name or customerNumber.",
      ),
    fetchCapped &&
      `Stopped after looking up ${MAX_EMAIL_CONTACT_FETCHES} contacts; further matches cannot be ` +
        "paged to with includePersons=false. Narrow the query or set includePersons=true.",
    missing > 0 && `${missing} matching contacts no longer exist in sevdesk and were skipped.`,
  ].filter((note): note is string => typeof note === "string");
  return {
    contacts,
    page,
    scan: {
      mode: "email",
      checked: scan.checked,
      truncated: scan.truncated || fetchCapped,
      ...(notes.length > 0 && { note: notes.join(" ") }),
    },
  };
}

export const searchContacts = defineTool({
  name: "search_contacts",
  title: "Search sevdesk contacts",
  description:
    "Finds customers, suppliers and other contacts. customerNumber uses sevdesk's own filter " +
    "(exact). query searches name and customer number (case- and accent-insensitive); a query " +
    "containing '@' searches e-mail addresses instead. sevdesk cannot reliably filter by name " +
    `or e-mail, so a query checks at most ${MAX_CONTACTS_SCANNED} contacts or ` +
    `${MAX_EMAILS_SCANNED} e-mail addresses and says when it stopped early; beyond that, ` +
    `up to ${MAX_NAME_FILTER_RESULTS} organisations are also looked up by sevdesk's own name ` +
    "filter, which may miss umlaut and spelling variants. " +
    "Without filters it lists contacts page by page. Use get_contact for addresses and " +
    "communication details, and the returned id as contactId in the invoice, order and " +
    "voucher searches." +
    FOREIGN_DATA_NOTE,
  class: "R",
  operationId: "getContacts",
  inputSchema: z.object({
    query: z
      .string()
      .trim()
      .min(2)
      .max(100)
      .optional()
      .describe("Part of a name, customer number or (with '@') e-mail address."),
    customerNumber: z.string().trim().min(1).max(50).optional().describe("Exact customer number."),
    includePersons: z
      .boolean()
      .default(true)
      .describe("Also return persons, not only organisations (all search modes)."),
    ...pageInput,
  }),
  outputSchema: searchOutput,
  annotations: READ_ANNOTATIONS,
  async handler(args, call) {
    if (args.query !== undefined && args.customerNumber !== undefined) {
      throw badInput("Use either query or customerNumber, not both.");
    }
    const depth = args.includePersons ? "1" : "0";
    const { sevdesk } = call;

    if (args.query === undefined) {
      const body = await sevdesk.call(
        sevdesk.api.GET("/Contact", {
          params: {
            query: {
              depth,
              ...(args.customerNumber !== undefined && { customerNumber: args.customerNumber }),
              ...pageQuery(args),
            },
          },
        }),
      );
      const contacts = objectsOf(body).map(mapContactSummary);
      const page = pageOf(args.offset, args.limit, contacts.length, totalOf(body));
      return present({ contacts, page }, { summary: pageSummary(page, "contacts") });
    }

    const needle = fold(args.query);
    if (args.query.includes("@")) {
      const result = await searchByEmail(call, needle, args);
      return present(result, {
        summary: `${pageSummary(result.page, "contacts with a matching e-mail")}${
          result.scan?.truncated ? " Search was cut short, see scan.note." : ""
        }`,
      });
    }

    const scan = await scanByName(call, needle, depth);
    // A complete scan has seen every contact; only beyond it is sevdesk's
    // name filter asked. Its extra hits follow the scan's, so paging over
    // the merged list stays stable.
    const lookup = scan.truncated ? await lookupByName(call, args.query, needle, depth) : undefined;
    const found = lookup !== undefined && "matches" in lookup ? lookup : undefined;
    const seen = new Set(scan.matches.map((match) => match.id));
    const extra: ContactSummary[] = [];
    for (const raw of found?.matches ?? []) {
      const summary = mapContactSummary(raw);
      if (seen.has(summary.id)) continue;
      seen.add(summary.id);
      extra.push(summary);
    }
    const matches = [...scan.matches, ...extra];
    const contacts = matches.slice(args.offset, args.offset + args.limit);
    const page = scan.truncated
      ? truncatedPage(
          args.offset,
          args.limit,
          contacts.length,
          args.offset + contacts.length < matches.length,
        )
      : pageOf(args.offset, args.limit, contacts.length, matches.length);
    const failure = lookup !== undefined && "failed" in lookup ? lookup.failed : undefined;
    const notes = [
      scan.truncated &&
        beyondScanNote(
          scan.checked,
          "contacts",
          "Search more specifically: a longer part of the name, an e-mail address " +
            "(query with @) or customerNumber.",
        ),
      found !== undefined &&
        `sevdesk's name filter found ${extra.length} more organisations beyond them` +
          `${found.full ? ` (first ${MAX_NAME_FILTER_RESULTS} results only)` : ""}; ` +
          "it may miss umlaut and spelling variants, and persons and customer numbers there " +
          "are not searched.",
      // Kind and status only: sevdesk's error text stays out of the answer.
      failure !== undefined &&
        (failure.kind === "timeout"
          ? `sevdesk's name filter did not answer within ${NAME_LOOKUP_TIMEOUT_MS / 1000} s, ` +
            "so only the scan was used."
          : `sevdesk's name filter failed (${failure.kind}${
              failure.status !== undefined ? ` ${failure.status}` : ""
            }), so only the scan was used.`),
      // Each call runs the lookup again, and its extra hits follow the
      // scan's: if it answered for an earlier page but not this one (or the
      // other way round), the merged list differs between the calls.
      failure !== undefined &&
        args.offset > 0 &&
        "Earlier pages may have included its results, so matches can have shifted or be " +
          "missing between pages; repeat the search from offset 0 for a consistent list.",
    ].filter((note): note is string => typeof note === "string");
    const output: SearchOutput = {
      contacts,
      page,
      scan: {
        mode: "name",
        checked: scan.checked,
        truncated: scan.truncated,
        ...(notes.length > 0 && { note: notes.join(" ") }),
      },
    };
    return present(output, {
      summary: `${pageSummary(page, "matching contacts")} Checked ${scan.checked} contacts${
        scan.truncated ? ", stopped early" : ""
      }.`,
    });
  },
});

// ---------------------------------------------------------------------------
// get_contact

const addressSchema = z.object({
  id: z.number().int(),
  street: z.string().nullable(),
  zip: z.string().nullable(),
  city: z.string().nullable(),
  countryId: z.number().int().nullable(),
  name: z.string().nullable(),
  categoryId: z.number().int().nullable(),
});

const communicationWaySchema = z.object({
  id: z.number().int(),
  type: z.string().nullable().describe("EMAIL, PHONE, MOBILE or WEB."),
  value: z.string().nullable(),
  main: z.boolean().nullable(),
});

function mapAddress(raw: Raw): z.infer<typeof addressSchema> {
  return {
    id: integer(raw.id) ?? 0,
    street: text(raw.street),
    zip: text(raw.zip),
    city: text(raw.city),
    countryId: refId(raw.country),
    name: text(raw.name),
    categoryId: refId(raw.category),
  };
}

const contactDetailSchema = contactSummarySchema.extend({
  name2: z.string().nullable(),
  academicTitle: z.string().nullable(),
  title: z.string().nullable(),
  gender: z.string().nullable(),
  birthday: z.string().nullable(),
  description: z.string().nullable(),
  taxNumber: z.string().nullable(),
  bankAccount: z.string().nullable(),
  bankNumber: z.string().nullable(),
  defaultTimeToPay: z.number().int().nullable().describe("Default payment term in days."),
  exemptVat: z.boolean().nullable(),
  buyerReference: z.string().nullable().describe("Leitweg-ID for e-invoices to authorities."),
  governmentAgency: z.boolean().nullable(),
});

export const getContact = defineTool({
  name: "get_contact",
  title: "Get a sevdesk contact",
  description:
    "Returns one contact by its sevdesk ID with master data, addresses and communication " +
    "ways (e-mail, phone, web). Find the ID with search_contacts." +
    FOREIGN_DATA_NOTE,
  class: "R",
  operationId: "getContactById",
  inputSchema: z.object({ contactId: entityId.describe("sevdesk ID of the contact.") }),
  outputSchema: z.object({
    contact: contactDetailSchema,
    addresses: z.array(addressSchema),
    communicationWays: z.array(communicationWaySchema),
    note: z.string().optional(),
  }),
  annotations: READ_ANNOTATIONS,
  async handler({ contactId }, { sevdesk }) {
    // "addresses" is the documented generic embed applied to the contact's
    // address list; the name is not confirmed by the spec, so a missing
    // embed is reported instead of failing.
    let body: unknown;
    let embedRefused = false;
    try {
      body = await sevdesk.call(
        sevdesk.api.GET("/Contact/{contactId}", {
          params: { path: { contactId }, query: { embed: "addresses" } },
        }),
      );
    } catch (error) {
      // If sevdesk rejects the embed itself, the contact is still readable:
      // try once more without it and say that addresses are missing.
      const refused =
        error instanceof SevdeskError &&
        (error.kind === "bad_request" || error.kind === "validation");
      if (!refused) throw error;
      embedRefused = true;
      body = await sevdesk.call(
        sevdesk.api.GET("/Contact/{contactId}", { params: { path: { contactId } } }),
      );
    }
    const raw = objectsOf(body)[0];
    if (raw === undefined) throw notFound("contact", contactId);
    const waysBody = await sevdesk.call(
      sevdesk.api.GET("/CommunicationWay", {
        params: { query: { "contact[id]": String(contactId), "contact[objectName]": "Contact" } },
      }),
    );
    const embedded = raw.addresses;
    const addresses = Array.isArray(embedded)
      ? embedded.map((entry) => mapAddress(asRecord(entry)))
      : [];
    const communicationWays = objectsOf(waysBody)
      // Belt and braces: keep only this contact's entries.
      .filter((way) => refId(way.contact) === null || refId(way.contact) === contactId)
      .map((way) => ({
        id: integer(way.id) ?? 0,
        type: text(way.type),
        value: text(way.value),
        main: flag(way.main),
      }));
    const contact = {
      ...mapContactSummary(raw),
      name2: text(raw.name2),
      academicTitle: text(raw.academicTitle),
      title: text(raw.titel),
      gender: text(raw.gender),
      birthday: isoDateOf(raw.birthday),
      description: text(raw.description),
      taxNumber: text(raw.taxNumber),
      bankAccount: text(raw.bankAccount),
      bankNumber: text(raw.bankNumber),
      defaultTimeToPay: integer(raw.defaultTimeToPay),
      exemptVat: flag(raw.exemptVat),
      buyerReference: text(raw.buyerReference),
      governmentAgency: flag(raw.governmentAgency),
    };
    return present(
      {
        contact,
        addresses,
        communicationWays,
        ...(embedRefused
          ? {
              note: "sevdesk refused to embed the addresses of this contact; they are not listed here.",
            }
          : !Array.isArray(embedded) && {
              note: "sevdesk did not embed the addresses of this contact; they are not listed here.",
            }),
      },
      {
        summary:
          `Contact ${contact.id}: ${addresses.length} addresses, ` +
          `${communicationWays.length} communication ways.`,
      },
    );
  },
});
