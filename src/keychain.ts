import { execFile as nodeExecFile } from "node:child_process";

/** Keychain entry the installer writes and the server reads. */
export const KEYCHAIN_SERVICE = "sevdesk-mcp";
export const KEYCHAIN_ACCOUNT = "api-token";
export const KEYCHAIN_TIMEOUT_MS = 5000;

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
 * found: the token. missing: no entry. unavailable: no keychain tool on this
 * system. failed: the lookup broke; reason is fixed text and never contains
 * output of the tool, which could hold the secret.
 */
export type KeychainResult =
  | { status: "found"; token: string }
  | { status: "missing" }
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
  /** Exit codes that mean "no such entry". */
  missingCodes: readonly number[];
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
      };
    case "linux":
      // libsecret's CLI lives in different places per distribution. It exits
      // 1 without output when nothing matches.
      return {
        file: "secret-tool",
        args: ["lookup", "service", KEYCHAIN_SERVICE, "account", KEYCHAIN_ACCOUNT],
        missingCodes: [1],
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
            else if (error.killed || error.signal)
              resolve({ status: "failed", reason: "timed out" });
            else if (typeof error.code === "number" && lookup.missingCodes.includes(error.code)) {
              resolve({ status: "missing" });
            } else resolve({ status: "failed", reason: "lookup failed" });
            return;
          }
          // Both tools end the secret with one newline; anything else is kept
          // and left to the token check in the config.
          const token = String(stdout).replace(/\r?\n$/, "");
          resolve(token === "" ? { status: "missing" } : { status: "found", token });
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
  /** Fixed-text note for stderr, e.g. why the keychain could not be read. */
  notice?: string;
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
    case "failed":
      return { env, notice: `keychain lookup ${result.reason}` };
    default:
      return { env };
  }
}
