import { z } from "zod";
import { LOG_LEVELS, type LogLevel } from "./logger.js";

export const MODES = ["read", "write"] as const;
export type Mode = (typeof MODES)[number];

export const DEFAULT_BASE_URL = "https://my.sevdesk.de/api/v1";

export interface Config {
  sevdeskApiToken: string;
  mode: Mode;
  baseUrl: string;
  logLevel: LogLevel;
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
  };
}
