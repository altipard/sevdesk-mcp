import { z } from "zod";
import type { ToolCall } from "../policy/registry.js";
import { SevdeskError } from "../sevdesk/errors.js";
import {
  amount,
  badInput,
  berlinDateTime,
  cents,
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
/*
 * Request budget at the default pace (SEVDESK_RATE_LIMIT 4/s, burst 4):
 * 45 s allow about 4 + 45 * 4 = 184 requests per call, shared with every
 * other call of the token. audit_vat spends a few on the version, the
 * voucher pages and the tax guidance, then reads positions until
 * AUDIT_DEADLINE_MS - CONTACT_RESERVE_MS (35 s: about 140 requests) and
 * keeps the last 10 s (about 40 requests) for supplier lookups. The caps
 * sit below both, so at the default pace they, not the clock, end a call
 * of a normal month.
 */
/** Vouchers whose positions are read per audit_vat call (one request each). */
export const MAX_AUDIT_POSITIONS = 130;
/** Supplier contacts looked up per audit_vat call (one request each). */
export const MAX_AUDIT_CONTACTS = 30;
/**
 * Requests in flight at once: the burst of the default bucket, so latency
 * does not hold the pace below the rate limit; the limiter does the rest.
 */
export const AUDIT_CONCURRENCY = 4;
/**
 * Time for all requests of one audit call, like RECEIVABLES_DEADLINE_MS:
 * below the 60 s request timeout of MCP clients, so a partial answer still
 * arrives.
 */
export const AUDIT_DEADLINE_MS = 45_000;
/** Time at the end of an audit_vat call kept for supplier lookups after the positions. */
export const CONTACT_RESERVE_MS = 10_000;
/** Upper bound for the bookkeeping version check, inside the deadline. */
export const VERSION_TIMEOUT_MS = 10_000;

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

/** Why an audit call stopped sending requests altogether. */
type StopReason = "deadline" | "cancelled" | "rate_limited";

/** Outcome of one request of an audit call (see AuditRun.attempt). */
export type Attempt =
  | { readonly kind: "ok"; readonly body: unknown }
  /** Not sent: the call had stopped before (deadline, cancel, rate limit). */
  | { readonly kind: "skipped" }
  | { readonly kind: "deadline" | "cancelled"; readonly error?: unknown }
  /** Cut by the request's own earlier limit (`until`); the call goes on. */
  | { readonly kind: "cut"; readonly error?: unknown }
  | { readonly kind: "error"; readonly error: SevdeskError };

/**
 * One audit call: shared deadline and the limits it ran into. A limit is
 * recorded once, with a note naming it; any recorded limit marks the
 * answer truncated. The deadline, a cancel by the MCP client and a 429
 * that the client's retries could not get past stop the call: every later
 * request is skipped, so a throttled token is not pressed further.
 */
export class AuditRun {
  readonly deadline: number;
  private readonly limits = new Map<string, string>();
  private stop: StopReason | undefined;
  private stopError: SevdeskError | undefined;

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

  /** The call stopped sending (deadline, cancel or rate limit). */
  get stopped(): boolean {
    return this.stop !== undefined;
  }

  private stopFor(reason: StopReason, error?: SevdeskError): void {
    if (this.stop !== undefined) return;
    this.stop = reason;
    this.stopError = error;
    this.hit(
      reason,
      reason === "deadline"
        ? `Stopped after ${AUDIT_DEADLINE_MS / 1000} s; not everything was read. Narrow the period.`
        : reason === "cancelled"
          ? "The call was cancelled; nothing more was read."
          : "sevdesk answered 429 (rate limit) after the client's retries; the remaining requests " +
            "of this call were skipped, so not everything was read. Try again in a minute.",
    );
  }

  /**
   * One request under the deadline, the MCP client's cancel and, if given,
   * an earlier limit `until` (epoch ms) of its own. Nothing is recorded
   * for a failed or cut request; the deadline, a cancel and a 429 stop the
   * call (see the class). A local policy refusal always throws.
   */
  async attempt(send: (signal: AbortSignal) => Promise<unknown>, until?: number): Promise<Attempt> {
    if (this.stop !== undefined) return { kind: "skipped" };
    const cancel = this.call.signal;
    if (cancel.aborted) {
      this.stopFor("cancelled");
      return { kind: "cancelled" };
    }
    const now = Date.now();
    const remaining = this.deadline - now;
    if (remaining <= 0) {
      this.stopFor("deadline");
      return { kind: "deadline" };
    }
    if (until !== undefined && until <= now) return { kind: "cut" };
    const deadline = AbortSignal.timeout(remaining);
    const cut =
      until !== undefined && until < this.deadline ? AbortSignal.timeout(until - now) : undefined;
    const signal = AbortSignal.any(cut ? [cancel, deadline, cut] : [cancel, deadline]);
    try {
      return { kind: "ok", body: await send(signal) };
    } catch (error) {
      if (error instanceof SevdeskError && error.kind === "policy") throw error;
      if (cancel.aborted) {
        this.stopFor("cancelled");
        return { kind: "cancelled", error };
      }
      if (deadline.aborted) {
        this.stopFor("deadline");
        return { kind: "deadline", error };
      }
      if (cut?.aborted) return { kind: "cut", error };
      if (error instanceof SevdeskError) {
        if (error.kind === "rate_limited") this.stopFor("rate_limited", error);
        return { kind: "error", error };
      }
      throw error;
    }
  }

  /**
   * One request (see attempt). Failures throw when `mustSucceed` (nothing
   * useful without the answer), except after a cancel, whose answer nobody
   * reads; otherwise they are recorded and the result is undefined. A
   * request cut by `until` is not recorded: the caller accounts for it. The
   * note names the error kind and status, never upstream text.
   */
  async request(
    what: string,
    send: (signal: AbortSignal) => Promise<unknown>,
    mustSucceed = false,
    until?: number,
  ): Promise<{ body: unknown } | undefined> {
    const result = await this.attempt(send, until);
    switch (result.kind) {
      case "ok":
        return { body: result.body };
      case "skipped":
        if (mustSucceed && this.stopError !== undefined) throw this.stopError;
        return undefined;
      case "deadline":
      case "cut":
        if (mustSucceed && result.error !== undefined) throw result.error;
        return undefined;
      case "cancelled":
        return undefined;
      case "error": {
        const { error } = result;
        if (mustSucceed) throw error;
        // A 429 has its own note (stopFor).
        if (error.kind !== "rate_limited") {
          const status = error.status === undefined ? "" : ` ${error.status}`;
          this.hit(
            `failed:${what}`,
            `Reading ${what} failed (${error.kind}${status}); results without them are incomplete.`,
          );
        }
        return undefined;
      }
    }
  }

  /** Set once the first scan of the call started; only that scan's first page must succeed. */
  private scanned = false;

  /**
   * Every object of a paged list, up to `cap`. The first page of the call's
   * first scan must succeed; any later failure or the deadline keeps what
   * was read and is recorded. The cap is recorded only when sevdesk has
   * more after it (one probe request of a single object). With
   * `guardRepeats`, for lists whose paging the upstream spec does not
   * declare, objects seen on an earlier page are dropped and a full page
   * with nothing new ends the scan, so a list that ignored limit/offset is
   * never counted twice.
   */
  async scan(
    what: string,
    send: (page: { limit: number; offset: number }, signal: AbortSignal) => Promise<unknown>,
    cap: number = MAX_AUDIT_DOCUMENTS,
    guardRepeats = false,
  ): Promise<Raw[]> {
    const first = !this.scanned;
    this.scanned = true;
    const items: Raw[] = [];
    const seen = new Set<number>();
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
      const fresh = guardRepeats
        ? page.filter((raw) => {
            const id = integer(raw.id);
            return id === null || !seen.has(id);
          })
        : page;
      for (const raw of fresh) {
        const id = integer(raw.id);
        if (id !== null) seen.add(id);
      }
      items.push(...fresh);
      if (page.length < limit) break;
      if (fresh.length === 0) {
        this.hit(
          `paging:${what}`,
          `sevdesk repeated the same ${what} on the next page; only the ${items.length} distinct ` +
            "ones were used and more may exist. Narrow the period.",
        );
        break;
      }
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
  /** Document currency if not EUR. */
  readonly foreignCurrency: string | null;
  /**
   * Euro sums: sumNet etc.; for a foreign-currency voucher the *Accounting
   * fields where sevdesk sends them (not missing, not 0).
   */
  readonly sumNet: number | null;
  readonly sumTax: number | null;
  readonly sumGross: number | null;
  /**
   * Foreign-currency voucher without usable *Accounting sums: its sums are
   * sumNet etc., whose currency the spec does not state.
   */
  readonly euroUnconfirmed: boolean;
  readonly openAmount: number | null;
  readonly taxRuleId: number | null;
  readonly hasDocument: boolean;
}

/**
 * Vouchers have no *ForeignCurrency sums, only sumNetAccounting,
 * sumTaxAccounting and sumGrossAccounting, documented as "usually the same
 * as sumNet". The spec's own example has sumNet 100 next to
 * sumNetAccounting 0, so they are not trusted for euro vouchers, whose
 * sumNet etc. are euro anyway. For a foreign-currency voucher they are the
 * euro amounts; if they are missing or 0 while sumGross is not, sumNet etc.
 * are used and that euro amount is unconfirmed (euroUnconfirmed). Only net
 * and gross decide: a tax of 0 is common.
 */
export function mapAuditVoucher(raw: Raw): AuditVoucher {
  const summary = mapVoucherSummary(raw);
  const foreignCurrency = foreignCurrencyOf(summary.currency);
  const net = amount(raw.sumNetAccounting);
  const tax = amount(raw.sumTaxAccounting);
  const gross = amount(raw.sumGrossAccounting);
  const zero = net === 0 && gross === 0 && (summary.sumGross ?? 0) !== 0;
  const accounting = foreignCurrency !== null && net !== null && gross !== null && !zero;
  return {
    id: summary.id,
    date: summary.voucherDate,
    description: summary.description,
    supplierId: summary.supplierId,
    supplierName: summary.supplierName,
    status: summary.status,
    creditDebit: summary.creditDebit,
    foreignCurrency,
    sumNet: accounting ? net : summary.sumNet,
    // Without sumTaxAccounting the euro tax is gross minus net: sumTax is in
    // the document currency and would not fit the euro net and gross.
    sumTax: accounting ? (tax ?? cents((gross as number) - (net as number))) : amount(raw.sumTax),
    sumGross: accounting ? gross : summary.sumGross,
    euroUnconfirmed: foreignCurrency !== null && !accounting,
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
 * Credit notes dated in the period. limit/offset are documented by sevdesk
 * for every list but declared for GET /CreditNote only by the overlay, so
 * repeated pages are guarded against (see scan).
 */
export async function scanCreditNotes(run: AuditRun, period: Period): Promise<AuditInvoice[]> {
  const { sevdesk } = run.call;
  const rows = await run.scan(
    "credit notes",
    (page, signal) =>
      sevdesk.call(
        sevdesk.api.GET("/CreditNote", {
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
    MAX_AUDIT_DOCUMENTS,
    true,
  );
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
 * Note for answers whose sums contain cancellation invoices (SR) or credit
 * notes: they were subtracted whatever sign sevdesk stores (revenueSign).
 */
export function signNote(
  documents: readonly Pick<AuditInvoice, "kind" | "invoiceType">[],
): string | undefined {
  const cancellations = documents.filter((d) => d.kind === "invoice" && d.invoiceType === "SR");
  const creditNotes = documents.filter((d) => d.kind === "credit_note");
  const parts = [
    cancellations.length > 0 && `${cancellations.length} cancellation invoice(s) (SR)`,
    creditNotes.length > 0 && `${creditNotes.length} credit note(s)`,
  ].filter((p): p is string => typeof p === "string");
  if (parts.length === 0) return undefined;
  return (
    `${parts.join(" and ")} are subtracted in the sums, whatever sign sevdesk stores (the API ` +
    "does not document it); check them if a total looks off."
  );
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

/** Note for answers with foreign-currency vouchers whose euro amount sevdesk did not send. */
export function euroNote(vouchers: readonly AuditVoucher[]): string | undefined {
  const count = vouchers.filter((v) => v.euroUnconfirmed).length;
  if (count === 0) return undefined;
  return (
    `${count} voucher(s) in another currency came without euro accounting sums (missing or 0); their ` +
    "amounts are sevdesk's sumNet/sumGross, whose currency is unconfirmed."
  );
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
