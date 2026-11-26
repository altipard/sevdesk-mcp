#!/usr/bin/env node
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { type Config, ConfigError, loadConfig } from "../config.js";
import { resolveApiToken, SECRET_ENV_VARIABLES } from "../keychain.js";
import { createLogger } from "../logger.js";
import { validateToolNames } from "../policy/registry.js";
import { createPolicyRuntime } from "../policy/runtime.js";
import { createServer } from "../server.js";
import { createSevdeskClient } from "../sevdesk/client.js";
import { TOOL_NAMES } from "../tools/index.js";
import { VERSION } from "../version.js";

// stdout carries the MCP protocol. Everything else, including startup
// errors, goes to stderr.

/**
 * Drops the secrets from the environment once the config holds them, so
 * code running later in this process (a dependency, a tool) cannot read
 * them from process.env, and child processes do not inherit them.
 *
 * This does not protect against local readers of the environment the
 * process was started with: the parent (the MCP client and its config
 * file), /proc/<pid>/environ on Linux or `ps eww` on macOS still show the
 * original values. Against those, the keychain is the better place.
 */
function forgetSecrets(...envs: Array<Record<string, string | undefined>>): void {
  for (const env of envs) for (const name of SECRET_ENV_VARIABLES) delete env[name];
}

// Without SEVDESK_API_TOKEN the token comes from the system keychain, so it
// does not have to sit in a client configuration file.
const token = await resolveApiToken(process.env);

let config: Config;
try {
  config = loadConfig(token.env);
  // token.env is process.env itself, or a copy holding the keychain token.
  forgetSecrets(process.env, token.env);
  validateToolNames(config, TOOL_NAMES);
} catch (error) {
  if (error instanceof ConfigError) {
    process.stderr.write(`sevdesk-mcp: ${error.message}\n`);
    // Keychain details only help when the token is the problem.
    if (error.issues.some((issue) => issue.startsWith("SEVDESK_API_TOKEN:"))) {
      if (token.source === "keychain") {
        process.stderr.write("sevdesk-mcp: the token was read from the keychain\n");
      } else if (token.keychainNote) {
        process.stderr.write(`sevdesk-mcp: ${token.keychainNote}\n`);
      }
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
