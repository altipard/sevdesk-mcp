import { inspect } from "node:util";
import type { Config } from "../src/config.js";
import { createLogger, type Logger } from "../src/logger.js";

// Synthetic token in the documented format (32 hex characters).
export const TEST_TOKEN = "0123456789abcdef0123456789abcdef";
export const MOCK_BASE_URL = "https://sevdesk.mock/api/v1";

export function testConfig(overrides: Partial<Config> = {}): Config {
  return {
    sevdeskApiToken: TEST_TOKEN,
    mode: "read",
    baseUrl: MOCK_BASE_URL,
    logLevel: "debug",
    deniedTools: [],
    enableTools: [],
    confirmTtlSeconds: 300,
    ...overrides,
  };
}

/** Logger that records lines instead of writing to stderr. */
export function captureLogger(redact: readonly string[] = [TEST_TOKEN]): {
  logger: Logger;
  lines: string[];
} {
  const lines: string[] = [];
  const logger = createLogger({ level: "debug", redact, write: (line) => lines.push(line) });
  return { logger, lines };
}

/** Every representation of an error that could end up in a log or a trace. */
export function errorRepresentations(error: unknown): string {
  const err = error as Error;
  return [
    String(err),
    err.message,
    err.stack ?? "",
    JSON.stringify(err),
    inspect(err, { depth: null, showHidden: true }),
  ].join("\n");
}
