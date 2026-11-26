import { type AuthInfo, McpServer } from "@modelcontextprotocol/server";
import type { Config } from "./config.js";
import { createLogger, type Logger } from "./logger.js";
import { registerTools, validateToolNames } from "./policy/registry.js";
import { type PolicyRuntime, requestPolicy } from "./policy/runtime.js";
import { createScopeGate, genericScope } from "./policy/scope.js";
import { createSevdeskClient, restrictClient, type SevdeskClient } from "./sevdesk/client.js";
import { DEFAULT_API_ALLOW, GENERIC_TOOL_NAME, registerGenericTool } from "./tools/generic.js";
import { TOOL_NAMES, TOOLS } from "./tools/index.js";
import { SERVER_NAME, VERSION } from "./version.js";

export interface ServerDeps {
  logger?: Logger;
  sevdesk?: SevdeskClient;
  /**
   * Per-process policy state, required. Entrypoints create it once and pass
   * it to every server they build. There is deliberately no default: a
   * silent stdio runtime under an HTTP entrypoint would mean rights from
   * SEVDESK_MODE alone and replay protection per request.
   */
  runtime: PolicyRuntime;
  /** Verified token of the HTTP request. Undefined on stdio. */
  authInfo?: AuthInfo;
}

/**
 * Builds the MCP server independent of the transport. Entrypoints only wire
 * a transport to it, so stdio and a later HTTP entrypoint expose the same
 * tools under the same rules.
 */
export function createServer(config: Config, deps: ServerDeps): McpServer {
  if (deps?.runtime === undefined) {
    throw new TypeError("createServer needs the per-process policy runtime (deps.runtime)");
  }
  validateToolNames(config, TOOL_NAMES);
  const logger =
    deps.logger ?? createLogger({ level: config.logLevel, redact: [config.sevdeskApiToken] });
  const sevdesk =
    deps.sevdesk ??
    createSevdeskClient({ baseUrl: config.baseUrl, token: config.sevdeskApiToken, logger });
  const policy = requestPolicy(config, deps.runtime, deps.authInfo);

  const server = new McpServer(
    { name: SERVER_NAME, version: VERSION },
    { capabilities: { tools: {} } },
  );

  const env = { server, policy, deps: { config, sevdesk, logger } };
  registerTools(env, TOOLS);
  // The fallback builds its requests from the spec itself; its client still
  // sends only the released operations the rights allow.
  const fallbackClient = restrictClient(
    sevdesk,
    createScopeGate({
      scope: genericScope(GENERIC_TOOL_NAME, config.apiAllow ?? DEFAULT_API_ALLOW, policy.rights),
      rights: policy.rights,
      baseUrl: config.baseUrl,
      subject: policy.subject,
      audit: deps.runtime.audit,
      logger,
    }),
  );
  registerGenericTool({ ...env, deps: { ...env.deps, sevdesk: fallbackClient } });

  return server;
}
