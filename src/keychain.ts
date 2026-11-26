import { execFile as nodeExecFile } from "node:child_process";

/** Keychain entry the installer writes and the server reads. */
export const KEYCHAIN_SERVICE = "sevdesk-mcp";
export const KEYCHAIN_ACCOUNT = "api-token";
export const KEYCHAIN_TIMEOUT_MS = 5000;
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
  options: { encoding: "utf8"; timeout: number; maxBuffer: number; windowsHide: boolean },
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
        { encoding: "utf8", timeout, maxBuffer: 64 * 1024, windowsHide: true },
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
  read: () => Promise<KeychainResult> = () => readKeychainToken(),
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
