import type { CallToolResult, ContentBlock } from "@modelcontextprotocol/server";
import type { Logger } from "../logger.js";
import { SevdeskError } from "../sevdesk/errors.js";

export interface Presentation {
  /** One line for the reader, put in front of the JSON text. */
  readonly summary: string;
  /** Further content blocks, e.g. a PDF as embedded resource. */
  readonly content?: readonly ContentBlock[];
}

// Keyed by the output object the handler returns: the guard hands that very
// object to okResult, so tools can shape their result without the guard
// knowing about it, and structuredContent stays exactly the schema'd data.
const presentations = new WeakMap<object, Presentation>();

/** Attaches a summary line and extra content to a handler's output. */
export function present<T extends Record<string, unknown>>(data: T, presentation: Presentation): T {
  presentations.set(data, presentation);
  return data;
}

/**
 * Successful tool result: structured data plus the same data as compact
 * JSON text for clients that do not pass structuredContent on, preceded by
 * the tool's summary line if it set one.
 */
export function okResult<T extends Record<string, unknown>>(data: T): CallToolResult {
  const presentation = presentations.get(data);
  const json = JSON.stringify(data);
  return {
    content: [
      { type: "text", text: presentation ? `${presentation.summary}\n${json}` : json },
      ...(presentation?.content ?? []),
    ],
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
