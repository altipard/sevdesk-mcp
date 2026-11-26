import type { CallToolResult } from "@modelcontextprotocol/server";
import type { Logger } from "../logger.js";
import { SevdeskError } from "../sevdesk/errors.js";

/** Successful tool result: structured data plus the same data as text for older clients. */
export function okResult<T extends Record<string, unknown>>(data: T): CallToolResult {
  return {
    content: [{ type: "text", text: JSON.stringify(data) }],
    structuredContent: data,
  };
}

/**
 * Converts a failure into an MCP tool error. sevdesk errors already carry a
 * user-facing, redacted message. Anything else is logged and reported
 * generically, because its message may contain internals.
 */
export function errorResult(tool: string, error: unknown, logger: Logger): CallToolResult {
  if (error instanceof SevdeskError) {
    logger.warn("tool failed", { tool, kind: error.kind, status: error.status });
    return { isError: true, content: [{ type: "text", text: error.message }] };
  }
  logger.error("tool crashed", { tool, error });
  return {
    isError: true,
    content: [
      { type: "text", text: "Internal error in sevdesk-mcp. Details are in the server log." },
    ],
  };
}
