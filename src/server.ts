import { type AuthInfo, McpServer } from "@modelcontextprotocol/server";
import type { Config } from "./config.js";
import { argumentScopeChallenge, scopeChallengeFor } from "./http/scope-challenge.js";
import { createLogger, type Logger } from "./logger.js";
import { classOf } from "./policy/classification.js";
import {
  configForTools,
  registerTools,
  scopedClient,
  validateToolNames,
} from "./policy/registry.js";
import { allows } from "./policy/rights.js";
import { type PolicyRuntime, type RequestPolicy, requestPolicy } from "./policy/runtime.js";
import { genericScope } from "./policy/scope.js";
import { createSevdeskClient, type SevdeskClient } from "./sevdesk/client.js";
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
 * a transport to it, so stdio and HTTP expose the same tools under the same
 * rules. On HTTP the tool set follows the mode and every tool carries a
 * scope challenge; on stdio the mode alone applies.
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
  // Everything past this point, tools included, sees the configuration
  // without the API token and the confirmation secret.
  const visible = configForTools(config);
  const policy = requestPolicy(visible, deps.runtime, deps.authInfo);

  const server = new McpServer(
    { name: SERVER_NAME, version: VERSION },
    { capabilities: { tools: {} } },
  );

  const env = { server, policy, deps: { config: visible, sevdesk, logger } };
  const http = deps.runtime.transport === "http";
  // HTTP registers by mode, not by token: a token without the scope sees
  // the tool and gets 403 insufficient_scope naming the scopes (step-up)
  // instead of "unknown tool". The guard and the client scope still check
  // the token's rights (policy.rights) on every call.
  registerTools(
    http
      ? {
          ...env,
          registrationRights: config.mode,
          scopeChallenge: (d) => scopeChallengeFor(d.class),
        }
      : env,
    TOOLS,
  );
  // The fallback builds its requests from the spec itself; its client still
  // sends only the released operations the token's rights allow.
  const allowList = config.apiAllow ?? DEFAULT_API_ALLOW;
  const fallbackClient = scopedClient(
    sevdesk,
    genericScope(GENERIC_TOOL_NAME, allowList, policy.rights),
    policy,
    logger,
  );
  // registerGenericTool registers for policy.rights. On HTTP it gets the
  // mode there, with the same subject, so its operation list follows the
  // mode too. Its guard derives the rights again from the request's token
  // (minimum of these and the token's), and fallbackClient above is bound
  // to the token's rights, so nothing above them is executed or sent.
  const registrationPolicy: RequestPolicy = http ? { ...policy, rights: config.mode } : policy;
  const generic = registerGenericTool({
    ...env,
    policy: registrationPolicy,
    deps: { ...env.deps, sevdesk: fallbackClient },
  });
  if (http) {
    generic?.update({
      scopeChallenge: argumentScopeChallenge((args) => {
        const id = args.operationId;
        if (typeof id !== "string" || !allowList.includes(id)) return undefined;
        const operationClass = classOf(id);
        return operationClass !== undefined && allows(config.mode, operationClass)
          ? operationClass
          : undefined;
      }),
    });
  }

  return server;
}
