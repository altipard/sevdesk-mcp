import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentType } from "add-mcp";
import { describe, expect, it } from "vitest";
import {
  type ExecFileFn,
  type KeychainResult,
  type StdinRunner,
  storeKeychainToken,
} from "../../src/keychain.js";
import {
  type AddMcp,
  classifyEntry,
  detectAgents,
  detectLaunch,
  NPX_LAUNCH,
  onPath,
} from "../../src/setup/agents.js";
import { parseSetupArgs, UsageError } from "../../src/setup/args.js";
import { parseJsonc } from "../../src/setup/jsonc.js";
import { checkToken, TOKEN_CHECK_URL, tokenFormatProblem } from "../../src/setup/token.js";

const TOKEN = "0123456789abcdef0123456789abcdef";

describe("parseJsonc", () => {
  it("allows comments and trailing commas, keeps strings as they are", () => {
    expect(
      parseJsonc(
        '\uFEFF{\n // a\n "u": "http://x/*y*/", /* b */ "l": [1, 2,],\n "s": "a,}" ,\n}\n',
      ),
    ).toEqual({ u: "http://x/*y*/", l: [1, 2], s: "a,}" });
    expect(parseJsonc('{"a": "\\"//"}')).toEqual({ a: '"//' });
  });

  it.each([
    "{ not json",
    '{"a": 1,, }',
    '{"a": 1 /* open',
    '{"a": "open',
    "[1 2]",
    '{"a": 1}{"b": 2}',
  ])("rejects %j", (text) => {
    expect(() => parseJsonc(text)).toThrow();
  });
});

describe("token format", () => {
  it("accepts 32 hex characters with surrounding blanks", () => {
    expect(tokenFormatProblem(` ${TOKEN.toUpperCase()}\n`)).toBeUndefined();
  });

  it("explains a malformed token without repeating it", () => {
    expect(tokenFormatProblem("abc")).toBe("expected 32 hex characters, got 3 characters");
    const problem = tokenFormatProblem(`${TOKEN.slice(0, 31)}z`);
    expect(problem).toContain("other than hex");
    expect(problem).not.toContain(TOKEN.slice(0, 31));
  });
});

describe("checkToken", () => {
  const respond = (status: number) =>
    (async () => new Response("{}", { status })) as unknown as typeof fetch;

  it("sends the token only in the header of a GET, with a timeout and no redirects", async () => {
    const calls: [string, RequestInit][] = [];
    const fake = (async (url: string, init: RequestInit) => {
      calls.push([url, init]);
      return new Response("{}", { status: 200 });
    }) as unknown as typeof fetch;
    expect(await checkToken(TOKEN, { fetch: fake })).toEqual({ status: "accepted" });
    const [url, init] = calls[0] ?? ["", {}];
    expect(url).toBe(TOKEN_CHECK_URL);
    expect(url).not.toContain(TOKEN);
    expect(init.method).toBe("GET");
    expect(init.headers).toEqual({ Authorization: TOKEN, Accept: "application/json" });
    expect(init.redirect).toBe("error");
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  it("tells accepted, rejected and unchecked apart", async () => {
    expect(await checkToken(TOKEN, { fetch: respond(401) })).toEqual({ status: "rejected" });
    expect(await checkToken(TOKEN, { fetch: respond(500) })).toEqual({
      status: "unchecked",
      detail: "HTTP 500",
    });
    const down = (async () => {
      throw new TypeError(`fetch failed ${TOKEN}`);
    }) as unknown as typeof fetch;
    expect(await checkToken(TOKEN, { fetch: down })).toEqual({
      status: "unchecked",
      detail: "no connection",
    });
  });

  it("gives up after the timeout", async () => {
    const hang = ((_url: string, init: RequestInit) =>
      new Promise((_resolve, reject) => {
        init.signal?.addEventListener("abort", () => reject(init.signal?.reason));
      })) as unknown as typeof fetch;
    expect(await checkToken(TOKEN, { fetch: hang, timeoutMs: 10 })).toEqual({
      status: "unchecked",
      detail: "timed out",
    });
  });
});

describe("parseSetupArgs", () => {
  it("reads every option", () => {
    expect(
      parseSetupArgs([
        "--agents=cursor, claude-code",
        "--scope=project",
        "--mode=write",
        "--no-verify",
        "-y",
        "--replace-entries",
        "--replace-token",
        "--token-stdin",
        "--skill",
      ]),
    ).toEqual({
      help: false,
      agents: ["cursor", "claude-code"],
      scope: "project",
      mode: "write",
      verify: false,
      yes: true,
      replaceEntries: true,
      replaceToken: true,
      tokenStdin: true,
      skipToken: false,
      skill: true,
    });
    expect(parseSetupArgs(["--no-skill"]).skill).toBe(false);
    expect(parseSetupArgs([]).skill).toBeUndefined();
  });

  it.each([
    [["--scope=user"]],
    [["--mode=admin"]],
    [["--agents="]],
    [["--skill", "--no-skill"]],
    [["--token-stdin", "--skip-token"]],
    [["extra"]],
    [["--token=abc"]],
  ])("refuses %j", (argv) => {
    expect(() => parseSetupArgs(argv)).toThrow(UsageError);
  });
});

describe("classifyEntry", () => {
  const launch = { command: "/bin/sevdesk-mcp", args: [] };

  it("recognises remote entries in every spelling", () => {
    for (const entry of [
      { url: "https://x" },
      { serverUrl: "https://x" },
      { httpUrl: "https://x" },
      { uri: "https://x", type: "streamable_http" },
      { type: "http", command: "/bin/sevdesk-mcp" },
      { type: "remote" },
      { transport: "sse" },
    ]) {
      expect(classifyEntry(entry, launch)).toEqual({ kind: "remote" });
    }
  });

  it("reads command and env in each agent's shape", () => {
    expect(classifyEntry({ command: "/bin/sevdesk-mcp", env: { A: "1", N: 2 } }, launch)).toEqual({
      kind: "ours",
      env: { A: "1" },
    });
    expect(
      classifyEntry(
        { type: "local", command: ["/bin/sevdesk-mcp"], environment: { A: "1" } },
        launch,
      ),
    ).toEqual({ kind: "ours", env: { A: "1" } });
    expect(classifyEntry({ cmd: "/bin/sevdesk-mcp", args: [], envs: { A: "1" } }, launch)).toEqual({
      kind: "ours",
      env: { A: "1" },
    });
    expect(classifyEntry({ command: "/bin/sevdesk-mcp", args: ["--x"] }, launch).kind).toBe(
      "custom",
    );
    expect(
      classifyEntry({ command: "npx", args: ["-y", "@altipard/sevdesk-mcp"] }, NPX_LAUNCH),
    ).toEqual({
      kind: "ours",
      env: {},
    });
    expect(classifyEntry(undefined, launch)).toEqual({ kind: "none" });
  });
});

describe("detectLaunch", () => {
  it("uses the binary itself when compiled, npx otherwise", () => {
    expect(
      detectLaunch("file:///$bunfs/root/sevdesk-mcp", "/home/u/.local/bin/sevdesk-mcp"),
    ).toEqual({
      command: "/home/u/.local/bin/sevdesk-mcp",
      args: [],
    });
    expect(
      detectLaunch(
        "file:///x/node_modules/@altipard/sevdesk-mcp/dist/bin/stdio.js",
        "/usr/bin/node",
      ),
    ).toEqual(NPX_LAUNCH);
  });
});

describe("detectAgents", () => {
  const fakeAddMcp = (found: AgentType[]) =>
    ({
      agents: Object.fromEntries(
        (["claude-code", "claude-desktop", "codex", "cursor", "vscode"] as AgentType[]).map((a) => [
          a,
          {},
        ]),
      ),
      detectGlobalAgents: async () => found,
    }) as unknown as AddMcp;

  it("adds agents found only by their app bundle or CLI, in add-mcp's order", async () => {
    const bin = mkdtempSync(join(tmpdir(), "sevdesk-mcp-path-"));
    for (const cli of ["claude", "code"]) {
      writeFileSync(join(bin, cli), "#!/bin/sh\n");
      chmodSync(join(bin, cli), 0o755);
    }
    const detected = await detectAgents(fakeAddMcp(["codex"]), {
      platform: "darwin",
      home: "/home/u",
      path: bin,
      exists: (path) => path === "/home/u/Applications/Claude.app",
    });
    expect(detected).toEqual(["claude-code", "claude-desktop", "codex", "vscode"]);
  });

  it("ignores app bundles off macOS and non-executable files on PATH", async () => {
    const bin = mkdtempSync(join(tmpdir(), "sevdesk-mcp-path-"));
    writeFileSync(join(bin, "cursor"), "");
    mkdirSync(join(bin, "claude"));
    expect(onPath("cursor", bin)).toBe(false);
    const detected = await detectAgents(fakeAddMcp([]), {
      platform: "linux",
      home: "/home/u",
      path: bin,
      exists: () => true,
    });
    expect(detected).toEqual([]);
  });
});

describe("storeKeychainToken", () => {
  function fakeRunner(code: number | "missing" | null = 0) {
    const calls: { file: string; args: readonly string[]; input: string; env: object }[] = [];
    const run: StdinRunner = async (file, args, input, options) => {
      calls.push({ file, args, input, env: options.env });
      return code;
    };
    return { run, calls };
  }
  const readBack =
    (result: KeychainResult): ExecFileFn =>
    (_file, _args, _options, callback) => {
      queueMicrotask(() =>
        result.status === "found"
          ? callback(null, `${result.token}\n`, "")
          : callback(Object.assign(new Error("x"), { code: 44 }), "", ""),
      );
    };

  it("passes the token to security on stdin only and reads it back", async () => {
    const { run, calls } = fakeRunner();
    const result = await storeKeychainToken(TOKEN, {
      platform: "darwin",
      run,
      execFile: readBack({ status: "found", token: TOKEN }),
      env: { PATH: "/usr/bin", SEVDESK_API_TOKEN: TOKEN, SEVDESK_CONFIRM_SECRET: "s" },
    });
    expect(result).toEqual({ status: "stored" });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.file).toBe("/usr/bin/security");
    expect(calls[0]?.args).toEqual(["-i"]);
    expect(calls[0]?.args.join(" ")).not.toContain(TOKEN);
    expect(calls[0]?.input).toBe(
      `add-generic-password -U -s sevdesk-mcp -a api-token -l sevdesk-mcp -w ${TOKEN}\n`,
    );
    expect(calls[0]?.env).toEqual({ PATH: "/usr/bin" });
  });

  it("passes the token to secret-tool on stdin only", async () => {
    const { run, calls } = fakeRunner();
    await storeKeychainToken(TOKEN, {
      platform: "linux",
      run,
      execFile: readBack({ status: "found", token: TOKEN }),
    });
    expect(calls[0]).toMatchObject({
      file: "secret-tool",
      args: ["store", "--label=sevdesk-mcp", "service", "sevdesk-mcp", "account", "api-token"],
      input: TOKEN,
    });
  });

  it("refuses anything but a token, so nothing else reaches the security command line", async () => {
    const { run, calls } = fakeRunner();
    expect(
      await storeKeychainToken(`${TOKEN}\ndelete-keychain`, { platform: "darwin", run }),
    ).toEqual({
      status: "failed",
      reason: "not a sevdesk API token",
    });
    expect(calls).toEqual([]);
  });

  it("reports a missing tool, a failure and a write that cannot be read back", async () => {
    expect(
      await storeKeychainToken(TOKEN, { platform: "linux", run: fakeRunner("missing").run }),
    ).toEqual({
      status: "unavailable",
    });
    expect(await storeKeychainToken(TOKEN, { platform: "darwin", run: fakeRunner(1).run })).toEqual(
      {
        status: "failed",
        reason: "the keychain tool failed",
      },
    );
    expect(
      await storeKeychainToken(TOKEN, {
        platform: "darwin",
        run: fakeRunner(0).run,
        execFile: readBack({ status: "missing", detail: "no entry" }),
      }),
    ).toEqual({ status: "failed", reason: "the stored token could not be read back" });
    expect(await storeKeychainToken(TOKEN, { platform: "win32" })).toEqual({
      status: "unavailable",
    });
  });
});
