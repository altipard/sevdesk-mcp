import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import { TEST_TOKEN } from "../helpers.js";

// Runs the built entrypoint as a container would start it.
const BIN = fileURLToPath(new URL("../../dist/bin/http.js", import.meta.url));

const BASE_ENV = {
  PATH: process.env.PATH ?? "",
  SEVDESK_API_TOKEN: TEST_TOKEN,
  SEVDESK_CONFIRM_SECRET: "a-bin-test-secret-of-at-least-32-chars",
  SEVDESK_BASE_URL: "http://127.0.0.1:9/api/v1",
  PORT: "0",
  MCP_RESOURCE_URL: "http://127.0.0.1:3999/mcp",
  OAUTH_ISSUER: "https://auth.example.test",
  OAUTH_JWKS_URL: "https://auth.example.test/certs",
};

interface Run {
  code: number | null;
  stdout: string;
  stderr: string;
}

function run(env: Record<string, string>, onLine?: (line: string, kill: () => void) => void) {
  return new Promise<Run>((resolve) => {
    const child = spawn(process.execPath, [BIN], { env, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => {
      stdout += chunk;
      for (const line of chunk.split("\n").filter(Boolean)) {
        onLine?.(line, () => child.kill("SIGTERM"));
      }
    });
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => {
      stderr += chunk;
    });
    const timer = setTimeout(() => child.kill("SIGKILL"), 15_000);
    child.on("exit", (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
  });
}

beforeAll(() => {
  if (!existsSync(BIN)) {
    throw new Error(`${BIN} is missing. Run "npm run build" first (npm test does this).`);
  }
});

describe("dist/bin/http.js", () => {
  it("refuses to start without REDIS_URL, with a JSON log line on stdout", async () => {
    const result = await run(BASE_ENV);
    expect(result.code).toBe(1);
    const line = JSON.parse(result.stdout.trim().split("\n").at(-1) ?? "{}");
    expect(line).toMatchObject({ level: "error", msg: "invalid configuration" });
    expect(line.issues).toContain(
      "REDIS_URL: is required for the HTTP transport (shared replay protection)",
    );
    expect(result.stdout).not.toContain(TEST_TOKEN);
  });

  it("refuses to start without SEVDESK_CONFIRM_SECRET", async () => {
    const { SEVDESK_CONFIRM_SECRET: _, ...env } = BASE_ENV;
    const result = await run({ ...env, REDIS_URL: "redis://127.0.0.1:9" });
    expect(result.code).toBe(1);
    expect(result.stdout).toContain("SEVDESK_CONFIRM_SECRET: is required for the HTTP transport");
  });

  it("stops with a clear message when Redis is not reachable, without the password", async () => {
    const result = await run({ ...BASE_ENV, REDIS_URL: "redis://:pw-in-url@127.0.0.1:9" });
    expect(result.code).toBe(1);
    expect(result.stdout).toContain("cannot connect to Redis (REDIS_URL)");
    expect(result.stdout + result.stderr).not.toContain("pw-in-url");
  }, 20_000);

  it.skipIf(!process.env.REDIS_URL)(
    "serves health and exits 0 on SIGTERM (needs REDIS_URL)",
    async () => {
      let port = 0;
      const result = await run(
        { ...BASE_ENV, REDIS_URL: process.env.REDIS_URL ?? "" },
        (line, kill) => {
          const entry = JSON.parse(line);
          if (entry.msg === "sevdesk-mcp started") {
            port = entry.port;
            void fetch(`http://127.0.0.1:${port}/healthz`).then((r) => {
              expect(r.status).toBe(200);
              kill();
            });
          }
        },
      );
      expect(port).toBeGreaterThan(0);
      expect(result.code).toBe(0);
      expect(result.stdout).toContain('"msg":"sevdesk-mcp stopped"');
    },
    20_000,
  );
});
