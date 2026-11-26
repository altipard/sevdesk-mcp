import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { toNodeHandler } from "@modelcontextprotocol/node";
import { OAuthError, type OAuthTokenVerifier } from "@modelcontextprotocol/server";
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
import { createHttpApp, type HttpApp } from "./app.js";
import { createJwtVerifier } from "./jwt-verifier.js";
import {
  type ConnectNonceStore,
  connectRedisNonceStore,
  type RedisNonceConnection,
} from "./redis.js";

/** How long shutdown waits for in-flight requests before cutting connections. */
export const SHUTDOWN_TIMEOUT_MS = 10_000;

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

  // Requests other than GET are tool calls and other exchanges that should
  // finish on shutdown; GET holds long-lived listen streams, which the MCP
  // handler aborts when it closes.
  let inFlight = 0;
  let idle: (() => void) | undefined;
  const handle = toNodeHandler(app, {
    onerror: (error) => logger.error("http adapter error", { error }),
  });
  const server = createServer((req, res) => {
    if (req.method !== "GET") {
      inFlight++;
      res.once("close", () => {
        inFlight--;
        if (inFlight === 0) idle?.();
      });
    }
    // The adapter's types predate exactOptionalPropertyTypes (method?: string).
    void handle(req as Parameters<typeof handle>[0], res);
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
      // Stop accepting connections; idle keep-alive connections close now,
      // busy ones once their response is done.
      const closed = new Promise<"closed">((resolve) => server.close(() => resolve("closed")));
      server.closeIdleConnections();

      const drained =
        inFlight === 0
          ? Promise.resolve("drained" as const)
          : new Promise<"drained">((resolve) => {
              idle = () => resolve("drained");
            });
      let wait = delay(remaining());
      const first = await Promise.race([drained, wait.promise]);
      wait.cancel();

      // Aborts what is left in the MCP handler, including listen streams.
      try {
        await app.close();
      } catch (error) {
        logger.error("closing the MCP handler failed", { error });
      }
      server.closeIdleConnections();

      wait = delay(first === "timeout" ? 0 : remaining());
      const second = await Promise.race([closed, wait.promise]);
      wait.cancel();
      const forced = second === "timeout";
      if (forced) {
        logger.warn("shutdown timeout reached, closing remaining connections", { inFlight });
        server.closeAllConnections();
        await closed;
      }
      await nonces.close();
      logger.info("sevdesk-mcp stopped", { forced });
      return { forced };
    })();
    return stopping;
  };

  return { origin, port, server, app, logger, shutdown };
}
