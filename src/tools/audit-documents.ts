import { z } from "zod";
import { defineTool } from "../policy/registry.js";
import {
  AuditRun,
  type AuditVoucher,
  auditFields,
  checkPeriod,
  documentRefSchema,
  invoiceRef,
  isEuro,
  normalized,
  type Period,
  periodInput,
  periodSchema,
  SEVERITIES,
  scanInvoices,
  scanVouchers,
  severityRank,
  supplierKey,
  voucherRef,
} from "./audit-common.js";
import {
  badInput,
  cents,
  daysBetween,
  FOREIGN_DATA_NOTE,
  INVOICE_STATUS,
  pageInput,
  pageOf,
  pageSchema,
  READ_ANNOTATIONS,
  todayIso,
  VOUCHER_STATUS,
} from "./format.js";
import { present } from "./result.js";

// ---------------------------------------------------------------------------
// find_duplicate_vouchers

export const DUPLICATE_CODES = ["SAME_NUMBER", "SAME_AMOUNT_NEAR_DATE", "OLD_DRAFT"] as const;

const duplicateSchema = z.object({
  severity: z.enum(SEVERITIES),
  code: z.enum(DUPLICATE_CODES),
  documents: z.array(documentRefSchema),
  detail: z.string(),
});
type Duplicate = z.infer<typeof duplicateSchema>;

export const DEFAULT_DUPLICATE_WINDOW_DAYS = 7;
export const DEFAULT_DRAFT_AGE_DAYS = 30;

const byDate = (a: AuditVoucher, b: AuditVoucher) =>
  (a.date ?? "").localeCompare(b.date ?? "") || a.id - b.id;

export function findDuplicates(
  vouchers: readonly AuditVoucher[],
  options: { windowDays: number; draftAgeDays: number; today: string },
): Duplicate[] {
  const findings: Duplicate[] = [];
  const groupBy = (key: (v: AuditVoucher) => string | null) => {
    const groups = new Map<string, AuditVoucher[]>();
    for (const v of vouchers) {
      const k = key(v);
      if (k !== null) groups.set(k, [...(groups.get(k) ?? []), v]);
    }
    return [...groups.values()];
  };

  // Same voucher number (description) for the same supplier and side.
  const numbered = new Set<string>();
  for (const group of groupBy((v) => {
    const supplier = supplierKey(v);
    const number = normalized(v.description);
    return supplier === null || number === ""
      ? null
      : `${supplier}\u0000${v.creditDebit}\u0000${number}`;
  })) {
    if (group.length < 2) continue;
    const sorted = [...group].sort(byDate);
    for (let i = 1; i < sorted.length; i++) {
      numbered.add(`${(sorted[0] as AuditVoucher).id}-${(sorted[i] as AuditVoucher).id}`);
    }
    findings.push({
      severity: "high",
      code: "SAME_NUMBER",
      documents: sorted.map(voucherRef),
      detail:
        `${group.length} vouchers of the same supplier with the number "${sorted[0]?.description}"; ` +
        "possibly booked twice.",
    });
  }

  // Same supplier and amount within the window.
  for (const group of groupBy((v) => {
    const supplier = supplierKey(v);
    if (supplier === null || v.sumGross === null || v.sumGross === 0 || v.date === null) {
      return null;
    }
    return `${supplier}\u0000${v.creditDebit}\u0000${cents(v.sumGross)}\u0000${v.currency ?? ""}`;
  })) {
    if (group.length < 2) continue;
    const sorted = [...group].sort(byDate);
    let cluster: AuditVoucher[] = [];
    const flush = () => {
      if (cluster.length >= 2) {
        const first = cluster[0] as AuditVoucher;
        const covered = cluster.slice(1).every((v) => numbered.has(`${first.id}-${v.id}`));
        if (!covered) {
          findings.push({
            severity: "medium",
            code: "SAME_AMOUNT_NEAR_DATE",
            documents: cluster.map(voucherRef),
            detail:
              `${cluster.length} vouchers of the same supplier over ${first.sumGross} ` +
              `${first.currency ?? ""} within ${options.windowDays} days; check whether one is a ` +
              "duplicate.",
          });
        }
      }
    };
    for (const v of sorted) {
      const last = cluster[cluster.length - 1];
      if (
        last !== undefined &&
        daysBetween(last.date as string, v.date as string) > options.windowDays
      ) {
        flush();
        cluster = [];
      }
      cluster.push(v);
    }
    flush();
  }

  for (const v of vouchers) {
    if (v.status !== 50 || v.date === null) continue;
    const age = daysBetween(v.date, options.today);
    if (age <= options.draftAgeDays) continue;
    findings.push({
      severity: "low",
      code: "OLD_DRAFT",
      documents: [voucherRef(v)],
      detail: `Draft for ${age} days; book it, or delete it if it is obsolete.`,
    });
  }

  return findings.sort(
    (a, b) =>
      severityRank(a.severity) - severityRank(b.severity) ||
      (a.documents[0]?.date ?? "").localeCompare(b.documents[0]?.date ?? "") ||
      (a.documents[0]?.id ?? 0) - (b.documents[0]?.id ?? 0),
  );
}

export const findDuplicateVouchers = defineTool({
  name: "find_duplicate_vouchers",
  title: "Find duplicate sevdesk vouchers",
  description:
    "Looks for vouchers of a period that may be booked twice: the same voucher number " +
    "(description) for the same supplier (high), the same supplier and gross amount within " +
    `windowDays (medium, default ${DEFAULT_DUPLICATE_WINDOW_DAYS}), and drafts older than ` +
    `draftAgeDays (low, default ${DEFAULT_DRAFT_AGE_DAYS}). Debit and credit vouchers are ` +
    "compared separately. Hints to check, nothing is changed." +
    FOREIGN_DATA_NOTE,
  class: "R",
  operationId: "getVouchers",
  inputSchema: z.object({
    ...periodInput,
    windowDays: z
      .number()
      .int()
      .min(0)
      .max(90)
      .default(DEFAULT_DUPLICATE_WINDOW_DAYS)
      .describe("Days between two vouchers with the same amount that still count as suspicious."),
    draftAgeDays: z
      .number()
      .int()
      .min(1)
      .max(3650)
      .default(DEFAULT_DRAFT_AGE_DAYS)
      .describe("Drafts older than this many days are listed."),
    ...pageInput,
  }),
  outputSchema: z.object({
    period: periodSchema,
    checkedVouchers: z.number().int(),
    findings: z.array(duplicateSchema),
    page: pageSchema,
    ...auditFields,
  }),
  annotations: READ_ANNOTATIONS,
  async handler(args, call) {
    const period = checkPeriod(args);
    const run = new AuditRun(call);
    const vouchers = await scanVouchers(run, period);
    const all = findDuplicates(vouchers, {
      windowDays: args.windowDays,
      draftAgeDays: args.draftAgeDays,
      today: todayIso(),
    });
    const findings = all.slice(args.offset, args.offset + args.limit);
    const page = pageOf(args.offset, args.limit, findings.length, all.length);
    return present(
      {
        period,
        checkedVouchers: vouchers.length,
        findings,
        page,
        truncated: run.truncated,
        ...run.noteField([vouchers.length === 0 && "No vouchers in the period."]),
      },
      {
        summary:
          `${all.length} possible duplicates or old drafts in ${vouchers.length} vouchers.` +
          `${run.truncated ? " Incomplete, see note." : ""}`,
      },
    );
  },
});

// ---------------------------------------------------------------------------
// find_subscription_gaps

export const DEFAULT_HISTORY_MONTHS = 6;
export const DEFAULT_MIN_MONTHS = 3;

const monthIndex = (month: string) => {
  const [y, m] = month.split("-").map(Number) as [number, number];
  return y * 12 + (m - 1);
};
const monthOf = (index: number) =>
  `${Math.floor(index / 12)}-${String((index % 12) + 1).padStart(2, "0")}`;

/** First day of the month `months` before the month of `date`. */
export function monthsBefore(date: string, months: number): string {
  return `${monthOf(monthIndex(date.slice(0, 7)) - months)}-01`;
}

const gapSchema = z.object({
  supplierId: z.number().int().nullable(),
  supplierName: z.string().nullable(),
  monthsSeen: z.number().int().describe("Distinct months with a voucher, history included."),
  firstSeen: z.string().describe("YYYY-MM"),
  lastSeen: z.string().describe("YYYY-MM"),
  typicalAmount: z.number().nullable().describe("Median gross amount."),
  currency: z.string().nullable(),
  missingMonths: z.array(z.string()).describe("Months of the period without a voucher, YYYY-MM."),
  possiblyEnded: z
    .boolean()
    .describe("The last months of the period are all missing; the subscription may have ended."),
});
type Gap = z.infer<typeof gapSchema>;

const median = (values: number[]): number | null => {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1
    ? (sorted[mid] as number)
    : cents(((sorted[mid - 1] as number) + (sorted[mid] as number)) / 2);
};

/**
 * Suppliers with a monthly cadence (vouchers in at least minMonths distinct
 * months, at least half of the steps between them one month) and the months of the
 * period without a voucher. The current month and later are never missing:
 * the voucher may simply not be booked yet.
 */
export function findGaps(
  vouchers: readonly AuditVoucher[],
  period: Period,
  options: { minMonths: number; today: string },
): { gaps: Gap[]; detected: number } {
  const groups = new Map<string, AuditVoucher[]>();
  for (const v of vouchers) {
    const key = supplierKey(v);
    if (key === null || v.date === null || v.creditDebit !== "D") continue;
    groups.set(key, [...(groups.get(key) ?? []), v]);
  }
  const current = monthIndex(options.today.slice(0, 7));
  const periodStart = monthIndex(period.startDate.slice(0, 7));
  const periodEnd = Math.min(monthIndex(period.endDate.slice(0, 7)), current - 1);
  const gaps: Gap[] = [];
  let detected = 0;
  for (const group of groups.values()) {
    const months = [...new Set(group.map((v) => monthIndex((v.date as string).slice(0, 7))))].sort(
      (a, b) => a - b,
    );
    if (months.length < options.minMonths) continue;
    const steps = months.slice(1).map((m, i) => m - (months[i] as number));
    // Monthly when at least half the steps are one month; missing months show as longer steps.
    if (steps.filter((step) => step === 1).length * 2 < steps.length) continue;
    detected++;
    const first = months[0] as number;
    const seen = new Set(months);
    const missing: number[] = [];
    for (let m = Math.max(periodStart, first); m <= periodEnd; m++) {
      if (!seen.has(m)) missing.push(m);
    }
    if (missing.length === 0) continue;
    let trailing = 0;
    for (let m = periodEnd; m >= periodStart && !seen.has(m); m--) trailing++;
    const latest = [...group].sort(byDate)[group.length - 1] as AuditVoucher;
    const currencies = new Set(group.map((v) => v.currency ?? "EUR"));
    gaps.push({
      supplierId: latest.supplierId,
      supplierName: latest.supplierName,
      monthsSeen: months.length,
      firstSeen: monthOf(first),
      lastSeen: monthOf(months[months.length - 1] as number),
      typicalAmount: median(group.map((v) => v.sumGross).filter((a): a is number => a !== null)),
      currency: currencies.size === 1 ? ([...currencies][0] ?? null) : null,
      missingMonths: missing.map(monthOf),
      possiblyEnded: trailing >= 2,
    });
  }
  gaps.sort(
    (a, b) =>
      b.missingMonths.length - a.missingMonths.length ||
      (a.supplierName ?? "").localeCompare(b.supplierName ?? ""),
  );
  return { gaps, detected };
}

export const findSubscriptionGaps = defineTool({
  name: "find_subscription_gaps",
  title: "Find gaps in sevdesk subscriptions",
  description:
    "Detects suppliers billed monthly (expense vouchers in at least minMonths distinct months, " +
    `default ${DEFAULT_MIN_MONTHS}, looking back historyMonths before the period, default ` +
    `${DEFAULT_HISTORY_MONTHS}) and lists the months of the period without a voucher, e.g. a ` +
    "missing receipt for a software subscription. The current month is never reported as " +
    "missing. possiblyEnded marks subscriptions whose last months are all missing." +
    FOREIGN_DATA_NOTE,
  class: "R",
  operationId: "getVouchers",
  inputSchema: z.object({
    ...periodInput,
    historyMonths: z
      .number()
      .int()
      .min(0)
      .max(24)
      .default(DEFAULT_HISTORY_MONTHS)
      .describe("Months before the period read to detect the cadence."),
    minMonths: z
      .number()
      .int()
      .min(2)
      .max(24)
      .default(DEFAULT_MIN_MONTHS)
      .describe("Distinct months with a voucher needed to call a supplier monthly."),
    ...pageInput,
  }),
  outputSchema: z.object({
    period: periodSchema,
    readFrom: z.string().describe("First day read, history included."),
    checkedVouchers: z.number().int(),
    subscriptionsDetected: z.number().int(),
    gaps: z.array(gapSchema),
    page: pageSchema,
    ...auditFields,
  }),
  annotations: READ_ANNOTATIONS,
  async handler(args, call) {
    const period = checkPeriod(args);
    const readFrom = monthsBefore(period.startDate, args.historyMonths);
    const run = new AuditRun(call);
    const vouchers = await scanVouchers(run, { startDate: readFrom, endDate: period.endDate }, "D");
    const { gaps: all, detected } = findGaps(vouchers, period, {
      minMonths: args.minMonths,
      today: todayIso(),
    });
    const gaps = all.slice(args.offset, args.offset + args.limit);
    const page = pageOf(args.offset, args.limit, gaps.length, all.length);
    return present(
      {
        period,
        readFrom,
        checkedVouchers: vouchers.length,
        subscriptionsDetected: detected,
        gaps,
        page,
        truncated: run.truncated,
        ...run.noteField([vouchers.length === 0 && "No expense vouchers in the period."]),
      },
      {
        summary:
          `${detected} monthly suppliers, ${all.length} with missing months.` +
          `${run.truncated ? " Incomplete, see note." : ""}`,
      },
    );
  },
});

// ---------------------------------------------------------------------------
// summarize_documents

const GROUPINGS = ["month", "status", "contact"] as const;
type Grouping = (typeof GROUPINGS)[number];

/** Invoice types summed: reminders (MA) repeat amounts, WKR are recurring templates. */
export const SUMMARY_INVOICE_TYPES = ["RE", "TR", "AR", "ER", "SR"] as const;

const groupSchema = z.object({
  group: z.string().describe("YYYY-MM, status name, or contact ID (name if there is none)."),
  label: z.string().nullable().describe("Contact name for groupBy contact."),
  currency: z.string(),
  count: z.number().int(),
  net: z.number(),
  tax: z.number(),
  gross: z.number(),
});
type Group = z.infer<typeof groupSchema>;

const totalSchema = groupSchema.omit({ group: true, label: true });

interface Summable {
  date: string | null;
  statusName: string;
  contactKey: string;
  contactName: string | null;
  currency: string | null;
  net: number | null;
  tax: number | null;
  gross: number | null;
}

export function summarize(
  docs: readonly Summable[],
  groupBy: Grouping,
): { groups: Group[]; totals: z.infer<typeof totalSchema>[] } {
  const groups = new Map<string, Group>();
  const totals = new Map<string, z.infer<typeof totalSchema>>();
  for (const d of docs) {
    const currency = isEuro(d.currency) ? "EUR" : (d.currency as string);
    const group =
      groupBy === "month"
        ? (d.date?.slice(0, 7) ?? "unknown")
        : groupBy === "status"
          ? d.statusName
          : d.contactKey;
    const net = d.net ?? 0;
    const gross = d.gross ?? 0;
    const tax = d.tax ?? (d.net !== null && d.gross !== null ? d.gross - d.net : 0);
    const key = `${group}\u0000${currency}`;
    const entry = groups.get(key) ?? {
      group,
      label: groupBy === "contact" ? d.contactName : null,
      currency,
      count: 0,
      net: 0,
      tax: 0,
      gross: 0,
    };
    const total = totals.get(currency) ?? { currency, count: 0, net: 0, tax: 0, gross: 0 };
    for (const target of [entry, total]) {
      target.count++;
      target.net = cents(target.net + net);
      target.tax = cents(target.tax + tax);
      target.gross = cents(target.gross + gross);
    }
    if (entry.label === null && groupBy === "contact") entry.label = d.contactName;
    groups.set(key, entry);
    totals.set(currency, total);
  }
  const list = [...groups.values()].sort((a, b) =>
    groupBy === "contact"
      ? b.gross - a.gross || a.group.localeCompare(b.group)
      : a.group.localeCompare(b.group) || a.currency.localeCompare(b.currency),
  );
  return { groups: list, totals: [...totals.values()] };
}

const contactKeyOf = (id: number | null, name: string | null) =>
  id !== null ? String(id) : (name ?? "none");

export const summarizeDocuments = defineTool({
  name: "summarize_documents",
  title: "Summarize sevdesk invoices or vouchers",
  description:
    "Adds up invoices or vouchers of a period on the server and returns count, net, tax and " +
    "gross per month, status or contact and in total, per currency. Use it for questions like " +
    "revenue in Q2 or costs per supplier instead of listing every document. Invoices: reminders " +
    "(MA) and recurring templates (WKR) are left out, cancellations (SR) count with their own " +
    "sign; drafts are left out unless includeDrafts." +
    FOREIGN_DATA_NOTE,
  class: "R",
  operationId: (args: { documentType: "invoices" | "vouchers" }) =>
    args.documentType === "invoices" ? "getInvoices" : "getVouchers",
  operations: ["getInvoices", "getVouchers"],
  inputSchema: z.object({
    documentType: z.enum(["invoices", "vouchers"]),
    ...periodInput,
    groupBy: z.enum(GROUPINGS).default("month"),
    creditDebit: z.enum(["C", "D"]).optional().describe("Vouchers only: D = expenses, C = income."),
    includeDrafts: z.boolean().default(false),
    ...pageInput,
  }),
  outputSchema: z.object({
    period: periodSchema,
    documentType: z.enum(["invoices", "vouchers"]),
    groupBy: z.enum(GROUPINGS),
    documents: z.number().int().describe("Documents summed."),
    groups: z.array(groupSchema),
    totals: z.array(totalSchema).describe("Per currency, over all groups."),
    page: pageSchema,
    ...auditFields,
  }),
  annotations: READ_ANNOTATIONS,
  async handler(args, call) {
    const period = checkPeriod(args);
    if (args.documentType === "invoices" && args.creditDebit !== undefined) {
      throw badInput("creditDebit applies to vouchers only.");
    }
    const run = new AuditRun(call);
    let docs: Summable[];
    if (args.documentType === "invoices") {
      const types = new Set<string>(SUMMARY_INVOICE_TYPES);
      docs = (await scanInvoices(run, period))
        .filter((i) => i.status !== 50 && (args.includeDrafts || i.status !== 100))
        .filter((i) => i.invoiceType === null || types.has(i.invoiceType))
        .map((i) => ({
          date: i.date,
          statusName: i.status === null ? "unknown" : (INVOICE_STATUS[i.status] ?? "unknown"),
          contactKey: contactKeyOf(i.contactId, i.contactName),
          contactName: invoiceRef(i).contactName,
          currency: i.currency,
          net: i.sumNet,
          tax: i.sumTax,
          gross: i.sumGross,
        }));
    } else {
      docs = (await scanVouchers(run, period, args.creditDebit))
        .filter((v) => args.includeDrafts || v.status !== 50)
        .map((v) => ({
          date: v.date,
          statusName: v.status === null ? "unknown" : (VOUCHER_STATUS[v.status] ?? "unknown"),
          contactKey: contactKeyOf(v.supplierId, v.supplierName),
          contactName: v.supplierName,
          currency: v.currency,
          net: v.sumNet,
          tax: v.sumTax,
          gross: v.sumGross,
        }));
    }
    const { groups: all, totals } = summarize(docs, args.groupBy);
    const groups = all.slice(args.offset, args.offset + args.limit);
    const page = pageOf(args.offset, args.limit, groups.length, all.length);
    // Only ISO currency codes go into the summary line, never free text.
    const sums = totals
      .map((t) => `${t.gross} ${/^[A-Z]{3}$/.test(t.currency) ? t.currency : ""}`.trim())
      .join(", ");
    return present(
      {
        period,
        documentType: args.documentType,
        groupBy: args.groupBy,
        documents: docs.length,
        groups,
        totals,
        page,
        truncated: run.truncated,
        ...run.noteField([
          totals.length > 1 && "Documents in several currencies; sums are per currency.",
        ]),
      },
      {
        summary:
          `${docs.length} ${args.documentType} ${period.startDate} to ${period.endDate}` +
          `${sums ? `, gross ${sums}` : ""}.${run.truncated ? " Incomplete, see note." : ""}`,
      },
    );
  },
});
