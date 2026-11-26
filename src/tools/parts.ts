import { z } from "zod";
import { defineTool } from "../policy/registry.js";
import {
  amount,
  FOREIGN_DATA_NOTE,
  flag,
  integer,
  objectsOf,
  PART_STATUS,
  pageInput,
  pageOf,
  pageQuery,
  pageSchema,
  pageSummary,
  READ_ANNOTATIONS,
  refId,
  statusFields,
  statusOf,
  text,
  totalOf,
} from "./format.js";
import { present } from "./result.js";

const partSchema = z.object({
  id: z.number().int(),
  partNumber: z.string().nullable(),
  name: z.string().nullable(),
  text: z.string().nullable(),
  unityId: z.number().int().nullable(),
  priceNet: z.number().nullable().describe("Net sales price in the account's currency."),
  priceGross: z.number().nullable(),
  pricePurchase: z.number().nullable(),
  taxRate: z.number().nullable(),
  stock: z.number().nullable(),
  stockEnabled: z.boolean().nullable(),
  ...statusFields,
});

export const searchParts = defineTool({
  name: "search_parts",
  title: "Search sevdesk parts",
  description:
    "Lists parts (Artikel: products and services) with prices, tax rate and stock, filtered " +
    "by part number or name as sevdesk matches them. Use it to look up prices or the part " +
    "behind an invoice position (partId)." +
    FOREIGN_DATA_NOTE,
  class: "R",
  operationId: "getParts",
  inputSchema: z.object({
    partNumber: z.string().min(1).max(100).optional().describe("Part number."),
    name: z.string().min(1).max(200).optional().describe("Part name."),
    ...pageInput,
  }),
  outputSchema: z.object({ parts: z.array(partSchema), page: pageSchema }),
  annotations: READ_ANNOTATIONS,
  async handler(args, { sevdesk }) {
    const body = await sevdesk.call(
      sevdesk.api.GET("/Part", {
        params: {
          query: {
            ...(args.partNumber && { partNumber: args.partNumber }),
            ...(args.name && { name: args.name }),
            ...pageQuery(args),
          },
        },
      }),
    );
    const parts = objectsOf(body).map((raw) => ({
      id: integer(raw.id) ?? 0,
      partNumber: text(raw.partNumber),
      name: text(raw.name),
      text: text(raw.text),
      unityId: refId(raw.unity),
      priceNet: amount(raw.priceNet ?? raw.price),
      priceGross: amount(raw.priceGross),
      pricePurchase: amount(raw.pricePurchase),
      taxRate: amount(raw.taxRate),
      stock: amount(raw.stock),
      stockEnabled: flag(raw.stockEnabled),
      ...statusOf(raw.status, PART_STATUS),
    }));
    const page = pageOf(args.offset, args.limit, parts.length, totalOf(body));
    return present({ parts, page }, { summary: pageSummary(page, "parts") });
  },
});
