import { z } from "zod";
import { defineTool } from "../policy/registry.js";
import {
  amount,
  badInput,
  berlinDateTime,
  CHECK_ACCOUNT_STATUS,
  dateRangeInput,
  enshrinedOf,
  entityId,
  FOREIGN_DATA_NOTE,
  flag,
  integer,
  isoDateOf,
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
  statusOf,
  TRANSACTION_STATUS,
  text,
  totalOf,
} from "./format.js";
import { present } from "./result.js";

const bankAccountSchema = z.object({
  id: z.number().int(),
  name: z.string().nullable(),
  iban: z.string().nullable(),
  bic: z.string().nullable(),
  type: z.string().nullable().describe("online (bank sync), offline or register (cash)."),
  currency: z.string().nullable(),
  balance: z.number().nullable().describe("Current balance as sevdesk shows it."),
  ...statusFields,
  defaultAccount: z.boolean().nullable(),
  accountingNumber: z.string().nullable().describe("Ledger account, e.g. 1200 or 1800."),
  lastSync: z.string().nullable().describe("Last bank sync, YYYY-MM-DD."),
});

function mapBankAccount(raw: Raw): z.infer<typeof bankAccountSchema> {
  return {
    id: integer(raw.id) ?? 0,
    name: text(raw.name),
    iban: text(raw.iban),
    bic: text(raw.bic),
    type: text(raw.type),
    currency: text(raw.currency),
    balance: amount(raw.balance),
    ...statusOf(raw.status, CHECK_ACCOUNT_STATUS),
    defaultAccount: flag(raw.defaultAccount),
    accountingNumber: text(raw.accountingNumber),
    lastSync: isoDateOf(raw.lastSync),
  };
}

export const listBankAccounts = defineTool({
  name: "list_bank_accounts",
  title: "List sevdesk bank accounts",
  description:
    "Lists the payment accounts (bank accounts, cash registers, clearing accounts) with " +
    "balance, IBAN and status. Use the returned id as checkAccountId in search_transactions." +
    FOREIGN_DATA_NOTE,
  class: "R",
  operationId: "getCheckAccounts",
  inputSchema: z.object({ ...pageInput }),
  outputSchema: z.object({ accounts: z.array(bankAccountSchema), page: pageSchema }),
  annotations: READ_ANNOTATIONS,
  async handler(args, { sevdesk }) {
    const body = await sevdesk.call(
      sevdesk.api.GET("/CheckAccount", { params: { query: pageQuery(args) } }),
    );
    const accounts = objectsOf(body).map(mapBankAccount);
    const page = pageOf(args.offset, args.limit, accounts.length, totalOf(body));
    const balances = accounts
      .filter((a) => a.balance !== null)
      .map((a) => `account ${a.id}: ${a.balance} ${a.currency ?? ""}`.trim())
      .join("; ");
    return present(
      { accounts, page },
      { summary: `${pageSummary(page, "accounts")}${balances ? ` ${balances}.` : ""}` },
    );
  },
});

const transactionSchema = z.object({
  id: z.number().int(),
  valueDate: z.string().nullable().describe("YYYY-MM-DD"),
  entryDate: z.string().nullable(),
  amount: z.number().nullable().describe("Positive for incoming, negative for outgoing money."),
  currency: z.string().nullable().describe("Currency of the account."),
  purpose: z.string().nullable().describe("Payment reference (Verwendungszweck)."),
  payeePayerName: z.string().nullable(),
  payeePayerAccount: z.string().nullable().describe("IBAN or account number of the other side."),
  checkAccountId: z.number().int().nullable(),
  ...statusFields,
  enshrined: z.boolean(),
});

/** Accounts fetched once per call to show each transaction's currency. */
const ACCOUNT_LOOKUP_LIMIT = 100;

export const searchTransactions = defineTool({
  name: "search_transactions",
  title: "Search sevdesk bank transactions",
  description:
    "Lists bank transactions, filtered by account, value date range, payment reference, " +
    "payer/payee name, booked or open, and incoming or outgoing. Use it to check whether a " +
    "payment arrived; find account IDs with list_bank_accounts." +
    FOREIGN_DATA_NOTE,
  class: "R",
  operationId: "getTransactions",
  inputSchema: z.object({
    checkAccountId: entityId.optional().describe("Only transactions of this account."),
    ...dateRangeInput,
    purpose: z.string().min(1).max(200).optional().describe("Part of the payment reference."),
    payeePayerName: z.string().min(1).max(200).optional().describe("Name of the other side."),
    booked: z
      .boolean()
      .optional()
      .describe("true: only booked (linked to invoices/vouchers); false: only open ones."),
    direction: z
      .enum(["incoming", "outgoing"])
      .optional()
      .describe("incoming = credits, outgoing = debits."),
    ...pageInput,
  }),
  outputSchema: z.object({ transactions: z.array(transactionSchema), page: pageSchema }),
  annotations: READ_ANNOTATIONS,
  async handler(args, { sevdesk }) {
    const problem = rangeProblem(args);
    if (problem) throw badInput(problem);
    const body = await sevdesk.call(
      sevdesk.api.GET("/CheckAccountTransaction", {
        params: {
          query: {
            ...(args.checkAccountId && {
              "checkAccount[id]": args.checkAccountId,
              "checkAccount[objectName]": "CheckAccount",
            }),
            // The spec declares date-time here, unlike the Unix timestamps
            // of invoices, orders and vouchers.
            ...(args.startDate && { startDate: berlinDateTime(args.startDate) }),
            ...(args.endDate && { endDate: berlinDateTime(args.endDate, true) }),
            ...(args.purpose && { paymtPurpose: args.purpose }),
            ...(args.payeePayerName && { payeePayerName: args.payeePayerName }),
            ...(args.booked !== undefined && { isBooked: args.booked }),
            ...(args.direction === "incoming" && { onlyCredit: true }),
            ...(args.direction === "outgoing" && { onlyDebit: true }),
            ...pageQuery(args),
          },
        },
      }),
    );
    const rows = objectsOf(body);
    const currencies = new Map<number, string | null>();
    if (rows.length > 0) {
      const accounts = await sevdesk.call(
        sevdesk.api.GET("/CheckAccount", { params: { query: { limit: ACCOUNT_LOOKUP_LIMIT } } }),
      );
      for (const account of objectsOf(accounts)) {
        const id = integer(account.id);
        if (id !== null) currencies.set(id, text(account.currency));
      }
    }
    const transactions = rows.map((raw) => {
      const checkAccountId = refId(raw.checkAccount);
      return {
        id: integer(raw.id) ?? 0,
        valueDate: isoDateOf(raw.valueDate),
        entryDate: isoDateOf(raw.entryDate),
        amount: amount(raw.amount),
        currency: checkAccountId === null ? null : (currencies.get(checkAccountId) ?? null),
        purpose: text(raw.paymtPurpose),
        payeePayerName: text(raw.payeePayerName),
        payeePayerAccount: text(raw.payeePayerAcctNo),
        checkAccountId,
        ...statusOf(raw.status, TRANSACTION_STATUS),
        enshrined: enshrinedOf(raw.enshrined),
      };
    });
    const page = pageOf(args.offset, args.limit, transactions.length, totalOf(body));
    return present({ transactions, page }, { summary: pageSummary(page, "transactions") });
  },
});
