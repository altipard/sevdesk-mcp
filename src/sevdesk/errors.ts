import type { Redactor } from "../redact.js";

export type SevdeskErrorKind =
  | "bad_request"
  | "unauthorized"
  | "forbidden"
  | "not_found"
  | "validation"
  | "rate_limited"
  | "server_error"
  | "http_error"
  | "timeout"
  | "network";

export interface SevdeskErrorDetails {
  status?: number;
  /** sevdesk's identifier for this failure, useful for their support. */
  exceptionUUID?: string;
  retryAfterSeconds?: number;
}

/**
 * Error raised for every failed sevdesk call. The message is written for
 * the person reading the tool result. It deliberately carries no request,
 * response, headers or cause, so neither the token nor request data can
 * leak through inspection or serialization.
 */
export class SevdeskError extends Error {
  override readonly name = "SevdeskError";
  readonly kind: SevdeskErrorKind;
  readonly status: number | undefined;
  readonly exceptionUUID: string | undefined;
  readonly retryAfterSeconds: number | undefined;

  constructor(kind: SevdeskErrorKind, message: string, details: SevdeskErrorDetails = {}) {
    super(message);
    this.kind = kind;
    this.status = details.status;
    this.exceptionUUID = details.exceptionUUID;
    this.retryAfterSeconds = details.retryAfterSeconds;
  }
}

const MAX_UPSTREAM_MESSAGE = 500;

interface UpstreamError {
  message?: string;
  exceptionUUID?: string;
}

function readUpstreamError(body: unknown): UpstreamError {
  if (typeof body === "string") return { message: body };
  if (typeof body !== "object" || body === null) return {};
  const inner = (body as { error?: unknown }).error;
  const source = typeof inner === "object" && inner !== null ? inner : body;
  const { message, exceptionUUID } = source as Record<string, unknown>;
  return {
    ...(typeof message === "string" ? { message } : {}),
    ...(typeof exceptionUUID === "string" ? { exceptionUUID } : {}),
  };
}

function clean(text: string, redact: Redactor): string {
  const singleLine = redact(text).replace(/\s+/g, " ").trim();
  return singleLine.length > MAX_UPSTREAM_MESSAGE
    ? `${singleLine.slice(0, MAX_UPSTREAM_MESSAGE)}…`
    : singleLine;
}

// IMF-fixdate, the HTTP date format servers must send (RFC 9110 5.6.7).
const HTTP_DATE =
  /^(Mon|Tue|Wed|Thu|Fri|Sat|Sun), \d{2} [A-Z][a-z]{2} \d{4} \d{2}:\d{2}:\d{2} GMT$/;

/**
 * Parses Retry-After (delta seconds or HTTP date) into milliseconds.
 * Anything else, e.g. "1.5" or "-5", is ignored instead of being guessed
 * at by Date.parse.
 */
export function parseRetryAfter(
  value: string | null,
  now: number = Date.now(),
): number | undefined {
  if (value === null) return undefined;
  const trimmed = value.trim();
  if (/^\d+$/.test(trimmed)) return Number(trimmed) * 1000;
  if (!HTTP_DATE.test(trimmed)) return undefined;
  const date = Date.parse(trimmed);
  if (Number.isNaN(date)) return undefined;
  return Math.max(0, date - now);
}

export interface HttpErrorInput {
  status: number;
  body: unknown;
  retryAfter: string | null;
  redact: Redactor;
}

export function mapHttpError({ status, body, retryAfter, redact }: HttpErrorInput): SevdeskError {
  const upstream = readUpstreamError(body);
  const detail = upstream.message ? `: ${clean(upstream.message, redact)}` : "";
  const details: SevdeskErrorDetails = { status };
  if (upstream.exceptionUUID) details.exceptionUUID = clean(upstream.exceptionUUID, redact);

  switch (status) {
    case 400:
      return new SevdeskError(
        "bad_request",
        `sevdesk rejected the request (400)${detail}`,
        details,
      );
    case 401:
      // Never echo the upstream text here: it is the most likely place for
      // an API to repeat the credential it rejected.
      return new SevdeskError(
        "unauthorized",
        "sevdesk rejected the API token (401). Check SEVDESK_API_TOKEN.",
        details,
      );
    case 403:
      return new SevdeskError(
        "forbidden",
        `The sevdesk API token is not allowed to do this (403)${detail}`,
        details,
      );
    case 404:
      return new SevdeskError(
        "not_found",
        `The requested sevdesk object does not exist (404)${detail}`,
        details,
      );
    case 422:
      return new SevdeskError(
        "validation",
        `sevdesk could not process the data (422)${detail}`,
        details,
      );
    case 429: {
      const retryMs = parseRetryAfter(retryAfter);
      if (retryMs !== undefined) details.retryAfterSeconds = Math.ceil(retryMs / 1000);
      const hint =
        details.retryAfterSeconds !== undefined
          ? ` Retry in ${details.retryAfterSeconds} s.`
          : " Retry later.";
      return new SevdeskError("rate_limited", `sevdesk rate limit reached (429).${hint}`, details);
    }
    default:
      if (status >= 500) {
        return new SevdeskError(
          "server_error",
          `sevdesk server error (${status})${detail}`,
          details,
        );
      }
      return new SevdeskError(
        "http_error",
        `Unexpected sevdesk response (${status})${detail}`,
        details,
      );
  }
}
