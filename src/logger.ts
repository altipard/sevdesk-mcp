import { createRedactor } from "./redact.js";

export const LOG_LEVELS = ["debug", "info", "warn", "error"] as const;
export type LogLevel = (typeof LOG_LEVELS)[number];

export type LogFields = Record<string, unknown>;

export interface Logger {
  debug(msg: string, fields?: LogFields): void;
  info(msg: string, fields?: LogFields): void;
  warn(msg: string, fields?: LogFields): void;
  error(msg: string, fields?: LogFields): void;
}

export interface LoggerOptions {
  level: LogLevel;
  /** Values that must never appear in output, e.g. the API token. */
  redact?: readonly string[];
  /** Line sink. Defaults to stderr: on the stdio transport stdout carries the protocol. */
  write?: (line: string) => void;
}

const writeStderr = (line: string): void => {
  process.stderr.write(line);
};

function serializeError(error: Error): LogFields {
  return { name: error.name, message: error.message, stack: error.stack };
}

function replacer(_key: string, value: unknown): unknown {
  return value instanceof Error ? serializeError(value) : value;
}

/**
 * Structured JSON-lines logger. Each call writes one line immediately, there
 * is no buffering in the process. Secrets are redacted from the final line,
 * so they cannot slip through nested fields or error stacks.
 */
export function createLogger(options: LoggerOptions): Logger {
  const threshold = LOG_LEVELS.indexOf(options.level);
  const redact = createRedactor(options.redact ?? []);
  const write = options.write ?? writeStderr;

  const log = (level: LogLevel, msg: string, fields?: LogFields): void => {
    if (LOG_LEVELS.indexOf(level) < threshold) return;
    // time, level and msg lead every line. Fields with those names are
    // dropped, so they can neither hide the real values nor duplicate keys.
    const { time: _time, level: _level, msg: _msg, ...rest } = fields ?? {};
    const entry = { time: new Date().toISOString(), level, msg, ...rest };
    let line: string;
    try {
      line = JSON.stringify(entry, replacer);
    } catch {
      line = JSON.stringify({ time: entry.time, level, msg, logError: "unserializable fields" });
    }
    write(`${redact(line)}\n`);
  };

  return {
    debug: (msg, fields) => log("debug", msg, fields),
    info: (msg, fields) => log("info", msg, fields),
    warn: (msg, fields) => log("warn", msg, fields),
    error: (msg, fields) => log("error", msg, fields),
  };
}

export const silentLogger: Logger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
};
