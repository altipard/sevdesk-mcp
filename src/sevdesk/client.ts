import createClient, { type Client } from "openapi-fetch";
import type { paths } from "../generated/sevdesk.js";
import { type Logger, silentLogger } from "../logger.js";
import { enforceRequestPins, PinViolation } from "../policy/pins.js";
import { createRedactor, type Redactor } from "../redact.js";
import { USER_AGENT } from "../version.js";
import { mapHttpError, OUTCOME_UNKNOWN, parseRetryAfter, SevdeskError } from "./errors.js";

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
  /** Upper bound for one response body; larger answers are dropped while streaming. */
  maxResponseBytes?: number;
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
  /**
   * Same client without retries, also for GET. For operations with side
   * effects behind a GET (export jobs, sendByWithRender): repeating them
   * after a timeout could run them twice.
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
  baseUrl: string;
  maxResponseBytes: number;
  /**
   * The request may have a side effect even if it is a GET (single-attempt
   * client). Failures then carry the "outcome unknown" warning.
   */
  sideEffects: boolean;
  timeoutMs: number;
  deadlineMs: number;
  retry: RetryOptions;
  logger: Logger;
  sleep: (ms: number) => Promise<void>;
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
 * fetch with a per-attempt timeout, an overall deadline and retries.
 * Retries happen only for GET: repeating a write could create or send
 * something twice.
 */
function createPolicyFetch(policy: FetchPolicy): (request: Request) => Promise<Response> {
  return async (original) => {
    // Pins (preventSendBy, enshrine flags) hold for every caller of the
    // client, not only for the fallback that checks them up front.
    let request: Request;
    try {
      request = await enforceRequestPins(original, policy.baseUrl);
    } catch (error) {
      if (error instanceof PinViolation) throw new SevdeskError("policy", error.message);
      throw error;
    }
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

    for (let attempt = 1; ; attempt++) {
      const attemptTimeoutMs = Math.max(1, Math.min(policy.timeoutMs, deadline - policy.now()));
      const timeout = AbortSignal.timeout(attemptTimeoutMs);
      const signal = AbortSignal.any([request.signal, timeout]);
      const started = performance.now();
      const canRetry = attempt < maxAttempts;
      let response: Response;

      try {
        const raw = await untilAborted(fetch(new Request(request, { signal })), signal);
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
          await policy.sleep(delay);
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
    baseUrl: options.baseUrl,
    maxResponseBytes: options.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES,
    sideEffects: false,
    timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    deadlineMs: options.deadlineMs ?? DEFAULT_DEADLINE_MS,
    retry: { ...DEFAULT_RETRY, ...options.retry },
    logger: options.logger ?? silentLogger,
    sleep: options.sleep ?? realSleep,
    now: options.now ?? Date.now,
  };

  const clientFor = (fetchPolicy: FetchPolicy) =>
    createClient<paths>({
      baseUrl: options.baseUrl.replace(/\/+$/, ""),
      headers: {
        // sevdesk expects the raw token, without a "Bearer" prefix.
        Authorization: options.token,
        "User-Agent": options.userAgent ?? USER_AGENT,
        Accept: "application/json",
      },
      fetch: createPolicyFetch(fetchPolicy),
    });
  const api = clientFor(policy);
  const apiSingleAttempt = clientFor({
    ...policy,
    sideEffects: true,
    retry: { ...policy.retry, maxRetries: 0 },
  });

  return {
    api,
    apiSingleAttempt,
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
        outcomeUnknown: response.headers.get(OUTCOME_HEADER) === "unknown",
        status: response.status,
        body: error,
        retryAfter: response.headers.get("retry-after"),
        redact,
      });
    },
  };
}
