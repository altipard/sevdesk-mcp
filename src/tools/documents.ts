import type { ContentBlock } from "@modelcontextprotocol/server";
import { z } from "zod";
import { defineTool } from "../policy/registry.js";
import { SevdeskError } from "../sevdesk/errors.js";
import { asRecord, entityId, flag, type Raw, READ_ANNOTATIONS, text } from "./format.js";
import { present } from "./result.js";

/** Upper bound for a decoded file handed to the client (5 MiB). */
export const MAX_FILE_BYTES = 5 * 1024 * 1024;

const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/;
const MIME_TYPE = /^[a-z0-9][a-z0-9.+-]*\/[a-z0-9][a-z0-9.+-]*$/i;

export interface DecodedFile {
  readonly filename: string | null;
  readonly mimeType: string;
  readonly base64: string;
  readonly sizeBytes: number;
}

/**
 * Reads the file answer of getPdf and Report/*. The spec shows two shapes:
 * getPdf top-level with mimeType/base64encoded, Report wrapped in objects
 * with mimetype/base64Encoded. Both are accepted; content that is not
 * base64 is taken as raw bytes.
 */
export function decodeFile(body: unknown, fallbackMime: string): DecodedFile {
  const outer = asRecord(body);
  const inner = asRecord(outer.objects);
  const source: Raw = typeof inner.content === "string" ? inner : outer;
  const content = source.content;
  if (typeof content !== "string" || content === "") {
    throw new SevdeskError("http_error", "sevdesk answered without file content.");
  }
  const encodedFlag = flag(source.base64encoded ?? source.base64Encoded);
  let bytes: Buffer;
  if (encodedFlag === false) {
    bytes = Buffer.from(content, "latin1");
  } else {
    const compact = content.replace(/\s+/g, "");
    if (!BASE64.test(compact) || compact.length % 4 === 1) {
      throw new SevdeskError("http_error", "sevdesk sent file content that is not valid base64.");
    }
    bytes = Buffer.from(compact, "base64");
  }
  if (bytes.byteLength > MAX_FILE_BYTES) {
    throw new SevdeskError(
      "response_too_large",
      `The file has ${bytes.byteLength} bytes, more than the ${MAX_FILE_BYTES} this server hands out.`,
    );
  }
  const declared = text(source.mimeType ?? source.mimetype);
  return {
    filename: text(source.filename),
    mimeType: declared !== null && MIME_TYPE.test(declared) ? declared : fallbackMime,
    base64: bytes.toString("base64"),
    sizeBytes: bytes.byteLength,
  };
}

export function fileContent(uri: string, file: DecodedFile): ContentBlock {
  return { type: "resource", resource: { uri, mimeType: file.mimeType, blob: file.base64 } };
}

export const fileMetaSchema = {
  filename: z.string().nullable(),
  mimeType: z.string(),
  sizeBytes: z.number().int(),
  resourceUri: z.string().describe("URI of the embedded resource that carries the file."),
};

const DOCUMENT_TYPES = ["invoice", "credit_note", "order"] as const;

export const getDocumentPdf = defineTool({
  name: "get_document_pdf",
  title: "Get the PDF of a sevdesk document",
  description:
    "Returns the rendered PDF of an invoice, credit note or order (estimate) as an embedded " +
    "resource (base64, application/pdf), plus file name and size. Fetching never marks the " +
    `document as sent: the server always sets preventSendBy. Files over ${MAX_FILE_BYTES} ` +
    "bytes are refused. Use get_invoice for the data itself.",
  class: "R",
  operationId: "invoiceGetPdf",
  inputSchema: z.object({
    documentType: z.enum(DOCUMENT_TYPES).describe("Kind of document."),
    documentId: entityId.describe("sevdesk ID of the invoice, credit note or order."),
  }),
  outputSchema: z.object({
    documentType: z.enum(DOCUMENT_TYPES),
    documentId: z.number().int(),
    ...fileMetaSchema,
  }),
  annotations: READ_ANNOTATIONS,
  async handler({ documentType, documentId }, { sevdesk }) {
    // preventSendBy is pinned in the client for every call path; it is set
    // here as well so the intent is visible where the request is made.
    const query = { preventSendBy: true } as const;
    const request =
      documentType === "invoice"
        ? sevdesk.api.GET("/Invoice/{invoiceId}/getPdf", {
            params: { path: { invoiceId: documentId }, query },
          })
        : documentType === "credit_note"
          ? sevdesk.api.GET("/CreditNote/{creditNoteId}/getPdf", {
              params: { path: { creditNoteId: documentId }, query },
            })
          : sevdesk.api.GET("/Order/{orderId}/getPdf", {
              params: { path: { orderId: documentId }, query },
            });
    const file = decodeFile(
      await sevdesk.call(request as Promise<{ data: unknown; response: Response }>),
      "application/pdf",
    );
    const resourceUri = `sevdesk://${documentType}/${documentId}/pdf`;
    return present(
      {
        documentType,
        documentId,
        filename: file.filename,
        mimeType: file.mimeType,
        sizeBytes: file.sizeBytes,
        resourceUri,
      },
      {
        summary: `PDF of ${documentType} ${documentId}: ${file.filename ?? "unnamed"}, ${file.sizeBytes} bytes.`,
        content: [fileContent(resourceUri, file)],
      },
    );
  },
});
