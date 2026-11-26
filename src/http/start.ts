import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { toNodeHandler } from "@modelcontextprotocol/node";
import { type AuthInfo, OAuthError, type OAuthTokenVerifier } from "@modelcontextprotocol/server";
import { createRemoteJWKSet } from "jose";
import {
  type Config,
  confirmSecretFor,
  forgetSecrets,
  HTTP_SECRET_ENV_VARIABLES,
  type HttpConfig,
  loadConfig,
  loadHttpConfig,
} from "../config.js";
import { SECRET_ENV_VARIABLES } from "../keychain.js";
import { createLogger, type Logger } from "../logger.js";
import { createAuditLog } from "../policy/audit.js";
import { validateToolNames } from "../policy/registry.js";
import { createPolicyRuntime } from "../policy/runtime.js";
import { createServer as createMcpServer } from "../server.js";
import { createSevdeskClient, type SevdeskClient } from "../sevdesk/client.js";
import { TOOL_NAMES } from "../tools/index.js";
import { VERSION } from "../version.js";
import { createHttpApp, HTTP_MAX_REQUEST_BODY_BYTES, type HttpApp } from "./app.js";
import { createJwtVerifier } from "./jwt-verifier.js";
import {
  type ConnectNonceStore,
  connectRedisNonceStore,
  type RedisNonceConnection,
} from "./redis.js";

/**
 * The request line and headers as a body-less Request, built like the
 * Node adapter builds its Request (same URL and headers), so screen() sees
 * what fetch() will see later.
 */
function headersOnly(req: IncomingMessage): Request {
  const single = (value: string | string[] | undefined) =>
    Array.isArray(value) ? value[0] : value;
  const host = single(req.headers.host) ?? single(req.headers[":authority"]) ?? "localhost";
  const headers = new Headers();
  for (const [name, value] of Object.entries(req.headers)) {
    if (value === undefined || name.startsWith(":")) continue;
    if (Array.isArray(value)) for (const item of value) headers.append(name, item);
    else headers.set(name, value);
  }
  return new Request(`http://${host}${req.url ?? "/"}`, {
    method: (req.method ?? "GET").toUpperCase(),
    headers,
  });
}

/** Writes an answer screen() gave; the request body stays unread and Node discards it. */
async function writeScreened(res: ServerResponse, response: Response): Promise<void> {
  const headers: Record<string, string> = {};
  for (const [name, value] of response.headers) headers[name] = value;
  res.writeHead(response.status, headers);
  res.end(Buffer.from(await response.arrayBuffer()));
}

/** How long shutdown waits for in-flight requests before cutting connections. */
export const SHUTDOWN_TIMEOUT_MS = 10_000;
/** After closing the MCP handler, time for the streams it ended to hang up. */
export const CLOSE_GRACE_MS = 1000;
const IDLE_SWEEP_MS = 50;

export interface StartHttpOptions {
  /** Environment to read; process.env in production. Its secrets are removed after loading. */
  env?: Record<string, string | undefined>;
  /** Log sink, one JSON line per call. Default: stdout, written immediately. */
  writeLine?: (line: string) => void;
  /** Interface to bind; default all interfaces. */
  host?: string;
  shutdownTimeoutMs?: number;
  /** Replaced in tests. */
  connectNonceStore?: ConnectNonceStore;
  /** Replaced in tests, so no request reaches sevdesk. */
  sevdesk?: SevdeskClient;
}

export interface RunningHttpServer {
  /** Origin the server listens on, e.g. http://127.0.0.1:3000. */
  readonly origin: string;
  readonly port: number;
  readonly server: Server;
  readonly app: HttpApp;
  readonly logger: Logger;
  /**
   * Graceful shutdown: stop accepting, let in-flight requests finish, close
   * the MCP handler and Redis. After the timeout remaining connections are
   * cut. Further calls return the same promise.
   */
  shutdown(reason: string): Promise<{ forced: boolean }>;
}

/** Startup failed for a reason the operator has to fix; the message says which. */
export class StartupError extends Error {
  override readonly name = "StartupError";
}

const writeStdout = (line: string): void => {
  process.stdout.write(line);
};

/** Values the logs must never show: tokens, the confirm secret, the Redis URL and its password. */
function secretsOf(config: Config, http: HttpConfig): string[] {
  const values = [config.sevdeskApiToken, http.redisUrl];
  if (config.confirmSecret) values.push(config.confirmSecret);
  try {
    const { password } = new URL(http.redisUrl);
    if (password !== "") values.push(password, decodeURIComponent(password));
  } catch {
    // loadHttpConfig already parsed it.
  }
  return values;
}

function delay(ms: number): { promise: Promise<"timeout">; cancel: () => void } {
  let timer: NodeJS.Timeout | undefined;
  const promise = new Promise<"timeout">((resolve) => {
    timer = setTimeout(() => resolve("timeout"), ms);
  });
  return { promise, cancel: () => clearTimeout(timer) };
}

/**
 * Starts the Streamable HTTP server: validates the configuration, connects
 * the shared nonce store, binds PORT and returns a handle with shutdown.
 * Signal handling is left to the entrypoint.
 */
export async function startHttpServer(options: StartHttpOptions = {}): Promise<RunningHttpServer> {
  const env = options.env ?? process.env;
  const writeLine = options.writeLine ?? writeStdout;

  // Unlike stdio, no keychain: a server process takes its secrets from the
  // environment (or the secret store that fills it).
  const config = loadConfig(env);
  const http = loadHttpConfig(env);
  validateToolNames(config, TOOL_NAMES);
  // Several instances and restarts must accept each other's confirmation
  // tokens; fail here, before connecting anything.
  const secret = confirmSecretFor(config, "http");
  forgetSecrets([...SECRET_ENV_VARIABLES, ...HTTP_SECRET_ENV_VARIABLES], env);

  const redact = secretsOf(config, http);
  const logger = createLogger({ level: config.logLevel, redact, write: writeLine });
  if (http.allowInsecureHttp) {
    logger.warn(
      "OAUTH_ALLOW_INSECURE_HTTP is set: issuer and keys over plain http, local use only",
    );
  }

  let nonces: RedisNonceConnection;
  try {
    nonces = await (options.connectNonceStore ?? connectRedisNonceStore)(http.redisUrl, logger);
  } catch {
    throw new StartupError(
      "cannot connect to Redis (REDIS_URL); the HTTP transport needs it for replay protection",
    );
  }

  let app: HttpApp;
  try {
    const runtime = createPolicyRuntime(config, {
      transport: "http",
      nonces: nonces.store,
      secret,
      audit: createAuditLog({ redact, write: writeLine }),
    });
    const sevdesk =
      options.sevdesk ??
      createSevdeskClient({ baseUrl: config.baseUrl, token: config.sevdeskApiToken, logger });
    const jwt = createJwtVerifier({
      issuer: http.issuer,
      resource: http.resourceUrl,
      keys: createRemoteJWKSet(http.jwksUrl),
      algorithms: http.algorithms,
    });
    // The gate answers anything but an OAuthError with a bare 500 (e.g. the
    // issuer's keys cannot be fetched); log the cause for the operator.
    const verifier: OAuthTokenVerifier = {
      verifyAccessToken: async (token) => {
        try {
          return await jwt.verifyAccessToken(token);
        } catch (error) {
          if (!(error instanceof OAuthError)) logger.error("token verification failed", { error });
          throw error;
        }
      },
    };
    app = createHttpApp({
      resourceUrl: http.resourceUrl,
      allowedHosts: http.allowedHosts,
      issuer: http.issuer,
      verifier,
      logger,
      factory: ({ authInfo }) =>
        createMcpServer(config, { logger, sevdesk, runtime, ...(authInfo && { authInfo }) }),
    });
  } catch (error) {
    await nonces.close();
    throw error;
  }

  // Shutdown waits for requests other than GET: tool calls and the like. A
  // 2026-07-28 subscriptions/listen stream is a POST as well and never ends
  // by itself, so with an open subscription the wait runs into the timeout;
  // closing the MCP handler then ends the stream gracefully. GET carries
  // only the legacy standalone stream, which that close ends too.
  let inFlight = 0;
  let idle: (() => void) | undefined;
  const handle = toNodeHandler(app, {
    onerror: (error) => logger.error("http adapter error", { error }),
    maxRequestBodySize: HTTP_MAX_REQUEST_BODY_BYTES,
  });
  const server = createServer((req, res) => {
    if (req.method !== "GET") {
      inFlight++;
      res.once("close", () => {
        inFlight--;
        if (inFlight === 0) idle?.();
      });
    }
    // The adapter reads the whole body before the app runs. Everything that
    // needs no body (Host, Origin, token, scope) is decided first, so an
    // unauthenticated client never gets a body buffered.
    void (async () => {
      let screened: Response | AuthInfo;
      try {
        screened = await app.screen(headersOnly(req));
      } catch (error) {
        logger.error("request screening failed", { error });
        screened = Response.json({ error: "server_error" }, { status: 500 });
      }
      if (screened instanceof Response) {
        await writeScreened(res, screened).catch((error: unknown) =>
          logger.warn("could not write response", { error }),
        );
        return;
      }
      // The adapter hands req.auth to app.fetch as authInfo: the admission
      // stands, the token is not verified a second time.
      const admitted = Object.assign(req, { auth: screened });
      // The adapter's types predate exactOptionalPropertyTypes (method?: string).
      await handle(admitted as Parameters<typeof handle>[0], res);
    })();
  });

  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(http.port, options.host, () => {
        server.off("error", reject);
        resolve();
      });
    });
  } catch (error) {
    await nonces.close();
    throw new StartupError(
      `cannot listen on port ${http.port}: ${error instanceof Error ? error.message : "unknown error"}`,
    );
  }
  const { port } = server.address() as AddressInfo;
  const origin = `http://${options.host ?? "localhost"}:${port}`;

  logger.info("sevdesk-mcp started", {
    version: VERSION,
    transport: "http",
    mode: config.mode,
    port,
    resource: http.resourceUrl.href,
  });

  const timeoutMs = options.shutdownTimeoutMs ?? SHUTDOWN_TIMEOUT_MS;
  let stopping: Promise<{ forced: boolean }> | undefined;
  const shutdown = (reason: string) => {
    stopping ??= (async () => {
      logger.info("sevdesk-mcp stopping", { reason, inFlight });
      const deadline = Date.now() + timeoutMs;
      const remaining = () => Math.max(0, deadline - Date.now());

      app.startDraining();
      // Stop accepting connections. server.close() drops idle keep-alive
      // connections only once, so connections that become idle later (a
      // finished request, a stream the handler ended) are swept until the
      // server is closed.
      const closed = new Promise<"closed">((resolve) => server.close(() => resolve("closed")));
      server.closeIdleConnections();
      const sweeper = setInterval(() => server.closeIdleConnections(), IDLE_SWEEP_MS);

      const drained =
        inFlight === 0
          ? Promise.resolve("drained" as const)
          : new Promise<"drained">((resolve) => {
              idle = () => resolve("drained");
            });
      let wait = delay(remaining());
      const first = await Promise.race([drained, wait.promise]);
      wait.cancel();
      if (first === "timeout") {
        logger.info("requests still open after the timeout, closing the MCP handler", { inFlight });
      }

      // Aborts what is left in the MCP handler, including listen streams.
      try {
        await app.close();
      } catch (error) {
        logger.error("closing the MCP handler failed", { error });
      }

      // Streams the close just ended need a moment to flush and hang up,
      // also when the drain phase already used up the timeout.
      wait = delay(Math.max(remaining(), CLOSE_GRACE_MS));
      const second = await Promise.race([closed, wait.promise]);
      wait.cancel();
      const forced = second === "timeout";
      if (forced) {
        logger.warn("shutdown timeout reached, closing remaining connections", { inFlight });
        server.closeAllConnections();
        await closed;
      }
      clearInterval(sweeper);
      await nonces.close();
      logger.info("sevdesk-mcp stopped", { forced });
      return { forced };
    })();
    return stopping;
  };

  return { origin, port, server, app, logger, shutdown };
}
