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

  // npm reads a bare "dir/file.tgz" as a GitHub user/repo shorthand and runs git ls-remote.
  it("hand npm publish only tarball paths that start with ./ or /", () => {
    let publishes = 0;
    for (const { name, text } of workflows) {
      // Tarball paths assigned in the workflow, which publish later reads via a variable.
      for (const [, path = ""] of text.matchAll(/set -- (\S*\.tgz)/g)) {
        expect(path, `${name}: ${path}`).toMatch(/^(\.\/|\/)/);
      }
      for (const [, arg = ""] of text.matchAll(/npm publish\s+(?!-)(\S+)/g)) {
        publishes++;
        const literal = arg.replace(/^"|"$/g, "");
        if (!literal.startsWith("$")) expect(literal, name).toMatch(/^(\.\/|\/)/);
      }
    }
    expect(publishes).toBeGreaterThan(0);
  });
});

describe("release workflow", () => {
  const release = workflows.find((w) => w.name === "release.yml")?.text ?? "";
  /** The body of one job: from its key to the next job key or the end of the file. */
  const job = (name: string): string => {
    const start = release.search(new RegExp(`^  ${name}:$`, "m"));
    if (start === -1) throw new Error(`job ${name} not found in release.yml`);
    const rest = release.slice(start + 1);
    const next = rest.search(/^ {2}[\w-]+:$/m);
    return next === -1 ? rest : rest.slice(0, next);
  };

  it("builds the Claude Desktop extension and smoke-tests it", () => {
    const mcpb = job("mcpb");
    expect(mcpb).toContain("needs: [version, check]");
    expect(mcpb).toContain('npm version --no-git-tag-version --allow-same-version "$VERSION"');
    expect(mcpb).toContain("npm run build:mcpb");
    expect(mcpb).toContain("node scripts/smoke-mcpb.mjs out/mcpb/sevdesk-mcp.mcpb");
    // The artifact name must match the sevdesk-mcp-* pattern attest and the release download.
    expect(mcpb).toMatch(/name: sevdesk-mcp-mcpb\n\s+path: out\/mcpb\/sevdesk-mcp\.mcpb\n/);
  });

  it("attests the extension with the binaries", () => {
    const attest = job("attest");
    expect(attest).toMatch(/needs: \[[^\]]*\bmcpb\b[^\]]*\]/);
    expect(attest).toMatch(
      /subject-path: \|\n\s+assets\/sevdesk-mcp-\*\n\s+assets\/sevdesk-mcp\.mcpb\n/,
    );
  });

  // One list drives SHA256SUMS, the completeness check on a rerun and the upload of what is missing.
  it("publishes the extension and covers it by SHA256SUMS", () => {
    const step = job("github-release");
    const files = step.match(/^\s+files=\(([^)]*)\)$/m)?.[1]?.split(/\s+/) ?? [];
    expect(files).toEqual([
      "sevdesk-mcp-darwin-arm64",
      "sevdesk-mcp-darwin-x64",
      "sevdesk-mcp-linux-x64",
      "sevdesk-mcp-linux-arm64",
      "sevdesk-mcp.mcpb",
    ]);
    expect(step.match(/sha256sum "\$\{files\[@\]\}" > SHA256SUMS/g)).toHaveLength(2);
    expect(step).toMatch(/for name in "\$\{files\[@\]\}" SHA256SUMS; do/);
    expect(step).toContain('gh release upload "$VERSION" "assets/$name"');
  });
});
