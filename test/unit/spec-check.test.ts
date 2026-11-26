import { describe, expect, it } from "vitest";
import { MOCK_BASE_URL } from "../helpers.js";
import { operationOf, readOnlyProblems, specProblems } from "../support/spec.js";

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
    expect(specProblems(get("/CheckAccountTransaction?startDate=2026-01-01"))).toEqual([
      "startDate=2026-01-01 is not an ISO 8601 date-time with offset",
    ]);
    expect(
      specProblems(get("/CheckAccountTransaction?startDate=2026-01-01T00%3A00%3A00%2B01%3A00")),
    ).toEqual([]);
    expect(specProblems(get("/CheckAccount/1/getBalanceAtDate?date=01.01.2026"))).toEqual([
      "date=01.01.2026 is not a date (YYYY-MM-DD)",
    ]);
    expect(specProblems(get("/Report/contactlist?sevQuery%5Bfilter%5D%5Bbogus%5D=1"))).toEqual([
      "sevQuery[filter][bogus] is not declared in sevQuery",
    ]);
  });

  it("allows read tools only GET requests on class R operations", () => {
    expect(readOnlyProblems(get("/Invoice"))).toEqual([]);
    expect(readOnlyProblems(get("/Invoice/1/getPdf"))).toEqual([]);
    expect(readOnlyProblems(get("/Export/datevCSV"))).toEqual([
      "exportDatevDepricated is class R+, not R",
    ]);
    expect(
      readOnlyProblems(new Request(`${MOCK_BASE_URL}/Contact`, { method: "POST", body: "{}" })),
    ).toEqual([`POST ${MOCK_BASE_URL}/Contact is not a GET`, "createContact is class W, not R"]);
  });
});
