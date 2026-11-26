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

// Every message is fixed text: zod must never echo the input, because for
// SEVDESK_API_TOKEN the input is the secret.
const envSchema = z.object({
  SEVDESK_API_TOKEN: z.preprocess(
    blankToUndefined,
    z
      .string({ error: "is required" })
      .trim()
      .regex(/^\S+$/, { error: "must not contain whitespace" }),
  ),
  SEVDESK_MODE: z.preprocess(
    blankToUndefined,
    z.enum(MODES, { error: `must be one of: ${MODES.join(", ")}` }).default("read"),
  ),
  SEVDESK_BASE_URL: z.preprocess(
    blankToUndefined,
    z
      .url({ protocol: /^https?$/, error: "must be an http(s) URL" })
      .default(DEFAULT_BASE_URL)
      .transform((url) => url.replace(/\/+$/, "")),
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
