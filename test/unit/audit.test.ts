import { describe, expect, it } from "vitest";
import { createAuditLog } from "../../src/policy/audit.js";
import { TEST_TOKEN } from "../helpers.js";

describe("audit log", () => {
  it("writes one JSON line with exactly the audit fields", () => {
    const lines: string[] = [];
    const audit = createAuditLog({ write: (l) => lines.push(l), now: () => new Date(0) });
    audit.record({
      subject: "sub:u1",
      tool: "send_invoice_email",
      operationId: "sendInvoiceViaEMail",
      targetId: "42",
      class: "X",
      outcome: "ok",
      // Not part of the type; must still not reach the log.
      ...({ args: { email: "a@b.c" }, confirmation_token: "v1.x.y" } as object),
    });
    expect(lines).toHaveLength(1);
    expect(lines[0]?.endsWith("\n")).toBe(true);
    expect(JSON.parse(lines[0] ?? "")).toEqual({
      time: "1970-01-01T00:00:00.000Z",
      level: "info",
      msg: "audit",
      audit: true,
      subject: "sub:u1",
      tool: "send_invoice_email",
      operationId: "sendInvoiceViaEMail",
      targetId: "42",
      class: "X",
      outcome: "ok",
    });
    expect(lines[0]).not.toContain("a@b.c");
    expect(lines[0]).not.toContain("v1.x.y");
  });

  it("redacts secrets that slip into a field", () => {
    const lines: string[] = [];
    const audit = createAuditLog({ redact: [TEST_TOKEN], write: (l) => lines.push(l) });
    audit.record({
      subject: "s",
      tool: "t",
      class: "W",
      outcome: "error",
      reason: `x ${TEST_TOKEN}`,
    });
    expect(lines[0]).not.toContain(TEST_TOKEN);
    expect(lines[0]).toContain("[REDACTED]");
  });
});
