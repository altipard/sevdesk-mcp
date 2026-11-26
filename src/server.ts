import { McpServer } from "@modelcontextprotocol/server";
import type { Config } from "./config.js";
import { createLogger, type Logger } from "./logger.js";
import { createSevdeskClient, type SevdeskClient } from "./sevdesk/client.js";
import { registerAccountTools } from "./tools/account.js";
import { SERVER_NAME, VERSION } from "./version.js";

export interface ServerDeps {
  logger?: Logger;
  sevdesk?: SevdeskClient;
}

/**
 * Builds the MCP server independent of the transport. Entrypoints only wire
 * a transport to it, so stdio and a later HTTP entrypoint expose the same
 * tools under the same rules.
 */
export function createServer(config: Config, deps: ServerDeps = {}): McpServer {
  const logger =
    deps.logger ?? createLogger({ level: config.logLevel, redact: [config.sevdeskApiToken] });
  const sevdesk =
    deps.sevdesk ??
    createSevdeskClient({ baseUrl: config.baseUrl, token: config.sevdeskApiToken, logger });

  const server = new McpServer(
    { name: SERVER_NAME, version: VERSION },
    { capabilities: { tools: {} } },
  );

  registerAccountTools(server, { config, sevdesk, logger });

  return server;
}
