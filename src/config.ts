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
/**
 * Requests per second per API token. sevdesk documents no figure for its
 * throttle, so this is a conservative guess; 429 answers are retried anyway.
 */
export const DEFAULT_RATE_LIMIT = 4;
export const MAX_RATE_LIMIT = 100;

export interface Config {
  sevdeskApiToken: string;
  mode: Mode;
  baseUrl: string;
  logLevel: LogLevel;
  /** SEVDESK_ALLOWED_TOOLS. Optional whitelist; it only ever narrows the tool set. */
  allowedTools?: readonly string[];
  /** SEVDESK_DENIED_TOOLS. Blocks single tools; always wins. */
  deniedTools: readonly string[];
  /**
   * SEVDESK_ENABLE_TOOLS. Switches on tools that are off by default: every
   * X tool, R+ tools and tools marked defaultEnabled: false. For X tools the
   * listing also counts as the operator's release for clients without
   * elicitation.
   */
  enableTools: readonly string[];
  /** SEVDESK_API_ALLOW. Undefined: the curated default list of the fallback. */
  apiAllow?: readonly string[];
  /** SEVDESK_CONFIRM_SECRET, HMAC key for confirmation tokens. */
  confirmSecret?: string;
  confirmTtlSeconds: number;
  /**
   * SEVDESK_RATE_LIMIT. Requests per second per API token; 0 switches
   * pacing off. loadConfig always sets it; unset (hand-built configs in
   * tests) also means off.
   */
  rateLimit?: number;
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
  SEVDESK_ENABLE_TOOLS: nameList("tool name"),
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
  // Plain decimal only: Number() would also take "0x10", "1e3" or "Infinity".
  SEVDESK_RATE_LIMIT: z.preprocess(
    blankToUndefined,
    z
      .string({ error: "must be a number of requests per second" })
      .trim()
      .regex(/^\d+(\.\d+)?$/, { error: "must be a number of requests per second, e.g. 4 or 0.5" })
      .transform(Number)
      .refine((value) => value <= MAX_RATE_LIMIT, {
        error: `must be between 0 (off) and ${MAX_RATE_LIMIT}`,
      })
      .default(DEFAULT_RATE_LIMIT),
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
    enableTools: data.SEVDESK_ENABLE_TOOLS ?? [],
    ...(data.SEVDESK_API_ALLOW && { apiAllow: data.SEVDESK_API_ALLOW }),
    ...(data.SEVDESK_CONFIRM_SECRET && { confirmSecret: data.SEVDESK_CONFIRM_SECRET }),
    confirmTtlSeconds: data.SEVDESK_CONFIRM_TTL_SECONDS,
    rateLimit: data.SEVDESK_RATE_LIMIT,
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

/**
 * Removes the named secrets from each environment once the config holds
 * them, so code running later in this process (a dependency, a tool) cannot
 * read them from process.env and child processes do not inherit them.
 *
 * This does not protect against local readers of the environment the
 * process was started with: the parent, /proc/<pid>/environ on Linux or
 * `ps eww` on macOS still show the original values.
 */
export function forgetSecrets(
  names: readonly string[],
  ...envs: Array<Record<string, string | undefined>>
): void {
  for (const env of envs) for (const name of names) delete env[name];
}

/**
 * JWS algorithms a token may be signed with. Only asymmetric ones: a JWKS
 * holds public keys, so HS* would invite key confusion, and `none` must
 * never be accepted.
 */
export const JWT_ALGORITHMS = [
  "RS256",
  "RS384",
  "RS512",
  "PS256",
  "PS384",
  "PS512",
  "ES256",
  "ES384",
  "ES512",
  "EdDSA",
  "Ed25519",
] as const;

export const DEFAULT_PORT = 3000;

/** Variables of the HTTP transport that can carry a secret (a Redis password). */
export const HTTP_SECRET_ENV_VARIABLES = ["REDIS_URL"] as const;

export interface HttpConfig {
  /** PORT. 0 picks a free port (tests). */
  port: number;
  /** MCP_RESOURCE_URL: public URL of the MCP endpoint and the expected token audience. */
  resourceUrl: URL;
  /** MCP_ALLOWED_HOSTS: Host header allowlist; default the host of MCP_RESOURCE_URL. */
  allowedHosts: readonly string[];
  /** OAUTH_ISSUER: expected `iss`, compared as an exact string. */
  issuer: string;
  /** OAUTH_JWKS_URL: public keys of the issuer. */
  jwksUrl: URL;
  /** OAUTH_ALGORITHMS: allowed JWS algorithms, asymmetric only. */
  algorithms: readonly string[];
  /** REDIS_URL: shared store for single-use nonces. Can hold a password. */
  redisUrl: string;
  /** OAUTH_ALLOW_INSECURE_HTTP: accept http for issuer and JWKS (local development only). */
  allowInsecureHttp: boolean;
}

type UrlCheck = { ok: true; url: URL } | { ok: false; error: string };

/** Absolute http(s) URL without credentials and fragment; plain http only if `allowHttp`. */
function checkHttpsUrl(value: string, allowHttp: (url: URL) => boolean): UrlCheck {
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    return { ok: false, error: "must be an absolute https URL" };
  }
  if (url.username !== "" || url.password !== "") {
    return { ok: false, error: "must not contain credentials" };
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    return { ok: false, error: "must be an absolute https URL" };
  }
  if (url.protocol === "http:" && !allowHttp(url)) {
    return { ok: false, error: "must use https" };
  }
  if (url.hash !== "" || value.includes("#")) {
    return { ok: false, error: "must not contain a fragment" };
  }
  return { ok: true, url };
}

const booleanFlag = z.preprocess(
  blankToUndefined,
  z
    .enum(["true", "false"], { error: "must be true or false" })
    .default("false")
    .transform((value) => value === "true"),
);

const HOST_PATTERN =
  /^(\[[0-9a-f:.]+\]|[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*)$/;

// Fixed messages only: REDIS_URL can carry a password, and zod must not
// echo it into a startup error.
const httpEnvSchema = z.object({
  PORT: z.preprocess(
    blankToUndefined,
    z.coerce
      .number({ error: "must be a port number" })
      .int({ error: "must be a port number" })
      .min(0, { error: "must be between 0 and 65535" })
      .max(65535, { error: "must be between 0 and 65535" })
      .default(DEFAULT_PORT),
  ),
  MCP_RESOURCE_URL: z.preprocess(blankToUndefined, z.string({ error: "is required" })),
  MCP_ALLOWED_HOSTS: z.preprocess(
    blankToUndefined,
    z
      .string({ error: "must be a comma-separated list of host names" })
      .transform((value, ctx) => {
        const hosts = [
          ...new Set(
            value
              .split(",")
              .map((host) => host.trim().toLowerCase())
              .filter((host) => host !== ""),
          ),
        ];
        if (hosts.length === 0 || !hosts.every((host) => HOST_PATTERN.test(host))) {
          ctx.addIssue({ code: "custom", message: "must be a comma-separated list of host names" });
          return z.NEVER;
        }
        return hosts;
      })
      .optional(),
  ),
  OAUTH_ISSUER: z.preprocess(blankToUndefined, z.string({ error: "is required" }).trim()),
  OAUTH_JWKS_URL: z.preprocess(blankToUndefined, z.string({ error: "is required" })),
  OAUTH_ALGORITHMS: z.preprocess(
    blankToUndefined,
    z
      .string({ error: "must be a comma-separated list" })
      .default("RS256")
      .transform((value, ctx) => {
        const algorithms = [
          ...new Set(
            value
              .split(",")
              .map((alg) => alg.trim())
              .filter((alg) => alg !== ""),
          ),
        ];
        if (algorithms.length === 0) {
          ctx.addIssue({ code: "custom", message: "must name at least one algorithm" });
          return z.NEVER;
        }
        for (const alg of algorithms) {
          if (!(JWT_ALGORITHMS as readonly string[]).includes(alg)) {
            ctx.addIssue({
              code: "custom",
              message: `must only contain asymmetric algorithms (${JWT_ALGORITHMS.join(", ")})`,
            });
            return z.NEVER;
          }
        }
        return algorithms;
      }),
  ),
  REDIS_URL: z.preprocess(
    blankToUndefined,
    z
      .string({ error: "is required for the HTTP transport (shared replay protection)" })
      .refine(
        (value) => {
          try {
            const url = new URL(value.trim());
            return (url.protocol === "redis:" || url.protocol === "rediss:") && url.hostname !== "";
          } catch {
            return false;
          }
        },
        { error: "must be a redis:// or rediss:// URL" },
      )
      .transform((value) => value.trim()),
  ),
  OAUTH_ALLOW_INSECURE_HTTP: booleanFlag,
});

/**
 * Configuration of the HTTP transport, on top of loadConfig. Kept apart so
 * the stdio entrypoint neither needs nor validates these variables.
 */
export function loadHttpConfig(env: Record<string, string | undefined> = process.env): HttpConfig {
  const result = httpEnvSchema.safeParse(env);
  if (!result.success) {
    throw new ConfigError(
      result.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`),
    );
  }
  const { data } = result;
  const issues: string[] = [];
  const insecure = data.OAUTH_ALLOW_INSECURE_HTTP;

  // The resource URL is what clients connect to and what tokens are issued
  // for. Plain http only for a server on this machine.
  const resource = checkHttpsUrl(data.MCP_RESOURCE_URL, (url) => LOOPBACK_HOSTS.has(url.hostname));
  if (!resource.ok) issues.push(`MCP_RESOURCE_URL: ${resource.error}`);
  else if (resource.url.search !== "") issues.push("MCP_RESOURCE_URL: must not contain a query");
  else if (
    resource.url.pathname.replace(/\/+$/, "") === "/healthz" ||
    resource.url.pathname.startsWith("/.well-known/")
  ) {
    issues.push("MCP_RESOURCE_URL: path collides with /healthz or /.well-known/");
  }

  // Keys fetched over plain http could be swapped on the way, and the
  // issuer is where clients send users to log in. http only with the
  // explicit local flag.
  const jwks = checkHttpsUrl(data.OAUTH_JWKS_URL, () => insecure);
  if (!jwks.ok) {
    issues.push(
      `OAUTH_JWKS_URL: ${jwks.error}${jwks.error === "must use https" ? " (http only with OAUTH_ALLOW_INSECURE_HTTP=true, for local development)" : ""}`,
    );
  }
  const issuer = checkHttpsUrl(data.OAUTH_ISSUER, () => insecure);
  if (!issuer.ok) {
    issues.push(
      `OAUTH_ISSUER: ${issuer.error}${issuer.error === "must use https" ? " (http only with OAUTH_ALLOW_INSECURE_HTTP=true, for local development)" : ""}`,
    );
  }

  if (!resource.ok || !jwks.ok || !issuer.ok || issues.length > 0) throw new ConfigError(issues);
  return {
    port: data.PORT,
    resourceUrl: resource.url,
    allowedHosts: data.MCP_ALLOWED_HOSTS ?? [resource.url.hostname.toLowerCase()],
    // Compared as written: `iss` must match this string exactly.
    issuer: data.OAUTH_ISSUER,
    jwksUrl: jwks.url,
    algorithms: data.OAUTH_ALGORITHMS,
    redisUrl: data.REDIS_URL,
    allowInsecureHttp: insecure,
  };
}
