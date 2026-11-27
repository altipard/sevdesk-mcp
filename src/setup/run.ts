import type { AgentType } from "add-mcp";
import {
  KEYCHAIN_ACCOUNT,
  KEYCHAIN_SERVICE,
  type KeychainResult,
  type StoreResult,
} from "../keychain.js";
import {
  type AddMcp,
  agentTypes,
  type Launch,
  type Scope,
  SERVER_NAME,
  supportsProject,
} from "./agents.js";
import { HELP, parseSetupArgs, type SetupArgs, UsageError } from "./args.js";
import { type Answer, CANCELLED, type Prompter } from "./prompter.js";
import { installSkill, type SkillOutcome, skillLocations, supportsSkill } from "./skill.js";
import { checkToken, isTokenFormat, normalizeToken, tokenFormatProblem } from "./token.js";
import {
  type EntryOutcome,
  type EntryPlan,
  type EntryRequest,
  type Mode,
  planEntry,
  writeEntry,
} from "./writer.js";

export interface SetupDeps {
  addMcp: AddMcp;
  /** Prompts can be shown: stdin and stdout are terminals. */
  interactive: boolean;
  /** Loaded only when prompts are shown. */
  prompter: () => Promise<Prompter>;
  out: (line: string) => void;
  err: (line: string) => void;
  keychain: { read(): Promise<KeychainResult>; store(token: string): Promise<StoreResult> };
  fetch: typeof fetch;
  readStdin: () => Promise<string>;
  detect: () => Promise<AgentType[]>;
  claudeCodeRunning: () => Promise<boolean>;
  cwd: string;
  home: string;
  xdgConfigHome?: string;
  /** CLAUDE_CONFIG_DIR: where Claude Code keeps its settings and skills instead of ~/.claude. */
  claudeConfigDir?: string;
  platform: NodeJS.Platform;
  launch: Launch;
  version: string;
  now?: () => Date;
  /** Runs `task` with Ctrl-C held back; reports whether one arrived meanwhile. */
  holdInterrupts: <T>(task: () => Promise<T>) => Promise<{ value: T; interrupted: boolean }>;
}

/** Exit codes: 0 done, 1 something failed, 2 usage, 130 cancelled. */
export const EXIT = { ok: 0, failed: 1, usage: 2, cancelled: 130 } as const;

class Cancelled extends Error {}

/** Ends the setup before anything changed, with this exit code. */
class Abort extends Error {
  constructor(readonly code: number) {
    super("abort");
  }
}

function answer<T>(value: Answer<T>): T {
  if (value === CANCELLED) throw new Cancelled();
  return value;
}

type TokenPlan =
  | { action: "keep" }
  | { action: "store"; token: string; checked: string }
  | { action: "none"; reason: string };

const MODE_TEXT: Record<Mode, string> = {
  read: "read: reading tools only",
  write: "write: also creates drafts, contacts, vouchers and payments",
  full: "full: write tools plus the irreversible ones listed in SEVDESK_ENABLE_TOOLS",
};

export async function runSetup(argv: readonly string[], deps: SetupDeps): Promise<number> {
  let args: SetupArgs;
  try {
    args = parseSetupArgs(argv);
    if (args.tokenStdin && !args.yes) throw new UsageError("--token-stdin needs --yes");
  } catch (error) {
    if (!(error instanceof UsageError)) throw error;
    deps.err(`sevdesk-mcp setup: ${error.message} (see --help)`);
    return EXIT.usage;
  }
  if (args.help) {
    deps.out(HELP);
    return EXIT.ok;
  }
  if (!args.yes && !deps.interactive) {
    deps.err(
      "sevdesk-mcp setup: no terminal for the prompts. Run it in a terminal, or pass --yes with the " +
        "options to use (--agents, --scope, --mode, --token-stdin; see --help).",
    );
    return EXIT.usage;
  }
  const ui = args.yes ? undefined : await deps.prompter();
  try {
    return await flow(args, deps, ui);
  } catch (error) {
    if (error instanceof Cancelled) {
      ui?.cancel("Setup cancelled; nothing was changed.");
      return EXIT.cancelled;
    }
    if (error instanceof Abort) return error.code;
    if (error instanceof UsageError) {
      deps.err(`sevdesk-mcp setup: ${error.message} (see --help)`);
      return EXIT.usage;
    }
    throw error;
  }
}

/** Plain output without prompts, the same messages as the prompter's. */
function printer(deps: SetupDeps, ui: Prompter | undefined) {
  return {
    info: (message: string) => (ui ? ui.info(message) : deps.out(message)),
    success: (message: string) => (ui ? ui.success(message) : deps.out(message)),
    warn: (message: string) => (ui ? ui.warn(message) : deps.out(`warning: ${message}`)),
    error: (message: string) => (ui ? ui.error(message) : deps.err(`error: ${message}`)),
    note: (lines: string, title: string) =>
      ui ? ui.note(lines, title) : deps.out(`${title}\n${indent(lines)}`),
  };
}

function indent(lines: string): string {
  return lines
    .split("\n")
    .map((line) => `  ${line}`)
    .join("\n");
}

function resolveAgents(names: string[], all: AgentType[], detected: AgentType[]): AgentType[] {
  const out = new Set<AgentType>();
  for (const name of names) {
    if (name === "all" || name === "detected") {
      for (const agent of name === "all" ? all : detected) out.add(agent);
    } else if ((all as string[]).includes(name)) out.add(name as AgentType);
    else throw new UsageError(`unknown agent "${name}"; known: ${all.join(", ")}`);
  }
  return all.filter((agent) => out.has(agent));
}

async function flow(args: SetupArgs, deps: SetupDeps, ui: Prompter | undefined): Promise<number> {
  const say = printer(deps, ui);
  const { addMcp } = deps;
  const name = (agent: AgentType) => addMcp.agents[agent].displayName;
  const names = (list: readonly AgentType[]) => list.map(name).join(", ");
  ui?.intro(`sevdesk-mcp setup ${deps.version}`);

  // Agents
  const all = agentTypes(addMcp);
  const detected = await deps.detect();
  let selected: AgentType[];
  if (args.agents) {
    selected = resolveAgents(args.agents, all, detected);
  } else if (ui) {
    const order = [
      ...detected,
      ...all
        .filter((agent) => !detected.includes(agent))
        .sort((a, b) => name(a).localeCompare(name(b))),
    ];
    selected = answer(
      await ui.multiselect({
        message: "Which agents should use sevdesk? (a selects all)",
        choices: order.map((agent) => ({
          value: agent,
          label: name(agent),
          ...(detected.includes(agent) ? { hint: "detected" } : {}),
        })),
        initial: detected,
        required: true,
      }),
    );
  } else {
    selected = detected;
  }
  if (selected.length === 0) {
    say.error("No agents found on this machine; name them with --agents (see --help).");
    return EXIT.failed;
  }

  // Scope
  const projectAgents = selected.filter((agent) => supportsProject(addMcp, agent));
  let scope: Scope = args.scope ?? "global";
  if (!args.scope && ui && projectAgents.length > 0) {
    scope = answer(
      await ui.select<Scope>({
        message: "Where should the configuration go?",
        choices: [
          { value: "global", label: "Global", hint: "your user, every project" },
          {
            value: "project",
            label: "This project",
            hint: `${deps.cwd}; ${projectAgents.length === selected.length ? "all selected agents" : `only ${names(projectAgents)}`}`,
          },
        ],
        initial: "global",
      }),
    );
  }
  if (scope === "project") {
    say.warn(
      "Project files are often committed: the token never goes into them, it stays in the keychain.",
    );
  }

  // Mode
  let mode: Mode = args.mode ?? "read";
  if (!args.mode && ui) {
    mode = answer(
      await ui.select<Mode>({
        message: "Mode",
        choices: (["read", "write", "full"] as const).map((value) => ({
          value,
          label: value,
          hint: MODE_TEXT[value].slice(value.length + 2),
        })),
        initial: "read",
      }),
    );
  }
  if (mode === "full") {
    say.info(
      "full lists the irreversible tools (send_invoice_email, cancel_invoice, enshrine_document) only " +
        "when they are named in SEVDESK_ENABLE_TOOLS in the entry's env; add that yourself where wanted.",
    );
  }

  // What happens per agent
  let replaceEntries = args.replaceEntries;
  const request = (agent: AgentType): EntryRequest => ({
    agent,
    scope,
    cwd: deps.cwd,
    launch: deps.launch,
    mode,
    replaceEntries,
  });
  const planAll = async () => {
    const out = new Map<AgentType, EntryPlan>();
    for (const agent of selected) out.set(agent, await planEntry(addMcp, request(agent)));
    return out;
  };
  let plans = await planAll();
  const custom = selected.filter((agent) => {
    const plan = plans.get(agent);
    return plan?.action === "skip" && plan.custom === true;
  });
  if (custom.length > 0 && ui && !replaceEntries) {
    replaceEntries = answer(
      await ui.confirm({
        message: `${names(custom)} already ${custom.length === 1 ? "has" : "have"} a "${SERVER_NAME}" entry with its own command or settings. Replace it? (its env is kept)`,
        initial: false,
      }),
    );
    if (replaceEntries) plans = await planAll();
  }

  // Token
  const token = await planToken(args, deps, ui, say);

  // Skill
  const locations = skillLocations(selected.filter(supportsSkill), {
    scope,
    cwd: deps.cwd,
    home: deps.home,
    ...(deps.xdgConfigHome ? { xdgConfigHome: deps.xdgConfigHome } : {}),
    ...(deps.claudeConfigDir ? { claudeConfigDir: deps.claudeConfigDir } : {}),
  });
  if (selected.includes("claude-code")) {
    say.info(
      "Claude Code can also get the skill from the sevdesk plugin: /plugin marketplace add altipard/sevdesk-mcp, " +
        "then /plugin install sevdesk@sevdesk-mcp. The plugin registers the server as well, so leave " +
        "Claude Code out here if you use it.",
    );
  }
  let skill = locations.length > 0 && (args.skill ?? false);
  if (locations.length > 0 && args.skill === undefined && ui) {
    skill = answer(
      await ui.confirm({
        message: `Also install the sevdesk skill (bookkeeping know-how) for ${names(locations.flatMap((l) => l.agents))}?`,
        initial: true,
      }),
    );
  }

  // Summary
  const lines: string[] = [];
  for (const agent of selected) {
    const plan = plans.get(agent);
    if (plan)
      lines.push(`${name(agent)}: ${describePlan(plan)}${plan.path ? `\n  ${plan.path}` : ""}`);
  }
  lines.push(`mode: ${MODE_TEXT[mode]}`);
  lines.push(`token: ${describeToken(token)}`);
  if (skill) for (const location of locations) lines.push(`skill: ${location.dir}`);
  lines.push("Changed files are backed up first (mode 600).");
  say.note(lines.join("\n"), "Setup plan");
  if (ui) {
    const go = answer(await ui.confirm({ message: "Apply this setup?", initial: true }));
    if (!go) {
      ui.outro("Nothing was changed.");
      return EXIT.ok;
    }
  }

  // Apply: Ctrl-C waits until this is done, so no step stops halfway.
  const { value: result, interrupted } = await deps.holdInterrupts(async () => {
    let stored: StoreResult | undefined;
    if (token.action === "store") stored = await deps.keychain.store(token.token);
    const entries = new Map<AgentType, EntryOutcome>();
    for (const agent of selected) {
      const plan = plans.get(agent);
      if (plan?.action === "skip") {
        entries.set(agent, {
          status: "skipped",
          path: plan.path,
          reason: plan.reason,
          ...(plan.snippet ? { snippet: plan.snippet } : {}),
        });
        continue;
      }
      entries.set(
        agent,
        await writeEntry(addMcp, request(agent), deps.now ? { now: deps.now } : {}),
      );
    }
    const skills: SkillOutcome[] = [];
    if (skill) for (const location of locations) skills.push(await installSkill(location.dir));
    return { stored, entries, skills };
  });

  // Report
  let failed = false;
  if (token.action === "store") {
    if (result.stored?.status === "stored") {
      say.success(
        `Token stored in the keychain (service ${KEYCHAIN_SERVICE}, account ${KEYCHAIN_ACCOUNT}).`,
      );
    } else {
      failed = true;
      say.error(
        `Storing the token failed${result.stored?.status === "failed" ? `: ${result.stored.reason}` : ""}; the keychain may be unchanged.`,
      );
    }
  }
  for (const [agent, outcome] of result.entries) {
    switch (outcome.status) {
      case "ok":
        say.success(
          `${name(agent)}: ${outcome.action === "add" ? "added" : "updated"} ${outcome.path}${outcome.backup ? `\n  backup: ${outcome.backup}` : ""}`,
        );
        break;
      case "unchanged":
        say.success(`${name(agent)}: already set up (${outcome.path})`);
        break;
      case "skipped":
        say.warn(
          `${name(agent)}: skipped, ${outcome.reason}${pathLine(outcome.path)}${snippetLines(outcome.snippet)}`,
        );
        break;
      case "error":
        failed = true;
        say.error(
          `${name(agent)}: ${outcome.reason}${pathLine(outcome.path)}${snippetLines(outcome.snippet)}`,
        );
        break;
    }
  }
  for (const outcome of result.skills) {
    if (outcome.status === "ok")
      say.success(`Skill ${outcome.updated ? "updated" : "installed"}: ${outcome.dir}`);
    else if (outcome.status === "skipped")
      say.warn(`Skill skipped, ${outcome.reason}: ${outcome.dir}`);
    else {
      failed = true;
      say.error(`Skill: ${outcome.reason}: ${outcome.dir}`);
    }
  }
  const claudeCode = result.entries.get("claude-code");
  if (scope === "global" && claudeCode?.status === "ok") {
    const running = await deps.claudeCodeRunning();
    say.warn(
      `${running ? "Claude Code is running and" : "A running Claude Code"} rewrites ~/.claude.json itself: ` +
        "restart it now, then check with `claude mcp list`.",
    );
  }
  if (token.action === "none") say.info(storeHint(deps.platform, token.reason));
  const next = "Restart the agents (or reload their MCP servers) to load sevdesk.";
  if (ui) ui.outro(next);
  else deps.out(next);
  if (interrupted) return EXIT.cancelled;
  return failed ? EXIT.failed : EXIT.ok;
}

function pathLine(path: string): string {
  return path ? `\n  ${path}` : "";
}

function snippetLines(snippet: string | undefined): string {
  return snippet ? `\n  Add it by hand:\n${indent(indent(snippet))}` : "";
}

function describePlan(plan: EntryPlan): string {
  switch (plan.action) {
    case "add":
      return "add the entry";
    case "update":
      return "update the entry (command and mode; other env kept)";
    case "replace":
      return `replace the entry (env kept${plan.dropped?.length ? `; drops its ${plan.dropped.join(", ")}` : ""})`;
    case "unchanged":
      return "already set up";
    case "skip":
      return `skip, ${plan.reason}${plan.custom ? " (--replace-entries replaces it)" : ""}`;
  }
}

function describeToken(token: TokenPlan): string {
  switch (token.action) {
    case "keep":
      return "keep the one in the keychain (--replace-token to change it)";
    case "store":
      return `store in the keychain (${token.checked})`;
    case "none":
      return `not stored: ${token.reason}`;
  }
}

function storeHint(platform: NodeJS.Platform, reason: string): string {
  const command =
    platform === "darwin"
      ? `security add-generic-password -U -s ${KEYCHAIN_SERVICE} -a ${KEYCHAIN_ACCOUNT} -w`
      : platform === "linux"
        ? `secret-tool store --label=${KEYCHAIN_SERVICE} service ${KEYCHAIN_SERVICE} account ${KEYCHAIN_ACCOUNT}`
        : undefined;
  return command
    ? `No token stored (${reason}). Run the setup again, or store it with:\n  ${command}`
    : `No token stored (${reason}). Set SEVDESK_API_TOKEN in the env of each entry instead.`;
}

async function planToken(
  args: SetupArgs,
  deps: SetupDeps,
  ui: Prompter | undefined,
  say: ReturnType<typeof printer>,
): Promise<TokenPlan> {
  if (args.skipToken) return { action: "none", reason: "--skip-token" };
  const current = await deps.keychain.read();
  if (current.status === "unavailable") {
    return {
      action: "none",
      reason:
        deps.platform === "linux"
          ? "secret-tool (libsecret) is not installed; install it, e.g. apt install libsecret-tools"
          : "no supported keychain on this system",
    };
  }
  if (current.status === "found" && !args.replaceToken) return { action: "keep" };
  // With --replace-token, a token already stored stays whenever no new one is given.
  const fallback = (reason: string): TokenPlan =>
    current.status === "found" ? { action: "keep" } : { action: "none", reason };

  const verify = async (token: string): Promise<"accepted" | "rejected" | string> => {
    if (!args.verify) return "not checked (--no-verify)";
    const check = ui
      ? answer(
          await ui.spin("Checking the token with sevdesk", () =>
            checkToken(token, { fetch: deps.fetch }),
          ),
        )
      : await checkToken(token, { fetch: deps.fetch });
    if (check.status === "unchecked") {
      say.warn(`Could not check the token with sevdesk (${check.detail}); it is stored anyway.`);
      return `not checked: ${check.detail}`;
    }
    return check.status;
  };

  if (args.tokenStdin) {
    const token = normalizeToken(await deps.readStdin());
    if (!isTokenFormat(token)) {
      throw new UsageError(
        `the token on stdin is not a sevdesk API token: ${tokenFormatProblem(token)}`,
      );
    }
    const checked = await verify(token);
    if (checked === "rejected") {
      say.error("sevdesk rejected the token (HTTP 401); nothing was changed.");
      throw new Abort(EXIT.failed);
    }
    if (checked === "accepted") say.success("sevdesk accepted the token.");
    return {
      action: "store",
      token,
      checked: checked === "accepted" ? "accepted by sevdesk" : checked,
    };
  }
  if (!ui) {
    if (current.status === "found") {
      say.warn("--replace-token needs --token-stdin without prompts; the stored token stays.");
    }
    return fallback("no token given; pass --token-stdin or run the setup in a terminal");
  }
  for (let attempt = 1; attempt <= 3; attempt++) {
    const input = answer(
      await ui.password({
        message: "sevdesk API token (input hidden, Enter skips)",
        validate: (value) => (value.trim() === "" ? undefined : tokenFormatProblem(value)),
      }),
    );
    const token = normalizeToken(input);
    if (token === "") return fallback("no token entered");
    const checked = await verify(token);
    if (checked === "rejected") {
      say.warn("sevdesk rejected this token (HTTP 401). Copy it again from sevdesk.");
      continue;
    }
    if (checked === "accepted") say.success("sevdesk accepted the token.");
    return {
      action: "store",
      token,
      checked: checked === "accepted" ? "accepted by sevdesk" : checked,
    };
  }
  return fallback("sevdesk rejected three tokens");
}
