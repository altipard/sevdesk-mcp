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
 * Write-only tokens get no rights at all. The HTTP gate keeps requiring
 * `sevdesk:read` and answers such a token with 403 `scope="sevdesk:read"`;
 * the IdP has to issue `sevdesk:write` only together with `sevdesk:read`.
 * Write does not imply read: an implied step would be a hierarchy the scope
 * list does not state, and the token could reach tools its issuer never
 * granted.
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

/** Audit subject for HTTP calls without an identifiable caller. They get no rights. */
export const UNIDENTIFIED_SUBJECT = "unidentified";

/**
 * Subject bound into confirmation tokens and recorded in audit events:
 * `sub` of the token, else its client ID. Undefined on HTTP when the token
 * names neither: such callers must not share one subject, because they
 * could then use each other's confirmation tokens.
 */
export function subjectFor(
  transport: Transport,
  authInfo: AuthInfo | undefined,
): string | undefined {
  if (transport === "stdio") return "stdio";
  const sub = authInfo?.extra?.sub;
  if (typeof sub === "string" && sub !== "") return `sub:${sub}`;
  if (typeof authInfo?.clientId === "string" && authInfo.clientId !== "") {
    return `client:${authInfo.clientId}`;
  }
  return undefined;
}

/**
 * Effective rights for a request on the given transport. On HTTP a missing
 * authInfo never falls back to the mode: without a verified token there are
 * no rights, even if the auth gate in front was misconfigured. A token that
 * identifies no caller (neither sub nor client ID) gets no rights either.
 */
export function rightsForRequest(
  mode: Mode,
  transport: Transport,
  authInfo: AuthInfo | undefined,
): Rights {
  if (transport === "stdio") return effectiveRights(mode, undefined);
  if (authInfo === undefined || subjectFor(transport, authInfo) === undefined) return "none";
  return effectiveRights(mode, authInfo.scopes);
}
