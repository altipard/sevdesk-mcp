import { describe, expect, it } from "vitest";
import {
  addDays,
  amount,
  berlinDateTime,
  daysBetween,
  enshrinedOf,
  INVOICE_STATUS,
  integer,
  isoDate,
  isoDateOf,
  MAX_TEXT_LENGTH,
  objectsOf,
  pageOf,
  statusOf,
  TRUNCATION_MARK,
  text,
  todayIso,
  totalOf,
  unixSeconds,
} from "../../src/tools/format.js";

describe("dates in German time", () => {
  it("turns ISO dates into Unix seconds for start and end of day, across DST", () => {
    expect(unixSeconds("2026-01-15")).toBe(Date.UTC(2026, 0, 14, 23) / 1000);
    expect(unixSeconds("2026-01-15", true)).toBe(Date.UTC(2026, 0, 15, 22, 59, 59) / 1000);
    expect(unixSeconds("2026-07-15")).toBe(Date.UTC(2026, 6, 14, 22) / 1000);
    // DST switch days: 2026-03-29 (23 h) and 2026-10-25 (25 h).
    expect(unixSeconds("2026-03-29")).toBe(Date.UTC(2026, 2, 28, 23) / 1000);
    expect(unixSeconds("2026-03-29", true)).toBe(Date.UTC(2026, 2, 29, 21, 59, 59) / 1000);
    expect(unixSeconds("2026-10-25")).toBe(Date.UTC(2026, 9, 24, 22) / 1000);
    expect(unixSeconds("2026-10-25", true)).toBe(Date.UTC(2026, 9, 25, 22, 59, 59) / 1000);
  });

  it("writes date-times with the German offset", () => {
    expect(berlinDateTime("2026-01-15")).toBe("2026-01-15T00:00:00+01:00");
    expect(berlinDateTime("2026-07-15", true)).toBe("2026-07-15T23:59:59+02:00");
  });

  it("reads sevdesk dates without shifting them a day", () => {
    expect(isoDateOf("2026-01-15T00:00:00+01:00")).toBe("2026-01-15");
    expect(isoDateOf("2026-01-15 00:00:00")).toBe("2026-01-15");
    expect(isoDateOf("2026-01-15")).toBe("2026-01-15");
    expect(isoDateOf("15.01.2026")).toBe("2026-01-15");
    expect(isoDateOf(String(Date.UTC(2026, 0, 14, 23) / 1000))).toBe("2026-01-15");
    expect(isoDateOf(Date.UTC(2026, 0, 14, 23) / 1000)).toBe("2026-01-15");
    for (const junk of [null, undefined, "", "soon", "0", 0, {}, "2026"]) {
      expect(isoDateOf(junk), String(junk)).toBeNull();
    }
  });

  it("knows today in Berlin even when UTC is still yesterday", () => {
    expect(todayIso(Date.UTC(2026, 0, 14, 23, 30))).toBe("2026-01-15");
  });

  it("adds and counts days over month and year ends", () => {
    expect(addDays("2026-01-25", 14)).toBe("2026-02-08");
    expect(addDays("2025-12-31", 1)).toBe("2026-01-01");
    expect(daysBetween("2026-03-28", "2026-03-30")).toBe(2);
    expect(daysBetween("2026-02-01", "2026-01-01")).toBe(-31);
  });

  it("accepts only real calendar dates as input", () => {
    expect(isoDate.safeParse("2028-02-29").success).toBe(true);
    for (const bad of ["2026-02-29", "2026-13-01", "26-01-01", "2026-1-1", "01.01.2026"]) {
      expect(isoDate.safeParse(bad).success, bad).toBe(false);
    }
  });
});

describe("values", () => {
  it("reads amounts and integers from strings without treating junk as 0", () => {
    expect(amount("119.5")).toBe(119.5);
    expect(amount("-50")).toBe(-50);
    expect(amount(12)).toBe(12);
    for (const junk of ["", " ", "1e3", "0x10", "12,50", null, undefined, Number.NaN, true]) {
      expect(amount(junk), String(junk)).toBeNull();
    }
    expect(integer("42")).toBe(42);
    expect(integer("4.2")).toBeNull();
  });

  it("names status codes and marks unknown ones", () => {
    expect(statusOf("750", INVOICE_STATUS)).toEqual({ status: 750, statusName: "partially_paid" });
    expect(statusOf("999", INVOICE_STATUS)).toEqual({ status: 999, statusName: "unknown" });
    expect(statusOf(null, INVOICE_STATUS)).toEqual({ status: null, statusName: null });
  });

  it("reads the enshrine marker", () => {
    expect(enshrinedOf("2026-01-01T00:00:00+01:00")).toBe(true);
    expect(enshrinedOf(true)).toBe(true);
    for (const no of [null, undefined, "", "0", 0, false])
      expect(enshrinedOf(no), String(no)).toBe(false);
  });
});

describe("lists", () => {
  it("accepts objects as array or single object and total as string", () => {
    expect(objectsOf({ objects: [{ id: "1" }] })).toEqual([{ id: "1" }]);
    expect(objectsOf({ objects: { id: "1" } })).toEqual([{ id: "1" }]);
    expect(objectsOf({ objects: null })).toEqual([]);
    expect(objectsOf(null)).toEqual([]);
    expect(totalOf({ total: "157" })).toBe(157);
    expect(totalOf({ total: 3 })).toBe(3);
    expect(totalOf({})).toBeNull();
  });

  it("derives hasMore from total, or from a full page without one", () => {
    expect(pageOf(0, 25, 25, 25).hasMore).toBe(false);
    expect(pageOf(25, 25, 25, 57).hasMore).toBe(true);
    expect(pageOf(50, 25, 7, 57).hasMore).toBe(false);
    expect(pageOf(0, 25, 25, null).hasMore).toBe(true);
    expect(pageOf(0, 25, 3, null).hasMore).toBe(false);
  });
});

describe("untrusted text", () => {
  it("keeps tabs and newlines, drops control and invisible characters", () => {
    expect(text("a\tb\nc")).toBe("a\tb\nc");
    expect(text("a\r\nb\rc")).toBe("a\nb\nc");
    expect(text("x\u0000\u0007\u001b\u007f\u0085­​‎ ‮⁦﻿y")).toBe("xy");
    expect(text("​ \u0000")).toBeNull();
  });

  it.each([
    ["Unicode tag block (ASCII smuggling)", "\u{E0041}\u{E0042}\u{E007F}"],
    ["variation selectors", "\uFE00\uFE0F\u{E0100}\u{E01EF}"],
    ["Mongolian vowel separator", "\u180E"],
    ["Arabic letter mark", "\u061C"],
    ["combining grapheme joiner", "\u034F"],
    ["Hangul fillers", "\u115F\u1160\u3164\uFFA0"],
    ["format characters (Cf)", "\u200B\u2060\u2066\u00AD\uFEFF"],
    ["line and paragraph separators", "\u2028\u2029"],
    ["control characters (Cc)", "\u0000\u001B\u007F\u0085"],
    ["private use (Co)", "\uE000\u{F0000}"],
    ["unassigned and noncharacters (Cn)", "\uFDD0\uFFFF"],
  ])("drops %s", (_name, hidden) => {
    expect(text(`a${hidden}b`)).toBe("ab");
    expect(text(hidden)).toBeNull();
  });

  it("keeps ZWJ and ZWNJ between visible characters", () => {
    const family = "\u{1F468}\u200D\u{1F469}\u200D\u{1F467}";
    expect(text(family)).toBe(family);
    expect(text(`Familie ${family}!`)).toBe(`Familie ${family}!`);
    // Persian "mi-khaham" is written with a ZWNJ after the prefix.
    const persian = "\u0645\u06CC\u200C\u062E\u0648\u0627\u0647\u0645";
    expect(text(persian)).toBe(persian);
  });

  it("drops joiners at the edge, next to spaces and in runs", () => {
    expect(text("\u200Dab\u200C")).toBe("ab");
    expect(text("a \u200D b")).toBe("a  b");
    expect(text("a\u200D\u200Cb")).toBe("ab");
    expect(text("a\u200D\u200D\u200Db")).toBe("ab");
    expect(text("\u200D\u200C")).toBeNull();
  });

  it("keeps umlauts, accents, euro signs, CJK and emoji", () => {
    const visible = "Müller & Söhne – größer 12,50 € café 日本語 \u{1F600} \u{1F4B6}";
    expect(text(visible)).toBe(visible);
  });

  it("caps long texts with a mark and leaves short ones alone", () => {
    const capped = text("a".repeat(MAX_TEXT_LENGTH + 1)) ?? "";
    expect(capped).toHaveLength(MAX_TEXT_LENGTH);
    expect(capped.endsWith(TRUNCATION_MARK)).toBe(true);
    expect(text("a".repeat(MAX_TEXT_LENGTH))).toHaveLength(MAX_TEXT_LENGTH);
  });
});
