import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { CLASSIFICATION, classOf, OPERATION_CLASSES } from "../../src/policy/classification.js";
import { OPERATIONS } from "../../src/policy/operations.js";

// Loads the spec as `npm run gen` produced it (after openapi/overlay.yaml)
// and fails on any drift between it and the committed policy data.

interface SpecParam {
  $ref?: string;
  name?: string;
  in?: string;
  required?: boolean;
  schema?: { type?: string };
}
interface SpecOperation {
  operationId: string;
  parameters?: SpecParam[];
  requestBody?: unknown;
}
const spec = JSON.parse(
  readFileSync(new URL("../../src/generated/sevdesk.openapi.json", import.meta.url), "utf8"),
) as {
  paths: Record<string, Record<string, SpecOperation>>;
  components: { parameters: Record<string, SpecParam> };
};

const METHODS = ["get", "put", "post", "delete", "patch"];
const specOps = Object.entries(spec.paths).flatMap(([path, item]) =>
  Object.entries(item)
    .filter(([method]) => METHODS.includes(method))
    .map(([method, op]) => ({ path, method: method.toUpperCase(), op })),
);
const resolve = (p: SpecParam) =>
  p.$ref ? (spec.components.parameters[p.$ref.split("/").pop() ?? ""] as SpecParam) : p;

describe("classification against the spec", () => {
  it("covers the spec", () => {
    expect(specOps.length).toBeGreaterThan(150);
  });

  it("classifies every operationId of the spec", () => {
    const missing = specOps.map((s) => s.op.operationId).filter((id) => classOf(id) === undefined);
    expect(missing).toEqual([]);
  });

  it("has no class for an operationId the spec does not have", () => {
    const ids = new Set(specOps.map((s) => s.op.operationId));
    expect(Object.keys(CLASSIFICATION).filter((id) => !ids.has(id))).toEqual([]);
    expect(Object.keys(OPERATIONS).filter((id) => !ids.has(id))).toEqual([]);
  });

  it("uses only known classes", () => {
    for (const value of Object.values(CLASSIFICATION)) expect(OPERATION_CLASSES).toContain(value);
  });

  it("matches method, path, body and parameters of every operation", () => {
    for (const { path, method, op } of specOps) {
      const committed = OPERATIONS[op.operationId as keyof typeof OPERATIONS];
      expect({ id: op.operationId, method: committed.method, path: committed.path }).toEqual({
        id: op.operationId,
        method,
        path,
      });
      expect(committed.body, op.operationId).toBe(op.requestBody !== undefined);
      expect(committed.params, op.operationId).toEqual(
        (op.parameters ?? []).map(resolve).map((p) => ({
          name: p.name,
          in: p.in,
          type: p.schema?.type,
          required: p.required === true,
        })),
      );
    }
  });

  it("denies anything unclassified", () => {
    expect(classOf("dropDatabase")).toBeUndefined();
    expect(classOf("__proto__")).toBeUndefined();
    expect(classOf("toString")).toBeUndefined();
  });
});

describe("classification follows the table in the analysis", () => {
  const where = (predicate: (s: (typeof specOps)[number]) => boolean) =>
    specOps.filter(predicate).map((s) => [s.op.operationId, classOf(s.op.operationId)]);

  it("puts all 13 DELETE operations into X", () => {
    const deletes = where((s) => s.method === "DELETE");
    expect(deletes).toHaveLength(13);
    for (const [, cls] of deletes) expect(cls).toBe("X");
  });

  it.each([
    ["enshrine", "/enshrine", "X", 4],
    ["sendViaEmail", "/sendViaEmail", "X", 3],
    ["cancelInvoice", "/cancelInvoice", "X", 1],
    ["sendBy", "/sendBy", "W+", 3],
    ["resetToDraft", "/resetToDraft", "W+", 3],
    ["resetToOpen", "/resetToOpen", "W+", 3],
    ["bookAmount", "/bookAmount", "W+", 3],
    ["sendByWithRender", "/sendByWithRender", "W+", 1],
    ["getPdf (preventSendBy forced)", "/getPdf", "R", 3],
  ])("%s", (_label, suffix, expected, count) => {
    const ops = where((s) => s.path.endsWith(suffix));
    expect(ops).toHaveLength(count);
    for (const [, cls] of ops) expect(cls).toBe(expected);
  });

  it("puts Export GETs into R+, except the DATEV job starters (W)", () => {
    for (const [id, cls] of where((s) => s.method === "GET" && s.path.startsWith("/Export/"))) {
      expect(cls, String(id)).toBe(
        String(id).startsWith("exportDatev") && id !== "exportDatevDepricated" ? "W" : "R+",
      );
    }
  });

  it("never puts a non-GET into a reading class", () => {
    for (const [id, cls] of where((s) => s.method !== "GET")) {
      expect(["R", "R+"], String(id)).not.toContain(cls);
    }
  });
});
