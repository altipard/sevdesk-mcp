import { describe, expect, it } from "vitest";
import { ConfigError, forgetSecrets, loadHttpConfig } from "../../src/config.js";

const BASE = {
  MCP_RESOURCE_URL: "https://mcp.example.test/mcp",
  OAUTH_ISSUER: "https://auth.example.test/realms/sevdesk",
  OAUTH_JWKS_URL: "https://auth.example.test/realms/sevdesk/certs",
  REDIS_URL: "rediss://:s3cret-pw@redis.example.test:6380/0",
};

function issues(env: Record<string, string | undefined>): string[] {
  try {
    loadHttpConfig(env);
  } catch (error) {
    expect(error).toBeInstanceOf(ConfigError);
    return [...(error as ConfigError).issues];
  }
  throw new Error("expected a ConfigError");
}

describe("loadHttpConfig", () => {
  it("loads a complete configuration with defaults", () => {
    const config = loadHttpConfig(BASE);
    expect(config).toMatchObject({
      port: 3000,
      allowedHosts: ["mcp.example.test"],
      issuer: BASE.OAUTH_ISSUER,
      algorithms: ["RS256"],
      redisUrl: BASE.REDIS_URL,
      allowInsecureHttp: false,
    });
    expect(config.resourceUrl.href).toBe(BASE.MCP_RESOURCE_URL);
    expect(config.jwksUrl.href).toBe(BASE.OAUTH_JWKS_URL);
  });

  it("reads PORT, OAUTH_ALGORITHMS and MCP_ALLOWED_HOSTS", () => {
    const config = loadHttpConfig({
      ...BASE,
      PORT: "8080",
      OAUTH_ALGORITHMS: "ES256, RS256,ES256",
      MCP_ALLOWED_HOSTS: "MCP.example.test, internal-lb, [::1]",
    });
    expect(config.port).toBe(8080);
    expect(config.algorithms).toEqual(["ES256", "RS256"]);
    expect(config.allowedHosts).toEqual(["mcp.example.test", "internal-lb", "[::1]"]);
  });

  it.each([
    [{ MCP_RESOURCE_URL: undefined }, "MCP_RESOURCE_URL: is required"],
    [{ OAUTH_ISSUER: "" }, "OAUTH_ISSUER: is required"],
    [{ OAUTH_JWKS_URL: undefined }, "OAUTH_JWKS_URL: is required"],
    [
      { REDIS_URL: undefined },
      "REDIS_URL: is required for the HTTP transport (shared replay protection)",
    ],
    [{ REDIS_URL: "http://redis:6379" }, "REDIS_URL: must be a redis:// or rediss:// URL"],
    [{ PORT: "70000" }, "PORT: must be between 0 and 65535"],
    [{ PORT: "web" }, "PORT: must be a port number"],
    [{ OAUTH_ALGORITHMS: "HS256" }, "OAUTH_ALGORITHMS: must only contain asymmetric algorithms"],
    [
      { OAUTH_ALGORITHMS: "RS256,none" },
      "OAUTH_ALGORITHMS: must only contain asymmetric algorithms",
    ],
    [{ OAUTH_ALGORITHMS: " , " }, "OAUTH_ALGORITHMS: must name at least one algorithm"],
    [{ MCP_ALLOWED_HOSTS: "evil.test/path" }, "MCP_ALLOWED_HOSTS: must be a comma-separated list"],
    [{ OAUTH_ALLOW_INSECURE_HTTP: "yes" }, "OAUTH_ALLOW_INSECURE_HTTP: must be true or false"],
  ])("refuses %j", (override, message) => {
    expect(issues({ ...BASE, ...override }).join("\n")).toContain(message);
  });

  it("refuses plain http for JWKS and issuer unless the local flag is set", () => {
    const env = {
      ...BASE,
      OAUTH_ISSUER: "http://keycloak:8080/realms/sevdesk",
      OAUTH_JWKS_URL: "http://keycloak:8080/realms/sevdesk/certs",
    };
    const found = issues(env);
    expect(found).toContain(
      "OAUTH_JWKS_URL: must use https (http only with OAUTH_ALLOW_INSECURE_HTTP=true, for local development)",
    );
    expect(found).toContain(
      "OAUTH_ISSUER: must use https (http only with OAUTH_ALLOW_INSECURE_HTTP=true, for local development)",
    );
    // Not even for localhost: the flag is the only way.
    expect(issues({ ...BASE, OAUTH_JWKS_URL: "http://localhost:8080/certs" })[0]).toMatch(
      /^OAUTH_JWKS_URL: must use https/,
    );
    const config = loadHttpConfig({ ...env, OAUTH_ALLOW_INSECURE_HTTP: "true" });
    expect(config.allowInsecureHttp).toBe(true);
    expect(config.jwksUrl.protocol).toBe("http:");
  });

  it("refuses other schemes, credentials and fragments in the URLs", () => {
    expect(issues({ ...BASE, OAUTH_JWKS_URL: "file:///etc/keys" })[0]).toMatch(
      /^OAUTH_JWKS_URL: must be an absolute https URL/,
    );
    expect(issues({ ...BASE, OAUTH_JWKS_URL: "https://u:p@auth.example.test/certs" })).toContain(
      "OAUTH_JWKS_URL: must not contain credentials",
    );
    expect(issues({ ...BASE, MCP_RESOURCE_URL: "https://mcp.example.test/mcp#x" })).toContain(
      "MCP_RESOURCE_URL: must not contain a fragment",
    );
    expect(issues({ ...BASE, MCP_RESOURCE_URL: "https://mcp.example.test/mcp?x=1" })).toContain(
      "MCP_RESOURCE_URL: must not contain a query",
    );
  });

  it("accepts an http resource URL only on loopback", () => {
    expect(
      loadHttpConfig({ ...BASE, MCP_RESOURCE_URL: "http://localhost:3000/mcp" }).allowedHosts,
    ).toEqual(["localhost"]);
    expect(issues({ ...BASE, MCP_RESOURCE_URL: "http://mcp.example.test/mcp" })).toContain(
      "MCP_RESOURCE_URL: must use https",
    );
  });

  it("refuses a resource path that collides with health or well-known routes", () => {
    for (const path of ["/healthz", "/healthz/", "/.well-known/oauth-protected-resource"]) {
      expect(issues({ ...BASE, MCP_RESOURCE_URL: `https://mcp.example.test${path}` })).toContain(
        "MCP_RESOURCE_URL: path collides with /healthz or /.well-known/",
      );
    }
  });

  it("never echoes the Redis URL or its password in an error", () => {
    const text = issues({ ...BASE, REDIS_URL: "http://:s3cret-pw@redis:6379", PORT: "x" }).join(
      "\n",
    );
    expect(text).not.toContain("s3cret-pw");
  });
});

describe("forgetSecrets", () => {
  it("removes the named variables from every environment and leaves the rest", () => {
    const a: Record<string, string | undefined> = {
      SEVDESK_API_TOKEN: "t",
      REDIS_URL: "r",
      PORT: "1",
    };
    const b: Record<string, string | undefined> = { SEVDESK_API_TOKEN: "t" };
    forgetSecrets(["SEVDESK_API_TOKEN", "REDIS_URL"], a, b);
    expect(a).toEqual({ PORT: "1" });
    expect(b).toEqual({});
  });
});
