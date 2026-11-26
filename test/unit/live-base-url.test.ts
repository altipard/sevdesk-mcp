import { describe, expect, it } from "vitest";
import { berlinDate, liveBaseUrl } from "../live/base-url.js";

describe("live smoke base URL", () => {
  it("accepts https on sevdesk hosts and the default", () => {
    expect(liveBaseUrl(undefined)).toBeUndefined();
    expect(liveBaseUrl("  ")).toBeUndefined();
    expect(liveBaseUrl("https://my.sevdesk.de/api/v1/")).toBe("https://my.sevdesk.de/api/v1");
    expect(liveBaseUrl("https://SEVDESK.DE/api/v1")).toBe("https://sevdesk.de/api/v1");
  });

  it.each([
    "http://my.sevdesk.de/api/v1",
    "https://my.sevdesk.de.evil.example/api/v1",
    "https://evilsevdesk.de/api/v1",
    "https://user:pw@my.sevdesk.de/api/v1",
    "https://my.sevdesk.de:8443/api/v1",
    "https://my.sevdesk.de/api/v1?x=1",
    "http://localhost:1234/api/v1",
    "not a url",
  ])("refuses %s", (value) => {
    expect(() => liveBaseUrl(value)).toThrow(/SEVDESK_LIVE_BASE_URL/);
  });

  it("dates the smoke in German time", () => {
    expect(berlinDate(Date.UTC(2026, 0, 14, 23, 30))).toBe("2026-01-15");
    expect(berlinDate(Date.UTC(2026, 6, 14, 21, 59))).toBe("2026-07-14");
  });
});
