import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { AgentType } from "add-mcp";
import { beforeEach, describe, expect, it } from "vitest";
import type { KeychainResult, StoreResult } from "../../src/keychain.js";
import { type AddMcp, agentTypes, configPath } from "../../src/setup/agents.js";
import { CANCELLED, type Prompter } from "../../src/setup/prompter.js";
import { EXIT, runSetup, type SetupDeps } from "../../src/setup/run.js";
import { SKILL_MARKER } from "../../src/setup/skill.js";

// The whole setup flow with the real add-mcp under a temporary HOME, a scripted prompter, a fake
// keychain and a fake fetch: no terminal, no keychain, no network, no real client configuration.

const ADD_MCP_ENV = [
  "APPDATA",
  "CLAUDE_CONFIG_DIR",
  "CLINE_DIR",
  "CODEX_HOME",
  "COPILOT_HOME",
  "GROK_HOME",
  "HERMES_HOME",
  "JUNIE_HOME",
  "KIMI_CODE_HOME",
  "LOCALAPPDATA",
  "PI_CODING_AGENT_DIR",
  "XDG_CONFIG_HOME",
];
const home = mkdtempSync(join(tmpdir(), "sevdesk-mcp-setup-run-"));
for (const name of ADD_MCP_ENV) delete process.env[name];
process.env.HOME = home;
const addMcp = (await import("add-mcp")) as unknown as AddMcp;
const project = join(home, "project");
for (const agent of agentTypes(addMcp)) {
  if (!configPath(addMcp, agent, "global", project).startsWith(home)) {
    throw new Error(`add-mcp resolved ${agent} outside the test HOME`);
  }
}

const BIN = "/opt/sevdesk/bin/sevdesk-mcp";
const TOKEN = "0123456789abcdef0123456789abcdef";
const OTHER = "fedcba9876543210fedcba9876543210";
const cursorFile = join(home, ".cursor", "mcp.json");
const desktopFile = () => configPath(addMcp, "claude-desktop", "global", project);
const claudeFile = join(home, ".claude.json");

type Step =
  | { multiselect: AgentType[] | typeof CANCELLED }
  | { select: string | typeof CANCELLED }
  | { confirm: boolean | typeof CANCELLED }
  | { password: string | typeof CANCELLED };

interface Run {
  code: number;
  output: string;
  /** Prompts as asked, with what they offered. */
  asked: { kind: string; message: string; initial?: unknown; choices?: unknown }[];
  stored: string[];
  fetches: { url: string; headers: Record<string, string> }[];
}

interface Options {
  steps?: Step[];
  interactive?: boolean;
  keychain?: KeychainResult;
  storeResult?: StoreResult;
  /** Status codes the fake sevdesk answers in turn; "down" = no connection. */
  http?: (number | "down")[];
  detected?: AgentType[];
  stdin?: string;
  claudeRunning?: boolean;
  interruptDuringApply?: boolean;
  platform?: NodeJS.Platform;
  /** Ctrl-C while the token is being checked. */
  cancelSpin?: boolean;
}

async function run(argv: string[], options: Options = {}): Promise<Run> {
  const steps = [...(options.steps ?? [])];
  const lines: string[] = [];
  const asked: Run["asked"] = [];
  const stored: string[] = [];
  const fetches: Run["fetches"] = [];
  const http = [...(options.http ?? [200])];
  const next = (kind: string, message: string, extra: object = {}) => {
    asked.push({ kind, message, ...extra });
    const step = steps.shift();
    if (!step || !(kind in step)) throw new Error(`unexpected prompt ${kind}: ${message}`);
    return (step as Record<string, unknown>)[kind];
  };
  const prompter: Prompter = {
    intro: (title) => lines.push(`intro ${title}`),
    outro: (message) => lines.push(`outro ${message}`),
    cancel: (message) => lines.push(`cancel ${message}`),
    note: (text, title) => lines.push(`note ${title}\n${text}`),
    info: (message) => lines.push(`info ${message}`),
    success: (message) => lines.push(`success ${message}`),
    warn: (message) => lines.push(`warn ${message}`),
    error: (message) => lines.push(`error ${message}`),
    multiselect: async ({ message, initial, choices }) =>
      next("multiselect", message, { initial, choices }) as never,
    select: async ({ message, initial, choices }) =>
      next("select", message, { initial, choices }) as never,
    confirm: async ({ message, initial }) => next("confirm", message, { initial }) as never,
    password: async ({ message, validate }) => {
      const value = next("password", message) as string | typeof CANCELLED;
      if (value !== CANCELLED && validate(value) !== undefined) {
        throw new Error(`the prompt would not accept ${value.length} characters`);
      }
      return value;
    },
    spin: async (message, task) => {
      lines.push(`spin ${message}`);
      return options.cancelSpin ? CANCELLED : task();
    },
  };
  const fakeFetch = (async (url: string, init: RequestInit) => {
    fetches.push({ url: String(url), headers: init.headers as Record<string, string> });
    const status = http.shift() ?? 200;
    if (status === "down") throw new TypeError("fetch failed");
    return new Response("{}", { status });
  }) as typeof fetch;
  const deps: SetupDeps = {
    addMcp,
    interactive: options.interactive ?? true,
    prompter: async () => prompter,
    out: (line) => lines.push(`out ${line}`),
    err: (line) => lines.push(`err ${line}`),
    keychain: {
      read: async () => options.keychain ?? { status: "missing", detail: "no entry" },
      store: async (token) => {
        stored.push(token);
        return options.storeResult ?? { status: "stored" };
      },
    },
    fetch: fakeFetch,
    readStdin: async () => options.stdin ?? "",
    detect: async () => options.detected ?? ["claude-desktop", "cursor"],
    claudeCodeRunning: async () => options.claudeRunning ?? false,
    cwd: project,
    home,
    platform: options.platform ?? "darwin",
    launch: { command: BIN, args: [] },
    version: "9.9.9",
    now: () => new Date(2026, 10, 27, 9, 0, 0),
    holdInterrupts: async (task) => ({
      value: await task(),
      interrupted: options.interruptDuringApply ?? false,
    }),
  };
  const code = await runSetup(argv, deps);
  if (steps.length > 0) throw new Error(`prompts not asked: ${JSON.stringify(steps)}`);
  return { code, output: lines.join("\n"), asked, stored, fetches };
}

/** Everything under HOME, to show that nothing changed. */
function tree(): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      out.push(path);
      if (entry.isDirectory()) walk(path);
    }
  };
  walk(home);
  return out.sort();
}

const json = (path: string) => JSON.parse(readFileSync(path, "utf8"));

beforeEach(() => {
  for (const entry of readdirSync(home))
    rmSync(join(home, entry), { recursive: true, force: true });
  mkdirSync(project);
});

/** The usual interactive answers: agents, scope, mode, token, skill, apply. */
const happy = (agents: AgentType[] = ["claude-desktop", "cursor"]): Step[] => [
  { multiselect: agents },
  { select: "global" },
  { select: "read" },
  { password: TOKEN },
  { confirm: false },
  { confirm: true },
];

describe("runSetup without prompts", () => {
  it("prints the help", async () => {
    const result = await run(["--help"], { interactive: false });
    expect(result.code).toBe(EXIT.ok);
    expect(result.output).toContain("Usage: sevdesk-mcp setup");
  });

  it("refuses to run without a terminal unless --yes is given, and changes nothing", async () => {
    const before = tree();
    const result = await run([], { interactive: false });
    expect(result.code).toBe(EXIT.usage);
    expect(result.output).toContain("no terminal for the prompts");
    expect(result.output).toContain("--yes");
    expect(tree()).toEqual(before);
  });

  it("refuses unknown options and agents", async () => {
    expect((await run(["--bogus"], { interactive: false })).code).toBe(EXIT.usage);
    expect((await run(["--mode=admin"], { interactive: false })).code).toBe(EXIT.usage);
    const unknown = await run(["--yes", "--agents=notepad"], { interactive: false });
    expect(unknown.code).toBe(EXIT.usage);
    expect(unknown.output).toContain('unknown agent "notepad"');
  });

  it("sets up the detected agents with the options and the defaults", async () => {
    const result = await run(["--yes", "--mode=write"], { interactive: false });
    expect(result.code).toBe(EXIT.ok);
    expect(json(desktopFile()).mcpServers.sevdesk).toEqual({
      command: BIN,
      args: [],
      env: { SEVDESK_MODE: "write" },
    });
    expect(json(cursorFile).mcpServers.sevdesk.env).toEqual({ SEVDESK_MODE: "write" });
    // No token given: the keychain is left alone, and the output says how to store one.
    expect(result.stored).toEqual([]);
    expect(result.output).toContain("No token stored");
    expect(result.output).toContain(
      "security add-generic-password -U -s sevdesk-mcp -a api-token -w",
    );
    expect(result.asked).toEqual([]);
  });

  it("takes named agents and the project scope", async () => {
    const result = await run(["--yes", "--agents=cursor,claude-desktop", "--scope=project"], {
      interactive: false,
    });
    expect(result.code).toBe(EXIT.ok);
    expect(json(join(project, ".cursor", "mcp.json")).mcpServers.sevdesk.command).toBe(BIN);
    expect(existsSync(desktopFile())).toBe(false);
    expect(result.output).toContain("Claude Desktop: skipped, has no project configuration");
    expect(result.output).toContain("the token never goes into them");
  });

  it("reads the token from stdin, checks it and stores it", async () => {
    const result = await run(["--yes", "--token-stdin"], {
      interactive: false,
      stdin: `${TOKEN}\n`,
    });
    expect(result.code).toBe(EXIT.ok);
    expect(result.stored).toEqual([TOKEN]);
    expect(result.fetches).toEqual([
      {
        url: "https://my.sevdesk.de/api/v1/Tools/bookkeepingSystemVersion",
        headers: expect.objectContaining({ Authorization: TOKEN }),
      },
    ]);
    expect(result.output).not.toContain(TOKEN);
    for (const file of [cursorFile, desktopFile()])
      expect(readFileSync(file, "utf8")).not.toContain(TOKEN);
  });

  it("changes nothing for a malformed or rejected token on stdin", async () => {
    const before = tree();
    const malformed = await run(["--yes", "--token-stdin"], { interactive: false, stdin: "abc" });
    expect(malformed.code).toBe(EXIT.usage);
    expect(malformed.output).not.toContain("abc\n");
    const rejected = await run(["--yes", "--token-stdin"], {
      interactive: false,
      stdin: TOKEN,
      http: [401],
    });
    expect(rejected.code).toBe(EXIT.failed);
    expect(rejected.output).toContain("rejected");
    expect(rejected.stored).toEqual([]);
    expect(tree()).toEqual(before);
  });

  it("stores the token when sevdesk cannot be reached, with a warning", async () => {
    const result = await run(["--yes", "--token-stdin"], {
      interactive: false,
      stdin: TOKEN,
      http: ["down"],
    });
    expect(result.stored).toEqual([TOKEN]);
    expect(result.output).toContain("Could not check the token with sevdesk (no connection)");
  });

  it("skips the check with --no-verify", async () => {
    const result = await run(["--yes", "--token-stdin", "--no-verify"], {
      interactive: false,
      stdin: TOKEN,
    });
    expect(result.fetches).toEqual([]);
    expect(result.stored).toEqual([TOKEN]);
  });

  it("needs --yes for --token-stdin", async () => {
    expect((await run(["--token-stdin"], { interactive: true })).code).toBe(EXIT.usage);
  });

  it("fails when storing the token fails", async () => {
    const result = await run(["--yes", "--token-stdin"], {
      interactive: false,
      stdin: TOKEN,
      storeResult: { status: "failed", reason: "the keychain tool failed" },
    });
    expect(result.code).toBe(EXIT.failed);
    expect(result.output).toContain("Storing the token failed: the keychain tool failed");
  });

  it("installs the skill only with --skill", async () => {
    await run(["--yes", "--agents=cursor"], { interactive: false });
    expect(existsSync(join(home, ".agents", "skills", "sevdesk"))).toBe(false);
    const result = await run(["--yes", "--agents=cursor,claude-code", "--skill"], {
      interactive: false,
    });
    expect(result.code).toBe(EXIT.ok);
    for (const dir of [
      join(home, ".agents", "skills", "sevdesk"),
      join(home, ".claude", "skills", "sevdesk"),
    ]) {
      expect(readFileSync(join(dir, "SKILL.md"), "utf8")).toMatch(/^---\nname: sevdesk\n/);
      expect(existsSync(join(dir, SKILL_MARKER))).toBe(true);
    }
  });

  it("fails without agents to set up", async () => {
    const result = await run(["--yes"], { interactive: false, detected: [] });
    expect(result.code).toBe(EXIT.failed);
    expect(result.output).toContain("No agents found");
  });
});

describe("runSetup with prompts", () => {
  it("offers the detected agents preselected, then carries out the plan after one confirmation", async () => {
    const result = await run([], { steps: happy() });
    expect(result.code).toBe(EXIT.ok);
    const [agents] = result.asked;
    expect(agents?.initial).toEqual(["claude-desktop", "cursor"]);
    const choices = agents?.choices as { value: string; hint?: string }[];
    // Detected first, marked; every agent add-mcp knows is offered.
    expect(choices.slice(0, 2)).toEqual([
      expect.objectContaining({ value: "claude-desktop", hint: "detected" }),
      expect.objectContaining({ value: "cursor", hint: "detected" }),
    ]);
    expect(choices).toHaveLength(agentTypes(addMcp).length);
    expect(result.stored).toEqual([TOKEN]);
    expect(json(cursorFile).mcpServers.sevdesk.env).toEqual({ SEVDESK_MODE: "read" });
    expect(result.output).toContain("note Setup plan");
    expect(result.output).toContain("outro Restart the agents");
    expect(result.output).not.toContain(TOKEN);
  });

  it("does not ask for the scope when no selected agent has a project configuration", async () => {
    const result = await run([], {
      steps: [
        { multiselect: ["claude-desktop"] },
        { select: "write" },
        { password: "" },
        { confirm: true },
      ],
    });
    expect(result.code).toBe(EXIT.ok);
    expect(result.asked.map((a) => a.kind)).toEqual([
      "multiselect",
      "select",
      "password",
      "confirm",
    ]);
    expect(json(desktopFile()).mcpServers.sevdesk.env.SEVDESK_MODE).toBe("write");
    expect(result.output).toContain("token: not stored: no token entered");
  });

  it("asks again after a rejected token, at most three times", async () => {
    const result = await run([], {
      steps: [
        { multiselect: ["claude-desktop"] },
        { select: "read" },
        { password: TOKEN },
        { password: OTHER },
        { password: TOKEN },
        { confirm: true },
      ],
      http: [401, 401, 401],
    });
    expect(result.code).toBe(EXIT.ok);
    expect(result.fetches).toHaveLength(3);
    expect(result.stored).toEqual([]);
    expect(result.output).toContain("sevdesk rejected three tokens");
    expect(result.output.match(/rejected this token/g)).toHaveLength(3);
  });

  it("accepts the token after one rejection", async () => {
    const result = await run([], {
      steps: [
        { multiselect: ["claude-desktop"] },
        { select: "read" },
        { password: OTHER },
        { password: TOKEN },
        { confirm: true },
      ],
      http: [401, 200],
    });
    expect(result.stored).toEqual([TOKEN]);
    expect(result.output).toContain("sevdesk accepted the token");
  });

  it("keeps a token already in the keychain unless --replace-token is given", async () => {
    const kept = await run([], {
      keychain: { status: "found", token: TOKEN },
      steps: [{ multiselect: ["claude-desktop"] }, { select: "read" }, { confirm: true }],
    });
    expect(kept.stored).toEqual([]);
    expect(kept.output).toContain("token: keep the one in the keychain");
    const replaced = await run(["--replace-token"], {
      keychain: { status: "found", token: TOKEN },
      steps: [
        { multiselect: ["claude-desktop"] },
        { select: "read" },
        { password: OTHER },
        { confirm: true },
      ],
    });
    expect(replaced.stored).toEqual([OTHER]);
    // Enter instead of a new token keeps the stored one.
    const skipped = await run(["--replace-token"], {
      keychain: { status: "found", token: TOKEN },
      steps: [
        { multiselect: ["claude-desktop"] },
        { select: "read" },
        { password: "" },
        { confirm: true },
      ],
    });
    expect(skipped.stored).toEqual([]);
    expect(skipped.output).toContain("token: keep the one in the keychain");
    expect(skipped.output).not.toContain("No token stored");
  });

  it("names the missing keychain tool on Linux and asks for no token", async () => {
    const result = await run([], {
      keychain: { status: "unavailable" },
      platform: "linux",
      steps: [{ multiselect: ["claude-desktop"] }, { select: "read" }, { confirm: true }],
    });
    expect(result.output).toContain("secret-tool (libsecret) is not installed");
  });

  it("explains full mode", async () => {
    const result = await run(["--mode=full"], {
      steps: [{ multiselect: ["claude-desktop"] }, { password: "" }, { confirm: true }],
    });
    expect(result.output).toContain("SEVDESK_ENABLE_TOOLS");
    expect(json(desktopFile()).mcpServers.sevdesk.env.SEVDESK_MODE).toBe("full");
  });

  it("asks before replacing entries with their own command and keeps them on no", async () => {
    const entry = {
      command: "npx",
      args: ["-y", "@altipard/sevdesk-mcp"],
      env: { SEVDESK_API_TOKEN: TOKEN },
    };
    mkdirSync(dirname(cursorFile), { recursive: true });
    writeFileSync(cursorFile, JSON.stringify({ mcpServers: { sevdesk: entry } }));
    const kept = await run([], {
      steps: [
        { multiselect: ["cursor"] },
        { select: "global" },
        { select: "read" },
        { confirm: false },
        { password: "" },
        { confirm: false },
        { confirm: true },
      ],
    });
    expect(kept.code).toBe(EXIT.ok);
    expect(json(cursorFile).mcpServers.sevdesk).toEqual(entry);
    expect(kept.output).toContain("--replace-entries replaces it");
    expect(kept.output).not.toContain(TOKEN);

    const replaced = await run([], {
      steps: [
        { multiselect: ["cursor"] },
        { select: "global" },
        { select: "read" },
        { confirm: true },
        { password: "" },
        { confirm: false },
        { confirm: true },
      ],
    });
    expect(replaced.code).toBe(EXIT.ok);
    expect(json(cursorFile).mcpServers.sevdesk).toEqual({
      command: BIN,
      args: [],
      env: { SEVDESK_API_TOKEN: TOKEN, SEVDESK_MODE: "read" },
    });
  });

  it("changes nothing when the plan is declined", async () => {
    const before = tree();
    const steps = happy();
    steps[steps.length - 1] = { confirm: false };
    const result = await run([], { steps });
    expect(result.code).toBe(EXIT.ok);
    expect(result.output).toContain("outro Nothing was changed.");
    expect(result.stored).toEqual([]);
    expect(tree()).toEqual(before);
  });

  it.each([0, 1, 2, 3, 4, 5])("cancels at prompt %i with nothing changed", async (at) => {
    const before = tree();
    const steps = happy().slice(0, at + 1);
    const last = steps[at] as Record<string, unknown>;
    const kind = Object.keys(last)[0] ?? "";
    steps[at] = { [kind]: CANCELLED } as Step;
    const result = await run([], { steps });
    expect(result.code).toBe(EXIT.cancelled);
    expect(result.output).toContain("cancel Setup cancelled; nothing was changed.");
    expect(result.stored).toEqual([]);
    expect(tree()).toEqual(before);
  });

  it("offers the skill and the Claude Code plugin, and installs the skill on yes", async () => {
    const result = await run([], {
      steps: [
        { multiselect: ["claude-code", "cursor"] },
        { select: "global" },
        { select: "read" },
        { password: "" },
        { confirm: true },
        { confirm: true },
      ],
    });
    expect(result.code).toBe(EXIT.ok);
    expect(result.output).toContain("/plugin install sevdesk@sevdesk-mcp");
    expect(existsSync(join(home, ".claude", "skills", "sevdesk", "SKILL.md"))).toBe(true);
    expect(existsSync(join(home, ".agents", "skills", "sevdesk", "SKILL.md"))).toBe(true);
    // Claude Code rewrites its file while it runs: always say to restart it.
    expect(result.output).toContain("restart it now");
    expect(json(claudeFile).mcpServers.sevdesk.command).toBe(BIN);
  });

  it("says when Claude Code is running", async () => {
    const result = await run(["--yes", "--agents=claude-code"], {
      interactive: false,
      claudeRunning: true,
    });
    expect(result.output).toContain("Claude Code is running");
  });

  it("finishes the changes when interrupted during them, then exits 130", async () => {
    const result = await run([], { steps: happy(), interruptDuringApply: true });
    expect(result.code).toBe(EXIT.cancelled);
    expect(json(cursorFile).mcpServers.sevdesk.command).toBe(BIN);
    expect(json(desktopFile()).mcpServers.sevdesk.command).toBe(BIN);
  });

  it("skips an agent whose configuration cannot be used and still sets up the others", async () => {
    mkdirSync(cursorFile, { recursive: true });
    const result = await run(["--yes"], { interactive: false });
    expect(result.code).toBe(EXIT.ok);
    expect(result.output).toContain("Cursor: skipped, the configuration is not a regular file");
    expect(json(desktopFile()).mcpServers.sevdesk.command).toBe(BIN);
  });

  // Root may write into a read-only directory.
  it.skipIf(process.getuid?.() === 0)(
    "reports a failed write, leaves that file as it was and exits 1",
    async () => {
      mkdirSync(dirname(cursorFile), { recursive: true });
      writeFileSync(cursorFile, '{"mcpServers":{}}');
      // No new file can be created next to it, so the staged copy fails.
      chmodSync(dirname(cursorFile), 0o500);
      try {
        const result = await run(["--yes"], { interactive: false });
        expect(result.code).toBe(EXIT.failed);
        expect(result.output).toMatch(
          /error: Cursor: writing failed \(EACCES\); the original is unchanged/,
        );
        expect(result.output).toContain('"sevdesk"');
        expect(readFileSync(cursorFile, "utf8")).toBe('{"mcpServers":{}}');
        expect(json(desktopFile()).mcpServers.sevdesk.command).toBe(BIN);
      } finally {
        chmodSync(dirname(cursorFile), 0o700);
      }
    },
  );

  it("cancels with nothing changed when Ctrl-C comes while the token is checked", async () => {
    const before = tree();
    const result = await run([], {
      steps: [
        { multiselect: ["cursor"] },
        { select: "global" },
        { select: "read" },
        { password: TOKEN },
      ],
      cancelSpin: true,
    });
    expect(result.code).toBe(EXIT.cancelled);
    expect(result.stored).toEqual([]);
    expect(tree()).toEqual(before);
  });
});
