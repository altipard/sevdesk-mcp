import type { AuthInfo } from "@modelcontextprotocol/server";
import type { Mode } from "../config.js";
import type { OperationClass } from "./classification.js";

/** Rights a caller ends up with. "none" only happens for HTTP callers. */
export const RIGHTS = ["none", "read", "write", "full"] as const;
export type Rights = (typeof RIGHTS)[number];

export const SCOPES = {
  read: "sevdesk:read",
  write: "sevdesk:write",
  irreversible: "sevdesk:irreversible",
} as const;

export type Transport = "stdio" | "http";

const rank = (rights: Rights): number => RIGHTS.indexOf(rights);

/** Rights needed to use an operation or tool of the given class. */
export function requiredRights(operationClass: OperationClass): Rights {
  switch (operationClass) {
    case "R":
    case "R+":
      return "read";
    case "W":
    case "W+":
      return "write";
    case "X":
      return "full";
  }
}

export function allows(rights: Rights, operationClass: OperationClass): boolean {
  return rank(rights) >= rank(requiredRights(operationClass));
}

export function minRights(a: Rights, b: Rights): Rights {
  return rank(a) <= rank(b) ? a : b;
}

/**
 * Rights granted by OAuth scopes alone, as a pure function of the token's
 * scope list, so the HTTP entrypoint can use it on `authInfo.scopes`.
 *
 * Scopes are a ladder without implied steps: each level needs its own scope
 * and every scope below it. `sevdesk:write` does not imply `sevdesk:read`,
 * and `sevdesk:irreversible` without `sevdesk:write` adds nothing.
 *
 * Write-only tokens (auth-spike.md, "Auflagen"): they get no rights at all.
 * The HTTP gate keeps requiring `sevdesk:read` and answers such a token with
 * 403 `scope="sevdesk:read"`; the IdP has to issue `sevdesk:write` only
 * together with `sevdesk:read`. Treating write as implying read here would
 * be exactly the silent hierarchy the spike rules out, and it would let a
 * token reach tools its issuer never granted.
 */
export function rightsFromScopes(scopes: readonly string[]): Rights {
  const has = (scope: string) => scopes.includes(scope);
  if (!has(SCOPES.read)) return "none";
  if (!has(SCOPES.write)) return "read";
  if (!has(SCOPES.irreversible)) return "write";
  return "full";
}

/**
 * Effective rights = minimum of the instance mode and the token scopes.
 * `scopes` undefined means "no token involved" (stdio), where the mode alone
 * applies. An empty list is a token without scopes and grants nothing.
 */
export function effectiveRights(mode: Mode, scopes: readonly string[] | undefined): Rights {
  if (scopes === undefined) return mode;
  return minRights(mode, rightsFromScopes(scopes));
}

/**
 * Effective rights for a request on the given transport. On HTTP a missing
 * authInfo never falls back to the mode: without a verified token there are
 * no rights, even if the auth gate in front was misconfigured.
 */
export function rightsForRequest(
  mode: Mode,
  transport: Transport,
  authInfo: AuthInfo | undefined,
): Rights {
  if (transport === "stdio") return effectiveRights(mode, undefined);
  if (authInfo === undefined) return "none";
  return effectiveRights(mode, authInfo.scopes);
}

/** Subject recorded in confirmation tokens and audit events. */
export function subjectFor(transport: Transport, authInfo: AuthInfo | undefined): string {
  if (transport === "stdio") return "stdio";
  const sub = authInfo?.extra?.sub;
  if (typeof sub === "string" && sub !== "") return `sub:${sub}`;
  if (authInfo?.clientId) return `client:${authInfo.clientId}`;
  return "anonymous";
}
