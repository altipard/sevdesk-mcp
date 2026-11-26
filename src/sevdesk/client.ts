import createClient, { type Client } from "openapi-fetch";
import type { paths } from "../generated/sevdesk.js";
import { type Logger, silentLogger } from "../logger.js";
import { createRedactor, type Redactor } from "../redact.js";
import { USER_AGENT } from "../version.js";
import { mapHttpError, parseRetryAfter, SevdeskError } from "./errors.js";

export interface RetryOptions {
  /** Additional attempts after the first one. Only GET requests are retried. */
  maxRetries: number;
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
  retry?: Partial<RetryOptions>;
  logger?: Logger;
  /** Injected in tests so retries do not wait in real time. */
  sleep?: (ms: number) => Promise<void>;
  /** Clock for the deadline, injected in tests together with `sleep`. */
  now?: () => number;
}

export type SevdeskApi = Client<paths>;

export interface SevdeskClient {
  /** Typed openapi-fetch client. Pass its promise to `call` to get data or a SevdeskError. */
  readonly api: SevdeskApi;
  call<T>(request: Promise<ApiResult<T>>): Promise<T>;
}

type ApiResult<T> =
  | { data: T; error?: never; response: Response }
  | { data?: never; error: unknown; response: Response };

export const DEFAULT_TIMEOUT_MS = 30_000;
export const DEFAULT_DEADLINE_MS = 60_000;
export const DEFAULT_RETRY: RetryOptions = { maxRetries: 3, baseDelayMs: 500, maxDelayMs: 10_000 };

const realSleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

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

interface FetchPolicy {
  timeoutMs: number;
  deadlineMs: number;
  retry: RetryOptions;
  logger: Logger;
  sleep: (ms: number) => Promise<void>;
  now: () => number;
}

const NULL_BODY_STATUS = new Set([204, 205, 304]);

/**
 * Reads the whole body within the attempt, so a stalled body hits the same
 * timeout and retry handling as stalled headers instead of surfacing later
 * as a raw DOMException in openapi-fetch.
 */
async function readFully(response: Response, signal: AbortSignal): Promise<Response> {
  const init = {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  };
  if (NULL_BODY_STATUS.has(response.status)) {
    await response.body?.cancel();
    return new Response(null, init);
  }
  return new Response(await untilAborted(response.arrayBuffer(), signal), init);
}

/**
 * fetch with a per-attempt timeout, an overall deadline and retries.
 * Retries happen only for GET: repeating a write could create or send
 * something twice.
 */
function createPolicyFetch(policy: FetchPolicy): (request: Request) => Promise<Response> {
  return async (request) => {
    const method = request.method.toUpperCase();
    const maxAttempts = method === "GET" ? policy.retry.maxRetries + 1 : 1;
    const path = new URL(request.url).pathname;
    const deadline = policy.now() + policy.deadlineMs;
    const fitsDeadline = (delayMs: number) => policy.now() + delayMs < deadline;

    for (let attempt = 1; ; attempt++) {
      const attemptTimeoutMs = Math.max(1, Math.min(policy.timeoutMs, deadline - policy.now()));
      const timeout = AbortSignal.timeout(attemptTimeoutMs);
      const signal = AbortSignal.any([request.signal, timeout]);
      const started = performance.now();
      const canRetry = attempt < maxAttempts;
      let response: Response;

      try {
        const raw = await untilAborted(fetch(new Request(request, { signal })), signal);
        response = await readFully(raw, signal);
      } catch (error) {
        if (request.signal.aborted) throw error;
        const kind = timeout.aborted ? "timeout" : "network";
        const delay = backoffDelay(attempt, policy.retry);
        if (canRetry && fitsDeadline(delay)) {
          policy.logger.warn("sevdesk request failed, retrying", {
            method,
            path,
            attempt,
            kind,
            delayMs: delay,
          });
          await policy.sleep(delay);
          continue;
        }
        if (kind === "timeout") {
          throw new SevdeskError(
            "timeout",
            `sevdesk did not answer within ${attemptTimeoutMs} ms.`,
          );
        }
        const code = networkErrorCode(error);
        throw new SevdeskError("network", `Could not reach sevdesk${code ? ` (${code})` : ""}.`);
      }

      policy.logger.debug("sevdesk request", {
        method,
        path,
        status: response.status,
        attempt,
        durationMs: Math.round(performance.now() - started),
      });

      if (!canRetry || !isRetryableStatus(response.status)) return response;

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
      await policy.sleep(delay);
    }
  };
}

export function createSevdeskClient(options: SevdeskClientOptions): SevdeskClient {
  const redact: Redactor = createRedactor([options.token]);
  const policy: FetchPolicy = {
    timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    deadlineMs: options.deadlineMs ?? DEFAULT_DEADLINE_MS,
    retry: { ...DEFAULT_RETRY, ...options.retry },
    logger: options.logger ?? silentLogger,
    sleep: options.sleep ?? realSleep,
    now: options.now ?? Date.now,
  };

  const api = createClient<paths>({
    baseUrl: options.baseUrl.replace(/\/+$/, ""),
    headers: {
      // sevdesk expects the raw token, without a "Bearer" prefix.
      Authorization: options.token,
      "User-Agent": options.userAgent ?? USER_AGENT,
      Accept: "application/json",
    },
    fetch: createPolicyFetch(policy),
  });

  return {
    api,
    async call<T>(request: Promise<ApiResult<T>>): Promise<T> {
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
        status: response.status,
        body: error,
        retryAfter: response.headers.get("retry-after"),
        redact,
      });
    },
  };
}
