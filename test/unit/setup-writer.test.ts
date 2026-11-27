import {
  chmodSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import {
  type AddMcp,
  agentTypes,
  classifyEntry,
  configPath,
  type Launch,
  readServers,
} from "../../src/setup/agents.js";
import { type EntryRequest, planEntry, writeEntry } from "../../src/setup/writer.js";

// Writes client configurations with the real add-mcp, loaded under a temporary HOME. add-mcp
// fixes its paths when it is imported, so the variables it reads are cleared first and every
// path is checked to lie inside the temporary HOME before any test runs: a real client
// configuration is never touched.

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
const home = mkdtempSync(join(tmpdir(), "sevdesk-mcp-setup-home-"));
for (const name of ADD_MCP_ENV) delete process.env[name];
process.env.HOME = home;
const addMcp = (await import("add-mcp")) as unknown as AddMcp;
const project = join(home, "project");
for (const agent of agentTypes(addMcp)) {
  const path = configPath(addMcp, agent, "global", project);
  if (!path.startsWith(home)) throw new Error(`add-mcp resolved ${agent} outside the test HOME`);
}

const BIN = "/opt/sevdesk/bin/sevdesk-mcp";
const LAUNCH: Launch = { command: BIN, args: [] };
const TOKEN = "0123456789abcdef0123456789abcdef";

const cursorFile = join(home, ".cursor", "mcp.json");
const desktopFile = () => configPath(addMcp, "claude-desktop", "global", project);
const claudeFile = () => configPath(addMcp, "claude-code", "global", project);

function request(overrides: Partial<EntryRequest> = {}): EntryRequest {
  return {
    agent: "cursor",
    scope: "global",
    cwd: project,
    launch: LAUNCH,
    mode: "read",
    replaceEntries: false,
    removeEnvToken: false,
    ...overrides,
  };
}

function write(path: string, content: unknown, mode = 0o644) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, typeof content === "string" ? content : JSON.stringify(content, null, 2));
  chmodSync(path, mode);
}

const json = (path: string) => JSON.parse(readFileSync(path, "utf8"));
const backups = (path: string) =>
  readdirSync(dirname(path)).filter((name) => name.startsWith(`${path.split("/").at(-1)}.backup-`));
const leftovers = (path: string) =>
  readdirSync(dirname(path)).filter((name) => name.includes(".sevdesk-mcp-"));

beforeEach(() => {
  for (const entry of readdirSync(home))
    rmSync(join(home, entry), { recursive: true, force: true });
  mkdirSync(project);
});

describe("writeEntry", () => {
  it("adds the entry to a new file, private, without a backup", async () => {
    const outcome = await writeEntry(addMcp, request({ agent: "claude-desktop" }));
    expect(outcome).toEqual({ status: "ok", path: desktopFile(), action: "add" });
    expect(json(desktopFile())).toEqual({
      mcpServers: { sevdesk: { command: BIN, args: [], env: { SEVDESK_MODE: "read" } } },
    });
    expect(statSync(desktopFile()).mode & 0o777).toBe(0o600);
    expect(backups(desktopFile())).toEqual([]);
    expect(leftovers(desktopFile())).toEqual([]);
  });

  it("keeps other entries and settings, the file mode and backs the original up (mode 600)", async () => {
    const original = {
      theme: "dark",
      mcpServers: { other: { command: "x", env: { OTHER_TOKEN: "secret" } } },
    };
    write(cursorFile, original, 0o640);
    const outcome = await writeEntry(addMcp, request({ mode: "write" }));
    expect(outcome.status).toBe("ok");
    expect(json(cursorFile)).toEqual({
      theme: "dark",
      mcpServers: {
        other: { command: "x", env: { OTHER_TOKEN: "secret" } },
        sevdesk: { command: BIN, args: [], env: { SEVDESK_MODE: "write" } },
      },
    });
    expect(statSync(cursorFile).mode & 0o777).toBe(0o640);
    const [backup] = backups(cursorFile);
    expect(outcome).toMatchObject({ backup: join(dirname(cursorFile), backup ?? "") });
    expect(json(join(dirname(cursorFile), backup ?? ""))).toEqual(original);
    expect(statSync(join(dirname(cursorFile), backup ?? "")).mode & 0o777).toBe(0o600);
    expect(leftovers(cursorFile)).toEqual([]);
  });

  it("keeps the other env of an existing entry and only sets SEVDESK_MODE", async () => {
    write(cursorFile, {
      mcpServers: {
        sevdesk: {
          command: BIN,
          args: [],
          env: {
            SEVDESK_MODE: "read",
            SEVDESK_API_TOKEN: TOKEN,
            SEVDESK_ENABLE_TOOLS: "cancel_invoice",
          },
        },
      },
    });
    const outcome = await writeEntry(addMcp, request({ mode: "full" }));
    expect(outcome).toMatchObject({ status: "ok", action: "update" });
    expect(json(cursorFile).mcpServers.sevdesk.env).toEqual({
      SEVDESK_MODE: "full",
      SEVDESK_API_TOKEN: TOKEN,
      SEVDESK_ENABLE_TOOLS: "cancel_invoice",
    });
  });

  it("changes nothing when the entry is already set up", async () => {
    const content = JSON.stringify({
      mcpServers: { sevdesk: { command: BIN, args: [], env: { SEVDESK_MODE: "read" } } },
    });
    write(cursorFile, content);
    expect(await writeEntry(addMcp, request())).toEqual({ status: "unchanged", path: cursorFile });
    expect(readFileSync(cursorFile, "utf8")).toBe(content);
    expect(backups(cursorFile)).toEqual([]);
  });

  it("leaves a remote entry alone and shows nothing of it", async () => {
    const content = JSON.stringify({
      mcpServers: {
        sevdesk: { url: "https://mcp.example/sevdesk", headers: { Authorization: TOKEN } },
      },
    });
    write(cursorFile, content);
    const outcome = await writeEntry(addMcp, request());
    expect(outcome).toMatchObject({ status: "skipped", reason: expect.stringContaining("remote") });
    expect(JSON.stringify(outcome)).not.toContain(TOKEN);
    expect(JSON.stringify(outcome)).not.toContain("mcp.example");
    expect(readFileSync(cursorFile, "utf8")).toBe(content);
    expect(backups(cursorFile)).toEqual([]);
  });

  it("keeps an entry with its own command unless replacing is asked for, and its env either way", async () => {
    const entry = {
      command: "npx",
      args: ["-y", "@altipard/sevdesk-mcp"],
      env: { SEVDESK_API_TOKEN: TOKEN },
    };
    write(cursorFile, { mcpServers: { sevdesk: entry } });
    const kept = await writeEntry(addMcp, request());
    expect(kept).toMatchObject({
      status: "skipped",
      reason: expect.stringContaining("own command"),
    });
    expect(JSON.stringify(kept)).not.toContain(TOKEN);
    expect(json(cursorFile).mcpServers.sevdesk).toEqual(entry);

    const replaced = await writeEntry(addMcp, request({ replaceEntries: true }));
    expect(replaced).toMatchObject({ status: "ok", action: "replace" });
    expect(json(cursorFile).mcpServers.sevdesk).toEqual({
      command: BIN,
      args: [],
      env: { SEVDESK_API_TOKEN: TOKEN, SEVDESK_MODE: "read" },
    });
  });

  it("treats settings add-mcp would drop or reset as the entry's own, naming only the keys", async () => {
    const clineFile = configPath(addMcp, "cline-cli", "global", project);
    write(clineFile, {
      mcpServers: {
        sevdesk: {
          command: BIN,
          args: [],
          disabled: true,
          autoApprove: ["get_invoice"],
          env: { N: 1 },
        },
      },
    });
    const plan = await planEntry(addMcp, request({ agent: "cline-cli" }));
    expect(plan).toMatchObject({ action: "skip", custom: true });
    expect(plan.action === "skip" && plan.reason).toContain("disabled, autoApprove, env.N");
    expect(
      await planEntry(addMcp, request({ agent: "cline-cli", replaceEntries: true })),
    ).toMatchObject({
      action: "replace",
      dropped: ["disabled", "autoApprove", "env.N"],
    });
  });

  it("leaves a file that is not valid JSON untouched and offers the entry to add by hand", async () => {
    write(cursorFile, '{ "mcpServers": { "a": 1, ');
    const outcome = await writeEntry(addMcp, request());
    expect(outcome).toMatchObject({
      status: "skipped",
      reason: expect.stringContaining("not valid JSON"),
    });
    expect(outcome.status === "skipped" && JSON.parse(outcome.snippet ?? "")).toEqual({
      sevdesk: { command: BIN, args: [], env: { SEVDESK_MODE: "read" } },
    });
    expect(readFileSync(cursorFile, "utf8")).toBe('{ "mcpServers": { "a": 1, ');
    expect(backups(cursorFile)).toEqual([]);
  });

  it("accepts comments and trailing commas and keeps the comments", async () => {
    write(cursorFile, '{\n  // mine\n  "mcpServers": {\n    "a": { "command": "a" },\n  },\n}\n');
    const outcome = await writeEntry(addMcp, request());
    expect(outcome.status).toBe("ok");
    const text = readFileSync(cursorFile, "utf8");
    expect(text).toContain("// mine");
    expect(text).toContain(BIN);
  });

  it("does not follow a symbolic link", async () => {
    const real = join(home, "real.json");
    write(real, { mcpServers: {} });
    mkdirSync(dirname(cursorFile), { recursive: true });
    symlinkSync(real, cursorFile);
    expect(await writeEntry(addMcp, request())).toMatchObject({
      status: "skipped",
      reason: expect.stringContaining("symbolic link"),
    });
    expect(lstatSync(cursorFile).isSymbolicLink()).toBe(true);
    expect(json(real)).toEqual({ mcpServers: {} });
  });

  it("writes TOML for Codex and keeps the entry's other env", async () => {
    const codexFile = configPath(addMcp, "codex", "global", project);
    write(
      codexFile,
      `model = "x"\n\n[mcp_servers.sevdesk]\ncommand = "${BIN}"\n\n[mcp_servers.sevdesk.env]\nFOO = "bar"\n`,
    );
    expect(await writeEntry(addMcp, request({ agent: "codex", mode: "write" }))).toMatchObject({
      status: "ok",
    });
    const text = readFileSync(codexFile, "utf8");
    expect(text).toContain('model = "x"');
    expect(text).toContain('FOO = "bar"');
    expect(text).toContain('SEVDESK_MODE = "write"');
    expect(backups(codexFile)).toHaveLength(1);
  });

  it("leaves an unparsable TOML file untouched", async () => {
    const codexFile = configPath(addMcp, "codex", "global", project);
    write(codexFile, "[mcp_servers.sevdesk\n");
    expect(await writeEntry(addMcp, request({ agent: "codex" }))).toMatchObject({
      status: "skipped",
      reason: expect.stringContaining("cannot be parsed"),
    });
    expect(readFileSync(codexFile, "utf8")).toBe("[mcp_servers.sevdesk\n");
  });

  it("starts over when the file changes while it is written, and gives up the second time", async () => {
    write(cursorFile, { mcpServers: {} });
    let changes = 0;
    const once = await writeEntry(addMcp, request(), {
      beforeCommit: (path) => {
        if (changes++ === 0)
          writeFileSync(path, JSON.stringify({ mcpServers: { other: { command: "o" } } }));
      },
    });
    expect(once.status).toBe("ok");
    expect(Object.keys(json(cursorFile).mcpServers).sort()).toEqual(["other", "sevdesk"]);

    let n = 0;
    const always = await writeEntry(addMcp, request({ mode: "write" }), {
      beforeCommit: (path) =>
        writeFileSync(path, JSON.stringify({ mcpServers: { n: { command: String(n++) } } })),
    });
    expect(always).toMatchObject({
      status: "error",
      reason: expect.stringContaining("kept changing"),
    });
    expect(json(cursorFile).mcpServers.sevdesk).toBeUndefined();
    expect(leftovers(cursorFile)).toEqual([]);
    expect(backups(cursorFile)).toHaveLength(1);
  });

  it("writes the project file of an agent that has one and skips the others", async () => {
    const cursor = await writeEntry(addMcp, request({ scope: "project" }));
    expect(cursor).toMatchObject({ status: "ok", path: join(project, ".cursor", "mcp.json") });
    const code = await writeEntry(addMcp, request({ agent: "claude-code", scope: "project" }));
    expect(code).toMatchObject({ status: "ok", path: join(project, ".mcp.json") });
    expect(json(join(project, ".mcp.json")).mcpServers.sevdesk.env).toEqual({
      SEVDESK_MODE: "read",
    });
    expect(
      await writeEntry(addMcp, request({ agent: "claude-desktop", scope: "project" })),
    ).toMatchObject({
      status: "skipped",
      reason: "has no project configuration",
    });
  });

  it("finds Claude Code's file in CLAUDE_CONFIG_DIR", async () => {
    const dir = join(home, "claude-config");
    process.env.CLAUDE_CONFIG_DIR = dir;
    try {
      expect(configPath(addMcp, "claude-code", "global", project)).toBe(join(dir, ".claude.json"));
      const outcome = await writeEntry(addMcp, request({ agent: "claude-code" }));
      expect(outcome).toMatchObject({ status: "ok", path: join(dir, ".claude.json") });
    } finally {
      delete process.env.CLAUDE_CONFIG_DIR;
    }
  });

  it("restores add-mcp's own paths after staging", async () => {
    write(cursorFile, { mcpServers: {} });
    await writeEntry(addMcp, request());
    expect(configPath(addMcp, "cursor", "global", project)).toBe(cursorFile);
    const read = await readServers(addMcp, "cursor", cursorFile, "global", project);
    expect(read.names).toEqual(["sevdesk"]);
  });

  it("updates entries the shell installer wrote (type stdio) without asking", async () => {
    write(claudeFile(), {
      mcpServers: {
        sevdesk: { type: "stdio", command: BIN, args: [], env: { SEVDESK_MODE: "read" } },
      },
    });
    expect(await planEntry(addMcp, request({ agent: "claude-code" }))).toMatchObject({
      action: "unchanged",
    });
    expect(
      await writeEntry(addMcp, request({ agent: "claude-code", mode: "write" })),
    ).toMatchObject({
      status: "ok",
      action: "update",
    });
    expect(json(claudeFile()).mcpServers.sevdesk.env).toEqual({ SEVDESK_MODE: "write" });
    // VS Code, as `code --add-mcp` wrote it.
    const vscodeFile = configPath(addMcp, "vscode", "global", project);
    write(vscodeFile, {
      servers: { sevdesk: { type: "stdio", command: BIN, env: { SEVDESK_MODE: "read" } } },
    });
    expect(await planEntry(addMcp, request({ agent: "vscode" }))).toMatchObject({
      action: "unchanged",
    });
  });

  it("leaves the original and no backup when the final rename fails", async () => {
    const original = JSON.stringify({ mcpServers: { other: { command: "o" } } });
    write(cursorFile, original);
    const outcome = await writeEntry(addMcp, request(), {
      rename: async () => {
        throw Object.assign(new Error("rename failed"), { code: "EXDEV" });
      },
    });
    expect(outcome).toMatchObject({
      status: "error",
      reason: "replacing the configuration failed; the original is unchanged",
    });
    expect(readFileSync(cursorFile, "utf8")).toBe(original);
    expect(backups(cursorFile)).toEqual([]);
    expect(leftovers(cursorFile)).toEqual([]);
  });
});

describe("writeEntry: token in env, comments, backups", () => {
  const withToken = {
    mcpServers: {
      sevdesk: { command: BIN, args: [], env: { SEVDESK_MODE: "read", SEVDESK_API_TOKEN: TOKEN } },
    },
  };

  it("reports a SEVDESK_API_TOKEN in the entry's env by name only and keeps it unless asked", async () => {
    write(cursorFile, withToken);
    const plan = await planEntry(addMcp, request());
    expect(plan).toMatchObject({ action: "unchanged", envToken: true });
    expect(JSON.stringify(plan)).not.toContain(TOKEN);
    await writeEntry(addMcp, request({ mode: "write" }));
    expect(json(cursorFile).mcpServers.sevdesk.env.SEVDESK_API_TOKEN).toBe(TOKEN);
  });

  it("removes the env token on request; the backup still holds it", async () => {
    write(cursorFile, withToken);
    expect(await planEntry(addMcp, request({ removeEnvToken: true }))).toMatchObject({
      action: "update",
      envToken: true,
    });
    const outcome = await writeEntry(addMcp, request({ removeEnvToken: true }));
    expect(outcome).toMatchObject({ status: "ok", action: "update" });
    expect(json(cursorFile).mcpServers.sevdesk.env).toEqual({ SEVDESK_MODE: "read" });
    expect(readFileSync(outcome.status === "ok" ? (outcome.backup ?? "") : "", "utf8")).toContain(
      TOKEN,
    );
  });

  it("flags the env token of an entry it skips, too", async () => {
    write(cursorFile, {
      mcpServers: { sevdesk: { command: "npx", env: { SEVDESK_API_TOKEN: TOKEN } } },
    });
    expect(await planEntry(addMcp, request())).toMatchObject({
      action: "skip",
      custom: true,
      envToken: true,
    });
  });

  it("predicts lost comments: TOML for Codex and the servers block of VS Code", async () => {
    const codexFile = configPath(addMcp, "codex", "global", project);
    write(codexFile, '# my settings\nmodel = "x" # inline\n');
    expect(await planEntry(addMcp, request({ agent: "codex" }))).toMatchObject({
      commentsLost: true,
    });
    const vscodeFile = configPath(addMcp, "vscode", "global", project);
    write(vscodeFile, '{\n  "servers": {\n    // keep me\n    "a": { "command": "a" }\n  }\n}\n');
    expect(await planEntry(addMcp, request({ agent: "vscode" }))).toMatchObject({
      commentsLost: true,
    });
    // Nothing is left behind by the dry run, and the files are unchanged.
    expect(readFileSync(codexFile, "utf8")).toBe('# my settings\nmodel = "x" # inline\n');
    expect(leftovers(codexFile)).toEqual([]);
  });

  it("does not warn when the comments survive or there are none", async () => {
    write(cursorFile, '{\n  // top\n  "mcpServers": {}\n}\n');
    expect(await planEntry(addMcp, request())).not.toHaveProperty("commentsLost");
    write(desktopFile(), { mcpServers: {} });
    expect(await planEntry(addMcp, request({ agent: "claude-desktop" }))).not.toHaveProperty(
      "commentsLost",
    );
  });

  it("puts backups into the backup directory when one is given, named after the file", async () => {
    const projectCursor = join(project, ".cursor", "mcp.json");
    write(projectCursor, { mcpServers: {} });
    const dir = join(home, "state", "backups");
    const outcome = await writeEntry(addMcp, request({ scope: "project", backupDir: dir }));
    expect(outcome.status).toBe("ok");
    const backup = outcome.status === "ok" ? (outcome.backup ?? "") : "";
    expect(dirname(backup)).toBe(dir);
    expect(backup.split("/").at(-1)).toMatch(/^mcp\.json\.[0-9a-f]{8}\.backup-\d{14}$/);
    expect(statSync(backup).mode & 0o777).toBe(0o600);
    expect(statSync(dir).mode & 0o777).toBe(0o700);
    expect(backups(projectCursor)).toEqual([]);
  });

  it("starts over when the file changes after the backup, keeping no stale backup", async () => {
    write(cursorFile, { mcpServers: {} });
    let changes = 0;
    const outcome = await writeEntry(addMcp, request(), {
      afterBackup: (path) => {
        if (changes++ === 0)
          writeFileSync(path, JSON.stringify({ mcpServers: { other: { command: "o" } } }));
      },
    });
    expect(outcome.status).toBe("ok");
    expect(Object.keys(json(cursorFile).mcpServers).sort()).toEqual(["other", "sevdesk"]);
    const all = backups(cursorFile);
    expect(all).toHaveLength(1);
    expect(json(join(dirname(cursorFile), all[0] ?? ""))).toEqual({
      mcpServers: { other: { command: "o" } },
    });
  });
});

describe("writeEntry for every agent", () => {
  it.each(agentTypes(addMcp))(
    "%s: adds, then finds it set up, then updates the mode keeping other env",
    async (agent) => {
      const first = await writeEntry(addMcp, request({ agent }));
      expect(first).toMatchObject({ status: "ok", action: "add" });
      expect(await planEntry(addMcp, request({ agent }))).toMatchObject({ action: "unchanged" });
      const path = configPath(addMcp, agent, "global", project);
      const update = await writeEntry(addMcp, request({ agent, mode: "write" }));
      expect(update).toMatchObject({ status: "ok", action: "update", path });
      const read = await readServers(addMcp, agent, path, "global", project);
      expect(classifyEntry(read.entry, LAUNCH)).toEqual({
        kind: "ours",
        env: { SEVDESK_MODE: "write" },
      });
      expect(leftovers(path)).toEqual([]);
    },
  );
});
