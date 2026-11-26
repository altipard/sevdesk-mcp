/**
 * Expected curated read tools, in registration order. Written out instead
 * of derived from TOOLS, so adding or dropping a tool needs a deliberate
 * change here.
 */
export const READ_TOOLS = [
  "get_account_info",
  "search_contacts",
  "get_contact",
  "search_invoices",
  "get_invoice",
  "list_open_receivables",
] as const;
