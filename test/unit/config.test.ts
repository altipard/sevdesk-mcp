import { describe, expect, it } from "vitest";
import {
  ConfigError,
  confirmSecretFor,
  DEFAULT_BASE_URL,
  DEFAULT_CONFIRM_TTL_SECONDS,
  loadConfig,
} from "../../src/config.js";
import { errorRepresentations, TEST_TOKEN } from "../helpers.js";

function configError(env: Record<string, string | undefined>): ConfigError {
  try {
    loadConfig(env);
  } catch (error) {
    expect(error).toBeInstanceOf(ConfigError);
    return error as ConfigError;
  }
  throw new Error("expected loadConfig to throw");
}

describe("loadConfig", () => {
  it("applies defaults when only the token is set", () => {
    expect(loadConfig({ SEVDESK_API_TOKEN: TEST_TOKEN })).toEqual({
      sevdeskApiToken: TEST_TOKEN,
      mode: "read",
      baseUrl: DEFAULT_BASE_URL,
      logLevel: "info",
      deniedTools: [],
      enableTools: [],
      confirmTtlSeconds: DEFAULT_CONFIRM_TTL_SECONDS,
    });
  });

  it("accepts all variables and normalises them", () => {
    expect(
      loadConfig({
        SEVDESK_API_TOKEN: `  ${TEST_TOKEN}\n`,
        SEVDESK_MODE: "write",
        SEVDESK_BASE_URL: "http://127.0.0.1:8080/api/v1//",
        LOG_LEVEL: "debug",
      }),
    ).toEqual({
      sevdeskApiToken: TEST_TOKEN,
      mode: "write",
      baseUrl: "http://127.0.0.1:8080/api/v1",
      logLevel: "debug",
      deniedTools: [],
      enableTools: [],
      confirmTtlSeconds: DEFAULT_CONFIRM_TTL_SECONDS,
    });
  });

  it("treats empty optional variables as unset", () => {
    const config = loadConfig({
      SEVDESK_API_TOKEN: TEST_TOKEN,
      SEVDESK_MODE: "",
      SEVDESK_BASE_URL: " ",
      LOG_LEVEL: "",
    });
    expect(config.mode).toBe("read");
    expect(config.baseUrl).toBe(DEFAULT_BASE_URL);
    expect(config.logLevel).toBe("info");
  });

  it.each([
    ["missing", undefined],
    ["empty", ""],
    ["blank", "   "],
  ])("requires the token (%s)", (_label, value) => {
    const error = configError({ SEVDESK_API_TOKEN: value });
    expect(error.issues).toEqual(["SEVDESK_API_TOKEN: is required"]);
    expect(error.message).toContain("SEVDESK_API_TOKEN: is required");
  });

  it("reports every invalid variable at once", () => {
    const error = configError({
      SEVDESK_MODE: "admin",
      SEVDESK_BASE_URL: "ftp://example.com",
      LOG_LEVEL: "verbose",
    });
    expect(error.issues).toEqual([
      "SEVDESK_API_TOKEN: is required",
      "SEVDESK_MODE: must be one of: read, write, full",
      "SEVDESK_BASE_URL: must be an absolute http(s) URL",
      "LOG_LEVEL: must be one of: debug, info, warn, error",
    ]);
  });

  it("rejects a malformed token without echoing it", () => {
    const malformed = `${TEST_TOKEN} leaked-part`;
    const error = configError({ SEVDESK_API_TOKEN: malformed, SEVDESK_MODE: "nope" });
    expect(error.issues).toContain(
      "SEVDESK_API_TOKEN: must contain only letters, digits and . _ ~ + / = -",
    );
    const text = errorRepresentations(error);
    expect(text).not.toContain(TEST_TOKEN);
    expect(text).not.toContain("leaked-part");
    expect(text).not.toContain("nope");
  });

  it("does not echo the token when other variables are invalid", () => {
    const error = configError({ SEVDESK_API_TOKEN: TEST_TOKEN, SEVDESK_BASE_URL: "not a url" });
    expect(errorRepresentations(error)).not.toContain(TEST_TOKEN);
  });

  it.each([
    ['"quote', `${TEST_TOKEN}"`],
    ["backslash", `${TEST_TOKEN}\\`],
    ["control character", `${TEST_TOKEN}\u0001`],
  ])("rejects a token with a %s", (_label, token) => {
    const error = configError({ SEVDESK_API_TOKEN: token });
    expect(error.issues).toEqual([
      "SEVDESK_API_TOKEN: must contain only letters, digits and . _ ~ + / = -",
    ]);
  });
});

describe("SEVDESK_BASE_URL", () => {
  const baseUrl = (value: string) =>
    loadConfig({ SEVDESK_API_TOKEN: TEST_TOKEN, SEVDESK_BASE_URL: value }).baseUrl;

  it.each([
    ["https://my.sevdesk.de/api/v1/", "https://my.sevdesk.de/api/v1"],
    ["http://localhost:4010/api/v1", "http://localhost:4010/api/v1"],
    ["http://127.0.0.1/api/v1", "http://127.0.0.1/api/v1"],
    ["http://[::1]:8080/api/v1", "http://[::1]:8080/api/v1"],
  ])("accepts %s", (value, expected) => {
    expect(baseUrl(value)).toBe(expected);
  });

  it.each([
    ["http://sevdesk.example/api/v1", "must use https (http is only allowed for localhost)"],
    ["http://127.0.0.2/api/v1", "must use https (http is only allowed for localhost)"],
    ["https://my.sevdesk.de/api/v1?x=1", "must not contain a query or fragment"],
    ["https://my.sevdesk.de/api/v1#frag", "must not contain a query or fragment"],
    ["https://my.sevdesk.de/api/v1?", "must not contain a query or fragment"],
    ["ftp://my.sevdesk.de/api/v1", "must be an absolute http(s) URL"],
    ["/api/v1", "must be an absolute http(s) URL"],
  ])("rejects %s", (value, message) => {
    const error = configError({ SEVDESK_API_TOKEN: TEST_TOKEN, SEVDESK_BASE_URL: value });
    expect(error.issues).toEqual([`SEVDESK_BASE_URL: ${message}`]);
  });

  it.each([
    "https://user:s3cr3t-pw@my.sevdesk.de/api/v1",
    "http://user:s3cr3t-pw@localhost/api/v1",
    "https://s3cr3t-pw@my.sevdesk.de/api/v1",
  ])("rejects credentials without echoing them (%s)", (value) => {
    const error = configError({ SEVDESK_API_TOKEN: TEST_TOKEN, SEVDESK_BASE_URL: value });
    expect(error.issues).toEqual(["SEVDESK_BASE_URL: must not contain credentials"]);
    const text = errorRepresentations(error);
    expect(text).not.toContain("s3cr3t-pw");
    expect(text).not.toContain(TEST_TOKEN);
  });
});

describe("SEVDESK_MODE", () => {
  it.each(["read", "write", "full"] as const)("accepts %s", (mode) => {
    expect(loadConfig({ SEVDESK_API_TOKEN: TEST_TOKEN, SEVDESK_MODE: mode }).mode).toBe(mode);
  });
});

describe("tool and operation lists", () => {
  const load = (env: Record<string, string>) =>
    loadConfig({ SEVDESK_API_TOKEN: TEST_TOKEN, ...env });

  it("parses comma-separated lists, trims and drops duplicates", () => {
    const config = load({
      SEVDESK_ALLOWED_TOOLS: " get_account_info, sevdesk_api_request ,get_account_info,",
      SEVDESK_DENIED_TOOLS: "sevdesk_api_request",
      SEVDESK_ENABLE_TOOLS: "send_invoice_email",
      SEVDESK_API_ALLOW: "getContacts,getInvoices",
    });
    expect(config.allowedTools).toEqual(["get_account_info", "sevdesk_api_request"]);
    expect(config.deniedTools).toEqual(["sevdesk_api_request"]);
    expect(config.enableTools).toEqual(["send_invoice_email"]);
    expect(config.apiAllow).toEqual(["getContacts", "getInvoices"]);
  });

  it("leaves unset and blank lists undefined so the defaults apply", () => {
    const config = load({ SEVDESK_ALLOWED_TOOLS: " ", SEVDESK_API_ALLOW: "" });
    expect(config.allowedTools).toBeUndefined();
    expect(config.apiAllow).toBeUndefined();
    expect(config.deniedTools).toEqual([]);
    expect(config.enableTools).toEqual([]);
  });

  it("rejects names with characters outside identifiers", () => {
    const error = configError({ SEVDESK_API_TOKEN: TEST_TOKEN, SEVDESK_DENIED_TOOLS: "a b,c/d" });
    expect(error.issues).toEqual(["SEVDESK_DENIED_TOOLS: contains an invalid tool name: a b"]);
  });

  it("rejects operationIds the classification does not know", () => {
    const error = configError({
      SEVDESK_API_TOKEN: TEST_TOKEN,
      SEVDESK_API_ALLOW: "getContacts,dropDatabase",
    });
    expect(error.issues).toEqual([
      "SEVDESK_API_ALLOW: unknown or unclassified operationId: dropDatabase",
    ]);
  });
});

describe("confirmation settings", () => {
  const secret = "s".repeat(32);

  it("accepts a secret of at least 32 characters and a TTL", () => {
    const config = loadConfig({
      SEVDESK_API_TOKEN: TEST_TOKEN,
      SEVDESK_CONFIRM_SECRET: secret,
      SEVDESK_CONFIRM_TTL_SECONDS: "120",
    });
    expect(config.confirmSecret).toBe(secret);
    expect(config.confirmTtlSeconds).toBe(120);
  });

  it("rejects a short secret without echoing it", () => {
    const error = configError({
      SEVDESK_API_TOKEN: TEST_TOKEN,
      SEVDESK_CONFIRM_SECRET: "short-secret",
    });
    expect(error.issues).toEqual(["SEVDESK_CONFIRM_SECRET: must be at least 32 characters"]);
    expect(errorRepresentations(error)).not.toContain("short-secret");
  });

  it.each(["10", "4000", "1.5", "soon"])("rejects the TTL %s", (value) => {
    const error = configError({
      SEVDESK_API_TOKEN: TEST_TOKEN,
      SEVDESK_CONFIRM_TTL_SECONDS: value,
    });
    expect(error.issues[0]).toMatch(/^SEVDESK_CONFIRM_TTL_SECONDS: must be/);
  });

  it("uses the configured secret on both transports", () => {
    const config = loadConfig({ SEVDESK_API_TOKEN: TEST_TOKEN, SEVDESK_CONFIRM_SECRET: secret });
    expect(confirmSecretFor(config, "stdio").toString()).toBe(secret);
    expect(confirmSecretFor(config, "http").toString()).toBe(secret);
  });

  it("draws a random secret per call on stdio when none is configured", () => {
    const config = loadConfig({ SEVDESK_API_TOKEN: TEST_TOKEN });
    const a = confirmSecretFor(config, "stdio");
    const b = confirmSecretFor(config, "stdio");
    expect(a).toHaveLength(32);
    expect(a.equals(b)).toBe(false);
  });

  it("requires the secret on HTTP", () => {
    const config = loadConfig({ SEVDESK_API_TOKEN: TEST_TOKEN });
    expect(() => confirmSecretFor(config, "http")).toThrow(ConfigError);
    expect(() => confirmSecretFor(config, "http")).toThrow(
      "SEVDESK_CONFIRM_SECRET: is required for the HTTP transport",
    );
  });
});
