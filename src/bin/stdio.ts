#!/usr/bin/env node
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { type Config, ConfigError, loadConfig } from "../config.js";
import { KEYCHAIN_ACCOUNT, KEYCHAIN_SERVICE, resolveApiToken } from "../keychain.js";
import { createLogger } from "../logger.js";
import { validateToolNames } from "../policy/registry.js";
import { createPolicyRuntime } from "../policy/runtime.js";
import { createServer } from "../server.js";
import { createSevdeskClient } from "../sevdesk/client.js";
import { TOOL_NAMES } from "../tools/index.js";
import { VERSION } from "../version.js";

// stdout carries the MCP protocol. Everything else, including startup
// errors, goes to stderr.

// Without SEVDESK_API_TOKEN the token comes from the system keychain, so it
// does not have to sit in a client configuration file.
const token = await resolveApiToken(process.env);
if (token.notice) process.stderr.write(`sevdesk-mcp: ${token.notice}\n`);

let config: Config;
try {
  config = loadConfig(token.env);
  validateToolNames(config, TOOL_NAMES);
} catch (error) {
  if (error instanceof ConfigError) {
    process.stderr.write(`sevdesk-mcp: ${error.message}\n`);
    if (token.source === "keychain") {
      process.stderr.write("sevdesk-mcp: the token was read from the keychain\n");
    } else if (token.source === undefined) {
      process.stderr.write(
        `sevdesk-mcp: no token in the keychain either (service ${KEYCHAIN_SERVICE}, account ${KEYCHAIN_ACCOUNT})\n`,
      );
    }
    process.exit(1);
  }
  throw error;
}

const secrets = [config.sevdeskApiToken, ...(config.confirmSecret ? [config.confirmSecret] : [])];
const logger = createLogger({ level: config.logLevel, redact: secrets });
const sevdesk = createSevdeskClient({
  baseUrl: config.baseUrl,
  token: config.sevdeskApiToken,
  logger,
});
// Once per process: without SEVDESK_CONFIRM_SECRET the HMAC key is random
// and confirmation tokens end with the process; the nonce store is shared
// by every server instance serveStdio builds.
const runtime = createPolicyRuntime(config, { transport: "stdio" });

const handle = serveStdio(() => createServer(config, { logger, sevdesk, runtime }), {
  onerror: (error) => logger.error("stdio transport error", { error }),
});

logger.info("sevdesk-mcp started", {
  version: VERSION,
  transport: "stdio",
  mode: config.mode,
  tokenSource: token.source,
});

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
