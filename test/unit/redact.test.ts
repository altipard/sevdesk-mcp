import { describe, expect, it } from "vitest";
import { createRedactor, REDACTED } from "../../src/redact.js";

describe("createRedactor", () => {
  it("replaces every occurrence of a secret", () => {
    const redact = createRedactor(["s3cret"]);
    expect(redact("a s3cret and s3cret")).toBe(`a ${REDACTED} and ${REDACTED}`);
  });

  it("replaces the JSON-escaped form of a secret", () => {
    const secret = 'ab"c\\d';
    const redact = createRedactor([secret]);
    const serialized = JSON.stringify({ header: secret });
    expect(serialized).not.toContain(secret);
    expect(redact(serialized)).toBe(`{"header":"${REDACTED}"}`);
    expect(redact(`raw ${secret}`)).toBe(`raw ${REDACTED}`);
  });

  it("ignores empty secrets", () => {
    expect(createRedactor([""])("unchanged")).toBe("unchanged");
  });
});
