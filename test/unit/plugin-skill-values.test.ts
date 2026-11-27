import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { DEFAULT_CONFIRM_TTL_SECONDS, loadConfig } from "../../src/config.js";
import { IDEMPOTENCY_TTL_MS } from "../../src/policy/guard.js";
import type { ToolDefinition } from "../../src/policy/registry.js";
import { SCOPES } from "../../src/policy/rights.js";
import { MAX_CONTACTS_SCANNED, MAX_EMAILS_SCANNED } from "../../src/tools/contacts.js";
import { MAX_FILE_BYTES } from "../../src/tools/documents.js";
import {
  CONTACT_STATUS,
  CREDIT_NOTE_STATUS,
  INVOICE_STATUS,
  INVOICE_TYPE,
  ORDER_STATUS,
  ORDER_TYPE,
  TRANSACTION_STATUS,
  VOUCHER_STATUS,
} from "../../src/tools/format.js";
import { TOOLS } from "../../src/tools/index.js";
import { RECEIVABLES_DEADLINE_MS } from "../../src/tools/invoices.js";
import { MAX_VOUCHER_FILE_BYTES } from "../../src/tools/voucher-writes.js";
import { MAX_VOUCHER_POSITIONS } from "../../src/tools/vouchers.js";
import {
  defaultTaxText,
  EXPENSE_TAX_RULES,
  OVERPAYING_PAYMENT_TYPES,
  PAYMENT_TYPES,
  positionInput,
  REVENUE_TAX_RULES,
  SETTLING_PAYMENT_TYPES,
  type TaxRuleInfo,
  VOUCHER_REVENUE_TAX_RULES,
} from "../../src/tools/write-common.js";

// Checks the values the skill states (status codes, tax rules, payment
// types, tool classes, limits, parameter names) against the server code,
// so the skill cannot drift from what the tools actually do.

const skillDir = fileURLToPath(new URL("../../plugins/sevdesk/skills/sevdesk/", import.meta.url));
const read = (file: string) => readFileSync(join(skillDir, file), "utf8");
const skill = read("SKILL.md");
const tools = read("references/tools.md");
const workflows = read("references/workflows.md");
const accounting = read("references/accounting.md");
const all = [skill, tools, workflows, accounting].join("\n");

const MIB = 1024 * 1024;

/** Text from a heading line up to the next heading of the same or a higher level. */
function section(markdown: string, heading: string): string {
  const lines = markdown.split("\n");
  const start = lines.findIndex((line) => line.trim() === heading);
  if (start < 0) throw new Error(`heading not found: ${heading}`);
  const level = heading.indexOf(" ");
  const end = lines.findIndex(
    (line, index) => index > start && /^#+ /.test(line) && line.indexOf(" ") <= level,
  );
  return lines.slice(start + 1, end < 0 ? undefined : end).join("\n");
}

/** Body rows of the Markdown tables in `text`, as trimmed cells. */
function rows(text: string): string[][] {
  return text
    .split("\n")
    .filter((line) => line.startsWith("|") && !/^\|\s*-/.test(line))
    .map((line) =>
      line
        .split("|")
        .slice(1, -1)
        .map((cell) => cell.trim()),
    )
    .filter(
      (cells) => !["Tool", "Document", "Rule", "Type", "Mode", "Task"].includes(cells[0] ?? ""),
    );
}

/** The table that directly follows the line `start`. */
function tableAfter(text: string, start: string): string {
  const index = text.indexOf(start);
  if (index < 0) throw new Error(`text not found: ${start}`);
  const lines = text
    .slice(index + start.length)
    .split("\n")
    .map((line) => line.trim());
  const first = lines.findIndex((line) => line.startsWith("|"));
  const table = lines.slice(first);
  const stop = table.findIndex((line) => !line.startsWith("|"));
  return table.slice(0, stop < 0 ? undefined : stop).join("\n");
}

const backticked = (text: string) => [...text.matchAll(/`([a-z_]+)`/g)].map((m) => m[1] ?? "");

/** "50 draft, 100 open" pairs as code to snake_case name. */
function statusPairs(text: string): Record<number, string> {
  const pairs: Record<number, string> = {};
  for (const [, code, name] of text.matchAll(/(\d+) ([a-z]+(?: [a-z]+)*)/g)) {
    pairs[Number(code)] = (name ?? "").replaceAll(" ", "_");
  }
  return pairs;
}

const tool = (name: string): ToolDefinition => {
  const found = TOOLS.find((definition) => definition.name === name);
  if (!found) throw new Error(`unknown tool ${name}`);
  return found;
};

/** Enum values of a tool input, through optional() and default(). */
function enumValues(name: string, key: string): string[] {
  // biome-ignore lint/suspicious/noExplicitAny: walks zod wrappers generically
  let schema: any = tool(name).inputSchema.shape[key];
  while (schema && !Array.isArray(schema.options)) schema = schema.unwrap?.();
  if (!schema) throw new Error(`${name}.${key} is not an enum`);
  return [...schema.options].map(String);
}

const sorted = (values: Iterable<string | number>) => [...values].map(String).sort();
const namesOfClass = (...classes: string[]) =>
  sorted(TOOLS.filter((definition) => classes.includes(definition.class)).map((d) => d.name));

describe("skill values match the server", () => {
  it("status codes", () => {
    const table: Record<string, Readonly<Record<number, string>>> = {
      Invoice: INVOICE_STATUS,
      "Credit note": CREDIT_NOTE_STATUS,
      "Order (estimate, confirmation)": ORDER_STATUS,
      Voucher: VOUCHER_STATUS,
      "Bank transaction": TRANSACTION_STATUS,
      Contact: CONTACT_STATUS,
    };
    const found = rows(section(accounting, "## Status codes"));
    expect(sorted(found.map(([label]) => label ?? ""))).toEqual(sorted(Object.keys(table)));
    for (const [label, codes] of found) {
      expect(statusPairs(codes ?? ""), label).toEqual({ ...table[label ?? ""] });
    }
    // The short summary in SKILL.md.
    const summary = /Invoice status: ([^.]+)\. Voucher\s+status:\s+([^.]+)\./.exec(skill);
    expect(summary).not.toBeNull();
    expect(statusPairs(summary?.[1] ?? "")).toEqual(
      Object.fromEntries(Object.entries(INVOICE_STATUS).filter(([code]) => code !== "50")),
    );
    expect(statusPairs(summary?.[2] ?? "")).toEqual({ ...VOUCHER_STATUS });
  });

  it("status names the search tools accept", () => {
    const listed = (row: string) =>
      sorted(
        (/Status names: ([^|]+)/.exec(row)?.[1] ?? "")
          .replaceAll("`", "")
          .split(",")
          .map((name) => name.trim()),
      );
    const row = (name: string) =>
      tools.split("\n").find((line) => line.startsWith(`| \`${name}\``));
    expect(listed(row("search_invoices") ?? "")).toEqual(
      sorted(enumValues("search_invoices", "status")),
    );
    expect(listed(row("search_vouchers") ?? "")).toEqual(
      sorted(enumValues("search_vouchers", "status")),
    );
  });

  it("invoice and order types", () => {
    const codes = (label: string) =>
      sorted(
        [
          ...(new RegExp(`${label}: ([^.]+)\\.`).exec(accounting)?.[1] ?? "").matchAll(
            /\b([A-Z]{2,3})\b/g,
          ),
        ].map((m) => m[1] ?? ""),
      );
    expect(codes("Invoice types")).toEqual(sorted(Object.keys(INVOICE_TYPE)));
    expect(codes("Order types")).toEqual(sorted(Object.keys(ORDER_TYPE)));
  });

  it("tax rules and their rates", () => {
    const parse = (text: string) =>
      rows(text).flatMap(([ids, meaning, rates]) =>
        (ids ?? "").split(",").map((id) => ({
          id: Number(id),
          meaning: meaning ?? "",
          rates:
            rates === "per country"
              ? null
              : (rates ?? "")
                  .replace("%", "")
                  .split(",")
                  .map((rate) => Number(rate.trim())),
        })),
      );
    const expectRules = (
      parsed: ReturnType<typeof parse>,
      rules: Readonly<Record<number, TaxRuleInfo>>,
    ) => {
      expect(sorted(parsed.map((rule) => rule.id))).toEqual(sorted(Object.keys(rules)));
      for (const rule of parsed)
        expect(rule.rates, `rule ${rule.id}`).toEqual(rules[rule.id]?.rates);
    };

    const income = parse(tableAfter(accounting, "Invoices and income vouchers (C):"));
    expectRules(income, REVENUE_TAX_RULES);
    for (const rule of income) {
      const invoicesOnly = !(rule.id in VOUCHER_REVENUE_TAX_RULES);
      expect(rule.meaning.includes("invoices only"), `rule ${rule.id}`).toBe(invoicesOnly);
    }
    expectRules(parse(tableAfter(accounting, "Expense vouchers (D):")), EXPENSE_TAX_RULES);

    expect(REVENUE_TAX_RULES[11]?.rates).toEqual([0]);
    expect(skill).toMatch(/Kleinunternehmer, §19 UStG\) use tax rule 11 with 0 %/);
    expect(accounting).toContain(`"${defaultTaxText(1)}" for rule 1`);
    expect(accounting).toContain(`"${defaultTaxText(11)}"`);
  });

  it("payment types", () => {
    const table = rows(section(accounting, "## Payment types for bookings"));
    expect(sorted(table.map(([type]) => type ?? ""))).toEqual(sorted(PAYMENT_TYPES));
    expect(
      sorted(table.filter(([, when]) => when?.includes("settles")).map(([type]) => type ?? "")),
    ).toEqual(sorted(SETTLING_PAYMENT_TYPES));
    const overpaying = /Overpayments are only accepted as ([A-Z]+) or ([A-Z]+)\./.exec(accounting);
    expect(sorted(overpaying?.slice(1) ?? [])).toEqual(sorted(OVERPAYING_PAYMENT_TYPES));
    for (const name of ["book_invoice_payment", "book_voucher_payment"]) {
      expect(sorted(enumValues(name, "paymentType"))).toEqual(sorted(PAYMENT_TYPES));
    }
  });

  it("tool classes in the tool reference", () => {
    const named = (heading: string) => rows(section(tools, heading));
    for (const [cell] of named("## Read (mode read and up)")) {
      const [name] = backticked(cell ?? "");
      if (name === "sevdesk_api_request") continue; // registered separately, class per operation
      expect(tool(name ?? "").class, name).toBe("R");
    }
    for (const [cell, operationClass] of named("## Write (mode write and up)")) {
      const [name] = backticked(cell ?? "");
      expect(tool(name ?? "").class, name).toBe(operationClass);
    }
    const irreversible = named("## Irreversible (mode full, plus SEVDESK_ENABLE_TOOLS)").map(
      ([cell]) => backticked(cell ?? "")[0] ?? "",
    );
    expect(sorted(irreversible)).toEqual(namesOfClass("X"));
  });

  it("tool groups in SKILL.md", () => {
    const fullRow = skill.split("\n").find((line) => line.startsWith("| full |")) ?? "";
    expect(sorted(backticked(fullRow))).toEqual(namesOfClass("X"));

    const flow = section(skill, "## Confirmation flow (W+ and X tools)").split("\n\n")[0] ?? "";
    expect(sorted(backticked(flow))).toEqual(namesOfClass("W+", "X"));

    const creates = /\*\*Creates are not idempotent\.\*\*([\s\S]*?)\n\d\./.exec(skill)?.[1] ?? "";
    expect(sorted(backticked(creates))).toEqual(
      sorted(TOOLS.filter((d) => d.name.startsWith("create_")).map((d) => d.name)),
    );
    for (const name of backticked(creates)) expect(tool(name).class).toBe("W");
  });

  it("limits and time windows", () => {
    expect(DEFAULT_CONFIRM_TTL_SECONDS % 60).toBe(0);
    const minutes = DEFAULT_CONFIRM_TTL_SECONDS / 60;
    expect(skill).toContain(`expiry (${minutes} minutes by`);
    expect(accounting).toContain(`expire after ${minutes}\n  minutes by default`);

    const hours = IDEMPOTENCY_TTL_MS / 3_600_000;
    expect(skill).toContain(`within ${hours} hours`);
    expect(accounting).toContain(`within ${hours} hours`);
    expect(tools).toContain(`once per target in ${hours} hours`);

    expect(MAX_EMAILS_SCANNED).toBe(MAX_CONTACTS_SCANNED);
    expect(tools).toContain(`checks at most ${MAX_CONTACTS_SCANNED} contacts`);
    expect(workflows).toContain(`stops after ${MAX_CONTACTS_SCANNED} contacts`);
    expect(tools).toContain(`stops after ${RECEIVABLES_DEADLINE_MS / 1000} s`);
    expect(tools).toContain(`files over ${MAX_FILE_BYTES / MIB} MiB are refused`);
    expect(tools).toContain(`PDF, PNG or JPEG up to ${MAX_VOUCHER_FILE_BYTES / MIB} MiB`);
    expect(tools).toContain(`At most ${MAX_VOUCHER_POSITIONS} positions`);
  });

  it("modes, defaults and scopes", () => {
    expect(loadConfig({ SEVDESK_API_TOKEN: "abc" }).mode).toBe("read");
    expect(skill).toContain("plugin settings (default read)");
    for (const scope of Object.values(SCOPES)) expect(skill).toContain(scope);
  });

  it("parameter names and their values", () => {
    const params: Record<string, readonly string[]> = {
      get_invoice: ["positionsOffset"],
      list_open_receivables: ["overdueOnly"],
      search_orders: ["orderType"],
      create_voucher: ["creditDebit", "supplierId", "supplierName", "file", "amountsAre"],
      create_invoice_from_order: ["partialType", "amountType", "amount"],
      mark_invoice_sent: ["sendType"],
      send_invoice_email: ["sendXml"],
      book_invoice_payment: ["paymentType", "checkAccountId", "checkAccountTransactionId"],
      book_voucher_payment: ["paymentType", "checkAccountId"],
      get_tax_guidance: ["scope"],
    };
    for (const [name, keys] of Object.entries(params)) {
      for (const key of keys) {
        expect(Object.keys(tool(name).inputSchema.shape), `${name}.${key}`).toContain(key);
        expect(all, `${key} is not mentioned`).toMatch(new RegExp(`\\b${key}\\b`));
      }
    }
    expect(Object.keys(positionInput.shape)).toContain("priceNet");
    expect(skill).toContain("(priceNet)");

    const segment = (text: string, start: string) =>
      (text.split(start)[1] ?? "").split(/[;|]/)[0] ?? "";
    const codes = (text: string) =>
      sorted([...text.matchAll(/\b([A-Z]{1,4})\b/g)].map((m) => m[1] ?? ""));
    expect(codes(segment(tools, "sendType "))).toEqual(
      sorted(enumValues("mark_invoice_sent", "sendType")),
    );
    expect(codes(segment(tools, "partialType "))).toEqual(
      sorted(enumValues("create_invoice_from_order", "partialType")),
    );
    expect(codes(segment(tools, "creditDebit "))).toEqual(
      sorted(enumValues("create_voucher", "creditDebit")),
    );
    const scopes = segment(tools, "Scopes ")
      .replaceAll("`", "")
      .split(",")
      .map((scope) => scope.trim());
    expect(sorted(scopes)).toEqual(sorted(enumValues("get_tax_guidance", "scope")));
  });
});
