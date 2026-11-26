import { describe, expect, it } from "vitest";
import { MOCK_BASE_URL } from "../helpers.js";
import { operationOf, specProblems } from "../support/spec.js";

const get = (path: string) => new Request(`${MOCK_BASE_URL}${path}`);

// The protocol tests rely on this check; make sure it actually rejects.
describe("spec check of outgoing requests", () => {
  it("accepts declared parameters with fitting values", () => {
    expect(
      specProblems(get("/Invoice?status=750&contact%5Bid%5D=1&limit=5&countAll=true")),
    ).toEqual([]);
    expect(
      specProblems(
        get(
          "/Report/invoicelist?view=all&sevQuery%5BmodelName%5D=Invoice&sevQuery%5BobjectName%5D=SevQuery&sevQuery%5Bfilter%5D%5Bcontact%5D%5Bid%5D=3",
        ),
      ),
    ).toEqual([]);
    expect(operationOf(get("/Contact/Factory/getNextCustomerNumber"))).toBe(
      "getNextCustomerNumber",
    );
  });

  it("flags unknown paths, undeclared keys, wrong types, enums and missing required keys", () => {
    expect(specProblems(get("/Nope"))).toEqual(["GET /api/v1/Nope is not in the spec"]);
    expect(specProblems(get("/Contact?name=x"))).toEqual([
      "getContacts does not declare query parameter name",
    ]);
    expect(specProblems(get("/Invoice?status=300"))).toEqual([
      "status=300 is not one of 50, 100, 200, 750, 1000",
    ]);
    expect(specProblems(get("/Invoice?limit=abc"))).toEqual(["limit=abc is not an integer"]);
    expect(specProblems(get("/Invoice?countAll=1"))).toEqual(["countAll=1 is not a boolean"]);
    expect(specProblems(get("/ReceiptGuidance/forAccountNumber"))).toEqual([
      "forAccountNumber requires query parameter accountNumber",
    ]);
    expect(specProblems(get("/Report/contactlist?sevQuery%5Bfilter%5D%5Bbogus%5D=1"))).toEqual([
      "sevQuery[filter][bogus] is not declared in sevQuery",
    ]);
  });
});
