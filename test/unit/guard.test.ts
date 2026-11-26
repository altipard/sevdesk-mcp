import type { McpServer, ServerContext } from "@modelcontextprotocol/server";
import { describe, expect, it } from "vitest";
import { createAuditLog } from "../../src/policy/audit.js";
import { canonicalTarget, runGuarded } from "../../src/policy/guard.js";
import { createPolicyRuntime, requestPolicy } from "../../src/policy/runtime.js";
import { captureLogger, sharedNonceStore, testConfig } from "../helpers.js";

// The registry only registers X tools that are enabled, and the fallback
// only offers X operations listed in SEVDESK_API_ALLOW, so both always pass
// explicitlyAllowed: true. The guard still refuses on its own if a future
// caller does not; this covers that branch directly.

const noElicitation = {
  server: { getClientCapabilities: () => ({}) },
} as unknown as McpServer;
const ctx = { mcpReq: {} } as unknown as ServerContext;

describe("guard for X without an approval channel", () => {
  it("refuses unless the operator released the action", async () => {
    const config = testConfig({ mode: "full" });
    const lines: string[] = [];
    const runtime = createPolicyRuntime(config, {
      transport: "stdio",
      secret: Buffer.from("g".repeat(32)),
      audit: createAuditLog({ write: (l) => lines.push(l) }),
    });
    const policy = requestPolicy(config, runtime, undefined);
    const env = { policy, server: noElicitation, logger: captureLogger().logger };
    let executed = 0;
    const action = (explicitlyAllowed: boolean, confirmationToken?: string) => ({
      key: "x_tool",
      tool: "x_tool",
      class: "X" as const,
      args: { id: 1 },
      targetId: "1",
      confirmationToken,
      explicitlyAllowed,
      summary: "x.",
      preview: async () => ({}),
      execute: async () => {
        executed++;
        return { ok: true };
      },
    });
    const { token } = runtime.signer.issue({ tool: "x_tool", args: { id: 1 }, subject: "stdio" });

    const refused = await runGuarded(env, ctx, action(false, token));
    expect(refused).toMatchObject({ isError: true });
    expect(JSON.stringify(refused)).toContain("cannot ask the user for approval");
    expect(executed).toBe(0);
    expect(JSON.parse(lines.at(-1) ?? "{}")).toMatchObject({
      outcome: "denied",
      reason: "no_approval_channel",
    });

    const released = await runGuarded(env, ctx, action(true, token));
    expect(released).toMatchObject({ structuredContent: { ok: true } });
    expect(executed).toBe(1);
  });
});

describe("guard on HTTP derives rights and subject per call", () => {
  const config = testConfig({ mode: "full" });
  const alice = {
    token: "a",
    clientId: "app",
    scopes: ["sevdesk:read", "sevdesk:write"],
    extra: { sub: "alice" },
  };

  async function call(authInfo: unknown) {
    const lines: string[] = [];
    const runtime = createPolicyRuntime(config, {
      transport: "http",
      secret: Buffer.from("g".repeat(32)),
      nonces: sharedNonceStore(),
      audit: createAuditLog({ write: (l) => lines.push(l) }),
    });
    const policy = requestPolicy(config, runtime, alice);
    let executed = 0;
    const result = await runGuarded(
      { policy, server: noElicitation, logger: captureLogger().logger },
      { mcpReq: {}, http: { authInfo } } as unknown as ServerContext,
      {
        key: "w_tool",
        tool: "w_tool",
        class: "W",
        args: {},
        explicitlyAllowed: false,
        summary: "w.",
        execute: async () => {
          executed++;
          return { ok: true };
        },
      },
    );
    return { result, executed, audit: lines.map((l) => JSON.parse(l)) };
  }

  it("runs for the subject the server was built for", async () => {
    const { result, executed, audit } = await call(alice);
    expect(result).toMatchObject({ structuredContent: { ok: true } });
    expect(executed).toBe(1);
    expect(audit[0]).toMatchObject({ subject: "sub:alice", outcome: "ok" });
  });

  it("denies a call whose token names another subject", async () => {
    const { executed, audit } = await call({ ...alice, extra: { sub: "mallory" } });
    expect(executed).toBe(0);
    expect(audit[0]).toMatchObject({ subject: "sub:mallory", outcome: "denied" });
  });

  it("denies a call whose token identifies nobody", async () => {
    const { executed, audit } = await call({ ...alice, clientId: "", extra: {} });
    expect(executed).toBe(0);
    expect(audit[0]).toMatchObject({ subject: "unidentified", outcome: "denied" });
  });
});

describe("guard with a failing audit sink", () => {
  it("keeps a successful action a success and logs the sink failure", async () => {
    const config = testConfig({ mode: "write" });
    const runtime = createPolicyRuntime(config, {
      transport: "stdio",
      secret: Buffer.from("g".repeat(32)),
      audit: {
        record: () => {
          throw new Error("disk full");
        },
      },
    });
    const { logger, lines } = captureLogger();
    let executed = 0;
    const result = await runGuarded(
      { policy: requestPolicy(config, runtime, undefined), server: noElicitation, logger },
      ctx,
      {
        key: "w_tool",
        tool: "w_tool",
        class: "W",
        args: {},
        explicitlyAllowed: false,
        summary: "w.",
        execute: async () => {
          executed++;
          return { ok: true };
        },
      },
    );
    expect(result).toMatchObject({ structuredContent: { ok: true } });
    expect((result as { isError?: boolean }).isError).toBeUndefined();
    expect(executed).toBe(1);
    expect(lines.join("")).toContain("audit sink failed");
    expect(lines.join("")).toContain("disk full");
  });
});

describe("canonical target IDs in the guard", () => {
  it("treats different spellings of a numeric target as one", () => {
    expect(canonicalTarget("042")).toBe("42");
    expect(canonicalTarget("42")).toBe("42");
    expect(canonicalTarget("0")).toBe("0");
    expect(canonicalTarget("INV-042")).toBe("INV-042");
    expect(canonicalTarget(undefined)).toBeUndefined();
  });

  it("keeps the once-per-target lock across spellings", async () => {
    const config = testConfig({ mode: "full" });
    const runtime = createPolicyRuntime(config, {
      transport: "stdio",
      secret: Buffer.from("g".repeat(32)),
    });
    const env = {
      policy: requestPolicy(config, runtime, undefined),
      server: noElicitation,
      logger: captureLogger().logger,
    };
    let executed = 0;
    const run = (targetId: string) => {
      const args = { invoice: targetId };
      const { token } = runtime.signer.issue({ tool: "x_tool", args, subject: "stdio" });
      return runGuarded(env, ctx, {
        key: "x_tool",
        tool: "x_tool",
        class: "X",
        args,
        targetId,
        confirmationToken: token,
        explicitlyAllowed: true,
        summary: "x.",
        execute: async () => {
          executed++;
          return { ok: true };
        },
      });
    };
    expect(await run("42")).toMatchObject({ structuredContent: { ok: true } });
    expect(JSON.stringify(await run("042"))).toContain("already ran for this target");
    expect(executed).toBe(1);
  });
});
