import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { v0_3 } from "@anthropic-ai/mcpb";
import { describe, expect, it } from "vitest";
import { MODES } from "../../src/config.js";

const file = (path: string) => fileURLToPath(new URL(`../../${path}`, import.meta.url));
const manifest = JSON.parse(readFileSync(file("mcpb/manifest.json"), "utf8"));
const pkg = JSON.parse(readFileSync(file("package.json"), "utf8"));
/** An MCPB placeholder such as ${__dirname}, which the client substitutes. */
const placeholder = (name: string) => `\${${name}}`;

describe("mcpb manifest", () => {
  it("matches the MCPB 0.3 schema", () => {
    expect(manifest.manifest_version).toBe("0.3");
    expect(() => v0_3.McpbManifestSchema.parse(manifest)).not.toThrow();
  });

  // Tags are the only version source: scripts/build-mcpb.mjs writes the release version
  // into the bundled copy, nothing is committed back.
  it("keeps the placeholder version", () => {
    expect(manifest.version).toBe("0.0.0");
  });

  it("agrees with package.json on runtime, license and repository", () => {
    expect(manifest.compatibility.runtimes.node).toBe(pkg.engines.node);
    expect(manifest.license).toBe(pkg.license);
    expect(manifest.repository.url).toBe(pkg.repository.url.replace(/^git\+/, ""));
    expect(manifest.description).toContain("Unofficial, not affiliated with sevdesk GmbH");
  });

  it("starts the stdio server with the token as a secret and read as the default mode", () => {
    const { mcp_config: config, entry_point: entry, type } = manifest.server;
    expect(type).toBe("node");
    expect(entry).toBe(pkg.bin["sevdesk-mcp"]);
    expect(config.command).toBe("node");
    expect(config.args).toEqual([`${placeholder("__dirname")}/${entry}`]);
    expect(config.env).toEqual({
      SEVDESK_API_TOKEN: placeholder("user_config.api_token"),
      SEVDESK_MODE: placeholder("user_config.mode"),
    });
    expect(manifest.user_config.api_token).toMatchObject({
      type: "string",
      sensitive: true,
      required: true,
    });
    expect(manifest.user_config.mode).toMatchObject({ type: "string", default: "read" });
  });

  // Irreversible tools are unlocked deliberately in a manual configuration, not in the
  // one-click extension: the mode field offers read and write only.
  it("offers read and write as modes and points to the manual setup for the rest", () => {
    const { description } = manifest.user_config.mode;
    expect(description).toMatch(/^read \(default\) or write, in lower case;/);
    // The server rejects any other spelling at startup (SEVDESK_MODE is case-sensitive).
    expect(description).toContain("an unknown value stops the server from starting");
    expect(MODES).toEqual(expect.arrayContaining(["read", "write"]));
    for (const text of [description, manifest.long_description]) {
      expect(text).toContain("SEVDESK_MODE=full");
      expect(text).toContain("SEVDESK_ENABLE_TOOLS");
      expect(text).not.toMatch(/\bread\b[^.]*\bwrite\b[^.]*\bor full\b/);
    }
    expect(manifest.server.mcp_config.env).not.toHaveProperty("SEVDESK_ENABLE_TOOLS");
  });

  // The tool set depends on the mode, so a static list would describe only one of them.
  it("lists no tools", () => {
    expect(manifest.tools).toBeUndefined();
  });
});

describe("mcpb icon", () => {
  // mcpb/icon.png is assets/logo/sevdesk-mcp.svg rendered once at 512x512. Render it again
  // whenever the SVG changes.
  it("is a 512x512 PNG", () => {
    const png = readFileSync(file(`mcpb/${manifest.icon}`));
    expect(png.subarray(0, 8)).toEqual(
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    );
    expect(png.toString("ascii", 12, 16)).toBe("IHDR");
    expect([png.readUInt32BE(16), png.readUInt32BE(20)]).toEqual([512, 512]);
  });
});
