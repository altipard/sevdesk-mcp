import { describe, expect, it } from "vitest";
import { ConfigError, DEFAULT_BASE_URL, loadConfig } from "../../src/config.js";
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
      SEVDESK_MODE: "full",
      SEVDESK_BASE_URL: "ftp://example.com",
      LOG_LEVEL: "verbose",
    });
    expect(error.issues).toEqual([
      "SEVDESK_API_TOKEN: is required",
      "SEVDESK_MODE: must be one of: read, write",
      "SEVDESK_BASE_URL: must be an http(s) URL",
      "LOG_LEVEL: must be one of: debug, info, warn, error",
    ]);
  });

  it("rejects a malformed token without echoing it", () => {
    const malformed = `${TEST_TOKEN} leaked-part`;
    const error = configError({ SEVDESK_API_TOKEN: malformed, SEVDESK_MODE: "nope" });
    expect(error.issues).toContain("SEVDESK_API_TOKEN: must not contain whitespace");
    const text = errorRepresentations(error);
    expect(text).not.toContain(TEST_TOKEN);
    expect(text).not.toContain("leaked-part");
    expect(text).not.toContain("nope");
  });

  it("does not echo the token when other variables are invalid", () => {
    const error = configError({ SEVDESK_API_TOKEN: TEST_TOKEN, SEVDESK_BASE_URL: "not a url" });
    expect(errorRepresentations(error)).not.toContain(TEST_TOKEN);
  });
});
