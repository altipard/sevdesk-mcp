import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const root = fileURLToPath(new URL("../../", import.meta.url));
const workflowDir = join(root, ".github/workflows");
const workflows = readdirSync(workflowDir)
  .filter((name) => name.endsWith(".yml"))
  .map((name) => ({ name, text: readFileSync(join(workflowDir, name), "utf8") }));

describe("workflows", () => {
  // Jobs without a checkout cannot read .nvmrc and name the version themselves.
  it("pin the same Node major as .nvmrc wherever they name one", () => {
    const nvmrc = readFileSync(join(root, ".nvmrc"), "utf8").trim();
    const pinned = workflows.flatMap(({ name, text }) =>
      [...text.matchAll(/^\s*node-version:\s*["']?([^"'\s#]+)["']?/gm)].map((m) => ({
        name,
        version: m[1],
      })),
    );
    expect(pinned.map((p) => p.name)).toContain("release.yml");
    for (const { name, version } of pinned) expect(version, name).toBe(nvmrc);
  });

  it("pin every action to a full commit SHA with an exact version comment", () => {
    for (const { name, text } of workflows) {
      for (const [line] of text.matchAll(/^\s*-?\s*uses:.*$/gm)) {
        expect(line, name).toMatch(/uses: [\w.-]+\/[\w.-]+@[0-9a-f]{40} # v\d+\.\d+\.\d+$/);
      }
    }
  });
});
