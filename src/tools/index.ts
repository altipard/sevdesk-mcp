import type { ToolDefinition } from "../policy/registry.js";
import { getAccountInfo } from "./account.js";
import { GENERIC_TOOL_NAME } from "./generic.js";
import { getInvoice, listOpenReceivables, searchInvoices } from "./invoices.js";

/** Every curated tool. New tools are added here and nowhere else. */
export const TOOLS: readonly ToolDefinition[] = [
  getAccountInfo,
  searchInvoices,
  getInvoice,
  listOpenReceivables,
];

/** Names valid in SEVDESK_ALLOWED_TOOLS, SEVDESK_DENIED_TOOLS and SEVDESK_ENABLE_TOOLS. */
export const TOOL_NAMES: readonly string[] = [...TOOLS.map((tool) => tool.name), GENERIC_TOOL_NAME];
