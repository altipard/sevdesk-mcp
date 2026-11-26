import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";

/**
 * Confirmation tokens for W+ and X actions.
 *
 * The first call of such an action returns a preview and a token; only a
 * second call with the same arguments and that token executes it. The token
 * is an HMAC over tool, canonical argument hash, subject, expiry and a nonce.
 * It proves that a preview was fetched for exactly these arguments by the
 * same subject a short time ago. It does not prove that a human saw it: an
 * injected model can make both calls. Human approval is elicitation's job.
 *
 * Format: `v1.<base64url(JSON claims)>.<base64url(HMAC-SHA256)>`.
 */

export const DEFAULT_CONFIRM_TTL_MS = 5 * 60 * 1000;
const VERSION = "v1";
const MAX_TOKEN_LENGTH = 2048;

export interface ConfirmationClaims {
  /** Tool name, for the fallback `sevdesk_api_request:<operationId>`. */
  readonly tool: string;
  readonly argsHash: string;
  readonly subject: string;
  /** Unix time in milliseconds. */
  readonly expiresAt: number;
  readonly nonce: string;
}

export interface ConfirmationRequest {
  readonly tool: string;
  readonly args: unknown;
  readonly subject: string;
}

export interface IssuedConfirmation {
  readonly token: string;
  readonly expiresAt: number;
}

export type RejectReason =
  | "malformed"
  | "bad_signature"
  | "expired"
  | "wrong_tool"
  | "wrong_arguments"
  | "wrong_subject";

export type VerifyResult =
  | { readonly ok: true; readonly claims: ConfirmationClaims }
  | { readonly ok: false; readonly reason: RejectReason };

export interface ConfirmationSigner {
  issue(request: ConfirmationRequest): IssuedConfirmation;
  verify(token: string, request: ConfirmationRequest): VerifyResult;
}

export interface SignerOptions {
  secret: Buffer;
  ttlMs?: number;
  now?: () => number;
}

/**
 * JSON with object keys sorted at every level, so the same arguments always
 * hash the same regardless of key order. `undefined` members are dropped,
 * as JSON.stringify does; values JSON cannot represent are rejected instead
 * of being silently changed.
 */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value === "boolean" || typeof value === "string") {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError("cannot hash a non-finite number");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => (item === undefined ? "null" : canonicalJson(item))).join(",")}]`;
  }
  if (typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`).join(",")}}`;
  }
  throw new TypeError(`cannot hash a value of type ${typeof value}`);
}

export function argumentHash(args: unknown): string {
  return createHash("sha256").update(canonicalJson(args)).digest("base64url");
}

function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  // timingSafeEqual needs equal lengths. Comparing against itself keeps the
  // time independent of where a mismatch is, also for the length check.
  if (left.length !== right.length) {
    timingSafeEqual(left, left);
    return false;
  }
  return timingSafeEqual(left, right);
}

function parseClaims(encoded: string): ConfirmationClaims | undefined {
  let raw: unknown;
  try {
    raw = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8"));
  } catch {
    return undefined;
  }
  if (typeof raw !== "object" || raw === null) return undefined;
  const { t, h, s, e, n } = raw as Record<string, unknown>;
  if (
    typeof t !== "string" ||
    typeof h !== "string" ||
    typeof s !== "string" ||
    typeof e !== "number" ||
    !Number.isSafeInteger(e) ||
    typeof n !== "string" ||
    n === ""
  ) {
    return undefined;
  }
  return { tool: t, argsHash: h, subject: s, expiresAt: e, nonce: n };
}

export function createConfirmationSigner(options: SignerOptions): ConfirmationSigner {
  if (options.secret.length < 32)
    throw new RangeError("confirmation secret must be 32 bytes or more");
  const secret = Buffer.from(options.secret);
  const ttlMs = options.ttlMs ?? DEFAULT_CONFIRM_TTL_MS;
  const now = options.now ?? Date.now;
  const sign = (body: string) => createHmac("sha256", secret).update(body).digest("base64url");

  return {
    issue({ tool, args, subject }) {
      const expiresAt = now() + ttlMs;
      const claims = {
        t: tool,
        h: argumentHash(args),
        s: subject,
        e: expiresAt,
        n: randomBytes(16).toString("base64url"),
      };
      const body = `${VERSION}.${Buffer.from(JSON.stringify(claims)).toString("base64url")}`;
      return { token: `${body}.${sign(body)}`, expiresAt };
    },

    verify(token, { tool, args, subject }) {
      if (typeof token !== "string" || token.length > MAX_TOKEN_LENGTH) {
        return { ok: false, reason: "malformed" };
      }
      const parts = token.split(".");
      if (parts.length !== 3 || parts[0] !== VERSION) return { ok: false, reason: "malformed" };
      const [version, payload, signature] = parts as [string, string, string];
      // The signature is checked before the payload is even parsed, so
      // nothing an attacker writes into the claims is interpreted unsigned.
      if (!safeEqual(signature, sign(`${version}.${payload}`))) {
        return { ok: false, reason: "bad_signature" };
      }
      const claims = parseClaims(payload);
      if (claims === undefined) return { ok: false, reason: "malformed" };
      if (claims.expiresAt <= now()) return { ok: false, reason: "expired" };
      if (!safeEqual(claims.tool, tool)) return { ok: false, reason: "wrong_tool" };
      if (!safeEqual(claims.argsHash, argumentHash(args))) {
        return { ok: false, reason: "wrong_arguments" };
      }
      if (!safeEqual(claims.subject, subject)) return { ok: false, reason: "wrong_subject" };
      return { ok: true, claims };
    },
  };
}
