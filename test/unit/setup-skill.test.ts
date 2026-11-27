import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  installSkill,
  SKILL_MARKER,
  skillLocations,
  supportsSkill,
} from "../../src/setup/skill.js";
import { SKILL_FILES, SKILL_NAME } from "../../src/setup/skill-files.js";

// The setup ships the sevdesk skill inside the binary, so src/setup/skill-files.ts holds a copy
// of plugins/sevdesk/skills/sevdesk. This test keeps the two equal; with UPDATE_SKILL_FILES=1 it
// rewrites the copy instead.

const root = fileURLToPath(new URL("../../", import.meta.url));
const source = join(root, "plugins", "sevdesk", "skills", "sevdesk");
const generated = join(root, "src", "setup", "skill-files.ts");

function sourceFiles(): Record<string, string> {
  const files: Record<string, string> = {};
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) =>
      a.name < b.name ? -1 : 1,
    )) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) walk(path);
      else files[relative(source, path).split(sep).join("/")] = readFileSync(path, "utf8");
    }
  };
  walk(source);
  return files;
}

function render(files: Record<string, string>): string {
  const entries = Object.entries(files)
    .map(([name, content]) => `  ${JSON.stringify(name)}:\n    ${JSON.stringify(content)},\n`)
    .join("");
  return `// Generated from plugins/sevdesk/skills/sevdesk; do not edit. Regenerate with
// UPDATE_SKILL_FILES=1 npx vitest run test/unit/setup-skill.test.ts

export const SKILL_NAME = "sevdesk";

export const SKILL_FILES: Readonly<Record<string, string>> = {
${entries}};
`;
}

describe("skill-files.ts", () => {
  it("matches plugins/sevdesk/skills/sevdesk", () => {
    const files = sourceFiles();
    if (process.env.UPDATE_SKILL_FILES === "1") {
      writeFileSync(generated, render(files));
      spawnSync("npx", ["biome", "format", "--write", generated], { cwd: root, stdio: "ignore" });
      return;
    }
    expect(
      SKILL_FILES,
      "run: UPDATE_SKILL_FILES=1 npx vitest run test/unit/setup-skill.test.ts",
    ).toEqual(files);
    expect(SKILL_NAME).toBe("sevdesk");
  });
});

describe("skillLocations", () => {
  const options = { scope: "global" as const, cwd: "/work/p", home: "/home/u" };

  it("puts the shared agents in one folder and the others in their own", () => {
    expect(
      skillLocations(
        ["claude-code", "cursor", "codex", "windsurf", "goose", "claude-desktop"],
        options,
      ),
    ).toEqual([
      { dir: "/home/u/.claude/skills/sevdesk", agents: ["claude-code"] },
      { dir: "/home/u/.agents/skills/sevdesk", agents: ["cursor", "codex"] },
      { dir: "/home/u/.codeium/windsurf/skills/sevdesk", agents: ["windsurf"] },
      { dir: "/home/u/.config/goose/skills/sevdesk", agents: ["goose"] },
    ]);
    expect(supportsSkill("claude-desktop")).toBe(false);
  });

  it("follows CLAUDE_CONFIG_DIR and XDG_CONFIG_HOME, and the project in project scope", () => {
    expect(
      skillLocations(["claude-code", "goose"], {
        ...options,
        claudeConfigDir: "/cfg/claude",
        xdgConfigHome: "/cfg/xdg",
      }).map((l) => l.dir),
    ).toEqual(["/cfg/claude/skills/sevdesk", "/cfg/xdg/goose/skills/sevdesk"]);
    expect(
      skillLocations(["claude-code", "cursor"], { ...options, scope: "project" }).map((l) => l.dir),
    ).toEqual(["/work/p/.claude/skills/sevdesk", "/work/p/.agents/skills/sevdesk"]);
  });
});

describe("installSkill", () => {
  const base = () => mkdtempSync(join(tmpdir(), "sevdesk-mcp-skill-"));
  const listing = (dir: string) => readdirSync(dir).sort();

  it("copies the skill with its marker and leaves nothing else behind", async () => {
    const skills = base();
    const dir = join(skills, "sevdesk");
    expect(await installSkill(dir)).toEqual({ status: "ok", dir, updated: false });
    expect(readFileSync(join(dir, "references", "tools.md"), "utf8")).toBe(
      SKILL_FILES["references/tools.md"],
    );
    expect(existsSync(join(dir, SKILL_MARKER))).toBe(true);
    expect(listing(skills)).toEqual(["sevdesk"]);
  });

  it("replaces its own earlier copy, files that are gone included", async () => {
    const skills = base();
    const dir = join(skills, "sevdesk");
    await installSkill(dir, { "SKILL.md": "old", "references/gone.md": "gone" });
    expect(await installSkill(dir, { "SKILL.md": "new" })).toEqual({
      status: "ok",
      dir,
      updated: true,
    });
    expect(readFileSync(join(dir, "SKILL.md"), "utf8")).toBe("new");
    expect(existsSync(join(dir, "references"))).toBe(false);
    expect(listing(skills)).toEqual(["sevdesk"]);
  });

  it("leaves a folder it did not install, and a symbolic link, alone", async () => {
    const skills = base();
    const dir = join(skills, "sevdesk");
    mkdirSync(dir);
    writeFileSync(join(dir, "SKILL.md"), "mine");
    expect(await installSkill(dir)).toMatchObject({ status: "skipped" });
    expect(readFileSync(join(dir, "SKILL.md"), "utf8")).toBe("mine");

    const other = base();
    const target = join(other, "elsewhere");
    mkdirSync(target);
    writeFileSync(join(target, SKILL_MARKER), "");
    const link = join(other, "sevdesk");
    symlinkSync(target, link);
    expect(await installSkill(link)).toMatchObject({ status: "skipped" });
    expect(listing(target)).toEqual([SKILL_MARKER]);
  });

  it("refuses file names that leave the folder", async () => {
    const skills = base();
    const dir = join(skills, "sevdesk");
    expect(await installSkill(dir, { "../escape.md": "x" })).toMatchObject({ status: "error" });
    expect(listing(skills)).toEqual([]);
  });
});
