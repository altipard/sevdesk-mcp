import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { HttpResponse, http } from "msw";
import { type SetupServer, setupServer } from "msw/node";
import { afterAll, afterEach, beforeAll, expect } from "vitest";
import type { Config } from "../../src/config.js";
import { createPolicyRuntime } from "../../src/policy/runtime.js";
import { createServer } from "../../src/server.js";
import { createSevdeskClient } from "../../src/sevdesk/client.js";
import { captureLogger, MOCK_BASE_URL, TEST_TOKEN, testConfig } from "../helpers.js";
import { readOnlyProblems, specProblems } from "./spec.js";

export interface MockApi {
  readonly server: SetupServer;
  /** Requests of the current test, in order. */
  readonly requests: Request[];
}

/**
 * msw server for one test file. Every request is checked against the spec;
 * a test fails in afterEach if a tool sent something the spec does not
 * declare.
 */
export function mockSevdesk(): MockApi {
  const server = setupServer();
  const requests: Request[] = [];
  const problems: string[] = [];
  beforeAll(() => {
    server.listen({ onUnhandledFrame: "error" });
    server.events.on("request:start", ({ request }) => {
      requests.push(request.clone());
      problems.push(...specProblems(request), ...readOnlyProblems(request));
    });
  });
  afterEach(() => {
    server.resetHandlers();
    requests.length = 0;
    const found = problems.splice(0);
    expect(found, "requests must match the sevdesk spec").toEqual([]);
  });
  afterAll(() => server.close());
  return { server, requests };
}

export const sevdeskUrl = (path: string) => `${MOCK_BASE_URL}${path}`;

/** sevdesk-style error answer. */
export function sevdeskError(status: number, message = "error", headers?: Record<string, string>) {
  return HttpResponse.json(
    { error: { message, exceptionUUID: "00000000-0000-0000-0000-000000000000" } },
    { status, ...(headers && { headers }) },
  );
}

export { HttpResponse, http };

export interface Connection {
  readonly client: Client;
  readonly logLines: string[];
  call(name: string, args?: Record<string, unknown>): ReturnType<Client["callTool"]>;
  close(): Promise<void>;
}

const open: Connection[] = [];
afterEach(async () => {
  for (const connection of open.splice(0)) await connection.close();
});

/** MCP client and server over the in-memory transport; retries do not wait. */
export async function connect(overrides: Partial<Config> = {}): Promise<Connection> {
  const config = testConfig(overrides);
  const { logger, lines } = captureLogger();
  const sevdesk = createSevdeskClient({
    baseUrl: MOCK_BASE_URL,
    token: TEST_TOKEN,
    logger,
    sleep: async () => {},
    retry: { maxRetries: 1 },
  });
  const server = createServer(config, {
    logger,
    sevdesk,
    runtime: createPolicyRuntime(config, { transport: "stdio" }),
  });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: "read-tools-test", version: "0.0.0" });
  await client.connect(clientTransport);
  const connection: Connection = {
    client,
    logLines: lines,
    call: (name, args = {}) => client.callTool({ name, arguments: args }),
    close: async () => {
      await client.close();
      await server.close();
    },
  };
  open.push(connection);
  return connection;
}

type ToolResult = Awaited<ReturnType<Client["callTool"]>>;

export function structured<T = Record<string, unknown>>(result: ToolResult): T {
  expect(result.isError, JSON.stringify(result.content)).toBeFalsy();
  return result.structuredContent as T;
}

export function textOf(result: ToolResult): string {
  return (result.content as Array<{ type: string; text?: string }>)
    .filter((c) => c.type === "text")
    .map((c) => c.text ?? "")
    .join("\n");
}

/** Query of the n-th request as a plain object (repeated keys joined by ","). */
export function queryOf(request: Request | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of new URL(request?.url ?? "http://x/").searchParams) {
    out[key] = key in out ? `${out[key]},${value}` : value;
  }
  return out;
}

export function pathOf(request: Request | undefined): string {
  return new URL(request?.url ?? "http://x/").pathname.replace(new URL(MOCK_BASE_URL).pathname, "");
}

/**
 * Asserts the standard failure behaviour of a tool for 400, 401, 404, 422
 * and 429:
 * an MCP tool error with a readable message and no token in it.
 */
export async function expectHttpErrors(
  api: MockApi,
  method: "get",
  path: string,
  tool: string,
  args: Record<string, unknown>,
): Promise<void> {
  const cases: Array<[number, string]> = [
    [400, "(400)"],
    [401, "SEVDESK_API_TOKEN"],
    [422, "(422)"],
    [404, "(404)"],
    [429, "rate limit"],
  ];
  for (const [status, expected] of cases) {
    api.server.use(
      http[method](sevdeskUrl(path), () => sevdeskError(status, `failure for ${TEST_TOKEN}`), {
        once: false,
      }),
    );
    const c = await connect();
    const result = await c.call(tool, args);
    expect(result.isError, `${tool} ${status}`).toBe(true);
    const text = textOf(result);
    expect(text.toLowerCase(), `${tool} ${status}: ${text}`).toContain(expected.toLowerCase());
    expect(JSON.stringify(result)).not.toContain(TEST_TOKEN);
    expect(c.logLines.join("\n")).not.toContain(TEST_TOKEN);
    api.server.resetHandlers();
  }
}
