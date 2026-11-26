import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const root = fileURLToPath(new URL("../../", import.meta.url));

/** Exit 0 of `git check-ignore` means git will not track the path. */
function ignored(path: string): boolean {
  try {
    execFileSync("git", ["check-ignore", "-q", "--no-index", path], { cwd: root });
    return true;
  } catch {
    return false;
  }
}

describe(".gitignore", () => {
  it("keeps secret files out of git", () => {
    for (const path of [".env", ".env.local", ".envrc"]) expect(ignored(path), path).toBe(true);
    expect(ignored(".env.example")).toBe(false);
  });
});
