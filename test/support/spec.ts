import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { classOf } from "../../src/policy/classification.js";
import { MOCK_BASE_URL } from "../helpers.js";

/**
 * Checks outgoing requests against the patched spec (after the overlay),
 * without extra dependencies: the path must name a declared operation,
 * every query key must be declared, required ones present, and values must
 * fit the declared type and enum. Catches tools sending parameters sevdesk
 * does not document.
 */

interface Schema {
  type?: string;
  format?: string;
  enum?: unknown[];
  properties?: Record<string, Schema>;
  items?: Schema;
}

interface Parameter {
  name: string;
  in: string;
  required?: boolean;
  schema?: Schema;
}

interface Operation {
  operationId: string;
  parameters?: Array<Parameter | { $ref: string }>;
}

interface Spec {
  paths: Record<string, Record<string, Operation>>;
  components: { parameters?: Record<string, Parameter> };
}

const SPEC = JSON.parse(
  readFileSync(
    fileURLToPath(new URL("../../src/generated/sevdesk.openapi.json", import.meta.url)),
    "utf8",
  ),
) as Spec;

const ROUTES = Object.entries(SPEC.paths)
  .flatMap(([path, methods]) =>
    Object.entries(methods).map(([method, operation]) => ({
      method: method.toUpperCase(),
      operation,
      literal: !path.includes("{"),
      pattern: new RegExp(
        `^${path
          .split(/\{[^}]+\}/)
          .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
          .join("[^/]+")}$`,
      ),
    })),
  )
  .sort((a, b) => Number(b.literal) - Number(a.literal));

function parametersOf(operation: Operation): Parameter[] {
  return (operation.parameters ?? []).map((p) =>
    "$ref" in p ? (SPEC.components.parameters?.[p.$ref.split("/").pop() ?? ""] as Parameter) : p,
  );
}

const DATE_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/;

function checkValue(name: string, value: string, schema: Schema | undefined): string | undefined {
  if (schema === undefined) return undefined;
  switch (schema.type) {
    case "integer":
      if (!/^-?\d+$/.test(value)) return `${name}=${value} is not an integer`;
      break;
    case "number":
      if (!/^-?\d+(\.\d+)?$/.test(value)) return `${name}=${value} is not a number`;
      break;
    case "boolean":
      if (value !== "true" && value !== "false") return `${name}=${value} is not a boolean`;
      break;
    default:
      break;
  }
  // Offsets as +01:00 or Z; sevdesk documents ISO 8601 for date-time.
  if (schema.format === "date-time" && !DATE_TIME.test(value)) {
    return `${name}=${value} is not an ISO 8601 date-time with offset`;
  }
  if (schema.format === "date" && !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    return `${name}=${value} is not a date (YYYY-MM-DD)`;
  }
  if (schema.enum && !schema.enum.map(String).includes(value)) {
    return `${name}=${value} is not one of ${schema.enum.join(", ")}`;
  }
  return undefined;
}

/** Schema of a nested query key like sevQuery[filter][contact][id]. */
function nestedSchema(root: Schema | undefined, path: string[]): Schema | undefined {
  let current = root;
  for (const key of path) {
    current = current?.type === "array" || key === "" ? current?.items : current?.properties?.[key];
    if (current === undefined) return undefined;
  }
  return current;
}

function routeOf(request: Request) {
  const url = new URL(request.url);
  const base = new URL(MOCK_BASE_URL).pathname;
  if (!url.pathname.startsWith(`${base}/`)) return undefined;
  const path = url.pathname.slice(base.length);
  return ROUTES.find((r) => r.method === request.method && r.pattern.test(path));
}

/** Problems of one request; empty when it fits the spec. */
export function specProblems(request: Request): string[] {
  const url = new URL(request.url);
  const route = routeOf(request);
  if (route === undefined) return [`${request.method} ${url.pathname} is not in the spec`];

  const problems: string[] = [];
  const params = parametersOf(route.operation).filter((p) => p.in === "query");
  const byName = new Map(params.map((p) => [p.name, p]));
  const seen = new Set<string>();
  for (const [key, value] of url.searchParams) {
    const direct = byName.get(key);
    if (direct) {
      seen.add(key);
      const problem = checkValue(key, value, direct.schema);
      if (problem) problems.push(problem);
      continue;
    }
    // Object parameter sent as key[a][b]=value.
    const match = /^([^[]+)((?:\[[^\]]*\])+)$/.exec(key);
    const root = match ? byName.get(match[1] as string) : undefined;
    if (match && root?.schema?.type === "object") {
      seen.add(root.name);
      const nested = [...(match[2] as string).matchAll(/\[([^\]]*)\]/g)].map((m) => m[1] as string);
      const schema = nestedSchema(root.schema, nested);
      const problem =
        schema === undefined
          ? `${key} is not declared in ${root.name}`
          : checkValue(key, value, schema);
      if (problem) problems.push(problem);
      continue;
    }
    problems.push(`${route.operation.operationId} does not declare query parameter ${key}`);
  }
  for (const param of params) {
    if (param.required && !seen.has(param.name)) {
      problems.push(`${route.operation.operationId} requires query parameter ${param.name}`);
    }
  }
  return problems;
}

/** operationId a request targets, or undefined. */
export function operationOf(request: Request): string | undefined {
  return routeOf(request)?.operation.operationId;
}

/**
 * The read tools may only read: every request must be a GET on an
 * operation of class R. A tool that slipped onto a writing, exporting or
 * status-changing endpoint fails here, whatever its own annotations say.
 */
export function readOnlyProblems(request: Request): string[] {
  const operationId = operationOf(request);
  const problems: string[] = [];
  if (request.method !== "GET") problems.push(`${request.method} ${request.url} is not a GET`);
  if (operationId !== undefined && classOf(operationId) !== "R") {
    problems.push(`${operationId} is class ${classOf(operationId) ?? "unclassified"}, not R`);
  }
  return problems;
}
