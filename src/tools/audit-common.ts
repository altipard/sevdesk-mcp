import { z } from "zod";
import type { ToolCall } from "../policy/registry.js";
import { SevdeskError } from "../sevdesk/errors.js";
import {
  amount,
  badInput,
  berlinDateTime,
  integer,
  isoDate,
  isoDateOf,
  objectsOf,
  type Raw,
  rangeProblem,
  refId,
  text,
  unixSeconds,
} from "./format.js";
import { mapInvoiceSummary } from "./invoices.js";
import { mapVoucherSummary } from "./vouchers.js";

/**
 * Shared plumbing of the audit tools (audit_vat, reverse_charge_report,
 * find_duplicate_vouchers, find_subscription_gaps, reconcile_transactions,
 * summarize_documents): they read every document of a period, so each call
 * is bounded by caps and a deadline, and says when it stopped early.
 */

/** Documents read per list (vouchers, invoices, transactions) and call. */
export const MAX_AUDIT_DOCUMENTS = 2000;
/** Vouchers whose positions are read per audit_vat call (one request each). */
export const MAX_AUDIT_POSITIONS = 500;
/** Supplier contacts looked up per audit_vat call (one request each). */
export const MAX_AUDIT_CONTACTS = 200;
/** Requests in flight at once; the client's rate limiter does the rest. */
export const AUDIT_CONCURRENCY = 2;
/**
 * Time for all requests of one audit call, like RECEIVABLES_DEADLINE_MS:
 * below the 60 s request timeout of MCP clients, so a partial answer still
 * arrives.
 */
export const AUDIT_DEADLINE_MS = 45_000;

const SCAN_PAGE = 100;

export const periodInput = {
  startDate: isoDate.describe("First day of the period, inclusive (YYYY-MM-DD)."),
  endDate: isoDate.describe("Last day of the period, inclusive (YYYY-MM-DD)."),
};

export interface Period {
  readonly startDate: string;
  readonly endDate: string;
}

export const periodSchema = z.object({ startDate: z.string(), endDate: z.string() });

/** Rejects a reversed period before anything is sent. */
export function checkPeriod(period: Period): Period {
  const problem = rangeProblem(period);
  if (problem) throw badInput(problem);
  return { startDate: period.startDate, endDate: period.endDate };
}

export const inPeriod = (date: string | null, period: Period): boolean =>
  date === null || (date >= period.startDate && date <= period.endDate);

/** Output fields every audit tool shares. */
export const auditFields = {
  truncated: z
    .boolean()
    .describe("A cap, the deadline or a failed request stopped reading early; see note."),
  note: z.string().optional(),
};

/**
 * One audit call: shared deadline and the limits it ran into. A limit is
 * recorded once, with a note naming it; any recorded limit marks the
 * answer truncated.
 */
export class AuditRun {
  readonly deadline: number;
  private readonly limits = new Map<string, string>();

  constructor(
    readonly call: ToolCall,
    now: number = Date.now(),
  ) {
    this.deadline = now + AUDIT_DEADLINE_MS;
  }

  hit(limit: string, note: string): void {
    if (!this.limits.has(limit)) this.limits.set(limit, note);
  }

  get truncated(): boolean {
    return this.limits.size > 0;
  }

  get notes(): string[] {
    return [...this.limits.values()];
  }

  /**
   * One request under the deadline. A local policy refusal always throws;
   * other sevdesk failures throw when `mustSucceed` (nothing useful without
   * the answer) and are otherwise recorded, returning undefined. The note
   * names the error kind and status, never upstream text.
   */
  async request(
    what: string,
    send: (signal: AbortSignal) => Promise<unknown>,
    mustSucceed = false,
  ): Promise<{ body: unknown } | undefined> {
    const remaining = this.deadline - Date.now();
    if (remaining <= 0) {
      this.hitDeadline();
      return undefined;
    }
    const signal = AbortSignal.timeout(remaining);
    try {
      return { body: await send(signal) };
    } catch (error) {
      if (error instanceof SevdeskError && error.kind === "policy") throw error;
      if (mustSucceed) throw error;
      if (signal.aborted) {
        this.hitDeadline();
        return undefined;
      }
      if (error instanceof SevdeskError) {
        const status = error.status === undefined ? "" : ` ${error.status}`;
        this.hit(
          `failed:${what}`,
          `Reading ${what} failed (${error.kind}${status}); results without them are incomplete.`,
        );
        return undefined;
      }
      throw error;
    }
  }

  private hitDeadline(): void {
    this.hit(
      "deadline",
      `Stopped after ${AUDIT_DEADLINE_MS / 1000} s; not everything was read. Narrow the period.`,
    );
  }

  /** Set once the first scan of the call started; only that scan's first page must succeed. */
  private scanned = false;

  /**
   * Every object of a paged list, up to `cap`. The first page of the call's
   * first scan must succeed; any later failure or the deadline keeps what
   * was read and is recorded. The cap is recorded only when sevdesk has
   * more after it (one probe request of a single object).
   */
  async scan(
    what: string,
    send: (page: { limit: number; offset: number }, signal: AbortSignal) => Promise<unknown>,
    cap: number = MAX_AUDIT_DOCUMENTS,
  ): Promise<Raw[]> {
    const first = !this.scanned;
    this.scanned = true;
    const items: Raw[] = [];
    for (let offset = 0; ; offset += SCAN_PAGE) {
      if (items.length >= cap) {
        const probe = await this.request(what, (signal) => send({ limit: 1, offset: cap }, signal));
        if (probe !== undefined && objectsOf(probe.body).length > 0) {
          this.hit(
            `cap:${what}`,
            `Only the first ${cap} ${what} of the period were read (cap); narrow the period.`,
          );
        }
        break;
      }
      const limit = Math.min(SCAN_PAGE, cap - items.length);
      const answer = await this.request(
        what,
        (signal) => send({ limit, offset }, signal),
        first && offset === 0,
      );
      if (answer === undefined) break;
      const page = objectsOf(answer.body);
      items.push(...page);
      if (page.length < limit) break;
    }
    return items.slice(0, cap);
  }

  /** True when a cap stopped reading `what` (see scan). */
  capped(what: string): boolean {
    return this.limits.has(`cap:${what}`);
  }

  /** The notes joined, or nothing, for the optional `note` field. */
  noteField(extra: readonly (string | false | undefined)[] = []): { note?: string } {
    const notes = [...this.notes, ...extra.filter((n): n is string => typeof n === "string")];
    return notes.length > 0 ? { note: notes.join(" ") } : {};
  }
}

/** Runs `fn` over `items` with at most `limit` calls in flight, keeping order. */
export async function mapLimited<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const index = next++;
      results[index] = await fn(items[index] as T);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

// ---------------------------------------------------------------------------
// Documents

export const documentRefSchema = z.object({
  type: z.enum(["voucher", "invoice", "credit_note", "transaction"]),
  id: z.number().int(),
  date: z.string().nullable().describe("Voucher, invoice, credit note or value date, YYYY-MM-DD."),
  number: z
    .string()
    .nullable()
    .describe("Invoice or credit note number, voucher description, or payment reference."),
  contactId: z.number().int().nullable(),
  contactName: z.string().nullable(),
  amount: z
    .number()
    .nullable()
    .describe(
      "Gross amount in euro (the account currency) as sevdesk reports it; transactions: signed " +
        "amount of the bank account.",
    ),
  foreignCurrency: z
    .string()
    .nullable()
    .describe("Document currency when it is not EUR (ISO code, or unknown), else null."),
  foreignAmount: z
    .number()
    .nullable()
    .describe("Gross amount in that currency where sevdesk reports it (invoices, credit notes)."),
});
export type DocumentRef = z.infer<typeof documentRefSchema>;

/**
 * Currency of a document when it is not the euro: the ISO code, or
 * "unknown" for anything that is not one (never free text). sevdesk's sum
 * fields are in the account currency: invoices and credit notes carry the
 * document currency in separate *ForeignCurrency fields, and vouchers
 * have sumDiscountsForeignCurrency next to sumDiscounts.
 */
export function foreignCurrencyOf(currency: string | null): string | null {
  if (currency === null) return null;
  const code = currency.trim().toUpperCase();
  if (code === "" || code === "EUR") return null;
  return /^[A-Z]{3}$/.test(code) ? code : "unknown";
}

export interface AuditVoucher {
  readonly id: number;
  readonly date: string | null;
  readonly description: string | null;
  readonly supplierId: number | null;
  readonly supplierName: string | null;
  readonly status: number | null;
  readonly creditDebit: string | null;
  /** Document currency if not EUR; the sums are in euro either way. */
  readonly foreignCurrency: string | null;
  readonly sumNet: number | null;
  readonly sumTax: number | null;
  readonly sumGross: number | null;
  readonly openAmount: number | null;
  readonly taxRuleId: number | null;
  readonly hasDocument: boolean;
}

export function mapAuditVoucher(raw: Raw): AuditVoucher {
  const summary = mapVoucherSummary(raw);
  return {
    id: summary.id,
    date: summary.voucherDate,
    description: summary.description,
    supplierId: summary.supplierId,
    supplierName: summary.supplierName,
    status: summary.status,
    creditDebit: summary.creditDebit,
    foreignCurrency: foreignCurrencyOf(summary.currency),
    sumNet: summary.sumNet,
    sumTax: amount(raw.sumTax),
    sumGross: summary.sumGross,
    openAmount: summary.openAmount,
    taxRuleId: refId(raw.taxRule),
    hasDocument: refId(raw.document) !== null,
  };
}

export function voucherRef(v: AuditVoucher): DocumentRef {
  return {
    type: "voucher",
    id: v.id,
    date: v.date,
    number: v.description,
    contactId: v.supplierId,
    contactName: v.supplierName,
    amount: v.sumGross,
    foreignCurrency: v.foreignCurrency,
    foreignAmount: null,
  };
}

/** Vouchers dated in the period (sevdesk filters by voucher date). */
export async function scanVouchers(
  run: AuditRun,
  period: Period,
  creditDebit?: "C" | "D",
): Promise<AuditVoucher[]> {
  const { sevdesk } = run.call;
  const rows = await run.scan("vouchers", (page, signal) =>
    sevdesk.call(
      sevdesk.api.GET("/Voucher", {
        params: {
          query: {
            startDate: unixSeconds(period.startDate),
            endDate: unixSeconds(period.endDate, true),
            ...(creditDebit && { creditDebit }),
            ...page,
          },
        },
        signal,
      }),
    ),
  );
  return rows
    .map(mapAuditVoucher)
    .filter((v) => v.id > 0 && inPeriod(v.date, period))
    .filter((v) => creditDebit === undefined || v.creditDebit === creditDebit);
}

export interface AuditInvoice {
  readonly kind: "invoice" | "credit_note";
  readonly id: number;
  readonly date: string | null;
  readonly invoiceNumber: string | null;
  readonly invoiceType: string | null;
  readonly contactId: number | null;
  readonly contactName: string | null;
  readonly status: number | null;
  readonly foreignCurrency: string | null;
  readonly foreignGross: number | null;
  readonly sumNet: number | null;
  readonly sumTax: number | null;
  readonly sumGross: number | null;
  readonly openAmount: number | null;
  readonly taxRuleId: number | null;
}

/** First line of the printed address: the recipient as the invoice names it. */
function recipientOf(raw: Raw): string | null {
  return text(text(raw.address)?.split("\n")[0]);
}

export async function scanInvoices(run: AuditRun, period: Period): Promise<AuditInvoice[]> {
  const { sevdesk } = run.call;
  const rows = await run.scan("invoices", (page, signal) =>
    sevdesk.call(
      sevdesk.api.GET("/Invoice", {
        params: {
          query: {
            startDate: unixSeconds(period.startDate),
            endDate: unixSeconds(period.endDate, true),
            ...page,
          },
        },
        signal,
      }),
    ),
  );
  return rows
    .map((raw) => {
      const summary = mapInvoiceSummary(raw);
      const foreignCurrency = foreignCurrencyOf(summary.currency);
      return {
        kind: "invoice" as const,
        id: summary.id,
        date: summary.invoiceDate,
        invoiceNumber: summary.invoiceNumber,
        invoiceType: summary.invoiceType,
        contactId: summary.contactId,
        contactName: recipientOf(raw),
        status: summary.status,
        foreignCurrency,
        foreignGross: foreignCurrency === null ? null : amount(raw.sumGrossForeignCurrency),
        sumNet: summary.sumNet,
        sumTax: amount(raw.sumTax),
        sumGross: summary.sumGross,
        openAmount: summary.openAmount,
        taxRuleId: refId(raw.taxRule),
      };
    })
    .filter((i) => i.id > 0 && inPeriod(i.date, period));
}

/**
 * GET /CreditNote declares no paging in the spec; sevdesk answers unpaged
 * list requests with up to 100 objects, so a full answer may be cut.
 */
export const MAX_CREDIT_NOTES = 100;

/** Credit notes dated in the period, one unpaged request. */
export async function scanCreditNotes(run: AuditRun, period: Period): Promise<AuditInvoice[]> {
  const { sevdesk } = run.call;
  const answer = await run.request("credit notes", (signal) =>
    sevdesk.call(
      sevdesk.api.GET("/CreditNote", {
        params: {
          query: {
            startDate: unixSeconds(period.startDate),
            endDate: unixSeconds(period.endDate, true),
          },
        },
        signal,
      }),
    ),
  );
  if (answer === undefined) return [];
  const rows = objectsOf(answer.body);
  if (rows.length >= MAX_CREDIT_NOTES) {
    run.hit(
      "cap:credit notes",
      `sevdesk returned ${rows.length} credit notes in one answer (the API offers no paging ` +
        "for them); more may exist. Narrow the period.",
    );
  }
  return rows
    .map((raw) => {
      const foreignCurrency = foreignCurrencyOf(text(raw.currency));
      return {
        kind: "credit_note" as const,
        id: integer(raw.id) ?? 0,
        date: isoDateOf(raw.creditNoteDate),
        invoiceNumber: text(raw.creditNoteNumber),
        invoiceType: null,
        contactId: refId(raw.contact),
        contactName: recipientOf(raw),
        status: integer(raw.status),
        foreignCurrency,
        foreignGross: foreignCurrency === null ? null : amount(raw.sumGrossForeignCurrency),
        sumNet: amount(raw.sumNet),
        sumTax: amount(raw.sumTax),
        sumGross: amount(raw.sumGross),
        openAmount: null,
        taxRuleId: refId(raw.taxRule),
      };
    })
    .filter((c) => c.id > 0 && inPeriod(c.date, period));
}

/**
 * Sign of a revenue document in sums: cancellation invoices (SR) and credit
 * notes reduce revenue. The spec does not say whether sevdesk stores them
 * negative, so they count as -|amount| either way: never added, never
 * subtracted twice.
 */
export function revenueSign(i: Pick<AuditInvoice, "kind" | "invoiceType">): 1 | -1 {
  return i.kind === "credit_note" || i.invoiceType === "SR" ? -1 : 1;
}

/** `value` with the sign revenueSign gives; null stays null. */
export function signed(value: number | null, sign: 1 | -1): number | null {
  if (value === null) return null;
  return sign === -1 ? -Math.abs(value) : value;
}

/**
 * Final invoices (ER) next to advance or partial invoices (AR, TR): the spec
 * does not say whether an ER's sums repeat the advances it settles, so the
 * answer says the total may count them twice instead of guessing.
 */
export function partialInvoiceNote(invoices: readonly AuditInvoice[]): string | undefined {
  const types = new Set(invoices.map((i) => i.invoiceType));
  if (!types.has("ER") || !(types.has("AR") || types.has("TR"))) return undefined;
  return (
    "The period has final invoices (ER) and advance or partial invoices (AR, TR). If a final " +
    "invoice repeats the amounts of its advances, they are counted twice; check those invoices."
  );
}

export function invoiceRef(i: AuditInvoice): DocumentRef {
  return {
    type: i.kind,
    id: i.id,
    date: i.date,
    number: i.invoiceNumber,
    contactId: i.contactId,
    contactName: i.contactName,
    amount: i.sumGross,
    foreignCurrency: i.foreignCurrency,
    foreignAmount: i.foreignGross,
  };
}

export interface AuditTransaction {
  readonly id: number;
  readonly date: string | null;
  readonly amount: number | null;
  readonly purpose: string | null;
  readonly payeePayerName: string | null;
  readonly checkAccountId: number | null;
  readonly status: number | null;
}

export async function scanTransactions(
  run: AuditRun,
  period: Period,
  checkAccountId?: number,
): Promise<AuditTransaction[]> {
  const { sevdesk } = run.call;
  const rows = await run.scan("transactions", (page, signal) =>
    sevdesk.call(
      sevdesk.api.GET("/CheckAccountTransaction", {
        params: {
          query: {
            ...(checkAccountId && {
              "checkAccount[id]": checkAccountId,
              "checkAccount[objectName]": "CheckAccount",
            }),
            startDate: berlinDateTime(period.startDate),
            endDate: berlinDateTime(period.endDate, true),
            ...page,
          },
        },
        signal,
      }),
    ),
  );
  return rows
    .map((raw) => ({
      id: integer(raw.id) ?? 0,
      date: isoDateOf(raw.valueDate),
      amount: amount(raw.amount),
      purpose: text(raw.paymtPurpose),
      payeePayerName: text(raw.payeePayerName),
      checkAccountId: refId(raw.checkAccount),
      status: integer(raw.status),
    }))
    .filter((t) => t.id > 0 && inPeriod(t.date, period));
}

export function transactionRef(t: AuditTransaction): DocumentRef {
  return {
    type: "transaction",
    id: t.id,
    date: t.date,
    number: t.purpose,
    contactId: null,
    contactName: t.payeePayerName,
    amount: t.amount,
    foreignCurrency: null,
    foreignAmount: null,
  };
}

/** Lower-case, single-spaced key for comparing names and numbers. */
export const normalized = (value: string | null): string =>
  (value ?? "").toLowerCase().replace(/\s+/g, " ").trim();

/** Supplier key: the contact ID, else the typed supplier name, else null. */
export function supplierKey(v: { supplierId: number | null; supplierName: string | null }) {
  if (v.supplierId !== null) return `id:${v.supplierId}`;
  const name = normalized(v.supplierName);
  return name === "" ? null : `name:${name}`;
}

export const SEVERITIES = ["high", "medium", "low"] as const;
export type Severity = (typeof SEVERITIES)[number];
export const severityRank = (s: Severity): number => SEVERITIES.indexOf(s);

export const HINT_DISCLAIMER =
  "Hints to check, not tax advice; where a decision is needed, ask the Steuerberater.";
