import { execFile } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  readKeychainToken,
  SECRET_ENV_VARIABLES,
  storeKeychainToken,
  withoutSecrets,
} from "../keychain.js";
import { VERSION } from "../version.js";
import { detectAgents, detectLaunch, loadAddMcp } from "./agents.js";
import { HELP } from "./args.js";
import { clackPrompter } from "./prompter.js";
import { runSetup, type SetupDeps } from "./run.js";

/** Largest token input read from stdin; a token is 32 characters. */
const STDIN_LIMIT = 4096;

async function readStdin(): Promise<string> {
  let text = "";
  for await (const chunk of process.stdin) {
    text += typeof chunk === "string" ? chunk : (chunk as Buffer).toString("utf8");
    if (text.length > STDIN_LIMIT) break;
  }
  return text.slice(0, STDIN_LIMIT);
}

/** True if a process named exactly "claude" runs; false when that cannot be found out. */
function claudeCodeRunning(): Promise<boolean> {
  if (process.platform === "win32") return Promise.resolve(false);
  return new Promise((resolve) => {
    try {
      execFile(
        "pgrep",
        ["-x", "claude"],
        { timeout: 2000, windowsHide: true, env: withoutSecrets(process.env) },
        (error) => resolve(error === null),
      );
    } catch {
      resolve(false);
    }
  });
}

/** Ctrl-C and SIGTERM wait until the task is done; the setup then exits with 130. */
async function holdInterrupts<T>(
  task: () => Promise<T>,
): Promise<{ value: T; interrupted: boolean }> {
  let interrupted = false;
  const hold = () => {
    if (!interrupted) process.stderr.write("\nFinishing the current changes, then stopping.\n");
    interrupted = true;
  };
  process.on("SIGINT", hold);
  process.on("SIGTERM", hold);
  try {
    return { value: await task(), interrupted };
  } finally {
    process.off("SIGINT", hold);
    process.off("SIGTERM", hold);
  }
}

/** `sevdesk-mcp setup [options]`; resolves with the exit code. */
export async function main(argv: readonly string[], moduleUrl: string): Promise<number> {
  // The help needs nothing else; install.sh probes for the setup command with it in an empty
  // environment.
  if (argv.length === 1 && (argv[0] === "--help" || argv[0] === "-h")) {
    process.stdout.write(`${HELP}`);
    return 0;
  }
  // The setup needs none of the server's secrets; no child process (pgrep, the keychain tools,
  // anything add-mcp starts) gets them.
  for (const name of SECRET_ENV_VARIABLES) delete process.env[name];
  const addMcp = await loadAddMcp();
  const home = homedir();
  const deps: SetupDeps = {
    addMcp,
    interactive: Boolean(process.stdin.isTTY && process.stdout.isTTY),
    prompter: clackPrompter,
    out: (line) => process.stdout.write(`${line}\n`),
    err: (line) => process.stderr.write(`${line}\n`),
    keychain: {
      read: () => readKeychainToken(),
      store: (token) => storeKeychainToken(token),
    },
    fetch,
    readStdin,
    detect: () => detectAgents(addMcp, { home }),
    claudeCodeRunning,
    cwd: process.cwd(),
    home,
    stateDir: join(process.env.XDG_STATE_HOME || join(home, ".local", "state"), "sevdesk-mcp"),
    ...(process.env.XDG_CONFIG_HOME ? { xdgConfigHome: process.env.XDG_CONFIG_HOME } : {}),
    ...(process.env.CLAUDE_CONFIG_DIR ? { claudeConfigDir: process.env.CLAUDE_CONFIG_DIR } : {}),
    platform: process.platform,
    launch: detectLaunch(moduleUrl, process.execPath),
    version: VERSION,
    holdInterrupts,
  };
  return runSetup(argv, deps);
}
