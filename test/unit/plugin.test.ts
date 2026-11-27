import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { MODES } from "../../src/config.js";
import {
  CHECK_ACCOUNT_STATUS,
  CONTACT_STATUS,
  CREDIT_NOTE_STATUS,
  INVOICE_STATUS,
  ORDER_STATUS,
  PART_STATUS,
  TRANSACTION_STATUS,
  VOUCHER_STATUS,
} from "../../src/tools/format.js";
import { TOOL_NAMES } from "../../src/tools/index.js";

const root = fileURLToPath(new URL("../../", import.meta.url));
const pluginDir = join(root, "plugins", "sevdesk");
const skillDir = join(pluginDir, "skills", "sevdesk");

type Json = Record<string, unknown>;

function readJson(path: string): Json {
  const value: unknown = JSON.parse(readFileSync(join(root, path), "utf8"));
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${path} is not a JSON object`);
  }
  return value as Json;
}

const asObject = (value: unknown): Json => {
  expect(value).toBeTypeOf("object");
  expect(value).not.toBeNull();
  return value as Json;
};

const marketplace = readJson(".claude-plugin/marketplace.json");
const manifest = readJson("plugins/sevdesk/.claude-plugin/plugin.json");
const pkg = readJson("package.json");
const plugins = marketplace.plugins as Json[];

function markdownFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return markdownFiles(path);
    return entry.name.endsWith(".md") ? [path] : [];
  });
}

/** Frontmatter as flat `key: value` lines; the skill keeps every value on one line. */
function frontmatter(markdown: string): Record<string, string> {
  const match = /^---\n([\s\S]*?)\n---\n/.exec(markdown);
  if (!match?.[1]) throw new Error("SKILL.md has no frontmatter");
  const fields: Record<string, string> = {};
  for (const line of match[1].split("\n")) {
    const separator = line.indexOf(":");
    if (separator <= 0) throw new Error(`unexpected frontmatter line: ${line}`);
    fields[line.slice(0, separator).trim()] = line.slice(separator + 1).trim();
  }
  return fields;
}

// Backticked snake_case words in the skill that are not tool names: the
// confirmation parameter, status names the search tools accept, and enum
// values of tool inputs. Everything else in that shape must be a tool.
const STATUS_NAMES = [
  INVOICE_STATUS,
  CREDIT_NOTE_STATUS,
  ORDER_STATUS,
  VOUCHER_STATUS,
  TRANSACTION_STATUS,
  CONTACT_STATUS,
  CHECK_ACCOUNT_STATUS,
  PART_STATUS,
].flatMap((codes) => Object.values(codes));
const NOT_TOOLS = new Set(["confirmation_token", "credit_note", "tax_rule", ...STATUS_NAMES]);
const SNAKE_CASE = /^[a-z][a-z0-9]*(?:_[a-z0-9]+)+$/;

/** Every backticked snake_case word per skill file. */
function backtickedNames(): Map<string, string[]> {
  const found = new Map<string, string[]>();
  for (const file of markdownFiles(skillDir)) {
    const names = [...readFileSync(file, "utf8").matchAll(/`([^`\n]+)`/g)]
      .map((match) => match[1] ?? "")
      .filter((word) => SNAKE_CASE.test(word));
    found.set(relative(skillDir, file), names);
  }
  return found;
}

describe("marketplace.json", () => {
  it("has the required fields and one plugin with a relative source", () => {
    expect(marketplace.name).toBe("sevdesk-mcp");
    expect(asObject(marketplace.owner).name).toBeTypeOf("string");
    expect(Array.isArray(plugins)).toBe(true);
    expect(plugins).toHaveLength(1);
    const [entry] = plugins as [Json];
    expect(entry.name).toBe(manifest.name);
    expect(entry.source).toBe("./plugins/sevdesk");
    expect(existsSync(join(root, entry.source as string, ".claude-plugin", "plugin.json"))).toBe(
      true,
    );
  });

  it("leaves the version to git, so installs track the released commit", () => {
    expect(marketplace).not.toHaveProperty("version");
    for (const entry of plugins) expect(entry).not.toHaveProperty("version");
  });
});

describe("plugin.json", () => {
  const servers = asObject(manifest.mcpServers);
  const server = asObject(servers.sevdesk);
  const env = asObject(server.env ?? {});

  it("has a kebab-case name and no version", () => {
    expect(manifest.name).toMatch(/^[a-z0-9]+(?:-[a-z0-9]+)*$/);
    expect(manifest).not.toHaveProperty("version");
  });

  it("starts the published npm package of this repository", () => {
    expect(server.command).toBe("npx");
    expect(server.args).toEqual(["-y", pkg.name]);
  });

  it("never carries the API token, so the keychain or the environment provides it", () => {
    expect(env).not.toHaveProperty("SEVDESK_API_TOKEN");
    expect(env).not.toHaveProperty("SEVDESK_CONFIRM_SECRET");
    expect(JSON.stringify(manifest)).not.toMatch(/token["']?\s*:/i);
  });

  it("lets the user pick SEVDESK_MODE with read as default", () => {
    const mode = asObject(asObject(manifest.userConfig).mode);
    expect(mode.type).toBe("string");
    expect(mode.options).toEqual([...MODES]);
    expect(mode.default).toBe("read");
    expect(mode).not.toHaveProperty("sensitive");
    // biome-ignore lint/suspicious/noTemplateCurlyInString: literal placeholder Claude Code substitutes
    expect(env.SEVDESK_MODE).toBe("${user_config.mode}");
  });

  it("is the only MCP configuration: none at the repository or plugin root", () => {
    expect(existsSync(join(root, ".mcp.json"))).toBe(false);
    expect(existsSync(join(pluginDir, ".mcp.json"))).toBe(false);
  });
});

describe("sevdesk skill", () => {
  const skill = readFileSync(join(skillDir, "SKILL.md"), "utf8");
  const fields = frontmatter(skill);

  it("follows the Agent Skills frontmatter rules", () => {
    expect(Object.keys(fields).sort()).toEqual(["description", "name"]);
    expect(fields.name).toBe("sevdesk");
    expect(fields.name).toMatch(/^[a-z0-9]+(?:-[a-z0-9]+)*$/);
    const description = fields.description ?? "";
    expect(description.length).toBeGreaterThan(0);
    expect(description.length).toBeLessThanOrEqual(1024);
    expect(description).not.toMatch(/[<>]/);
    for (const word of ["sevdesk", "Rechnungen", "Belege", "Buchhaltung", "Kontakte"]) {
      expect(description).toContain(word);
    }
  });

  it("links only reference files that exist", () => {
    for (const file of markdownFiles(skillDir)) {
      for (const [, target] of readFileSync(file, "utf8").matchAll(/\]\(([^)#]+\.md)\)/g)) {
        expect(existsSync(join(file, "..", target ?? "")), `${file} -> ${target}`).toBe(true);
      }
    }
  });

  it("names only tools the server registers", () => {
    const known = new Set(TOOL_NAMES);
    let tools = 0;
    for (const [file, names] of backtickedNames()) {
      for (const name of names) {
        if (NOT_TOOLS.has(name)) continue;
        expect(known.has(name), `${file}: unknown tool \`${name}\``).toBe(true);
        tools += 1;
      }
    }
    // Guards against a pattern that silently matches nothing.
    expect(tools).toBeGreaterThan(50);
  });

  it("covers every registered tool", () => {
    const mentioned = new Set([...backtickedNames().values()].flat());
    const missing = TOOL_NAMES.filter((name) => !mentioned.has(name));
    expect(missing).toEqual([]);
  });

  it("keeps the non-tool words distinct from tool names", () => {
    for (const word of NOT_TOOLS) expect(TOOL_NAMES).not.toContain(word);
  });
});
