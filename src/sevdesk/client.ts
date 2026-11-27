import createClient, { type Client } from "openapi-fetch";
import type { paths } from "../generated/sevdesk.js";
import { type Logger, silentLogger } from "../logger.js";
import { enforceRequestPins, PinViolation } from "../policy/pins.js";
import { createRedactor, type Redactor } from "../redact.js";
import { USER_AGENT } from "../version.js";
import { mapHttpError, OUTCOME_UNKNOWN, parseRetryAfter, SevdeskError } from "./errors.js";
import { type RateLimiter, type RateLimiterRegistry, sharedRateLimiters } from "./rate-limit.js";

export interface RetryOptions {
  /**
   * Additional attempts after the first one for 5xx (502, 503, 504),
   * timeouts and network errors. Only GET requests are retried this way.
   */
  maxRetries: number;
  /**
   * Additional attempts after a 429, for every method and also through the
   * single-attempt client: sevdesk did not run a throttled request.
   */
  maxRateLimitRetries: number;
  baseDelayMs: number;
  /** Upper bound per wait. A longer Retry-After ends retrying instead. */
  maxDelayMs: number;
}

export interface SevdeskClientOptions {
  baseUrl: string;
  token: string;
  userAgent?: string;
  /** Per attempt, covering headers and body. */
  timeoutMs?: number;
  /** Upper bound for one call including all retries and waits. */
  deadlineMs?: number;
  /** Upper bound for one response body; larger answers are dropped while streaming. */
  maxResponseBytes?: number;
  retry?: Partial<RetryOptions>;
  /**
   * Client-side pacing in requests per second (SEVDESK_RATE_LIMIT). Shared
   * by every client of the process with the same token. Unset or 0: off.
   */
  rateLimit?: number | undefined;
  /** Where the buckets live; injected in tests. Default: one per process. */
  rateLimiters?: RateLimiterRegistry;
  logger?: Logger;
  /**
   * Injected in tests so retries do not wait in real time. The signal
   * aborts with the caller's request; the wait is abandoned either way.
   */
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  /** Clock for the deadline, injected in tests together with `sleep`. */
  now?: () => number;
}

export type SevdeskApi = Client<paths>;

export interface SevdeskClient {
  /** Typed openapi-fetch client. Pass its promise to `call` to get data or a SevdeskError. */
  readonly api: SevdeskApi;
  /**
   * Same client without retries on 5xx, timeouts or network errors, also
   * for GET. For operations with side effects behind a GET (export jobs,
   * sendByWithRender): repeating them after a timeout could run them twice.
   * A 429 is still retried: sevdesk did not run the throttled request.
   */
  readonly apiSingleAttempt: SevdeskApi;
  call<T>(request: Promise<ApiResult<T>>): Promise<T>;
}

type ApiResult<T> =
  | { data: T; error?: never; response: Response }
  | { data?: never; error: unknown; response: Response };

export const DEFAULT_TIMEOUT_MS = 30_000;
export const DEFAULT_DEADLINE_MS = 60_000;
export const DEFAULT_MAX_RESPONSE_BYTES = 10 * 1024 * 1024;
export const DEFAULT_RETRY: RetryOptions = {
  maxRetries: 3,
  maxRateLimitRetries: 3,
  baseDelayMs: 500,
  maxDelayMs: 10_000,
};

/** Waits `ms`; an abort clears the timer, so it does not outlive the call. */
const realSleep = (ms: number, signal?: AbortSignal): Promise<void> =>
  new Promise((resolve) => {
    const timer = setTimeout(done, ms);
    function done() {
      clearTimeout(timer);
      signal?.removeEventListener("abort", done);
      resolve();
    }
    signal?.addEventListener("abort", done, { once: true });
  });

// 500 is left out on purpose: sevdesk answers some invalid input with 500,
// and repeating that only multiplies the failure.
const RETRYABLE_STATUS = new Set([429, 502, 503, 504]);

function isRetryableStatus(status: number): boolean {
  return RETRYABLE_STATUS.has(status);
}

function backoffDelay(attempt: number, retry: RetryOptions): number {
  const exponential = Math.min(retry.maxDelayMs, retry.baseDelayMs * 2 ** (attempt - 1));
  // Jitter between 50 % and 100 % so parallel callers do not retry in lockstep.
  return Math.round(exponential * (0.5 + Math.random() * 0.5));
}

/** fetch's rejection for a redirect under `redirect: "error"`. */
function isRedirectRefusal(error: unknown): boolean {
  if (!(error instanceof TypeError)) return false;
  const cause = (error as { cause?: unknown }).cause;
  const causeMessage = cause instanceof Error ? cause.message : "";
  return /redirect/i.test(`${error.message} ${causeMessage}`);
}

/**
 * Request headers a call may carry. The client sets Accept, User-Agent and,
 * with a body, Content-Type; a caller may override those, nothing else.
 * Method overrides (X-HTTP-Method-Override and relatives) or forwarding
 * headers could make sevdesk run another operation than the one checked.
 */
const ALLOWED_HEADERS = new Set(["accept", "content-type", "user-agent"]);

/** Query keys some frameworks read as the real method. */
const METHOD_OVERRIDE_QUERY = new Set([
  "_method",
  "x-http-method",
  "x-http-method-override",
  "x-method-override",
]);

function refuseCall(
  gates: readonly RequestGate[],
  method: string,
  reason: string,
  message: string,
): never {
  for (const gate of gates) gate.callRefused(method.toUpperCase(), reason);
  throw new SevdeskError("policy", `${message} Nothing was sent.`);
}

function refuseSmuggling(gates: readonly RequestGate[], request: Request): void {
  for (const name of request.headers.keys()) {
    if (!ALLOWED_HEADERS.has(name)) {
      const shown = name.slice(0, 60);
      refuseCall(
        gates,
        request.method,
        `header:${shown}`,
        `The request header "${shown}" is not allowed on sevdesk requests.`,
      );
    }
  }
  for (const key of new URL(request.url).searchParams.keys()) {
    if (METHOD_OVERRIDE_QUERY.has(key.toLowerCase())) {
      const shown = key.slice(0, 60);
      refuseCall(
        gates,
        request.method,
        `query:${shown}`,
        `The query parameter "${shown}" is not allowed on sevdesk requests.`,
      );
    }
  }
}

function networkErrorCode(error: unknown): string | undefined {
  const cause = (error as { cause?: { code?: unknown } } | undefined)?.cause;
  return typeof cause?.code === "string" ? cause.code : undefined;
}

/**
 * Rejects as soon as the signal aborts, even if the underlying fetch
 * implementation ignores the signal (some interceptors and polyfills do).
 */
function untilAborted<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(signal.reason);
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
  });
}

/** Checks of a restricted client. */
export interface RequestGate {
  /**
   * Runs on every outgoing request before anything is sent. Throws to
   * refuse it (a SevdeskError of kind "policy").
   */
  check(request: Request): void;
  /**
   * Told when the client refuses a call itself: a per-call override, a
   * header outside the allowlist or a method-override query. `reason` is
   * short and machine-readable, e.g. "call_override:fetch".
   */
  callRefused(method: string, reason: string): void;
}

interface FetchPolicy {
  baseUrl: string;
  /** Added after every check, so nothing before the policy fetch sees it. */
  token: string;
  /** Checks of a restricted client, in order; each one can refuse. */
  gates: readonly RequestGate[];
  maxResponseBytes: number;
  /**
   * The request may have a side effect even if it is a GET (single-attempt
   * client). Failures then carry the "outcome unknown" warning.
   */
  sideEffects: boolean;
  timeoutMs: number;
  deadlineMs: number;
  retry: RetryOptions;
  /** Paces every attempt, retries included. */
  limiter: RateLimiter;
  logger: Logger;
  sleep: (ms: number, signal?: AbortSignal) => Promise<void>;
  now: () => number;
}

/** Internal marker on responses whose request may have had an effect. */
const OUTCOME_HEADER = "x-sevdesk-mcp-outcome";

const NULL_BODY_STATUS = new Set([204, 205, 304]);

/**
 * Reads the whole body within the attempt, so a stalled body hits the same
 * timeout and retry handling as stalled headers instead of surfacing later
 * as a raw DOMException in openapi-fetch.
 */
async function readFully(
  response: Response,
  signal: AbortSignal,
  maxBytes: number,
): Promise<Response> {
  const init = {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  };
  if (NULL_BODY_STATUS.has(response.status) || response.body === null) {
    await response.body?.cancel();
    return new Response(null, init);
  }
  const tooLarge = () =>
    new SevdeskError(
      "response_too_large",
      `sevdesk sent more than ${maxBytes} bytes; the response was dropped. Narrow the request.`,
      { status: response.status },
    );
  // Stop before buffering, not after: a declared or streamed size over the
  // limit ends the read and frees the connection.
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maxBytes) {
    await response.body.cancel();
    throw tooLarge();
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await untilAborted(reader.read(), signal);
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) throw tooLarge();
      chunks.push(value);
    }
  } catch (error) {
    await reader.cancel().catch(() => {});
    throw error;
  }
  const body = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new Response(body, init);
}

/**
 * The pause before a retry. A caller that aborts before or during it gets
 * its abort at once instead of after the full Retry-After or backoff.
 */
async function waitUnlessAborted(
  policy: FetchPolicy,
  delayMs: number,
  signal: AbortSignal,
): Promise<void> {
  if (signal.aborted) throw signal.reason;
  await untilAborted(policy.sleep(delayMs, signal), signal);
}

/**
 * fetch with client-side pacing, a per-attempt timeout, an overall deadline
 * and retries. 5xx, timeouts and network errors are retried only for GET:
 * repeating a write could create or send something twice. A 429 is retried
 * for every method, since sevdesk refused it before running it.
 */
function createPolicyFetch(policy: FetchPolicy): (request: Request) => Promise<Response> {
  return async (original) => {
    // Headers and method overrides first, then the scope of a restricted
    // client: a request outside either is refused before pins, retries or
    // the network see it.
    refuseSmuggling(policy.gates, original);
    for (const gate of policy.gates) gate.check(original);
    // Pins (preventSendBy, enshrine flags) hold for every caller of the
    // client, not only for the fallback that checks them up front.
    let request: Request;
    try {
      request = await enforceRequestPins(original, policy.baseUrl);
    } catch (error) {
      if (error instanceof PinViolation) throw new SevdeskError("policy", error.message);
      throw error;
    }
    // The token is set only here, after openapi-fetch and every check, so
    // nothing a caller can hook into (middleware, Request) ever holds it.
    const headers = new Headers(request.headers);
    // sevdesk expects the raw token, without a "Bearer" prefix.
    headers.set("Authorization", policy.token);
    request = new Request(request, { headers });
    const method = request.method.toUpperCase();
    const mayHaveSideEffect = method !== "GET" || policy.sideEffects;
    const maxAttempts = method === "GET" ? policy.retry.maxRetries + 1 : 1;
    const path = new URL(request.url).pathname;
    const deadline = policy.now() + policy.deadlineMs;
    // A retry only starts if, after the wait, a meaningful attempt still
    // fits. Otherwise the last attempt would get a few milliseconds and its
    // timeout message would report that tiny budget instead of the deadline.
    const minAttemptMs = Math.min(policy.timeoutMs, 1000);
    const fitsDeadline = (delayMs: number) => policy.now() + delayMs + minAttemptMs <= deadline;

    // The last answer that was retried, passed on if pacing leaves no room
    // for another attempt.
    let retriedResponse: Response | undefined;

    for (let attempt = 1; ; attempt++) {
      // Pacing counts against the deadline like a retry wait; a caller's
      // abort during it is passed through unchanged.
      const paced = await policy.limiter.acquire(
        request.signal,
        Math.max(0, deadline - policy.now() - minAttemptMs),
      );
      if (!paced) {
        if (retriedResponse !== undefined) return retriedResponse;
        const nothingSent = attempt === 1 ? " Nothing was sent." : "";
        throw new SevdeskError(
          "timeout",
          `The client-side rate limit (SEVDESK_RATE_LIMIT) would hold this request past the ${policy.deadlineMs} ms deadline.${nothingSent}`,
        );
      }
      const attemptTimeoutMs = Math.max(1, Math.min(policy.timeoutMs, deadline - policy.now()));
      const timeout = AbortSignal.timeout(attemptTimeoutMs);
      const signal = AbortSignal.any([request.signal, timeout]);
      const started = performance.now();
      const canRetry = attempt < maxAttempts;
      let response: Response;

      try {
        // A redirect could lead to a path or host the scope never checked.
        // A clone per attempt: a retried write must send its body again,
        // and the first attempt would otherwise have consumed it.
        const raw = await untilAborted(
          fetch(new Request(request.clone(), { signal, redirect: "error" })),
          signal,
        );
        response = await readFully(raw, signal, policy.maxResponseBytes);
      } catch (error) {
        if (request.signal.aborted) throw error;
        // Too large is a verdict on the answer, not a transport failure:
        // retrying would only download it again. A write that sevdesk did
        // not refuse (status < 400, or a 5xx) may have happened even though
        // its answer was dropped, so the caller must check before repeating.
        if (error instanceof SevdeskError) {
          const status = error.status;
          if (
            error.kind === "response_too_large" &&
            mayHaveSideEffect &&
            (status === undefined || status < 400 || status >= 500)
          ) {
            throw new SevdeskError(error.kind, `${error.message} ${OUTCOME_UNKNOWN}`, {
              ...(status !== undefined && { status }),
            });
          }
          throw error;
        }
        // A refused redirect is an answer, not a transport failure: retrying
        // would only be redirected again.
        if (!timeout.aborted && isRedirectRefusal(error)) {
          const unknown = mayHaveSideEffect ? ` ${OUTCOME_UNKNOWN}` : "";
          throw new SevdeskError(
            "http_error",
            `sevdesk answered with a redirect, which this server does not follow.${unknown}`,
          );
        }
        const kind = timeout.aborted ? "timeout" : "network";
        const delay = backoffDelay(attempt, policy.retry);
        const deadlineHit = canRetry && !fitsDeadline(delay);
        if (canRetry && !deadlineHit) {
          policy.logger.warn("sevdesk request failed, retrying", {
            method,
            path,
            attempt,
            kind,
            delayMs: delay,
          });
          retriedResponse = undefined;
          await waitUnlessAborted(policy, delay, request.signal);
          continue;
        }
        // A write may have reached sevdesk before the connection failed, so
        // the caller must not simply repeat it.
        const unknownOutcome = mayHaveSideEffect ? ` ${OUTCOME_UNKNOWN}` : "";
        if (kind === "timeout") {
          const within = deadlineHit
            ? `within the ${policy.deadlineMs} ms deadline`
            : `within ${attemptTimeoutMs} ms`;
          throw new SevdeskError("timeout", `sevdesk did not answer ${within}.${unknownOutcome}`);
        }
        const code = networkErrorCode(error);
        const gaveUp = deadlineHit ? ` Gave up within the ${policy.deadlineMs} ms deadline.` : "";
        throw new SevdeskError(
          "network",
          `Could not reach sevdesk${code ? ` (${code})` : ""}.${gaveUp}${unknownOutcome}`,
        );
      }

      policy.logger.debug("sevdesk request", {
        method,
        path,
        status: response.status,
        attempt,
        durationMs: Math.round(performance.now() - started),
      });

      // A server error on a request with side effects does not prove that
      // nothing happened; mark it so the error message says so.
      if (mayHaveSideEffect && response.status >= 500) {
        const headers = new Headers(response.headers);
        headers.set(OUTCOME_HEADER, "unknown");
        response = new Response(response.body, {
          status: response.status,
          statusText: response.statusText,
          headers,
        });
      }

      // Retries of other answers are bounded by maxRetries and GET only;
      // a 429 by its own budget, for every method.
      const retryStatus =
        response.status === 429
          ? attempt <= policy.retry.maxRateLimitRetries
          : canRetry && isRetryableStatus(response.status);
      if (!retryStatus) return response;

      const retryAfter = parseRetryAfter(response.headers.get("retry-after"));
      // Retry-After 0 (or a date in the past) still gets a minimal pause.
      const delay =
        retryAfter === undefined
          ? backoffDelay(attempt, policy.retry)
          : Math.max(policy.retry.baseDelayMs, retryAfter);
      // A server asking for a longer pause than we are willing to wait, or
      // one past the deadline, gets its error passed through as is.
      if (delay > policy.retry.maxDelayMs || !fitsDeadline(delay)) return response;

      policy.logger.warn("sevdesk request failed, retrying", {
        method,
        path,
        attempt,
        status: response.status,
        delayMs: delay,
      });
      retriedResponse = response;
      await waitUnlessAborted(policy, delay, request.signal);
    }
  };
}

// openapi-fetch lets a single call replace fetch or the Request class, or
// add middleware. fetch and Request would skip the policy fetch (scope,
// pins, timeouts); middleware could rewrite the request or read what the
// call carries. All three are refused.
const FORBIDDEN_CALL_OPTIONS = ["fetch", "Request", "middleware"] as const;
const CALL_METHODS = ["GET", "PUT", "POST", "DELETE", "OPTIONS", "HEAD", "PATCH", "TRACE"] as const;

/**
 * The call options as a plain copy, read once, so a getter cannot show one
 * value here and another to openapi-fetch.
 */
function refuseOverrides(gates: readonly RequestGate[], method: string, init: unknown): unknown {
  if (typeof init !== "object" || init === null) return init;
  const copy: Record<string, unknown> = { ...init };
  for (const option of FORBIDDEN_CALL_OPTIONS) {
    if (copy[option] !== undefined) {
      refuseCall(
        gates,
        method,
        `call_override:${option}`,
        `The per-call option "${option}" is not allowed on the sevdesk client.`,
      );
    }
  }
  return copy;
}

/**
 * The openapi-fetch client with per-call overrides refused and without
 * use/eject: client-wide middleware would see every request of the tool.
 */
function sealApi(api: SevdeskApi, gates: readonly RequestGate[]): SevdeskApi {
  const sealed: Record<string, unknown> = {
    request: (method: string, url: string, init?: unknown) => {
      return (api.request as (m: string, u: string, i?: unknown) => unknown)(
        method,
        url,
        refuseOverrides(gates, String(method), init),
      );
    },
    use: () =>
      refuseCall(
        gates,
        "USE",
        "call_override:middleware",
        "Middleware is not allowed on the sevdesk client.",
      ),
    eject: () =>
      refuseCall(
        gates,
        "EJECT",
        "call_override:middleware",
        "Middleware is not allowed on the sevdesk client.",
      ),
  };
  for (const name of CALL_METHODS) {
    const call = api[name] as (url: string, init?: unknown) => unknown;
    sealed[name] = (url: string, init?: unknown) => {
      return call(url, refuseOverrides(gates, name, init));
    };
  }
  return Object.freeze(sealed) as unknown as SevdeskApi;
}

/** Builds clients sharing one configuration with additional gates. */
type ClientFactory = (gates: readonly RequestGate[]) => SevdeskClient;

// Known only to this module, so a restricted client can be narrowed further
// but never widened: the factory of a restricted client keeps its gates.
const factories = new WeakMap<SevdeskClient, ClientFactory>();

/**
 * The same client, limited by `gate`: every request (through `api` and
 * `apiSingleAttempt`) must pass it, in addition to any gate the client
 * already has. Only clients built by createSevdeskClient can be
 * restricted; anything else is refused instead of passed on unchecked.
 */
export function restrictClient(client: SevdeskClient, gate: RequestGate): SevdeskClient {
  const factory = factories.get(client);
  if (factory === undefined) {
    throw new TypeError("restrictClient needs a client built by createSevdeskClient");
  }
  return factory([gate]);
}

export function createSevdeskClient(options: SevdeskClientOptions): SevdeskClient {
  const redact: Redactor = createRedactor([options.token]);
  const base: FetchPolicy = {
    baseUrl: options.baseUrl,
    token: options.token,
    gates: [],
    maxResponseBytes: options.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES,
    sideEffects: false,
    timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    deadlineMs: options.deadlineMs ?? DEFAULT_DEADLINE_MS,
    retry: { ...DEFAULT_RETRY, ...options.retry },
    limiter: (options.rateLimiters ?? sharedRateLimiters).limiterFor(
      options.token,
      options.rateLimit ?? 0,
    ),
    logger: options.logger ?? silentLogger,
    sleep: options.sleep ?? realSleep,
    now: options.now ?? Date.now,
  };

  const clientFor = (fetchPolicy: FetchPolicy) =>
    sealApi(
      createClient<paths>({
        baseUrl: options.baseUrl.replace(/\/+$/, ""),
        // Authorization is added by the policy fetch, after every check.
        headers: {
          "User-Agent": options.userAgent ?? USER_AGENT,
          Accept: "application/json",
        },
        fetch: createPolicyFetch(fetchPolicy),
      }),
      fetchPolicy.gates,
    );

  async function call<T>(request: Promise<ApiResult<T>>): Promise<T> {
    let result: ApiResult<T>;
    try {
      result = await request;
    } catch (error) {
      // openapi-fetch parses the body after our fetch returned; a body
      // that is not JSON surfaces here as a SyntaxError.
      if (error instanceof SyntaxError) {
        throw new SevdeskError("http_error", "sevdesk sent a response that is not valid JSON.");
      }
      // Bodies are read inside the fetch policy, so this is a safety net
      // for a timeout that still escapes. A caller's own abort (AbortError)
      // is passed through unchanged.
      if (error instanceof Error && error.name === "TimeoutError") {
        throw new SevdeskError("timeout", "sevdesk did not answer in time.");
      }
      throw error;
    }
    const { data, error, response } = result;
    if (response.ok) return data as T;
    throw mapHttpError({
      outcomeUnknown: response.headers.get(OUTCOME_HEADER) === "unknown",
      status: response.status,
      body: error,
      retryAfter: response.headers.get("retry-after"),
      redact,
    });
  }

  const build = (gates: readonly RequestGate[]): SevdeskClient => {
    const policy: FetchPolicy = { ...base, gates };
    const client: SevdeskClient = Object.freeze({
      api: clientFor(policy),
      apiSingleAttempt: clientFor({
        ...policy,
        sideEffects: true,
        retry: { ...policy.retry, maxRetries: 0 },
      }),
      call,
    });
    factories.set(client, (more) => build([...gates, ...more]));
    return client;
  };
  return build([]);
}
