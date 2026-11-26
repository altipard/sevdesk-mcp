import type { Logger } from "../logger.js";
import { SevdeskError } from "../sevdesk/errors.js";
import type { AuditLog } from "./audit.js";
import { classOf, OPERATION_CLASSES, type OperationClass } from "./classification.js";
import type { OperationId } from "./operations.js";
import { matchOperation, normalizePath } from "./pins.js";
import { allows, type Rights } from "./rights.js";

/**
 * What one tool may send to sevdesk. The registry checks a tool's class
 * before the handler runs; this scope checks every request the handler
 * then makes, so a handler cannot reach operations above its class or
 * outside its declaration, whatever it does with the client.
 */
export interface ClientScope {
  /** Tool name, for messages and audit events. */
  readonly tool: string;
  /** Declared class of the tool: no operation above it is sent. */
  readonly class: OperationClass;
  /** Operations the tool declared; everything else is refused. */
  readonly operations: ReadonlySet<OperationId>;
}

export type ScopeDenial =
  /** Different origin, or a path outside the base URL. */
  | "outside_base_url"
  /** Method and path match no operation of the spec. */
  | "unmapped"
  /** The operation has no class. */
  | "unclassified"
  /** The operation's class is above the tool's class. */
  | "class_exceeded"
  /** The operation's class is above the caller's rights. */
  | "rights_exceeded"
  /** The operation is not declared for this tool. */
  | "not_declared";

export type ScopeDecision =
  | { readonly ok: true; readonly operationId: OperationId; readonly class: OperationClass }
  | {
      readonly ok: false;
      readonly reason: ScopeDenial;
      readonly operationId?: OperationId | undefined;
      readonly class?: OperationClass | undefined;
    };

const rank = (operationClass: OperationClass) => OPERATION_CLASSES.indexOf(operationClass);

/** Whether `operationClass` stays within `ceiling` (R < R+ < W < W+ < X). */
export function classWithin(operationClass: OperationClass, ceiling: OperationClass): boolean {
  return rank(operationClass) <= rank(ceiling);
}

// Path segments as the spec and openapi-fetch produce them: names and
// plain IDs. Percent-encoding, ";" parameters or dot segments could make
// sevdesk route a request differently than the matcher reads it.
const PLAIN_SEGMENT = /^[A-Za-z0-9_~-]+(\.[A-Za-z0-9_~-]+)*$/;

/**
 * Maps a request to its operation and checks it against the scope and the
 * caller's rights. Anything that cannot be mapped unambiguously is denied.
 */
export function checkRequest(
  scope: ClientScope,
  rights: Rights,
  baseUrl: string,
  method: string,
  url: string,
): ScopeDecision {
  let target: URL;
  let base: URL;
  try {
    target = new URL(url);
    base = new URL(baseUrl);
  } catch {
    return { ok: false, reason: "outside_base_url" };
  }
  if (target.origin !== base.origin || target.username !== "" || target.password !== "") {
    return { ok: false, reason: "outside_base_url" };
  }
  const basePath = normalizePath(base.pathname).toLowerCase().replace(/\/$/, "");
  const raw = target.pathname;
  if (!raw.toLowerCase().startsWith(`${basePath}/`))
    return { ok: false, reason: "outside_base_url" };
  const relative = raw.slice(basePath.length);
  const segments = relative.split("/").slice(1);
  if (segments.length === 0 || !segments.every((segment) => PLAIN_SEGMENT.test(segment))) {
    return { ok: false, reason: "unmapped" };
  }

  const operationId = matchOperation(method, relative);
  if (operationId === undefined) return { ok: false, reason: "unmapped" };
  const operationClass = classOf(operationId);
  if (operationClass === undefined) return { ok: false, reason: "unclassified", operationId };
  const denied = (reason: ScopeDenial): ScopeDecision => ({
    ok: false,
    reason,
    operationId,
    class: operationClass,
  });
  if (!classWithin(operationClass, scope.class)) return denied("class_exceeded");
  if (!allows(rights, operationClass)) return denied("rights_exceeded");
  if (!scope.operations.has(operationId)) return denied("not_declared");
  return { ok: true, operationId, class: operationClass };
}

/** Message for the caller. Names no path, so no IDs or query values end up in it. */
export function denialMessage(
  scope: ClientScope,
  method: string,
  decision: Extract<ScopeDecision, { ok: false }>,
): string {
  const operation = decision.operationId
    ? `sevdesk operation ${decision.operationId}${decision.class ? ` (class ${decision.class})` : ""}`
    : `this ${method.toUpperCase().slice(0, 10)} request`;
  const why: Record<ScopeDenial, string> = {
    outside_base_url: "it does not go to the configured sevdesk API",
    unmapped: "it does not match any operation of the sevdesk API spec",
    unclassified: "the operation is not classified",
    class_exceeded: `the tool is declared as class ${scope.class}`,
    rights_exceeded: "the effective rights (SEVDESK_MODE and token scopes) do not allow it",
    not_declared: "the operation is not declared for this tool",
  };
  return `${scope.tool} may not call ${operation}: ${why[decision.reason]}. Nothing was sent to sevdesk.`;
}

export interface GateEnv {
  readonly scope: ClientScope;
  readonly rights: Rights;
  readonly baseUrl: string;
  readonly subject: string;
  readonly audit: AuditLog;
  readonly logger: Logger;
}

/**
 * Request check for the sevdesk client: throws a policy SevdeskError, after
 * an audit entry, for every request outside the scope. Runs before the
 * request is sent; a failing audit sink still denies.
 */
export function createScopeGate(env: GateEnv): (request: Request) => void {
  return (request) => {
    const decision = checkRequest(env.scope, env.rights, env.baseUrl, request.method, request.url);
    if (decision.ok) return;
    env.logger.warn("sevdesk request outside the tool scope", {
      tool: env.scope.tool,
      method: request.method,
      operationId: decision.operationId,
      reason: decision.reason,
    });
    try {
      env.audit.record({
        subject: env.subject,
        tool: env.scope.tool,
        operationId: decision.operationId,
        class: env.scope.class,
        outcome: "denied",
        reason: `client_scope:${decision.reason}`,
      });
    } catch (error) {
      env.logger.error("audit sink failed", { tool: env.scope.tool, outcome: "denied", error });
    }
    throw new SevdeskError("policy", denialMessage(env.scope, request.method, decision));
  };
}

/** Scope of a curated tool: its main operation plus the ones it lists. */
export function toolScope(tool: {
  readonly name: string;
  readonly class: OperationClass;
  readonly operationId?: OperationId | undefined;
  readonly operations?: readonly OperationId[] | undefined;
}): ClientScope {
  return {
    tool: tool.name,
    class: tool.class,
    operations: new Set([
      ...(tool.operationId ? [tool.operationId] : []),
      ...(tool.operations ?? []),
    ]),
  };
}

/**
 * Scope of the generic fallback: exactly the released operations the
 * rights allow, as in its registration. Its class is the highest class
 * among them, so the audit trail shows how far it can reach.
 */
export function genericScope(
  tool: string,
  allowList: readonly string[],
  rights: Rights,
): ClientScope {
  const operations = new Set<OperationId>();
  let ceiling: OperationClass = "R";
  for (const id of allowList) {
    const operationClass = classOf(id);
    if (operationClass === undefined || !allows(rights, operationClass)) continue;
    operations.add(id as OperationId);
    if (!classWithin(operationClass, ceiling)) ceiling = operationClass;
  }
  return { tool, class: ceiling, operations };
}

/**
 * Problems with the operations a tool declares: unknown, unclassified or
 * above the tool's class. Checked at definition and registration time, so
 * such a tool fails at startup instead of at its first call.
 */
export function scopeProblems(tool: {
  readonly class: OperationClass;
  readonly operationId?: string | undefined;
  readonly operations?: readonly string[] | undefined;
}): string[] {
  const problems: string[] = [];
  const declared = [
    ...(tool.operationId !== undefined ? [["operationId", tool.operationId] as const] : []),
    ...(tool.operations ?? []).map((id) => ["operations", id] as const),
  ];
  for (const [field, id] of declared) {
    const operationClass = classOf(id);
    if (operationClass === undefined) {
      problems.push(`${field}: ${id} is not a classified sevdesk operation`);
    } else if (!classWithin(operationClass, tool.class)) {
      problems.push(`${field}: ${id} is class ${operationClass}, above the tool's ${tool.class}`);
    }
  }
  return problems;
}
