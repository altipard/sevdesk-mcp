import { z } from "zod";
import { defineTool, type ToolCall } from "../policy/registry.js";
import { SevdeskError } from "../sevdesk/errors.js";
import {
  addDays,
  amount,
  badInput,
  cents,
  codeFor,
  dateRangeInput,
  daysBetween,
  enshrinedOf,
  entityId,
  FOREIGN_DATA_NOTE,
  INVOICE_STATUS,
  INVOICE_TYPE,
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
  rangeProblem,
  refId,
  statusFields,
  statusNames,
  statusOf,
  text,
  todayIso,
  totalOf,
  typeOf,
  unixSeconds,
} from "./format.js";
import { present } from "./result.js";

// ---------------------------------------------------------------------------
// Mapping

const invoiceSummarySchema = z.object({
  id: z.number().int(),
  invoiceNumber: z.string().nullable(),
  invoiceType: z.string().nullable().describe("sevdesk type code, e.g. RE, SR, MA."),
  invoiceTypeName: z.string().nullable(),
  ...statusFields,
  invoiceDate: z.string().nullable().describe("YYYY-MM-DD"),
  dueDate: z.string().nullable().describe("invoiceDate plus timeToPay days, YYYY-MM-DD."),
  contactId: z.number().int().nullable(),
  header: z.string().nullable(),
  currency: z.string().nullable(),
  sumNet: z.number().nullable(),
  sumGross: z.number().nullable(),
  paidAmount: z.number().nullable(),
  openAmount: z
    .number()
    .nullable()
    .describe("sumGross minus paidAmount for open and partially paid invoices, 0 when paid."),
});
type InvoiceSummary = z.infer<typeof invoiceSummarySchema>;

const OPEN_CODES = [200, 750];

export function mapInvoiceSummary(raw: Raw): InvoiceSummary {
  const id = integer(raw.id) ?? 0;
  const type = typeOf(raw.invoiceType, INVOICE_TYPE);
  const status = statusOf(raw.status, INVOICE_STATUS);
  const invoiceDate = isoDateOf(raw.invoiceDate);
  const timeToPay = integer(raw.timeToPay);
  const sumGross = amount(raw.sumGross);
  const paidAmount = amount(raw.paidAmount);
  let openAmount: number | null = null;
  if (status.status === 1000) openAmount = 0;
  else if (status.status !== null && OPEN_CODES.includes(status.status) && sumGross !== null) {
    openAmount = cents(sumGross - (paidAmount ?? 0));
  }
  return {
    id,
    invoiceNumber: text(raw.invoiceNumber),
    invoiceType: type.code,
    invoiceTypeName: type.name,
    ...status,
    invoiceDate,
    dueDate: invoiceDate !== null && timeToPay !== null ? addDays(invoiceDate, timeToPay) : null,
    contactId: refId(raw.contact),
    header: text(raw.header),
    currency: text(raw.currency),
    sumNet: amount(raw.sumNet),
    sumGross,
    paidAmount,
    openAmount,
  };
}

const positionSchema = z.object({
  id: z.number().int(),
  positionNumber: z.number().int().nullable(),
  name: z.string().nullable(),
  text: z.string().nullable(),
  quantity: z.number().nullable(),
  unityId: z.number().int().nullable(),
  partId: z.number().int().nullable(),
  priceNet: z.number().nullable(),
  priceGross: z.number().nullable(),
  taxRate: z.number().nullable(),
  discount: z.number().nullable(),
});

export function mapPosition(raw: Raw): z.infer<typeof positionSchema> {
  return {
    id: integer(raw.id) ?? 0,
    positionNumber: integer(raw.positionNumber),
    name: text(raw.name),
    text: text(raw.text),
    quantity: amount(raw.quantity),
    unityId: refId(raw.unity),
    partId: refId(raw.part),
    priceNet: amount(raw.priceNet ?? raw.price),
    priceGross: amount(raw.priceGross),
    taxRate: amount(raw.taxRate),
    discount: amount(raw.discount),
  };
}

export const documentPositionSchema = positionSchema;

// ---------------------------------------------------------------------------
// search_invoices

const INVOICE_STATUS_NAMES = statusNames(INVOICE_STATUS);

export const searchInvoices = defineTool({
  name: "search_invoices",
  title: "Search sevdesk invoices",
  description:
    "Lists invoices in sevdesk's order, filtered by status, invoice date range, " +
    "contact or invoice number. Returns a compact summary per invoice (amounts, due date, open " +
    "amount). Use get_invoice for positions and details, list_open_receivables for what " +
    "customers still owe, and search_contacts first to find a contactId." +
    FOREIGN_DATA_NOTE,
  class: "R",
  operationId: "getInvoices",
  inputSchema: z.object({
    status: z
      .enum(INVOICE_STATUS_NAMES)
      .optional()
      .describe("Only invoices in this status (open = sent and not yet paid)."),
    ...dateRangeInput,
    contactId: entityId.optional().describe("Only invoices of this contact."),
    invoiceNumber: z.string().min(1).max(100).optional().describe("Exact invoice number."),
    ...pageInput,
  }),
  outputSchema: z.object({ invoices: z.array(invoiceSummarySchema), page: pageSchema }),
  annotations: READ_ANNOTATIONS,
  async handler(args, { sevdesk }) {
    const problem = rangeProblem(args);
    if (problem) throw badInput(problem);
    const body = await sevdesk.call(
      sevdesk.api.GET("/Invoice", {
        params: {
          query: {
            ...(args.status && {
              status: codeFor(INVOICE_STATUS, args.status) as 50 | 100 | 200 | 750 | 1000,
            }),
            ...(args.startDate && { startDate: unixSeconds(args.startDate) }),
            ...(args.endDate && { endDate: unixSeconds(args.endDate, true) }),
            ...(args.contactId && {
              "contact[id]": args.contactId,
              "contact[objectName]": "Contact",
            }),
            ...(args.invoiceNumber && { invoiceNumber: args.invoiceNumber }),
            ...pageQuery(args),
          },
        },
      }),
    );
    const invoices = objectsOf(body).map(mapInvoiceSummary);
    const page = pageOf(args.offset, args.limit, invoices.length, totalOf(body));
    return present({ invoices, page }, { summary: pageSummary(page, "invoices") });
  },
});

// ---------------------------------------------------------------------------
// get_invoice

const MAX_POSITIONS = 100;

const invoiceDetailSchema = invoiceSummarySchema.extend({
  deliveryDate: z.string().nullable(),
  payDate: z.string().nullable().describe("Date of the last payment, YYYY-MM-DD."),
  sendDate: z.string().nullable(),
  timeToPay: z.number().int().nullable().describe("Days the customer has to pay."),
  address: z.string().nullable().describe("Recipient address as printed."),
  sumTax: z.number().nullable(),
  sumDiscounts: z.number().nullable(),
  taxRuleId: z.number().int().nullable().describe("sevdesk tax rule (bookkeeping 2.0)."),
  taxText: z.string().nullable(),
  dunningLevel: z.number().int().nullable(),
  enshrined: z.boolean().describe("Enshrined (festgeschrieben); can no longer be changed."),
  customerInternalNote: z.string().nullable(),
});

export const getInvoice = defineTool({
  name: "get_invoice",
  title: "Get a sevdesk invoice",
  description:
    `Returns one invoice by its sevdesk ID with up to ${MAX_POSITIONS} positions, amounts, ` +
    "dates and status. If positionsTruncated is true, call again with positionsOffset = " +
    "nextPositionsOffset for the rest. Find the ID with search_invoices. Use get_document_pdf " +
    "for the rendered PDF." +
    FOREIGN_DATA_NOTE,
  class: "R",
  operationId: "getInvoiceById",
  inputSchema: z.object({
    invoiceId: entityId.describe("sevdesk ID of the invoice."),
    positionsOffset: z
      .number()
      .int()
      .min(0)
      .max(100_000)
      .default(0)
      .describe("Positions to skip, for invoices with more than 100 positions."),
  }),
  outputSchema: z.object({
    invoice: invoiceDetailSchema,
    positions: z.array(positionSchema),
    positionsOffset: z.number().int(),
    positionsTruncated: z.boolean().describe("More positions may follow."),
    nextPositionsOffset: z.number().int().optional(),
  }),
  annotations: READ_ANNOTATIONS,
  async handler({ invoiceId, positionsOffset }, { sevdesk }) {
    const body = await sevdesk.call(
      sevdesk.api.GET("/Invoice/{invoiceId}", { params: { path: { invoiceId } } }),
    );
    const raw = objectsOf(body)[0];
    if (raw === undefined) throw notFound("invoice", invoiceId);
    const positionsBody = await sevdesk.call(
      sevdesk.api.GET("/Invoice/{invoiceId}/getPositions", {
        params: {
          path: { invoiceId },
          query: { limit: MAX_POSITIONS, ...(positionsOffset > 0 && { offset: positionsOffset }) },
        },
      }),
    );
    const positions = objectsOf(positionsBody).map(mapPosition);
    const invoice = {
      ...mapInvoiceSummary(raw),
      deliveryDate: isoDateOf(raw.deliveryDate),
      payDate: isoDateOf(raw.payDate),
      sendDate: isoDateOf(raw.sendDate),
      timeToPay: integer(raw.timeToPay),
      address: text(raw.address),
      sumTax: amount(raw.sumTax),
      sumDiscounts: amount(raw.sumDiscounts),
      taxRuleId: refId(raw.taxRule),
      taxText: text(raw.taxText),
      dunningLevel: integer(raw.dunningLevel),
      enshrined: enshrinedOf(raw.enshrined),
      customerInternalNote: text(raw.customerInternalNote),
    };
    const truncated = positions.length >= MAX_POSITIONS;
    return present(
      {
        invoice,
        positions,
        positionsOffset,
        positionsTruncated: truncated,
        ...(truncated && { nextPositionsOffset: positionsOffset + positions.length }),
      },
      {
        summary:
          `Invoice ${invoice.id} (${invoice.statusName ?? "unknown status"}), ` +
          `${positions.length}${truncated ? "+" : ""} positions.`,
      },
    );
  },
});

// ---------------------------------------------------------------------------
// list_open_receivables

/** Upper bound of invoices checked per status, so one call stays bounded. */
export const MAX_RECEIVABLES_SCANNED = 1000;
const SCAN_PAGE = 100;

/**
 * Aging buckets by days overdue: not yet due, then 0-30, 31-60, 61-90 and
 * over 90 days past the due date.
 */
export const AGING_BUCKETS = ["not_due", "0-30", "31-60", "61-90", "over_90"] as const;
type AgingBucket = (typeof AGING_BUCKETS)[number];

export function agingBucketOf(overdue: boolean, daysOverdue: number): AgingBucket {
  if (!overdue) return "not_due";
  if (daysOverdue <= 30) return "0-30";
  if (daysOverdue <= 60) return "31-60";
  if (daysOverdue <= 90) return "61-90";
  return "over_90";
}

const receivableSchema = invoiceSummarySchema.extend({
  overdue: z.boolean(),
  daysOverdue: z.number().int().describe("Days past the due date, 0 if not yet due."),
  agingBucket: z
    .enum(AGING_BUCKETS)
    .describe("not_due, or days overdue: 0-30, 31-60, 61-90, over_90."),
});

const agingSchema = z.object({
  currency: z.string().nullable(),
  bucket: z.enum(AGING_BUCKETS),
  count: z.number().int(),
  openAmount: z.number(),
});

const totalsSchema = z.object({
  currency: z.string().nullable(),
  count: z.number().int(),
  openAmount: z.number(),
  overdueCount: z.number().int(),
  overdueAmount: z.number(),
});
type Totals = z.infer<typeof totalsSchema>;

const typeTotalsSchema = totalsSchema.extend({
  invoiceType: z.string().nullable(),
  invoiceTypeName: z.string().nullable(),
});

/** totalsByType bucket for invoices without an invoiceType. */
const OTHER_TYPE = "other";

const INVOICE_TYPE_CODES = Object.keys(INVOICE_TYPE) as [string, ...string[]];

/**
 * Receivables by default: reminders (MA) only repeat the amount of the
 * invoice they remind of, and cancellations (SR) are not owed by the
 * customer, so counting them would double or distort the totals. WKR is
 * the template of a recurring invoice; the invoices it creates are RE, so
 * the template itself is owed by no one.
 */
export const DEFAULT_RECEIVABLE_TYPES = ["RE", "TR", "AR", "ER"] as const;

/**
 * Time for all pages of one list_open_receivables call. Kept below the 60 s
 * deadline of a single sevdesk call and the 60 s default request timeout of
 * MCP clients, so a partial answer still arrives. Checked before each page
 * and passed to each page as an abort signal, so a hanging page is cut too.
 */
export const RECEIVABLES_DEADLINE_MS = 45_000;

function addTo(entry: Totals, invoice: { openAmount: number | null; overdue: boolean }): void {
  entry.count++;
  entry.openAmount = cents(entry.openAmount + (invoice.openAmount ?? 0));
  if (invoice.overdue) {
    entry.overdueCount++;
    entry.overdueAmount = cents(entry.overdueAmount + (invoice.openAmount ?? 0));
  }
}

const emptyTotals = (currency: string | null): Totals => ({
  currency,
  count: 0,
  openAmount: 0,
  overdueCount: 0,
  overdueAmount: 0,
});

/** Why a scan stopped before sevdesk had no more invoices. */
type ScanStop =
  | { reason: "deadline"; status: 200 | 750 }
  | { reason: "failed"; status: 200 | 750; offset: number; error: SevdeskError };

interface StatusScan {
  invoices: InvoiceSummary[];
  /** Stopped at MAX_RECEIVABLES_SCANNED. */
  truncated: boolean;
  stop?: ScanStop;
}

/** Shared by both status scans: one deadline, and whether a page was asked yet. */
interface ScanState {
  deadline: number;
  requests: number;
}

async function scanStatus(
  call: ToolCall,
  status: 200 | 750,
  contactId: number | undefined,
  state: ScanState,
): Promise<StatusScan> {
  const { sevdesk } = call;
  const invoices: InvoiceSummary[] = [];
  for (let offset = 0; offset < MAX_RECEIVABLES_SCANNED; offset += SCAN_PAGE) {
    const remaining = state.deadline - Date.now();
    if (remaining <= 0) return { invoices, truncated: false, stop: { reason: "deadline", status } };
    // Also cuts a page that hangs, so the deadline holds within a page too.
    const signal = AbortSignal.timeout(remaining);
    const first = state.requests === 0;
    state.requests++;
    let body: unknown;
    try {
      body = await sevdesk.call(
        sevdesk.api.GET("/Invoice", {
          params: {
            query: {
              status,
              ...(contactId && { "contact[id]": contactId, "contact[objectName]": "Contact" }),
              limit: SCAN_PAGE,
              offset,
            },
          },
          signal,
        }),
      );
    } catch (error) {
      // A local policy refusal is never a partial answer; nor is a failure
      // before anything was collected.
      if (error instanceof SevdeskError && error.kind === "policy") throw error;
      if (first) throw error;
      if (signal.aborted)
        return { invoices, truncated: false, stop: { reason: "deadline", status } };
      if (error instanceof SevdeskError) {
        return { invoices, truncated: false, stop: { reason: "failed", status, offset, error } };
      }
      throw error;
    }
    const page = objectsOf(body).map(mapInvoiceSummary);
    invoices.push(...page);
    if (page.length < SCAN_PAGE) return { invoices, truncated: false };
  }
  return { invoices, truncated: true };
}

/** Note for a scan that stopped early; names the cause, never upstream text. */
function stopNote(stop: ScanStop, checked: number): string {
  const cause =
    stop.reason === "deadline"
      ? `Stopped after ${RECEIVABLES_DEADLINE_MS / 1000} s with ${checked} invoices checked`
      : `Reading invoices failed at offset ${stop.offset} of status ${stop.status} ` +
        `(${stop.error.kind}${stop.error.status !== undefined ? ` ${stop.error.status}` : ""}) ` +
        `after ${checked} invoices`;
  const skipped =
    stop.status === 200 ? " Partially paid invoices (status 750) were not queried." : "";
  return `${cause}; receivables and totals are incomplete.${skipped} Narrow by contactId.`;
}

export const listOpenReceivables = defineTool({
  name: "list_open_receivables",
  title: "List open sevdesk receivables",
  description:
    "Lists invoices customers still have to pay (status open or partially paid) with open " +
    "amount, due date, days overdue and aging bucket, sorted by due date, plus totals per " +
    "currency and per invoice type and open amounts per aging bucket (not due, 0-30, 31-60, " +
    "61-90, over 90 days overdue). Reminders (MA) and cancellations (SR) are left out unless listed in " +
    "invoiceTypes, because they would count amounts twice, and so are recurring-invoice " +
    "templates (WKR), whose invoices appear as RE. Stops after " +
    `${RECEIVABLES_DEADLINE_MS / 1000} s, or when a later page fails, and marks the answer as ` +
    "incomplete. " +
    "Use it for dunning and cash-flow " +
    "questions; use search_invoices for any other invoice search." +
    FOREIGN_DATA_NOTE,
  class: "R",
  operationId: "getInvoices",
  inputSchema: z.object({
    contactId: entityId.optional().describe("Only receivables of this contact."),
    overdueOnly: z.boolean().default(false).describe("Only invoices past their due date."),
    invoiceTypes: z
      .array(z.enum(INVOICE_TYPE_CODES))
      .min(1)
      .max(INVOICE_TYPE_CODES.length)
      .optional()
      .describe(
        "Invoice types to include (RE invoice, WKR recurring-invoice template, TR partial, " +
          "AR advance, ER final, MA reminder, SR cancellation). Default: RE, TR, AR, ER.",
      ),
    ...pageInput,
  }),
  outputSchema: z.object({
    asOf: z.string().describe("Today in German time; overdue is computed against it."),
    receivables: z.array(receivableSchema),
    totals: z.array(totalsSchema).describe("Over all matching receivables, not just this page."),
    totalsByType: z
      .array(typeTotalsSchema)
      .describe("The same totals split by invoice type and currency."),
    aging: z
      .array(agingSchema)
      .describe(
        "Open amount per currency and aging bucket (not_due, 0-30, 31-60, 61-90, over_90 days " +
          "overdue), over all matching receivables; every bucket is listed per currency.",
      ),
    page: pageSchema,
    truncated: z
      .boolean()
      .describe("Not every open invoice was checked (scan or time limit); totals may be low."),
    note: z.string().optional(),
  }),
  annotations: READ_ANNOTATIONS,
  async handler(args, call) {
    const asOf = todayIso();
    // The default is applied here, not in the schema, so the standard filter
    // is the absence of the input: even all four default codes passed
    // explicitly stay exact. Only the standard filter takes in invoices
    // sevdesk sent without a type, as receivables like any other.
    const untypedIncluded = args.invoiceTypes === undefined;
    const types = new Set<string>(args.invoiceTypes ?? DEFAULT_RECEIVABLE_TYPES);
    const state: ScanState = { deadline: Date.now() + RECEIVABLES_DEADLINE_MS, requests: 0 };
    const open = await scanStatus(call, 200, args.contactId, state);
    const partial: StatusScan =
      open.stop === undefined
        ? await scanStatus(call, 750, args.contactId, state)
        : { invoices: [], truncated: false };
    const capped = open.truncated || partial.truncated;
    const stop = open.stop ?? partial.stop;
    const truncated = capped || stop !== undefined;

    const all = [...open.invoices, ...partial.invoices]
      .filter((invoice) => (invoice.openAmount ?? 0) > 0)
      .map((invoice) => {
        const days = invoice.dueDate === null ? 0 : daysBetween(invoice.dueDate, asOf);
        const daysOverdue = Math.max(0, days);
        return {
          ...invoice,
          overdue: days > 0,
          daysOverdue,
          agingBucket: agingBucketOf(days > 0, daysOverdue),
        };
      })
      .filter((invoice) => !args.overdueOnly || invoice.overdue)
      .filter((invoice) =>
        invoice.invoiceType === null ? untypedIncluded : types.has(invoice.invoiceType),
      )
      .sort((a, b) => (a.dueDate ?? "9999").localeCompare(b.dueDate ?? "9999") || a.id - b.id);

    const aging = new Map<string, z.infer<typeof agingSchema>>();
    for (const invoice of all) {
      for (const bucket of AGING_BUCKETS) {
        const key = `${invoice.currency ?? ""}\u0000${bucket}`;
        if (!aging.has(key)) {
          aging.set(key, { currency: invoice.currency, bucket, count: 0, openAmount: 0 });
        }
      }
      const entry = aging.get(`${invoice.currency ?? ""}\u0000${invoice.agingBucket}`);
      if (entry) {
        entry.count++;
        entry.openAmount = cents(entry.openAmount + (invoice.openAmount ?? 0));
      }
    }

    const totals = new Map<string, Totals>();
    const byType = new Map<string, z.infer<typeof typeTotalsSchema>>();
    for (const invoice of all) {
      const key = invoice.currency ?? "";
      const entry = totals.get(key) ?? emptyTotals(invoice.currency);
      addTo(entry, invoice);
      totals.set(key, entry);
      const typeKey = `${invoice.invoiceType ?? OTHER_TYPE}\u0000${key}`;
      const typeEntry = byType.get(typeKey) ?? {
        invoiceType: invoice.invoiceType ?? OTHER_TYPE,
        invoiceTypeName: invoice.invoiceTypeName ?? OTHER_TYPE,
        ...emptyTotals(invoice.currency),
      };
      addTo(typeEntry, invoice);
      byType.set(typeKey, typeEntry);
    }

    const receivables = all.slice(args.offset, args.offset + args.limit);
    const page = pageOf(args.offset, args.limit, receivables.length, all.length);
    const totalList = [...totals.values()];
    // Only ISO currency codes go into the summary line, never free text.
    const sums = totalList
      .map((t) => `${t.openAmount} ${/^[A-Z]{3}$/.test(t.currency ?? "") ? t.currency : ""}`.trim())
      .join(", ");
    const notes = [
      capped &&
        `Checked only the first ${MAX_RECEIVABLES_SCANNED} invoices per status; ` +
          "totals may be incomplete. Narrow by contactId.",
      stop !== undefined && stopNote(stop, open.invoices.length + partial.invoices.length),
    ].filter((note): note is string => typeof note === "string");
    return present(
      {
        asOf,
        receivables,
        totals: totalList,
        totalsByType: [...byType.values()].sort(
          (a, b) =>
            (a.invoiceType ?? "").localeCompare(b.invoiceType ?? "") ||
            (a.currency ?? "").localeCompare(b.currency ?? ""),
        ),
        aging: [...aging.values()],
        page,
        truncated,
        ...(notes.length > 0 && { note: notes.join(" ") }),
      },
      {
        summary: `${pageSummary(page, "open receivables")}${
          sums ? ` Open in ${truncated ? "what was checked" : "total"}: ${sums}.` : ""
        }${truncated ? " Incomplete, see note." : ""}`,
      },
    );
  },
});
