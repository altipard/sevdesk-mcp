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

describe("tool registration paths", () => {
  it("registers tools only in the registry and the fallback", () => {
    const offenders = sourceFiles(SRC)
      .map((file) => relative(SRC, file).replaceAll("\\", "/"))
      .filter((file) => !ALLOWED.has(file))
      .filter((file) =>
        /\.registerTool\s*\(|\.tool\s*\(/.test(readFileSync(join(SRC, file), "utf8")),
      );
    expect(offenders).toEqual([]);
  });

  it("finds the allowed registration sites, so the scan itself works", () => {
    for (const file of ALLOWED) {
      expect(readFileSync(join(SRC, file), "utf8")).toMatch(/\.registerTool\s*\(/);
    }
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
