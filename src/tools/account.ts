import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { type Config, MODES } from "../config.js";
import type { Logger } from "../logger.js";
import type { SevdeskClient } from "../sevdesk/client.js";
import { SevdeskError } from "../sevdesk/errors.js";
import { errorResult, okResult } from "./result.js";

export interface ToolContext {
  config: Config;
  sevdesk: SevdeskClient;
  logger: Logger;
}

const accountInfoSchema = z.object({
  bookkeepingSystemVersion: z
    .string()
    .describe('sevdesk bookkeeping system version, "2.0" after the 2024 tax-rule update'),
  mode: z.enum(MODES).describe("Mode this server runs in: read or write"),
});

export function registerAccountTools(server: McpServer, ctx: ToolContext): void {
  server.registerTool(
    "get_account_info",
    {
      title: "sevdesk account info",
      description:
        "Checks that the sevdesk connection works and returns the account's bookkeeping " +
        "system version and the mode this server runs in. Use it first when other tools fail.",
      inputSchema: z.object({}),
      outputSchema: accountInfoSchema,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async () => {
      try {
        const body = await ctx.sevdesk.call(ctx.sevdesk.api.GET("/Tools/bookkeepingSystemVersion"));
        const version = body?.objects?.version;
        if (typeof version !== "string") {
          throw new SevdeskError(
            "http_error",
            "sevdesk answered without a bookkeeping system version.",
          );
        }
        return okResult({ bookkeepingSystemVersion: version, mode: ctx.config.mode });
      } catch (error) {
        return errorResult("get_account_info", error, ctx.logger);
      }
    },
  );
}
