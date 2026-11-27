import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const read = (path: string) =>
  readFileSync(fileURLToPath(new URL(`../../${path}`, import.meta.url)), "utf8");

const SWITCHER_TARGETS = new Set(["README.md", "README.de.md"]);
const FENCE = /^```[^\n]*\n[\s\S]*?^```$/gm;

/** Fenced code blocks in order, fences included. */
function codeBlocks(text: string): string[] {
  return [...text.matchAll(FENCE)].map((m) => m[0]);
}

/** The text outside code blocks, so a link-like string in a command does not count. */
function prose(text: string): string {
  return text.replace(FENCE, "");
}

/** GitHub's heading anchor: lower case, punctuation dropped, spaces to hyphens. */
function slug(heading: string): string {
  return heading
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s_-]/gu, "")
    .replace(/\s/g, "-");
}

/** Markdown headings (## and deeper) in order. */
function headings(text: string): string[] {
  return [...prose(text).matchAll(/^#{2,6}\s+(.+?)\s*$/gm)].map((m) => m[1] ?? "");
}

function h2Count(text: string): number {
  return [...prose(text).matchAll(/^##\s+\S/gm)].length;
}

/**
 * Every link target outside code blocks, Markdown and HTML alike. The language switcher is
 * left out. An anchor into the same file becomes the position of its heading, because the
 * heading text, and so the anchor, differs between the languages.
 */
function linkTargets(text: string): string[] {
  const body = prose(text);
  const anchors = headings(text).map(slug);
  const raw = [
    ...[...body.matchAll(/\]\(([^)\s]+)\)/g)].map((m) => m[1] ?? ""),
    ...[...body.matchAll(/\b(?:href|src)="([^"]+)"/g)].map((m) => m[1] ?? ""),
  ];
  return raw
    .filter((target) => !SWITCHER_TARGETS.has(target))
    .map((target) => {
      if (!target.startsWith("#")) return target;
      const index = anchors.indexOf(target.slice(1));
      if (index === -1) throw new Error(`anchor ${target} matches no heading`);
      return `#heading-${index}`;
    });
}

/** The first line after the HTML header: not blank, not HTML, not indented header text. */
function firstProseLine(text: string): string | undefined {
  return text.split("\n").find((line) => line.trim() !== "" && !/^(\s|<)/.test(line));
}

const en = read("README.md");
const de = read("README.de.md");

describe("README translations", () => {
  it("have the same number of sections", () => {
    expect(h2Count(en)).toBeGreaterThan(0);
    expect(h2Count(de)).toBe(h2Count(en));
    expect(headings(de)).toHaveLength(headings(en).length);
  });

  it("link to the same targets", () => {
    const targets = linkTargets(en);
    expect(targets.length).toBeGreaterThan(0);
    expect(new Set(linkTargets(de))).toEqual(new Set(targets));
  });

  it("keep every code block identical", () => {
    const blocks = codeBlocks(en);
    expect(blocks.length).toBeGreaterThan(0);
    expect(codeBlocks(de)).toEqual(blocks);
  });

  it("link to each other right under the header", () => {
    expect(firstProseLine(en)).toBe("**English** · [Deutsch](README.de.md)");
    expect(firstProseLine(de)).toBe("[English](README.md) · **Deutsch**");
  });

  it("link to the privacy policy", () => {
    expect(linkTargets(en)).toContain("PRIVACY.md");
    expect(linkTargets(de)).toContain("PRIVACY.md");
  });
});

describe("README drift helpers", () => {
  it("map anchors by heading position", () => {
    const text = "## Eins\n\n## Dein API-Token\n\n[x](#dein-api-token) [y](docs/a.md#b)\n";
    expect(linkTargets(text)).toEqual(["#heading-1", "docs/a.md#b"]);
  });

  it("reject an anchor without a heading", () => {
    expect(() => linkTargets("## Eins\n\n[x](#zwei)\n")).toThrow(/matches no heading/);
  });

  it("ignore links and headings inside code blocks", () => {
    const text = "## A\n\n```sh\n## not a heading [x](y.md)\n```\n";
    expect(headings(text)).toEqual(["A"]);
    expect(linkTargets(text)).toEqual([]);
  });

  it("drop the language switcher and read HTML links", () => {
    const text = '<a href="LICENSE"><img src="a.svg"></a>\n\n[English](README.md) · **Deutsch**\n';
    expect(linkTargets(text)).toEqual(["LICENSE", "a.svg"]);
  });
});
