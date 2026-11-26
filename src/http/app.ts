import {
  type AuthInfo,
  createMcpHandler,
  getOAuthProtectedResourceMetadataUrl,
  hostHeaderValidationResponse,
  type McpServerFactory,
  type OAuthProtectedResourceMetadata,
  type OAuthTokenVerifier,
  originValidationResponse,
  requireBearerAuth,
} from "@modelcontextprotocol/server";
import type { Logger } from "../logger.js";
import { SCOPES } from "../policy/rights.js";
import { SERVER_NAME } from "../version.js";

/** Liveness endpoint, without auth and without the Host check (probes use the pod IP). */
export const HEALTH_PATH = "/healthz";
/** RFC 9728 well-known prefix; the path-aware document lives below it. */
export const PRM_ROOT = "/.well-known/oauth-protected-resource";
export const SUPPORTED_SCOPES = [SCOPES.read, SCOPES.write, SCOPES.irreversible] as const;
/**
 * Largest POST body read on the MCP endpoint, in bytes, for the Node
 * adapter, the MCP handler and the long-lived-stream check alike. Sized for
 * create_voucher: a file at its limit travels as base64 (4/3 of its size)
 * plus the JSON envelope. Bodies are only read after screen() let the
 * request through, so this bound applies to authenticated callers only.
 */
export const HTTP_MAX_REQUEST_BODY_BYTES = 16 * 1024 * 1024;

export interface HttpAppOptions {
  /** Public URL of the MCP endpoint, also the expected token audience. */
  resourceUrl: URL;
  /** Host header allowlist (DNS rebinding protection). */
  allowedHosts: readonly string[];
  /** Authorization server published in the metadata. */
  issuer: string;
  verifier: OAuthTokenVerifier;
  /** Builds the MCP server for one request, with that request's verified token. */
  factory: McpServerFactory;
  logger: Logger;
}

export interface HttpApp {
  /**
   * Answers a request. `authInfo` is screen()'s result for this request,
   * handed on by the Node adapter (req.auth): with it, fetch takes the
   * admission (token, scope, draining) as decided and repeats only the
   * checks screen ran before it. Nothing else may pass authInfo.
   */
  fetch(request: Request, options?: { authInfo?: AuthInfo }): Promise<Response>;
  /**
   * Every check that needs no body, with the same rules fetch applies: the
   * answer for a request that ends here (health, metadata, 404, Host,
   * Origin, draining, missing or bad token, missing scope), or the verified
   * token of an MCP request whose body may now be read.
   */
  screen(request: Request): Promise<Response | AuthInfo>;
  /** From now on the MCP endpoint answers 503 and the health check reports draining. */
  startDraining(): void;
  /** Aborts in-flight MCP exchanges and closes their server instances. */
  close(): Promise<void>;
  readonly resourceMetadataUrl: string;
}

/** RFC 9728 Protected Resource Metadata of this server. */
export function protectedResourceMetadata(
  resourceUrl: URL,
  issuer: string,
): OAuthProtectedResourceMetadata {
  return {
    resource: resourceUrl.href,
    authorization_servers: [issuer],
    scopes_supported: [...SUPPORTED_SCOPES],
    bearer_methods_supported: ["header"],
    resource_name: SERVER_NAME,
  };
}

const json = (body: unknown, status: number, headers: Record<string, string> = {}) =>
  Response.json(body, { status, headers: { "cache-control": "no-store", ...headers } });

const methodNotAllowed = () => json({ error: "method_not_allowed" }, 405, { allow: "GET, HEAD" });
const notFound = () => json({ error: "not_found" }, 404);

const LISTEN_METHOD = "subscriptions/listen";

/** JSON-RPC method names in a body: one message or a (2025) batch. */
function methodsOf(body: unknown): string[] {
  const messages = Array.isArray(body) ? body : [body];
  return messages.flatMap((message) =>
    typeof message === "object" &&
    message !== null &&
    typeof (message as { method?: unknown }).method === "string"
      ? [(message as { method: string }).method]
      : [],
  );
}

/**
 * Whether the request opens a stream that only ends when the client leaves:
 * the legacy GET stream or a 2026-07-28 subscriptions/listen. Reads a copy
 * of the body, at most as much as the handler itself accepts; anything
 * larger or unreadable counts as not long-lived (the handler refuses it).
 */
export async function isLongLivedStream(request: Request): Promise<boolean> {
  if (request.method === "GET") return true;
  if (request.method !== "POST" || request.body === null) return false;
  const declared = Number(request.headers.get("content-length") ?? "0");
  if (declared > HTTP_MAX_REQUEST_BODY_BYTES) return false;
  const reader = request.clone().body?.getReader();
  if (reader === undefined) return false;
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > HTTP_MAX_REQUEST_BODY_BYTES) {
        // Not awaited: cancelling one branch of a tee only settles once the
        // handler's branch is done too.
        void reader.cancel().catch(() => {});
        return false;
      }
      chunks.push(value);
    }
    const text = new TextDecoder().decode(Buffer.concat(chunks));
    return methodsOf(JSON.parse(text)).includes(LISTEN_METHOD);
  } catch {
    return false;
  }
}

// setTimeout fires at once for delays above 2^31-1 ms.
const MAX_TIMER_MS = 2_147_483_647;

/**
 * Ends an event stream response at `deadlineMs` (the token's exp): the
 * client then has to come back with a fresh token, which the gate checks.
 * Other responses are returned unchanged. Only applied to long-lived
 * streams (see isLongLivedStream), never to answers of tool calls.
 */
export function endStreamAt(response: Response, deadlineMs: number, now = Date.now): Response {
  const contentType = response.headers.get("content-type") ?? "";
  if (response.body === null || !contentType.toLowerCase().startsWith("text/event-stream")) {
    return response;
  }
  const reader = response.body.getReader();
  let timer: NodeJS.Timeout | undefined;
  let ended = false;
  const end = (controller: ReadableStreamDefaultController<Uint8Array>) => {
    if (ended) return;
    ended = true;
    clearTimeout(timer);
    controller.close();
    void reader.cancel("access token expired").catch(() => {});
  };
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      const delay = deadlineMs - now();
      if (delay <= 0) end(controller);
      else timer = setTimeout(() => end(controller), Math.min(MAX_TIMER_MS, delay));
    },
    async pull(controller) {
      try {
        const { done, value } = await reader.read();
        if (ended) return;
        if (done) end(controller);
        else controller.enqueue(value);
      } catch (error) {
        if (ended) return;
        ended = true;
        clearTimeout(timer);
        controller.error(error);
      }
    },
    cancel(reason) {
      ended = true;
      clearTimeout(timer);
      return reader.cancel(reason);
    },
  });
  return new Response(body, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
}

/**
 * The HTTP surface, in this order:
 * 1. health check (no auth, no Host check);
 * 2. Host header allowlist;
 * 3. Protected Resource Metadata, path-aware and at the root (no auth);
 * 4. the MCP endpoint: Origin allowlist (same hosts), then the bearer gate,
 *    which requires sevdesk:read; per-tool scopes are checked by the scope
 *    challenge of each tool. Subscription streams end when the token
 *    expires; answers to tool calls run to the end.
 * Everything else is 404. The MCP token is only used here and never leaves
 * the process: tools call sevdesk with the server's own API token.
 */
export function createHttpApp(options: HttpAppOptions): HttpApp {
  const { resourceUrl, logger } = options;
  const resourceMetadataUrl = getOAuthProtectedResourceMetadataUrl(resourceUrl);
  const metadataPath = new URL(resourceMetadataUrl).pathname;
  const metadata = protectedResourceMetadata(resourceUrl, options.issuer);
  const mcpPath = resourceUrl.pathname;
  const allowedHosts = [...options.allowedHosts];

  const gate = requireBearerAuth({
    verifier: options.verifier,
    requiredScopes: [SCOPES.read],
    resourceMetadataUrl,
    expectedResource: resourceUrl,
  });
  const mcp = createMcpHandler(options.factory, {
    onerror: (error) => logger.error("mcp handler error", { error }),
    maxRequestBodySize: HTTP_MAX_REQUEST_BODY_BYTES,
  });
  let draining = false;

  // The one place for every check without a body. fetch runs it again, so
  // a request answered by screen() gets the same answer from fetch.
  const screenRoute = async (
    request: Request,
    pathname: string,
    admitted?: AuthInfo,
  ): Promise<{ response: Response } | { auth: AuthInfo }> => {
    const end = (response: Response) => ({ response });
    const readOnlyMethod = request.method === "GET" || request.method === "HEAD";
    if (pathname === HEALTH_PATH) {
      if (!readOnlyMethod) return end(methodNotAllowed());
      return end(draining ? json({ status: "draining" }, 503) : json({ status: "ok" }, 200));
    }

    const badHost = hostHeaderValidationResponse(request, allowedHosts);
    if (badHost) return end(badHost);

    if (pathname === metadataPath || pathname === PRM_ROOT) {
      // The root document is a fallback for clients that probe it.
      if (!readOnlyMethod) return end(methodNotAllowed());
      return end(Response.json(metadata, { headers: { "cache-control": "public, max-age=300" } }));
    }
    if (pathname !== mcpPath) return end(notFound());

    // Browsers send Origin; a page on another site must not drive the
    // endpoint with a token it got hold of. Clients without Origin pass.
    const badOrigin = originValidationResponse(request, allowedHosts);
    if (badOrigin) return end(badOrigin);

    // Admitted by screen() already: a request that arrived before draining
    // runs to the end, and a token that expired while the body was being
    // uploaded does not throw away a call the client finished sending.
    if (admitted) return { auth: admitted };
    if (draining) {
      return end(
        json({ error: "shutting_down" }, 503, { "retry-after": "1", connection: "close" }),
      );
    }
    const auth = await gate(request);
    return auth instanceof Response ? end(auth) : { auth };
  };

  const route = async (
    request: Request,
    pathname: string,
    admitted?: AuthInfo,
  ): Promise<Response> => {
    const screened = await screenRoute(request, pathname, admitted);
    if ("response" in screened) return screened.response;
    const { auth } = screened;
    // Read before the handler consumes the body.
    const longLived = await isLongLivedStream(request);
    const response = await mcp.fetch(request, { authInfo: auth });
    // The gate checked exp once; a subscription must not outlive the token.
    // Answers to tool calls run to the end, so a write that sevdesk already
    // executed is never cut off from its result.
    return longLived ? endStreamAt(response, (auth.expiresAt ?? 0) * 1000) : response;
  };

  return {
    resourceMetadataUrl,
    startDraining: () => {
      draining = true;
    },
    close: () => mcp.close(),
    fetch: (request, options) =>
      logged(request, (req, pathname) => route(req, pathname, options?.authInfo)),
    screen: async (request) => {
      let auth: AuthInfo | undefined;
      const response = await logged(request, async (req, pathname) => {
        const screened = await screenRoute(req, pathname);
        if ("response" in screened) return screened.response;
        auth = screened.auth;
        return undefined;
      });
      return auth ?? (response as Response);
    },
  };

  /** Runs one stage with error handling and logs its answer, if it gave one. */
  async function logged<R extends Response | undefined>(
    request: Request,
    stage: (request: Request, pathname: string) => Promise<R>,
  ): Promise<R | Response> {
    const started = performance.now();
    // Only the path is logged: no query, no headers, so neither the
    // Authorization header nor anything a client put in the URL.
    const { pathname } = new URL(request.url);
    let response: R | Response;
    try {
      response = await stage(request, pathname);
    } catch (error) {
      logger.error("request failed", { method: request.method, path: pathname, error });
      response = json({ error: "server_error" }, 500);
    }
    if (response === undefined) return response;
    // Health probes arrive every few seconds; they only show at debug.
    const log = pathname === HEALTH_PATH ? logger.debug : logger.info;
    log("http request", {
      method: request.method,
      path: pathname,
      status: response.status,
      durationMs: Math.round(performance.now() - started),
    });
    return response;
  }
}
