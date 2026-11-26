import { describe, expect, it } from "vitest";
import {
  MAX_SUMMARY_LENGTH,
  MAX_TOOL_RESPONSE_CHARS,
  okResult,
  present,
} from "../../src/tools/result.js";

describe("okResult", () => {
  it("keeps the summary on one line, so the JSON is always line 2", () => {
    const data = present({ a: 1 }, { summary: `first\n\nsecond\r\n\tthird ${"x".repeat(400)}` });
    const [content] = okResult(data).content as Array<{ text: string }>;
    const lines = content?.text.split("\n") ?? [];
    expect(lines).toHaveLength(2);
    expect(lines[0]?.startsWith("first second third x")).toBe(true);
    expect(lines[0]?.length).toBe(MAX_SUMMARY_LENGTH);
    expect(JSON.parse(lines[1] ?? "")).toEqual({ a: 1 });
  });

  it("returns plain JSON without a summary", () => {
    expect(okResult({ a: 1 }).content).toEqual([{ type: "text", text: '{"a":1}' }]);
  });
});

describe("okResult size budget", () => {
  const entry = (i: number) => ({ id: i, text: "x".repeat(2000) });
  const entries = (count: number) => Array.from({ length: count }, (_, i) => entry(i));
  const textOf = (result: ReturnType<typeof okResult>) =>
    (result.content[0] as { text: string }).text;

  it("leaves answers within the budget untouched", () => {
    const data = { items: entries(10), truncated: false };
    const result = okResult(data);
    expect(result.structuredContent).toBe(data);
    expect(JSON.parse(textOf(result))).toEqual(data);
  });

  it("cuts the list, marks the answer and keeps summary line and JSON valid", () => {
    const data = present(
      {
        items: entries(100),
        page: { offset: 0, limit: 100, count: 100, total: 250, hasMore: true },
        truncated: false,
        note: "Earlier note.",
      },
      { summary: "100 of 250 items (offset 0, more available)." },
    );
    const result = okResult(data);
    const text = textOf(result);
    expect(text.length).toBeLessThanOrEqual(MAX_TOOL_RESPONSE_CHARS);
    const lines = text.split("\n");
    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain("cut to fit");
    expect(lines[0]).toContain("100 of 250 items");
    const json = JSON.parse(lines[1] ?? "") as typeof data;
    expect(json).toEqual(result.structuredContent);
    expect(json.items.length).toBeGreaterThan(0);
    expect(json.items.length).toBeLessThan(100);
    expect(json.truncated).toBe(true);
    expect(json.note.startsWith("Earlier note. Answer cut")).toBe(true);
    expect(json.page).toMatchObject({ count: json.items.length, hasMore: true, total: 250 });
    expect(json.items.map((i) => i.id)).toEqual(json.items.map((_, i) => i));
  });

  it("cuts the largest list first and leaves small ones whole", () => {
    const small = [{ id: 1 }, { id: 2 }];
    const result = okResult({ big: entries(100), small });
    const json = JSON.parse(textOf(result)) as { big: unknown[]; small: unknown[] };
    expect(json.small).toEqual(small);
    expect(json.big.length).toBeLessThan(100);
  });

  it("cuts lists one object level down, like invoice positions", () => {
    const result = okResult({ invoice: { id: 1, positions: entries(100) } });
    const json = JSON.parse(textOf(result)) as {
      invoice: { id: number; positions: unknown[] };
      truncated: boolean;
    };
    expect(json.invoice.id).toBe(1);
    expect(json.invoice.positions.length).toBeLessThan(100);
    expect(json.truncated).toBe(true);
    expect(textOf(result).length).toBeLessThanOrEqual(MAX_TOOL_RESPONSE_CHARS);
  });

  it("empties a list that alone is too big and moves on to the next", () => {
    const huge = [{ blob: "y".repeat(MAX_TOOL_RESPONSE_CHARS * 2) }];
    const result = okResult({ huge, rest: entries(60) });
    const json = JSON.parse(textOf(result)) as { huge: unknown[]; rest: unknown[] };
    expect(json.huge).toEqual([]);
    expect(json.rest.length).toBeGreaterThan(0);
    expect(textOf(result).length).toBeLessThanOrEqual(MAX_TOOL_RESPONSE_CHARS);
  });

  it("says so when nothing is left to cut and the answer stays over budget", () => {
    const data = { blob: "z".repeat(MAX_TOOL_RESPONSE_CHARS + 10), note: "Earlier." };
    const result = okResult(data);
    const json = JSON.parse(textOf(result)) as { blob: string; note: string; truncated?: boolean };
    expect(json.blob).toBe(data.blob);
    expect(json.note.startsWith("Earlier. This answer is over 100000 characters")).toBe(true);
    expect(json.truncated).toBeUndefined();
    expect(result.structuredContent).toEqual(json);
  });

  it("also says so when emptied lists are not enough", () => {
    const result = okResult({ items: entries(3), blob: "z".repeat(MAX_TOOL_RESPONSE_CHARS) });
    const json = JSON.parse(textOf(result)) as {
      items: unknown[];
      note: string;
      truncated: boolean;
    };
    expect(json.items).toEqual([]);
    expect(json.truncated).toBe(true);
    expect(json.note).toContain("Answer cut");
    expect(json.note).toContain("could not be cut further");
  });
});
