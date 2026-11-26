import { z } from "zod";
import { defineTool } from "../policy/registry.js";
import {
  amount,
  badInput,
  codeFor,
  dateRangeInput,
  entityId,
  FOREIGN_DATA_NOTE,
  integer,
  isoDateOf,
  ORDER_STATUS,
  ORDER_TYPE,
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
  totalOf,
  typeOf,
  unixSeconds,
} from "./format.js";
import { present } from "./result.js";

const orderSummarySchema = z.object({
  id: z.number().int(),
  orderNumber: z.string().nullable(),
  orderType: z
    .string()
    .nullable()
    .describe("AN estimate, AB order confirmation, LI delivery note."),
  orderTypeName: z.string().nullable(),
  ...statusFields,
  orderDate: z.string().nullable().describe("YYYY-MM-DD"),
  contactId: z.number().int().nullable(),
  header: z.string().nullable(),
  currency: z.string().nullable(),
  sumNet: z.number().nullable(),
  sumGross: z.number().nullable(),
  sendDate: z.string().nullable(),
});

export function mapOrderSummary(raw: Raw): z.infer<typeof orderSummarySchema> {
  const type = typeOf(raw.orderType, ORDER_TYPE);
  return {
    id: integer(raw.id) ?? 0,
    orderNumber: text(raw.orderNumber),
    orderType: type.code,
    orderTypeName: type.name,
    ...statusOf(raw.status, ORDER_STATUS),
    orderDate: isoDateOf(raw.orderDate),
    contactId: refId(raw.contact),
    header: text(raw.header),
    currency: text(raw.currency),
    sumNet: amount(raw.sumNet),
    sumGross: amount(raw.sumGross),
    sendDate: isoDateOf(raw.sendDate),
  };
}

type OrderStatusCode = 100 | 200 | 300 | 500 | 750 | 1000;

export const searchOrders = defineTool({
  name: "search_orders",
  title: "Search sevdesk orders and estimates",
  description:
    "Lists estimates (Angebote), order confirmations and delivery notes, filtered by status, " +
    "order date range, contact or order number. Each result names its orderType. sevdesk " +
    "cannot filter by orderType; that filter is applied to the fetched page, so a page may " +
    "hold fewer results than limit while more exist (see page.hasMore). Use " +
    "search_invoices for invoices and get_document_pdf (documentType order) for the PDF." +
    FOREIGN_DATA_NOTE,
  class: "R",
  operationId: "getOrders",
  inputSchema: z.object({
    status: z
      .enum(statusNames(ORDER_STATUS))
      .optional()
      .describe("Only orders in this status, e.g. delivered (sent) or accepted."),
    ...dateRangeInput,
    contactId: entityId.optional().describe("Only orders of this contact."),
    orderNumber: z.string().min(1).max(100).optional().describe("Exact order number."),
    orderType: z
      .enum(["AN", "AB", "LI"])
      .optional()
      .describe(
        "AN estimates, AB order confirmations, LI delivery notes; filtered after fetching.",
      ),
    ...pageInput,
  }),
  outputSchema: z.object({
    orders: z.array(orderSummarySchema),
    page: pageSchema.describe(
      "sevdesk's list before the orderType filter: total, count and hasMore refer to all " +
        "types; continue with offset + limit.",
    ),
    orderTypeFilter: z
      .object({
        orderType: z.string(),
        fetched: z.number().int(),
        kept: z.number().int(),
        note: z.string(),
      })
      .optional(),
  }),
  annotations: READ_ANNOTATIONS,
  async handler(args, { sevdesk }) {
    const problem = rangeProblem(args);
    if (problem) throw badInput(problem);
    const body = await sevdesk.call(
      sevdesk.api.GET("/Order", {
        params: {
          query: {
            ...(args.status && { status: codeFor(ORDER_STATUS, args.status) as OrderStatusCode }),
            ...(args.startDate && { startDate: unixSeconds(args.startDate) }),
            ...(args.endDate && { endDate: unixSeconds(args.endDate, true) }),
            ...(args.contactId && {
              "contact[id]": args.contactId,
              "contact[objectName]": "Contact",
            }),
            ...(args.orderNumber && { orderNumber: args.orderNumber }),
            ...pageQuery(args),
          },
        },
      }),
    );
    const fetched = objectsOf(body).map(mapOrderSummary);
    const page = pageOf(args.offset, args.limit, fetched.length, totalOf(body));
    if (args.orderType === undefined) {
      return present({ orders: fetched, page }, { summary: pageSummary(page, "orders") });
    }
    const orders = fetched.filter((order) => order.orderType === args.orderType);
    return present(
      {
        orders,
        page,
        orderTypeFilter: {
          orderType: args.orderType,
          fetched: fetched.length,
          kept: orders.length,
          note:
            "sevdesk has no orderType filter: it was applied to this page only. page.total " +
            "counts all order types; more matches may follow at offset + limit.",
        },
      },
      {
        summary:
          `${orders.length} of ${fetched.length} fetched orders are ${args.orderType} ` +
          `(offset ${args.offset}${page.hasMore ? ", more available" : ""}).`,
      },
    );
  },
});
