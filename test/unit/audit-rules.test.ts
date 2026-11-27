import { describe, expect, it } from "vitest";
import { SevdeskError } from "../../src/sevdesk/errors.js";
import {
  type AuditInvoice,
  type AuditTransaction,
  type AuditVoucher,
  checkPeriod,
  euroNote,
  mapAuditVoucher,
  mapLimited,
  signNote,
} from "../../src/tools/audit-common.js";
import {
  billedMonths,
  findDuplicates,
  findGaps,
  hasDocumentNumber,
  monthsBefore,
  type Summable,
  summarize,
} from "../../src/tools/audit-documents.js";
import {
  checkSupplierConsistency,
  checkVoucher,
  classifyReverseCharge,
  countryOf,
  coverageNote,
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
    foreignCurrency: null,
    sumNet: 100,
    sumTax: 0,
    sumGross: 100,
    euroUnconfirmed: false,
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

describe("voucher euro amounts", () => {
  const raw = (overrides: Record<string, unknown>) => ({
    id: "1",
    currency: "USD",
    status: "100",
    sumNet: "110",
    sumTax: "0",
    sumGross: "110",
    ...overrides,
  });

  it("reads the accounting sums as euro when sevdesk sends them", () => {
    const v = mapAuditVoucher(
      raw({ sumNetAccounting: "100", sumTaxAccounting: "0", sumGrossAccounting: "100" }),
    );
    expect(v).toMatchObject({
      sumNet: 100,
      sumGross: 100,
      foreignCurrency: "USD",
      euroUnconfirmed: false,
    });
    expect(euroNote([v])).toBeUndefined();
  });

  it("falls back to sumNet and marks the euro amount of a foreign voucher unconfirmed", () => {
    const v = mapAuditVoucher(raw({}));
    expect(v).toMatchObject({ sumNet: 110, sumGross: 110, euroUnconfirmed: true });
    expect(euroNote([v])).toContain("1 voucher(s)");
    // A euro voucher without accounting sums is fine.
    expect(mapAuditVoucher(raw({ currency: "EUR" })).euroUnconfirmed).toBe(false);
  });

  it("keeps sumNet etc. for a euro voucher whatever its accounting sums say", () => {
    // The spec's own example: sumNet 100 next to sumNetAccounting 0.
    const v = mapAuditVoucher(
      raw({
        currency: "EUR",
        sumNetAccounting: "0",
        sumTaxAccounting: "0",
        sumGrossAccounting: "0",
      }),
    );
    expect(v).toMatchObject({ sumNet: 110, sumTax: 0, sumGross: 110, euroUnconfirmed: false });
    const other = mapAuditVoucher(
      raw({ currency: null, sumNetAccounting: "90", sumGrossAccounting: "90" }),
    );
    expect(other).toMatchObject({ sumNet: 110, sumGross: 110, foreignCurrency: null });
  });

  it("derives the euro tax when a foreign voucher has accounting net and gross only", () => {
    // sumTax 21 is in USD; euro net 100 and gross 119 leave a euro tax of 19.
    const v = mapAuditVoucher(
      raw({
        sumNet: "110",
        sumTax: "21",
        sumGross: "131",
        sumNetAccounting: "100",
        sumTaxAccounting: null,
        sumGrossAccounting: "119",
      }),
    );
    expect(v).toMatchObject({ sumNet: 100, sumTax: 19, sumGross: 119, euroUnconfirmed: false });
    expect(checkVoucher({ voucher: v }).map((f) => f.code)).not.toContain("NET_PLUS_TAX_NOT_GROSS");
  });

  it("falls back for a foreign voucher whose accounting sums are 0, not for a tax of 0", () => {
    const zero = mapAuditVoucher(
      raw({ sumNetAccounting: "0", sumTaxAccounting: "0", sumGrossAccounting: "0" }),
    );
    expect(zero).toMatchObject({ sumNet: 110, sumGross: 110, euroUnconfirmed: true });
    expect(euroNote([zero])).toContain("missing or 0");
    // A voucher of 0 in every field is no reason to doubt the accounting sums.
    expect(
      mapAuditVoucher(
        raw({
          sumNet: "0",
          sumGross: "0",
          sumNetAccounting: "0",
          sumTaxAccounting: "0",
          sumGrossAccounting: "0",
        }),
      ).euroUnconfirmed,
    ).toBe(false);
  });
});

describe("audit_vat coverage note", () => {
  const full = {
    vouchers: 10,
    positionsRead: 10,
    suppliers: 2,
    countriesRead: 2,
    reverseChargeUnchecked: 0,
  };

  it("is absent when everything was read", () => {
    expect(coverageNote(full)).toBeUndefined();
  });

  it("names the numbers and the unchecked reverse charge cases", () => {
    const note = coverageNote({
      ...full,
      positionsRead: 7,
      countriesRead: 1,
      reverseChargeUnchecked: 3,
    });
    expect(note).toContain("Positions were read for 7 of 10 vouchers");
    expect(note).toContain("supplier countries for 1 of 2 suppliers");
    expect(note).toContain("not done for 3 expense voucher(s) with rule 9 or 10 and no tax");
    expect(coverageNote({ ...full, countriesRead: 1 })).not.toContain("not done");
  });
});

describe("sign note", () => {
  const doc = (kind: "invoice" | "credit_note", invoiceType: string | null) => ({
    kind,
    invoiceType,
  });

  it("appears only when cancellations or credit notes are in the sums", () => {
    expect(signNote([doc("invoice", "RE"), doc("invoice", null)])).toBeUndefined();
    expect(signNote([doc("invoice", "SR")])).toBe(
      "1 cancellation invoice(s) (SR) are subtracted in the sums, whatever sign sevdesk stores " +
        "(the API does not document it); check them if a total looks off.",
    );
    expect(
      signNote([doc("invoice", "SR"), doc("credit_note", null), doc("credit_note", null)]),
    ).toContain("1 cancellation invoice(s) (SR) and 2 credit note(s) are subtracted");
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

  it("suggests 12 or 13 for a supplier outside the EU, low for rule 10", () => {
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
    expect(ten).toMatchObject({ severity: "low", code: "FOREIGN_SUPPLIER_DOMESTIC_RULE" });
  });

  it("names all candidates neutrally without a usable VAT ID, 8 or 12/13 for XI", () => {
    const [unknown] = checkVoucher({
      voucher: voucher(),
      positions: zeroPositions,
      country: { foreign: true, region: "unknown" },
    });
    expect(unknown?.suggestedTaxRules).toEqual([14, 8, 12, 13]);
    expect(unknown?.suggestion).toContain("missing or unclear");
    const [xi] = checkVoucher({
      voucher: voucher(),
      positions: zeroPositions,
      country: { foreign: true, region: "xi" },
    });
    expect(xi?.suggestedTaxRules).toEqual([8, 12, 13]);
    expect(xi?.suggestion).toContain("goods only");
  });

  it("does not treat a foreign address with a German VAT ID as EU-foreign", () => {
    expect(
      checkVoucher({
        voucher: voucher(),
        positions: zeroPositions,
        country: { foreign: true, region: "de_vat" },
      }),
    ).toEqual([]);
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
    const [finding] = checkVoucher({ voucher: voucher({ foreignCurrency: "USD" }) });
    expect(finding).toMatchObject({ severity: "low", code: "FOREIGN_CURRENCY" });
    expect(finding?.detail).toContain("Document currency USD");
    expect(finding?.document.amount).toBe(100);
    expect(finding?.document.foreignCurrency).toBe("USD");
  });

  it("skips tax amount checks for self-assessed rules and compares net only", () => {
    // 13b voucher where sevdesk may show 19 % self-assessed tax: no sum findings.
    const rc = voucher({ taxRuleId: 12, sumNet: 100, sumTax: 19, sumGross: 100 });
    const positions = {
      partial: false,
      positions: [{ accountDatevId: 6815, taxRate: 0, sumNet: 100, sumTax: 19, sumGross: 119 }],
    };
    expect(checkVoucher({ voucher: rc, positions })).toEqual([]);
    expect(
      codes(
        checkVoucher({
          voucher: voucher({ taxRuleId: 14, sumNet: 200, sumTax: 0, sumGross: 200 }),
          positions,
        }),
      ),
    ).toEqual(["POSITIONS_DIFFER_FROM_HEADER"]);
    // The same amounts under rule 9 are findings.
    expect(
      codes(checkVoucher({ voucher: voucher({ sumNet: 100, sumTax: 19, sumGross: 100 }) })),
    ).toEqual(["NET_PLUS_TAX_NOT_GROSS"]);
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

describe("supplier country", () => {
  const addr = (countryId: number) => ({
    country: { id: String(countryId) },
    category: { id: "47" },
  });
  it("reads the address country and the VAT ID prefix", () => {
    expect(countryOf({ addresses: [addr(1)], vatNumber: "DE123" })).toEqual({
      foreign: false,
      region: "de_vat",
    });
    expect(countryOf({ addresses: [addr(13)], vatNumber: "IE123" })).toEqual({
      foreign: true,
      region: "eu",
    });
    // Foreign address, German VAT ID: not an EU-foreign business.
    expect(countryOf({ addresses: [addr(13)], vatNumber: "DE123" })).toEqual({
      foreign: true,
      region: "de_vat",
    });
    expect(countryOf({ addresses: [addr(13)], vatNumber: "XI123" }).region).toBe("xi");
    expect(countryOf({ addresses: [addr(13)], vatNumber: "CHE-1" }).region).toBe("non_eu");
    expect(countryOf({ addresses: [addr(13)], vatNumber: null })).toEqual({
      foreign: true,
      region: "unknown",
    });
    expect(countryOf({ vatNumber: "FR12" })).toEqual({ foreign: true, region: "eu" });
    expect(countryOf({})).toEqual({ foreign: null, region: "unknown" });
  });
});

describe("reverse charge", () => {
  const invoice = (overrides: Partial<AuditInvoice> = {}): AuditInvoice => ({
    kind: "invoice",
    id: 50,
    date: "2026-03-05",
    invoiceNumber: "RE-50",
    invoiceType: "RE",
    contactId: 9,
    contactName: "Kunde GmbH",
    status: 200,
    foreignCurrency: null,
    foreignGross: null,
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
        invoice({ id: 54, foreignCurrency: "USD", foreignGross: 12, sumNet: 10 }),
        invoice({ id: 55, invoiceType: "SR", sumNet: 300 }),
        invoice({ id: 56, invoiceType: "SR", sumNet: -300 }),
        invoice({ id: 57, kind: "credit_note", invoiceType: null, sumNet: 100 }),
        invoice({ id: 58, kind: "credit_note", invoiceType: null, status: 100, sumNet: 5 }),
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
      "revenue:invoice:55",
      "revenue:invoice:56",
      "revenue:credit_note:57",
      "revenue:voucher:6",
    ]);
    // Cancellations and credit notes reduce, whatever sign sevdesk stores.
    expect(classified.filter((c) => c.net !== null && c.net < 0).map((c) => c.net)).toEqual([
      -20, -300, -300, -100,
    ]);
    const totals = reverseChargeTotals(classified);
    expect(totals).toContainEqual(
      expect.objectContaining({
        category: "nets_to_zero",
        documents: 3,
        net: 130.5,
        taxRules: [12, 14],
      }),
    );
    expect(totals).toContainEqual(
      expect.objectContaining({ category: "payable", documents: 1, net: 30, taxRules: [13] }),
    );
    expect(totals).toContainEqual(
      expect.objectContaining({
        category: "revenue",
        documents: 6,
        net: 1000 + 10 - 300 - 300 - 100 + 200,
        foreignCurrencyDocuments: 1,
      }),
    );
    expect(totals).toHaveLength(3);
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

  it("finds the same number and amount per supplier, not across suppliers or sides", () => {
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
        voucher({ id: 4, description: "X-9", date: "2026-03-01", sumGross: 50 }),
        voucher({ id: 5, description: "X-9", date: "2026-03-02", sumGross: 50 }),
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

  it("treats text without a digit as no number, and the same number with other amounts as low", () => {
    const findings = findDuplicates(
      [
        voucher({ id: 1, description: "Miete", date: "2026-01-01", sumGross: 900 }),
        voucher({ id: 2, description: "Miete", date: "2026-02-01", sumGross: 900 }),
        voucher({ id: 3, description: "R-77", date: "2026-02-01", sumGross: 10 }),
        voucher({ id: 4, description: "R-77", date: "2026-03-20", sumGross: 12 }),
      ],
      options,
    );
    expect(findings).toEqual([expect.objectContaining({ severity: "low", code: "SAME_NUMBER" })]);
    expect(findings[0]?.documents.map((d) => d.id)).toEqual([3, 4]);
    // Free text never reaches the detail.
    expect(findings[0]?.detail).not.toContain("R-77");
  });

  it("does not take a bare year for a number, and needs 90 days for high", () => {
    expect(hasDocumentNumber("miete 2026")).toBe(false);
    expect(hasDocumentNumber("inv-2026-001")).toBe(true);
    expect(hasDocumentNumber("r 12345")).toBe(true);
    const yearOnly = findDuplicates(
      [
        voucher({ id: 1, description: "Miete 2026", date: "2026-01-01", sumGross: 900 }),
        voucher({ id: 2, description: "Miete 2026", date: "2026-02-01", sumGross: 900 }),
      ],
      options,
    );
    expect(yearOnly).toEqual([]);
    const far = findDuplicates(
      [
        voucher({ id: 1, description: "R-1", date: "2025-03-01", sumGross: 50 }),
        voucher({ id: 2, description: "R-1", date: "2026-03-01", sumGross: 50 }),
      ],
      options,
    );
    expect(far).toEqual([expect.objectContaining({ severity: "low", code: "SAME_NUMBER" })]);
    const near = findDuplicates(
      [
        voucher({ id: 1, description: "R-1", date: "2026-01-01", sumGross: 50 }),
        voucher({ id: 2, description: "R-1", date: "2026-03-31", sumGross: 50 }),
      ],
      options,
    );
    expect(near).toEqual([expect.objectContaining({ severity: "high", code: "SAME_NUMBER" })]);
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
        foreignCurrency: null,
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

  it("does not see a gap when month-end billing drifts into the next month", () => {
    const dates = ["2026-01-31", "2026-03-01", "2026-03-31", "2026-04-30", "2026-05-31"];
    const vouchers = dates.map((date, i) => voucher({ id: 200 + i, date }));
    const { gaps, detected } = findGaps(
      vouchers,
      { startDate: "2026-01-01", endDate: "2026-05-31" },
      { minMonths: 3, today: "2026-06-15" },
    );
    expect(detected).toBe(1);
    expect(gaps).toEqual([]);
    expect(billedMonths(["2026-01-31", "2026-03-01"]).size).toBe(3);
    // A single early voucher without a month-end one before it stays in its month.
    expect(billedMonths(["2026-01-15", "2026-03-02"]).size).toBe(2);
  });

  it("keeps the own month when month-end billing drifts (30.01., 01.03., 01.04., 01.05.)", () => {
    const dates = ["2026-01-30", "2026-03-01", "2026-04-01", "2026-05-01"];
    expect([...billedMonths(dates)].map((m) => `${Math.floor(m / 12)}-${(m % 12) + 1}`)).toEqual([
      "2026-1",
      "2026-3",
      "2026-4",
      "2026-5",
      "2026-2",
    ]);
    const { gaps } = findGaps(
      dates.map((date, i) => voucher({ id: 300 + i, date })),
      { startDate: "2026-01-01", endDate: "2026-05-31" },
      { minMonths: 3, today: "2026-06-15" },
    );
    expect(gaps).toEqual([]);
    // The original case: 31.01., then 01.03. covers February and March.
    expect(billedMonths(["2026-01-31", "2026-03-01"]).size).toBe(3);
  });

  it("monthsBefore", () => {
    expect(monthsBefore("2026-03-15", 6)).toBe("2025-09-01");
    expect(monthsBefore("2026-01-31", 0)).toBe("2026-01-01");
    expect(monthsBefore("2026-01-31", 1)).toBe("2025-12-01");
  });
});

describe("summarize", () => {
  const doc = (overrides: Partial<Summable> = {}): Summable => ({
    date: "2026-04-10",
    statusName: "paid",
    contactKey: "9",
    contactName: "Kunde GmbH",
    creditDebit: null,
    foreign: false,
    net: 100,
    tax: 19,
    gross: 119,
    ...overrides,
  });

  it("groups by month in euro with totals; negative documents reduce", () => {
    const result = summarize(
      [
        doc(),
        doc({ date: "2026-04-20", net: -50, tax: -9.5, gross: -59.5 }),
        doc({ date: "2026-05-01" }),
        doc({ foreign: true }),
        doc({ date: null, tax: null }),
      ],
      "month",
    );
    const row = (
      group: string,
      count: number,
      net: number,
      tax: number,
      gross: number,
      foreign = 0,
    ) => ({
      group,
      label: null,
      creditDebit: null,
      count,
      net,
      tax,
      gross,
      foreignCurrencyDocuments: foreign,
    });
    expect(result.groups).toEqual([
      row("2026-04", 3, 150, 28.5, 178.5, 1),
      row("2026-05", 1, 100, 19, 119),
      row("unknown", 1, 100, 19, 119),
    ]);
    expect(result.totals).toEqual([
      {
        creditDebit: null,
        count: 5,
        net: 350,
        tax: 66.5,
        gross: 416.5,
        foreignCurrencyDocuments: 1,
      },
    ]);
  });

  it("never mixes income and expense vouchers", () => {
    const result = summarize(
      [doc({ creditDebit: "C", gross: 500 }), doc({ creditDebit: "D", gross: 200 })],
      "month",
    );
    expect(result.groups.map((g) => [g.group, g.creditDebit, g.gross])).toEqual([
      ["2026-04", "C", 500],
      ["2026-04", "D", 200],
    ]);
    expect(result.totals.map((t) => [t.creditDebit, t.gross])).toEqual([
      ["C", 500],
      ["D", 200],
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
      foreignCurrency: null,
      foreignAmount: null,
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

  it("treats amounts within one cent as equal despite float noise", () => {
    expect(reconcile([tx({ amount: -100.01 })], [doc()], 14).matches).toHaveLength(1);
    expect(reconcile([tx({ amount: -100.02 })], [doc()], 14).matches).toHaveLength(0);
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
