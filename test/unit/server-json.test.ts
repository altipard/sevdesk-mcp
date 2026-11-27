import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { MODES } from "../../src/config.js";
import { KEYCHAIN_ACCOUNT, KEYCHAIN_SERVICE } from "../../src/keychain.js";

const file = (path: string) => fileURLToPath(new URL(`../../${path}`, import.meta.url));
const server = JSON.parse(readFileSync(file("server.json"), "utf8"));
const pkg = JSON.parse(readFileSync(file("package.json"), "utf8"));
const configSource = readFileSync(file("src/config.ts"), "utf8");

interface EnvironmentVariable {
  name: string;
  description: string;
  isRequired?: boolean;
  isSecret?: boolean;
  default?: string;
  choices?: string[];
}

const [npm] = server.packages;
const env = (name: string): EnvironmentVariable | undefined =>
  (npm.environmentVariables as EnvironmentVariable[]).find((v) => v.name === name);

// The official MCP registry (registry.modelcontextprotocol.io) lists the npm package from
// server.json; it accepts the entry only if the published package.json names it in mcpName.
describe("server.json for the MCP registry", () => {
  it("uses the current schema and the GitHub namespace of this repository", () => {
    expect(server.$schema).toBe(
      "https://static.modelcontextprotocol.io/schemas/2025-12-11/server.schema.json",
    );
    expect(server.name).toBe("io.github.altipard/sevdesk-mcp");
    expect(server.repository).toMatchObject({
      url: pkg.repository.url.replace(/^git\+/, "").replace(/\.git$/, ""),
      source: "github",
    });
  });

  it("matches mcpName and the package name in package.json", () => {
    expect(pkg.mcpName).toBe(server.name);
    expect(server.packages).toHaveLength(1);
    expect(npm).toMatchObject({
      registryType: "npm",
      registryBaseUrl: "https://registry.npmjs.org",
      identifier: pkg.name,
      transport: { type: "stdio" },
    });
  });

  // Tags are the only version source: the release workflow stamps the release version into
  // both fields right before it publishes.
  it("keeps the placeholder version", () => {
    expect(server.version).toBe("0.0.0");
    expect(npm.version).toBe(server.version);
  });

  it("stays within the registry's length limits and says it is unofficial", () => {
    expect(server.description.length).toBeLessThanOrEqual(100);
    expect(server.title.length).toBeLessThanOrEqual(100);
    expect(server.description).toMatch(/^Unofficial\b/);
  });

  it("names only environment variables the server reads", () => {
    const names = (npm.environmentVariables as EnvironmentVariable[]).map((v) => v.name);
    expect(names).toEqual(["SEVDESK_API_TOKEN", "SEVDESK_MODE"]);
    for (const name of names) expect(configSource).toMatch(new RegExp(`^\\s+${name}:`, "m"));
  });

  // The keychain is the other token source, so a client must not insist on the variable.
  it("marks the token secret but optional and points to the keychain", () => {
    const token = env("SEVDESK_API_TOKEN");
    expect(token).toMatchObject({ isSecret: true, isRequired: false });
    expect(token?.description).toContain("keychain");
    expect(token?.description).toContain(`service ${KEYCHAIN_SERVICE}`);
    expect(token?.description).toContain(`account ${KEYCHAIN_ACCOUNT}`);
  });

  // full needs SEVDESK_ENABLE_TOOLS, which the registry entry cannot set, so it is not offered.
  it("offers only server modes the registry can set, with read as the default", () => {
    const mode = env("SEVDESK_MODE");
    expect(mode).toMatchObject({ isSecret: false, isRequired: false, default: "read" });
    expect(mode?.choices).toEqual(["read", "write"]);
    expect(MODES).toEqual(expect.arrayContaining(mode?.choices ?? []));
    expect(configSource).toMatch(/\.default\("read"\)/);
    expect(mode?.description).not.toMatch(/\bfull\b/);
  });
});
