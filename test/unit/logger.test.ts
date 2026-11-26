import { describe, expect, it } from "vitest";
import { createLogger } from "../../src/logger.js";
import { TEST_TOKEN } from "../helpers.js";

describe("createLogger", () => {
  it("writes one JSON object per line and respects the level", () => {
    const lines: string[] = [];
    const logger = createLogger({ level: "info", write: (line) => lines.push(line) });

    logger.debug("hidden");
    logger.info("shown", { tool: "get_account_info" });

    expect(lines).toHaveLength(1);
    expect(lines[0]?.endsWith("\n")).toBe(true);
    expect(JSON.parse(lines[0] ?? "")).toMatchObject({
      level: "info",
      msg: "shown",
      tool: "get_account_info",
    });
  });

  it("redacts secrets in fields and error stacks", () => {
    const lines: string[] = [];
    const logger = createLogger({
      level: "debug",
      redact: [TEST_TOKEN],
      write: (line) => lines.push(line),
    });

    logger.error("boom", {
      nested: { header: TEST_TOKEN },
      error: new Error(`failed with ${TEST_TOKEN}`),
    });

    const output = lines.join("");
    expect(output).not.toContain(TEST_TOKEN);
    expect(output).toContain("[REDACTED]");
    expect(JSON.parse(output).error.message).toBe("failed with [REDACTED]");
  });
});
