import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { createPolicyRuntime } from "../../src/policy/runtime.js";
import { createServer } from "../../src/server.js";
import * as client from "../../src/sevdesk/client.js";
import { captureLogger, testConfig } from "../helpers.js";

// The client paces only when it is given a rate, so an entrypoint that
// forgets to pass config.rateLimit would make SEVDESK_RATE_LIMIT do nothing.

vi.mock("../../src/sevdesk/client.js", { spy: true });

describe("SEVDESK_RATE_LIMIT reaches the client", () => {
  it("is passed by createServer when it builds its own client", () => {
    const config = testConfig({ rateLimit: 3 });
    const { logger } = captureLogger();
    createServer(config, { logger, runtime: createPolicyRuntime(config, { transport: "stdio" }) });

    expect(client.createSevdeskClient).toHaveBeenCalledWith(
      expect.objectContaining({ rateLimit: 3 }),
    );
  });

  // Both entrypoints run at import (stdio) or need Redis and an issuer
  // (HTTP), so their client construction is checked in the source.
  it.each(["src/bin/stdio.ts", "src/http/start.ts", "src/server.ts"])(
    "%s passes config.rateLimit to every createSevdeskClient call",
    (path) => {
      const source = readFileSync(new URL(`../../${path}`, import.meta.url), "utf8");
      const calls = [...source.matchAll(/createSevdeskClient\(\{([^}]*)\}\)/g)];
      expect(calls.length).toBeGreaterThan(0);
      for (const [, args] of calls) expect(args).toContain("rateLimit: config.rateLimit");
    },
  );
});
