import { describe, expect, it } from "vitest";
import { unixSeconds } from "../../../src/tools/format.js";
import { MAX_VOUCHER_FILE_BYTES } from "../../../src/tools/voucher-writes.js";
import { checkAccount, contact, list, PDF_BYTES, voucher } from "../../fixtures/sevdesk.js";
import {
  HttpResponse,
  http,
  sevdeskError,
  sevdeskUrl,
  structured,
  textOf,
} from "../../support/harness.js";
import {
  bodyOf,
  connectWrites,
  mockSevdeskWrites,
  operations,
  previewOf,
  type WriteConnection,
} from "../../support/write-harness.js";

const api = mockSevdeskWrites();

const writes = () => api.requests.filter((request) => request.method !== "GET");

const PNG_BYTES = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]);
const GIF_BYTES = Buffer.from("GIF89a....", "latin1");

const expenseGuide = (rates = ["ZERO", "SEVEN", "NINETEEN"]) => ({
  accountDatevId: 6815,
  accountNumber: "6815",
  accountName: "Bürobedarf",
  description: "Büromaterial",
  allowedTaxRules: [
    { id: 9, name: "VORST_ABZUGSF_AUFW", description: "Vorsteuer", taxRates: rates },
    {
      id: 10,
      name: "NICHT_VORST_ABZUGSF_AUFW",
      description: "keine Vorsteuer",
      taxRates: ["ZERO"],
    },
  ],
  allowedReceiptTypes: ["EXPENSE"],
});

const readSupplier = http.get(sevdeskUrl("/Contact/2003"), () =>
  HttpResponse.json(list([contact({ id: "2003", name: "Bürobedarf Beispiel KG" })])),
);
const guidance = (guide = expenseGuide()) =>
  http.get(sevdeskUrl("/ReceiptGuidance/forExpense"), () =>
    HttpResponse.json({ objects: [guide] }),
  );

type Received = Array<{ name: string; type: string; bytes: Buffer }>;

/** Upload handler recording the received file. */
function uploadHandler(received: Received) {
  return http.post(sevdeskUrl("/Voucher/Factory/uploadTempFile"), async ({ request }) => {
    const form = await request.formData();
    const file = form.get("file") as File;
    received.push({
      name: file.name,
      type: file.type,
      bytes: Buffer.from(await file.arrayBuffer()),
    });
    return HttpResponse.json(
      {
        objects: { filename: "f019bec36c65f5a0e7d2c63cc33f0681.pdf", mimeType: "application/pdf" },
      },
      { status: 201 },
    );
  });
}

const saved = (overrides: Record<string, unknown> = {}) =>
  http.post(sevdeskUrl("/Voucher/Factory/saveVoucher"), () =>
    HttpResponse.json(
      {
        objects: {
          voucher: voucher({
            id: "8101",
            status: "50",
            description: "RE-4711",
            sumNet: "100.84",
            sumGross: "120",
            document: { id: "77", objectName: "Document" },
            ...overrides,
          }),
          voucherPos: [],
        },
      },
      { status: 201 },
    ),
  );

const base = {
  voucherDate: "2026-03-01",
  description: "RE-4711",
  supplierId: 2003,
  taxRule: 9,
  positions: [
    { accountDatevId: 6815, taxRate: 19, amount: 100, comment: "Papier" },
    { accountDatevId: 6815, taxRate: 7, amount: 20 },
  ],
};
const pdfFile = {
  content: PDF_BYTES.toString("base64"),
  filename: "rechnung-4711.pdf",
  mimeType: "application/pdf",
};

describe("create_voucher (W)", () => {
  it("checks tax and accounts, uploads the file and saves a draft voucher with it", async () => {
    const received: Received = [];
    api.server.use(readSupplier, guidance(), uploadHandler(received), saved());
    const c = await connectWrites({ config: { mode: "write" } });
    const result = await c.call("create_voucher", { ...base, file: pdfFile });
    expect(result.isError, textOf(result)).toBeFalsy();
    expect(operations(api)).toEqual([
      "GET getContactById",
      "GET forExpense",
      "POST voucherUploadFile",
      "POST voucherFactorySaveVoucher",
    ]);
    expect(received).toEqual([
      { name: "rechnung-4711.pdf", type: "application/pdf", bytes: PDF_BYTES },
    ]);
    expect(await bodyOf(api, "voucherFactorySaveVoucher")).toEqual({
      voucher: {
        objectName: "Voucher",
        mapAll: true,
        voucherDate: "01.03.2026",
        deliveryDate: "01.03.2026",
        supplier: { id: 2003, objectName: "Contact" },
        description: "RE-4711",
        status: 50,
        taxRule: { id: 9, objectName: "TaxRule" },
        creditDebit: "D",
        voucherType: "VOU",
      },
      voucherPosSave: [
        {
          objectName: "VoucherPos",
          mapAll: true,
          accountDatev: { id: 6815, objectName: "AccountDatev" },
          taxRate: 19,
          net: false,
          sumGross: 100,
          comment: "Papier",
        },
        {
          objectName: "VoucherPos",
          mapAll: true,
          accountDatev: { id: 6815, objectName: "AccountDatev" },
          taxRate: 7,
          net: false,
          sumGross: 20,
        },
      ],
      voucherPosDelete: null,
      filename: "f019bec36c65f5a0e7d2c63cc33f0681.pdf",
    });
    expect(structured(result)).toEqual({
      voucher: {
        id: 8101,
        description: "RE-4711",
        status: 50,
        statusName: "draft",
        creditDebit: "D",
        voucherDate: "2026-03-01",
        supplierId: 2003,
        supplierName: "Bürobedarf Beispiel KG",
        currency: "EUR",
        sumNet: 100.84,
        sumGross: 120,
        hasDocument: true,
      },
      taxRule: { id: 9, name: "Vorsteuerabziehbare Aufwendungen", checkedAgainst: "guidance" },
      positions: 2,
      amountsAre: "gross",
      expectedSum: 120,
      file: {
        filename: "rechnung-4711.pdf",
        mimeType: "application/pdf",
        bytes: PDF_BYTES.length,
        sevdeskFilename: "f019bec36c65f5a0e7d2c63cc33f0681.pdf",
      },
      warnings: [],
    });
    expect(textOf(result).split("\n")[0]).toBe(
      "Created voucher draft 8101 (expense): 2 positions, gross 120 EUR, tax rule 9, file attached.",
    );
    expect(c.audit()).toEqual([
      expect.objectContaining({ tool: "create_voucher", class: "W", outcome: "ok" }),
    ]);
  });

  it("creates an income voucher with net amounts and no file, checked against revenue guidance", async () => {
    api.server.use(
      http.get(sevdeskUrl("/ReceiptGuidance/forRevenue"), () =>
        HttpResponse.json({
          objects: [{ accountDatevId: 4400, allowedTaxRules: [{ id: 1, taxRates: ["NINETEEN"] }] }],
        }),
      ),
      saved({ sumNet: "50", sumGross: "59.5", creditDebit: "C", document: null }),
    );
    const c = await connectWrites({ config: { mode: "write" } });
    const result = await c.call("create_voucher", {
      creditDebit: "C",
      voucherDate: "2026-03-02",
      supplierName: "Laufkundschaft",
      taxRule: 1,
      amountsAre: "net",
      positions: [{ accountDatevId: 4400, taxRate: 19, amount: 50 }],
    });
    expect(result.isError, textOf(result)).toBeFalsy();
    expect(operations(api)).toEqual(["GET forRevenue", "POST voucherFactorySaveVoucher"]);
    const body = (await bodyOf(api, "voucherFactorySaveVoucher")) as {
      voucher: Record<string, unknown>;
      voucherPosSave: Array<Record<string, unknown>>;
    };
    expect(body.voucher).toMatchObject({ supplierName: "Laufkundschaft", creditDebit: "C" });
    expect(body.voucher).not.toHaveProperty("supplier");
    expect(body.voucherPosSave[0]).toMatchObject({ net: true, sumNet: 50 });
    expect(body).not.toHaveProperty("filename");
    expect(structured(result)).toMatchObject({ file: null, amountsAre: "net", warnings: [] });
  });

  it("is not registered in read mode", async () => {
    const c = await connectWrites({ config: { mode: "read" } });
    const names = (await c.client.listTools()).tools.map((t) => t.name);
    expect(names).not.toContain("create_voucher");
  });

  const tooBig = Buffer.alloc(MAX_VOUCHER_FILE_BYTES + 1, 0x20);
  PDF_BYTES.copy(tooBig);
  // "JVBERi0=" decodes to "%PDF-"; "JVBERi1=" decodes to the same bytes
  // with stray padding bits, which Buffer.from accepts silently.
  const BAD_FILES: Array<[string, Record<string, unknown>, string]> = [
    [
      "an unsupported type",
      { mimeType: "image/gif", content: GIF_BYTES.toString("base64"), filename: "a.gif" },
      "mimeType",
    ],
    [
      "content that is not the declared type",
      { content: GIF_BYTES.toString("base64") },
      "is not a application/pdf file",
    ],
    [
      "a PNG declared as PDF",
      { content: PNG_BYTES.toString("base64") },
      "is not a application/pdf file",
    ],
    ["an extension that does not fit", { filename: "rechnung.png" }, "must end with .pdf"],
    ["characters outside base64", { content: "JVBER$i0" }, "not valid base64"],
    ["a length that is no multiple of 4", { content: "JVBERi0xL" }, "not valid base64"],
    [
      "a data: prefix",
      { content: `data:application/pdf;base64,${pdfFile.content}` },
      "not valid base64",
    ],
    [
      "line breaks",
      { content: `${pdfFile.content.slice(0, 8)}\n${pdfFile.content.slice(8)}` },
      "not valid base64",
    ],
    ["non-canonical padding bits", { content: "JVBERi1=" }, "not canonical base64"],
    [
      "a file over the limit",
      { content: tooBig.toString("base64") },
      `at most ${MAX_VOUCHER_FILE_BYTES} (2.5 MiB)`,
    ],
    ["a path in the file name", { filename: "../etc/rechnung.pdf" }, "plain file name"],
  ];

  it.each(BAD_FILES)("refuses %s before anything is sent", async (_label, change, message) => {
    api.server.use(readSupplier, guidance(), uploadHandler([]), saved());
    const c = await connectWrites({ config: { mode: "write" } });
    const result = await c.call("create_voucher", { ...base, file: { ...pdfFile, ...change } });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain(message);
    expect(api.requests).toHaveLength(0);
  });

  it("keeps a file at the limit, as base64 in a JSON-RPC message, below 4 MiB", () => {
    const content = Buffer.alloc(MAX_VOUCHER_FILE_BYTES).toString("base64");
    const message = JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: "create_voucher", arguments: { ...base, file: { ...pdfFile, content } } },
    });
    expect(message.length).toBeLessThan(4 * 1024 * 1024 - 256 * 1024);
  });

  it("accepts a file of exactly the limit", async () => {
    const atLimit = Buffer.alloc(MAX_VOUCHER_FILE_BYTES, 0x20);
    PDF_BYTES.copy(atLimit);
    PDF_BYTES.copy(atLimit, atLimit.length - PDF_BYTES.length);
    api.server.use(readSupplier, guidance(), uploadHandler([]), saved());
    const c = await connectWrites({ config: { mode: "write" } });
    const result = await c.call("create_voucher", {
      ...base,
      file: { ...pdfFile, content: atLimit.toString("base64") },
    });
    expect(result.isError, textOf(result)).toBeFalsy();
  });

  it("finds the PDF header within the first 1024 bytes, not further", async () => {
    const received: Received = [];
    api.server.use(readSupplier, guidance(), uploadHandler(received), saved());
    const c = await connectWrites({ config: { mode: "write" } });
    const late = (offset: number) =>
      Buffer.concat([Buffer.alloc(offset, 0x0a), PDF_BYTES]).toString("base64");
    const near = await c.call("create_voucher", {
      ...base,
      file: { ...pdfFile, content: late(1000) },
    });
    expect(near.isError, textOf(near)).toBeFalsy();
    const far = await c.call("create_voucher", {
      ...base,
      file: { ...pdfFile, content: late(1024) },
    });
    expect(textOf(far)).toContain("is not a application/pdf file");
    expect(received).toHaveLength(1);
  });

  it("refuses a polyglot with %PDF- in a preamble but no %%EOF at the end", async () => {
    api.server.use(readSupplier, guidance(), uploadHandler([]), saved());
    const c = await connectWrites({ config: { mode: "write" } });
    const polyglot = Buffer.concat([
      Buffer.from("%PDF-1.4\n", "latin1"),
      Buffer.alloc(2048, 0x41),
      Buffer.from("<html><script>x()</script></html>\n", "latin1"),
    ]);
    const result = await c.call("create_voucher", {
      ...base,
      file: { ...pdfFile, content: polyglot.toString("base64") },
    });
    expect(textOf(result)).toContain("is not a application/pdf file");
    expect(api.requests).toHaveLength(0);
  });

  it("refuses a PDF whose %%EOF lies before the last 1024 bytes", async () => {
    const c = await connectWrites({ config: { mode: "write" } });
    const trailing = Buffer.concat([PDF_BYTES, Buffer.alloc(1024, 0x20)]);
    const result = await c.call("create_voucher", {
      ...base,
      file: { ...pdfFile, content: trailing.toString("base64") },
    });
    expect(textOf(result)).toContain("is not a application/pdf file");
    expect(api.requests).toHaveLength(0);
  });

  it("accepts canonical padding of both lengths", async () => {
    api.server.use(readSupplier, guidance(), uploadHandler([]), saved());
    const c = await connectWrites({ config: { mode: "write" } });
    for (const extra of ["A", "AB"]) {
      const content = Buffer.concat([PDF_BYTES, Buffer.from(extra)]).toString("base64");
      const result = await c.call("create_voucher", { ...base, file: { ...pdfFile, content } });
      expect(result.isError, `${content}: ${textOf(result)}`).toBeFalsy();
    }
  });

  it("refuses base64 longer than any file within the limit in the schema", async () => {
    const c = await connectWrites({ config: { mode: "write" } });
    const content = "A".repeat(Math.ceil(MAX_VOUCHER_FILE_BYTES / 3) * 4 + 4);
    const result = await c.call("create_voucher", { ...base, file: { ...pdfFile, content } });
    expect(result.isError).toBe(true);
    expect(api.requests).toHaveLength(0);
  });

  it("accepts a PNG and a JPEG with fitting names", async () => {
    const received: Received = [];
    api.server.use(readSupplier, guidance(), uploadHandler(received), saved());
    const c = await connectWrites({ config: { mode: "write" } });
    const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 16]);
    for (const file of [
      { content: PNG_BYTES.toString("base64"), filename: "scan.PNG", mimeType: "image/png" },
      { content: jpeg.toString("base64"), filename: "foto.jpeg", mimeType: "image/jpeg" },
    ]) {
      const result = await c.call("create_voucher", { ...base, file });
      expect(result.isError, textOf(result)).toBeFalsy();
    }
    expect(received.map((r) => r.type)).toEqual(["image/png", "image/jpeg"]);
  });

  it("refuses accounts, rules and rates the guidance does not allow, without writing", async () => {
    api.server.use(readSupplier, guidance(expenseGuide(["NINETEEN"])));
    const c = await connectWrites({ config: { mode: "write" } });
    const cases: Array<[Record<string, unknown>, string]> = [
      [
        { positions: [{ accountDatevId: 4999, taxRate: 19, amount: 10 }] },
        "account 4999 is not an allowed expense account",
      ],
      [{ taxRule: 1 }, "Tax rule 1 is not a expense tax rule sevdesk documents for vouchers"],
      [{ taxRule: 8 }, "does not allow tax rule 8"],
      [
        { positions: [{ accountDatevId: 6815, taxRate: 7, amount: 10 }] },
        "allows tax rates 19 % with tax rule 9 and account 6815, not 7 %",
      ],
      [
        { taxRule: 10, positions: [{ accountDatevId: 6815, taxRate: 19, amount: 10 }] },
        "Tax rule 10 (Nicht vorsteuerabziehbare Aufwendungen) allows tax rates 0 %",
      ],
      [{ taxRule: 21 }, "must be a voucher tax rule"],
      [{ supplierName: "Zweiter Name" }, "not both"],
      [{ positions: [{ accountDatevId: 6815, taxRate: 19, amount: 10.005 }] }, "two decimal"],
    ];
    for (const [change, message] of cases) {
      const result = await c.call("create_voucher", { ...base, ...change });
      expect(result.isError, JSON.stringify(change)).toBe(true);
      expect(textOf(result), JSON.stringify(change)).toContain(message);
    }
    expect(writes()).toEqual([]);
  });

  it("falls back to the documented rules with a warning when the guidance cannot be read", async () => {
    api.server.use(
      readSupplier,
      http.get(sevdeskUrl("/ReceiptGuidance/forExpense"), () => sevdeskError(503)),
      saved({ document: null }),
    );
    const c = await connectWrites({ config: { mode: "write" } });
    const result = await c.call("create_voucher", base);
    expect(result.isError, textOf(result)).toBeFalsy();
    expect(structured(result)).toMatchObject({
      taxRule: { id: 9, checkedAgainst: "documented_rules" },
      warnings: [expect.stringContaining("the booking accounts were not checked")],
    });
  });

  it("falls back with a warning when the guidance lists no accounts", async () => {
    api.server.use(
      readSupplier,
      http.get(sevdeskUrl("/ReceiptGuidance/forExpense"), () => HttpResponse.json({ objects: [] })),
      saved({ document: null }),
    );
    const c = await connectWrites({ config: { mode: "write" } });
    const result = await c.call("create_voucher", base);
    expect(structured(result)).toMatchObject({
      taxRule: { checkedAgainst: "documented_rules" },
      warnings: [
        "sevdesk's tax guidance listed no expense accounts; tax rule and rates were checked " +
          "against the documented sevdesk rules only, the booking accounts were not checked.",
      ],
    });
  });

  it("checks the account and rule but not the rate when the guidance names an unknown rate", async () => {
    api.server.use(readSupplier, guidance(expenseGuide(["NINETEEN", "TWENTY_ONE"])), saved());
    const c = await connectWrites({ config: { mode: "write" } });
    const result = await c.call("create_voucher", base);
    expect(result.isError, textOf(result)).toBeFalsy();
    expect(structured(result)).toMatchObject({ taxRule: { checkedAgainst: "guidance" } });
  });

  it("only warns when deliveryDate is after voucherDate", async () => {
    api.server.use(readSupplier, guidance(), saved({ document: null }));
    const c = await connectWrites({ config: { mode: "write" } });
    const result = await c.call("create_voucher", { ...base, deliveryDate: "2026-03-05" });
    expect(result.isError, textOf(result)).toBeFalsy();
    expect(structured(result).warnings).toEqual([
      "deliveryDate 2026-03-05 is after voucherDate 2026-03-01; check that both dates are right.",
    ]);
    expect(await bodyOf(api, "voucherFactorySaveVoucher")).toMatchObject({
      voucher: { deliveryDate: "05.03.2026" },
    });
  });

  it("refuses an unknown supplier before uploading anything", async () => {
    api.server.use(
      http.get(sevdeskUrl("/Contact/2003"), () => HttpResponse.json({ objects: [] })),
      guidance(),
    );
    const c = await connectWrites({ config: { mode: "write" } });
    const result = await c.call("create_voucher", { ...base, file: pdfFile });
    expect(textOf(result)).toBe("sevdesk has no contact with ID 2003.");
    expect(writes()).toEqual([]);
  });

  it("says the file was uploaded but no voucher created when sevdesk rejects the voucher", async () => {
    api.server.use(
      readSupplier,
      guidance(),
      uploadHandler([]),
      http.post(sevdeskUrl("/Voucher/Factory/saveVoucher"), () =>
        sevdeskError(422, "taxRule invalid"),
      ),
    );
    const c = await connectWrites({ config: { mode: "write" } });
    const result = await c.call("create_voucher", { ...base, file: pdfFile });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("The file was uploaded to sevdesk's temporary storage");
    expect(textOf(result)).toContain("No voucher was created");
  });

  it("reports an unknown outcome when saving fails with a server error", async () => {
    api.server.use(
      readSupplier,
      guidance(),
      uploadHandler([]),
      http.post(sevdeskUrl("/Voucher/Factory/saveVoucher"), () => sevdeskError(500)),
    );
    const c = await connectWrites({ config: { mode: "write" } });
    const result = await c.call("create_voucher", { ...base, file: pdfFile });
    expect(textOf(result)).toContain("The file was uploaded");
    expect(textOf(result)).toContain("The outcome is unknown: check sevdesk before retrying.");
    expect(textOf(result)).not.toContain("No voucher was created");
    expect(c.audit().at(-1)).toMatchObject({ outcome: "error", status: 500 });
  });

  it("stops after a failed upload without saving a voucher", async () => {
    api.server.use(
      readSupplier,
      guidance(),
      http.post(sevdeskUrl("/Voucher/Factory/uploadTempFile"), () => sevdeskError(400, "bad file")),
    );
    const c = await connectWrites({ config: { mode: "write" } });
    const result = await c.call("create_voucher", { ...base, file: pdfFile });
    expect(textOf(result)).toBe(
      "The file upload failed: sevdesk rejected the request (400): bad file No voucher was created.",
    );
    expect(operations(api).filter((op) => op.startsWith("POST"))).toEqual([
      "POST voucherUploadFile",
    ]);
  });

  it("says no voucher was created when the upload fails with a server error", async () => {
    api.server.use(
      readSupplier,
      guidance(),
      http.post(sevdeskUrl("/Voucher/Factory/uploadTempFile"), () => sevdeskError(503)),
    );
    const c = await connectWrites({ config: { mode: "write" } });
    const result = await c.call("create_voucher", { ...base, file: pdfFile });
    expect(textOf(result)).toMatch(/^The file upload failed: .*No voucher was created\.$/);
    expect(operations(api)).not.toContain("POST voucherFactorySaveVoucher");
  });

  it.each([
    [{ objects: {} }],
    [{ objects: { filename: "../../etc/passwd" } }],
    [{ objects: { filename: "a b.pdf" } }],
  ])("does not save a voucher when the upload answers %j", async (answer) => {
    api.server.use(
      readSupplier,
      guidance(),
      http.post(sevdeskUrl("/Voucher/Factory/uploadTempFile"), () =>
        HttpResponse.json(answer, { status: 201 }),
      ),
    );
    const c = await connectWrites({ config: { mode: "write" } });
    const result = await c.call("create_voucher", { ...base, file: pdfFile });
    expect(textOf(result)).toContain("returned no usable file name. No voucher was created");
    expect(operations(api)).not.toContain("POST voucherFactorySaveVoucher");
  });

  it("warns when sevdesk's sum or status differ from what was sent", async () => {
    api.server.use(
      readSupplier,
      guidance(),
      saved({ sumGross: "240", status: "100", document: null }),
    );
    const c = await connectWrites({ config: { mode: "write" } });
    const result = await c.call("create_voucher", base);
    expect((structured(result).warnings as string[]).join(" ")).toMatch(
      /Sum mismatch: sevdesk reports a gross sum of 240.*status 100 instead of draft/,
    );
  });
});

// ---------------------------------------------------------------------------

const unpaid = voucher({ sumGross: "50", paidAmount: "10" });
const readVoucher = (raw: unknown) =>
  http.get(sevdeskUrl("/Voucher/8001"), () => HttpResponse.json(list([raw])));
const account = http.get(sevdeskUrl("/CheckAccount/9001"), () =>
  HttpResponse.json(list([checkAccount()])),
);
const booked = http.put(sevdeskUrl("/Voucher/8001/bookAmount"), () =>
  HttpResponse.json({ objects: { id: "88", objectName: "VoucherLog" } }),
);

async function confirm(c: WriteConnection, name: string, args: Record<string, unknown>) {
  const { token } = await previewOf(c, name, args);
  return { token, result: await c.call(name, { ...args, confirmation_token: token }) };
}

describe("book_voucher_payment (W+)", () => {
  const args = {
    voucherId: 8001,
    amount: 40,
    date: "2026-03-10",
    paymentType: "FULL_PAYMENT",
    checkAccountId: 9001,
  };

  it("previews the open amount before and after and books only with the token", async () => {
    api.server.use(readVoucher(unpaid), readSupplier, account, booked);
    const c = await connectWrites({ config: { mode: "write" } });
    const { preview, token } = await previewOf(c, "book_voucher_payment", args);
    expect(writes()).toEqual([]);
    expect(preview).toMatchObject({
      voucher: {
        documentType: "voucher",
        id: 8001,
        number: "Druckerpapier",
        contact: { id: 2003, name: "Bürobedarf Beispiel KG" },
        status: 100,
        statusName: "unpaid",
        openAmount: 40,
      },
      amount: 40,
      paymentType: "FULL_PAYMENT",
      checkAccount: { id: 9001, name: "Geschäftskonto" },
      openBefore: 40,
      openAfter: 0,
      overpayment: 0,
      warnings: [],
    });
    expect(preview.approval).toBe(
      "Book 40 EUR (FULL_PAYMENT) dated 2026-03-10 on voucher Druckerpapier (ID 8001) from " +
        "Bürobedarf Beispiel KG, gross 50 EUR to check account 9001 (Geschäftskonto); open 40 -> 0.",
    );
    const result = await c.call("book_voucher_payment", { ...args, confirmation_token: token });
    expect(structured(result)).toEqual({
      voucherId: 8001,
      voucherNumber: "Druckerpapier",
      bookedAmount: 40,
      date: "2026-03-10",
      paymentType: "FULL_PAYMENT",
      checkAccountId: 9001,
      openBefore: 40,
      openAfterExpected: 0,
      overpayment: 0,
      logId: 88,
    });
    expect(await bodyOf(api, "bookVoucher")).toEqual({
      amount: 40,
      date: unixSeconds("2026-03-10"),
      type: "FULL_PAYMENT",
      checkAccount: { id: 9001, objectName: "CheckAccount" },
    });
    const replay = await c.call("book_voucher_payment", { ...args, confirmation_token: token });
    expect(textOf(replay)).toContain("already used");
    expect(writes()).toHaveLength(1);
    expect(c.audit().map((e) => e.outcome)).toEqual(["confirmation_issued", "ok", "denied"]);
  });

  it("links a bank transaction when one is given", async () => {
    api.server.use(readVoucher(unpaid), readSupplier, account, booked);
    const c = await connectWrites({ config: { mode: "write" } });
    await confirm(c, "book_voucher_payment", { ...args, checkAccountTransactionId: 9501 });
    expect(await bodyOf(api, "bookVoucher")).toMatchObject({
      checkAccountTransaction: { id: 9501, objectName: "CheckAccountTransaction" },
    });
  });

  it("warns about overpayment, a type that does not fit and a draft", async () => {
    api.server.use(readVoucher(unpaid), readSupplier, account);
    const c = await connectWrites({ config: { mode: "write" } });
    const over = await previewOf(c, "book_voucher_payment", { ...args, amount: 55 });
    expect(over.preview.approval).toContain(
      "Warnings: Overpayment: 55 is 15 more than the open amount of 40. Without type O or OF",
    );
    expect(over.preview.warnings).toEqual([
      "Overpayment: 55 is 15 more than the open amount of 40. Without type O or OF this server refuses the " +
        "booking at execution.",
      "FULL_PAYMENT expects the open amount (40), not 55; use N for a partial payment, CB, " +
        "MTC or O for a reduced amount, OF for reminder fees.",
    ]);
    const partial = await previewOf(c, "book_voucher_payment", { ...args, paymentType: "N" });
    expect((partial.preview.warnings as string[]).join(" ")).toContain("N books a partial payment");
    api.server.use(readVoucher(voucher({ status: "50" })));
    const draft = await previewOf(c, "book_voucher_payment", args);
    expect((draft.preview.warnings as string[]).join(" ")).toContain("is draft (50)");
    expect(writes()).toEqual([]);
  });

  it("shows CB, MTC and O as expected settled with nothing left open", async () => {
    api.server.use(readVoucher(unpaid), readSupplier, account);
    const c = await connectWrites({ config: { mode: "write" } });
    for (const paymentType of ["CB", "MTC", "O"]) {
      const { preview } = await previewOf(c, "book_voucher_payment", {
        ...args,
        amount: 38,
        paymentType,
      });
      expect(preview, paymentType).toMatchObject({
        openBefore: 40,
        openAfter: 0,
        expectedSettled: true,
      });
      expect(preview.approval as string, paymentType).toContain("open 40 -> 0 (expected settled).");
    }
    const partial = await previewOf(c, "book_voucher_payment", {
      ...args,
      amount: 38,
      paymentType: "N",
    });
    expect(partial.preview).toMatchObject({ openAfter: 2, expectedSettled: false });
  });

  it("refuses an enshrined voucher in the preview and at execution", async () => {
    const enshrined = voucher({
      sumGross: "50",
      paidAmount: "10",
      enshrined: "2026-03-03T10:00:00+01:00",
    });
    api.server.use(readVoucher(enshrined), readSupplier, account, booked);
    const c = await connectWrites({ config: { mode: "write" } });
    const result = await c.call("book_voucher_payment", args);
    expect(textOf(result)).toBe(
      "Voucher 8001 is enshrined (festgeschrieben); this server refuses payments on " +
        "enshrined vouchers. Nothing was booked.",
    );
    expect(result.structuredContent).toBeUndefined();

    let reads = 0;
    api.server.use(
      http.get(sevdeskUrl("/Voucher/8001"), () => {
        reads++;
        return HttpResponse.json(list([reads === 1 ? unpaid : enshrined]));
      }),
    );
    const { result: executed } = await confirm(c, "book_voucher_payment", args);
    expect(textOf(executed)).toContain("is enshrined (festgeschrieben)");
    expect(textOf(executed)).toContain("new preview");
    expect(writes()).toEqual([]);
  });

  it("refuses at execution an overpayment that arose after the preview", async () => {
    let reads = 0;
    api.server.use(
      http.get(sevdeskUrl("/Voucher/8001"), () => {
        reads++;
        return HttpResponse.json(
          list([
            reads === 1 ? unpaid : voucher({ sumGross: "50", paidAmount: "30", status: "750" }),
          ]),
        );
      }),
      readSupplier,
      account,
      booked,
    );
    const c = await connectWrites({ config: { mode: "write" } });
    const { result } = await confirm(c, "book_voucher_payment", args);
    expect(textOf(result)).toBe(
      "Voucher 8001 has 20 open now; 40 would overpay it by 20; this server refuses " +
        "overpayments without type O or OF. Nothing was booked; call the tool again without confirmation_token for a new preview.",
    );
    expect(writes()).toEqual([]);
  });

  it("books an overpayment as OF and records the voucher as audit target", async () => {
    api.server.use(readVoucher(unpaid), readSupplier, account, booked);
    const c = await connectWrites({ config: { mode: "write" } });
    const { result } = await confirm(c, "book_voucher_payment", {
      ...args,
      amount: 45,
      paymentType: "OF",
    });
    expect(structured(result)).toMatchObject({ overpayment: 5, openAfterExpected: 0 });
    expect(c.audit().at(-1)).toMatchObject({ outcome: "ok", targetId: "voucher:8001" });
  });

  it("requires paymentType and date and whole cents, and refuses CF", async () => {
    const c = await connectWrites({ config: { mode: "write" } });
    const { paymentType: _type, ...withoutType } = args;
    const { date: _date, ...withoutDate } = args;
    for (const bad of [
      withoutType,
      withoutDate,
      { ...args, amount: 1.234 },
      { ...args, paymentType: "CF" },
    ]) {
      const result = await c.call("book_voucher_payment", bad);
      expect(result.isError, JSON.stringify(bad)).toBe(true);
    }
    expect(api.requests).toHaveLength(0);
    const tool = (await c.client.listTools()).tools.find((t) => t.name === "book_voucher_payment");
    const schema = tool?.inputSchema as { required?: string[] };
    expect(schema.required).toEqual(expect.arrayContaining(["date", "paymentType"]));
  });

  const CHANGED: Array<Record<string, unknown>> = [
    { voucherId: 8002 },
    { amount: 41 },
    { date: "2026-03-11" },
    { paymentType: "N" },
    { checkAccountId: 9002 },
    { checkAccountTransactionId: 9501 },
  ];

  it.each(CHANGED)("refuses the token with %j changed and sends nothing", async (change) => {
    api.server.use(readVoucher(unpaid), readSupplier, account, booked);
    const c = await connectWrites({ config: { mode: "write" } });
    const { token } = await previewOf(c, "book_voucher_payment", args);
    const result = await c.call("book_voucher_payment", {
      ...args,
      ...change,
      confirmation_token: token,
    });
    expect(textOf(result)).toContain("was issued for different arguments");
    expect(writes()).toEqual([]);
    expect(c.audit().at(-1)).toMatchObject({ outcome: "denied", reason: "wrong_arguments" });
  });

  it("refuses a malformed token without sending anything", async () => {
    api.server.use(readVoucher(unpaid), readSupplier, account, booked);
    const c = await connectWrites({ config: { mode: "write" } });
    const result = await c.call("book_voucher_payment", { ...args, confirmation_token: "x.y" });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("confirmation_token");
    expect(writes()).toEqual([]);
  });

  it("refuses at execution when the voucher is paid by then, without booking", async () => {
    let reads = 0;
    api.server.use(
      http.get(sevdeskUrl("/Voucher/8001"), () => {
        reads++;
        return HttpResponse.json(list([reads === 1 ? unpaid : voucher({ status: "1000" })]));
      }),
      readSupplier,
      account,
      booked,
    );
    const c = await connectWrites({ config: { mode: "write" } });
    const { result } = await confirm(c, "book_voucher_payment", args);
    expect(textOf(result)).toBe(
      "Voucher 8001 is paid (1000) now, so sevdesk would refuse the booking. Nothing was " +
        "booked; call the tool again without confirmation_token for a new preview.",
    );
    expect(writes()).toEqual([]);
  });

  it("reports an unknown outcome on a server error", async () => {
    api.server.use(
      readVoucher(unpaid),
      readSupplier,
      account,
      http.put(sevdeskUrl("/Voucher/8001/bookAmount"), () => sevdeskError(502)),
    );
    const c = await connectWrites({ config: { mode: "write" } });
    const { result } = await confirm(c, "book_voucher_payment", args);
    expect(textOf(result)).toContain("The outcome is unknown: check sevdesk before retrying.");
  });

  it("is not registered in read mode", async () => {
    const c = await connectWrites({ config: { mode: "read" } });
    const names = (await c.client.listTools()).tools.map((t) => t.name);
    expect(names).not.toContain("book_voucher_payment");
  });
});
