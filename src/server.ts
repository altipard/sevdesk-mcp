import { type AuthInfo, McpServer } from "@modelcontextprotocol/server";
import type { Config } from "./config.js";
import { createLogger, type Logger } from "./logger.js";
import { registerTools, validateToolNames } from "./policy/registry.js";
import { createPolicyRuntime, type PolicyRuntime, requestPolicy } from "./policy/runtime.js";
import { createSevdeskClient, type SevdeskClient } from "./sevdesk/client.js";
import { registerGenericTool } from "./tools/generic.js";
import { TOOL_NAMES, TOOLS } from "./tools/index.js";
import { SERVER_NAME, VERSION } from "./version.js";

export interface ServerDeps {
  logger?: Logger;
  sevdesk?: SevdeskClient;
  /**
   * Per-process policy state. Entrypoints must create it once and pass it
   * to every server they build; the fallback (a fresh stdio runtime with a
   * random key) only suits tests and single-connection use.
   */
  runtime?: PolicyRuntime;
  /** Verified token of the HTTP request. Undefined on stdio. */
  authInfo?: AuthInfo;
}

/**
 * Builds the MCP server independent of the transport. Entrypoints only wire
 * a transport to it, so stdio and a later HTTP entrypoint expose the same
 * tools under the same rules.
 */
export function createServer(config: Config, deps: ServerDeps = {}): McpServer {
  validateToolNames(config, TOOL_NAMES);
  const logger =
    deps.logger ?? createLogger({ level: config.logLevel, redact: [config.sevdeskApiToken] });
  const sevdesk =
    deps.sevdesk ??
    createSevdeskClient({ baseUrl: config.baseUrl, token: config.sevdeskApiToken, logger });
  const runtime = deps.runtime ?? createPolicyRuntime(config, { transport: "stdio" });
  const policy = requestPolicy(config, runtime, deps.authInfo);

  const server = new McpServer(
    { name: SERVER_NAME, version: VERSION },
    { capabilities: { tools: {} } },
  );

  const env = { server, policy, deps: { config, sevdesk, logger } };
  registerTools(env, TOOLS);
  registerGenericTool(env);

  return server;
}
