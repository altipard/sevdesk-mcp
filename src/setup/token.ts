import { TOKEN_PATTERN } from "../keychain.js";

/** A read-only endpoint every token may call; it changes nothing in the account. */
export const TOKEN_CHECK_URL = "https://my.sevdesk.de/api/v1/Tools/bookkeepingSystemVersion";
export const TOKEN_CHECK_TIMEOUT_MS = 15_000;

/** Leading and trailing blanks (a pasted line) do not count. */
export function normalizeToken(input: string): string {
  return input.trim();
}

export function isTokenFormat(token: string): boolean {
  return TOKEN_PATTERN.test(token);
}

/** Why an input is not a token, or undefined; never repeats the input. */
export function tokenFormatProblem(input: string): string | undefined {
  const token = normalizeToken(input);
  if (isTokenFormat(token)) return undefined;
  return `expected 32 hex characters, got ${token.length} character${token.length === 1 ? "" : "s"}${
    /[^0-9A-Fa-f]/.test(token) ? " including other than hex" : ""
  }`;
}

/**
 * accepted: 2xx. rejected: 401. unchecked: anything else (no connection, timeout, another
 * status); detail is fixed text and never contains the token.
 */
export type TokenCheck =
  | { status: "accepted" }
  | { status: "rejected" }
  | { status: "unchecked"; detail: string };

export interface TokenCheckOptions {
  fetch?: typeof fetch;
  timeoutMs?: number;
  url?: string;
}

/** Asks sevdesk whether it accepts the token. The token travels only in the header. */
export async function checkToken(
  token: string,
  options: TokenCheckOptions = {},
): Promise<TokenCheck> {
  const doFetch = options.fetch ?? fetch;
  try {
    const response = await doFetch(options.url ?? TOKEN_CHECK_URL, {
      method: "GET",
      headers: { Authorization: token, Accept: "application/json" },
      redirect: "error",
      signal: AbortSignal.timeout(options.timeoutMs ?? TOKEN_CHECK_TIMEOUT_MS),
    });
    // The body is not needed; release the connection.
    await response.body?.cancel().catch(() => {});
    if (response.status >= 200 && response.status < 300) return { status: "accepted" };
    if (response.status === 401) return { status: "rejected" };
    return { status: "unchecked", detail: `HTTP ${response.status}` };
  } catch (error) {
    const name = error instanceof Error ? error.name : "";
    return {
      status: "unchecked",
      detail: name === "TimeoutError" || name === "AbortError" ? "timed out" : "no connection",
    };
  }
}
