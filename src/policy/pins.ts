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

interface BodyPin {
  /** Field path inside the JSON body. */
  readonly path: readonly string[];
  /** Allowed values (compared as numbers); without it the field must be absent or null. */
  readonly allow?: readonly number[];
}

const draftOnly = (prefix: readonly string[], draft: number, extra: readonly string[] = []) => [
  { path: [...prefix, "status"], allow: [draft] },
  ...["sendDate", "sendType", "enshrined", ...extra].map((field) => ({ path: [...prefix, field] })),
];

/**
 * Body fields of W operations that would reach W+ (or X) effects without a
 * confirmation: setting a document to sent/paid/booked, a send date or
 * send type, or the enshrined flag. These operations may only create or
 * change drafts; status changes run through their own confirmed operations.
 */
export const BODY_PINS: Readonly<Partial<Record<OperationId, readonly BodyPin[]>>> = {
  createInvoiceByFactory: draftOnly(["invoice"], 100),
  createcreditNote: draftOnly(["creditNote"], 100),
  createOrder: draftOnly(["order"], 100),
  updateOrder: draftOnly([], 100),
  // Voucher draft is 50; 100 is already "unpaid" (booked as open).
  voucherFactorySaveVoucher: draftOnly(["voucher"], 50),
  // Transaction 100 = created; 200 linked, 300 private, 400 booked.
  createTransaction: [{ path: ["status"], allow: [100] }],
};

function fieldAt(body: unknown, path: readonly string[]): unknown {
  let current = body;
  for (const key of path) {
    if (typeof current !== "object" || current === null || Array.isArray(current)) return undefined;
    current = Object.hasOwn(current, key) ? (current as Record<string, unknown>)[key] : undefined;
  }
  return current;
}

/** Throws PinViolation if the body sets a pinned field to a disallowed value. */
export function checkBodyPins(operationId: OperationId, body: unknown): void {
  for (const pin of BODY_PINS[operationId] ?? []) {
    const value = fieldAt(body, pin.path);
    if (value === undefined || value === null) continue;
    const field = pin.path.join(".");
    if (pin.allow === undefined) {
      throw new PinViolation(
        `${operationId}: ${field} must not be set on this server. ` +
          "Sending and status changes run through their own confirmed operations.",
      );
    }
    const numeric =
      typeof value === "number" || typeof value === "string" ? Number(value) : Number.NaN;
    if (!pin.allow.includes(numeric)) {
      throw new PinViolation(
        `${operationId}: ${field} may only be ${pin.allow.join(" or ")} (draft) on this server. ` +
          "Status changes run through their own confirmed operations.",
      );
    }
  }
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

  if (BODY_PINS[operationId] !== undefined && request.body !== null) {
    const type = request.headers.get("content-type") ?? "";
    let body: unknown;
    try {
      if (!type.includes("json")) throw new Error("not JSON");
      body = JSON.parse(await request.clone().text());
    } catch {
      throw new PinViolation(`${operationId}: the request body must be JSON on this server`);
    }
    checkBodyPins(operationId, body);
  }

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
