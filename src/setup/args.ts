import { parseArgs } from "node:util";
import type { Scope } from "./agents.js";
import type { Mode } from "./writer.js";

export interface SetupArgs {
  help: boolean;
  /** Agent names, "detected" or "all"; undefined: ask (or the detected ones without prompts). */
  agents?: string[];
  scope?: Scope;
  mode?: Mode;
  verify: boolean;
  yes: boolean;
  replaceEntries: boolean;
  replaceToken: boolean;
  /** Remove SEVDESK_API_TOKEN from existing entries (it wins over the keychain). */
  removeEnvToken: boolean;
  /** Read the token from stdin instead of asking (non-interactive only). */
  tokenStdin: boolean;
  /** Do not touch the keychain at all. */
  skipToken: boolean;
  /** true / false: install the skill or not; undefined: ask (no prompts: no). */
  skill?: boolean;
}

export class UsageError extends Error {}

export const HELP = `Usage: sevdesk-mcp setup [options]

Sets up sevdesk-mcp for the MCP clients (agents) on this machine: picks the
agents, global or project configuration, the mode, stores the sevdesk API token
in the system keychain and optionally installs the sevdesk skill. With a
terminal it asks; without one it needs --yes and runs on the options alone.

Options:
  --agents=LIST       comma-separated agent names, "detected" or "all"
                      (default: ask; without prompts: detected)
  --scope=SCOPE       global (default) or project (this directory; only agents
                      with a project configuration)
  --mode=MODE         read (default), write or full
  --replace-entries   also replace a "sevdesk" entry with its own command;
                      its env is kept either way
  --replace-token     ask for a new token even if one is in the keychain
  --remove-env-token  remove SEVDESK_API_TOKEN from the env of existing entries;
                      it wins over the keychain token (default: ask; without
                      prompts: keep it and warn)
  --token-stdin       read the token from stdin (without prompts)
  --skip-token        leave the keychain alone
  --no-verify         store the token without checking it with sevdesk
  --skill, --no-skill install the sevdesk skill for agents that read skills
                      (default: ask; without prompts: no)
  -y, --yes           no prompts: run with the options and defaults
  -h, --help          show this help

The token never goes into a client configuration or a project file; the
server reads it from the keychain. Existing configuration files are backed up
(mode 600) before they change, remote "sevdesk" entries are left alone, and
other env variables of an existing entry are kept. Without a terminal, prompts
are never shown: pass --yes.
`;

export function parseSetupArgs(argv: readonly string[]): SetupArgs {
  let parsed: ReturnType<typeof parse>;
  try {
    parsed = parse(argv);
  } catch (error) {
    throw new UsageError(error instanceof Error ? error.message : String(error));
  }
  const { values, positionals } = parsed;
  if (positionals.length > 0) throw new UsageError(`unexpected argument ${positionals[0]}`);
  const scope = values.scope;
  if (scope !== undefined && scope !== "global" && scope !== "project") {
    throw new UsageError(`unknown scope "${scope}"; use global or project`);
  }
  const mode = values.mode;
  if (mode !== undefined && mode !== "read" && mode !== "write" && mode !== "full") {
    throw new UsageError(`unknown mode "${mode}"; use read, write or full`);
  }
  if (values.skill && values["no-skill"])
    throw new UsageError("--skill and --no-skill exclude each other");
  if (values["token-stdin"] && values["skip-token"]) {
    throw new UsageError("--token-stdin and --skip-token exclude each other");
  }
  const agents = values.agents
    ?.split(",")
    .map((name) => name.trim())
    .filter((name) => name !== "");
  if (agents !== undefined && agents.length === 0)
    throw new UsageError("--agents needs at least one name");
  return {
    help: values.help ?? false,
    ...(agents ? { agents } : {}),
    ...(scope ? { scope } : {}),
    ...(mode ? { mode } : {}),
    verify: !values["no-verify"],
    yes: values.yes ?? false,
    replaceEntries: values["replace-entries"] ?? false,
    replaceToken: values["replace-token"] ?? false,
    removeEnvToken: values["remove-env-token"] ?? false,
    tokenStdin: values["token-stdin"] ?? false,
    skipToken: values["skip-token"] ?? false,
    ...(values.skill ? { skill: true } : values["no-skill"] ? { skill: false } : {}),
  };
}

function parse(argv: readonly string[]) {
  return parseArgs({
    args: [...argv],
    strict: true,
    allowPositionals: true,
    options: {
      help: { type: "boolean", short: "h" },
      agents: { type: "string" },
      scope: { type: "string" },
      mode: { type: "string" },
      "no-verify": { type: "boolean" },
      yes: { type: "boolean", short: "y" },
      "replace-entries": { type: "boolean" },
      "replace-token": { type: "boolean" },
      "remove-env-token": { type: "boolean" },
      "token-stdin": { type: "boolean" },
      "skip-token": { type: "boolean" },
      skill: { type: "boolean" },
      "no-skill": { type: "boolean" },
    },
  });
}
