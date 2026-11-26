import { describe, expect, it } from "vitest";
import type { Mode } from "../../src/config.js";
import {
  allows,
  effectiveRights,
  type Rights,
  rightsForRequest,
  rightsFromScopes,
  SCOPES,
  subjectFor,
} from "../../src/policy/rights.js";

const R = SCOPES.read;
const W = SCOPES.write;
const X = SCOPES.irreversible;

describe("rightsFromScopes", () => {
  it.each([
    [[], "none"],
    [[R], "read"],
    [[R, W], "write"],
    [[R, W, X], "full"],
    // Write-only token: write does not imply read.
    [[W], "none"],
    [[W, X], "none"],
    // irreversible without write adds nothing.
    [[R, X], "read"],
    [[X], "none"],
    [["sevdesk:admin", "openid"], "none"],
  ] as const)("%j -> %s", (scopes, expected) => {
    expect(rightsFromScopes(scopes)).toBe(expected);
  });
});

describe("effectiveRights = min(mode, scopes)", () => {
  const modes: Mode[] = ["read", "write", "full"];
  const tokens: Array<[string, string[]]> = [
    ["no scopes", []],
    ["read", [R]],
    ["read+write", [R, W]],
    ["all", [R, W, X]],
    ["write only", [W]],
  ];
  const expected: Record<Mode, Rights[]> = {
    read: ["none", "read", "read", "read", "none"],
    write: ["none", "read", "write", "write", "none"],
    full: ["none", "read", "write", "full", "none"],
  };

  for (const mode of modes) {
    tokens.forEach(([label, scopes], index) => {
      it(`mode ${mode}, token ${label} -> ${expected[mode][index]}`, () => {
        expect(effectiveRights(mode, scopes)).toBe(expected[mode][index]);
      });
    });
    it(`mode ${mode} on stdio (no scopes involved) -> ${mode}`, () => {
      expect(effectiveRights(mode, undefined)).toBe(mode);
    });
  }
});

describe("allows", () => {
  it.each([
    ["none", "R", false],
    ["read", "R", true],
    ["read", "R+", true],
    ["read", "W", false],
    ["write", "W+", true],
    ["write", "X", false],
    ["full", "X", true],
  ] as const)("%s allows %s: %s", (rights, cls, expected) => {
    expect(allows(rights, cls)).toBe(expected);
  });
});

describe("rightsForRequest", () => {
  const auth = (scopes: string[]) => ({ token: "t", clientId: "c", scopes });

  it("uses the mode alone on stdio, ignoring any authInfo", () => {
    expect(rightsForRequest("write", "stdio", undefined)).toBe("write");
    expect(rightsForRequest("write", "stdio", auth([]))).toBe("write");
  });

  it("grants nothing on HTTP without a verified token", () => {
    expect(rightsForRequest("full", "http", undefined)).toBe("none");
  });

  it("grants nothing to an HTTP token that names neither sub nor client", () => {
    const anonymous = { token: "t", clientId: "", scopes: [R, W, X] };
    expect(rightsForRequest("full", "http", anonymous)).toBe("none");
    expect(rightsForRequest("full", "http", { ...anonymous, extra: { sub: "" } })).toBe("none");
    expect(rightsForRequest("full", "http", { ...anonymous, extra: { sub: "u1" } })).toBe("full");
  });

  it("takes the minimum on HTTP", () => {
    expect(rightsForRequest("full", "http", auth([R, W]))).toBe("write");
    expect(rightsForRequest("read", "http", auth([R, W, X]))).toBe("read");
  });
});

describe("subjectFor", () => {
  it("names stdio and HTTP callers", () => {
    expect(subjectFor("stdio", undefined)).toBe("stdio");
    expect(
      subjectFor("http", { token: "t", clientId: "app", scopes: [], extra: { sub: "u1" } }),
    ).toBe("sub:u1");
    expect(subjectFor("http", { token: "t", clientId: "app", scopes: [] })).toBe("client:app");
    expect(subjectFor("http", undefined)).toBeUndefined();
    expect(subjectFor("http", { token: "t", clientId: "", scopes: [] })).toBeUndefined();
  });
});
