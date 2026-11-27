import { accessSync, constants, existsSync, statSync } from "node:fs";
import { delimiter, join } from "node:path";
import type { AgentConfig, AgentServers, AgentType, InstallResult, McpServerConfig } from "add-mcp";

/** The part of add-mcp the setup uses; tests hand in the real module loaded under a temp HOME. */
export interface AddMcp {
  agents: Record<AgentType, AgentConfig>;
  detectGlobalAgents(): Promise<AgentType[]>;
  listInstalledServers(options: {
    global?: boolean;
    agents?: AgentType[];
    cwd?: string;
  }): Promise<AgentServers[]>;
  upsertServer(
    agentType: AgentType,
    serverName: string,
    config: McpServerConfig,
    options?: { local?: boolean; cwd?: string },
  ): InstallResult;
}

/**
 * add-mcp computes its configuration paths from HOME when it is imported, so it is loaded only
 * when the setup runs: the server never imports it.
 */
export async function loadAddMcp(): Promise<AddMcp> {
  return (await import("add-mcp")) as AddMcp;
}

export type Scope = "global" | "project";

/** Name of the server entry in every client configuration. */
export const SERVER_NAME = "sevdesk";

export function agentTypes(addMcp: AddMcp): AgentType[] {
  return Object.keys(addMcp.agents) as AgentType[];
}

export function supportsProject(addMcp: AddMcp, agent: AgentType): boolean {
  return addMcp.agents[agent].localConfigPath !== undefined;
}

/** The configuration file add-mcp writes for this agent and scope (its own rule, mirrored). */
export function configPath(addMcp: AddMcp, agent: AgentType, scope: Scope, cwd: string): string {
  const config = addMcp.agents[agent];
  const local = scope === "project";
  // Claude Code keeps .claude.json in CLAUDE_CONFIG_DIR when that is set; add-mcp ignores it.
  const claudeDir = process.env.CLAUDE_CONFIG_DIR;
  if (agent === "claude-code" && !local && claudeDir) return join(claudeDir, ".claude.json");
  if (config.resolveConfigPath) return config.resolveConfigPath(config, { local, cwd });
  if (local && config.localConfigPath) return join(cwd, config.localConfigPath);
  return config.configPath;
}

/**
 * Runs `fn` while add-mcp treats `agent` as installed and its configuration as living at
 * `path`. This lets the setup read and write a staged copy next to the real file and rename it
 * into place afterwards, which add-mcp itself does not do. Synchronous swaps around one call:
 * nothing else in this process uses add-mcp meanwhile.
 */
export async function withConfigAt<T>(
  addMcp: AddMcp,
  agent: AgentType,
  path: string,
  fn: () => T | Promise<T>,
): Promise<T> {
  const original = addMcp.agents[agent];
  addMcp.agents[agent] = {
    ...original,
    resolveConfigPath: () => path,
    detectGlobalInstall: async () => true,
    // join(cwd, ".") always exists, so project detection finds the agent too.
    projectDetectPaths: ["."],
  };
  try {
    return await fn();
  } finally {
    addMcp.agents[agent] = original;
  }
}

export interface ReadResult {
  /** The "sevdesk" entry as stored, if any. */
  entry?: Record<string, unknown>;
  /** Names of all server entries in the file. */
  names: string[];
  error?: string;
}

/** Reads the server entries of the file at `path` with add-mcp's reader for this agent. */
export async function readServers(
  addMcp: AddMcp,
  agent: AgentType,
  path: string,
  scope: Scope,
  cwd: string,
): Promise<ReadResult> {
  return withConfigAt(addMcp, agent, path, async () => {
    const [result] = await addMcp.listInstalledServers({
      global: scope === "global",
      agents: [agent],
      cwd,
    });
    if (!result) return { names: [], error: "no result" };
    const entry = result.servers.find((server) => server.serverName === SERVER_NAME)?.config;
    return {
      ...(entry ? { entry } : {}),
      names: result.servers.map((server) => server.serverName),
      ...(result.error ? { error: result.error } : {}),
    };
  });
}

/** How the setup starts the server: the compiled binary, or the npm package through npx. */
export interface Launch {
  command: string;
  args: string[];
}

export const NPX_LAUNCH: Launch = { command: "npx", args: ["-y", "@altipard/sevdesk-mcp"] };

/**
 * A bun-compiled binary runs its bundled modules from a virtual file system ($bunfs, or ~BUN
 * on Windows); then the binary itself is the command. Otherwise this is the npm package, maybe
 * from an npx cache that goes away, so the entry starts it through npx.
 */
export function detectLaunch(moduleUrl: string, execPath: string): Launch {
  if (moduleUrl.includes("/$bunfs/") || moduleUrl.includes("~BUN")) {
    return { command: execPath, args: [] };
  }
  return NPX_LAUNCH;
}

/** An entry in any agent's shape, reduced to what the setup compares. */
export type EntryKind =
  | { kind: "none" }
  | { kind: "remote" }
  | { kind: "ours"; env: Record<string, string> }
  | { kind: "custom"; env: Record<string, string> };

const REMOTE_KEYS = ["url", "uri", "serverUrl", "httpUrl"];
const REMOTE_TYPES = [
  "http",
  "sse",
  "remote",
  "streamable_http",
  "streamableHttp",
  "streamable-http",
];

function stringRecord(value: unknown): Record<string, string> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const out: Record<string, string> = {};
  for (const [key, item] of Object.entries(value)) {
    if (typeof item === "string") out[key] = item;
  }
  return out;
}

/**
 * none, remote (URL or a non-stdio type: left alone), ours (this launch command, no extra
 * args) or custom (another command or args). env is the entry's environment in any of the
 * agents' spellings (env, envs, environment); only string values count.
 */
export function classifyEntry(
  entry: Record<string, unknown> | undefined,
  launch: Launch,
): EntryKind {
  if (!entry) return { kind: "none" };
  if (REMOTE_KEYS.some((key) => entry[key] !== undefined)) return { kind: "remote" };
  const type = entry.type ?? entry.transport;
  if (typeof type === "string" && REMOTE_TYPES.includes(type)) return { kind: "remote" };
  let command: unknown = entry.command ?? entry.cmd;
  let args: unknown = entry.args ?? [];
  if (Array.isArray(command)) {
    args = command.slice(1);
    command = command[0];
  }
  const env = stringRecord(entry.env ?? entry.envs ?? entry.environment);
  const sameArgs =
    Array.isArray(args) &&
    args.length === launch.args.length &&
    args.every((arg, index) => arg === launch.args[index]);
  return command === launch.command && sameArgs ? { kind: "ours", env } : { kind: "custom", env };
}

/** True if an executable `name` is on PATH (no process is started). */
export function onPath(name: string, path = process.env.PATH ?? ""): boolean {
  return path
    .split(delimiter)
    .filter((dir) => dir !== "")
    .some((dir) => {
      try {
        const file = join(dir, name);
        accessSync(file, constants.X_OK);
        // A directory is "executable" too.
        return statSync(file).isFile();
      } catch {
        return false;
      }
    });
}

export interface DetectOptions {
  platform?: NodeJS.Platform;
  home?: string;
  path?: string;
  exists?: (path: string) => boolean;
}

/**
 * Agents add-mcp finds (their configuration directory exists) plus the ones only their
 * application or CLI gives away, as the shell installer detected them: Claude Desktop and
 * Cursor from their macOS app bundles, Claude Code, Cursor and VS Code from their CLI on PATH.
 */
export async function detectAgents(
  addMcp: AddMcp,
  options: DetectOptions = {},
): Promise<AgentType[]> {
  const found = new Set(await addMcp.detectGlobalAgents());
  const exists = options.exists ?? existsSync;
  const platform = options.platform ?? process.platform;
  const home = options.home ?? process.env.HOME ?? "";
  const path = options.path ?? process.env.PATH ?? "";
  const app = (name: string) =>
    platform === "darwin" &&
    (exists(`/Applications/${name}.app`) ||
      (home !== "" && exists(join(home, "Applications", `${name}.app`))));
  if (app("Claude")) found.add("claude-desktop");
  if (app("Cursor") || onPath("cursor", path)) found.add("cursor");
  if (onPath("claude", path)) found.add("claude-code");
  if (onPath("code", path)) found.add("vscode");
  return agentTypes(addMcp).filter((agent) => found.has(agent));
}
