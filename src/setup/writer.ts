import { createHash, randomBytes } from "node:crypto";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import type { AgentType, McpServerConfig } from "add-mcp";
import {
  type AddMcp,
  classifyEntry,
  configPath,
  type EntryKind,
  type Launch,
  readServers,
  type Scope,
  SERVER_NAME,
  supportsProject,
  withConfigAt,
} from "./agents.js";
import { countHashComments, countJsoncComments, parseJsonc } from "./jsonc.js";

export type Mode = "read" | "write" | "full";

export interface EntryRequest {
  agent: AgentType;
  scope: Scope;
  cwd: string;
  launch: Launch;
  mode: Mode;
  /** Replace an entry with its own command or args (its env is still kept). */
  replaceEntries: boolean;
  /** Drop SEVDESK_API_TOKEN from the entry's env, so the server uses the keychain token. */
  removeEnvToken: boolean;
  /**
   * Where backups go; next to the configuration when unset. A project file gets its backups in
   * a user directory, so they do not end up in the repository.
   */
  backupDir?: string;
}

/** The env variable that, set in an entry, wins over the keychain token. */
export const ENV_TOKEN = "SEVDESK_API_TOKEN";

/**
 * What the setup will do with one agent, found before anything is written:
 * add, update (our entry, env kept, mode set), replace (custom entry, only with
 * replaceEntries), unchanged, or skip with a reason.
 */
export type EntryPlan =
  | {
      action: "add" | "update" | "replace" | "unchanged";
      path: string;
      kind: EntryKind["kind"];
      /** replace: what the existing entry loses (names only). */
      dropped?: string[];
      /** The existing entry has SEVDESK_API_TOKEN in its env. */
      envToken?: boolean;
      /** Writing loses comments of the file (add-mcp rewrites that part without them). */
      commentsLost?: boolean;
    }
  | {
      action: "skip";
      path: string;
      reason: string;
      snippet?: string;
      custom?: boolean;
      envToken?: boolean;
    };

export type EntryOutcome =
  | { status: "ok"; path: string; backup?: string; action: "add" | "update" | "replace" }
  | { status: "unchanged"; path: string }
  | { status: "skipped"; path: string; reason: string; snippet?: string }
  | { status: "error"; path: string; reason: string; snippet?: string };

interface Inspection {
  plan: EntryPlan;
  /** File content when inspected; null if the file does not exist. */
  original: string | null;
  env: Record<string, string>;
}

/** The entry in this agent's shape, for the user to add by hand; never holds a secret. */
export function snippet(addMcp: AddMcp, request: EntryRequest): string {
  const config = addMcp.agents[request.agent];
  const entry = config.transformConfig(SERVER_NAME, serverConfig(request, {}), {
    local: request.scope === "project",
  });
  return JSON.stringify({ [SERVER_NAME]: entry }, null, 2);
}

function serverConfig(request: EntryRequest, env: Record<string, string>): McpServerConfig {
  return {
    command: request.launch.command,
    args: [...request.launch.args],
    env: { ...env, SEVDESK_MODE: request.mode },
  };
}

function nestedValue(value: unknown, key: string): unknown {
  if (key === "") return value;
  let current = value;
  for (const part of key.split(".")) {
    if (!current || typeof current !== "object" || Array.isArray(current)) return undefined;
    current = (current as Record<string, unknown>)[part];
  }
  return current;
}

async function inspect(addMcp: AddMcp, request: EntryRequest): Promise<Inspection> {
  const { agent, scope, cwd } = request;
  const config = addMcp.agents[agent];
  const skip = (path: string, reason: string, extra: { custom?: boolean } = {}): Inspection => ({
    plan: { action: "skip", path, reason, snippet: snippet(addMcp, request), ...extra },
    original: null,
    env: {},
  });
  if (scope === "project" && !supportsProject(addMcp, agent)) {
    return {
      plan: { action: "skip", path: "", reason: "has no project configuration" },
      original: null,
      env: {},
    };
  }
  let path: string;
  try {
    path = configPath(addMcp, agent, scope, cwd);
  } catch {
    return {
      plan: {
        action: "skip",
        path: "",
        reason: "the configuration path cannot be determined",
      },
      original: null,
      env: {},
    };
  }
  let original: string | null = null;
  try {
    const info = await lstat(path);
    if (info.isSymbolicLink()) return skip(path, "the configuration is a symbolic link");
    if (!info.isFile()) return skip(path, "the configuration is not a regular file");
    original = await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      return skip(path, "the configuration cannot be read");
    }
  }
  if (original !== null && original.trim() !== "" && config.format === "json") {
    let parsed: unknown;
    try {
      parsed = parseJsonc(original);
    } catch {
      return skip(path, "the configuration is not valid JSON");
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return skip(path, "the configuration is not a JSON object");
    }
    const key =
      scope === "project" && config.localConfigKey ? config.localConfigKey : config.configKey;
    const servers = nestedValue(parsed, key);
    const existing =
      servers && typeof servers === "object" && !Array.isArray(servers)
        ? (servers as Record<string, unknown>)[SERVER_NAME]
        : undefined;
    if (
      existing !== undefined &&
      (!existing || typeof existing !== "object" || Array.isArray(existing))
    ) {
      return skip(path, `the "${SERVER_NAME}" entry is not an object`);
    }
  }
  const read = await readServers(addMcp, agent, path, scope, cwd);
  if (read.error) return skip(path, "the configuration cannot be parsed");
  const kind = classifyEntry(read.entry, request.launch);
  const result = (plan: EntryPlan, env: Record<string, string> = {}): Inspection => ({
    plan,
    original,
    env,
  });
  if (kind.kind === "none") {
    const env = {};
    const commentsLost = await predictCommentLoss(addMcp, request, path, original, env);
    return result(
      { action: "add", path, kind: "none", ...(commentsLost ? { commentsLost } : {}) },
      env,
    );
  }
  if (kind.kind === "remote") {
    return {
      plan: {
        action: "skip",
        path,
        reason: `the "${SERVER_NAME}" entry is a remote (URL) entry and stays unchanged`,
      },
      original: null,
      env: {},
    };
  }
  const envToken = (kind.env[ENV_TOKEN] ?? "") !== "";
  const own = ownSettings(addMcp, request, read.entry ?? {}, kind);
  if (own.length > 0 && !request.replaceEntries) {
    return skip(
      path,
      `the "${SERVER_NAME}" entry has its own ${own.join(", ")} and stays unchanged`,
      { custom: true, ...(envToken ? { envToken } : {}) },
    );
  }
  const env = { ...kind.env };
  if (request.removeEnvToken) delete env[ENV_TOKEN];
  const removing = envToken && request.removeEnvToken;
  if (own.length === 0 && kind.env.SEVDESK_MODE === request.mode && !removing) {
    return result(
      { action: "unchanged", path, kind: "ours", ...(envToken ? { envToken } : {}) },
      env,
    );
  }
  const commentsLost = await predictCommentLoss(addMcp, request, path, original, env);
  return result(
    {
      action: own.length > 0 ? "replace" : "update",
      path,
      kind: own.length > 0 ? "custom" : "ours",
      ...(own.length > 0 ? { dropped: own } : {}),
      ...(envToken ? { envToken } : {}),
      ...(commentsLost ? { commentsLost } : {}),
    },
    env,
  );
}

function countComments(text: string, format: string): number {
  return format === "json" ? countJsoncComments(text) : countHashComments(text);
}

/**
 * Whether writing drops comments: add-mcp rewrites TOML and YAML without them, and in JSON the
 * whole servers block. A dry run on a copy in a temporary directory tells for sure.
 */
async function predictCommentLoss(
  addMcp: AddMcp,
  request: EntryRequest,
  path: string,
  original: string | null,
  env: Record<string, string>,
): Promise<boolean> {
  if (original === null) return false;
  const format = addMcp.agents[request.agent].format;
  const before = countComments(original, format);
  if (before === 0) return false;
  const dir = await mkdtemp(join(tmpdir(), "sevdesk-mcp-dry-"));
  try {
    const copy = join(dir, basename(path));
    await writeFile(copy, original, { mode: 0o600 });
    const result = await withConfigAt(addMcp, request.agent, copy, () =>
      addMcp.upsertServer(request.agent, SERVER_NAME, serverConfig(request, env), {
        local: request.scope === "project",
        cwd: request.cwd,
      }),
    );
    if (!result.success) return false;
    return countComments(await readFile(copy, "utf8"), format) < before;
  } catch {
    return false;
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

const CORE_KEYS = new Set(["command", "args", "env", "cmd", "envs", "environment"]);

/**
 * Names (never values) of what an existing entry has beyond what the setup writes: another
 * command or args, settings add-mcp would drop or reset (disabled, autoApprove, timeout, ...),
 * env values that are not strings. Writing would lose them, so such an entry is only replaced
 * on request. Its string env is kept either way.
 */
function ownSettings(
  addMcp: AddMcp,
  request: EntryRequest,
  entry: Record<string, unknown>,
  kind: EntryKind,
): string[] {
  const own: string[] = [];
  if (kind.kind === "custom") own.push("command");
  const config = addMcp.agents[request.agent];
  const local = request.scope === "project";
  const configKey = local && config.localConfigKey ? config.localConfigKey : config.configKey;
  const env = kind.kind === "ours" || kind.kind === "custom" ? kind.env : {};
  const emitted = config.transformConfig(SERVER_NAME, serverConfig(request, env), {
    local,
    configKey,
  }) as Record<string, unknown>;
  for (const [key, value] of Object.entries(entry)) {
    if (CORE_KEYS.has(key)) continue;
    // `claude mcp add` and `code --add-mcp` write type "stdio"; it only restates the default.
    if ((key === "type" || key === "transport") && (value === "stdio" || value === "local"))
      continue;
    if (!(key in emitted) || !isDeepStrictEqual(value, emitted[key])) own.push(key);
  }
  const rawEnv = entry.env ?? entry.envs ?? entry.environment;
  if (rawEnv !== undefined && (!rawEnv || typeof rawEnv !== "object" || Array.isArray(rawEnv))) {
    own.push("env");
  } else if (rawEnv) {
    for (const [key, value] of Object.entries(rawEnv)) {
      if (typeof value !== "string") own.push(`env.${key}`);
    }
  }
  return own;
}

/** Finds what the setup would do for one agent; reads only. */
export async function planEntry(addMcp: AddMcp, request: EntryRequest): Promise<EntryPlan> {
  return (await inspect(addMcp, request)).plan;
}

function timestamp(now: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
}

/**
 * A private copy of the original, next to it or in `dir` (named after the file plus a hash of
 * its path, so files of different projects do not collide); an existing name is never
 * overwritten.
 */
async function backup(path: string, content: string, now: Date, dir?: string): Promise<string> {
  let base = `${path}.backup-${timestamp(now)}`;
  if (dir) {
    await mkdir(dir, { recursive: true, mode: 0o700 });
    const hash = createHash("sha256").update(path).digest("hex").slice(0, 8);
    base = join(dir, `${basename(path)}.${hash}.backup-${timestamp(now)}`);
  }
  for (let n = 0; ; n++) {
    const name = n === 0 ? base : `${base}-${n}`;
    try {
      await writeFile(name, content, { flag: "wx", mode: 0o600 });
      return name;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST" || n > 50) throw error;
    }
  }
}

export interface WriteOptions {
  now?: () => Date;
  /** Called after staging, before the final check; tests change the file here. */
  beforeCommit?: (path: string) => Promise<void> | void;
  /** Called after the backup is written, before the last read; tests change the file here. */
  afterBackup?: (path: string) => Promise<void> | void;
  /** Replaced in tests to make the final rename fail. */
  rename?: (from: string, to: string) => Promise<void>;
}

/**
 * Writes the entry for one agent without ever leaving a half-written file:
 * 1. inspect the file (skip remote, custom without replaceEntries, unreadable),
 * 2. copy it next to itself and let add-mcp write the copy (env of an existing entry kept,
 *    SEVDESK_MODE set),
 * 3. read the copy back and check the entry and that no other entry disappeared,
 * 4. check the original did not change meanwhile (a running client may rewrite it); if it did,
 *    start over once,
 * 5. back up the original (mode 600) and rename the copy over it, after reading the original
 *    once more.
 */
export async function writeEntry(
  addMcp: AddMcp,
  request: EntryRequest,
  options: WriteOptions = {},
): Promise<EntryOutcome> {
  const now = options.now ?? (() => new Date());
  for (let attempt = 0; attempt < 2; attempt++) {
    const outcome = await writeOnce(addMcp, request, now, options);
    if (outcome !== "changed") return outcome;
  }
  const path = configPath(addMcp, request.agent, request.scope, request.cwd);
  return {
    status: "error",
    path,
    reason:
      "the file kept changing while it was written (is the client running?); run the setup again",
  };
}

async function writeOnce(
  addMcp: AddMcp,
  request: EntryRequest,
  now: () => Date,
  options: WriteOptions,
): Promise<EntryOutcome | "changed"> {
  const { plan, original, env } = await inspect(addMcp, request);
  if (plan.action === "skip") {
    return {
      status: "skipped",
      path: plan.path,
      reason: plan.reason,
      ...(plan.snippet ? { snippet: plan.snippet } : {}),
    };
  }
  if (plan.action === "unchanged") return { status: "unchanged", path: plan.path };
  const path = plan.path;
  const fail = (reason: string): EntryOutcome => ({
    status: "error",
    path,
    reason,
    snippet: snippet(addMcp, request),
  });
  const dir = dirname(path);
  const stage = join(dir, `.${basename(path)}.sevdesk-mcp-${randomBytes(6).toString("hex")}`);
  let staged = false;
  try {
    await mkdir(dir, { recursive: true });
    const mode = original === null ? 0o600 : (await stat(path)).mode & 0o777;
    if (original !== null) {
      await writeFile(stage, original, { flag: "wx", mode });
      staged = true;
    }
    const before = await readServers(addMcp, request.agent, stage, request.scope, request.cwd);
    const result = await withConfigAt(addMcp, request.agent, stage, () =>
      addMcp.upsertServer(request.agent, SERVER_NAME, serverConfig(request, env), {
        local: request.scope === "project",
        cwd: request.cwd,
      }),
    );
    staged = true;
    // add-mcp's error text may quote the file; it is not shown.
    if (!result.success) return fail("writing failed; the original is unchanged");
    const after = await readServers(addMcp, request.agent, stage, request.scope, request.cwd);
    const kind = classifyEntry(after.entry, request.launch);
    const lost = before.names.filter((name) => !after.names.includes(name));
    if (
      after.error ||
      kind.kind !== "ours" ||
      kind.env.SEVDESK_MODE !== request.mode ||
      Object.entries(env).some(
        ([key, value]) => key !== "SEVDESK_MODE" && kind.env[key] !== value,
      ) ||
      (request.removeEnvToken && kind.env[ENV_TOKEN] !== undefined) ||
      lost.length > 0
    ) {
      return fail("the written configuration did not check out; the original is unchanged");
    }
    // add-mcp creates a new file with the default mode; a client configuration may later hold
    // secrets of other servers, so a new one is private.
    if (original === null) await chmod(stage, mode);
    await options.beforeCommit?.(path);
    let current: string | null = null;
    try {
      current = await readFile(path, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    if (current !== original) return "changed";
    const saved =
      original === null ? undefined : await backup(path, original, now(), request.backupDir);
    await options.afterBackup?.(path);
    // Once more right before the rename: the backup must hold exactly what is replaced.
    let latest: string | null = null;
    try {
      latest = await readFile(path, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    if (latest !== original) {
      if (saved) await rm(saved, { force: true }).catch(() => {});
      return "changed";
    }
    // rename keeps the staged file's mode (copied from the original) but not the original's
    // owner, ACLs, extended attributes or hard links: the new file replaces the old inode.
    try {
      await (options.rename ?? rename)(stage, path);
      staged = false;
    } catch {
      // The original is untouched; its copy is clutter.
      if (saved) await rm(saved, { force: true }).catch(() => {});
      return fail("replacing the configuration failed; the original is unchanged");
    }
    return { status: "ok", path, action: plan.action, ...(saved ? { backup: saved } : {}) };
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    return fail(`writing failed${code ? ` (${code})` : ""}; the original is unchanged`);
  } finally {
    // Cleanup must not replace the outcome.
    if (staged) await rm(stage, { force: true }).catch(() => {});
  }
}
