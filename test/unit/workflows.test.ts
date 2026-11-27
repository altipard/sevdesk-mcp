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

  it("attests the archives together with the binaries and the extension", () => {
    const attest = job("attest");
    expect(attest).toMatch(/needs: \[[^\]]*\bmcpb\b[^\]]*\]/);
    expect(attest).toMatch(/needs: \[[^\]]*\barchives\b[^\]]*\]/);
    // The subject-path glob also covers the sevdesk-mcp-*<os>-<arch>.tar.xz artifacts.
    expect(attest).toMatch(
      /subject-path: \|\n\s+assets\/sevdesk-mcp-\*\n\s+assets\/sevdesk-mcp\.mcpb\n/,
    );
  });

  // The archives are what install.sh prefers: packed with GNU tar on Linux (macOS bsdtar
  // would add xattrs and ._ entries), with fixed metadata for a reproducible build, and
  // verified complete before they are uploaded.
  it("packs every target into a reproducible tar.xz and verifies it", () => {
    const archives = job("archives");
    expect(archives).toContain("needs: [version, binaries]");
    expect(archives).toMatch(/^ {4}if: needs\.version\.outputs\.version != ''$/m);
    expect(archives).toContain("runs-on: ubuntu-24.04");
    expect(archives).toMatch(/target: \[darwin-arm64, darwin-x64, linux-x64, linux-arm64\]/);
    // download-artifact drops the executable bit; the member must be 0755.
    expect(archives).toContain('chmod 755 "in/sevdesk-mcp-$TARGET"');
    expect(archives).toContain("--format=gnu");
    expect(archives).toContain("--owner=0");
    expect(archives).toContain("--group=0");
    expect(archives).toContain("--numeric-owner");
    expect(archives).toContain("--mtime='@0'");
    expect(archives).toContain("--mode=0755");
    expect(archives).toMatch(/-cJf "out\/sevdesk-mcp-\$TARGET\.tar\.xz" sevdesk-mcp/);
    // Complete before upload: one member, byte-identical to the binary, fixed mode and mtime.
    const at = (text: string) => archives.indexOf(text);
    const listing = at('tar -tJf "out/sevdesk-mcp-$TARGET.tar.xz"');
    const extract = at('tar -xJf "out/sevdesk-mcp-$TARGET.tar.xz" -C "$verify"');
    const compare = at('cmp "$verify/sevdesk-mcp" "in/sevdesk-mcp-$TARGET"');
    expect(listing).toBeGreaterThan(-1);
    expect(extract).toBeGreaterThan(listing);
    expect(compare).toBeGreaterThan(extract);
    expect(archives).toContain("expected 755 and 0");
    // The artifact name matches the sevdesk-mcp-* pattern of attest and the release download.
    expect(archives).toMatch(
      /name: sevdesk-mcp-\$\{\{ matrix\.target \}\}\.tar\.xz\n\s+path: out\/sevdesk-mcp-\$\{\{ matrix\.target \}\}\.tar\.xz\n/,
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
      "sevdesk-mcp-darwin-arm64.tar.xz",
      "sevdesk-mcp-darwin-x64.tar.xz",
      "sevdesk-mcp-linux-x64.tar.xz",
      "sevdesk-mcp-linux-arm64.tar.xz",
      "sevdesk-mcp.mcpb",
    ]);
    expect(step.match(/sha256sum "\$\{files\[@\]\}" > SHA256SUMS/g)).toHaveLength(2);
    expect(step).toMatch(/for name in "\$\{files\[@\]\}" SHA256SUMS; do/);
    expect(step).toContain('gh release upload "$VERSION" "assets/$name"');
  });

  describe("MCP registry job", () => {
    const registry = job("mcp-registry");
    const at = (text: string) => {
      const index = registry.indexOf(text);
      if (index === -1) throw new Error(`mcp-registry lacks: ${text}`);
      return index;
    };

    // Same gate as npm: no release version, no publish. The registry checks mcpName in the
    // published package, so it can only follow the npm job.
    it("runs only for a release and after the npm publish", () => {
      expect(registry).toContain("needs: [version, npm]");
      expect(registry).toMatch(/^ {4}if: needs\.version\.outputs\.version != ''$/m);
      expect(job("npm")).toMatch(/^ {4}if: needs\.version\.outputs\.version != ''$/m);
    });

    it("gets the OIDC token for the registry login and nothing more", () => {
      expect(registry).toMatch(/permissions:\n\s+contents: read\n\s+id-token: write\n/);
      expect(registry).toContain("persist-credentials: false");
    });

    it("downloads a pinned mcp-publisher and checks it before running it", () => {
      expect(registry).toMatch(/^\s+MCP_PUBLISHER_VERSION: v\d+\.\d+\.\d+$/m);
      expect(registry).toMatch(/^\s+MCP_PUBLISHER_SHA256: [0-9a-f]{64}$/m);
      expect(registry).not.toContain("releases/latest");
      expect(registry).toContain(
        "https://github.com/modelcontextprotocol/registry/releases/download/$MCP_PUBLISHER_VERSION/mcp-publisher_linux_amd64.tar.gz",
      );
      expect(registry).toContain("--proto '=https'");
      const check = at('echo "$MCP_PUBLISHER_SHA256  $archive" | sha256sum -c -');
      expect(at('tar -xzf "$archive"')).toBeGreaterThan(check);
    });

    it("stamps the release version, waits for npm, then logs in and publishes", () => {
      const stamp = at(
        "jq --arg v \"$VERSION\" '.version = $v | .packages[].version = $v' server.json",
      );
      const wait = at('npm view "$PACKAGE@$VERSION" mcpName');
      const download = at("sha256sum -c -");
      const login = at('"$RUNNER_TEMP/mcp-publisher" login github-oidc');
      const publish = at('"$RUNNER_TEMP/mcp-publisher" publish');
      expect(stamp).toBeLessThan(wait);
      expect(wait).toBeLessThan(download);
      expect(download).toBeLessThan(login);
      expect(login).toBeLessThan(publish);
    });

    // A published version is immutable; a rerun of a completed release must not fail on it.
    it("skips a version the registry already has", () => {
      const lookup = at(
        "https://registry.modelcontextprotocol.io/v0.1/servers/$encoded/versions/$VERSION",
      );
      const skip = at('is already in the MCP registry; nothing to publish"\n              exit 0');
      expect(lookup).toBeLessThan(skip);
      expect(skip).toBeLessThan(at("login github-oidc"));
    });
  });
});

describe("ci workflow", () => {
  const ci = workflows.find((w) => w.name === "ci.yml")?.text ?? "";

  // A broken bundle must fail the pull request, not only the release after the merge.
  it("builds and smoke-tests the Claude Desktop extension on every run", () => {
    const start = ci.search(/^ {2}mcpb:$/m);
    expect(start).toBeGreaterThan(-1);
    const rest = ci.slice(start + 1);
    const next = rest.search(/^ {2}[\w-]+:$/m);
    const job = next === -1 ? rest : rest.slice(0, next);
    expect(job).not.toMatch(/^\s+if:/m);
    expect(job).toContain("npm ci --ignore-scripts");
    expect(job.indexOf("npm run build:mcpb")).toBeGreaterThan(-1);
    expect(job.indexOf("npm run smoke:mcpb")).toBeGreaterThan(job.indexOf("npm run build:mcpb"));
  });
});
