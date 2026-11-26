import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { HttpResponse, http } from "msw";
import { setupServer } from "msw/node";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import type { Config } from "../../src/config.js";
import { createServer } from "../../src/server.js";
import { captureLogger, MOCK_BASE_URL, TEST_TOKEN, testConfig } from "../helpers.js";

const api = setupServer();
beforeAll(() => api.listen({ onUnhandledFrame: "error" }));
afterEach(() => api.resetHandlers());
afterAll(() => api.close());

const versionUrl = `${MOCK_BASE_URL}/Tools/bookkeepingSystemVersion`;

async function connect(config: Config = testConfig()) {
  const { logger, lines } = captureLogger();
  const server = createServer(config, { logger });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: "protocol-test", version: "0.0.0" });
  await client.connect(clientTransport);
  return {
    client,
    logLines: lines,
    close: async () => {
      await client.close();
      await server.close();
    },
  };
}

describe("MCP protocol over the in-memory transport", () => {
  it("lists get_account_info with schemas and read-only annotations", async () => {
    const { client, close } = await connect();
    try {
      const { tools } = await client.listTools();

      expect(tools.map((tool) => tool.name)).toEqual(["get_account_info", "sevdesk_api_request"]);
      const tool = tools.find((t) => t.name === "get_account_info");
      expect(tool?.inputSchema.type).toBe("object");
      expect(tool?.outputSchema).toMatchObject({
        type: "object",
        properties: {
          bookkeepingSystemVersion: { type: "string" },
          mode: { enum: ["read", "write", "full"] },
        },
        required: ["bookkeepingSystemVersion", "mode"],
      });
      expect(tool?.annotations).toEqual({
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      });
    } finally {
      await close();
    }
  });

  it("returns the mocked account data", async () => {
    let authorization: string | null = null;
    api.use(
      http.get(versionUrl, ({ request }) => {
        authorization = request.headers.get("authorization");
        return HttpResponse.json({ objects: { version: "2.0" } });
      }),
    );
    const { client, close } = await connect(testConfig({ mode: "write" }));
    try {
      const result = await client.callTool({ name: "get_account_info", arguments: {} });

      expect(result.isError).toBeFalsy();
      expect(result.structuredContent).toEqual({ bookkeepingSystemVersion: "2.0", mode: "write" });
      expect(result.content).toEqual([
        { type: "text", text: JSON.stringify({ bookkeepingSystemVersion: "2.0", mode: "write" }) },
      ]);
      expect(authorization).toBe(TEST_TOKEN);
    } finally {
      await close();
    }
  });

  it("reports a rejected token as a tool error without leaking it", async () => {
    api.use(
      http.get(versionUrl, () =>
        HttpResponse.json({ error: { message: `bad token ${TEST_TOKEN}` } }, { status: 401 }),
      ),
    );
    const { client, logLines, close } = await connect();
    try {
      const result = await client.callTool({ name: "get_account_info", arguments: {} });

      expect(result.isError).toBe(true);
      const text = JSON.stringify(result);
      expect(text).toContain("Check SEVDESK_API_TOKEN");
      expect(text).not.toContain(TEST_TOKEN);
      expect(logLines.join("")).not.toContain(TEST_TOKEN);
    } finally {
      await close();
    }
  });

  it("reports an unexpected response shape as a tool error", async () => {
    api.use(http.get(versionUrl, () => HttpResponse.json({ objects: {} })));
    const { client, close } = await connect();
    try {
      const result = await client.callTool({ name: "get_account_info", arguments: {} });
      expect(result.isError).toBe(true);
      expect(JSON.stringify(result.content)).toContain("without a bookkeeping system version");
    } finally {
      await close();
    }
  });
});
