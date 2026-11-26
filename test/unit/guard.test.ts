import type { McpServer, ServerContext } from "@modelcontextprotocol/server";
import { describe, expect, it } from "vitest";
import { createAuditLog } from "../../src/policy/audit.js";
import { runGuarded } from "../../src/policy/guard.js";
import { createPolicyRuntime, requestPolicy } from "../../src/policy/runtime.js";
import { captureLogger, testConfig } from "../helpers.js";

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
