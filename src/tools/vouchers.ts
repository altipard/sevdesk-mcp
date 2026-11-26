import { z } from "zod";
import { defineTool } from "../policy/registry.js";
import {
  amount,
  badInput,
  cents,
  codeFor,
  dateRangeInput,
  enshrinedOf,
  entityId,
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
  rangeProblem,
  refId,
  statusFields,
  statusNames,
  statusOf,
  text,
  totalOf,
  unixSeconds,
  VOUCHER_STATUS,
} from "./format.js";
import { present } from "./result.js";

const voucherSummarySchema = z.object({
  id: z.number().int(),
  voucherDate: z.string().nullable().describe("YYYY-MM-DD"),
  description: z.string().nullable().describe("Voucher number or text, as entered."),
  supplierId: z.number().int().nullable(),
  supplierName: z.string().nullable(),
  ...statusFields,
  creditDebit: z.string().nullable().describe("D = debit (expense), C = credit (income)."),
  voucherType: z.string().nullable().describe("VOU normal, RV recurring."),
  currency: z.string().nullable(),
  sumNet: z.number().nullable(),
  sumGross: z.number().nullable(),
  paidAmount: z.number().nullable(),
  openAmount: z
    .number()
    .nullable()
    .describe("sumGross minus paidAmount while unpaid, 0 when paid."),
  payDate: z.string().nullable(),
  paymentDeadline: z.string().nullable(),
});
type VoucherSummary = z.infer<typeof voucherSummarySchema>;

const UNPAID_CODES = [100, 150, 750];

export function mapVoucherSummary(raw: Raw): VoucherSummary {
  const status = statusOf(raw.status, VOUCHER_STATUS);
  const sumGross = amount(raw.sumGross);
  const paidAmount = amount(raw.paidAmount);
  let openAmount: number | null = null;
  if (status.status === 1000) openAmount = 0;
  else if (status.status !== null && UNPAID_CODES.includes(status.status) && sumGross !== null) {
    openAmount = cents(sumGross - (paidAmount ?? 0));
  }
  return {
    id: integer(raw.id) ?? 0,
    voucherDate: isoDateOf(raw.voucherDate),
    description: text(raw.description),
    supplierId: refId(raw.supplier),
    supplierName: text(raw.supplierName),
    ...status,
    creditDebit: text(raw.creditDebit),
    voucherType: text(raw.voucherType),
    currency: text(raw.currency),
    sumNet: amount(raw.sumNet),
    sumGross,
    paidAmount,
    openAmount,
    payDate: isoDateOf(raw.payDate),
    paymentDeadline: isoDateOf(raw.paymentDeadline),
  };
}

type VoucherStatusCode = 50 | 100 | 150 | 750 | 1000;

export const searchVouchers = defineTool({
  name: "search_vouchers",
  title: "Search sevdesk vouchers",
  description:
    "Lists vouchers (Belege: incoming invoices, receipts) filtered by status, voucher date " +
    "range, text in the description, debit/credit or supplier contact. Use get_voucher for " +
    "the positions with booking accounts and get_tax_guidance for allowed accounts and tax rules.",
  class: "R",
  operationId: "getVouchers",
  inputSchema: z.object({
    status: z
      .enum(statusNames(VOUCHER_STATUS))
      .optional()
      .describe("Only vouchers in this status (unpaid = booked as open)."),
    ...dateRangeInput,
    text: z
      .string()
      .min(1)
      .max(200)
      .optional()
      .describe("Part of the description (voucher number or text)."),
    creditDebit: z.enum(["C", "D"]).optional().describe("D = expenses, C = income."),
    contactId: entityId.optional().describe("Only vouchers of this supplier or customer."),
    ...pageInput,
  }),
  outputSchema: z.object({ vouchers: z.array(voucherSummarySchema), page: pageSchema }),
  annotations: READ_ANNOTATIONS,
  async handler(args, { sevdesk }) {
    const problem = rangeProblem(args);
    if (problem) throw badInput(problem);
    const body = await sevdesk.call(
      sevdesk.api.GET("/Voucher", {
        params: {
          query: {
            ...(args.status && {
              status: codeFor(VOUCHER_STATUS, args.status) as VoucherStatusCode,
            }),
            ...(args.startDate && { startDate: unixSeconds(args.startDate) }),
            ...(args.endDate && { endDate: unixSeconds(args.endDate, true) }),
            ...(args.text && { descriptionLike: args.text }),
            ...(args.creditDebit && { creditDebit: args.creditDebit }),
            ...(args.contactId && {
              "contact[id]": args.contactId,
              "contact[objectName]": "Contact",
            }),
            ...pageQuery(args),
          },
        },
      }),
    );
    const vouchers = objectsOf(body).map(mapVoucherSummary);
    const page = pageOf(args.offset, args.limit, vouchers.length, totalOf(body));
    return present({ vouchers, page }, { summary: pageSummary(page, "vouchers") });
  },
});

const voucherPositionSchema = z.object({
  id: z.number().int(),
  accountDatevId: z.number().int().nullable().describe("Booking account (see get_tax_guidance)."),
  taxRate: z.number().nullable(),
  net: z.boolean().nullable().describe("Amounts were entered net."),
  isAsset: z.boolean().nullable(),
  sumNet: z.number().nullable(),
  sumTax: z.number().nullable(),
  sumGross: z.number().nullable(),
  comment: z.string().nullable(),
});

export const getVoucher = defineTool({
  name: "get_voucher",
  title: "Get a sevdesk voucher",
  description:
    "Returns one voucher by its sevdesk ID with its positions (booking account, tax rate, " +
    "amounts). Find the ID with search_vouchers.",
  class: "R",
  operationId: "getVoucherById",
  inputSchema: z.object({ voucherId: entityId.describe("sevdesk ID of the voucher.") }),
  outputSchema: z.object({
    voucher: voucherSummarySchema.extend({
      sumTax: z.number().nullable(),
      taxRuleId: z.number().int().nullable(),
      deliveryDate: z.string().nullable(),
      enshrined: z.boolean(),
      hasDocument: z.boolean().describe("A file (scan, PDF) is attached."),
    }),
    positions: z.array(voucherPositionSchema),
  }),
  annotations: READ_ANNOTATIONS,
  async handler({ voucherId }, { sevdesk }) {
    const body = await sevdesk.call(
      sevdesk.api.GET("/Voucher/{voucherId}", { params: { path: { voucherId } } }),
    );
    const raw = objectsOf(body)[0];
    if (raw === undefined) throw notFound("voucher", voucherId);
    const positionsBody = await sevdesk.call(
      sevdesk.api.GET("/VoucherPos", {
        params: { query: { "voucher[id]": voucherId, "voucher[objectName]": "Voucher" } },
      }),
    );
    const positions = objectsOf(positionsBody)
      .filter((pos) => refId(pos.voucher) === null || refId(pos.voucher) === voucherId)
      .map((pos) => ({
        id: integer(pos.id) ?? 0,
        accountDatevId: refId(pos.accountDatev),
        taxRate: amount(pos.taxRate),
        net: flag(pos.net),
        isAsset: flag(pos.isAsset),
        sumNet: amount(pos.sumNet),
        sumTax: amount(pos.sumTax),
        sumGross: amount(pos.sumGross),
        comment: text(pos.comment),
      }));
    const voucher = {
      ...mapVoucherSummary(raw),
      sumTax: amount(raw.sumTax),
      taxRuleId: refId(raw.taxRule),
      deliveryDate: isoDateOf(raw.deliveryDate),
      enshrined: enshrinedOf(raw.enshrined),
      hasDocument: refId(raw.document) !== null,
    };
    return present(
      { voucher, positions },
      {
        summary:
          `Voucher ${voucher.description ?? voucher.id} (${voucher.statusName ?? "unknown status"}), ` +
          `${positions.length} positions.`,
      },
    );
  },
});
