/**
 * sevdesk tax rules (bookkeeping 2.0, the `taxRule` of invoices, vouchers
 * and credit notes), from the "Tax Rules" section of the spec
 * (src/generated/sevdesk.openapi.json, info.description). The one place for
 * tax rule knowledge: the write tools check against it, the audit tools
 * read side, rates and reverse charge kind from it.
 *
 * Bookkeeping 1.0 accounts use the deprecated taxType instead; the audit
 * tools refuse them (see BOOKKEEPING_1_MESSAGE) rather than mapping taxType,
 * because taxType has no expense-side reverse charge distinction.
 */

export interface TaxRuleInfo {
  readonly name: string;
  /** Allowed position tax rates; null where they depend on the country (OSS). */
  readonly rates: readonly number[] | null;
}

/** revenue: invoices and credit (C) vouchers; expense: debit (D) vouchers. */
export type TaxSide = "revenue" | "expense";

/**
 * Reverse charge kind for the 13b report:
 * - nets_to_zero: tax owed and deducted as input tax in the same return;
 * - payable: tax owed without input tax deduction;
 * - revenue: own sale where the customer owes the tax.
 */
export type ReverseChargeKind = "nets_to_zero" | "payable" | "revenue";

export interface TaxRule extends TaxRuleInfo {
  readonly id: number;
  readonly side: TaxSide;
  /** Plain English meaning, ASCII only (tool descriptions and summaries). */
  readonly meaning: string;
  /** Usable on vouchers; 18-21 are documented as invoices only. */
  readonly vouchers: boolean;
  /** Only for rules under section 13b UStG. */
  readonly reverseCharge?: ReverseChargeKind;
}

export const TAX_RULES: Readonly<Record<number, TaxRule>> = {
  1: {
    id: 1,
    side: "revenue",
    name: "Umsatzsteuerpflichtige Umsätze",
    meaning: "domestic taxable sales",
    rates: [0, 7, 19],
    vouchers: true,
  },
  2: { id: 2, side: "revenue", name: "Ausfuhren", meaning: "exports", rates: [0], vouchers: true },
  3: {
    id: 3,
    side: "revenue",
    name: "Innergemeinschaftliche Lieferungen",
    meaning: "intra-EU deliveries",
    rates: [0, 7, 19],
    vouchers: true,
  },
  4: {
    id: 4,
    side: "revenue",
    name: "Steuerfreie Umsätze §4 UStG",
    meaning: "tax-exempt sales (section 4 UStG)",
    rates: [0],
    vouchers: true,
  },
  5: {
    id: 5,
    side: "revenue",
    name: "Reverse Charge gem. §13b UStG",
    meaning: "own sales under reverse charge, the customer owes the tax (section 13b UStG)",
    rates: [0],
    vouchers: true,
    reverseCharge: "revenue",
  },
  11: {
    id: 11,
    side: "revenue",
    name: "Steuer nicht erhoben nach §19 UStG (Kleinunternehmer)",
    meaning: "small business, no VAT charged (section 19 UStG)",
    rates: [0],
    vouchers: true,
  },
  17: {
    id: 17,
    side: "revenue",
    name: "Nicht im Inland steuerbare Leistung",
    meaning: "service not taxable in Germany",
    rates: [0],
    vouchers: true,
  },
  18: {
    id: 18,
    side: "revenue",
    name: "One Stop Shop (Waren)",
    meaning: "One Stop Shop, goods",
    rates: null,
    vouchers: false,
  },
  19: {
    id: 19,
    side: "revenue",
    name: "One Stop Shop (elektronische Dienstleistungen)",
    meaning: "One Stop Shop, electronic services",
    rates: null,
    vouchers: false,
  },
  20: {
    id: 20,
    side: "revenue",
    name: "One Stop Shop (sonstige Dienstleistungen)",
    meaning: "One Stop Shop, other services",
    rates: null,
    vouchers: false,
  },
  21: {
    id: 21,
    side: "revenue",
    name: "Reverse Charge gem. §18b UStG",
    meaning: "reverse charge reported under section 18b UStG",
    rates: [0],
    vouchers: false,
  },
  8: {
    id: 8,
    side: "expense",
    name: "Innergemeinschaftliche Erwerbe",
    meaning: "intra-EU acquisition of goods",
    rates: [0, 7, 19],
    vouchers: true,
  },
  9: {
    id: 9,
    side: "expense",
    name: "Vorsteuerabziehbare Aufwendungen",
    meaning: "domestic expenses with input tax deduction",
    rates: [0, 7, 19],
    vouchers: true,
  },
  10: {
    id: 10,
    side: "expense",
    name: "Nicht vorsteuerabziehbare Aufwendungen",
    meaning: "expenses without input tax deduction",
    rates: [0],
    vouchers: true,
  },
  12: {
    id: 12,
    side: "expense",
    name: "Reverse Charge gem. §13b Abs. 2 UStG mit Vorsteuerabzug",
    meaning: "reverse charge (section 13b (2) UStG) with input tax deduction",
    rates: [0],
    vouchers: true,
    reverseCharge: "nets_to_zero",
  },
  13: {
    id: 13,
    side: "expense",
    name: "Reverse Charge gem. §13b UStG ohne Vorsteuerabzug",
    meaning: "reverse charge (section 13b UStG) without input tax deduction",
    rates: [0],
    vouchers: true,
    reverseCharge: "payable",
  },
  14: {
    id: 14,
    side: "expense",
    name: "Reverse Charge gem. §13b Abs. 1 EU Umsätze",
    meaning: "reverse charge for services from EU businesses (section 13b (1) UStG)",
    rates: [0],
    vouchers: true,
    reverseCharge: "nets_to_zero",
  },
};

const infoOf = (rule: TaxRule): TaxRuleInfo => ({ name: rule.name, rates: rule.rates });

function table(filter: (rule: TaxRule) => boolean): Readonly<Record<number, TaxRuleInfo>> {
  return Object.fromEntries(
    Object.values(TAX_RULES)
      .filter(filter)
      .map((rule) => [rule.id, infoOf(rule)]),
  );
}

/** Revenue tax rules (invoices, credit vouchers). */
export const REVENUE_TAX_RULES = table((rule) => rule.side === "revenue");

export const REVENUE_TAX_RULE_IDS = Object.keys(REVENUE_TAX_RULES).map(Number);

/** Expense tax rules (sevdesk-Update 2.0) for debit vouchers. */
export const EXPENSE_TAX_RULES = table((rule) => rule.side === "expense");

/** Revenue tax rules a credit voucher may use; 18-21 are documented as not for vouchers. */
export const VOUCHER_REVENUE_TAX_RULES = table((rule) => rule.side === "revenue" && rule.vouchers);

export const VOUCHER_TAX_RULE_IDS = [
  ...Object.keys(EXPENSE_TAX_RULES),
  ...Object.keys(VOUCHER_REVENUE_TAX_RULES),
]
  .map(Number)
  .sort((a, b) => a - b);

/** Rate names of the ReceiptGuidance answers. */
export const GUIDANCE_RATES: Readonly<Record<string, number>> = {
  ZERO: 0,
  FIVE: 5,
  SEVEN: 7,
  SIXTEEN: 16,
  NINETEEN: 19,
};

/** Side of a voucher's tax rule: D vouchers are expenses, C vouchers revenue. */
export function sideOfCreditDebit(creditDebit: string | null): TaxSide | null {
  if (creditDebit === "D") return "expense";
  if (creditDebit === "C") return "revenue";
  return null;
}

/** "tax rule 9 (domestic expenses with input tax deduction)". */
export function describeRule(id: number | null): string {
  if (id === null) return "no tax rule";
  const rule = TAX_RULES[id];
  return `tax rule ${id} (${rule?.meaning ?? "unknown to this server"})`;
}

export const BOOKKEEPING_1_MESSAGE =
  "This check needs sevdesk bookkeeping 2.0 (taxRule). The account uses bookkeeping 1.0, " +
  "whose taxType cannot be mapped reliably (e.g. no expense-side 13b distinction); " +
  "check the tax rules in sevdesk or with the Steuerberater.";

/** EU member states as VAT ID prefixes (Greece is EL, Northern Ireland XI for goods). */
export const EU_VAT_PREFIXES: ReadonlySet<string> = new Set([
  "AT",
  "BE",
  "BG",
  "CY",
  "CZ",
  "DE",
  "DK",
  "EE",
  "EL",
  "ES",
  "FI",
  "FR",
  "HR",
  "HU",
  "IE",
  "IT",
  "LT",
  "LU",
  "LV",
  "MT",
  "NL",
  "PL",
  "PT",
  "RO",
  "SE",
  "SI",
  "SK",
  "XI",
]);

/** Country prefix of a VAT ID like "IE 1234567X", or null for anything else. */
export function vatPrefix(vatNumber: string | null): string | null {
  const match = /^([A-Z]{2})/.exec((vatNumber ?? "").replace(/\s+/g, "").toUpperCase());
  return match ? (match[1] as string) : null;
}
