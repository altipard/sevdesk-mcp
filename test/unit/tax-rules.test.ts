import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  BOOKKEEPING_1_MESSAGE,
  describeRule,
  EXPENSE_TAX_RULES,
  REVENUE_TAX_RULES,
  sideOfCreditDebit,
  TAX_RULES,
  VOUCHER_REVENUE_TAX_RULES,
  VOUCHER_TAX_RULE_IDS,
  vatPrefix,
} from "../../src/tools/tax-rules.js";
import * as writeCommon from "../../src/tools/write-common.js";

const spec = JSON.parse(
  readFileSync(new URL("../../src/generated/sevdesk.openapi.json", import.meta.url), "utf8"),
) as { info: { description: string } };

/** Rule ID -> allowed rates from the "VAT rules ... (Revenue|Expense)" tables of the spec. */
function specRules(side: "Revenue" | "Expense"): Map<number, number[] | null> {
  const description = spec.info.description.replace(/\r/g, "");
  const rules = new Map<number, number[] | null>();
  let index = description.indexOf(`sevdesk-Update 2.0 (${side})`);
  expect(index).toBeGreaterThanOrEqual(0);
  while (index >= 0) {
    const table = description.slice(index, description.indexOf("</table>", index));
    for (const row of table.split("</tr>")) {
      const id = /'taxRule': (\d+)/.exec(row)?.[1];
      if (id === undefined) continue;
      const cells = row.split(/<\/td>/).map((cell) => cell.replace(/<[^>]+>/g, " ").trim());
      const rateCell = cells[2] ?? "";
      rules.set(
        Number(id),
        rateCell.includes("depending on country")
          ? null
          : [...rateCell.matchAll(/(\d+)\.0/g)].map((m) => Number(m[1])),
      );
    }
    index = description.indexOf(`sevdesk-Update 2.0 (${side})`, index + 1);
  }
  return rules;
}

describe("tax rule table", () => {
  it("matches the revenue and expense tables of the spec", () => {
    for (const [side, table] of [
      ["Revenue", REVENUE_TAX_RULES],
      ["Expense", EXPENSE_TAX_RULES],
    ] as const) {
      const fromSpec = specRules(side);
      expect([...fromSpec.keys()].sort((a, b) => a - b)).toEqual(
        Object.keys(table)
          .map(Number)
          .sort((a, b) => a - b),
      );
      for (const [id, rates] of fromSpec) expect(table[id]?.rates, `rule ${id}`).toEqual(rates);
    }
  });

  it("gives every rule a side matching its table, an ASCII meaning and its own ID", () => {
    for (const [id, rule] of Object.entries(TAX_RULES)) {
      expect(rule.id).toBe(Number(id));
      expect(rule.meaning).toMatch(/^[\x20-\x7e]+$/);
      expect(rule.side === "revenue" ? REVENUE_TAX_RULES : EXPENSE_TAX_RULES).toHaveProperty(id);
    }
  });

  it("marks the 13b rules by kind and nothing else", () => {
    const kinds = Object.fromEntries(
      Object.values(TAX_RULES)
        .filter((rule) => rule.reverseCharge)
        .map((rule) => [rule.id, rule.reverseCharge]),
    );
    expect(kinds).toEqual({ 5: "revenue", 12: "nets_to_zero", 13: "payable", 14: "nets_to_zero" });
  });

  it("keeps OSS and 18b rules off vouchers", () => {
    expect(Object.keys(VOUCHER_REVENUE_TAX_RULES).map(Number)).toEqual([1, 2, 3, 4, 5, 11, 17]);
    expect(VOUCHER_TAX_RULE_IDS).toEqual([1, 2, 3, 4, 5, 8, 9, 10, 11, 12, 13, 14, 17]);
  });

  it("is what write-common re-exports, so the write tools check the same table", () => {
    expect(writeCommon.REVENUE_TAX_RULES).toBe(REVENUE_TAX_RULES);
    expect(writeCommon.EXPENSE_TAX_RULES).toBe(EXPENSE_TAX_RULES);
    expect(writeCommon.VOUCHER_TAX_RULE_IDS).toBe(VOUCHER_TAX_RULE_IDS);
  });

  it("helpers", () => {
    expect(sideOfCreditDebit("D")).toBe("expense");
    expect(sideOfCreditDebit("C")).toBe("revenue");
    expect(sideOfCreditDebit(null)).toBeNull();
    expect(describeRule(9)).toBe("tax rule 9 (domestic expenses with input tax deduction)");
    expect(describeRule(99)).toBe("tax rule 99 (unknown to this server)");
    expect(describeRule(null)).toBe("no tax rule");
    expect(vatPrefix("ie 123 4567X")).toBe("IE");
    expect(vatPrefix("123")).toBeNull();
    expect(vatPrefix(null)).toBeNull();
    expect(BOOKKEEPING_1_MESSAGE).toContain("bookkeeping 2.0");
  });
});
