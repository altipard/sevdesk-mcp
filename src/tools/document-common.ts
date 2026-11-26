import { z } from "zod";
import type { ToolCall } from "../policy/registry.js";
import {
  amount,
  CREDIT_NOTE_STATUS,
  cents,
  enshrinedOf,
  entityId,
  INVOICE_STATUS,
  notFound,
  ORDER_STATUS,
  objectsOf,
  type Raw,
  refId,
  statusOf,
  text,
  VOUCHER_STATUS,
} from "./format.js";
import { mapVoucherSummary } from "./vouchers.js";
import { contactNameOf, money, oneLineText } from "./write-common.js";

/**
 * One view of invoices, credit notes, vouchers and orders for the tools
 * that act on any of them (reset, tag, enshrine, voucher payments).
 */

export const DOCUMENT_TYPES = ["invoice", "credit_note", "voucher", "order"] as const;
export type DocumentType = (typeof DOCUMENT_TYPES)[number];

/** sevdesk model names, as Tag/Factory/create expects them. */
export const OBJECT_NAMES: Readonly<Record<DocumentType, string>> = {
  invoice: "Invoice",
  credit_note: "CreditNote",
  voucher: "Voucher",
  order: "Order",
};

/** "Invoice", "Credit note", ... for the start of a sentence. */
export const capitalized = (value: string) => value.charAt(0).toUpperCase() + value.slice(1);

export const DOCUMENT_LABELS: Readonly<Record<DocumentType, string>> = {
  invoice: "invoice",
  credit_note: "credit note",
  voucher: "voucher",
  order: "order",
};

const STATUS_NAMES: Readonly<Record<DocumentType, Readonly<Record<number, string>>>> = {
  invoice: INVOICE_STATUS,
  credit_note: CREDIT_NOTE_STATUS,
  voucher: VOUCHER_STATUS,
  order: ORDER_STATUS,
};

export const documentIdInput = entityId.describe(
  "sevdesk ID of the document (search_invoices, search_vouchers, search_orders).",
);

export const documentFactsSchema = z.object({
  documentType: z.enum(DOCUMENT_TYPES),
  id: z.number().int(),
  number: z
    .string()
    .nullable()
    .describe("Invoice, credit note or order number; for vouchers the description as entered."),
  contact: z.object({
    id: z.number().int().nullable(),
    name: z.string().nullable().describe("Customer, or supplier for vouchers."),
  }),
  sumGross: z.number().nullable(),
  currency: z.string().nullable(),
  status: z.number().int().nullable(),
  statusName: z.string().nullable(),
  paidAmount: z.number().nullable(),
  openAmount: z
    .number()
    .nullable()
    .describe("sumGross minus paidAmount while open, 0 when paid; null for orders."),
  enshrined: z.boolean(),
});
export type DocumentFacts = z.infer<typeof documentFactsSchema>;

/** Open amount of an invoice or credit note: open and partially paid only. */
function openOfInvoiceLike(status: number | null, sumGross: number | null, paid: number | null) {
  if (status === 1000) return 0;
  if ((status === 200 || status === 750) && sumGross !== null) return cents(sumGross - (paid ?? 0));
  return null;
}

async function readRaw(call: ToolCall, type: DocumentType, id: number): Promise<Raw> {
  const { sevdesk } = call;
  const { api } = sevdesk;
  const request =
    type === "invoice"
      ? api.GET("/Invoice/{invoiceId}", { params: { path: { invoiceId: id } } })
      : type === "credit_note"
        ? api.GET("/CreditNote/{creditNoteId}", { params: { path: { creditNoteId: id } } })
        : type === "voucher"
          ? api.GET("/Voucher/{voucherId}", { params: { path: { voucherId: id } } })
          : api.GET("/Order/{orderId}", { params: { path: { orderId: id } } });
  const body = await sevdesk.call(request as Promise<{ data: unknown; response: Response }>);
  const raw = objectsOf(body)[0];
  if (raw === undefined) throw notFound(DOCUMENT_LABELS[type], id);
  return raw;
}

/** Facts of a document as sevdesk holds them now; throws not_found for an unknown ID. */
export async function readDocument(
  call: ToolCall,
  type: DocumentType,
  id: number,
): Promise<DocumentFacts> {
  return (await readDocumentWithRaw(call, type, id)).facts;
}

/** readDocument plus the raw sevdesk object, for fields DocumentFacts leaves out. */
export async function readDocumentWithRaw(
  call: ToolCall,
  type: DocumentType,
  id: number,
): Promise<{ facts: DocumentFacts; raw: Raw }> {
  const raw = await readRaw(call, type, id);
  const status = statusOf(raw.status, STATUS_NAMES[type]);
  const sumGross = amount(raw.sumGross);
  const paidAmount = amount(raw.paidAmount);
  let number: string | null;
  let contactId: number | null;
  let openAmount: number | null;
  if (type === "voucher") {
    number = text(raw.description);
    contactId = refId(raw.supplier);
    openAmount = mapVoucherSummary(raw).openAmount;
  } else {
    number =
      type === "invoice"
        ? text(raw.invoiceNumber)
        : type === "credit_note"
          ? text(raw.creditNoteNumber)
          : text(raw.orderNumber);
    contactId = refId(raw.contact);
    openAmount = type === "order" ? null : openOfInvoiceLike(status.status, sumGross, paidAmount);
  }
  const contactName =
    (await contactNameOf(call, contactId)) ?? (type === "voucher" ? text(raw.supplierName) : null);
  const facts: DocumentFacts = {
    documentType: type,
    id,
    number,
    contact: { id: contactId, name: contactName },
    sumGross,
    currency: text(raw.currency),
    ...status,
    paidAmount,
    openAmount,
    enshrined: enshrinedOf(raw.enshrined),
  };
  return { facts, raw };
}

/** "RE-1001 (ID 1001)", or "ID 1001 (no number yet)". */
export function documentLabel(facts: DocumentFacts): string {
  return facts.number
    ? `${oneLineText(facts.number, 120)} (ID ${facts.id})`
    : `ID ${facts.id} (no number yet)`;
}

export const statusText = (facts: Pick<DocumentFacts, "status" | "statusName">) =>
  `${facts.statusName ?? "unknown"}${facts.status === null ? "" : ` (${facts.status})`}`;

/**
 * "invoice RE-1001 (ID 1001) for Muster GmbH, gross 119 EUR" for approval
 * questions: free text on one line and shortened, so it cannot fake lines
 * or crowd out the warnings.
 */
export function documentLine(facts: DocumentFacts): string {
  const party = facts.documentType === "voucher" ? "from" : "for";
  const contact = facts.contact.name ? ` ${party} ${oneLineText(facts.contact.name, 100)}` : "";
  return (
    `${DOCUMENT_LABELS[facts.documentType]} ${documentLabel(facts)}${contact}, gross ` +
    money(facts.sumGross, facts.currency)
  );
}
