import { describe, expect, it } from "vitest";
import { connect } from "../../support/harness.js";
import { READ_TOOLS } from "../../support/tool-names.js";

describe("tool listing in read mode", () => {
  it("lists the 21 read tools plus the fallback and nothing that writes", async () => {
    const c = await connect({ mode: "read" });
    const { tools } = await c.client.listTools();
    expect(READ_TOOLS).toHaveLength(21);
    expect(tools.map((t) => t.name)).toEqual([...READ_TOOLS, "sevdesk_api_request"]);
    for (const tool of tools) {
      expect(tool.annotations, tool.name).toEqual({
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      });
      expect(tool.inputSchema.properties ?? {}, tool.name).not.toHaveProperty("confirmation_token");
    }
  });

  it("gives every curated tool an output schema, a title and an English description", async () => {
    const c = await connect();
    const { tools } = await c.client.listTools();
    for (const tool of tools.filter((t) => t.name !== "sevdesk_api_request")) {
      expect(tool.outputSchema?.type, tool.name).toBe("object");
      expect(tool.title, tool.name).toBeTruthy();
      expect(tool.description?.length ?? 0, tool.name).toBeGreaterThan(80);
      expect(tool.description, tool.name).toMatch(/^[\x20-\x7e]+$/);
    }
  });

  it("caps list sizes at 100 in the advertised schema", async () => {
    const c = await connect();
    const { tools } = await c.client.listTools();
    const paged = tools.filter(
      (t) => t.name !== "sevdesk_api_request" && t.inputSchema.properties?.limit,
    );
    expect(paged.map((t) => t.name)).toEqual([
      "search_contacts",
      "search_invoices",
      "list_open_receivables",
      "search_orders",
      "search_vouchers",
      "list_bank_accounts",
      "search_transactions",
      "search_parts",
      "get_tax_guidance",
      "summarize_documents",
      "audit_vat",
      "reverse_charge_report",
      "find_duplicate_vouchers",
      "find_subscription_gaps",
      "reconcile_transactions",
    ]);
    for (const tool of paged) {
      expect(tool.inputSchema.properties?.limit, tool.name).toMatchObject({
        maximum: 100,
        default: 25,
      });
    }
  });
});
