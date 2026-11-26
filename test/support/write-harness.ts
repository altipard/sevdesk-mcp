import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { setupServer } from "msw/node";
import { afterAll, afterEach, beforeAll, expect } from "vitest";
import type { Config } from "../../src/config.js";
import { createAuditLog } from "../../src/policy/audit.js";
import { createPolicyRuntime } from "../../src/policy/runtime.js";
import { createServer } from "../../src/server.js";
import { createSevdeskClient } from "../../src/sevdesk/client.js";
import { captureLogger, MOCK_BASE_URL, TEST_TOKEN, testConfig } from "../helpers.js";
import type { MockApi } from "./harness.js";
import { operationOf, specProblems } from "./spec.js";

/**
 * Harness for the curated write tools. Like mockSevdesk, every request is
 * checked against the spec, but writes are allowed; tests assert which
 * operations were called. The connection runs over serveStdio like
 * production, answers elicitations if asked to and captures the audit log.
 */
export function mockSevdeskWrites(): MockApi {
  const server = setupServer();
  const requests: Request[] = [];
  const problems: string[] = [];
  beforeAll(() => {
    server.listen({ onUnhandledFrame: "error" });
    server.events.on("request:start", ({ request }) => {
      requests.push(request.clone());
      problems.push(...specProblems(request));
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

/** "METHOD operationId" of every request, in order. */
export function operations(api: MockApi): string[] {
  return api.requests.map((request) => `${request.method} ${operationOf(request) ?? request.url}`);
}

/** JSON body of the request to `operationId` (the n-th, default the first). */
export async function bodyOf(api: MockApi, operationId: string, nth = 0): Promise<unknown> {
  const request = api.requests.filter((r) => operationOf(r) === operationId)[nth];
  if (request === undefined) throw new Error(`no request to ${operationId}`);
  return request.clone().json();
}

export type Answer = "accept" | "decline";

export interface WriteConnection {
  readonly client: Client;
  readonly logLines: string[];
  readonly elicitations: string[];
  /** Audit events written so far. */
  audit(): Array<Record<string, unknown>>;
  call(name: string, args?: Record<string, unknown>): ReturnType<Client["callTool"]>;
}

const open: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const close of open.splice(0)) await close();
});

export async function connectWrites(
  options: { config?: Partial<Config>; answer?: Answer } = {},
): Promise<WriteConnection> {
  const config = testConfig({ mode: "full", ...options.config });
  const { logger, lines } = captureLogger();
  const auditLines: string[] = [];
  const runtime = createPolicyRuntime(config, {
    transport: "stdio",
    secret: Buffer.from("w".repeat(32)),
    audit: createAuditLog({ redact: [TEST_TOKEN], write: (line) => auditLines.push(line) }),
  });
  const sevdesk = createSevdeskClient({
    baseUrl: MOCK_BASE_URL,
    token: TEST_TOKEN,
    logger,
    sleep: async () => {},
    retry: { maxRetries: 1 },
  });
  const elicitations: string[] = [];
  const client = new Client(
    { name: "write-tools-test", version: "0.0.0" },
    { capabilities: options.answer ? { elicitation: { form: {} } } : {} },
  );
  if (options.answer) {
    const answer = options.answer;
    client.setRequestHandler("elicitation/create", async (request) => {
      elicitations.push(String((request.params as { message?: string }).message));
      return answer === "accept"
        ? { action: "accept", content: { confirm: true } }
        : { action: "decline" };
    });
  }
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const handle = serveStdio(() => createServer(config, { logger, sevdesk, runtime }), {
    transport: serverTransport,
  });
  await client.connect(clientTransport);
  open.push(async () => {
    await client.close();
    await handle.close();
  });
  return {
    client,
    logLines: lines,
    elicitations,
    audit: () => auditLines.map((line) => JSON.parse(line) as Record<string, unknown>),
    call: (name, args = {}) => client.callTool({ name, arguments: args }),
  };
}

type ToolResult = Awaited<ReturnType<Client["callTool"]>>;

/** First call of a W+/X tool: asserts the preview and returns it with its token. */
export async function previewOf(
  c: WriteConnection,
  name: string,
  args: Record<string, unknown>,
): Promise<{ token: string; preview: Record<string, unknown>; result: ToolResult }> {
  const result = await c.call(name, args);
  expect(result.isError, JSON.stringify(result.content)).toBeFalsy();
  const body = result.structuredContent as Record<string, unknown>;
  expect(body.status).toBe("confirmation_required");
  return {
    token: body.confirmation_token as string,
    preview: body.preview as Record<string, unknown>,
    result,
  };
}
