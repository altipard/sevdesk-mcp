import type { ToolDefinition } from "../policy/registry.js";
import { getAccountInfo } from "./account.js";
import { GENERIC_TOOL_NAME } from "./generic.js";

/** Every curated tool. New tools are added here and nowhere else. */
export const TOOLS: readonly ToolDefinition[] = [getAccountInfo];

/** Names valid in SEVDESK_ALLOWED_TOOLS and SEVDESK_DENIED_TOOLS. */
export const TOOL_NAMES: readonly string[] = [...TOOLS.map((tool) => tool.name), GENERIC_TOOL_NAME];
