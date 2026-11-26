import { type ToolDefinition, withOperations } from "../policy/registry.js";
import { getAccountInfo } from "./account.js";
import { listBankAccounts, searchTransactions } from "./banking.js";
import { createContact, updateContact } from "./contact-writes.js";
import { getContact, searchContacts } from "./contacts.js";
import { createInvoiceDraft, createInvoiceFromOrder, createOrderDraft } from "./document-drafts.js";
import { getDocumentPdf } from "./documents.js";
import { GENERIC_TOOL_NAME } from "./generic.js";
import { getTaxGuidance } from "./guidance.js";
import {
  bookInvoicePayment,
  cancelInvoice,
  markInvoiceSent,
  sendInvoiceEmail,
} from "./invoice-actions.js";
import { getInvoice, listOpenReceivables, searchInvoices } from "./invoices.js";
import { searchOrders } from "./orders.js";
import { searchParts } from "./parts.js";
import { getReport } from "./reports.js";
import { getVoucher, searchVouchers } from "./vouchers.js";

/**
 * Every curated tool. New tools are added here and nowhere else.
 *
 * A tool's client only sends its operationId and the operations it lists.
 * Tools below call more than their operationId; their extra operations are
 * listed here until they move into the tool definitions themselves. New
 * tools declare `operations` in their own definition.
 */
export const TOOLS: readonly ToolDefinition[] = [
  getAccountInfo,
  withOperations(searchContacts, ["getCommunicationWays", "getContactById"]),
  withOperations(getContact, ["getCommunicationWays"]),
  searchInvoices,
  withOperations(getInvoice, ["getInvoicePositionsById"]),
  withOperations(getDocumentPdf, ["creditNoteGetPdf", "orderGetPdf"]),
  listOpenReceivables,
  searchOrders,
  searchVouchers,
  withOperations(getVoucher, ["getVoucherPositions"]),
  listBankAccounts,
  withOperations(searchTransactions, ["getCheckAccounts"]),
  searchParts,
  withOperations(getTaxGuidance, ["forRevenue", "forExpense", "forAccountNumber", "forTaxRule"]),
  withOperations(getReport, ["reportOrder", "reportContact", "reportVoucher"]),
  createContact,
  updateContact,
  createInvoiceDraft,
  createOrderDraft,
  createInvoiceFromOrder,
  markInvoiceSent,
  bookInvoicePayment,
  sendInvoiceEmail,
  cancelInvoice,
];

/** Names valid in SEVDESK_ALLOWED_TOOLS, SEVDESK_DENIED_TOOLS and SEVDESK_ENABLE_TOOLS. */
export const TOOL_NAMES: readonly string[] = [...TOOLS.map((tool) => tool.name), GENERIC_TOOL_NAME];
