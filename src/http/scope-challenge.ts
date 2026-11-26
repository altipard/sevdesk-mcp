import {
  type JSONRPCRequest,
  requireScopes,
  type ScopeChallengeHandler,
} from "@modelcontextprotocol/server";
import type { OperationClass } from "../policy/classification.js";
import { type Rights, requiredRights, SCOPES } from "../policy/rights.js";

/**
 * The complete scope set a token needs for the given rights. Scopes are a
 * ladder without implied steps (see rightsFromScopes), so a challenge names
 * every step: a client that requests only `sevdesk:write` would end up with
 * a token that grants nothing.
 */
export function scopesFor(rights: Rights): readonly [string, ...string[]] {
  switch (rights) {
    case "none":
    case "read":
      return [SCOPES.read];
    case "write":
      return [SCOPES.read, SCOPES.write];
    case "full":
      return [SCOPES.read, SCOPES.write, SCOPES.irreversible];
  }
}

/**
 * Transport-level check for a tool of the given class: a token without the
 * scopes gets HTTP 403 insufficient_scope naming them, before the handler
 * runs, so the client can step up. The guard checks the rights again in the
 * handler; this check only adds the hint.
 */
export function scopeChallengeFor(operationClass: OperationClass): ScopeChallengeHandler {
  return requireScopes(...scopesFor(requiredRights(operationClass)));
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * Challenge for a tool whose class depends on its arguments (the generic
 * fallback: the class of the requested operationId). `classOfCall` returns
 * undefined when no step-up could help (unknown or unreleased operation,
 * above the mode); the handler then refuses the call itself.
 */
export function argumentScopeChallenge(
  classOfCall: (args: Record<string, unknown>) => OperationClass | undefined,
): ScopeChallengeHandler {
  return (context) => {
    const request: JSONRPCRequest = context.request;
    const args = request.params?.arguments;
    const operationClass = classOfCall(isRecord(args) ? args : {});
    return operationClass === undefined ? undefined : scopeChallengeFor(operationClass)(context);
  };
}
