/**
 * Strict check for JSON with comments, as MCP clients write it (VS Code, Zed, Cursor): line and
 * block comments and trailing commas are allowed, anything else must be valid JSON. The writer
 * of add-mcp parses leniently and would rewrite a broken file; this check keeps such a file
 * untouched. Returns the parsed value or throws.
 */
export function parseJsonc(text: string): unknown {
  return JSON.parse(stripJsonc(text.replace(/^\uFEFF/, "")).text);
}

/**
 * Number of comment groups (consecutive comments count once) in JSON-with-comments text; 0 for
 * text that cannot be scanned. Only used to tell whether comments disappeared.
 */
export function countJsoncComments(text: string): number {
  try {
    return stripJsonc(text).comments;
  } catch {
    return 0;
  }
}

/**
 * Number of `#` comments in TOML or YAML text: a `#` outside a quoted string. Multi-line strings
 * are not tracked; the count only has to tell whether comments disappeared.
 */
export function countHashComments(text: string): number {
  let count = 0;
  for (const line of text.split("\n")) {
    let quote: string | undefined;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (quote) {
        if (ch === "\\" && quote === '"') i++;
        else if (ch === quote) quote = undefined;
      } else if (ch === '"' || ch === "'") {
        quote = ch;
      } else if (ch === "#") {
        count++;
        break;
      }
    }
  }
  return count;
}

/** Index after the blanks and comments starting at `from`; -1 for an unterminated comment. */
function skipTrivia(text: string, from: number): number {
  let j = from;
  for (;;) {
    while (j < text.length && /\s/.test(text[j] ?? "")) j++;
    if (text[j] === "/" && text[j + 1] === "/") {
      while (j < text.length && text[j] !== "\n") j++;
    } else if (text[j] === "/" && text[j + 1] === "*") {
      const end = text.indexOf("*/", j + 2);
      if (end === -1) return -1;
      j = end + 2;
    } else {
      return j;
    }
  }
}

/** Removes comments and trailing commas outside of strings, counting the comments. */
function stripJsonc(text: string): { text: string; comments: number } {
  let out = "";
  let comments = 0;
  let i = 0;
  const n = text.length;
  while (i < n) {
    const ch = text[i];
    if (ch === '"') {
      const start = i;
      i++;
      while (i < n && text[i] !== '"') {
        if (text[i] === "\\") i++;
        i++;
      }
      // An unterminated string is left for JSON.parse to reject.
      out += text.slice(start, i + 1);
      i++;
      continue;
    }
    if (ch === "/" && (text[i + 1] === "/" || text[i + 1] === "*")) {
      const next = skipTrivia(text, i);
      if (next === -1) throw new SyntaxError("unterminated block comment");
      comments++;
      // Keep a separator so that `1/**/2` does not turn into `12`.
      out += " ";
      i = next;
      continue;
    }
    if (ch === ",") {
      const next = skipTrivia(text, i + 1);
      if (next !== -1 && (text[next] === "}" || text[next] === "]")) {
        i++;
        continue;
      }
    }
    out += ch;
    i++;
  }
  return { text: out, comments };
}
