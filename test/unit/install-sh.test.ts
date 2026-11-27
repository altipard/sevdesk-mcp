import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const root = fileURLToPath(new URL("../../", import.meta.url));
const script = readFileSync(new URL("install.sh", `file://${root}`), "utf8");

function run(args: string[], env: Record<string, string> = {}) {
  // No HOME tricks needed: --help and --dry-run neither download nor write.
  return spawnSync("sh", ["install.sh", ...args], {
    cwd: root,
    encoding: "utf8",
    env: { PATH: process.env.PATH ?? "", HOME: "/home/test", LANG: "C", ...env },
    timeout: 10_000,
  });
}

describe("install.sh", () => {
  it("embeds the owl of assets/logo/sevdesk-mcp.txt, cropped to its visible pixels", () => {
    const grid = readFileSync(new URL("assets/logo/sevdesk-mcp.txt", `file://${root}`), "utf8")
      .split("\n")
      .filter((line) => line !== "" && !line.startsWith("#"));
    const rows = grid.filter((row) => /[^.]/.test(row));
    const cols = [...(rows[0] ?? "")]
      .map((_, i) => i)
      .filter((i) => rows.some((r) => r[i] !== "."));
    const cropped = rows.map((row) => row.slice(cols[0], (cols.at(-1) ?? 0) + 1));
    const embedded = script.match(/<<'ART'\n([\s\S]*?)\nART\n/)?.[1]?.split("\n");
    expect(embedded).toEqual(cropped);
    // Half blocks combine two pixel rows into one terminal row.
    expect(cropped.length % 2).toBe(0);
  });

  it("knows every palette letter of the logo", () => {
    const letters = new Set(script.match(/<<'ART'\n([\s\S]*?)\nART\n/)?.[1]?.replace(/[.\n]/g, ""));
    for (const letter of letters)
      expect(script).toMatch(new RegExp(`^\\s+${letter}\\) p_rgb=`, "m"));
  });

  it("prints help", () => {
    const result = run(["--help"]);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("INSTALL_DIR");
    expect(result.stdout).toContain("SEVDESK_MCP_VERSION");
  });

  it("does a dry run without network access", () => {
    const result = run(["--dry-run"], { SEVDESK_MCP_VERSION: "v0.2.0", INSTALL_DIR: "/opt/x/" });
    expect(result.status).toBe(0);
    expect(result.stdout).toMatch(
      /releases\/download\/0\.2\.0\/sevdesk-mcp-(darwin|linux)-(arm64|x64)\n/,
    );
    // The dry run names both candidates and the rule that picks between them.
    expect(result.stdout).toMatch(
      /package: {3}sevdesk-mcp-(darwin|linux)-(arm64|x64)\.tar\.xz when it is listed/,
    );
    expect(result.stdout).toContain("releases/download/0.2.0/SHA256SUMS");
    expect(result.stdout).toContain("target:    /opt/x/sevdesk-mcp");
    expect(run(["--dry-run"]).stdout).toContain("target:    /home/test/.local/bin/sevdesk-mcp");
  });

  it("refuses unknown options, relative targets and odd versions", () => {
    expect(run(["--bogus"]).status).toBe(2);
    const relative = run(["--dry-run"], { INSTALL_DIR: "bin" });
    expect(relative.status).toBe(1);
    expect(relative.stderr).toContain("INSTALL_DIR must be an absolute path");
    const quote = run(["--dry-run"], { INSTALL_DIR: '/tmp/a"b' });
    expect(quote.status).toBe(1);
    const version = run(["--dry-run"], { SEVDESK_MCP_VERSION: "1.0/../x" });
    expect(version.status).toBe(1);
    expect(version.stderr).toContain("invalid release version");
  });

  it("accepts read, write and full as mode and refuses anything else", () => {
    expect(run(["--dry-run", "--mode=write"]).status).toBe(0);
    expect(run(["--dry-run"], { SEVDESK_MODE: "full" }).status).toBe(0);
    const flag = run(["--dry-run", "--mode=admin"]);
    expect(flag.status).toBe(1);
    expect(flag.stderr).toContain("unknown mode 'admin'");
    // The option wins over the environment.
    expect(run(["--dry-run", "--mode=read"], { SEVDESK_MODE: "bogus" }).status).toBe(0);
    // Without setup the variable is not used, so it cannot break an install.
    expect(run(["--dry-run", "--no-setup"], { SEVDESK_MODE: "bogus" }).status).toBe(0);
  });

  it("accepts the setup options", () => {
    const result = run(["--dry-run", "--no-setup", "--replace-token", "--no-verify"]);
    expect(result.status).toBe(0);
    expect(run(["--help"]).stdout).toMatch(/--replace-token[\s\S]*--no-verify/);
  });
});
