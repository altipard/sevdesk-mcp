import { describe, expect, it } from "vitest";
import { parseRetryAfter } from "../../src/sevdesk/errors.js";

const NOW = Date.parse("2026-11-26T12:00:00Z");

describe("parseRetryAfter", () => {
  it.each([
    ["0", 0],
    ["7", 7000],
    [" 120 ", 120_000],
  ])("reads delta seconds %j", (value, expected) => {
    expect(parseRetryAfter(value, NOW)).toBe(expected);
  });

  it("reads an HTTP date relative to now", () => {
    expect(parseRetryAfter("Thu, 26 Nov 2026 12:00:30 GMT", NOW)).toBe(30_000);
  });

  it("clamps an HTTP date in the past to 0", () => {
    expect(parseRetryAfter("Thu, 26 Nov 2026 11:00:00 GMT", NOW)).toBe(0);
  });

  it.each([null, "", "1.5", "-5", "soon", "2026-11-26T12:00:30Z", "26 Nov 2026"])(
    "ignores %j",
    (value) => {
      expect(parseRetryAfter(value, NOW)).toBeUndefined();
    },
  );
});
