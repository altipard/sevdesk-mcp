import type { ToolDefinition } from "../policy/registry.js";
import { getAccountInfo } from "./account.js";
import { listBankAccounts, searchTransactions } from "./banking.js";
import { getContact, searchContacts } from "./contacts.js";
import { GENERIC_TOOL_NAME } from "./generic.js";
import { getTaxGuidance } from "./guidance.js";
import { getInvoice, listOpenReceivables, searchInvoices } from "./invoices.js";
import { searchOrders } from "./orders.js";
import { searchParts } from "./parts.js";
import { getVoucher, searchVouchers } from "./vouchers.js";

/** Every curated tool. New tools are added here and nowhere else. */
export const TOOLS: readonly ToolDefinition[] = [
  getAccountInfo,
  searchContacts,
  getContact,
  searchInvoices,
  getInvoice,
  listOpenReceivables,
  searchOrders,
  searchVouchers,
  getVoucher,
  listBankAccounts,
  searchTransactions,
  searchParts,
  getTaxGuidance,
];

/** Names valid in SEVDESK_ALLOWED_TOOLS, SEVDESK_DENIED_TOOLS and SEVDESK_ENABLE_TOOLS. */
export const TOOL_NAMES: readonly string[] = [...TOOLS.map((tool) => tool.name), GENERIC_TOOL_NAME];
