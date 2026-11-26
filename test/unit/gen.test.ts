import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";

// Runs scripts/gen.mjs against modified copies of the overlay to prove that
// spec drift stops code generation instead of passing silently.

const GEN = fileURLToPath(new URL("../../scripts/gen.mjs", import.meta.url));
const OVERLAY = readFileSync(new URL("../../openapi/overlay.yaml", import.meta.url), "utf8");
const work = mkdtempSync(join(tmpdir(), "sevdesk-mcp-gen-"));

afterAll(() => rmSync(work, { recursive: true, force: true }));

function gen(overlay: string, name: string) {
  const overlayPath = join(work, `${name}.yaml`);
  const out = join(work, name);
  writeFileSync(overlayPath, overlay);
  const run = spawnSync(process.execPath, [GEN, "--overlay", overlayPath, "--out", out], {
    encoding: "utf8",
  });
  return { ...run, out };
}

describe("npm run gen", () => {
  it("applies the committed overlay", () => {
    const run = gen(OVERLAY, "ok");
    expect(run.status).toBe(0);
    expect(existsSync(join(run.out, "sevdesk.d.ts"))).toBe(true);
  });

  it("fails when a single-path action no longer matches", () => {
    const drifted = OVERLAY.replace(
      `"$.paths['/Part'].get.parameters"`,
      `"$.paths['/PartRenamed'].get.parameters"`,
    );
    expect(drifted).not.toBe(OVERLAY);

    const run = gen(drifted, "drift");

    expect(run.status).toBe(1);
    expect(run.stderr).toContain(
      "overlay action matched nothing: Pagination and embed on GET /Part",
    );
    expect(existsSync(join(run.out, "sevdesk.d.ts"))).toBe(false);
  });

  it("targets one path per action, so partial matches cannot hide drift", () => {
    for (const match of OVERLAY.matchAll(/target: "\$\.paths\[([^\]]*)\]/g)) {
      expect(match[1]?.split(",")).toHaveLength(1);
    }
  });
});
