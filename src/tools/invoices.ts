import { z } from "zod";
import { defineTool, type ToolCall } from "../policy/registry.js";
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

const receivableSchema = invoiceSummarySchema.extend({
  overdue: z.boolean(),
  daysOverdue: z.number().int().describe("Days past the due date, 0 if not yet due."),
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
 * customer, so counting them would double or distort the totals.
 */
export const DEFAULT_RECEIVABLE_TYPES = ["RE", "WKR", "TR", "AR", "ER"] as const;

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

async function scanStatus(
  call: ToolCall,
  status: 200 | 750,
  contactId: number | undefined,
): Promise<{ invoices: InvoiceSummary[]; truncated: boolean }> {
  const { sevdesk } = call;
  const invoices: InvoiceSummary[] = [];
  for (let offset = 0; offset < MAX_RECEIVABLES_SCANNED; offset += SCAN_PAGE) {
    const body = await sevdesk.call(
      sevdesk.api.GET("/Invoice", {
        params: {
          query: {
            status,
            ...(contactId && { "contact[id]": contactId, "contact[objectName]": "Contact" }),
            limit: SCAN_PAGE,
            offset,
          },
        },
      }),
    );
    const page = objectsOf(body).map(mapInvoiceSummary);
    invoices.push(...page);
    if (page.length < SCAN_PAGE) return { invoices, truncated: false };
  }
  return { invoices, truncated: true };
}

export const listOpenReceivables = defineTool({
  name: "list_open_receivables",
  title: "List open sevdesk receivables",
  description:
    "Lists invoices customers still have to pay (status open or partially paid) with open " +
    "amount, due date and days overdue, sorted by due date, plus totals per currency and per " +
    "invoice type. Reminders (MA) and cancellations (SR) are left out unless listed in " +
    "invoiceTypes, because they would count amounts twice. Use it for dunning and cash-flow " +
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
        "Invoice types to include (RE invoice, WKR recurring, TR partial, AR advance, ER final, " +
          "MA reminder, SR cancellation). Default: RE, WKR, TR, AR, ER.",
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
    page: pageSchema,
    truncated: z.boolean(),
    note: z.string().optional(),
  }),
  annotations: READ_ANNOTATIONS,
  async handler(args, call) {
    const asOf = todayIso();
    // The default is applied here, not in the schema, so the standard filter
    // is the absence of the input: even all five default codes passed
    // explicitly stay exact. Only the standard filter takes in invoices
    // sevdesk sent without a type, as receivables like any other.
    const untypedIncluded = args.invoiceTypes === undefined;
    const types = new Set<string>(args.invoiceTypes ?? DEFAULT_RECEIVABLE_TYPES);
    const open = await scanStatus(call, 200, args.contactId);
    const partial = await scanStatus(call, 750, args.contactId);
    const truncated = open.truncated || partial.truncated;

    const all = [...open.invoices, ...partial.invoices]
      .filter((invoice) => (invoice.openAmount ?? 0) > 0)
      .map((invoice) => {
        const days = invoice.dueDate === null ? 0 : daysBetween(invoice.dueDate, asOf);
        return { ...invoice, overdue: days > 0, daysOverdue: Math.max(0, days) };
      })
      .filter((invoice) => !args.overdueOnly || invoice.overdue)
      .filter((invoice) =>
        invoice.invoiceType === null ? untypedIncluded : types.has(invoice.invoiceType),
      )
      .sort((a, b) => (a.dueDate ?? "9999").localeCompare(b.dueDate ?? "9999") || a.id - b.id);

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
        page,
        truncated,
        ...(truncated && {
          note:
            `Checked only the first ${MAX_RECEIVABLES_SCANNED} invoices per status; ` +
            "totals may be incomplete. Narrow by contactId.",
        }),
      },
      {
        summary: `${pageSummary(page, "open receivables")}${sums ? ` Open in total: ${sums}.` : ""}`,
      },
    );
  },
});
