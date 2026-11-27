import {
  type ChildProcess,
  execFile as nodeExecFile,
  spawn as nodeSpawn,
} from "node:child_process";

/** Keychain entry the installer writes and the server reads. */
export const KEYCHAIN_SERVICE = "sevdesk-mcp";
export const KEYCHAIN_ACCOUNT = "api-token";
export const KEYCHAIN_TIMEOUT_MS = 5000;
/** Variables holding secrets of this server; no child process gets them. */
export const SECRET_ENV_VARIABLES = ["SEVDESK_API_TOKEN", "SEVDESK_CONFIRM_SECRET"] as const;
const ENTRY = `service ${KEYCHAIN_SERVICE}, account ${KEYCHAIN_ACCOUNT}`;

export interface ExecFileError extends Error {
  code?: string | number | null;
  killed?: boolean;
  signal?: NodeJS.Signals | null;
}

/** The subset of child_process.execFile used here; replaced in tests. */
export type ExecFileFn = (
  file: string,
  args: readonly string[],
  options: {
    encoding: "utf8";
    timeout: number;
    maxBuffer: number;
    windowsHide: boolean;
    env: Record<string, string | undefined>;
  },
  callback: (error: ExecFileError | null, stdout: string, stderr: string) => void,
) => unknown;

/**
 * found: the token. missing: the tool found nothing; detail says what that
 * can mean on this system. unavailable: no keychain tool on this system.
 * failed: the lookup broke. detail and reason are fixed text and never
 * contain output of the tool, which could hold the secret.
 */
export type KeychainResult =
  | { status: "found"; token: string }
  | { status: "missing"; detail: string }
  | { status: "unavailable" }
  | { status: "failed"; reason: string };

export interface KeychainOptions {
  platform?: NodeJS.Platform;
  execFile?: ExecFileFn;
  timeoutMs?: number;
  /** Environment the lookup tool starts from; the secrets are removed. */
  env?: Record<string, string | undefined>;
}

/**
 * A copy of `env` without the server's secrets. The rest stays: PATH finds
 * secret-tool, and the Secret Service needs the D-Bus session variables.
 */
function childEnv(env: Record<string, string | undefined>): Record<string, string | undefined> {
  const copy = { ...env };
  for (const name of SECRET_ENV_VARIABLES) delete copy[name];
  return copy;
}

interface Lookup {
  file: string;
  args: readonly string[];
  /** Exit codes that mean "nothing found". */
  missingCodes: readonly number[];
  /** What "nothing found" means for this tool. */
  missingDetail: string;
}

function lookupFor(platform: NodeJS.Platform): Lookup | undefined {
  switch (platform) {
    case "darwin":
      // Absolute path: a PATH entry must not be able to stand in for it.
      // Exit 44 is errSecItemNotFound.
      return {
        file: "/usr/bin/security",
        args: ["find-generic-password", "-s", KEYCHAIN_SERVICE, "-a", KEYCHAIN_ACCOUNT, "-w"],
        missingCodes: [44],
        missingDetail: "no entry",
      };
    case "linux":
      // libsecret's CLI lives in different places per distribution. It exits
      // 1 both when nothing matches and when no Secret Service answers (no
      // D-Bus session, locked or missing keyring), so 1 cannot tell them apart.
      return {
        file: "secret-tool",
        args: ["lookup", "service", KEYCHAIN_SERVICE, "account", KEYCHAIN_ACCOUNT],
        missingCodes: [1],
        missingDetail: "no entry, or the Secret Service is not reachable",
      };
    default:
      return undefined;
  }
}

/** Reads the API token from the macOS keychain or the Secret Service on Linux. */
export function readKeychainToken(options: KeychainOptions = {}): Promise<KeychainResult> {
  const lookup = lookupFor(options.platform ?? process.platform);
  if (lookup === undefined) return Promise.resolve({ status: "unavailable" });
  const execFile = options.execFile ?? (nodeExecFile as unknown as ExecFileFn);
  const timeout = options.timeoutMs ?? KEYCHAIN_TIMEOUT_MS;

  return new Promise((resolve) => {
    try {
      execFile(
        lookup.file,
        lookup.args,
        {
          encoding: "utf8",
          timeout,
          maxBuffer: 64 * 1024,
          windowsHide: true,
          env: childEnv(options.env ?? process.env),
        },
        (error, stdout) => {
          if (error) {
            if (error.code === "ENOENT") resolve({ status: "unavailable" });
            // Node kills the child for both; check the buffer case first.
            else if (error.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER") {
              resolve({ status: "failed", reason: "returned more output than a token" });
            } else if (error.killed || error.signal) {
              resolve({ status: "failed", reason: "timed out" });
            } else if (typeof error.code === "number" && lookup.missingCodes.includes(error.code)) {
              resolve({ status: "missing", detail: lookup.missingDetail });
            } else resolve({ status: "failed", reason: "lookup failed" });
            return;
          }
          // Both tools end the secret with one newline; anything else is kept
          // and left to the token check in the config.
          const token = String(stdout).replace(/\r?\n$/, "");
          resolve(
            token === ""
              ? { status: "missing", detail: "empty entry" }
              : { status: "found", token },
          );
        },
      );
    } catch {
      resolve({ status: "failed", reason: "lookup failed" });
    }
  });
}

export interface TokenResolution {
  env: Record<string, string | undefined>;
  /** Where the token came from; undefined if there is none. */
  source?: "env" | "keychain";
  /**
   * Fixed text on what the keychain lookup found when there is no token. The
   * entrypoint prints it only next to a token error.
   */
  keychainNote?: string;
}

/**
 * SEVDESK_API_TOKEN wins. Only when it is unset or blank is the keychain
 * asked, and the token found there goes through the same config validation.
 */
export async function resolveApiToken(
  env: Record<string, string | undefined>,
  read: () => Promise<KeychainResult> = () => readKeychainToken({ env }),
): Promise<TokenResolution> {
  if ((env.SEVDESK_API_TOKEN ?? "").trim() !== "") return { env, source: "env" };
  const result = await read();
  switch (result.status) {
    case "found":
      return { env: { ...env, SEVDESK_API_TOKEN: result.token }, source: "keychain" };
    case "missing":
      return { env, keychainNote: `no token in the keychain (${ENTRY}): ${result.detail}` };
    case "failed":
      return { env, keychainNote: `keychain lookup ${result.reason} (${ENTRY})` };
    default:
      return { env };
  }
}

/**
 * Runs a tool with `input` on stdin, output discarded. Resolves with its exit code, "missing"
 * when the tool is not installed, or null when it could not run or was killed.
 */
export type StdinRunner = (
  file: string,
  args: readonly string[],
  input: string,
  options: { timeout: number; env: Record<string, string | undefined> },
) => Promise<number | "missing" | null>;

const runWithStdin: StdinRunner = (file, args, input, options) =>
  new Promise((resolve) => {
    let child: ChildProcess;
    try {
      // stdout and stderr are dropped: `security -i` repeats a failed command line, token included.
      child = nodeSpawn(file, args, {
        stdio: ["pipe", "ignore", "ignore"],
        timeout: options.timeout,
        windowsHide: true,
        env: options.env,
      });
    } catch {
      resolve(null);
      return;
    }
    child.on("error", (error: NodeJS.ErrnoException) =>
      resolve(error.code === "ENOENT" ? "missing" : null),
    );
    child.on("close", (code) => resolve(code));
    child.stdin?.on("error", () => {});
    child.stdin?.end(input);
  });

export interface StoreOptions extends KeychainOptions {
  run?: StdinRunner;
}

/**
 * stored: written and read back unchanged. unavailable: no keychain tool. failed: fixed text,
 * never output of the tool.
 */
export type StoreResult =
  | { status: "stored" }
  | { status: "unavailable" }
  | { status: "failed"; reason: string };

/** sevdesk API tokens are 32 hex characters. */
export const TOKEN_PATTERN = /^[0-9A-Fa-f]{32}$/;

/**
 * Stores the API token where readKeychainToken finds it. The value reaches the tool on stdin
 * only, never in an argument list: `security -i` reads the whole command from stdin,
 * secret-tool reads the secret from stdin. Only a 32-hex token is accepted, which also keeps
 * anything else out of the `security -i` command line. The result is read back to confirm.
 */
export async function storeKeychainToken(
  token: string,
  options: StoreOptions = {},
): Promise<StoreResult> {
  if (!TOKEN_PATTERN.test(token)) return { status: "failed", reason: "not a sevdesk API token" };
  const platform = options.platform ?? process.platform;
  const run = options.run ?? runWithStdin;
  const env = childEnv(options.env ?? process.env);
  const timeout = options.timeoutMs ?? KEYCHAIN_TIMEOUT_MS;
  let code: number | "missing" | null;
  switch (platform) {
    case "darwin":
      code = await run(
        "/usr/bin/security",
        ["-i"],
        `add-generic-password -U -s ${KEYCHAIN_SERVICE} -a ${KEYCHAIN_ACCOUNT} -l ${KEYCHAIN_SERVICE} -w ${token}\n`,
        { timeout, env },
      );
      break;
    case "linux":
      code = await run(
        "secret-tool",
        [
          "store",
          `--label=${KEYCHAIN_SERVICE}`,
          "service",
          KEYCHAIN_SERVICE,
          "account",
          KEYCHAIN_ACCOUNT,
        ],
        token,
        { timeout, env },
      );
      break;
    default:
      return { status: "unavailable" };
  }
  if (code === "missing") return { status: "unavailable" };
  if (code === null) return { status: "failed", reason: "the keychain tool did not run" };
  if (code !== 0) return { status: "failed", reason: "the keychain tool failed" };
  // `security -i` exits 0 even when its command failed: only a read-back proves the write.
  const check = await readKeychainToken(options);
  if (check.status === "found" && check.token === token) return { status: "stored" };
  return { status: "failed", reason: "the stored token could not be read back" };
}
