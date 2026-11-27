import { z } from "zod";
import { defineTool, type ToolCall } from "../policy/registry.js";
import { SevdeskError } from "../sevdesk/errors.js";
import {
  AUDIT_CONCURRENCY,
  type AuditInvoice,
  AuditRun,
  type AuditVoucher,
  auditFields,
  checkPeriod,
  type DocumentRef,
  documentRefSchema,
  euroNote,
  HINT_DISCLAIMER,
  invoiceRef,
  MAX_AUDIT_CONTACTS,
  MAX_AUDIT_POSITIONS,
  mapLimited,
  type Period,
  partialInvoiceNote,
  periodInput,
  periodSchema,
  revenueSign,
  SEVERITIES,
  type Severity,
  scanCreditNotes,
  scanInvoices,
  scanVouchers,
  severityRank,
  signed,
  supplierKey,
  voucherRef,
} from "./audit-common.js";
import {
  amount,
  asRecord,
  badInput,
  cents,
  FOREIGN_DATA_NOTE,
  integer,
  objectsOf,
  pageInput,
  pageOf,
  pageSchema,
  type Raw,
  READ_ANNOTATIONS,
  refId,
  text,
} from "./format.js";
import { present } from "./result.js";
import {
  BOOKKEEPING_1_MESSAGE,
  describeRule,
  EU_VAT_PREFIXES,
  GUIDANCE_RATES,
  type ReverseChargeKind,
  sideOfCreditDebit,
  TAX_RULES,
  vatPrefix,
} from "./tax-rules.js";
import { MAX_VOUCHER_POSITIONS } from "./vouchers.js";

// ---------------------------------------------------------------------------
// Bookkeeping version

/**
 * Refuses bookkeeping 1.0 accounts (taxType instead of taxRule). If the
 * version cannot be read, the check goes on as 2.0 and says so.
 */
async function requireBookkeeping2({
  sevdesk,
}: ToolCall): Promise<{ version: string | null; note?: string }> {
  let body: unknown;
  try {
    body = await sevdesk.call(sevdesk.api.GET("/Tools/bookkeepingSystemVersion"));
  } catch (error) {
    if (error instanceof SevdeskError && error.kind !== "policy") {
      return {
        version: null,
        note: `The bookkeeping version could not be read (${error.kind}); bookkeeping 2.0 was assumed.`,
      };
    }
    throw error;
  }
  const version = text(asRecord(asRecord(body).objects).version);
  if (version === "1.0") throw badInput(BOOKKEEPING_1_MESSAGE);
  return { version };
}

// ---------------------------------------------------------------------------
// Findings

/** Codes audit_vat reports, most severe first. */
export const AUDIT_VAT_CODES = [
  "FOREIGN_SUPPLIER_DOMESTIC_RULE",
  "WRONG_SIDE_TAX_RULE",
  "RATE_CONTRADICTS_RULE",
  "RULE_NOT_ALLOWED_FOR_ACCOUNT",
  "RATE_NOT_ALLOWED_FOR_ACCOUNT",
  "RULE_NOT_FOR_VOUCHERS",
  "UNKNOWN_TAX_RULE",
  "MISSING_TAX_RULE",
  "NET_PLUS_TAX_NOT_GROSS",
  "POSITIONS_DIFFER_FROM_HEADER",
  "POSITION_SUM_MISMATCH",
  "TAX_AMOUNT_DIFFERS_FROM_RATE",
  "SUPPLIER_COUNTRY_UNKNOWN",
  "ACCOUNT_NOT_IN_GUIDANCE",
  "INCONSISTENT_SUPPLIER_TAX_RULES",
  "FOREIGN_CURRENCY",
] as const;
type AuditVatCode = (typeof AUDIT_VAT_CODES)[number];

/** Rounding tolerance in currency units for each sum comparison. */
export const SUM_TOLERANCE = 0.02;

const findingSchema = z.object({
  severity: z.enum(SEVERITIES),
  code: z.enum(AUDIT_VAT_CODES),
  document: documentRefSchema,
  detail: z.string(),
  suggestion: z.string(),
  suggestedTaxRules: z.array(z.number().int()).optional(),
});
type Finding = z.infer<typeof findingSchema>;

interface Position {
  accountDatevId: number | null;
  taxRate: number | null;
  sumNet: number | null;
  sumTax: number | null;
  sumGross: number | null;
}

interface PositionsRead {
  positions: Position[];
  /** sevdesk answered with a full page; more may exist, sums are not compared. */
  partial: boolean;
}

/** Account -> rule -> allowed rates (null: rates unreadable). */
type Guidance = Map<number, Map<number, Set<number> | null>>;

interface SupplierCountry {
  /** true: address (or VAT ID) abroad; false: German; null: unknown. */
  foreign: boolean | null;
  /**
   * From the VAT ID prefix: eu (EU member other than Germany), xi (Northern
   * Ireland, EU only for goods), non_eu, de_vat (German VAT ID despite a
   * foreign address: not an EU-foreign business) or unknown (none, unclear).
   */
  region: "eu" | "xi" | "non_eu" | "de_vat" | "unknown";
}

function parseGuidance(body: unknown): Guidance {
  const accounts: Guidance = new Map();
  for (const entry of objectsOf(body)) {
    const accountId = integer(entry.accountDatevId);
    if (accountId === null) continue;
    const rules = accounts.get(accountId) ?? new Map<number, Set<number> | null>();
    for (const raw of Array.isArray(entry.allowedTaxRules) ? entry.allowedTaxRules : []) {
      const rule = asRecord(raw);
      const id = integer(rule.id);
      if (id === null) continue;
      const rates = new Set<number>();
      let readable = true;
      for (const name of Array.isArray(rule.taxRates) ? rule.taxRates : []) {
        const rate = typeof name === "string" ? GUIDANCE_RATES[name] : undefined;
        if (rate === undefined) readable = false;
        else rates.add(rate);
      }
      rules.set(id, readable ? rates : null);
    }
    accounts.set(accountId, rules);
  }
  return accounts;
}

function mapPositions(body: unknown, voucherId: number): PositionsRead {
  const rows = objectsOf(body);
  return {
    partial: rows.length >= MAX_VOUCHER_POSITIONS,
    positions: rows
      .filter((pos) => refId(pos.voucher) === null || refId(pos.voucher) === voucherId)
      .map((pos: Raw) => ({
        accountDatevId: refId(pos.accountDatev),
        taxRate: amount(pos.taxRate),
        sumNet: amount(pos.sumNet),
        sumTax: amount(pos.sumTax),
        sumGross: amount(pos.sumGross),
      })),
  };
}

/** Country of a contact from its invoice (or first) address, else from the VAT ID. */
export function countryOf(raw: Raw): SupplierCountry {
  const addresses = Array.isArray(raw.addresses) ? raw.addresses.map(asRecord) : [];
  const chosen = addresses.find((a) => refId(a.category) === 47) ?? addresses[0];
  const countryId = chosen === undefined ? null : refId(chosen.country);
  const prefix = vatPrefix(text(raw.vatNumber));
  const region: SupplierCountry["region"] =
    prefix === null
      ? "unknown"
      : prefix === "DE"
        ? "de_vat"
        : prefix === "XI"
          ? "xi"
          : EU_VAT_PREFIXES.has(prefix)
            ? "eu"
            : "non_eu";
  if (countryId !== null) return { foreign: countryId !== GERMANY_COUNTRY_ID, region };
  if (prefix !== null) return { foreign: prefix !== "DE", region };
  return { foreign: null, region: "unknown" };
}

/** sevdesk ID of the StaticCountry Germany. */
const GERMANY_COUNTRY_ID = 1;

const sum = (values: readonly (number | null)[]): number | null =>
  values.some((v) => v === null)
    ? null
    : cents(values.reduce<number>((total, v) => total + (v as number), 0));

const differs = (a: number | null, b: number | null, tolerance = SUM_TOLERANCE): boolean =>
  a !== null && b !== null && Math.abs(a - b) > tolerance + 1e-9;

/**
 * Rules where the recipient owes the tax (13b, intra-EU acquisition). The
 * spec lists them as "0% (19%)" without saying whether sevdesk shows the
 * self-assessed tax in sumTax, so tax amount checks are skipped for them
 * and only net sums are compared.
 */
export const SELF_ASSESSED_RULES: ReadonlySet<number> = new Set([8, 12, 13, 14]);

const FOREIGN_SUPPLIER_ADVICE: Readonly<
  Record<"eu" | "xi" | "non_eu" | "unknown", { suggestion: string; rules: number[] }>
> = {
  eu: {
    suggestion:
      "For a service from an EU business rule 14 usually fits, for goods rule 8; check with " +
      "the Steuerberater.",
    rules: [14, 8],
  },
  xi: {
    suggestion:
      "Northern Ireland counts as EU for goods only: goods rule 8, a service rule 12 (with " +
      "input tax deduction) or 13 (without); check with the Steuerberater.",
    rules: [8, 12, 13],
  },
  non_eu: {
    suggestion:
      "For a service from a business outside the EU rule 12 (with input tax deduction) or 13 " +
      "(without) usually fits; check with the Steuerberater.",
    rules: [12, 13],
  },
  unknown: {
    suggestion:
      "The supplier's VAT ID is missing or unclear, so the fitting rule depends on where the " +
      "business sits and what was bought: 14 (EU service), 8 (EU goods), 12 or 13 (service " +
      "from outside the EU). Check with the Steuerberater.",
    rules: [14, 8, 12, 13],
  },
};

const ratesText = (rates: Iterable<number>) =>
  [...rates]
    .sort((a, b) => a - b)
    .map((r) => `${r} %`)
    .join(", ");

interface VoucherContext {
  voucher: AuditVoucher;
  positions?: PositionsRead | undefined;
  country?: SupplierCountry | undefined;
  guidance?: Guidance | undefined;
}

/** Findings for one voucher; each code at most once per voucher. */
export function checkVoucher({ voucher, positions, country, guidance }: VoucherContext): Finding[] {
  const findings: Finding[] = [];
  const document = voucherRef(voucher);
  const add = (
    severity: Severity,
    code: AuditVatCode,
    detail: string,
    suggestion: string,
    suggestedTaxRules?: number[],
  ) =>
    findings.push({
      severity,
      code,
      document,
      detail,
      suggestion,
      ...(suggestedTaxRules && { suggestedTaxRules }),
    });

  const side = sideOfCreditDebit(voucher.creditDebit);
  const ruleId = voucher.taxRuleId;
  const rule = ruleId === null ? undefined : TAX_RULES[ruleId];
  const draft = voucher.status === 50;

  if (ruleId === null) {
    add(
      draft ? "low" : "medium",
      "MISSING_TAX_RULE",
      "The voucher has no tax rule.",
      "Set the tax rule that fits the voucher before it is booked.",
    );
  } else if (rule === undefined) {
    add(
      "medium",
      "UNKNOWN_TAX_RULE",
      `${describeRule(ruleId)} is not a bookkeeping 2.0 rule this server knows.`,
      "Check the tax rule in sevdesk.",
    );
  } else if (side !== null && rule.side !== side) {
    const expense = side === "expense";
    add(
      "high",
      "WRONG_SIDE_TAX_RULE",
      `${expense ? "Expense (D)" : "Revenue (C)"} voucher booked with ${describeRule(ruleId)}, ` +
        `a ${rule.side} rule.`,
      expense
        ? "Expense vouchers take an expense rule (8, 9, 10, 12, 13 or 14); check the voucher."
        : "Revenue vouchers take a revenue rule (1, 2, 3, 4, 5, 11 or 17); check the voucher.",
      expense ? [9] : [1],
    );
  } else if (!rule.vouchers) {
    add(
      "medium",
      "RULE_NOT_FOR_VOUCHERS",
      `${describeRule(ruleId)} is documented for invoices only, not for vouchers.`,
      "Check the tax rule of the voucher.",
    );
  }

  if (voucher.foreignCurrency !== null) {
    add(
      "low",
      "FOREIGN_CURRENCY",
      voucher.euroUnconfirmed
        ? `Document currency ${voucher.foreignCurrency}; sevdesk sent no euro accounting sums, ` +
            "so the amounts shown may be in that currency and position sums were not compared."
        : `Document currency ${voucher.foreignCurrency}; the amounts shown are sevdesk's euro ` +
            "accounting sums and position sums were not compared.",
      "Check the exchange rate and the euro amounts in sevdesk.",
    );
  }

  const selfAssessed = ruleId !== null && SELF_ASSESSED_RULES.has(ruleId);
  if (
    !selfAssessed &&
    voucher.sumNet !== null &&
    voucher.sumTax !== null &&
    voucher.sumGross !== null
  ) {
    const expected = cents(voucher.sumNet + voucher.sumTax);
    if (differs(expected, voucher.sumGross)) {
      add(
        "medium",
        "NET_PLUS_TAX_NOT_GROSS",
        `Net ${voucher.sumNet} plus tax ${voucher.sumTax} is ${expected}, gross is ${voucher.sumGross}.`,
        "Check the amounts of the voucher against the receipt.",
      );
    }
  }

  if (positions === undefined) return findings;
  const list = positions.positions;
  const zeroOnly = list.length > 0 && list.every((p) => p.taxRate === 0);

  // Foreign supplier, domestic expense rule, no tax charged: typical reverse charge case.
  if (side === "expense" && (ruleId === 9 || ruleId === 10) && zeroOnly) {
    if (country?.foreign === true && country.region !== "de_vat") {
      const advice = FOREIGN_SUPPLIER_ADVICE[country.region];
      const label = {
        eu: " (EU VAT ID)",
        xi: " (Northern Ireland VAT ID)",
        non_eu: " (VAT ID outside the EU)",
        unknown: "",
      }[country.region];
      add(
        // Rule 10 with 0 % abroad is often right (hotels, travel abroad).
        ruleId === 9 ? "high" : "low",
        "FOREIGN_SUPPLIER_DOMESTIC_RULE",
        `Supplier from abroad${label}, booked with ${describeRule(ruleId)} and only 0 % ` +
          "positions: possibly a reverse charge case (section 13b UStG).",
        advice.suggestion,
        advice.rules,
      );
    } else if (country?.foreign === null && voucher.supplierId !== null) {
      add(
        "low",
        "SUPPLIER_COUNTRY_UNKNOWN",
        `Booked with ${describeRule(ruleId)} and only 0 % positions, but the supplier has no ` +
          "address country or VAT ID, so a reverse charge case cannot be ruled out.",
        "Add the supplier's address; if it is abroad, check the tax rule with the Steuerberater.",
      );
    }
  }

  if (rule?.rates) {
    const allowed = rule.rates;
    const wrong = [
      ...new Set(list.map((p) => p.taxRate).filter((r): r is number => r !== null)),
    ].filter((r) => !allowed.includes(r));
    if (wrong.length > 0) {
      add(
        "high",
        "RATE_CONTRADICTS_RULE",
        `Positions use ${ratesText(wrong)}, but ${describeRule(ruleId)} allows ${ratesText(allowed)}.`,
        "Either the rate or the tax rule is wrong; check the receipt.",
      );
    }
  }

  if (guidance !== undefined && ruleId !== null) {
    const missing = new Set<number>();
    const notAllowed = new Map<number, number[]>();
    const wrongRate = new Map<number, Set<number>>();
    for (const p of list) {
      if (p.accountDatevId === null) continue;
      const rules = guidance.get(p.accountDatevId);
      if (rules === undefined) {
        missing.add(p.accountDatevId);
        continue;
      }
      const rates = rules.get(ruleId);
      if (!rules.has(ruleId)) {
        notAllowed.set(
          p.accountDatevId,
          [...rules.keys()].sort((a, b) => a - b),
        );
      } else if (rates && rates.size > 0 && p.taxRate !== null && !rates.has(p.taxRate)) {
        wrongRate.set(p.accountDatevId, rates);
      }
    }
    if (notAllowed.size > 0) {
      const [account, allowed] = [...notAllowed.entries()][0] as [number, number[]];
      add(
        "medium",
        "RULE_NOT_ALLOWED_FOR_ACCOUNT",
        `sevdesk's tax guidance does not allow ${describeRule(ruleId)} with account ` +
          `${[...notAllowed.keys()].join(", ")}.`,
        `Allowed with account ${account}: ${allowed.length > 0 ? allowed.join(", ") : "none"}. ` +
          "Change the account or the tax rule (see get_tax_guidance).",
        allowed.length > 0 ? allowed : undefined,
      );
    }
    if (wrongRate.size > 0) {
      const [account, rates] = [...wrongRate.entries()][0] as [number, Set<number>];
      add(
        "medium",
        "RATE_NOT_ALLOWED_FOR_ACCOUNT",
        `sevdesk allows ${ratesText(rates)} with ${describeRule(ruleId)} on account ${account}; ` +
          "a position uses another rate.",
        "Check the rate of the position.",
      );
    }
    if (missing.size > 0) {
      add(
        "low",
        "ACCOUNT_NOT_IN_GUIDANCE",
        `Account ${[...missing].join(", ")} is not in sevdesk's tax guidance.`,
        "Check the booking account (see get_tax_guidance).",
      );
    }
  }

  // Position sums are in the document currency, the header in euro: compare only euro vouchers.
  if (!positions.partial && list.length > 0 && voucher.foreignCurrency === null) {
    const tolerance = Math.max(SUM_TOLERANCE, 0.01 * list.length);
    const net = sum(list.map((p) => p.sumNet));
    const gross = sum(list.map((p) => p.sumGross));
    // Self-assessed rules: gross may or may not carry the tax, compare net only.
    if (
      differs(net, voucher.sumNet, tolerance) ||
      (!selfAssessed && differs(gross, voucher.sumGross, tolerance))
    ) {
      add(
        "medium",
        "POSITIONS_DIFFER_FROM_HEADER",
        selfAssessed
          ? `Positions add up to net ${net}, the voucher says net ${voucher.sumNet}.`
          : `Positions add up to net ${net} / gross ${gross}, the voucher says net ` +
              `${voucher.sumNet} / gross ${voucher.sumGross}.`,
        "Check the positions against the receipt.",
      );
    }
  }
  if (selfAssessed) return findings;
  const brokenPositions = list.filter(
    (p) =>
      p.sumNet !== null &&
      p.sumTax !== null &&
      p.sumGross !== null &&
      differs(cents(p.sumNet + p.sumTax), p.sumGross),
  ).length;
  if (brokenPositions > 0) {
    add(
      "low",
      "POSITION_SUM_MISMATCH",
      `${brokenPositions} position(s) where net plus tax is not gross.`,
      "Check the position amounts.",
    );
  }
  const offRate = list.filter(
    (p) =>
      p.taxRate !== null &&
      p.sumNet !== null &&
      p.sumTax !== null &&
      differs(cents((p.sumNet * p.taxRate) / 100), p.sumTax),
  ).length;
  if (offRate > 0) {
    add(
      "low",
      "TAX_AMOUNT_DIFFERS_FROM_RATE",
      `${offRate} position(s) where the tax amount does not match net times rate.`,
      "Check rate and tax amount against the receipt.",
    );
  }
  return findings;
}

/** One finding per supplier whose expense vouchers carry different tax rules. */
export function checkSupplierConsistency(vouchers: readonly AuditVoucher[]): Finding[] {
  const groups = new Map<string, AuditVoucher[]>();
  for (const v of vouchers) {
    if (v.creditDebit !== "D" || v.taxRuleId === null) continue;
    const key = supplierKey(v);
    if (key === null) continue;
    groups.set(key, [...(groups.get(key) ?? []), v]);
  }
  const findings: Finding[] = [];
  for (const group of groups.values()) {
    const byRule = new Map<number, number[]>();
    for (const v of group) {
      byRule.set(v.taxRuleId as number, [...(byRule.get(v.taxRuleId as number) ?? []), v.id]);
    }
    if (byRule.size < 2) continue;
    const latest = [...group].sort((a, b) => (b.date ?? "").localeCompare(a.date ?? ""))[0];
    const parts = [...byRule.entries()]
      .sort((a, b) => b[1].length - a[1].length)
      .map(([rule, ids]) => `rule ${rule}: ${ids.length} (IDs ${ids.slice(0, 5).join(", ")})`);
    findings.push({
      severity: "low",
      code: "INCONSISTENT_SUPPLIER_TAX_RULES",
      document: voucherRef(latest as AuditVoucher),
      detail: `Same supplier booked with different tax rules in the period: ${parts.join("; ")}.`,
      suggestion:
        "Different rules can be right (different services), but often one is a mistake; " +
        "check the vouchers.",
    });
  }
  return findings;
}

const sortFindings = (findings: Finding[]) =>
  findings.sort(
    (a, b) =>
      severityRank(a.severity) - severityRank(b.severity) ||
      (a.document.date ?? "").localeCompare(b.document.date ?? "") ||
      a.document.id - b.document.id,
  );

// ---------------------------------------------------------------------------
// audit_vat

export const auditVat = defineTool({
  name: "audit_vat",
  title: "Audit VAT bookings in sevdesk",
  description:
    "Checks the vouchers of a period for likely VAT booking mistakes (bookkeeping 2.0): foreign " +
    "supplier booked with a domestic expense rule and only 0 % positions (possible reverse " +
    "charge, section 13b UStG, with the fitting rule suggested), tax rule from the wrong side, " +
    "rule not allowed for the booking account (sevdesk tax guidance), rate contradicting the " +
    "rule, sums that do not add up, and suppliers booked with different rules. Each finding has " +
    "severity, code, the voucher, detail and suggestion, most severe first. The findings are " +
    `hints to check, not tax advice. Reads at most ${MAX_AUDIT_POSITIONS} vouchers' positions ` +
    "and stops early on caps or time, marking the answer truncated. Refuses bookkeeping 1.0 " +
    "accounts." +
    FOREIGN_DATA_NOTE,
  class: "R",
  operationId: "getVouchers",
  operations: [
    "bookkeepingSystemVersion",
    "getVoucherPositions",
    "getContactById",
    "forAllAccounts",
  ],
  inputSchema: z.object({
    ...periodInput,
    minSeverity: z
      .enum(SEVERITIES)
      .default("low")
      .describe("Only findings of this severity or higher."),
    ...pageInput,
  }),
  outputSchema: z.object({
    period: periodSchema,
    bookkeepingVersion: z.string().nullable(),
    checked: z.object({
      vouchers: z.number().int(),
      positionsRead: z.number().int().describe("Vouchers whose positions were read."),
      suppliersLookedUp: z.number().int(),
      guidanceRead: z.boolean().describe("sevdesk's tax guidance was read for account checks."),
    }),
    findingCounts: z.object({
      high: z.number().int(),
      medium: z.number().int(),
      low: z.number().int(),
    }),
    findings: z.array(findingSchema),
    page: pageSchema,
    disclaimer: z.string(),
    ...auditFields,
  }),
  annotations: READ_ANNOTATIONS,
  async handler(args, call) {
    const period = checkPeriod(args);
    const { sevdesk } = call;
    const version = await requireBookkeeping2(call);
    const run = new AuditRun(call);
    const vouchers = await scanVouchers(run, period);

    let guidance: Guidance | undefined;
    if (vouchers.length > 0) {
      const answer = await run.request("tax guidance", (signal) =>
        sevdesk.call(sevdesk.api.GET("/ReceiptGuidance/forAllAccounts", { signal })),
      );
      if (answer !== undefined) {
        const parsed = parseGuidance(answer.body);
        guidance = parsed.size > 0 ? parsed : undefined;
      }
    }

    if (vouchers.length > MAX_AUDIT_POSITIONS) {
      run.hit(
        "cap:positions",
        `Positions were read for the first ${MAX_AUDIT_POSITIONS} of ${vouchers.length} ` +
          "vouchers (cap); the rest were checked on their header only. Narrow the period.",
      );
    }
    const withPositions = vouchers.slice(0, MAX_AUDIT_POSITIONS);
    const positions = new Map<number, PositionsRead>();
    await mapLimited(withPositions, AUDIT_CONCURRENCY, async (voucher) => {
      const answer = await run.request("voucher positions", (signal) =>
        sevdesk.call(
          sevdesk.api.GET("/VoucherPos", {
            params: { query: { "voucher[id]": voucher.id, "voucher[objectName]": "Voucher" } },
            signal,
          }),
        ),
      );
      if (answer !== undefined) positions.set(voucher.id, mapPositions(answer.body, voucher.id));
    });

    // Countries only matter for the reverse charge check: expense vouchers
    // with a domestic rule and nothing but 0 % positions.
    const candidates = [
      ...new Set(
        vouchers
          .filter((v) => {
            const read = positions.get(v.id);
            return (
              v.creditDebit === "D" &&
              (v.taxRuleId === 9 || v.taxRuleId === 10) &&
              v.supplierId !== null &&
              read !== undefined &&
              read.positions.length > 0 &&
              read.positions.every((p) => p.taxRate === 0)
            );
          })
          .map((v) => v.supplierId as number),
      ),
    ];
    if (candidates.length > MAX_AUDIT_CONTACTS) {
      run.hit(
        "cap:contacts",
        `Only the first ${MAX_AUDIT_CONTACTS} of ${candidates.length} suppliers were looked up ` +
          "for their country (cap).",
      );
    }
    const countries = new Map<number, SupplierCountry>();
    await mapLimited(candidates.slice(0, MAX_AUDIT_CONTACTS), AUDIT_CONCURRENCY, async (id) => {
      const answer = await run.request("supplier contacts", (signal) =>
        sevdesk.call(
          sevdesk.api.GET("/Contact/{contactId}", {
            params: { path: { contactId: id }, query: { embed: "addresses" } },
            signal,
          }),
        ),
      );
      const raw = answer === undefined ? undefined : objectsOf(answer.body)[0];
      if (raw !== undefined) countries.set(id, countryOf(raw));
    });

    const all = sortFindings([
      ...vouchers.flatMap((voucher) =>
        checkVoucher({
          voucher,
          positions: positions.get(voucher.id),
          country: voucher.supplierId === null ? undefined : countries.get(voucher.supplierId),
          guidance,
        }),
      ),
      ...checkSupplierConsistency(vouchers),
    ]);
    const findingCounts = { high: 0, medium: 0, low: 0 };
    for (const f of all) findingCounts[f.severity]++;
    const selfAssessed = vouchers.filter(
      (v) => v.taxRuleId !== null && SELF_ASSESSED_RULES.has(v.taxRuleId),
    ).length;
    const shown = all.filter((f) => severityRank(f.severity) <= severityRank(args.minSeverity));
    const findings = shown.slice(args.offset, args.offset + args.limit);
    const page = pageOf(args.offset, args.limit, findings.length, shown.length);
    const truncated = run.truncated;
    return present(
      {
        period,
        bookkeepingVersion: version.version,
        checked: {
          vouchers: vouchers.length,
          positionsRead: positions.size,
          suppliersLookedUp: countries.size,
          guidanceRead: guidance !== undefined,
        },
        findingCounts,
        findings,
        page,
        disclaimer: HINT_DISCLAIMER,
        truncated,
        ...run.noteField([
          version.note,
          euroNote(vouchers),
          vouchers.length > 0 &&
            guidance === undefined &&
            "Booking accounts were not checked: sevdesk's tax guidance was not available.",
          selfAssessed > 0 &&
            `Tax amount checks were skipped for ${selfAssessed} vouchers with rule 8, 12, 13 or ` +
              "14: the spec does not say whether sevdesk shows the self-assessed tax in sumTax; " +
              "only net sums were compared.",
          vouchers.length === 0 && "No vouchers in the period.",
        ]),
      },
      {
        summary:
          `${vouchers.length} vouchers ${period.startDate} to ${period.endDate}: ` +
          `${findingCounts.high} high, ${findingCounts.medium} medium, ${findingCounts.low} low ` +
          `findings.${truncated ? " Incomplete, see note." : ""}`,
      },
    );
  },
});

// ---------------------------------------------------------------------------
// reverse_charge_report

const CATEGORY_MEANING: Readonly<Record<ReverseChargeKind, string>> = {
  nets_to_zero: "Tax owed by you and deducted as input tax in the same return (nets to zero).",
  payable: "Tax owed by you without input tax deduction (a real cost).",
  revenue: "Own sales where the customer owes the tax (field 60 of the VAT return).",
};

const REVERSE_CHARGE_RULES: Readonly<Record<ReverseChargeKind, number[]>> = {
  nets_to_zero: Object.values(TAX_RULES)
    .filter((r) => r.reverseCharge === "nets_to_zero")
    .map((r) => r.id),
  payable: Object.values(TAX_RULES)
    .filter((r) => r.reverseCharge === "payable")
    .map((r) => r.id),
  revenue: Object.values(TAX_RULES)
    .filter((r) => r.reverseCharge === "revenue")
    .map((r) => r.id),
};

const CATEGORIES = ["nets_to_zero", "payable", "revenue"] as const;

/** Invoice types counted as revenue: reminders repeat amounts, WKR are templates. */
export const REVENUE_INVOICE_TYPES: ReadonlySet<string> = new Set(["RE", "TR", "AR", "ER", "SR"]);

const categoryTotalSchema = z.object({
  category: z.enum(CATEGORIES),
  meaning: z.string(),
  taxRules: z.array(z.number().int()),
  documents: z.number().int(),
  net: z
    .number()
    .describe("Tax base in euro: sum of net amounts, cancellations and credit notes subtracted."),
  foreignCurrencyDocuments: z
    .number()
    .int()
    .describe("Documents in another currency; their euro amounts are included."),
});
type CategoryTotal = z.infer<typeof categoryTotalSchema>;

const reverseChargeDocumentSchema = z.object({
  category: z.enum(CATEGORIES),
  taxRuleId: z.number().int(),
  net: z.number().nullable().describe("Net in euro, negative for cancellations and credit notes."),
  document: documentRefSchema,
});

interface Classified {
  category: ReverseChargeKind;
  taxRuleId: number;
  net: number | null;
  document: DocumentRef;
}

/** Draft status per revenue document kind (invoice 100, credit note 100). */
const isRevenueDraft = (i: AuditInvoice) => i.status === 100;

export function classifyReverseCharge(
  vouchers: readonly AuditVoucher[],
  invoices: readonly AuditInvoice[],
  includeDrafts: boolean,
): Classified[] {
  const out: Classified[] = [];
  for (const v of vouchers) {
    if (!includeDrafts && v.status === 50) continue;
    const kind = v.taxRuleId === null ? undefined : TAX_RULES[v.taxRuleId]?.reverseCharge;
    if (kind === undefined) continue;
    // A rule from the wrong side is audit_vat's business, not a tax base.
    if ((kind === "revenue") !== (v.creditDebit === "C")) continue;
    out.push({
      category: kind,
      taxRuleId: v.taxRuleId as number,
      net: v.sumNet,
      document: voucherRef(v),
    });
  }
  for (const i of invoices) {
    if (!includeDrafts && isRevenueDraft(i)) continue;
    if (i.kind === "invoice" && i.status === 50) continue;
    if (i.invoiceType !== null && !REVENUE_INVOICE_TYPES.has(i.invoiceType)) continue;
    if (i.taxRuleId === null || TAX_RULES[i.taxRuleId]?.reverseCharge !== "revenue") continue;
    out.push({
      category: "revenue",
      taxRuleId: i.taxRuleId,
      net: signed(i.sumNet, revenueSign(i)),
      document: invoiceRef(i),
    });
  }
  return out.sort(
    (a, b) =>
      CATEGORIES.indexOf(a.category) - CATEGORIES.indexOf(b.category) ||
      (a.document.date ?? "").localeCompare(b.document.date ?? "") ||
      a.document.id - b.document.id,
  );
}

export function reverseChargeTotals(classified: readonly Classified[]): CategoryTotal[] {
  const totals = new Map<ReverseChargeKind, CategoryTotal>();
  for (const category of CATEGORIES) {
    totals.set(category, {
      category,
      meaning: CATEGORY_MEANING[category],
      taxRules: REVERSE_CHARGE_RULES[category],
      documents: 0,
      net: 0,
      foreignCurrencyDocuments: 0,
    });
  }
  for (const c of classified) {
    const entry = totals.get(c.category) as CategoryTotal;
    entry.documents++;
    entry.net = cents(entry.net + (c.net ?? 0));
    if (c.document.foreignCurrency !== null) entry.foreignCurrencyDocuments++;
  }
  return [...totals.values()];
}

/** Tax period caveat: documents are placed by their date, not by when the tax arises. */
export const DOCUMENT_DATE_NOTE =
  "Documents are assigned to the period by their document date, an approximation of the tax " +
  "period (delivery date and cash or accrual taxation can move them).";

export const reverseChargeReport = defineTool({
  name: "reverse_charge_report",
  title: "Report sevdesk reverse charge (13b) bases",
  description:
    "Sums the reverse charge tax base (section 13b UStG, bookkeeping 2.0) of a period in euro " +
    "from vouchers, invoices and credit notes, split into: nets_to_zero (expense rules 12 and " +
    "14, tax owed and deducted as input tax), payable (expense rule 13, tax owed without " +
    "deduction) and revenue (rule 5, own sales where the customer owes the tax; cancellation " +
    "invoices and credit notes subtracted). Returns totals and document counts per category, " +
    "plus the documents. Drafts, reminders and recurring templates are left out; intra-EU " +
    "acquisitions (rule 8) are not 13b and not included. Documents count by their date. " +
    "Figures to check, not tax advice. Refuses bookkeeping 1.0 accounts." +
    FOREIGN_DATA_NOTE,
  class: "R",
  operationId: "getVouchers",
  operations: ["bookkeepingSystemVersion", "getInvoices", "getCreditNotes"],
  inputSchema: z.object({
    ...periodInput,
    includeDrafts: z
      .boolean()
      .default(false)
      .describe("Also count draft vouchers, invoices and credit notes."),
    ...pageInput,
  }),
  outputSchema: z.object({
    period: periodSchema,
    bookkeepingVersion: z.string().nullable(),
    totals: z.array(categoryTotalSchema),
    documents: z.array(reverseChargeDocumentSchema),
    page: pageSchema,
    disclaimer: z.string(),
    ...auditFields,
  }),
  annotations: READ_ANNOTATIONS,
  async handler(args, call) {
    const period: Period = checkPeriod(args);
    const version = await requireBookkeeping2(call);
    const run = new AuditRun(call);
    const vouchers = await scanVouchers(run, period);
    const invoices = await scanInvoices(run, period);
    const creditNotes = await scanCreditNotes(run, period);
    const classified = classifyReverseCharge(
      vouchers,
      [...invoices, ...creditNotes],
      args.includeDrafts,
    );
    const totals = reverseChargeTotals(classified);
    const documents = classified.slice(args.offset, args.offset + args.limit);
    const page = pageOf(args.offset, args.limit, documents.length, classified.length);
    const net = (category: ReverseChargeKind) =>
      totals.find((t) => t.category === category)?.net ?? 0;
    const truncated = run.truncated;
    const revenueInvoices = invoices.filter(
      (i) => i.taxRuleId !== null && TAX_RULES[i.taxRuleId]?.reverseCharge === "revenue",
    );
    return present(
      {
        period,
        bookkeepingVersion: version.version,
        totals,
        documents,
        page,
        disclaimer: `${HINT_DISCLAIMER} ${DOCUMENT_DATE_NOTE}`,
        truncated,
        ...run.noteField([
          version.note,
          euroNote(vouchers),
          partialInvoiceNote(revenueInvoices),
          classified.length === 0 && "No reverse charge documents in the period.",
        ]),
      },
      {
        summary:
          `13b ${period.startDate} to ${period.endDate} (EUR net): nets to zero ${net("nets_to_zero")}, ` +
          `payable ${net("payable")}, own revenue ${net("revenue")}; ${classified.length} documents.` +
          `${truncated ? " Incomplete, see note." : ""}`,
      },
    );
  },
});
