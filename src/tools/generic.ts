import type { CallToolResult, ServerContext } from "@modelcontextprotocol/server";
import { z } from "zod";
import { classOf, type OperationClass } from "../policy/classification.js";
import { CONFIRMATION_TOKEN_DESCRIPTION, runGuarded, type ToolOutput } from "../policy/guard.js";
import { OPERATIONS, type OperationId, type ParamSpec } from "../policy/operations.js";
import { isToolEnabled, type RegistrationEnv } from "../policy/registry.js";
import { allows } from "../policy/rights.js";

export const GENERIC_TOOL_NAME = "sevdesk_api_request";

/**
 * Operations the fallback offers when SEVDESK_API_ALLOW is unset: reads
 * without side effects (class R). Left out on purpose:
 * - getPdf (invoice, credit note, order): the curated tools serve PDFs;
 * - Report/*: they return rendered list files rather than data;
 * - every R+ (Export/*, export jobs), W, W+ and X operation, including
 *   sendByWithRender.
 */
export const DEFAULT_API_ALLOW: readonly OperationId[] = [
  "bookkeepingSystemVersion",
  "getCheckAccounts",
  "getCheckAccountById",
  "getBalanceAtDate",
  "getTransactions",
  "getCheckAccountTransactionById",
  "listPrivateTransactionRules",
  "getNextCustomerNumber",
  "findContactsByCustomFieldValue",
  "contactCustomerNumberAvailabilityCheck",
  "getContacts",
  "getContactById",
  "getContactTabsItemCountById",
  "getContactAddresses",
  "contactAddressId",
  "getCommunicationWays",
  "getCommunicationWayById",
  "getCommunicationWayKeys",
  "getAccountingContact",
  "getAccountingContactById",
  "getPlaceholder",
  "getContactFields",
  "getContactFieldsById",
  "getContactFieldSettings",
  "getContactFieldSettingById",
  "getReferenceCount",
  "getCreditNotes",
  "getcreditNoteById",
  "getcreditNotePositions",
  "getParts",
  "getPartById",
  "partGetStock",
  "getInvoices",
  "getInvoiceById",
  "getInvoicePositionsById",
  "getIsInvoicePartiallyPaid",
  "invoiceGetXml",
  "getInvoicePos",
  "getLetterpapersWithThumb",
  "getTemplates",
  "getOrders",
  "getOrderById",
  "getOrderPositionsById",
  "getDiscounts",
  "getRelatedObjects",
  "getOrderPositions",
  "getOrderPositionById",
  "getVouchers",
  "getVoucherById",
  "getVoucherPositions",
  "forAllAccounts",
  "forAccountNumber",
  "forTaxRule",
  "forRevenue",
  "forExpense",
  "getTags",
  "getTagById",
  "getTagRelations",
];

/**
 * Parameters the server pins, because the other value would lift the
 * operation into a higher class: getPdf without preventSendBy marks the
 * document as sent (W+), the DATEV exports with enshrine/enshrineDocuments
 * enshrine every exported record (X). A caller asking for the other value
 * gets an error. `true` is sent explicitly; `false` is sent by leaving the
 * parameter out, so nothing depends on how sevdesk parses the string "false".
 */
export const FORCED_PARAMS: Readonly<Record<string, boolean>> = {
  preventSendBy: true,
  enshrine: false,
  enshrineDocuments: false,
};

/** Applied when an operation declares `limit` and the caller sets none. */
export const DEFAULT_LIMIT = 50;
/** Upper bound for the serialized response handed to the model. */
export const MAX_RESPONSE_CHARS = 100_000;
const MAX_VALUE_LENGTH = 1000;
const MAX_URL_LENGTH = 8000;
const MAX_OBJECT_DEPTH = 4;
const OBJECT_KEY = /^[A-Za-z0-9_]+$/;

/** Invalid input for the fallback; the message is safe to show. */
export class RequestBuildError extends Error {
  override readonly name = "RequestBuildError";
}

export interface BuiltRequest {
  readonly operationId: OperationId;
  readonly method: string;
  /** Encoded path plus query, relative to the base URL. */
  readonly path: string;
  readonly targetId: string | undefined;
  readonly appliedDefaults: Readonly<Record<string, unknown>>;
}

const fail = (message: string): never => {
  throw new RequestBuildError(message);
};

function primitiveToString(spec: ParamSpec, value: unknown): string {
  if (typeof value === "string") {
    if (value.length > MAX_VALUE_LENGTH)
      fail(`${spec.name} is longer than ${MAX_VALUE_LENGTH} characters`);
    return value;
  }
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  if (typeof value === "boolean") return String(value);
  return fail(`${spec.name} must be a string, number or boolean`);
}

function pathValue(spec: ParamSpec, value: unknown): string {
  switch (spec.type) {
    case "integer":
      if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0)
        return String(value);
      if (typeof value === "string" && /^\d{1,15}$/.test(value)) return value;
      return fail(`${spec.name} must be a non-negative integer`);
    case "number":
      if (typeof value === "number" && Number.isFinite(value) && value >= 0) return String(value);
      if (typeof value === "string" && /^\d{1,15}(\.\d{1,6})?$/.test(value)) return value;
      return fail(`${spec.name} must be a non-negative number`);
    case "string": {
      const text = primitiveToString(spec, value);
      // Encoded or not, these could change which resource the path names.
      if (text === "" || text === "." || text === ".." || /[/\\]/.test(text)) {
        fail(`${spec.name} is not a valid path segment`);
      }
      return text;
    }
    default:
      return fail(`${spec.name} has an unsupported path parameter type`);
  }
}

function flattenObject(
  prefix: string,
  value: unknown,
  depth: number,
  out: Array<[string, string]>,
  spec: ParamSpec,
): void {
  if (depth > MAX_OBJECT_DEPTH) fail(`${spec.name} is nested too deeply`);
  if (Array.isArray(value)) {
    for (const item of value) out.push([`${prefix}[]`, primitiveToString(spec, item)]);
    return;
  }
  if (typeof value === "object" && value !== null) {
    for (const [key, item] of Object.entries(value)) {
      if (!OBJECT_KEY.test(key)) fail(`${spec.name} contains an invalid key: ${key.slice(0, 40)}`);
      flattenObject(`${prefix}[${key}]`, item, depth + 1, out, spec);
    }
    return;
  }
  out.push([prefix, primitiveToString(spec, value)]);
}

function queryEntries(spec: ParamSpec, value: unknown): Array<[string, string]> {
  switch (spec.type) {
    case "integer":
      if (typeof value === "number" && Number.isSafeInteger(value))
        return [[spec.name, String(value)]];
      if (typeof value === "string" && /^-?\d{1,15}$/.test(value)) return [[spec.name, value]];
      return fail(`${spec.name} must be an integer`);
    case "number":
      if (typeof value === "number" && Number.isFinite(value)) return [[spec.name, String(value)]];
      if (typeof value === "string" && /^-?\d{1,15}(\.\d{1,6})?$/.test(value)) {
        return [[spec.name, value]];
      }
      return fail(`${spec.name} must be a number`);
    case "boolean":
      if (typeof value === "boolean") return [[spec.name, String(value)]];
      if (value === "true" || value === "false") return [[spec.name, value]];
      return fail(`${spec.name} must be true or false`);
    case "string":
      return [[spec.name, primitiveToString(spec, value)]];
    case "array": {
      const items = Array.isArray(value) ? value : [value];
      return [[spec.name, items.map((item) => primitiveToString(spec, item)).join(",")]];
    }
    case "object": {
      if (typeof value !== "object" || value === null || Array.isArray(value)) {
        fail(`${spec.name} must be an object`);
      }
      const out: Array<[string, string]> = [];
      flattenObject(spec.name, value, 1, out, spec);
      return out;
    }
  }
}

/**
 * Builds the request path from the spec template and declared parameters
 * only, then checks that the result still points below the base URL.
 */
export function buildRequest(
  baseUrl: string,
  operationId: OperationId,
  params: Readonly<Record<string, unknown>> = {},
): BuiltRequest {
  const operation = OPERATIONS[operationId];
  const declared = new Map<string, ParamSpec>(operation.params.map((p) => [p.name, p]));
  for (const name of Object.keys(params)) {
    if (!declared.has(name)) fail(`${operationId} has no parameter ${name.slice(0, 60)}`);
  }

  const values: Record<string, unknown> = {};
  const appliedDefaults: Record<string, unknown> = {};
  for (const spec of operation.params) {
    let value = params[spec.name];
    const forced = FORCED_PARAMS[spec.name];
    if (forced !== undefined) {
      if (value !== undefined && value !== forced && value !== String(forced)) {
        fail(`${spec.name} is always ${forced} on this server`);
      }
      // Omitted means off for these flags; see FORCED_PARAMS.
      if (!forced) continue;
      value = forced;
    }
    if (value === undefined && spec.name === "limit" && spec.in === "query") {
      value = DEFAULT_LIMIT;
      appliedDefaults.limit = DEFAULT_LIMIT;
    }
    if (value === undefined || value === null) {
      if (spec.required) fail(`${operationId} needs the parameter ${spec.name}`);
      continue;
    }
    values[spec.name] = value;
  }

  let targetId: string | undefined;
  const path = operation.path.replace(/\{([^}]+)\}/g, (_match, name: string) => {
    const spec = declared.get(name);
    if (spec === undefined || spec.in !== "path")
      return fail(`template parameter ${name} is not declared`);
    const segment = pathValue(spec, values[name]);
    targetId ??= segment;
    return encodeURIComponent(segment);
  });

  const query = new URLSearchParams();
  for (const spec of operation.params) {
    if (spec.in !== "query" || values[spec.name] === undefined) continue;
    for (const [key, value] of queryEntries(spec, values[spec.name])) query.append(key, value);
  }
  const search = query.toString();
  const relative = search === "" ? path : `${path}?${search}`;

  // Defence in depth: the template is trusted and every value is encoded,
  // but the final URL is still checked against the base before it is used.
  const base = new URL(baseUrl);
  const url = new URL(`${baseUrl}${relative}`);
  const basePath = base.pathname.replace(/\/+$/, "");
  const segments = url.pathname.split("/").map((segment) => decodeURIComponent(segment));
  if (
    url.origin !== base.origin ||
    url.username !== "" ||
    url.password !== "" ||
    url.hash !== "" ||
    url.pathname !== `${basePath}${path}` ||
    segments.some((segment) => segment === "." || segment === "..") ||
    url.href.length > MAX_URL_LENGTH
  ) {
    fail(`${operationId}: the request URL failed validation`);
  }

  return { operationId, method: operation.method, path: relative, targetId, appliedDefaults };
}

const size = (value: unknown) => (JSON.stringify(value) ?? "null").length;

/**
 * Keeps answers within MAX_RESPONSE_CHARS. Lists are cut to as many objects
 * as fit; anything else that is too large is dropped with a hint.
 */
export function shapeResponse(data: unknown, maxChars = MAX_RESPONSE_CHARS): ToolOutput {
  const full = { data: data ?? null };
  if (size(full) <= maxChars) return full;

  const objects = (data as { objects?: unknown } | null)?.objects;
  if (Array.isArray(objects)) {
    const fits = (count: number) =>
      size({ data: { ...(data as object), objects: objects.slice(0, count) } }) <= maxChars - 400;
    let low = 0;
    let high = objects.length;
    while (low < high) {
      const mid = Math.ceil((low + high) / 2);
      if (fits(mid)) low = mid;
      else high = mid - 1;
    }
    return {
      data: { ...(data as object), objects: objects.slice(0, low) },
      truncated: true,
      note:
        `Cut to ${low} of ${objects.length} objects to stay under ${maxChars} characters. ` +
        "Use limit/offset or narrower filters for the rest.",
    };
  }
  return {
    data: null,
    truncated: true,
    note: `The response has ${size(data)} characters, more than the ${maxChars} allowed. Narrow the request.`,
  };
}

function failure(text: string): CallToolResult {
  return { isError: true, content: [{ type: "text", text }] };
}

type UntypedRequest = (
  method: string,
  path: string,
  init: { body?: unknown },
) => ReturnType<RegistrationEnv["deps"]["sevdesk"]["api"]["GET"]>;

/**
 * Registers sevdesk_api_request: one operation by operationId, only from
 * SEVDESK_API_ALLOW (default DEFAULT_API_ALLOW) and only up to the caller's
 * rights. W+/X operations go through the same guard as curated tools.
 * Returns false if there is nothing the caller may call.
 */
export function registerGenericTool(env: RegistrationEnv): boolean {
  const { server, policy, deps } = env;
  if (!isToolEnabled(policy.config, policy.rights, { name: GENERIC_TOOL_NAME, class: "R" })) {
    return false;
  }
  const allowList = policy.config.apiAllow ?? DEFAULT_API_ALLOW;
  const usable = allowList.filter((id): id is OperationId => {
    const operationClass = classOf(id);
    return operationClass !== undefined && allows(policy.rights, operationClass);
  });
  const [first, ...rest] = usable;
  if (first === undefined) return false;

  const classes = new Set<OperationClass>(usable.map((id) => classOf(id) as OperationClass));
  const readOnly = [...classes].every((c) => c === "R" || c === "R+");
  const confirm = classes.has("W+") || classes.has("X");

  const inputSchema = z.object({
    operationId: z.enum([first, ...rest]).describe("sevdesk operationId to call."),
    params: z
      .record(z.string(), z.unknown())
      .optional()
      .describe(
        'Path and query parameters by their name in the sevdesk API spec, e.g. {"invoiceId": 42}. ' +
          `Lists default to limit ${DEFAULT_LIMIT}.`,
      ),
    body: z
      .record(z.string(), z.unknown())
      .optional()
      .describe("JSON request body, only for operations that take one."),
    ...(confirm && {
      confirmation_token: z.string().max(2048).optional().describe(CONFIRMATION_TOKEN_DESCRIPTION),
    }),
  });

  server.registerTool(
    GENERIC_TOOL_NAME,
    {
      title: "sevdesk API request",
      description:
        "Fallback for sevdesk operations without a dedicated tool. Calls one operation by " +
        "operationId with its declared parameters; only operations the operator released are " +
        "accepted. Prefer the dedicated tools. Large answers are cut and say so.",
      inputSchema,
      annotations: {
        readOnlyHint: readOnly,
        destructiveHint: confirm,
        idempotentHint: readOnly,
        openWorldHint: true,
      },
    },
    async (input: z.infer<typeof inputSchema>, ctx: ServerContext) => {
      const operationId = input.operationId as OperationId;
      const operationClass = classOf(operationId);
      if (operationClass === undefined) return failure(`${operationId} is not classified.`);
      const operation = OPERATIONS[operationId];
      const params = input.params ?? {};
      if (input.body !== undefined && !operation.body) {
        return failure(`${operationId} takes no request body.`);
      }
      let built: BuiltRequest;
      try {
        built = buildRequest(policy.config.baseUrl, operationId, params);
      } catch (error) {
        if (error instanceof RequestBuildError) return failure(error.message);
        throw error;
      }
      const token = (input as { confirmation_token?: unknown }).confirmation_token;
      // Reads may be retried; anything with a side effect, even behind a
      // GET, gets exactly one attempt.
      const reading = operationClass === "R" || operationClass === "R+";
      const api = (reading ? deps.sevdesk.api : deps.sevdesk.apiSingleAttempt)
        .request as unknown as UntypedRequest;

      return runGuarded({ policy, server, logger: deps.logger }, ctx, {
        key: `${GENERIC_TOOL_NAME}:${operationId}`,
        tool: GENERIC_TOOL_NAME,
        operationId,
        class: operationClass,
        args: { operationId, params, body: input.body },
        confirmationToken: typeof token === "string" && token !== "" ? token : undefined,
        targetId: built.targetId,
        explicitlyAllowed: policy.config.apiAllow?.includes(operationId) ?? false,
        summary: `sevdesk ${operationId}: ${built.method} ${built.path}.`,
        preview: async () => ({
          operationId,
          class: operationClass,
          method: built.method,
          path: built.path,
          body: input.body ?? null,
        }),
        execute: async () => {
          const data = await deps.sevdesk.call(
            api(
              built.method.toLowerCase(),
              built.path,
              input.body === undefined ? {} : { body: input.body },
            ),
          );
          return {
            operationId,
            ...(Object.keys(built.appliedDefaults).length > 0 && {
              appliedDefaults: built.appliedDefaults,
            }),
            ...shapeResponse(data),
          };
        },
      });
    },
  );
  return true;
}
