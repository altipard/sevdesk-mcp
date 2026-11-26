import type { McpServer, ScopeChallengeHandler, ServerContext } from "@modelcontextprotocol/server";
import { z } from "zod";
import { type Config, ConfigError } from "../config.js";
import type { Logger } from "../logger.js";
import { restrictClient, type SevdeskClient } from "../sevdesk/client.js";
import type { OperationClass } from "./classification.js";
import { CONFIRMATION_TOKEN_DESCRIPTION, runGuarded, type ToolOutput } from "./guard.js";
import type { OperationId } from "./operations.js";
import { allows, minRights, type Rights } from "./rights.js";
import type { RequestPolicy } from "./runtime.js";
import {
  type ClientScope,
  createScopeGate,
  previewScope,
  scopeProblems,
  toolScope,
} from "./scope.js";

export interface ToolDeps {
  readonly config: Config;
  readonly sevdesk: SevdeskClient;
  readonly logger: Logger;
}

export interface ToolCall extends ToolDeps {
  readonly ctx: ServerContext;
}

/** All four hints, always explicit: clients must not fall back to defaults. */
export interface StrictToolAnnotations {
  readonly readOnlyHint: boolean;
  readonly destructiveHint: boolean;
  readonly idempotentHint: boolean;
  readonly openWorldHint: boolean;
}

type ObjectSchema = z.ZodObject<z.ZodRawShape>;

export interface ToolDefinition<S extends ObjectSchema = ObjectSchema> {
  readonly name: string;
  readonly title: string;
  readonly description: string;
  readonly class: OperationClass;
  /** Main sevdesk operation, for audit events and idempotency keys. */
  readonly operationId?: OperationId;
  /**
   * Further operations the handler calls besides operationId. The client a
   * handler gets sends nothing else: requests to other operations, or to
   * operations above the tool's class, are refused before the network.
   */
  readonly operations?: readonly OperationId[];
  readonly inputSchema: S;
  /** Only for R, R+ and W: W+/X calls first return a confirmation preview instead. */
  readonly outputSchema?: ObjectSchema;
  readonly annotations: StrictToolAnnotations;
  /**
   * false: off by default, registered only when listed in SEVDESK_ENABLE_TOOLS
   * (planned for enshrine_document). X and R+ tools are always off by default.
   */
  readonly defaultEnabled?: boolean;
  /** ID of the object the call acts on. Required for X (idempotency key). */
  readonly targetId?: (args: z.infer<S>) => string | number | undefined;
  /** Summary for the approval question, e.g. "Send invoice 42 by e-mail." */
  readonly summary?: (args: z.infer<S>) => string;
  /** Preview for the confirmation step. Required for W+ and X. */
  readonly preview?: (args: z.infer<S>, call: ToolCall) => Promise<ToolOutput>;
  readonly handler: (args: z.infer<S>, call: ToolCall) => Promise<ToolOutput>;
}

export class ToolDefinitionError extends Error {
  override readonly name = "ToolDefinitionError";
}

const needsConfirmation = (operationClass: OperationClass) =>
  operationClass === "W+" || operationClass === "X";

/**
 * Checks a definition against its class, so a tool cannot be mislabelled:
 * annotations must match the class, W+/X need a preview, X a target.
 */
export function defineTool<S extends ObjectSchema>(
  definition: ToolDefinition<S>,
): ToolDefinition<S> {
  const { name, annotations: a } = definition;
  const fail = (problem: string): never => {
    throw new ToolDefinitionError(`tool ${name}: ${problem}`);
  };
  if (!/^[a-z][a-z0-9_]*$/.test(name)) fail("name must be snake_case");
  const reading = definition.class === "R" || definition.class === "R+";
  if (a.readOnlyHint !== reading)
    fail(`readOnlyHint must be ${reading} for class ${definition.class}`);
  if (reading && a.destructiveHint) fail("a reading tool cannot be destructive");
  if (definition.class === "X" && !a.destructiveHint) fail("class X must set destructiveHint");
  if (definition.class === "X" && a.idempotentHint) fail("class X cannot be idempotent");
  if (needsConfirmation(definition.class)) {
    if (definition.preview === undefined) fail("W+/X tools need a preview");
    if (definition.outputSchema !== undefined) fail("W+/X tools cannot declare an outputSchema");
    if ("confirmation_token" in definition.inputSchema.shape) {
      fail("confirmation_token is added by the registry");
    }
  }
  if (definition.class === "X" && definition.targetId === undefined) fail("class X needs targetId");
  const problems = scopeProblems(definition);
  if (problems.length > 0) fail(problems.join("; "));
  return definition;
}

/**
 * Adds operations to an existing definition, for tools whose own file does
 * not list them yet. Validated like defineTool.
 */
export function withOperations<S extends ObjectSchema>(
  definition: ToolDefinition<S>,
  operations: readonly OperationId[],
): ToolDefinition<S> {
  return defineTool({
    ...definition,
    operations: [...new Set([...(definition.operations ?? []), ...operations])],
  });
}

/**
 * Explicitly switched on in SEVDESK_ENABLE_TOOLS. For X tools this is also
 * the operator's release for clients that cannot ask the user (no
 * elicitation); with elicitation the user is still asked.
 */
export function isExplicitlyEnabled(config: Config, name: string): boolean {
  return config.enableTools.includes(name);
}

/** Off unless switched on: every X and R+ tool and tools marked defaultEnabled: false. */
export function isOffByDefault(tool: Pick<ToolDefinition, "class" | "defaultEnabled">): boolean {
  return tool.class === "X" || tool.class === "R+" || tool.defaultEnabled === false;
}

/**
 * Registration rule:
 * - rights (mode and scopes) are a hard ceiling no list can lift;
 * - SEVDESK_DENIED_TOOLS blocks single tools and always wins;
 * - SEVDESK_ALLOWED_TOOLS, if set, is a whitelist that only narrows;
 * - tools that are off by default need SEVDESK_ENABLE_TOOLS.
 */
export function isToolEnabled(
  config: Config,
  rights: Rights,
  tool: Pick<ToolDefinition, "name" | "class" | "defaultEnabled">,
): boolean {
  if (!allows(rights, tool.class)) return false;
  if (config.deniedTools.includes(tool.name)) return false;
  if (config.allowedTools !== undefined && !config.allowedTools.includes(tool.name)) return false;
  if (isOffByDefault(tool)) return isExplicitlyEnabled(config, tool.name);
  return true;
}

/** Fails at startup on names in the allow/deny lists that no tool has (typos). */
export function validateToolNames(config: Config, known: readonly string[]): void {
  const issues: string[] = [];
  for (const [variable, names] of [
    ["SEVDESK_ALLOWED_TOOLS", config.allowedTools ?? []],
    ["SEVDESK_DENIED_TOOLS", config.deniedTools],
    ["SEVDESK_ENABLE_TOOLS", config.enableTools],
  ] as const) {
    for (const name of names) {
      if (!known.includes(name)) issues.push(`${variable}: unknown tool: ${name}`);
    }
  }
  if (issues.length > 0) throw new ConfigError(issues);
}

export interface RegistrationEnv {
  readonly server: McpServer;
  readonly policy: RequestPolicy;
  readonly deps: ToolDeps;
  /**
   * Rights tools are registered for, instead of policy.rights. The HTTP
   * transport passes the mode: tools/list then shows what the instance
   * offers, and a token without the scope gets a 403 step-up instead of an
   * unknown tool. Never above the mode. The guard and the client scope keep
   * checking policy.rights at call time.
   */
  readonly registrationRights?: Rights;
  /** Scope check before the handler runs (HTTP: 403 insufficient_scope with the scope). */
  readonly scopeChallenge?: (definition: ToolDefinition) => ScopeChallengeHandler | undefined;
}

const stringId = (value: string | number | undefined) =>
  value === undefined ? undefined : String(value);

/**
 * The configuration as tools see it: without the API token and the
 * confirmation secret. Only the client and the policy runtime need them,
 * and both are built before any tool runs.
 */
export function configForTools(config: Config): Config {
  const copy: Config = { ...config, sevdeskApiToken: "" };
  delete copy.confirmSecret;
  return Object.freeze(copy);
}

/** `client` restricted to `scope`, with denials audited for this policy. */
export function scopedClient(
  client: SevdeskClient,
  scope: ClientScope,
  policy: RequestPolicy,
  logger: Logger,
): SevdeskClient {
  return restrictClient(
    client,
    createScopeGate({
      scope,
      rights: policy.rights,
      baseUrl: policy.config.baseUrl,
      subject: policy.subject,
      audit: policy.runtime.audit,
      logger,
    }),
  );
}

/**
 * The one way tools get onto the server. Tools above the effective rights
 * or excluded by the lists are not registered at all; every registered tool
 * runs through the guard, which re-checks rights at call time.
 */
export function registerTools(
  env: RegistrationEnv,
  definitions: readonly ToolDefinition[],
): string[] {
  const { server, policy, deps } = env;
  const config = configForTools(deps.config);
  const registered: string[] = [];
  const registrationRights =
    env.registrationRights === undefined
      ? policy.rights
      : minRights(env.registrationRights, policy.config.mode);
  for (const definition of definitions) {
    if (!isToolEnabled(policy.config, registrationRights, definition)) continue;
    // Definitions built without defineTool still must not declare more
    // than their class.
    const problems = scopeProblems(definition);
    if (problems.length > 0) {
      throw new ToolDefinitionError(`tool ${definition.name}: ${problems.join("; ")}`);
    }
    // The handler only ever sees this client: requests outside the tool's
    // declared operations and class are refused and audited. A preview runs
    // before the confirmation and therefore only reads.
    const sevdesk = scopedClient(deps.sevdesk, toolScope(definition), policy, deps.logger);
    const previewClient = scopedClient(deps.sevdesk, previewScope(definition), policy, deps.logger);
    const confirm = needsConfirmation(definition.class);
    const inputSchema = confirm
      ? definition.inputSchema.extend({
          confirmation_token: z
            .string()
            .max(2048)
            .optional()
            .describe(CONFIRMATION_TOKEN_DESCRIPTION),
        })
      : definition.inputSchema;

    const scopeChallenge = env.scopeChallenge?.(definition);
    server.registerTool(
      definition.name,
      {
        title: definition.title,
        description: definition.description,
        inputSchema,
        ...(definition.outputSchema && { outputSchema: definition.outputSchema }),
        annotations: { ...definition.annotations },
        ...(scopeChallenge && { scopeChallenge }),
      },
      async (input: Record<string, unknown>, ctx: ServerContext) => {
        const { confirmation_token: token, ...rest } = input;
        const args = (confirm ? rest : input) as z.infer<typeof definition.inputSchema>;
        const call: ToolCall = { ...deps, config, sevdesk, ctx };
        const previewCall: ToolCall = { ...call, sevdesk: previewClient };
        return runGuarded({ policy, server, logger: deps.logger }, ctx, {
          key: definition.name,
          tool: definition.name,
          operationId: definition.operationId,
          class: definition.class,
          args: args as Record<string, unknown>,
          confirmationToken: typeof token === "string" && token !== "" ? token : undefined,
          targetId: stringId(definition.targetId?.(args)),
          explicitlyAllowed: isExplicitlyEnabled(policy.config, definition.name),
          summary: definition.summary?.(args) ?? `Run ${definition.name}.`,
          preview:
            definition.preview &&
            (() => definition.preview?.(args, previewCall) ?? Promise.resolve({})),
          execute: () => definition.handler(args, call),
        });
      },
    );
    registered.push(definition.name);
  }
  return registered;
}
