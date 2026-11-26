import { describe, expect, it } from "vitest";
import { MAX_FILE_BYTES } from "../../../src/tools/documents.js";
import { PDF_BYTES, pdfDocument } from "../../fixtures/sevdesk.js";
import {
  connect,
  expectHttpErrors,
  HttpResponse,
  http,
  mockSevdesk,
  pathOf,
  queryOf,
  sevdeskUrl,
  structured,
  textOf,
} from "../../support/harness.js";

const api = mockSevdesk();

type Content = Array<{
  type: string;
  text?: string;
  resource?: { uri: string; mimeType: string; blob: string };
}>;

describe("get_document_pdf", () => {
  it.each([
    ["invoice", "/Invoice/1001/getPdf"],
    ["credit_note", "/CreditNote/1001/getPdf"],
    ["order", "/Order/1001/getPdf"],
  ])(
    "fetches the %s PDF with preventSendBy=true as an embedded resource",
    async (documentType, path) => {
      api.server.use(http.get(sevdeskUrl(path), () => HttpResponse.json(pdfDocument())));
      const c = await connect();
      const result = await c.call("get_document_pdf", { documentType, documentId: 1001 });
      const data = structured(result);
      expect(api.requests.map(pathOf)).toEqual([path]);
      expect(queryOf(api.requests[0])).toEqual({ preventSendBy: "true" });
      expect(data).toEqual({
        documentType,
        documentId: 1001,
        filename: "RE-1001.pdf",
        mimeType: "application/pdf",
        sizeBytes: PDF_BYTES.byteLength,
        resourceUri: `sevdesk://${documentType}/1001/pdf`,
      });
      const content = result.content as Content;
      expect(content[1]).toEqual({
        type: "resource",
        resource: {
          uri: `sevdesk://${documentType}/1001/pdf`,
          mimeType: "application/pdf",
          blob: PDF_BYTES.toString("base64"),
        },
      });
      // The text stays short: the file travels only in the resource.
      expect(textOf(result)).not.toContain(PDF_BYTES.toString("base64"));
    },
  );

  it("accepts the wrapped shape with lower-case keys and raw content", async () => {
    api.server.use(
      http.get(sevdeskUrl("/Invoice/5/getPdf"), () =>
        HttpResponse.json({
          objects: {
            filename: "x.pdf",
            mimetype: "application/pdf",
            base64Encoded: false,
            content: PDF_BYTES.toString("latin1"),
          },
        }),
      ),
    );
    const c = await connect();
    const result = await c.call("get_document_pdf", { documentType: "invoice", documentId: 5 });
    expect(structured(result)).toMatchObject({
      filename: "x.pdf",
      sizeBytes: PDF_BYTES.byteLength,
    });
    expect((result.content as Content)[1]?.resource?.blob).toBe(PDF_BYTES.toString("base64"));
  });

  it("refuses files over the size limit, broken base64 and empty answers", async () => {
    const big = Buffer.alloc(MAX_FILE_BYTES + 1, 0x41).toString("base64");
    api.server.use(
      http.get(sevdeskUrl("/Invoice/1/getPdf"), () =>
        HttpResponse.json(pdfDocument({ content: big })),
      ),
      http.get(sevdeskUrl("/Invoice/2/getPdf"), () =>
        HttpResponse.json(pdfDocument({ content: "not base64!" })),
      ),
      http.get(sevdeskUrl("/Invoice/3/getPdf"), () => HttpResponse.json({ objects: null })),
    );
    const c = await connect();
    const tooBig = await c.call("get_document_pdf", { documentType: "invoice", documentId: 1 });
    expect(tooBig.isError).toBe(true);
    expect(textOf(tooBig)).toContain(`more than the ${MAX_FILE_BYTES}`);
    expect(
      textOf(await c.call("get_document_pdf", { documentType: "invoice", documentId: 2 })),
    ).toContain("not valid base64");
    expect(
      textOf(await c.call("get_document_pdf", { documentType: "invoice", documentId: 3 })),
    ).toContain("without file content");
  });

  it("reports 401, 404 and 429 as tool errors", async () => {
    await expectHttpErrors(api, "get", "/Order/4/getPdf", "get_document_pdf", {
      documentType: "order",
      documentId: 4,
    });
  });
});

describe("get_report", () => {
  const report = () =>
    HttpResponse.json({
      objects: {
        filename: "invoice.pdf",
        mimetype: "application/pdf",
        base64Encoded: true,
        content: PDF_BYTES.toString("base64"),
      },
    });

  it("builds the nested sevQuery and returns the file", async () => {
    api.server.use(http.get(sevdeskUrl("/Report/invoicelist"), report));
    const c = await connect();
    const result = await c.call("get_report", {
      report: "invoices",
      startDate: "2026-01-01",
      endDate: "2026-01-31",
      contactId: 2001,
    });
    expect(queryOf(api.requests[0])).toEqual({
      view: "all",
      "sevQuery[modelName]": "Invoice",
      "sevQuery[objectName]": "SevQuery",
      "sevQuery[filter][startDate]": "2026-01-01T00:00:00+01:00",
      "sevQuery[filter][endDate]": "2026-01-31T23:59:59+01:00",
      "sevQuery[filter][contact][id]": "2001",
      "sevQuery[filter][contact][objectName]": "Contact",
    });
    expect(structured(result)).toEqual({
      report: "invoices",
      filename: "invoice.pdf",
      mimeType: "application/pdf",
      sizeBytes: PDF_BYTES.byteLength,
      resourceUri: "sevdesk://report/invoices",
    });
    expect((result.content as Content)[1]?.type).toBe("resource");
  });

  it("covers orders with type, contacts and vouchers", async () => {
    for (const path of ["orderlist", "contactlist", "voucherlist"]) {
      api.server.use(http.get(sevdeskUrl(`/Report/${path}`), report));
    }
    const c = await connect();
    structured(await c.call("get_report", { report: "orders", orderType: "AB" }));
    structured(await c.call("get_report", { report: "contacts" }));
    structured(await c.call("get_report", { report: "vouchers" }));
    expect(api.requests.map(queryOf)).toEqual([
      {
        view: "all",
        "sevQuery[modelName]": "Order",
        "sevQuery[objectName]": "SevQuery",
        "sevQuery[filter][orderType]": "AB",
      },
      { "sevQuery[modelName]": "Contact", "sevQuery[objectName]": "SevQuery" },
      { "sevQuery[modelName]": "Voucher", "sevQuery[objectName]": "SevQuery" },
    ]);
  });

  it("rejects filters a report does not take", async () => {
    const c = await connect();
    expect(textOf(await c.call("get_report", { report: "contacts", contactId: 1 }))).toContain(
      "takes no date range or contactId",
    );
    expect(textOf(await c.call("get_report", { report: "invoices", orderType: "AN" }))).toContain(
      "orders report only",
    );
    expect(api.requests).toEqual([]);
  });

  it("reports 401, 404 and 429 as tool errors", async () => {
    await expectHttpErrors(api, "get", "/Report/voucherlist", "get_report", { report: "vouchers" });
  });
});
