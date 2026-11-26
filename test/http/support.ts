import { createServer, type IncomingHttpHeaders, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import {
  type CryptoKey,
  exportJWK,
  generateKeyPair,
  type JWK,
  type JWTPayload,
  SignJWT,
} from "jose";
import { afterAll, afterEach, beforeAll } from "vitest";
import {
  type RunningHttpServer,
  type StartHttpOptions,
  startHttpServer,
} from "../../src/http/start.js";
import { RedisNonceStore } from "../../src/policy/redis-nonce-store.js";
import { TEST_TOKEN } from "../helpers.js";
import { FakeRedis } from "../support/fake-redis.js";

export const CONFIRM_SECRET = "an-http-test-secret-of-at-least-32-chars";
export const READ = "sevdesk:read";
export const READ_WRITE = "sevdesk:read sevdesk:write";
export const ALL_SCOPES = "sevdesk:read sevdesk:write sevdesk:irreversible";

export interface SigningKey {
  privateKey: CryptoKey;
  publicJwk: JWK;
  kid: string;
  alg: string;
}

export async function makeKey(kid: string, alg = "RS256"): Promise<SigningKey> {
  const { privateKey, publicKey } = await generateKeyPair(alg, { extractable: true });
  const publicJwk = { ...(await exportJWK(publicKey)), kid, alg, use: "sig" };
  return { privateKey, publicJwk, kid, alg };
}

export async function listen(server: Server): Promise<string> {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

export function close(server: Server): Promise<void> {
  return new Promise((resolve) => {
    server.closeAllConnections();
    server.close(() => resolve());
  });
}

/** Local test issuer: a key pair and its JWKS over real HTTP. `hold` delays the JWKS answer. */
export async function startIssuer() {
  const key = await makeKey("test-key-1");
  let gate: Promise<void> | undefined;
  let arrived: (() => void) | undefined;
  const server = createServer(async (req, res) => {
    if (req.url === "/jwks") {
      arrived?.();
      await gate;
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ keys: [key.publicJwk] }));
      return;
    }
    res.writeHead(404).end();
  });
  const issuer = await listen(server);
  return {
    issuer,
    jwksUrl: `${issuer}/jwks`,
    key,
    /**
     * Holds JWKS answers until `release` is called. `arrived` resolves when
     * the first held request reaches the issuer, i.e. a gate is waiting.
     */
    hold(): { release: () => void; arrived: Promise<void> } {
      let release = () => {};
      gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const reached = new Promise<void>((resolve) => {
        arrived = resolve;
      });
      return {
        arrived: reached,
        release: () => {
          gate = undefined;
          arrived = undefined;
          release();
        },
      };
    },
    close: () => close(server),
  };
}

export type Issuer = Awaited<ReturnType<typeof startIssuer>>;

export interface TokenOptions {
  claims?: JWTPayload;
  issuer?: string;
  audience?: string | string[];
  scope?: string;
  /** Absolute exp (seconds) or a jose duration. */
  expiresIn?: string | number;
  key?: SigningKey;
  omit?: string[];
  /** Header typ; null leaves it out. */
  typ?: string | null;
}

export async function signToken(
  iss: Issuer,
  audience: string,
  options: TokenOptions = {},
): Promise<string> {
  const key = options.key ?? iss.key;
  const claims: JWTPayload = {
    sub: "user-1",
    client_id: "client-1",
    scope: options.scope ?? READ,
    ...options.claims,
  };
  for (const name of options.omit ?? []) delete claims[name];
  const typ = options.typ === undefined ? "at+jwt" : options.typ;
  const jwt = new SignJWT(claims)
    .setProtectedHeader({ alg: key.alg, kid: key.kid, ...(typ !== null && { typ }) })
    .setIssuer(options.issuer ?? iss.issuer)
    .setAudience(options.audience ?? audience)
    .setIssuedAt();
  if (!options.omit?.includes("exp")) jwt.setExpirationTime(options.expiresIn ?? "5m");
  return jwt.sign(key.privateKey);
}

export interface SeenRequest {
  method: string;
  url: string;
  headers: IncomingHttpHeaders;
  body: string;
}

/** Stand-in for the sevdesk API: answers every request with a success and records it. */
export async function startSevdeskMock() {
  const seen: SeenRequest[] = [];
  const server = createServer((req, res) => {
    let body = "";
    req.setEncoding("utf8");
    req.on("data", (chunk: string) => {
      body += chunk;
    });
    req.on("end", () => {
      seen.push({ method: req.method ?? "", url: req.url ?? "", headers: req.headers, body });
      res.writeHead(200, { "content-type": "application/json" });
      if (req.url?.endsWith("/Tools/bookkeepingSystemVersion")) {
        res.end(JSON.stringify({ objects: { version: "2.0" } }));
      } else {
        res.end(JSON.stringify({ objects: [{ id: "7", objectName: "Contact" }] }));
      }
    });
  });
  const origin = await listen(server);
  return { baseUrl: `${origin}/api/v1`, seen, close: () => close(server) };
}

export type SevdeskMock = Awaited<ReturnType<typeof startSevdeskMock>>;

export interface TestServer extends RunningHttpServer {
  readonly resourceUrl: URL;
  readonly redis: FakeRedis;
  readonly logLines: string[];
  /** The environment object the server was started with. */
  readonly env: Record<string, string | undefined>;
  /** Whether shutdown closed the nonce store connection. */
  redisClosed(): boolean;
  /** Parsed audit events written so far. */
  audit(): Array<Record<string, unknown>>;
}

async function freePort(): Promise<string> {
  const probe = createServer();
  const origin = await listen(probe);
  await close(probe);
  return new URL(origin).port;
}

/**
 * The real HTTP server (startHttpServer) on a free port with a local
 * issuer, a sevdesk mock and a fake Redis. The resource URL names the port,
 * so a free one is picked first.
 */
export async function startTestServer(
  iss: Issuer,
  sevdesk: SevdeskMock,
  env: Record<string, string | undefined> = {},
  options: Partial<StartHttpOptions> = {},
): Promise<TestServer> {
  const port = await freePort();
  const redis = new FakeRedis();
  const logLines: string[] = [];
  let redisClosed = false;
  const serverEnv: Record<string, string | undefined> = {
    PORT: port,
    SEVDESK_API_TOKEN: TEST_TOKEN,
    SEVDESK_BASE_URL: sevdesk.baseUrl,
    SEVDESK_CONFIRM_SECRET: CONFIRM_SECRET,
    SEVDESK_MODE: "write",
    LOG_LEVEL: "debug",
    MCP_RESOURCE_URL: `http://127.0.0.1:${port}/mcp`,
    OAUTH_ISSUER: iss.issuer,
    OAUTH_JWKS_URL: iss.jwksUrl,
    OAUTH_ALLOW_INSECURE_HTTP: "true",
    REDIS_URL: "redis://:redis-password@redis.test:6379",
    ...env,
  };
  const running = await startHttpServer({
    host: "127.0.0.1",
    writeLine: (line) => logLines.push(line),
    connectNonceStore: async () => {
      const store = new RedisNonceStore(redis, { operationTimeoutMs: 200 });
      await store.initialize();
      return {
        store,
        close: async () => {
          redisClosed = true;
        },
      };
    },
    ...options,
    env: serverEnv,
  });
  return Object.assign(running, {
    resourceUrl: new URL(env.MCP_RESOURCE_URL ?? `http://127.0.0.1:${port}/mcp`),
    redis,
    logLines,
    env: serverEnv,
    redisClosed: () => redisClosed,
    audit: () =>
      logLines
        .map((line) => JSON.parse(line) as Record<string, unknown>)
        .filter((entry) => entry.audit === true),
  });
}

export type Era = "modern" | "legacy";
export const ERAS = ["modern", "legacy"] as const;
export const WIRE_VERSION = { modern: "2026-07-28", legacy: "2025-11-25" } as const;

export interface Recorded {
  status: number;
  wwwAuthenticate: string | null;
  protocolVersion: string | null;
}

/**
 * MCP client with a static bearer token that records every HTTP exchange.
 * `modern` pins 2026-07-28; `legacy` is the client default (2025-11-25).
 */
export async function connectClient(resourceUrl: URL, token: string, era: Era = "modern") {
  const responses: Recorded[] = [];
  const recordingFetch: typeof fetch = async (input, init) => {
    const response = await fetch(input, init);
    responses.push({
      status: response.status,
      wwwAuthenticate: response.headers.get("www-authenticate"),
      protocolVersion: new Headers(init?.headers).get("mcp-protocol-version"),
    });
    return response;
  };
  const transport = new StreamableHTTPClientTransport(resourceUrl, {
    authProvider: { token: async () => token },
    fetch: recordingFetch,
  });
  const client = new Client(
    { name: "http-test", version: "0.0.0" },
    era === "modern" ? { versionNegotiation: { mode: { pin: "2026-07-28" } } } : {},
  );
  await client.connect(transport);
  return { client, responses, close: () => client.close() };
}

/** Raw JSON-RPC POST without the MCP client, for gate-level assertions. */
export function rawPost(
  url: URL | string,
  token?: string,
  body: unknown = { jsonrpc: "2.0", id: 1, method: "tools/list", params: {} },
) {
  return fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      ...(token && { authorization: `Bearer ${token}` }),
    },
    body: JSON.stringify(body),
  });
}

/** Issuer, sevdesk mock and cleanup for one test file. */
export function httpFixture() {
  const state = {} as { iss: Issuer; sevdesk: SevdeskMock };
  const cleanups: Array<() => Promise<unknown>> = [];
  beforeAll(async () => {
    state.iss = await startIssuer();
    state.sevdesk = await startSevdeskMock();
  });
  afterEach(async () => {
    // Clients first, then servers.
    while (cleanups.length > 0) await cleanups.shift()?.();
    state.sevdesk.seen.length = 0;
  });
  afterAll(async () => {
    await state.iss.close();
    await state.sevdesk.close();
  });
  return {
    get iss() {
      return state.iss;
    },
    get sevdesk() {
      return state.sevdesk;
    },
    async server(
      env: Record<string, string | undefined> = {},
      options: Partial<StartHttpOptions> = {},
    ) {
      const started = await startTestServer(state.iss, state.sevdesk, env, options);
      cleanups.push(() => started.shutdown("test end"));
      return started;
    },
    async client(resourceUrl: URL, token: string, era: Era = "modern") {
      const connected = await connectClient(resourceUrl, token, era);
      cleanups.unshift(connected.close);
      return connected;
    },
  };
}

export function textOf(result: unknown): string {
  const content = (result as { content?: Array<{ text?: string }> }).content;
  return content?.[0]?.text ?? "";
}
