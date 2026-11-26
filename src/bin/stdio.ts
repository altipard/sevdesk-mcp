#!/usr/bin/env node
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { type Config, ConfigError, loadConfig } from "../config.js";
import { createLogger } from "../logger.js";
import { createServer } from "../server.js";
import { createSevdeskClient } from "../sevdesk/client.js";
import { VERSION } from "../version.js";

// stdout carries the MCP protocol. Everything else, including startup
// errors, goes to stderr.

let config: Config;
try {
  config = loadConfig(process.env);
} catch (error) {
  if (error instanceof ConfigError) {
    process.stderr.write(`sevdesk-mcp: ${error.message}\n`);
    process.exit(1);
  }
  throw error;
}

const logger = createLogger({ level: config.logLevel, redact: [config.sevdeskApiToken] });
const sevdesk = createSevdeskClient({
  baseUrl: config.baseUrl,
  token: config.sevdeskApiToken,
  logger,
});

const handle = serveStdio(() => createServer(config, { logger, sevdesk }), {
  onerror: (error) => logger.error("stdio transport error", { error }),
});

logger.info("sevdesk-mcp started", { version: VERSION, transport: "stdio", mode: config.mode });

let shuttingDown = false;
const shutdown = (signal: NodeJS.Signals): void => {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info("sevdesk-mcp stopping", { signal });
  handle.close().then(
    () => process.exit(0),
    (error: unknown) => {
      logger.error("shutdown failed", { error });
      process.exit(1);
    },
  );
};

process.once("SIGTERM", shutdown);
process.once("SIGINT", shutdown);
