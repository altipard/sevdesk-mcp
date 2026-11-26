import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// Checks the spec that `npm run gen` produced from openapi/overlay.yaml.
// The typed calls in client.test.ts cover the same at compile time.

interface Operation {
  parameters?: Array<{ $ref?: string; name?: string }>;
  responses: Record<string, { $ref?: string }>;
}

const spec = JSON.parse(
  readFileSync(new URL("../../src/generated/sevdesk.openapi.json", import.meta.url), "utf8"),
) as { paths: Record<string, { get: Operation }> };

const ref = (kind: string, name: string) => `#/components/${kind}/${name}`;
const refs = (operation: Operation) => (operation.parameters ?? []).map((p) => p.$ref);

const resources: Array<[list: string, single: string]> = [
  ["/Contact", "/Contact/{contactId}"],
  ["/Invoice", "/Invoice/{invoiceId}"],
  ["/Order", "/Order/{orderId}"],
  ["/Voucher", "/Voucher/{voucherId}"],
  ["/CheckAccount", "/CheckAccount/{checkAccountId}"],
  ["/CheckAccountTransaction", "/CheckAccountTransaction/{checkAccountTransactionId}"],
  ["/Part", "/Part/{partId}"],
];

describe.each(resources)("overlay for %s", (list, single) => {
  it("adds pagination and embed to the list endpoint", () => {
    const operation = spec.paths[list]?.get as Operation;
    expect(refs(operation)).toEqual(
      expect.arrayContaining(
        ["limit", "offset", "countAll", "embed"].map((name) => ref("parameters", name)),
      ),
    );
  });

  it("adds embed to the single-object endpoint", () => {
    expect(refs(spec.paths[single]?.get as Operation)).toContain(ref("parameters", "embed"));
  });

  it("declares error responses with a body, including 429", () => {
    const listResponses = spec.paths[list]?.get.responses ?? {};
    const singleResponses = spec.paths[single]?.get.responses ?? {};
    expect(listResponses["429"]).toEqual({ $ref: ref("responses", "TooManyRequests") });
    expect(listResponses["400"]).toEqual({ $ref: ref("responses", "BadRequest") });
    expect(singleResponses["404"]).toEqual({ $ref: ref("responses", "NotFound") });
    expect(singleResponses["500"]).toEqual({ $ref: ref("responses", "ServerError") });
  });
});
