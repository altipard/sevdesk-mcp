import type { Logger } from "../logger.js";
import type { RequestGate } from "../sevdesk/client.js";
import { SevdeskError } from "../sevdesk/errors.js";
import type { AuditLog } from "./audit.js";
import { classOf, OPERATION_CLASSES, type OperationClass } from "./classification.js";
import { OPERATIONS, type OperationId } from "./operations.js";
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
  /** Declared class of the tool, recorded in audit events. */
  readonly class: OperationClass;
  /** Highest class sent; the tool's class unless narrowed (previews: R). */
  readonly ceiling?: OperationClass | undefined;
  /** Set for the client of a confirmation preview, which only reads. */
  readonly stage?: "preview" | undefined;
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
  if (!classWithin(operationClass, scope.ceiling ?? scope.class)) return denied("class_exceeded");
  if (!allows(rights, operationClass)) return denied("rights_exceeded");
  if (!scope.operations.has(operationId)) return denied("not_declared");
  return { ok: true, operationId, class: operationClass };
}

interface QueryNames {
  /** Names sent as they are, including literal ones like "contact[id]". */
  readonly exact: ReadonlySet<string>;
  /** Object parameters, sent as name[key]… (sevQuery[filter][contact][id]). */
  readonly objects: ReadonlySet<string>;
}

const queryNames = new Map<OperationId, QueryNames>();

function queryNamesOf(operationId: OperationId): QueryNames {
  let names = queryNames.get(operationId);
  if (names === undefined) {
    const params = OPERATIONS[operationId].params.filter((param) => param.in === "query");
    names = {
      exact: new Set(params.map((param) => param.name)),
      objects: new Set(params.filter((param) => param.type === "object").map((p) => p.name)),
    };
    queryNames.set(operationId, names);
  }
  return names;
}

const OBJECT_KEY = /^([^[\]]+)((?:\[[^[\]]*\])+)$/;

/**
 * The first query key `url` carries that the operation does not declare,
 * or undefined. Keys are compared exactly, as sevdesk reads them: a
 * method override (method, _method), a differently cased or bracketed
 * variant of a declared name or any other extra key could change what
 * sevdesk does without the scope seeing it. Object parameters are only
 * checked by their root name; the table has no schema for what is nested.
 */
export function undeclaredQueryKey(operationId: OperationId, url: string): string | undefined {
  const names = queryNamesOf(operationId);
  for (const key of new URL(url).searchParams.keys()) {
    if (names.exact.has(key)) continue;
    const root = OBJECT_KEY.exec(key)?.[1];
    if (root !== undefined && names.objects.has(root)) continue;
    return key;
  }
  return undefined;
}

/** A query key as it may appear in messages and audit reasons. */
export function shownQueryKey(key: string): string {
  return key.slice(0, 60).replace(/[^\x20-\x7e]/g, "?");
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
    class_exceeded:
      scope.stage === "preview"
        ? "a preview only reads (class R) before the confirmation"
        : `the tool is declared as class ${scope.ceiling ?? scope.class}`,
    rights_exceeded: "the effective rights (SEVDESK_MODE and token scopes) do not allow it",
    not_declared: "the operation is not declared for this tool",
  };
  return `${caller(scope)} may not call ${operation}: ${why[decision.reason]}. Nothing was sent to sevdesk.`;
}

const caller = (scope: ClientScope) =>
  scope.stage === "preview" ? `${scope.tool} (preview)` : scope.tool;

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
export function createScopeGate(env: GateEnv): RequestGate {
  const deny = (
    method: string,
    reason: string,
    operationId: OperationId | undefined,
    attemptedClass: OperationClass | undefined,
  ): void => {
    env.logger.warn("sevdesk request outside the tool scope", {
      tool: env.scope.tool,
      stage: env.scope.stage,
      method,
      operationId,
      attemptedClass,
      reason,
    });
    try {
      env.audit.record({
        subject: env.subject,
        tool: env.scope.tool,
        operationId,
        class: env.scope.class,
        attemptedClass,
        outcome: "denied",
        reason: `client_scope:${env.scope.stage === "preview" ? "preview:" : ""}${reason}`,
      });
    } catch (error) {
      env.logger.error("audit sink failed", { tool: env.scope.tool, outcome: "denied", error });
    }
  };
  return {
    check(request) {
      const decision = checkRequest(
        env.scope,
        env.rights,
        env.baseUrl,
        request.method,
        request.url,
      );
      if (!decision.ok) {
        deny(request.method, decision.reason, decision.operationId, decision.class);
        throw new SevdeskError("policy", denialMessage(env.scope, request.method, decision));
      }
      // Allowlist, not denylist: only the query keys the spec declares for
      // this operation reach sevdesk.
      const key = undeclaredQueryKey(decision.operationId, request.url);
      if (key === undefined) return;
      const shown = shownQueryKey(key);
      deny(request.method, `query:${shown}`, decision.operationId, decision.class);
      throw new SevdeskError(
        "policy",
        `${caller(env.scope)} may not send the query parameter "${shown}" to sevdesk operation ` +
          `${decision.operationId}: it is not declared for this operation. Nothing was sent to sevdesk.`,
      );
    },
    callRefused(method, reason) {
      deny(method, reason, undefined, undefined);
    },
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
 * Scope of a W+/X tool's confirmation preview: only the class-R operations
 * of its declaration. Nothing is written before the confirmation, not even
 * the tool's own operation.
 */
export function previewScope(tool: Parameters<typeof toolScope>[0]): ClientScope {
  const full = toolScope(tool);
  return {
    ...full,
    ceiling: "R",
    stage: "preview",
    operations: new Set([...full.operations].filter((id) => classOf(id) === "R")),
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
