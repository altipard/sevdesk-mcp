import { OPERATIONS, type OperationId } from "./operations.js";

/**
 * Pins: parameter values that would lift an operation into a higher class
 * than it is classified in. They apply on every call path: the fallback
 * checks them up front for a clear error, and the sevdesk client enforces
 * them again on the outgoing request, so curated tools cannot forget them.
 */

/** Message is safe to show to the caller. */
export class PinViolation extends Error {
  override readonly name = "PinViolation";
}

/**
 * Query parameters the server pins. getPdf without preventSendBy marks the
 * document as sent (W+); the DATEV exports with enshrine/enshrineDocuments
 * enshrine every exported record (X). `true` is sent explicitly; `false`
 * by leaving the parameter out, so nothing depends on how sevdesk parses
 * the string "false". Asking for the other value is an error.
 */
export const QUERY_PINS: Readonly<Record<string, boolean>> = {
  preventSendBy: true,
  enshrine: false,
  enshrineDocuments: false,
};

export type PinnedParam =
  | { readonly omit: true }
  | { readonly omit: false; readonly value: unknown };

/**
 * Applies the pin for one declared query parameter. Returns undefined if the
 * parameter is not pinned, otherwise what to send; throws on a conflict.
 */
export function pinQueryParam(name: string, value: unknown): PinnedParam | undefined {
  if (!Object.hasOwn(QUERY_PINS, name)) return undefined;
  const pinned = QUERY_PINS[name] as boolean;
  if (value !== undefined && value !== null && value !== pinned && value !== String(pinned)) {
    throw new PinViolation(`${name} is always ${pinned} on this server`);
  }
  return pinned ? { omit: false, value: pinned } : { omit: true };
}

interface Route {
  readonly operationId: OperationId;
  readonly method: string;
  readonly pattern: RegExp;
  readonly params: number;
}

// Literal paths win over templates ("/Contact/Factory/x" before "/Contact/{id}").
const ROUTES: readonly Route[] = (
  Object.entries(OPERATIONS) as Array<[OperationId, (typeof OPERATIONS)[OperationId]]>
)
  .map(([operationId, op]) => ({
    operationId,
    method: op.method,
    params: (op.path.match(/\{/g) ?? []).length,
    pattern: new RegExp(
      `^${op.path
        .split(/\{[^}]+\}/)
        .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
        .join("[^/]+")}$`,
    ),
  }))
  .sort((a, b) => a.params - b.params);

/** The operation a request targets, by method and path relative to the base URL. */
export function matchOperation(method: string, relativePath: string): OperationId | undefined {
  const upper = method.toUpperCase();
  return ROUTES.find((route) => route.method === upper && route.pattern.test(relativePath))
    ?.operationId;
}

/**
 * Enforces the pins on an outgoing request. Requests to paths outside the
 * spec are passed through unchanged; nothing is pinned for them.
 */
export async function enforceRequestPins(request: Request, baseUrl: string): Promise<Request> {
  const url = new URL(request.url);
  const basePath = new URL(baseUrl).pathname.replace(/\/+$/, "");
  if (!url.pathname.startsWith(`${basePath}/`)) return request;
  const operationId = matchOperation(request.method, url.pathname.slice(basePath.length));
  if (operationId === undefined) return request;

  let changed = false;
  for (const spec of OPERATIONS[operationId].params) {
    if (spec.in !== "query") continue;
    const present = url.searchParams.get(spec.name);
    const pinned = pinQueryParam(spec.name, present ?? undefined);
    if (pinned === undefined) continue;
    if (pinned.omit) {
      if (present !== null) {
        url.searchParams.delete(spec.name);
        changed = true;
      }
    } else if (present !== String(pinned.value)) {
      url.searchParams.set(spec.name, String(pinned.value));
      changed = true;
    }
  }
  return changed ? new Request(url, request) : request;
}
