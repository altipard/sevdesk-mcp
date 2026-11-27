/**
 * Strict check for JSON with comments, as MCP clients write it (VS Code, Zed, Cursor): line and
 * block comments and trailing commas are allowed, anything else must be valid JSON. The writer
 * of add-mcp parses leniently and would rewrite a broken file; this check keeps such a file
 * untouched. Returns the parsed value or throws.
 */
export function parseJsonc(text: string): unknown {
  return JSON.parse(stripJsonc(text.replace(/^﻿/, "")));
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

/** Removes comments and trailing commas outside of strings. */
function stripJsonc(text: string): string {
  let out = "";
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
  return out;
}
