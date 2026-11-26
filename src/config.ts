import { randomBytes } from "node:crypto";
import { z } from "zod";
import { LOG_LEVELS, type LogLevel } from "./logger.js";
import { classOf } from "./policy/classification.js";

/**
 * read: only reading tools. write: also drafts, master data and status
 * changes with confirmation. full: also irreversible actions (X).
 */
export const MODES = ["read", "write", "full"] as const;
export type Mode = (typeof MODES)[number];

export const DEFAULT_BASE_URL = "https://my.sevdesk.de/api/v1";
export const DEFAULT_CONFIRM_TTL_SECONDS = 300;
export const MIN_CONFIRM_SECRET_LENGTH = 32;

export interface Config {
  sevdeskApiToken: string;
  mode: Mode;
  baseUrl: string;
  logLevel: LogLevel;
  /** SEVDESK_ALLOWED_TOOLS. Undefined: the default tool set. Set: exactly these tools. */
  allowedTools?: readonly string[];
  /** SEVDESK_DENIED_TOOLS. Always wins over the allowlist. */
  deniedTools: readonly string[];
  /** SEVDESK_API_ALLOW. Undefined: the curated default list of the fallback. */
  apiAllow?: readonly string[];
  /** SEVDESK_CONFIRM_SECRET, HMAC key for confirmation tokens. */
  confirmSecret?: string;
  confirmTtlSeconds: number;
}

export class ConfigError extends Error {
  override readonly name = "ConfigError";
  readonly issues: readonly string[];

  constructor(issues: readonly string[]) {
    super(`Invalid configuration:\n${issues.map((issue) => `  - ${issue}`).join("\n")}`);
    this.issues = issues;
  }
}

// Unset and empty variables are treated the same, so `FOO=` in an env file
// falls back to the default instead of failing validation.
const blankToUndefined = (value: unknown): unknown =>
  typeof value === "string" && value.trim() === "" ? undefined : value;

// sevdesk tokens are 32 hex characters. The wider set tolerates a format
// change, but excludes quotes, backslashes and control characters so the
// token reads the same in logs, JSON and headers and redaction can find it.
const TOKEN_PATTERN = /^[A-Za-z0-9._~+/=-]+$/;

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

type BaseUrlCheck = { ok: true; url: string } | { ok: false; error: string };

/**
 * The token is sent to this URL, so plain http is only accepted for local
 * mocks. Credentials, query and fragment are rejected: fetch refuses URLs
 * with credentials and would print them in its error.
 */
export function checkBaseUrl(value: string): BaseUrlCheck {
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    return { ok: false, error: "must be an absolute http(s) URL" };
  }
  if (url.username !== "" || url.password !== "") {
    return { ok: false, error: "must not contain credentials" };
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    return { ok: false, error: "must be an absolute http(s) URL" };
  }
  if (url.protocol === "http:" && !LOOPBACK_HOSTS.has(url.hostname)) {
    return { ok: false, error: "must use https (http is only allowed for localhost)" };
  }
  if (url.search !== "" || url.hash !== "" || value.includes("?") || value.includes("#")) {
    return { ok: false, error: "must not contain a query or fragment" };
  }
  return { ok: true, url: `${url.origin}${url.pathname}`.replace(/\/+$/, "") };
}

const NAME_PATTERN = /^[A-Za-z][A-Za-z0-9_]*$/;

/** Comma-separated list; blank means unset, so the default applies. */
const nameList = (what: string) =>
  z.preprocess(
    blankToUndefined,
    z
      .string({ error: "must be a comma-separated list" })
      .transform((value, ctx) => {
        const names = [
          ...new Set(
            value
              .split(",")
              .map((name) => name.trim())
              .filter((name) => name !== ""),
          ),
        ];
        for (const name of names) {
          if (!NAME_PATTERN.test(name)) {
            ctx.addIssue({ code: "custom", message: `contains an invalid ${what}: ${name}` });
            return z.NEVER;
          }
        }
        return names;
      })
      .optional(),
  );

// Every message is fixed text: zod must never echo the input, because for
// SEVDESK_API_TOKEN the input is the secret.
const envSchema = z.object({
  SEVDESK_API_TOKEN: z.preprocess(
    blankToUndefined,
    z
      .string({ error: "is required" })
      .trim()
      .regex(TOKEN_PATTERN, { error: "must contain only letters, digits and . _ ~ + / = -" }),
  ),
  SEVDESK_MODE: z.preprocess(
    blankToUndefined,
    z.enum(MODES, { error: `must be one of: ${MODES.join(", ")}` }).default("read"),
  ),
  SEVDESK_BASE_URL: z.preprocess(
    blankToUndefined,
    z
      .string({ error: "must be a string" })
      .default(DEFAULT_BASE_URL)
      .transform((value, ctx) => {
        const checked = checkBaseUrl(value);
        if (checked.ok) return checked.url;
        ctx.addIssue({ code: "custom", message: checked.error });
        return z.NEVER;
      }),
  ),
  LOG_LEVEL: z.preprocess(
    blankToUndefined,
    z.enum(LOG_LEVELS, { error: `must be one of: ${LOG_LEVELS.join(", ")}` }).default("info"),
  ),
  SEVDESK_ALLOWED_TOOLS: nameList("tool name"),
  SEVDESK_DENIED_TOOLS: nameList("tool name"),
  SEVDESK_API_ALLOW: nameList("operationId").superRefine((ids, ctx) => {
    for (const id of ids ?? []) {
      if (classOf(id) === undefined) {
        ctx.addIssue({ code: "custom", message: `unknown or unclassified operationId: ${id}` });
      }
    }
  }),
  SEVDESK_CONFIRM_SECRET: z.preprocess(
    blankToUndefined,
    z
      .string({ error: "must be a string" })
      .min(MIN_CONFIRM_SECRET_LENGTH, {
        error: `must be at least ${MIN_CONFIRM_SECRET_LENGTH} characters`,
      })
      .optional(),
  ),
  SEVDESK_CONFIRM_TTL_SECONDS: z.preprocess(
    blankToUndefined,
    z.coerce
      .number({ error: "must be a number of seconds" })
      .int({ error: "must be a whole number of seconds" })
      .min(30, { error: "must be between 30 and 3600" })
      .max(3600, { error: "must be between 30 and 3600" })
      .default(DEFAULT_CONFIRM_TTL_SECONDS),
  ),
});

export function loadConfig(env: Record<string, string | undefined> = process.env): Config {
  const result = envSchema.safeParse(env);
  if (!result.success) {
    throw new ConfigError(
      result.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`),
    );
  }
  const { data } = result;
  return {
    sevdeskApiToken: data.SEVDESK_API_TOKEN,
    mode: data.SEVDESK_MODE,
    baseUrl: data.SEVDESK_BASE_URL,
    logLevel: data.LOG_LEVEL,
    ...(data.SEVDESK_ALLOWED_TOOLS && { allowedTools: data.SEVDESK_ALLOWED_TOOLS }),
    deniedTools: data.SEVDESK_DENIED_TOOLS ?? [],
    ...(data.SEVDESK_API_ALLOW && { apiAllow: data.SEVDESK_API_ALLOW }),
    ...(data.SEVDESK_CONFIRM_SECRET && { confirmSecret: data.SEVDESK_CONFIRM_SECRET }),
    confirmTtlSeconds: data.SEVDESK_CONFIRM_TTL_SECONDS,
  };
}

/**
 * HMAC key for confirmation tokens.
 *
 * stdio: SEVDESK_CONFIRM_SECRET is optional. Without it every process draws
 * a random key, so tokens die with the process; that is fine for a local
 * single-user server and avoids a secret users would have to manage.
 *
 * http: required. Several instances or a restart behind a load balancer
 * must accept each other's tokens, and a random per-process key would make
 * confirmations fail at random. The HTTP entrypoint calls this at startup.
 */
export function confirmSecretFor(config: Config, transport: "stdio" | "http"): Buffer {
  if (config.confirmSecret !== undefined) return Buffer.from(config.confirmSecret, "utf8");
  if (transport === "http") {
    throw new ConfigError(["SEVDESK_CONFIRM_SECRET: is required for the HTTP transport"]);
  }
  return randomBytes(32);
}
