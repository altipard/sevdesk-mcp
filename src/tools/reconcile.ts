import { z } from "zod";
import { defineTool } from "../policy/registry.js";
import {
  AuditRun,
  type AuditTransaction,
  auditFields,
  checkPeriod,
  type DocumentRef,
  documentRefSchema,
  inPeriod,
  invoiceRef,
  normalized,
  type Period,
  periodInput,
  periodSchema,
  scanInvoices,
  scanTransactions,
  scanVouchers,
  transactionRef,
  voucherRef,
} from "./audit-common.js";
import {
  addDays,
  daysBetween,
  entityId,
  FOREIGN_DATA_NOTE,
  pageInput,
  pageOf,
  pageSchema,
  READ_ANNOTATIONS,
} from "./format.js";
import { present } from "./result.js";

export const DEFAULT_RECONCILE_WINDOW_DAYS = 14;

/** Amounts closer than this count as equal. */
const AMOUNT_TOLERANCE = 0.01;

export const CONFIDENCES = ["high", "medium", "low"] as const;
type Confidence = (typeof CONFIDENCES)[number];

const matchSchema = z.object({
  confidence: z.enum(CONFIDENCES),
  transaction: documentRefSchema,
  document: documentRefSchema,
  daysApart: z.number().int().describe("Days between document date and value date."),
  reasons: z.array(z.string()),
});
type Match = z.infer<typeof matchSchema>;

/** An open document as a match candidate; amount is what is still owed. */
export interface OpenDocument {
  ref: DocumentRef;
  /** +1: money comes in (invoices, credit vouchers); -1: money goes out (debit vouchers). */
  direction: 1 | -1;
  amount: number;
  date: string | null;
}

/** Transactions sevdesk has not linked or booked yet (status created, or unknown). */
const isOpen = (t: AuditTransaction) => t.status === null || t.status === 100;

/** Words of 4+ letters, for comparing payee and contact names. */
const words = (value: string | null) =>
  new Set(
    normalized(value)
      .split(/[^\p{L}\p{N}]+/u)
      .filter((w) => w.length >= 4),
  );

function judge(
  t: AuditTransaction,
  doc: OpenDocument,
  days: number,
): Omit<Match, "transaction" | "document"> {
  const reasons = ["amount matches"];
  const number = normalized(doc.ref.number);
  const refMatch = number.length >= 4 && normalized(t.purpose).includes(number);
  if (refMatch) reasons.push("document number in the payment reference");
  const payee = words(t.payeePayerName);
  const nameMatch = [...words(doc.ref.contactName)].some((w) => payee.has(w));
  if (nameMatch) reasons.push("payee name matches the contact");
  reasons.push(`${Math.abs(days)} days apart`);
  const confidence: Confidence =
    refMatch || (nameMatch && Math.abs(days) <= 7)
      ? "high"
      : nameMatch || Math.abs(days) <= 3
        ? "medium"
        : "low";
  return { confidence, daysApart: days, reasons };
}

/**
 * Pairs open transactions with open documents of the same amount and
 * direction within the window, best pairs first; each side is used once.
 */
export function reconcile(
  transactions: readonly AuditTransaction[],
  documents: readonly OpenDocument[],
  windowDays: number,
): {
  matches: Match[];
  unmatchedTransactions: AuditTransaction[];
  unmatchedDocuments: OpenDocument[];
} {
  const candidates: Array<{ t: AuditTransaction; doc: OpenDocument; match: Match }> = [];
  for (const t of transactions) {
    if (t.amount === null || t.amount === 0 || t.date === null) continue;
    const direction = t.amount > 0 ? 1 : -1;
    for (const doc of documents) {
      if (doc.direction !== direction) continue;
      // Same tolerance logic as the audit sum checks: float noise never decides.
      if (Math.abs(Math.abs(t.amount) - doc.amount) > AMOUNT_TOLERANCE + 1e-9) continue;
      const days = doc.date === null ? windowDays : daysBetween(doc.date, t.date);
      if (Math.abs(days) > windowDays) continue;
      const verdict = judge(t, doc, days);
      candidates.push({
        t,
        doc,
        match: { ...verdict, transaction: transactionRef(t), document: doc.ref },
      });
    }
  }
  candidates.sort(
    (a, b) =>
      CONFIDENCES.indexOf(a.match.confidence) - CONFIDENCES.indexOf(b.match.confidence) ||
      Math.abs(a.match.daysApart) - Math.abs(b.match.daysApart) ||
      a.t.id - b.t.id ||
      a.doc.ref.id - b.doc.ref.id,
  );
  const usedT = new Set<number>();
  const usedD = new Set<string>();
  const matches: Match[] = [];
  for (const c of candidates) {
    const docKey = `${c.doc.ref.type}:${c.doc.ref.id}`;
    if (usedT.has(c.t.id) || usedD.has(docKey)) continue;
    usedT.add(c.t.id);
    usedD.add(docKey);
    matches.push(c.match);
  }
  matches.sort(
    (a, b) =>
      (a.transaction.date ?? "").localeCompare(b.transaction.date ?? "") ||
      a.transaction.id - b.transaction.id,
  );
  return {
    matches,
    unmatchedTransactions: transactions.filter((t) => !usedT.has(t.id)),
    unmatchedDocuments: documents.filter((d) => !usedD.has(`${d.ref.type}:${d.ref.id}`)),
  };
}

const UNPAID_VOUCHER = new Set([100, 150, 750]);
const OPEN_INVOICE = new Set([200, 750]);
/** Reminders repeat the amount of their invoice; WKR are templates. */
const SKIPPED_INVOICE_TYPES = new Set(["MA", "WKR"]);

export const reconcileTransactions = defineTool({
  name: "reconcile_transactions",
  title: "Reconcile sevdesk bank transactions",
  description:
    "Compares the open (not yet booked) bank transactions of a period with open vouchers and " +
    "invoices by amount, direction and date (documents up to windowDays before or after, " +
    `default ${DEFAULT_RECONCILE_WINDOW_DAYS}). Returns likely matches with confidence ` +
    "(high: document number in the reference or payee name and close date; medium: name or " +
    "date within 3 days; low: amount and window only), payments without a document, and open " +
    "documents of the period without a payment. offset and limit apply to each of the three " +
    "lists; counts gives their full sizes. Documents in a foreign currency are not matched, " +
    "and credit notes are not read. " +
    "Nothing is booked; use the matches as hints." +
    FOREIGN_DATA_NOTE,
  class: "R",
  operationId: "getTransactions",
  operations: ["getVouchers", "getInvoices"],
  inputSchema: z.object({
    ...periodInput,
    checkAccountId: entityId.optional().describe("Only transactions of this account."),
    windowDays: z
      .number()
      .int()
      .min(0)
      .max(90)
      .default(DEFAULT_RECONCILE_WINDOW_DAYS)
      .describe("Largest distance in days between document date and value date."),
    ...pageInput,
  }),
  outputSchema: z.object({
    period: periodSchema,
    windowDays: z.number().int(),
    counts: z.object({
      openTransactions: z.number().int(),
      bookedTransactions: z.number().int(),
      openDocuments: z.number().int(),
      foreignCurrencySkipped: z.number().int(),
      matches: z.number().int(),
      paymentsWithoutDocument: z.number().int(),
      documentsWithoutPayment: z.number().int(),
    }),
    matches: z.array(matchSchema),
    paymentsWithoutDocument: z.array(documentRefSchema),
    documentsWithoutPayment: z.array(documentRefSchema),
    page: pageSchema,
    ...auditFields,
  }),
  annotations: READ_ANNOTATIONS,
  async handler(args, call) {
    const period = checkPeriod(args);
    const run = new AuditRun(call);
    const transactions = await scanTransactions(run, period, args.checkAccountId);
    // Documents are read windowDays before and after the period: an invoice
    // from late last month is often paid in this one, and a payment late in
    // the period may belong to a document dated a few days later.
    const docPeriod: Period = {
      startDate: addDays(period.startDate, -args.windowDays),
      endDate: addDays(period.endDate, args.windowDays),
    };
    const vouchers = await scanVouchers(run, docPeriod);
    const invoices = await scanInvoices(run, docPeriod);

    let foreign = 0;
    const documents: OpenDocument[] = [];
    for (const v of vouchers) {
      if (v.status === null || !UNPAID_VOUCHER.has(v.status)) continue;
      const owed = v.openAmount ?? v.sumGross;
      if (owed === null || owed === 0) continue;
      if (v.foreignCurrency !== null) {
        foreign++;
        continue;
      }
      // A negative open amount (credit) flows the other way.
      const sign = (v.creditDebit === "C" ? 1 : -1) * (owed < 0 ? -1 : 1);
      documents.push({
        ref: voucherRef(v),
        direction: sign as 1 | -1,
        amount: Math.abs(owed),
        date: v.date,
      });
    }
    for (const i of invoices) {
      if (i.status === null || !OPEN_INVOICE.has(i.status)) continue;
      if (i.invoiceType !== null && SKIPPED_INVOICE_TYPES.has(i.invoiceType)) continue;
      const owed = i.openAmount ?? i.sumGross;
      if (owed === null || owed === 0) continue;
      if (i.foreignCurrency !== null) {
        foreign++;
        continue;
      }
      documents.push({
        ref: invoiceRef(i),
        direction: owed < 0 ? -1 : 1,
        amount: Math.abs(owed),
        date: i.date,
      });
    }

    const open = transactions.filter(isOpen);
    const result = reconcile(open, documents, args.windowDays);
    const paymentsWithoutDocument = result.unmatchedTransactions.map(transactionRef);
    const documentsWithoutPayment = result.unmatchedDocuments
      .filter((d) => inPeriod(d.date, period))
      .map((d) => d.ref);
    const slice = <T>(list: T[]) => list.slice(args.offset, args.offset + args.limit);
    const longest = Math.max(
      result.matches.length,
      paymentsWithoutDocument.length,
      documentsWithoutPayment.length,
    );
    const shown = {
      matches: slice(result.matches),
      paymentsWithoutDocument: slice(paymentsWithoutDocument),
      documentsWithoutPayment: slice(documentsWithoutPayment),
    };
    const count = Math.max(
      shown.matches.length,
      shown.paymentsWithoutDocument.length,
      shown.documentsWithoutPayment.length,
    );
    const page = pageOf(args.offset, args.limit, count, longest);
    return present(
      {
        period,
        windowDays: args.windowDays,
        counts: {
          openTransactions: open.length,
          bookedTransactions: transactions.length - open.length,
          openDocuments: documents.length,
          foreignCurrencySkipped: foreign,
          matches: result.matches.length,
          paymentsWithoutDocument: paymentsWithoutDocument.length,
          documentsWithoutPayment: documentsWithoutPayment.length,
        },
        ...shown,
        page,
        truncated: run.truncated,
        ...run.noteField([
          foreign > 0 &&
            `${foreign} open documents in a foreign currency were not matched; check them by hand.`,
          transactions.length === 0 && "No bank transactions in the period.",
        ]),
      },
      {
        summary:
          `${open.length} open transactions: ${result.matches.length} likely matches, ` +
          `${paymentsWithoutDocument.length} without document; ${documentsWithoutPayment.length} ` +
          `open documents without payment.${run.truncated ? " Incomplete, see note." : ""}`,
      },
    );
  },
});
