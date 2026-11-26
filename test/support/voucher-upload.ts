import { MAX_VOUCHER_FILE_BYTES } from "../../src/tools/voucher-writes.js";
import { PDF_BYTES, voucher } from "../fixtures/sevdesk.js";

/**
 * create_voucher with a file of exactly MAX_VOUCHER_FILE_BYTES, for tests
 * that send it through a real transport, and the sevdesk answers it needs
 * from a plain node:http mock.
 */

/** A PDF of exactly the limit (header first, end marker last), as base64. */
export function pdfAtLimit(): string {
  const bytes = Buffer.alloc(MAX_VOUCHER_FILE_BYTES, 0x20);
  PDF_BYTES.copy(bytes);
  PDF_BYTES.copy(bytes, bytes.length - PDF_BYTES.length);
  return bytes.toString("base64");
}

export function voucherArguments(content: string) {
  return {
    voucherDate: "2026-03-01",
    description: "RE-4711",
    supplierName: "Bürobedarf Beispiel KG",
    taxRule: 9,
    positions: [{ accountDatevId: 6815, taxRate: 19, amount: 119 }],
    file: { content, filename: "rechnung-4711.pdf", mimeType: "application/pdf" },
  };
}

const GUIDANCE = {
  objects: [
    {
      accountDatevId: 6815,
      accountNumber: "6815",
      accountName: "Bürobedarf",
      allowedTaxRules: [{ id: 9, name: "VORST_ABZUGSF_AUFW", taxRates: ["NINETEEN"] }],
      allowedReceiptTypes: ["EXPENSE"],
    },
  ],
};
const UPLOADED = {
  objects: { filename: "f019bec36c65f5a0e7d2c63cc33f0681.pdf", mimeType: "application/pdf" },
};
const SAVED = {
  objects: {
    voucher: voucher({
      id: "8101",
      status: "50",
      description: "RE-4711",
      supplier: null,
      sumNet: "100",
      sumGross: "119",
      document: { id: "77", objectName: "Document" },
    }),
    voucherPos: [],
  },
};

/** The answer for a create_voucher request, or undefined for any other route. */
export function voucherRoute(method: string, url: string): unknown {
  const path = new URL(url, "http://mock").pathname;
  if (method === "GET" && path.endsWith("/ReceiptGuidance/forExpense")) return GUIDANCE;
  if (method === "POST" && path.endsWith("/Voucher/Factory/uploadTempFile")) return UPLOADED;
  if (method === "POST" && path.endsWith("/Voucher/Factory/saveVoucher")) return SAVED;
  return undefined;
}
