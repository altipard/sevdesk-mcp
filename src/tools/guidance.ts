import { z } from "zod";
import { defineTool } from "../policy/registry.js";
import {
  asRecord,
  badInput,
  integer,
  objectsOf,
  pageInput,
  pageOf,
  pageSchema,
  pageSummary,
  READ_ANNOTATIONS,
  text,
} from "./format.js";
import { present } from "./result.js";

const taxRuleSchema = z.object({
  id: z.number().int().nullable().describe("Tax rule ID (taxRule in vouchers and invoices)."),
  name: z.string().nullable(),
  description: z.string().nullable(),
  taxRates: z.array(z.string()).describe("Allowed rates, e.g. ZERO, SEVEN, NINETEEN."),
});

const guideSchema = z.object({
  accountDatevId: z.number().int().nullable().describe("Account ID used in voucher positions."),
  accountNumber: z.string().nullable(),
  accountName: z.string().nullable(),
  description: z.string().nullable(),
  allowedTaxRules: z.array(taxRuleSchema),
  allowedReceiptTypes: z.array(z.string()),
});

const strings = (value: unknown): string[] =>
  Array.isArray(value) ? value.map(text).filter((v): v is string => v !== null) : [];

const SCOPES = ["all", "revenue", "expense", "account", "tax_rule"] as const;

export const getTaxGuidance = defineTool({
  name: "get_tax_guidance",
  title: "Get sevdesk tax guidance",
  description:
    "Lists which booking accounts, tax rules and tax rates sevdesk allows together " +
    "(ReceiptGuidance, bookkeeping 2.0). scope revenue or expense narrows to income or cost " +
    "accounts, account to one account number, tax_rule to the accounts allowed for one tax " +
    "rule. Use it before suggesting an account or tax rule for a voucher or invoice.",
  class: "R",
  operationId: "forAllAccounts",
  inputSchema: z.object({
    scope: z.enum(SCOPES).default("all"),
    accountNumber: z
      .number()
      .int()
      .min(0)
      .max(99_999_999)
      .optional()
      .describe("Account number, required for scope account."),
    taxRule: z
      .number()
      .int()
      .min(1)
      .max(999)
      .optional()
      .describe("Tax rule ID, required for scope tax_rule."),
    ...pageInput,
  }),
  outputSchema: z.object({ accounts: z.array(guideSchema), page: pageSchema }),
  annotations: READ_ANNOTATIONS,
  async handler(args, { sevdesk }) {
    if (args.scope === "account" && args.accountNumber === undefined) {
      throw badInput("scope account needs accountNumber.");
    }
    if (args.scope === "tax_rule" && args.taxRule === undefined) {
      throw badInput("scope tax_rule needs taxRule.");
    }
    const { api } = sevdesk;
    const request =
      args.scope === "revenue"
        ? api.GET("/ReceiptGuidance/forRevenue")
        : args.scope === "expense"
          ? api.GET("/ReceiptGuidance/forExpense")
          : args.scope === "account"
            ? api.GET("/ReceiptGuidance/forAccountNumber", {
                params: { query: { accountNumber: args.accountNumber as number } },
              })
            : args.scope === "tax_rule"
              ? api.GET("/ReceiptGuidance/forTaxRule", {
                  params: { query: { taxRule: String(args.taxRule) } },
                })
              : api.GET("/ReceiptGuidance/forAllAccounts");
    const body = await sevdesk.call(request as Promise<{ data: unknown; response: Response }>);
    // sevdesk sends the whole list; paging happens here to keep answers small.
    const all = objectsOf(body).map((raw) => ({
      accountDatevId: integer(raw.accountDatevId),
      accountNumber: text(raw.accountNumber),
      accountName: text(raw.accountName),
      description: text(raw.description),
      allowedTaxRules: (Array.isArray(raw.allowedTaxRules) ? raw.allowedTaxRules : []).map(
        (entry) => {
          const rule = asRecord(entry);
          return {
            id: integer(rule.id),
            name: text(rule.name),
            description: text(rule.description),
            taxRates: strings(rule.taxRates),
          };
        },
      ),
      allowedReceiptTypes: strings(raw.allowedReceiptTypes),
    }));
    const accounts = all.slice(args.offset, args.offset + args.limit);
    const page = pageOf(args.offset, args.limit, accounts.length, all.length);
    return present({ accounts, page }, { summary: pageSummary(page, "accounts") });
  },
});
