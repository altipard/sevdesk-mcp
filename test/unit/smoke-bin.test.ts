import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { TOOLS } from "../../src/tools/index.js";

// scripts/smoke-bin.mjs starts the compiled binary and cannot import the
// sources, so it writes the tool names out. This keeps them in line.
const script = readFileSync(
  fileURLToPath(new URL("../../scripts/smoke-bin.mjs", import.meta.url)),
  "utf8",
);

function listed(name: string): string[] {
  const match = script.match(new RegExp(`const ${name} = \\[([^\\]]*)\\]`));
  if (!match) throw new Error(`${name} not found in smoke-bin.mjs`);
  return [...(match[1] ?? "").matchAll(/"([a-z_]+)"/g)].map((m) => m[1] as string);
}

describe("smoke-bin", () => {
  it("expects every irreversible tool, and enables exactly those", () => {
    const x = TOOLS.filter((tool) => tool.class === "X").map((tool) => tool.name);
    expect(listed("X_TOOLS").sort()).toEqual([...x].sort());
  });

  it("expects every write tool in full mode", () => {
    const writes = TOOLS.filter((tool) => tool.class !== "R" && tool.class !== "R+")
      .filter((tool) => tool.class !== "X")
      .map((tool) => tool.name);
    expect(listed("WRITE_TOOLS").sort()).toEqual([...writes].sort());
    expect(script).toContain("...X_TOOLS,");
  });
});
