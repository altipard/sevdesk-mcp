import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { createServer, type IncomingHttpHeaders, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { VERSION } from "../../src/version.js";
import { TEST_TOKEN } from "../helpers.js";

// Runs the built binary as an MCP client would start it. msw cannot reach a
// child process, so a real HTTP server on a random port stands in for sevdesk.

const BIN = fileURLToPath(new URL("../../dist/bin/stdio.js", import.meta.url));

let mock: Server;
let mockBaseUrl: string;
const seenHeaders: IncomingHttpHeaders[] = [];

beforeAll(async () => {
  if (!existsSync(BIN)) {
    throw new Error(`${BIN} is missing. Run "npm run build" first (npm test does this).`);
  }
  mock = createServer((req, res) => {
    seenHeaders.push(req.headers);
    if (req.method === "GET" && req.url === "/api/v1/Tools/bookkeepingSystemVersion") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ objects: { version: "2.0" } }));
      return;
    }
    res.writeHead(404, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: { message: "not mocked" } }));
  });
  await new Promise<void>((resolve) => mock.listen(0, "127.0.0.1", resolve));
  const { port } = mock.address() as AddressInfo;
  mockBaseUrl = `http://127.0.0.1:${port}/api/v1`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => mock.close(() => resolve()));
});

function childEnv(extra: Record<string, string>): NodeJS.ProcessEnv {
  // Only what the binary needs, so a developer's real token never reaches the test.
  return { PATH: process.env.PATH ?? "", LOG_LEVEL: "debug", ...extra };
}

interface JsonRpcMessage {
  jsonrpc: "2.0";
  id?: number;
  result?: Record<string, unknown>;
  error?: unknown;
}

class StdioSession {
  readonly stderr: string[] = [];
  readonly stdoutLines: string[] = [];
  private readonly pending = new Map<number, (message: JsonRpcMessage) => void>();

  constructor(readonly child: ChildProcessWithoutNullStreams) {
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => this.stderr.push(chunk));
    createInterface({ input: child.stdout }).on("line", (line) => {
      this.stdoutLines.push(line);
      const message = JSON.parse(line) as JsonRpcMessage;
      if (message.id !== undefined) this.pending.get(message.id)?.(message);
    });
  }

  request(id: number, method: string, params: Record<string, unknown> = {}) {
    return new Promise<JsonRpcMessage>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`no answer to ${method}`)), 5000);
      this.pending.set(id, (message) => {
        clearTimeout(timer);
        resolve(message);
      });
      this.send({ jsonrpc: "2.0", id, method, params });
    });
  }

  notify(method: string) {
    this.send({ jsonrpc: "2.0", method });
  }

  private send(message: Record<string, unknown>) {
    this.child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  async close(): Promise<number | null> {
    this.child.stdin.end();
    if (this.child.exitCode !== null) return this.child.exitCode;
    return new Promise((resolve) => this.child.once("exit", (code) => resolve(code)));
  }
}

describe("built stdio binary", () => {
  it("answers initialize, tools/list and tools/call against the mock base URL", async () => {
    const session = new StdioSession(
      spawn(process.execPath, [BIN], {
        env: childEnv({ SEVDESK_API_TOKEN: TEST_TOKEN, SEVDESK_BASE_URL: mockBaseUrl }),
      }),
    );

    const init = await session.request(1, "initialize", {
      protocolVersion: "2025-11-25",
      capabilities: {},
      clientInfo: { name: "stdio-test", version: "0.0.0" },
    });
    expect(init.result).toMatchObject({
      serverInfo: { name: "sevdesk-mcp", version: VERSION },
      capabilities: { tools: {} },
    });
    session.notify("notifications/initialized");

    const list = await session.request(2, "tools/list");
    const tools = list.result?.tools as Array<{ name: string; annotations?: unknown }>;
    expect(tools.map((tool) => tool.name)).toEqual(["get_account_info", "sevdesk_api_request"]);
    for (const tool of tools) expect(tool.annotations).toMatchObject({ readOnlyHint: true });

    const call = await session.request(3, "tools/call", {
      name: "get_account_info",
      arguments: {},
    });
    expect(call.result).toMatchObject({
      structuredContent: { bookkeepingSystemVersion: "2.0", mode: "read" },
    });
    expect(seenHeaders.at(-1)?.authorization).toBe(TEST_TOKEN);

    expect(await session.close()).toBe(0);

    // stdout carries nothing but protocol messages; logs went to stderr.
    for (const line of session.stdoutLines) {
      expect(JSON.parse(line)).toHaveProperty("jsonrpc", "2.0");
    }
    const stderr = session.stderr.join("");
    expect(stderr).toContain('"msg":"sevdesk-mcp started"');
    expect(stderr).toContain('"msg":"sevdesk request"');
    expect(stderr).not.toContain(TEST_TOKEN);
  });

  it("exits with a clear message when the token is missing", async () => {
    const session = new StdioSession(
      spawn(process.execPath, [BIN], { env: childEnv({ SEVDESK_BASE_URL: mockBaseUrl }) }),
    );

    expect(await session.close()).toBe(1);
    expect(session.stdoutLines).toEqual([]);
    expect(session.stderr.join("")).toContain("SEVDESK_API_TOKEN: is required");
  });
});
