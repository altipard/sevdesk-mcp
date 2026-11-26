import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { existsSync, mkdtempSync } from "node:fs";
import { createServer, type IncomingHttpHeaders, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { MAX_VOUCHER_FILE_BYTES } from "../../src/tools/voucher-writes.js";
import { VERSION } from "../../src/version.js";
import { TEST_TOKEN } from "../helpers.js";
import { READ_TOOLS } from "../support/tool-names.js";
import { pdfAtLimit, voucherArguments, voucherRoute } from "../support/voucher-upload.js";

// Runs the built binary as an MCP client would start it. msw cannot reach a
// child process, so a real HTTP server on a random port stands in for sevdesk.

const BIN = fileURLToPath(new URL("../../dist/bin/stdio.js", import.meta.url));
const ENV_PROBE = pathToFileURL(
  fileURLToPath(new URL("../support/env-probe.mjs", import.meta.url)),
).href;

let mock: Server;
let mockBaseUrl: string;
const seenHeaders: IncomingHttpHeaders[] = [];
/** Body sizes of the file uploads the mock received. */
const uploads: number[] = [];

beforeAll(async () => {
  if (!existsSync(BIN)) {
    throw new Error(`${BIN} is missing. Run "npm run build" first (npm test does this).`);
  }
  mock = createServer((req, res) => {
    seenHeaders.push(req.headers);
    let bytes = 0;
    req.on("data", (chunk: Buffer) => {
      bytes += chunk.length;
    });
    req.on("end", () => {
      uploads.push(...(req.url?.endsWith("/uploadTempFile") ? [bytes] : []));
      if (req.method === "GET" && req.url === "/api/v1/Tools/bookkeepingSystemVersion") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ objects: { version: "2.0" } }));
        return;
      }
      const answer = voucherRoute(req.method ?? "", req.url ?? "");
      if (answer !== undefined) {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify(answer));
        return;
      }
      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { message: "not mocked" } }));
    });
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
  id?: number | null;
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
      if (message.id === null) this.pending.get(-1)?.(message);
      else if (message.id !== undefined) this.pending.get(message.id)?.(message);
    });
  }

  request(id: number, method: string, params: Record<string, unknown> = {}, timeoutMs = 5000) {
    return new Promise<JsonRpcMessage>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`no answer to ${method}`)), timeoutMs);
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

  /** Writes a raw line and waits for the answer with `id` (or with id null). */
  rawRequest(id: number | null, line: string, timeoutMs = 15_000) {
    return new Promise<JsonRpcMessage>((resolve, reject) => {
      const key = id ?? -1;
      const timer = setTimeout(() => reject(new Error(`no answer to raw line ${id}`)), timeoutMs);
      this.pending.set(key, (message) => {
        clearTimeout(timer);
        this.pending.delete(key);
        resolve(message);
      });
      this.child.stdin.write(`${line}\n`);
    });
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
    expect(tools.map((tool) => tool.name)).toEqual([...READ_TOOLS, "sevdesk_api_request"]);
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

  it("takes a voucher file at the limit and survives a message over the limit", async () => {
    const session = new StdioSession(
      spawn(process.execPath, [BIN], {
        env: childEnv({
          SEVDESK_API_TOKEN: TEST_TOKEN,
          SEVDESK_BASE_URL: mockBaseUrl,
          SEVDESK_MODE: "write",
          LOG_LEVEL: "warn",
        }),
      }),
    );
    await session.request(1, "initialize", {
      protocolVersion: "2025-11-25",
      capabilities: {},
      clientInfo: { name: "stdio-test", version: "0.0.0" },
    });
    session.notify("notifications/initialized");

    const created = await session.request(
      2,
      "tools/call",
      { name: "create_voucher", arguments: voucherArguments(pdfAtLimit()) },
      30_000,
    );
    expect(created.result?.isError, JSON.stringify(created.result).slice(0, 500)).toBeFalsy();
    expect(created.result?.structuredContent).toMatchObject({
      file: { bytes: MAX_VOUCHER_FILE_BYTES },
    });
    expect(uploads.at(-1)).toBeGreaterThan(MAX_VOUCHER_FILE_BYTES);

    // 16 MiB + 1 of JSON: answered with an error naming the request, the
    // session stays open. The id sits at the end, as TypeScript clients send it.
    const padding = "A".repeat(16 * 1024 * 1024);
    const tooLarge = await session.rawRequest(
      3,
      `{"method":"tools/call","params":{"name":"create_voucher","arguments":{"x":"${padding}"}},"jsonrpc":"2.0","id":3}`,
    );
    expect(tooLarge.error).toMatchObject({ code: -32000 });
    expect(String((tooLarge.error as { message: string }).message)).toContain("Message too large");
    // id first, as Python clients send it; and a line without an id at all.
    const first = await session.rawRequest(
      4,
      `{"jsonrpc":"2.0","id":4,"method":"x","params":"${padding}"}`,
    );
    expect(first.error).toMatchObject({ code: -32000 });
    const anonymous = await session.rawRequest(
      null,
      `{"jsonrpc":"2.0","method":"x","params":"${padding}"}`,
    );
    expect(anonymous.error).toMatchObject({ code: -32000 });

    // A whole request followed by padding: the cut would be valid JSON, but
    // it must not run; the only answer is the error.
    const before = seenHeaders.length;
    const padded = await session.rawRequest(
      6,
      `{"jsonrpc":"2.0","id":6,"method":"tools/call","params":{"name":"get_account_info","arguments":{}}}${" ".repeat(16 * 1024 * 1024)}`,
    );
    expect(padded.error).toMatchObject({ code: -32000 });
    // An oversized response from the client carries an id of the server's own: not echoed.
    const response = await session.rawRequest(
      null,
      `{"jsonrpc":"2.0","id":7,"result":{"x":"${padding}"}}`,
    );
    expect(response.error).toMatchObject({ code: -32000 });

    const list = await session.request(5, "tools/list");
    expect(seenHeaders.length).toBe(before);
    expect(session.stdoutLines.filter((line) => line.includes('"id":6'))).toHaveLength(1);
    expect(list.result?.tools).toEqual(expect.arrayContaining([expect.anything()]));
    expect(await session.close()).toBe(0);
    expect(session.stderr.join("")).toContain("stdio message over the size limit dropped");
  }, 60_000);

  interface ProbeReport {
    /** Secret variable names still in the server's process.env after startup. */
    present: string[];
    /** Secret variable names the keychain tool was started with. */
    keychainEnv?: string[];
  }

  async function probeReport(session: StdioSession): Promise<ProbeReport> {
    const init = await session.request(1, "initialize", {
      protocolVersion: "2025-11-25",
      capabilities: {},
      clientInfo: { name: "stdio-test", version: "0.0.0" },
    });
    expect(init.result).toBeDefined();
    const line = session.stderr
      .join("")
      .split("\n")
      .find((entry) => entry.startsWith("env-probe "));
    expect(line, "the env probe did not report").toBeDefined();
    return JSON.parse(line?.slice("env-probe ".length) ?? "{}") as ProbeReport;
  }

  const secretsLeftAfterStart = async (session: StdioSession) =>
    (await probeReport(session)).present;

  async function accountInfo(session: StdioSession): Promise<void> {
    session.notify("notifications/initialized");
    const call = await session.request(2, "tools/call", {
      name: "get_account_info",
      arguments: {},
    });
    expect(call.result).toMatchObject({ structuredContent: { bookkeepingSystemVersion: "2.0" } });
  }

  it("removes the token and the confirmation secret from process.env after startup", async () => {
    const secret = "s".repeat(40);
    const session = new StdioSession(
      spawn(process.execPath, ["--import", ENV_PROBE, BIN], {
        env: childEnv({
          SEVDESK_API_TOKEN: TEST_TOKEN,
          SEVDESK_CONFIRM_SECRET: secret,
          SEVDESK_BASE_URL: mockBaseUrl,
        }),
      }),
    );
    expect(await secretsLeftAfterStart(session)).toEqual([]);
    // The server still has both through its config.
    await accountInfo(session);
    expect(seenHeaders.at(-1)?.authorization).toBe(TEST_TOKEN);
    expect(await session.close()).toBe(0);
    expect(session.stderr.join("")).not.toContain(secret);
  });

  it.skipIf(process.platform === "win32")("keeps a keychain token out of process.env", async () => {
    const keychainToken = "k".repeat(32);
    const session = new StdioSession(
      spawn(process.execPath, ["--import", ENV_PROBE, BIN], {
        env: childEnv({
          // Blank counts as unset, so the keychain is asked.
          SEVDESK_API_TOKEN: "",
          SEVDESK_CONFIRM_SECRET: "s".repeat(40),
          PROBE_KEYCHAIN_TOKEN: keychainToken,
          SEVDESK_BASE_URL: mockBaseUrl,
        }),
      }),
    );
    // Neither the server afterwards nor the keychain tool sees the secrets.
    expect(await probeReport(session)).toEqual({ present: [], keychainEnv: [] });
    await accountInfo(session);
    expect(seenHeaders.at(-1)?.authorization).toBe(keychainToken);
    expect(await session.close()).toBe(0);
    const stderr = session.stderr.join("");
    expect(stderr).toContain('"tokenSource":"keychain"');
    expect(stderr).not.toContain(keychainToken);
  });

  it("exits with a clear message when the token is missing", async () => {
    const session = new StdioSession(
      spawn(process.execPath, [BIN], {
        // An empty HOME keeps the server from finding a token the developer stored in the
        // login keychain.
        env: childEnv({
          SEVDESK_BASE_URL: mockBaseUrl,
          HOME: mkdtempSync(join(tmpdir(), "sevdesk-mcp-home-")),
        }),
      }),
    );

    expect(await session.close()).toBe(1);
    expect(session.stdoutLines).toEqual([]);
    expect(session.stderr.join("")).toContain("SEVDESK_API_TOKEN: is required");
  });
});
