import { describe, expect, it } from "vitest";
import { z } from "zod";
import { ConfigError } from "../../src/config.js";
import {
  defineTool,
  isToolEnabled,
  resolveOperationId,
  type ToolDefinition,
  ToolDefinitionError,
  validateToolNames,
} from "../../src/policy/registry.js";
import type { Rights } from "../../src/policy/rights.js";
import { TOOL_NAMES } from "../../src/tools/index.js";
import { testConfig } from "../helpers.js";

const base = {
  title: "t",
  description: "d",
  inputSchema: z.object({ id: z.number() }),
  handler: async () => ({}),
};
const ro = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: true,
};
const rw = {
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: false,
  openWorldHint: true,
};
const destructive = { ...rw, destructiveHint: true };

describe("defineTool", () => {
  it("accepts consistent definitions", () => {
    expect(() =>
      defineTool({ ...base, name: "read_it", class: "R", annotations: ro }),
    ).not.toThrow();
    expect(() =>
      defineTool({
        ...base,
        name: "send_it",
        class: "X",
        annotations: destructive,
        preview: async () => ({}),
        targetId: (a) => a.id,
      }),
    ).not.toThrow();
  });

  it.each([
    ["a reading tool without readOnlyHint", { name: "x", class: "R", annotations: rw }],
    ["a writing tool with readOnlyHint", { name: "x", class: "W", annotations: ro }],
    [
      "a destructive reading tool",
      { name: "x", class: "R", annotations: { ...ro, destructiveHint: true } },
    ],
    [
      "X without destructiveHint",
      { name: "x", class: "X", annotations: rw, preview: async () => ({}), targetId: () => 1 },
    ],
    [
      "X marked idempotent",
      {
        name: "x",
        class: "X",
        annotations: { ...destructive, idempotentHint: true },
        preview: async () => ({}),
        targetId: () => 1,
      },
    ],
    ["W+ without preview", { name: "x", class: "W+", annotations: destructive }],
    [
      "X without targetId",
      { name: "x", class: "X", annotations: destructive, preview: async () => ({}) },
    ],
    [
      "W+ with outputSchema",
      {
        name: "x",
        class: "W+",
        annotations: destructive,
        preview: async () => ({}),
        outputSchema: z.object({}),
      },
    ],
    [
      "W+ declaring confirmation_token",
      {
        name: "x",
        class: "W+",
        annotations: destructive,
        preview: async () => ({}),
        inputSchema: z.object({ confirmation_token: z.string() }),
      },
    ],
    ["a name that is not snake_case", { name: "SendIt", class: "R", annotations: ro }],
  ])("rejects %s", (_label, override) => {
    expect(() => defineTool({ ...base, ...override } as ToolDefinition)).toThrow(
      ToolDefinitionError,
    );
  });
});

describe("operationId picked from the arguments", () => {
  const picking = (operations: ToolDefinition["operations"]) =>
    defineTool({
      ...base,
      name: "enshrine_it",
      class: "X",
      annotations: destructive,
      preview: async () => ({}),
      targetId: (a) => a.id,
      inputSchema: z.object({ id: z.number(), kind: z.enum(["invoice", "voucher"]) }),
      operationId: (a) => (a.kind === "invoice" ? "invoiceEnshrine" : "voucherEnshrine"),
      ...(operations && { operations }),
    });

  it("resolves per call to one of the declared operations", () => {
    const tool = picking(["invoiceEnshrine", "voucherEnshrine"]);
    expect(resolveOperationId(tool, { id: 1, kind: "invoice" })).toBe("invoiceEnshrine");
    expect(resolveOperationId(tool, { id: 1, kind: "voucher" })).toBe("voucherEnshrine");
  });

  it("refuses a pick that operations does not list", () => {
    const tool = picking(["invoiceEnshrine"]);
    expect(() => resolveOperationId(tool, { id: 1, kind: "voucher" })).toThrow(
      /voucherEnshrine is not listed in operations/,
    );
  });

  it("needs the candidates in operations at definition time", () => {
    expect(() => picking(undefined)).toThrow(ToolDefinitionError);
  });

  it("returns a fixed operationId unchanged", () => {
    const tool = defineTool({
      ...base,
      name: "read_it",
      class: "R",
      annotations: ro,
      operationId: "getInvoices",
    });
    expect(resolveOperationId(tool, { id: 1 })).toBe("getInvoices");
  });
});

describe("isToolEnabled", () => {
  const tool = (cls: ToolDefinition["class"], extra: Partial<ToolDefinition> = {}) =>
    ({ name: "some_tool", class: cls, ...extra }) as ToolDefinition;

  it.each([
    ["read", "R", true],
    ["read", "W", false],
    ["write", "W+", true],
    ["write", "X", false],
    ["full", "X", true],
    ["none", "R", false],
  ] as const)("rights %s, class %s (enabled): %s", (rights, cls, expected) => {
    const config = testConfig({ enableTools: ["some_tool"] });
    expect(isToolEnabled(config, rights as Rights, tool(cls))).toBe(expected);
  });

  it("lets the deny list win over allow and enable lists", () => {
    const config = testConfig({
      allowedTools: ["some_tool"],
      enableTools: ["some_tool"],
      deniedTools: ["some_tool"],
    });
    expect(isToolEnabled(config, "full", tool("R"))).toBe(false);
    expect(isToolEnabled(config, "full", tool("X"))).toBe(false);
  });

  it("uses the allowlist only to narrow", () => {
    expect(isToolEnabled(testConfig({ allowedTools: ["other"] }), "full", tool("R"))).toBe(false);
    expect(isToolEnabled(testConfig({ allowedTools: ["some_tool"] }), "full", tool("R"))).toBe(
      true,
    );
    // Listing an off-by-default tool in the allowlist does not switch it on.
    expect(isToolEnabled(testConfig({ allowedTools: ["some_tool"] }), "full", tool("X"))).toBe(
      false,
    );
  });

  it("keeps X, R+ and default-off tools off unless enabled", () => {
    expect(isToolEnabled(testConfig(), "full", tool("X"))).toBe(false);
    expect(isToolEnabled(testConfig(), "full", tool("R+"))).toBe(false);
    expect(isToolEnabled(testConfig(), "full", tool("W", { defaultEnabled: false }))).toBe(false);
    const enabled = testConfig({ enableTools: ["some_tool"] });
    expect(isToolEnabled(enabled, "full", tool("X"))).toBe(true);
    expect(isToolEnabled(enabled, "read", tool("R+"))).toBe(true);
    expect(isToolEnabled(enabled, "write", tool("W", { defaultEnabled: false }))).toBe(true);
  });

  it("narrows enabled tools by the allowlist too", () => {
    const config = testConfig({ enableTools: ["some_tool"], allowedTools: ["other"] });
    expect(isToolEnabled(config, "full", tool("X"))).toBe(false);
  });

  it("never lifts a tool above the rights, even when enabled", () => {
    const config = testConfig({ allowedTools: ["some_tool"], enableTools: ["some_tool"] });
    expect(isToolEnabled(config, "read", tool("W"))).toBe(false);
    expect(isToolEnabled(config, "write", tool("X"))).toBe(false);
  });
});

describe("validateToolNames", () => {
  it("accepts known names and reports unknown ones", () => {
    expect(() =>
      validateToolNames(
        testConfig({ allowedTools: ["get_account_info"], deniedTools: ["sevdesk_api_request"] }),
        TOOL_NAMES,
      ),
    ).not.toThrow();
    try {
      validateToolNames(
        testConfig({
          allowedTools: ["get_acount_info"],
          deniedTools: ["nope"],
          enableTools: ["x_tool"],
        }),
        TOOL_NAMES,
      );
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(ConfigError);
      expect((error as ConfigError).issues).toEqual([
        "SEVDESK_ALLOWED_TOOLS: unknown tool: get_acount_info",
        "SEVDESK_DENIED_TOOLS: unknown tool: nope",
        "SEVDESK_ENABLE_TOOLS: unknown tool: x_tool",
      ]);
    }
  });
});
