import { describe, expect, it } from "vitest";
import { SevdeskError } from "../../src/sevdesk/errors.js";
import {
  type AuditInvoice,
  type AuditTransaction,
  type AuditVoucher,
  checkPeriod,
  mapLimited,
} from "../../src/tools/audit-common.js";
import {
  findDuplicates,
  findGaps,
  monthsBefore,
  summarize,
} from "../../src/tools/audit-documents.js";
import {
  checkSupplierConsistency,
  checkVoucher,
  classifyReverseCharge,
  reverseChargeTotals,
} from "../../src/tools/audit-vat.js";
import { agingBucketOf } from "../../src/tools/invoices.js";
import { type OpenDocument, reconcile } from "../../src/tools/reconcile.js";

function voucher(overrides: Partial<AuditVoucher> = {}): AuditVoucher {
  return {
    id: 1,
    date: "2026-03-10",
    description: "INV-1",
    supplierId: 7,
    supplierName: "Cloud Ltd",
    status: 100,
    creditDebit: "D",
    currency: "EUR",
    sumNet: 100,
    sumTax: 0,
    sumGross: 100,
    openAmount: 100,
    taxRuleId: 9,
    hasDocument: true,
    ...overrides,
  };
}

const zeroPositions = {
  partial: false,
  positions: [{ accountDatevId: 6815, taxRate: 0, sumNet: 100, sumTax: 0, sumGross: 100 }],
};

const codes = (findings: Array<{ code: string }>) => findings.map((f) => f.code).sort();

describe("checkPeriod", () => {
  it("rejects a reversed period as bad input", () => {
    expect(() => checkPeriod({ startDate: "2026-03-31", endDate: "2026-03-01" })).toThrow(
      SevdeskError,
    );
    expect(checkPeriod({ startDate: "2026-03-01", endDate: "2026-03-01" })).toEqual({
      startDate: "2026-03-01",
      endDate: "2026-03-01",
    });
  });
});

describe("mapLimited", () => {
  it("keeps the order and never runs more than the limit at once", async () => {
    let running = 0;
    let peak = 0;
    const out = await mapLimited([5, 1, 3, 2, 4], 2, async (n) => {
      running++;
      peak = Math.max(peak, running);
      await new Promise((resolve) => setTimeout(resolve, n));
      running--;
      return n * 10;
    });
    expect(out).toEqual([50, 10, 30, 20, 40]);
    expect(peak).toBe(2);
    expect(await mapLimited([], 2, async () => 1)).toEqual([]);
  });
});

describe("audit_vat rules", () => {
  it("flags a foreign EU supplier with rule 9 and 0 % as likely reverse charge (high)", () => {
    const [finding] = checkVoucher({
      voucher: voucher(),
      positions: zeroPositions,
      country: { foreign: true, region: "eu" },
    });
    expect(finding).toMatchObject({
      severity: "high",
      code: "FOREIGN_SUPPLIER_DOMESTIC_RULE",
      suggestedTaxRules: [14, 8],
      document: { type: "voucher", id: 1, contactName: "Cloud Ltd", amount: 100 },
    });
    expect(finding?.suggestion).toContain("Steuerberater");
  });

  it("suggests 12 or 13 for a supplier outside the EU, medium for rule 10", () => {
    const [nonEu] = checkVoucher({
      voucher: voucher(),
      positions: zeroPositions,
      country: { foreign: true, region: "non_eu" },
    });
    expect(nonEu?.suggestedTaxRules).toEqual([12, 13]);
    const [ten] = checkVoucher({
      voucher: voucher({ taxRuleId: 10 }),
      positions: zeroPositions,
      country: { foreign: true, region: "unknown" },
    });
    expect(ten).toMatchObject({ severity: "medium", code: "FOREIGN_SUPPLIER_DOMESTIC_RULE" });
  });

  it("does not flag a German supplier, or a foreign one charging VAT", () => {
    expect(
      checkVoucher({
        voucher: voucher(),
        positions: zeroPositions,
        country: { foreign: false, region: "eu" },
      }),
    ).toEqual([]);
    const taxed = {
      partial: false,
      positions: [{ accountDatevId: 6815, taxRate: 19, sumNet: 100, sumTax: 19, sumGross: 119 }],
    };
    expect(
      checkVoucher({
        voucher: voucher({ sumTax: 19, sumGross: 119 }),
        positions: taxed,
        country: { foreign: true, region: "eu" },
      }),
    ).toEqual([]);
  });

  it("reports an unknown country as low only when the supplier is a contact", () => {
    const unknown = checkVoucher({
      voucher: voucher(),
      positions: zeroPositions,
      country: { foreign: null, region: "unknown" },
    });
    expect(codes(unknown)).toEqual(["SUPPLIER_COUNTRY_UNKNOWN"]);
    // No contact at all (typed supplier name): nothing to look up, nothing reported.
    expect(
      checkVoucher({ voucher: voucher({ supplierId: null }), positions: zeroPositions }),
    ).toEqual([]);
  });

  it("flags rules from the wrong side", () => {
    const expense = checkVoucher({ voucher: voucher({ taxRuleId: 1 }) });
    expect(expense[0]).toMatchObject({ severity: "high", code: "WRONG_SIDE_TAX_RULE" });
    const revenue = checkVoucher({
      voucher: voucher({ creditDebit: "C", taxRuleId: 12 }),
    });
    expect(revenue[0]).toMatchObject({ code: "WRONG_SIDE_TAX_RULE", suggestedTaxRules: [1] });
  });

  it("flags missing, unknown and invoice-only rules", () => {
    expect(checkVoucher({ voucher: voucher({ taxRuleId: null }) })[0]).toMatchObject({
      severity: "medium",
      code: "MISSING_TAX_RULE",
    });
    expect(checkVoucher({ voucher: voucher({ taxRuleId: null, status: 50 }) })[0]?.severity).toBe(
      "low",
    );
    expect(codes(checkVoucher({ voucher: voucher({ taxRuleId: 99 }) }))).toEqual([
      "UNKNOWN_TAX_RULE",
    ]);
    expect(codes(checkVoucher({ voucher: voucher({ creditDebit: "C", taxRuleId: 19 }) }))).toEqual([
      "RULE_NOT_FOR_VOUCHERS",
    ]);
  });

  it("flags a rate the rule does not allow", () => {
    const findings = checkVoucher({
      voucher: voucher({ taxRuleId: 12, sumTax: 19, sumGross: 119 }),
      positions: {
        partial: false,
        positions: [{ accountDatevId: 6815, taxRate: 19, sumNet: 100, sumTax: 19, sumGross: 119 }],
      },
    });
    expect(findings).toContainEqual(
      expect.objectContaining({ severity: "high", code: "RATE_CONTRADICTS_RULE" }),
    );
  });

  it("checks accounts against the tax guidance", () => {
    const guidance = new Map([
      [6815, new Map<number, Set<number> | null>([[9, new Set([19])]])],
      [4400, new Map<number, Set<number> | null>([[1, new Set([19])]])],
    ]);
    const rateOff = checkVoucher({ voucher: voucher(), positions: zeroPositions, guidance });
    expect(codes(rateOff)).toEqual(["RATE_NOT_ALLOWED_FOR_ACCOUNT"]);

    const ruleOff = checkVoucher({
      voucher: voucher({ taxRuleId: 10 }),
      positions: zeroPositions,
      guidance,
    });
    expect(ruleOff.find((f) => f.code === "RULE_NOT_ALLOWED_FOR_ACCOUNT")).toMatchObject({
      severity: "medium",
      suggestedTaxRules: [9],
    });

    const unknownAccount = checkVoucher({
      voucher: voucher(),
      positions: {
        partial: false,
        positions: [{ accountDatevId: 1, taxRate: 0, sumNet: 100, sumTax: 0, sumGross: 100 }],
      },
      guidance,
    });
    expect(codes(unknownAccount)).toEqual(["ACCOUNT_NOT_IN_GUIDANCE"]);
  });

  it("checks sums with rounding tolerance", () => {
    expect(
      checkVoucher({ voucher: voucher({ sumNet: 100, sumTax: 19, sumGross: 119.01 }) }),
    ).toEqual([]);
    expect(
      codes(checkVoucher({ voucher: voucher({ sumNet: 100, sumTax: 19, sumGross: 120 }) })),
    ).toEqual(["NET_PLUS_TAX_NOT_GROSS"]);

    const header = checkVoucher({
      voucher: voucher({ sumNet: 200, sumGross: 200 }),
      positions: zeroPositions,
    });
    expect(codes(header)).toEqual(["POSITIONS_DIFFER_FROM_HEADER"]);

    const broken = checkVoucher({
      voucher: voucher({ sumTax: 19, sumGross: 119 }),
      positions: {
        partial: false,
        positions: [{ accountDatevId: 6815, taxRate: 19, sumNet: 100, sumTax: 15, sumGross: 119 }],
      },
    });
    expect(codes(broken)).toEqual(["POSITION_SUM_MISMATCH", "TAX_AMOUNT_DIFFERS_FROM_RATE"]);
  });

  it("does not compare position sums when the positions may be cut", () => {
    expect(
      checkVoucher({
        voucher: voucher({ sumNet: 999, sumGross: 999, sumTax: 0 }),
        positions: { ...zeroPositions, partial: true },
      }),
    ).toEqual([]);
  });

  it("handles credit notes with negative amounts", () => {
    const credit = voucher({ sumNet: -100, sumTax: -19, sumGross: -119 });
    expect(
      checkVoucher({
        voucher: credit,
        positions: {
          partial: false,
          positions: [
            { accountDatevId: 6815, taxRate: 19, sumNet: -100, sumTax: -19, sumGross: -119 },
          ],
        },
      }),
    ).toEqual([]);
  });

  it("flags foreign currency as low", () => {
    expect(codes(checkVoucher({ voucher: voucher({ currency: "USD" }) }))).toEqual([
      "FOREIGN_CURRENCY",
    ]);
  });

  it("finds suppliers booked with different rules, per supplier once", () => {
    const findings = checkSupplierConsistency([
      voucher({ id: 1, taxRuleId: 9 }),
      voucher({ id: 2, taxRuleId: 9, date: "2026-03-20" }),
      voucher({ id: 3, taxRuleId: 14, date: "2026-03-15" }),
      voucher({ id: 4, supplierId: 8, taxRuleId: 9 }),
      voucher({ id: 5, supplierId: null, supplierName: null, taxRuleId: 13 }),
      voucher({ id: 6, creditDebit: "C", taxRuleId: 1 }),
    ]);
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({
      severity: "low",
      code: "INCONSISTENT_SUPPLIER_TAX_RULES",
      document: { id: 2 },
    });
    expect(findings[0]?.detail).toContain("rule 9: 2 (IDs 1, 2); rule 14: 1 (IDs 3)");
  });
});

describe("reverse charge", () => {
  const invoice = (overrides: Partial<AuditInvoice> = {}): AuditInvoice => ({
    id: 50,
    date: "2026-03-05",
    invoiceNumber: "RE-50",
    invoiceType: "RE",
    contactId: 9,
    contactName: "Kunde GmbH",
    status: 200,
    currency: "EUR",
    sumNet: 1000,
    sumTax: 0,
    sumGross: 1000,
    openAmount: 1000,
    taxRuleId: 5,
    ...overrides,
  });

  it("splits bases into nets to zero, payable and revenue with totals", () => {
    const classified = classifyReverseCharge(
      [
        voucher({ id: 1, taxRuleId: 12, sumNet: 100 }),
        voucher({ id: 2, taxRuleId: 14, sumNet: 50.5 }),
        voucher({ id: 3, taxRuleId: 13, sumNet: 30 }),
        voucher({ id: 4, taxRuleId: 9, sumNet: 999 }),
        voucher({ id: 5, taxRuleId: 12, sumNet: 10, status: 50 }),
        voucher({ id: 6, taxRuleId: 5, creditDebit: "C", sumNet: 200 }),
        voucher({ id: 7, taxRuleId: 5, creditDebit: "D", sumNet: 1 }),
        voucher({ id: 8, taxRuleId: 12, sumNet: -20 }),
      ],
      [
        invoice(),
        invoice({ id: 51, invoiceType: "MA" }),
        invoice({ id: 52, status: 100 }),
        invoice({ id: 53, taxRuleId: 1 }),
        invoice({ id: 54, currency: "USD", sumNet: 10 }),
      ],
      false,
    );
    expect(classified.map((c) => `${c.category}:${c.document.type}:${c.document.id}`)).toEqual([
      "nets_to_zero:voucher:1",
      "nets_to_zero:voucher:2",
      "nets_to_zero:voucher:8",
      "payable:voucher:3",
      "revenue:invoice:50",
      "revenue:invoice:54",
      "revenue:voucher:6",
    ]);
    const totals = reverseChargeTotals(classified);
    expect(totals).toContainEqual(
      expect.objectContaining({
        category: "nets_to_zero",
        currency: "EUR",
        documents: 3,
        net: 130.5,
        taxRules: [12, 14],
      }),
    );
    expect(totals).toContainEqual(
      expect.objectContaining({ category: "payable", documents: 1, net: 30, taxRules: [13] }),
    );
    expect(totals).toContainEqual(
      expect.objectContaining({ category: "revenue", currency: "EUR", documents: 2, net: 1200 }),
    );
    expect(totals).toContainEqual(
      expect.objectContaining({ category: "revenue", currency: "USD", documents: 1, net: 10 }),
    );
    expect(classifyReverseCharge([voucher({ taxRuleId: 12, status: 50 })], [], true)).toHaveLength(
      1,
    );
  });

  it("lists every category with zero for an empty period", () => {
    expect(reverseChargeTotals([])).toEqual([
      expect.objectContaining({ category: "nets_to_zero", documents: 0, net: 0 }),
      expect.objectContaining({ category: "payable", documents: 0, net: 0 }),
      expect.objectContaining({ category: "revenue", documents: 0, net: 0 }),
    ]);
  });
});

describe("duplicates", () => {
  const options = { windowDays: 7, draftAgeDays: 30, today: "2026-04-30" };

  it("finds the same number per supplier, not across suppliers or sides", () => {
    const findings = findDuplicates(
      [
        voucher({ id: 1, description: "INV-1" }),
        voucher({ id: 2, description: " inv-1 ", date: "2026-03-25" }),
        voucher({ id: 3, description: "INV-1", supplierId: 8 }),
        voucher({ id: 4, description: "INV-1", creditDebit: "C" }),
      ],
      options,
    );
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({ severity: "high", code: "SAME_NUMBER" });
    expect(findings[0]?.documents.map((d) => d.id)).toEqual([1, 2]);
  });

  it("finds the same amount within the window once, not when already numbered alike", () => {
    const findings = findDuplicates(
      [
        voucher({ id: 1, description: "A", date: "2026-03-01" }),
        voucher({ id: 2, description: "B", date: "2026-03-05" }),
        voucher({ id: 3, description: "C", date: "2026-04-01" }),
        voucher({ id: 4, description: "X", date: "2026-03-01", sumGross: 50 }),
        voucher({ id: 5, description: "X", date: "2026-03-02", sumGross: 50 }),
        voucher({ id: 6, description: "Z", date: "2026-03-01", sumGross: 0 }),
        voucher({ id: 7, description: "Y", date: "2026-03-01", sumGross: 0 }),
      ],
      options,
    );
    expect(findings.map((f) => `${f.code}:${f.documents.map((d) => d.id).join(",")}`)).toEqual([
      "SAME_NUMBER:4,5",
      "SAME_AMOUNT_NEAR_DATE:1,2",
    ]);
  });

  it("lists drafts older than draftAgeDays", () => {
    const findings = findDuplicates(
      [
        voucher({ id: 1, status: 50, date: "2026-03-01", description: "a" }),
        voucher({ id: 2, status: 50, date: "2026-04-20", description: "b" }),
        voucher({ id: 3, status: 50, date: null, description: "c" }),
      ],
      options,
    );
    expect(findings).toEqual([
      expect.objectContaining({
        severity: "low",
        code: "OLD_DRAFT",
        detail: expect.stringContaining("60 days"),
      }),
    ]);
  });

  it("returns nothing for an empty period", () => {
    expect(findDuplicates([], options)).toEqual([]);
  });
});

describe("subscription gaps", () => {
  const monthly = (months: string[], overrides: Partial<AuditVoucher> = {}) =>
    months.map((month, i) =>
      voucher({ id: 100 + i, date: `${month}-03`, sumGross: 29.99, ...overrides }),
    );

  it("finds missing months of a monthly supplier in the period", () => {
    const vouchers = monthly(["2025-12", "2026-01", "2026-02", "2026-04", "2026-06"]);
    const { gaps, detected } = findGaps(
      vouchers,
      { startDate: "2026-01-01", endDate: "2026-06-30" },
      { minMonths: 3, today: "2026-07-15" },
    );
    expect(detected).toBe(1);
    expect(gaps).toEqual([
      expect.objectContaining({
        supplierId: 7,
        monthsSeen: 5,
        firstSeen: "2025-12",
        lastSeen: "2026-06",
        typicalAmount: 29.99,
        currency: "EUR",
        missingMonths: ["2026-03", "2026-05"],
        possiblyEnded: false,
      }),
    ]);
  });

  it("never reports the current month, marks a likely end, ignores irregular suppliers", () => {
    const ended = monthly(["2026-01", "2026-02", "2026-03"]);
    const quarterly = monthly(["2025-10", "2026-01", "2026-04"], { supplierId: 8 });
    const { gaps, detected } = findGaps(
      [...ended, ...quarterly],
      { startDate: "2026-01-01", endDate: "2026-12-31" },
      { minMonths: 3, today: "2026-06-10" },
    );
    expect(detected).toBe(1);
    expect(gaps[0]).toMatchObject({ missingMonths: ["2026-04", "2026-05"], possiblyEnded: true });
  });

  it("needs minMonths months and a supplier", () => {
    expect(
      findGaps(
        monthly(["2026-01", "2026-03"]),
        { startDate: "2026-01-01", endDate: "2026-03-31" },
        { minMonths: 3, today: "2026-05-01" },
      ).detected,
    ).toBe(0);
    expect(
      findGaps(
        monthly(["2026-01", "2026-02", "2026-03"], { supplierId: null, supplierName: null }),
        { startDate: "2026-01-01", endDate: "2026-03-31" },
        { minMonths: 3, today: "2026-05-01" },
      ).detected,
    ).toBe(0);
  });

  it("monthsBefore", () => {
    expect(monthsBefore("2026-03-15", 6)).toBe("2025-09-01");
    expect(monthsBefore("2026-01-31", 0)).toBe("2026-01-01");
    expect(monthsBefore("2026-01-31", 1)).toBe("2025-12-01");
  });
});

describe("summarize", () => {
  const doc = (overrides: Record<string, unknown> = {}) => ({
    date: "2026-04-10",
    statusName: "paid",
    contactKey: "9",
    contactName: "Kunde GmbH",
    currency: "EUR",
    net: 100,
    tax: 19,
    gross: 119,
    ...overrides,
  });

  it("groups by month per currency with totals; credit notes reduce", () => {
    const result = summarize(
      [
        doc(),
        doc({ date: "2026-04-20", net: -50, tax: -9.5, gross: -59.5 }),
        doc({ date: "2026-05-01" }),
        doc({ currency: "USD" }),
        doc({ date: null, tax: null }),
      ],
      "month",
    );
    expect(result.groups).toEqual([
      { group: "2026-04", label: null, currency: "EUR", count: 2, net: 50, tax: 9.5, gross: 59.5 },
      { group: "2026-04", label: null, currency: "USD", count: 1, net: 100, tax: 19, gross: 119 },
      { group: "2026-05", label: null, currency: "EUR", count: 1, net: 100, tax: 19, gross: 119 },
      { group: "unknown", label: null, currency: "EUR", count: 1, net: 100, tax: 19, gross: 119 },
    ]);
    expect(result.totals).toEqual([
      { currency: "EUR", count: 4, net: 250, tax: 47.5, gross: 297.5 },
      { currency: "USD", count: 1, net: 100, tax: 19, gross: 119 },
    ]);
  });

  it("groups by contact, largest first, and by status", () => {
    const docs = [doc(), doc({ contactKey: "10", contactName: "Big AG", gross: 1000 })];
    expect(summarize(docs, "contact").groups.map((g) => [g.group, g.label])).toEqual([
      ["10", "Big AG"],
      ["9", "Kunde GmbH"],
    ]);
    expect(summarize(docs, "status").groups).toEqual([
      expect.objectContaining({ group: "paid", count: 2, gross: 1119 }),
    ]);
    expect(summarize([], "month")).toEqual({ groups: [], totals: [] });
  });
});

describe("reconcile", () => {
  const tx = (overrides: Partial<AuditTransaction> = {}): AuditTransaction => ({
    id: 900,
    date: "2026-03-12",
    amount: -100,
    purpose: "Payment INV-1 Cloud Ltd",
    payeePayerName: "Cloud Ltd",
    checkAccountId: 1,
    status: 100,
    ...overrides,
  });
  const doc = (overrides: Partial<OpenDocument> = {}): OpenDocument => ({
    ref: {
      type: "voucher",
      id: 1,
      date: "2026-03-10",
      number: "INV-1",
      contactId: 7,
      contactName: "Cloud Ltd",
      amount: 100,
      currency: "EUR",
    },
    direction: -1,
    amount: 100,
    date: "2026-03-10",
    ...overrides,
  });

  it("matches by amount, direction and window with confidence", () => {
    const result = reconcile(
      [
        tx(),
        tx({ id: 901, amount: 250, purpose: "x", payeePayerName: "Somebody" }),
        tx({ id: 902, amount: -42, purpose: "card", payeePayerName: "Shop" }),
      ],
      [
        doc(),
        doc({
          ref: { ...doc().ref, id: 2, type: "invoice", number: "RE-2", contactName: "Kunde" },
          direction: 1,
          amount: 250,
          date: "2026-03-01",
        }),
        doc({ ref: { ...doc().ref, id: 3, number: "Q" }, amount: 77 }),
      ],
      14,
    );
    expect(result.matches.map((m) => [m.transaction.id, m.document.id, m.confidence])).toEqual([
      [900, 1, "high"],
      [901, 2, "low"],
    ]);
    expect(result.matches[0]?.reasons).toContain("document number in the payment reference");
    expect(result.unmatchedTransactions.map((t) => t.id)).toEqual([902]);
    expect(result.unmatchedDocuments.map((d) => d.ref.id)).toEqual([3]);
  });

  it("never matches the wrong direction or outside the window, and uses each side once", () => {
    const result = reconcile(
      [tx({ amount: 100 }), tx({ id: 901, date: "2026-05-30" }), tx({ id: 902 }), tx({ id: 903 })],
      [doc()],
      14,
    );
    expect(result.matches.map((m) => m.transaction.id)).toEqual([902]);
    expect(result.unmatchedTransactions.map((t) => t.id)).toEqual([900, 901, 903]);
  });

  it("rates a name match within a week high, a close date medium", () => {
    const named = reconcile([tx({ purpose: "monthly" })], [doc()], 14);
    expect(named.matches[0]?.confidence).toBe("high");
    const close = reconcile(
      [tx({ purpose: "monthly", payeePayerName: "XY" })],
      [doc({ date: "2026-03-11" })],
      14,
    );
    expect(close.matches[0]?.confidence).toBe("medium");
    expect(reconcile([], [], 14)).toEqual({
      matches: [],
      unmatchedTransactions: [],
      unmatchedDocuments: [],
    });
  });
});

describe("aging buckets", () => {
  it("buckets by days overdue", () => {
    expect(agingBucketOf(false, 0)).toBe("not_due");
    expect(agingBucketOf(true, 1)).toBe("0-30");
    expect(agingBucketOf(true, 30)).toBe("0-30");
    expect(agingBucketOf(true, 31)).toBe("31-60");
    expect(agingBucketOf(true, 60)).toBe("31-60");
    expect(agingBucketOf(true, 61)).toBe("61-90");
    expect(agingBucketOf(true, 90)).toBe("61-90");
    expect(agingBucketOf(true, 91)).toBe("over_90");
  });
});
