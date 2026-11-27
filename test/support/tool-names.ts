/**
 * Expected curated read tools (numbers 1-15 of the curated list, then the
 * audit and analysis tools), in
 * registration order. Written out instead of derived from TOOLS, so adding
 * or dropping a tool needs a deliberate change here.
 */
export const READ_TOOLS = [
  "get_account_info",
  "search_contacts",
  "get_contact",
  "search_invoices",
  "get_invoice",
  "get_document_pdf",
  "list_open_receivables",
  "search_orders",
  "search_vouchers",
  "get_voucher",
  "list_bank_accounts",
  "search_transactions",
  "search_parts",
  "get_tax_guidance",
  "get_report",
  "summarize_documents",
  "audit_vat",
  "reverse_charge_report",
  "find_duplicate_vouchers",
  "find_subscription_gaps",
  "reconcile_transactions",
] as const;
