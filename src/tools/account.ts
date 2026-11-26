import { z } from "zod";
import { MODES } from "../config.js";
import { defineTool } from "../policy/registry.js";
import { SevdeskError } from "../sevdesk/errors.js";

const accountInfoSchema = z.object({
  bookkeepingSystemVersion: z
    .string()
    .describe('sevdesk bookkeeping system version, "2.0" after the 2024 tax-rule update'),
  mode: z.enum(MODES).describe("Mode this server runs in: read, write or full"),
});

export const getAccountInfo = defineTool({
  name: "get_account_info",
  title: "sevdesk account info",
  description:
    "Checks that the sevdesk connection works and returns the account's bookkeeping " +
    "system version and the mode this server runs in. Use it first when other tools fail.",
  class: "R",
  operationId: "bookkeepingSystemVersion",
  inputSchema: z.object({}),
  outputSchema: accountInfoSchema,
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: true,
  },
  async handler(_args, { sevdesk, config }) {
    const body = await sevdesk.call(sevdesk.api.GET("/Tools/bookkeepingSystemVersion"));
    const version = body?.objects?.version;
    if (typeof version !== "string") {
      throw new SevdeskError(
        "http_error",
        "sevdesk answered without a bookkeeping system version.",
      );
    }
    return { bookkeepingSystemVersion: version, mode: config.mode };
  },
});
