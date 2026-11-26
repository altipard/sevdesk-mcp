import type { CallToolResult, ContentBlock } from "@modelcontextprotocol/server";
import type { Logger } from "../logger.js";
import { SevdeskError } from "../sevdesk/errors.js";
import { MAX_OFFSET } from "./format.js";

export interface Presentation {
  /** One line for the reader, put in front of the JSON text. */
  readonly summary: string;
  /** Further content blocks, e.g. a PDF as embedded resource. */
  readonly content?: readonly ContentBlock[];
}

/** Upper bound of the summary line; summaries carry IDs and counts, not free text. */
export const MAX_SUMMARY_LENGTH = 300;

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
 * Budget for the text of one tool answer (summary line plus JSON). Texts are
 * capped per field, but a list of 100 entries with long texts still adds up;
 * this is the same bound the generic tool applies (MAX_RESPONSE_CHARS).
 */
export const MAX_TOOL_RESPONSE_CHARS = 100_000;

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** Arrays directly in the answer or one object level down, e.g. `invoice.positions`. */
function listPaths(data: Record<string, unknown>): string[][] {
  const paths: string[][] = [];
  for (const [key, value] of Object.entries(data)) {
    if (Array.isArray(value)) paths.push([key]);
    else if (isPlainObject(value)) {
      for (const [inner, innerValue] of Object.entries(value)) {
        if (Array.isArray(innerValue)) paths.push([key, inner]);
      }
    }
  }
  return paths;
}

function listAt(data: Record<string, unknown>, path: readonly string[]): unknown[] {
  const [key, inner] = path as [string, string?];
  const holder = inner === undefined ? data : (data[key] as Record<string, unknown>);
  return holder[inner ?? key] as unknown[];
}

/** Copy of `data` with the list at `path` cut to its first `kept` entries. */
function withList(
  data: Record<string, unknown>,
  path: readonly string[],
  kept: number,
): Record<string, unknown> {
  const [key, inner] = path as [string, string?];
  if (inner === undefined) return { ...data, [key]: (data[key] as unknown[]).slice(0, kept) };
  const holder = data[key] as Record<string, unknown>;
  return { ...data, [key]: { ...holder, [inner]: (holder[inner] as unknown[]).slice(0, kept) } };
}

interface Cut {
  readonly path: readonly string[];
  readonly kept: number;
  readonly total: number;
}

/**
 * Marks a cut answer: `truncated` and a note (appended to an existing one),
 * and for the list a page describes, the page's hasMore and nextOffset.
 *
 * nextOffset never skips a cut entry:
 * - the list is the page (its length is page.count): count becomes the
 *   entries kept and the next page starts right after them;
 * - the list was filtered from the page after fetching (search_orders with
 *   orderType, a top-level list shorter than page.count): the k-th kept
 *   entry sits at position k or later in the fetched page, so offset + k
 *   is at or before the first cut one. The next page may repeat entries,
 *   and the note says so.
 * With nothing kept there is no safe next offset, so it is null.
 */
function markCut(data: Record<string, unknown>, cuts: readonly Cut[]): Record<string, unknown> {
  const parts = cuts.map(
    (cut) => `${cut.path.join(".")}: first ${cut.kept} of ${cut.total} entries`,
  );
  let cutNote =
    `Answer cut to stay under ${MAX_TOOL_RESPONSE_CHARS} characters (${parts.join("; ")}). ` +
    "Use limit/offset or narrower filters for the rest.";
  const marked: Record<string, unknown> = { ...data, truncated: true };
  const page = data.page;
  if (isPlainObject(page) && typeof page.count === "number") {
    const count = page.count;
    const exact = cuts.find((cut) => cut.total === count);
    const filtered = exact
      ? undefined
      : cuts.find((cut) => cut.path.length === 1 && cut.kept <= count);
    const listed = exact ?? filtered;
    if (listed) {
      const next =
        typeof page.offset === "number" && listed.kept > 0 ? page.offset + listed.kept : null;
      marked.page = {
        ...page,
        ...(exact && { count: listed.kept }),
        hasMore: true,
        ...("nextOffset" in page && {
          nextOffset: next !== null && next <= MAX_OFFSET ? next : null,
        }),
      };
      if (filtered) {
        cutNote +=
          " The list was filtered after fetching, so page.nextOffset may repeat entries " +
          "already returned; it skips none.";
      }
    }
  }
  marked.note =
    typeof data.note === "string" && data.note !== "" ? `${data.note} ${cutNote}` : cutNote;
  return marked;
}

const OVER_BUDGET_NOTE = `This answer is over ${MAX_TOOL_RESPONSE_CHARS} characters and could not be cut further; narrow the request.`;

const CUT_SUMMARY = `Answer cut to fit ${MAX_TOOL_RESPONSE_CHARS} characters, see note.`;

interface Rendered {
  readonly data: Record<string, unknown>;
  readonly text: string;
}

function render(
  data: Record<string, unknown>,
  summary: string | undefined,
  cut: boolean,
): Rendered {
  const json = JSON.stringify(data);
  // The cut notice goes first: the summary is sliced, the notice must survive.
  const line = summary
    ? (cut ? `${CUT_SUMMARY} ${summary}` : summary).slice(0, MAX_SUMMARY_LENGTH)
    : undefined;
  return { data, text: line ? `${line}\n${json}` : json };
}

/**
 * Cuts lists, largest first, until summary line plus JSON fit the budget.
 * Always cuts whole entries and re-serializes, so the JSON stays valid and
 * the text and structuredContent describe the same data.
 *
 * Known limit: the budget is not absolute. If no list is left to cut (the
 * answer has none, or the rest is scalar fields and empty lists), the
 * answer goes out over budget and its note says so.
 */
function fitBudget(data: Record<string, unknown>, summary: string | undefined): Rendered {
  const whole = render(data, summary, false);
  if (whole.text.length <= MAX_TOOL_RESPONSE_CHARS) return whole;

  const candidates = listPaths(data)
    .map((path) => ({ path, size: JSON.stringify(listAt(data, path)).length }))
    .sort((a, b) => b.size - a.size);
  let current = data;
  const cuts: Cut[] = [];
  for (const { path } of candidates) {
    const total = listAt(current, path).length;
    if (total === 0) continue;
    const attempt = (kept: number) => {
      const cut = [...cuts, { path, kept, total }];
      return render(markCut(withList(current, path, kept), cut), summary, true);
    };
    let low = 0;
    let high = total - 1;
    while (low < high) {
      const mid = Math.ceil((low + high) / 2);
      if (attempt(mid).text.length <= MAX_TOOL_RESPONSE_CHARS) low = mid;
      else high = mid - 1;
    }
    const rendered = attempt(low);
    if (rendered.text.length <= MAX_TOOL_RESPONSE_CHARS) return rendered;
    // Even an empty list is not enough: keep it empty and cut the next one.
    cuts.push({ path, kept: low, total });
    current = withList(current, path, low);
  }
  const base = cuts.length === 0 ? data : markCut(current, cuts);
  const note = typeof base.note === "string" && base.note !== "" ? `${base.note} ` : "";
  return render({ ...base, note: `${note}${OVER_BUDGET_NOTE}` }, summary, cuts.length > 0);
}

/**
 * Successful tool result: structured data plus the same data as compact
 * JSON text for clients that do not pass structuredContent on, preceded by
 * the tool's summary line if it set one. Answers over
 * MAX_TOOL_RESPONSE_CHARS are cut list by list and marked truncated.
 */
export function okResult<T extends Record<string, unknown>>(data: T): CallToolResult {
  const presentation = presentations.get(data);
  // One line, so the JSON is always the second line, whatever a summary holds.
  const summary = presentation?.summary.replace(/\s+/g, " ").trim();
  const fitted = fitBudget(data, summary === "" ? undefined : summary);
  return {
    content: [{ type: "text", text: fitted.text }, ...(presentation?.content ?? [])],
    structuredContent: fitted.data,
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
