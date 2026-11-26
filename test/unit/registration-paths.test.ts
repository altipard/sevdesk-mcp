import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { McpServer, type ServerContext } from "@modelcontextprotocol/server";
import { describe, expect, it } from "vitest";
import { createPolicyRuntime, requestPolicy } from "../../src/policy/runtime.js";
import { createSevdeskClient } from "../../src/sevdesk/client.js";
import { registerGenericTool } from "../../src/tools/generic.js";
import { captureLogger, MOCK_BASE_URL, TEST_TOKEN, testConfig } from "../helpers.js";

const SRC = fileURLToPath(new URL("../../src/", import.meta.url));
// Only these files may put tools on a server; everything else must go
// through registerTools, so no tool can skip the guard.
const ALLOWED = new Set(["policy/registry.ts", "tools/generic.ts"]);

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === "generated" ? [] : sourceFiles(path);
    return entry.name.endsWith(".ts") ? [path] : [];
  });
}

/**
 * Anything that can put a tool on a server or answer tools/call. Matches
 * identifiers rather than call syntax, so destructuring
 * (`const { registerTool } = server`), aliasing (`server["registerTool"]`,
 * `.bind`) and a raw request handler for tools/call are caught too.
 * `registerTools` and `registerGenericTool` are the guarded entry points
 * and do not match.
 */
const REGISTRATION_PATTERNS: readonly RegExp[] = [
  /\bregisterTool\b/,
  /\.tool\s*\(/,
  /\bsetRequestHandler\b/,
  /["'`]tools\/call["'`]/,
  /\bCallToolRequestSchema\b/,
];

function registersTools(source: string): boolean {
  return REGISTRATION_PATTERNS.some((pattern) => pattern.test(source));
}

describe("tool registration paths", () => {
  it("registers tools only in the registry and the fallback", () => {
    const offenders = sourceFiles(SRC)
      .map((file) => relative(SRC, file).replaceAll("\\", "/"))
      .filter((file) => !ALLOWED.has(file))
      .filter((file) => registersTools(readFileSync(join(SRC, file), "utf8")));
    expect(offenders).toEqual([]);
  });

  it("finds the allowed registration sites, so the scan itself works", () => {
    for (const file of ALLOWED) {
      expect(registersTools(readFileSync(join(SRC, file), "utf8")), file).toBe(true);
    }
  });

  it.each([
    ["direct call", "server.registerTool('x', {}, handler);"],
    ["destructured", "const { registerTool } = server;\nregisterTool('x', {}, h);"],
    ["aliased", "const { registerTool: add } = server; add('x', {}, h);"],
    ["bracket access", 'server["registerTool"]("x", {}, h);'],
    ["bound", "const add = server.registerTool.bind(server);"],
    ["legacy tool()", "server.tool('x', handler);"],
    ["raw handler by method", "server.server.setRequestHandler('tools/call', h);"],
    ["raw handler by schema", "low.setRequestHandler(CallToolRequestSchema, h);"],
    ["method literal", "const method = `tools/call`;"],
  ])("flags a %s", (_name, snippet) => {
    expect(registersTools(snippet)).toBe(true);
  });

  it.each([
    ["the guarded entry point", "registerTools(env, TOOLS);"],
    ["the fallback entry point", "registerGenericTool(env);"],
    ["unrelated code", "const tools = list.map((t) => t.name);"],
  ])("does not flag %s", (_name, snippet) => {
    expect(registersTools(snippet)).toBe(false);
  });
});

describe("sevdesk_api_request handler", () => {
  it("re-checks the operationId against the released set", async () => {
    const config = testConfig({ mode: "full" });
    const runtime = createPolicyRuntime(config, {
      transport: "stdio",
      secret: Buffer.from("r".repeat(32)),
    });
    const server = new McpServer({ name: "t", version: "0" }, { capabilities: { tools: {} } });
    const registered = registerGenericTool({
      server,
      policy: requestPolicy(config, runtime, undefined),
      deps: {
        config,
        sevdesk: createSevdeskClient({ baseUrl: MOCK_BASE_URL, token: TEST_TOKEN }),
        logger: captureLogger().logger,
      },
    });
    expect(registered).toBeDefined();
    // Calls the handler directly, past the input schema's enum.
    const handler = registered?.handler as unknown as (
      args: Record<string, unknown>,
      ctx: ServerContext,
    ) => Promise<{ isError?: boolean; content: Array<{ text: string }> }>;
    const result = await handler({ operationId: "deleteContact", params: { contactId: 1 } }, {
      mcpReq: {},
    } as unknown as ServerContext);
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toBe("deleteContact is not released for this server.");
  });
});
