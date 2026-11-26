import { describe, expect, it, vi } from "vitest";
import {
  type ExecFileError,
  type ExecFileFn,
  KEYCHAIN_TIMEOUT_MS,
  readKeychainToken,
  resolveApiToken,
} from "../../src/keychain.js";
import { TEST_TOKEN } from "../helpers.js";

type Outcome = { error?: ExecFileError; stdout?: string; stderr?: string; throws?: boolean };

function fakeExecFile(outcome: Outcome) {
  const calls: { file: string; args: readonly string[]; options: unknown }[] = [];
  const fn: ExecFileFn = (file, args, options, callback) => {
    calls.push({ file, args, options });
    if (outcome.throws) throw new Error(`spawn failed ${TEST_TOKEN}`);
    queueMicrotask(() =>
      callback(outcome.error ?? null, outcome.stdout ?? "", outcome.stderr ?? ""),
    );
  };
  return { fn, calls };
}

const failure = (fields: Partial<ExecFileError>): ExecFileError =>
  Object.assign(new Error(`Command failed: stdout ${TEST_TOKEN}`), fields);

describe("readKeychainToken", () => {
  it("asks the macOS keychain without a shell and with a timeout", async () => {
    const exec = fakeExecFile({ stdout: `${TEST_TOKEN}\n` });
    const result = await readKeychainToken({ platform: "darwin", execFile: exec.fn });
    expect(result).toEqual({ status: "found", token: TEST_TOKEN });
    expect(exec.calls).toEqual([
      {
        file: "/usr/bin/security",
        args: ["find-generic-password", "-s", "sevdesk-mcp", "-a", "api-token", "-w"],
        options: expect.objectContaining({ timeout: KEYCHAIN_TIMEOUT_MS, encoding: "utf8" }),
      },
    ]);
    expect(exec.calls[0]?.options).not.toHaveProperty("shell");
  });

  it("asks secret-tool on Linux", async () => {
    const exec = fakeExecFile({ stdout: TEST_TOKEN });
    const result = await readKeychainToken({ platform: "linux", execFile: exec.fn, timeoutMs: 50 });
    expect(result).toEqual({ status: "found", token: TEST_TOKEN });
    expect(exec.calls[0]?.file).toBe("secret-tool");
    expect(exec.calls[0]?.args).toEqual([
      "lookup",
      "service",
      "sevdesk-mcp",
      "account",
      "api-token",
    ]);
    expect(exec.calls[0]?.options).toMatchObject({ timeout: 50 });
  });

  it("reports a missing entry, honestly for secret-tool", async () => {
    for (const [platform, code, detail] of [
      ["darwin", 44, "no entry"],
      // secret-tool exits 1 for "no match" and for "no Secret Service" alike.
      ["linux", 1, "no entry, or the Secret Service is not reachable"],
    ] as const) {
      const exec = fakeExecFile({ error: failure({ code }) });
      expect(await readKeychainToken({ platform, execFile: exec.fn })).toEqual({
        status: "missing",
        detail,
      });
    }
    const empty = fakeExecFile({ stdout: "\n" });
    expect(await readKeychainToken({ platform: "linux", execFile: empty.fn })).toEqual({
      status: "missing",
      detail: "empty entry",
    });
  });

  it("treats a missing tool and other systems as unavailable", async () => {
    const exec = fakeExecFile({ error: failure({ code: "ENOENT" }) });
    expect(await readKeychainToken({ platform: "linux", execFile: exec.fn })).toEqual({
      status: "unavailable",
    });
    const unused = fakeExecFile({});
    expect(await readKeychainToken({ platform: "win32", execFile: unused.fn })).toEqual({
      status: "unavailable",
    });
    expect(unused.calls).toEqual([]);
  });

  it("reports failures with fixed text only", async () => {
    const cases: [Outcome, string][] = [
      [{ error: failure({ killed: true, signal: "SIGTERM" }) }, "timed out"],
      // Node also kills the child when output exceeds maxBuffer; that is no timeout.
      [
        {
          error: failure({
            code: "ERR_CHILD_PROCESS_STDIO_MAXBUFFER",
            killed: true,
            signal: "SIGTERM",
          }),
        },
        "returned more output than a token",
      ],
      [{ error: failure({ code: 51 }), stderr: TEST_TOKEN }, "lookup failed"],
      [{ error: failure({ code: 1 }) }, "lookup failed"], // 1 means "missing" only on Linux
      [{ throws: true }, "lookup failed"],
    ];
    for (const [outcome, reason] of cases) {
      const exec = fakeExecFile(outcome);
      const result = await readKeychainToken({ platform: "darwin", execFile: exec.fn });
      expect(result).toEqual({ status: "failed", reason });
      expect(JSON.stringify(result)).not.toContain(TEST_TOKEN);
    }
  });

  it("keeps everything but the final newline", async () => {
    const exec = fakeExecFile({ stdout: ` ${TEST_TOKEN}\r\n` });
    expect(await readKeychainToken({ platform: "darwin", execFile: exec.fn })).toEqual({
      status: "found",
      token: ` ${TEST_TOKEN}`,
    });
  });
});

describe("resolveApiToken", () => {
  it("prefers the environment and does not touch the keychain", async () => {
    const read = vi.fn();
    const env = { SEVDESK_API_TOKEN: TEST_TOKEN, SEVDESK_MODE: "read" };
    expect(await resolveApiToken(env, read)).toEqual({ env, source: "env" });
    expect(read).not.toHaveBeenCalled();
  });

  it("falls back to the keychain when the variable is unset or blank", async () => {
    for (const value of [undefined, "", "   "]) {
      const read = vi.fn().mockResolvedValue({ status: "found", token: TEST_TOKEN });
      const result = await resolveApiToken({ SEVDESK_API_TOKEN: value, LOG_LEVEL: "warn" }, read);
      expect(result).toEqual({
        env: { SEVDESK_API_TOKEN: TEST_TOKEN, LOG_LEVEL: "warn" },
        source: "keychain",
      });
    }
  });

  it("does not modify the passed environment", async () => {
    const env: Record<string, string | undefined> = {};
    await resolveApiToken(env, async () => ({ status: "found", token: TEST_TOKEN }));
    expect(env).toEqual({});
  });

  it("returns no token, with a note on what the keychain lookup found", async () => {
    expect(
      await resolveApiToken({}, async () => ({ status: "missing", detail: "no entry" })),
    ).toEqual({
      env: {},
      keychainNote: "no token in the keychain (service sevdesk-mcp, account api-token): no entry",
    });
    expect(await resolveApiToken({}, async () => ({ status: "unavailable" }))).toEqual({
      env: {},
    });
    expect(
      await resolveApiToken({}, async () => ({ status: "failed", reason: "timed out" })),
    ).toEqual({
      env: {},
      keychainNote: "keychain lookup timed out (service sevdesk-mcp, account api-token)",
    });
  });
});
