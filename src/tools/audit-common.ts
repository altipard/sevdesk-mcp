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

  /**
   * Every object of a paged list, up to `cap`. The first page must succeed;
   * a later failure or the deadline keeps what was read and is recorded.
   */
  async scan(
    what: string,
    send: (page: { limit: number; offset: number }, signal: AbortSignal) => Promise<unknown>,
    cap: number = MAX_AUDIT_DOCUMENTS,
  ): Promise<Raw[]> {
    const items: Raw[] = [];
    for (let offset = 0; ; offset += SCAN_PAGE) {
      if (items.length >= cap) {
        this.hit(
          `cap:${what}`,
          `Only the first ${cap} ${what} of the period were read (cap); narrow the period.`,
        );
        break;
      }
      const answer = await this.request(
        what,
        (signal) => send({ limit: SCAN_PAGE, offset }, signal),
        offset === 0,
      );
      if (answer === undefined) break;
      const page = objectsOf(answer.body);
      items.push(...page);
      if (page.length < SCAN_PAGE) break;
    }
    return items.slice(0, cap);
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
  type: z.enum(["voucher", "invoice", "transaction"]),
  id: z.number().int(),
  date: z.string().nullable().describe("Voucher, invoice or value date, YYYY-MM-DD."),
  number: z.string().nullable().describe("Invoice number, voucher description or purpose."),
  contactId: z.number().int().nullable(),
  contactName: z.string().nullable(),
  amount: z.number().nullable().describe("Gross amount (transactions: signed amount)."),
  currency: z.string().nullable(),
});
export type DocumentRef = z.infer<typeof documentRefSchema>;

export interface AuditVoucher {
  readonly id: number;
  readonly date: string | null;
  readonly description: string | null;
  readonly supplierId: number | null;
  readonly supplierName: string | null;
  readonly status: number | null;
  readonly creditDebit: string | null;
  readonly currency: string | null;
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
    currency: summary.currency,
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
    currency: v.currency,
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
  readonly id: number;
  readonly date: string | null;
  readonly invoiceNumber: string | null;
  readonly invoiceType: string | null;
  readonly contactId: number | null;
  readonly contactName: string | null;
  readonly status: number | null;
  readonly currency: string | null;
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
      return {
        id: summary.id,
        date: summary.invoiceDate,
        invoiceNumber: summary.invoiceNumber,
        invoiceType: summary.invoiceType,
        contactId: summary.contactId,
        contactName: recipientOf(raw),
        status: summary.status,
        currency: summary.currency,
        sumNet: summary.sumNet,
        sumTax: amount(raw.sumTax),
        sumGross: summary.sumGross,
        openAmount: summary.openAmount,
        taxRuleId: refId(raw.taxRule),
      };
    })
    .filter((i) => i.id > 0 && inPeriod(i.date, period));
}

export function invoiceRef(i: AuditInvoice): DocumentRef {
  return {
    type: "invoice",
    id: i.id,
    date: i.date,
    number: i.invoiceNumber,
    contactId: i.contactId,
    contactName: i.contactName,
    amount: i.sumGross,
    currency: i.currency,
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
    currency: null,
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

/** Document currency counts as euro when it is EUR or missing. */
export const isEuro = (currency: string | null): boolean =>
  currency === null || currency.toUpperCase() === "EUR";

export const SEVERITIES = ["high", "medium", "low"] as const;
export type Severity = (typeof SEVERITIES)[number];
export const severityRank = (s: Severity): number => SEVERITIES.indexOf(s);

export const HINT_DISCLAIMER =
  "Hints to check, not tax advice; where a decision is needed, ask the Steuerberater.";
