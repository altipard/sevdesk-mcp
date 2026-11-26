import { describe, expect, it } from "vitest";
import { MAX_SUMMARY_LENGTH, okResult, present } from "../../src/tools/result.js";

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
