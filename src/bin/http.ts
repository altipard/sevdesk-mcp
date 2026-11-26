#!/usr/bin/env node
import { ConfigError } from "../config.js";
import { SHUTDOWN_TIMEOUT_MS, StartupError, startHttpServer } from "../http/start.js";

// Streamable HTTP entrypoint. Logs are JSON lines on stdout, written
// immediately; the process manager collects them.

const fail = (msg: string, fields: Record<string, unknown> = {}): never => {
  process.stdout.write(
    `${JSON.stringify({ time: new Date().toISOString(), level: "error", msg, ...fields })}\n`,
  );
  process.exit(1);
};

let running: Awaited<ReturnType<typeof startHttpServer>>;
try {
  running = await startHttpServer();
} catch (error) {
  if (error instanceof ConfigError) fail("invalid configuration", { issues: error.issues });
  if (error instanceof StartupError) fail(error.message);
  throw error;
}

const stop = (signal: NodeJS.Signals): void => {
  // Last resort if closing hangs beyond the shutdown timeout.
  setTimeout(() => process.exit(1), SHUTDOWN_TIMEOUT_MS + 5000).unref();
  running.shutdown(signal).then(
    () => process.exit(0),
    (error: unknown) => {
      running.logger.error("shutdown failed", { error });
      process.exit(1);
    },
  );
};

// A second signal does not start a second shutdown; it waits for the first.
process.on("SIGTERM", stop);
process.on("SIGINT", stop);
