import type { OperationId } from "./operations.js";

/**
 * Risk class of a sevdesk operation (docs/research/stack-analyse.md, section 4).
 *
 * - R:  reads without side effects.
 * - R+: reads that move bulk data out (exports). Only with an explicit allowlist.
 * - W:  creates or changes data that can still be corrected (drafts, master data).
 * - W+: changes document status or bookings; reversible, but only by a
 *       counter-action. Needs a confirmation token.
 * - X:  cannot be undone (e-mail to third parties, cancellation invoice,
 *       enshrining, deletion). Confirmation token with single-use nonce,
 *       idempotency per target and human approval.
 */
export const OPERATION_CLASSES = ["R", "R+", "W", "W+", "X"] as const;
export type OperationClass = (typeof OPERATION_CLASSES)[number];

/**
 * Class of every operation in the spec. An operation missing here is denied
 * everywhere, and the test suite fails until it is classified.
 *
 * Operations the table in the analysis does not name are classified by the
 * rule "upward when in doubt":
 * - other creates and updates of master data, drafts and settings: W;
 * - generic updates of accounting records that can already be booked
 *   (updatecreditNote, updateVoucher, updateCheckAccountTransaction): W+,
 *   because they can change booked or sent documents;
 * - export job follow-ups (Progress, ExportJob): R+ like the exports themselves.
 *
 * Parameters that would lift an operation into a higher class are pinned by
 * the fallback instead (FORCED_PARAMS in src/tools/generic.ts): getPdf always
 * runs with preventSendBy=true, so it is R here, and the DATEV exports never
 * send enshrine/enshrineDocuments=true.
 */
export const CLASSIFICATION = {
  // Basics
  bookkeepingSystemVersion: "R",

  // CheckAccount
  getCheckAccounts: "R",
  createFileImportAccount: "W",
  createClearingAccount: "W",
  getCheckAccountById: "R",
  updateCheckAccount: "W",
  deleteCheckAccount: "X",
  getBalanceAtDate: "R",

  // CheckAccountTransaction
  getTransactions: "R",
  createTransaction: "W",
  getCheckAccountTransactionById: "R",
  updateCheckAccountTransaction: "W+",
  deleteCheckAccountTransaction: "X",
  checkAccountTransactionEnshrine: "X",

  // PrivateTransactionRule
  listPrivateTransactionRules: "R",
  createPrivateTransactionRule: "W",
  deletePrivateTransactionRule: "X",

  // Contact
  getNextCustomerNumber: "R",
  findContactsByCustomFieldValue: "R",
  contactCustomerNumberAvailabilityCheck: "R",
  getContacts: "R",
  createContact: "W",
  getContactById: "R",
  updateContact: "W",
  deleteContact: "X",
  getContactTabsItemCountById: "R",

  // ContactAddress
  createContactAddress: "W",
  getContactAddresses: "R",
  contactAddressId: "R",
  updateContactAddress: "W",
  deleteContactAddress: "X",

  // CommunicationWay
  getCommunicationWays: "R",
  createCommunicationWay: "W",
  getCommunicationWayById: "R",
  deleteCommunicationWay: "X",
  UpdateCommunicationWay: "W",
  getCommunicationWayKeys: "R",

  // AccountingContact
  getAccountingContact: "R",
  createAccountingContact: "W",
  getAccountingContactById: "R",
  updateAccountingContact: "W",
  deleteAccountingContact: "X",

  // Textparser, ContactField
  getPlaceholder: "R",
  getContactFields: "R",
  createContactField: "W",
  getContactFieldsById: "R",
  updateContactfield: "W",
  deleteContactCustomFieldId: "X",
  getContactFieldSettings: "R",
  createContactFieldSetting: "W",
  getContactFieldSettingById: "R",
  updateContactFieldSetting: "W",
  deleteContactFieldSetting: "X",
  getReferenceCount: "R",

  // CreditNote
  getCreditNotes: "R",
  createcreditNote: "W",
  createCreditNoteFromInvoice: "W",
  createCreditNoteFromVoucher: "W",
  getcreditNoteById: "R",
  updatecreditNote: "W+",
  deletecreditNote: "X",
  sendCreditNoteByPrinting: "W+",
  creditNoteSendBy: "W+",
  creditNoteEnshrine: "X",
  creditNoteGetPdf: "R",
  sendCreditNoteViaEMail: "X",
  bookCreditNote: "W+",
  creditNoteResetToOpen: "W+",
  creditNoteResetToDraft: "W+",
  getcreditNotePositions: "R",

  // Export
  updateExportConfig: "W",
  exportDatevDepricated: "R+",
  exportDatevCSV: "W",
  exportDatevXML: "W",
  generateDownloadHash: "R+",
  getProgress: "R+",
  jobDownloadInfo: "R+",
  exportInvoice: "R+",
  exportInvoiceZip: "R+",
  exportCreditNote: "R+",
  exportVoucher: "R+",
  exportTransactions: "R+",
  exportVoucherZip: "R+",
  exportContact: "R+",

  // Part
  getParts: "R",
  createPart: "W",
  getPartById: "R",
  updatePart: "W",
  partGetStock: "R",

  // Invoice
  getInvoices: "R",
  createInvoiceByFactory: "W",
  getInvoiceById: "R",
  getInvoicePositionsById: "R",
  createInvoiceFromOrder: "W",
  createInvoiceReminder: "W",
  getIsInvoicePartiallyPaid: "R",
  cancelInvoice: "X",
  invoiceRender: "W",
  sendInvoiceViaEMail: "X",
  invoiceGetPdf: "R",
  invoiceGetXml: "R",
  invoiceSendBy: "W+",
  invoiceEnshrine: "X",
  bookInvoice: "W+",
  invoiceResetToOpen: "W+",
  invoiceResetToDraft: "W+",
  getInvoicePos: "R",

  // Layout
  getLetterpapersWithThumb: "R",
  getTemplates: "R",
  updateInvoiceTemplate: "W",
  updateOrderTemplate: "W",
  updateCreditNoteTemplate: "W",

  // Order
  getOrders: "R",
  createOrder: "W",
  getOrderById: "R",
  updateOrder: "W",
  deleteOrder: "X",
  getOrderPositionsById: "R",
  getDiscounts: "R",
  getRelatedObjects: "R",
  sendorderViaEMail: "X",
  createPackingListFromOrder: "W",
  createContractNoteFromOrder: "W",
  orderGetPdf: "R",
  orderSendBy: "W+",
  getOrderPositions: "R",
  getOrderPositionById: "R",
  updateOrderPosition: "W",
  deleteOrderPos: "X",

  // Voucher
  voucherFactorySaveVoucher: "W",
  voucherUploadFile: "W",
  getVouchers: "R",
  getVoucherById: "R",
  updateVoucher: "W+",
  voucherEnshrine: "X",
  bookVoucher: "W+",
  voucherResetToOpen: "W+",
  voucherResetToDraft: "W+",
  getVoucherPositions: "R",

  // ReceiptGuidance
  forAllAccounts: "R",
  forAccountNumber: "R",
  forTaxRule: "R",
  forRevenue: "R",
  forExpense: "R",

  // Report
  reportInvoice: "R",
  reportOrder: "R",
  reportContact: "R",
  reportVoucher: "R",

  // Tag
  getTags: "R",
  getTagById: "R",
  updateTag: "W",
  deleteTag: "X",
  createTag: "W",
  getTagRelations: "R",
} as const satisfies Record<OperationId, OperationClass>;

/** Class of an operation, or undefined for anything unclassified (= denied). */
export function classOf(operationId: string): OperationClass | undefined {
  return Object.hasOwn(CLASSIFICATION, operationId)
    ? CLASSIFICATION[operationId as OperationId]
    : undefined;
}

export function isOperationId(value: string): value is OperationId {
  return classOf(value) !== undefined;
}
