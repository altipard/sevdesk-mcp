import { randomBytes } from "node:crypto";
import { lstat, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, normalize, sep } from "node:path";
import type { AgentType } from "add-mcp";
import type { Scope } from "./agents.js";
import { SKILL_FILES, SKILL_NAME } from "./skill-files.js";

/** Written into every skill folder the setup installs; only such a folder is ever replaced. */
export const SKILL_MARKER = ".installed-by-sevdesk-mcp";

/**
 * Where agents read skills, as `npx skills` installs them: Claude Code, Windsurf and Goose
 * have their own folder, the others share ~/.agents/skills (project: .agents/skills).
 */
interface GlobalDirs {
  home: string;
  xdg: string;
  claude: string | undefined;
}

const SKILL_DIRS: Partial<
  Record<AgentType, { global: (dirs: GlobalDirs) => string; project: string }>
> = {
  "claude-code": {
    global: ({ home, claude }) => join(claude ?? join(home, ".claude"), "skills"),
    project: join(".claude", "skills"),
  },
  windsurf: {
    global: ({ home }) => join(home, ".codeium", "windsurf", "skills"),
    project: join(".windsurf", "skills"),
  },
  goose: {
    global: ({ xdg }) => join(xdg, "goose", "skills"),
    project: join(".goose", "skills"),
  },
  ...Object.fromEntries(
    (
      ["codex", "cursor", "gemini-cli", "opencode", "cline", "github-copilot-cli", "zed"] as const
    ).map((agent) => [
      agent,
      {
        global: ({ home }: GlobalDirs) => join(home, ".agents", "skills"),
        project: join(".agents", "skills"),
      },
    ]),
  ),
};

export function supportsSkill(agent: AgentType): boolean {
  return SKILL_DIRS[agent] !== undefined;
}

export interface SkillLocation {
  /** The skill folder, e.g. ~/.agents/skills/sevdesk. */
  dir: string;
  agents: AgentType[];
}

export interface SkillPathOptions {
  scope: Scope;
  cwd: string;
  home: string;
  xdgConfigHome?: string;
  claudeConfigDir?: string;
}

/** The skill folders for these agents, one per distinct folder. */
export function skillLocations(
  agents: readonly AgentType[],
  options: SkillPathOptions,
): SkillLocation[] {
  const xdg = options.xdgConfigHome || join(options.home, ".config");
  const byDir = new Map<string, AgentType[]>();
  for (const agent of agents) {
    const dirs = SKILL_DIRS[agent];
    if (!dirs) continue;
    const base =
      options.scope === "global"
        ? dirs.global({ home: options.home, xdg, claude: options.claudeConfigDir })
        : join(options.cwd, dirs.project);
    const dir = join(base, SKILL_NAME);
    byDir.set(dir, [...(byDir.get(dir) ?? []), agent]);
  }
  return [...byDir].map(([dir, list]) => ({ dir, agents: list }));
}

export type SkillOutcome =
  | { status: "ok"; dir: string; updated: boolean }
  | { status: "skipped"; dir: string; reason: string }
  | { status: "error"; dir: string; reason: string };

/** "ours" (has the marker), "none", or "foreign" (anything else, including a symbolic link). */
async function folderState(dir: string): Promise<"none" | "ours" | "foreign"> {
  try {
    const info = await lstat(dir);
    if (!info.isDirectory()) return "foreign";
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return "none";
    return "foreign";
  }
  try {
    await readFile(join(dir, SKILL_MARKER));
    return "ours";
  } catch {
    return "foreign";
  }
}

function safeRelative(path: string): boolean {
  const clean = normalize(path);
  return !isAbsolute(clean) && clean !== ".." && !clean.startsWith(`..${sep}`);
}

/**
 * Copies the skill into `dir` (a copy, not a link: the binary has no source folder to link
 * to). The files are written to a fresh folder next to it and renamed into place; a folder the
 * setup did not install (no marker, e.g. one from `npx skills` or written by hand) stays.
 */
export async function installSkill(
  dir: string,
  files: Readonly<Record<string, string>> = SKILL_FILES,
): Promise<SkillOutcome> {
  const state = await folderState(dir);
  if (state === "foreign") {
    return {
      status: "skipped",
      dir,
      reason: "a sevdesk skill installed some other way is already there",
    };
  }
  const suffix = randomBytes(6).toString("hex");
  const fresh = join(dirname(dir), `.${SKILL_NAME}.new-${suffix}`);
  const old = join(dirname(dir), `.${SKILL_NAME}.old-${suffix}`);
  try {
    await mkdir(fresh, { recursive: true });
    for (const [name, content] of Object.entries(files)) {
      if (!safeRelative(name)) throw new Error("unsafe skill file name");
      const target = join(fresh, name);
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, content, { flag: "wx" });
    }
    await writeFile(
      join(fresh, SKILL_MARKER),
      "Installed by `sevdesk-mcp setup`; it replaces this folder on updates.\n",
    );
    if (state === "ours") await rename(dir, old);
    try {
      await rename(fresh, dir);
    } catch (error) {
      if (state === "ours") await rename(old, dir);
      throw error;
    }
    if (state === "ours") await rm(old, { recursive: true, force: true });
    return { status: "ok", dir, updated: state === "ours" };
  } catch (error) {
    await rm(fresh, { recursive: true, force: true });
    const code = (error as NodeJS.ErrnoException).code;
    return { status: "error", dir, reason: `copying the skill failed${code ? ` (${code})` : ""}` };
  }
}
