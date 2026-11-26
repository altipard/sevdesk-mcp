import type { McpServer, ServerContext } from "@modelcontextprotocol/server";
import { z } from "zod";
import { type Config, ConfigError } from "../config.js";
import type { Logger } from "../logger.js";
import type { SevdeskClient } from "../sevdesk/client.js";
import type { OperationClass } from "./classification.js";
import { CONFIRMATION_TOKEN_DESCRIPTION, runGuarded, type ToolOutput } from "./guard.js";
import type { OperationId } from "./operations.js";
import { allows, type Rights } from "./rights.js";
import type { RequestPolicy } from "./runtime.js";

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
  readonly inputSchema: S;
  /** Only for R, R+ and W: W+/X calls first return a confirmation preview instead. */
  readonly outputSchema?: ObjectSchema;
  readonly annotations: StrictToolAnnotations;
  /** false: registered only when listed in SEVDESK_ALLOWED_TOOLS (e.g. enshrine_document). */
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
  return definition;
}

/** Explicitly listed in SEVDESK_ALLOWED_TOOLS (an unset list is never explicit). */
export function isExplicitlyAllowed(config: Config, name: string): boolean {
  return config.allowedTools?.includes(name) ?? false;
}

/**
 * Registration rule. Rights (mode and scopes) are a hard ceiling no list can
 * lift; SEVDESK_DENIED_TOOLS always wins; a set SEVDESK_ALLOWED_TOOLS means
 * "exactly these". R+ and default-off tools need an explicit listing.
 */
export function isToolEnabled(
  config: Config,
  rights: Rights,
  tool: Pick<ToolDefinition, "name" | "class" | "defaultEnabled">,
): boolean {
  if (!allows(rights, tool.class)) return false;
  if (config.deniedTools.includes(tool.name)) return false;
  if (config.allowedTools !== undefined) return isExplicitlyAllowed(config, tool.name);
  if (tool.class === "R+") return false;
  return tool.defaultEnabled !== false;
}

/** Fails at startup on names in the allow/deny lists that no tool has (typos). */
export function validateToolNames(config: Config, known: readonly string[]): void {
  const issues: string[] = [];
  for (const [variable, names] of [
    ["SEVDESK_ALLOWED_TOOLS", config.allowedTools ?? []],
    ["SEVDESK_DENIED_TOOLS", config.deniedTools],
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
}

const stringId = (value: string | number | undefined) =>
  value === undefined ? undefined : String(value);

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
  const registered: string[] = [];
  for (const definition of definitions) {
    if (!isToolEnabled(policy.config, policy.rights, definition)) continue;
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

    server.registerTool(
      definition.name,
      {
        title: definition.title,
        description: definition.description,
        inputSchema,
        ...(definition.outputSchema && { outputSchema: definition.outputSchema }),
        annotations: { ...definition.annotations },
      },
      async (input: Record<string, unknown>, ctx: ServerContext) => {
        const { confirmation_token: token, ...rest } = input;
        const args = (confirm ? rest : input) as z.infer<typeof definition.inputSchema>;
        const call: ToolCall = { ...deps, ctx };
        return runGuarded({ policy, server, logger: deps.logger }, ctx, {
          key: definition.name,
          tool: definition.name,
          operationId: definition.operationId,
          class: definition.class,
          args: args as Record<string, unknown>,
          confirmationToken: typeof token === "string" && token !== "" ? token : undefined,
          targetId: stringId(definition.targetId?.(args)),
          explicitlyAllowed: isExplicitlyAllowed(policy.config, definition.name),
          summary: definition.summary?.(args) ?? `Run ${definition.name}.`,
          preview:
            definition.preview && (() => definition.preview?.(args, call) ?? Promise.resolve({})),
          execute: () => definition.handler(args, call),
        });
      },
    );
    registered.push(definition.name);
  }
  return registered;
}
