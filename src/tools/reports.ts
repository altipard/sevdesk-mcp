import { z } from "zod";
import type { OperationId } from "../policy/operations.js";
import { defineTool } from "../policy/registry.js";
import { decodeFile, fileContent, fileMetaSchema, MAX_FILE_BYTES } from "./documents.js";
import {
  badInput,
  berlinDateTime,
  dateRangeInput,
  entityId,
  READ_ANNOTATIONS,
  rangeProblem,
} from "./format.js";
import { buildRequest, RequestBuildError } from "./generic.js";
import { present } from "./result.js";

const REPORTS = {
  invoices: { operationId: "reportInvoice", modelName: "Invoice", view: true },
  orders: { operationId: "reportOrder", modelName: "Order", view: true },
  contacts: { operationId: "reportContact", modelName: "Contact", view: false },
  vouchers: { operationId: "reportVoucher", modelName: "Voucher", view: false },
} as const satisfies Record<string, { operationId: OperationId; modelName: string; view: boolean }>;

type ReportName = keyof typeof REPORTS;

type UntypedGet = (
  method: "get",
  path: string,
  init: Record<string, never>,
) => Promise<{ data: unknown; response: Response }>;

export const getReport = defineTool({
  name: "get_report",
  title: "Get a sevdesk list report",
  description:
    "Returns sevdesk's rendered list report (usually a PDF) of invoices, orders, contacts or " +
    "vouchers as an embedded resource, optionally limited to a date range and a contact " +
    "(not for contacts) or, for orders, an order type. It is a document for people, not data: " +
    "use the search_* tools to work with the entries. " +
    `Files over ${MAX_FILE_BYTES} bytes are refused.`,
  class: "R",
  operationId: "reportInvoice",
  inputSchema: z.object({
    report: z.enum(Object.keys(REPORTS) as [ReportName, ...ReportName[]]),
    ...dateRangeInput,
    contactId: entityId.optional().describe("Only entries of this contact (not for contacts)."),
    orderType: z
      .enum(["AN", "AB", "LI"])
      .optional()
      .describe("orders only: AN estimates, AB order confirmations, LI delivery notes."),
  }),
  outputSchema: z.object({ report: z.string(), ...fileMetaSchema }),
  annotations: READ_ANNOTATIONS,
  async handler(args, { sevdesk, config }) {
    const report = REPORTS[args.report];
    const problem = rangeProblem(args);
    if (problem) throw badInput(problem);
    if (args.report === "contacts" && (args.startDate || args.endDate || args.contactId)) {
      throw badInput("The contacts report takes no date range or contactId.");
    }
    if (args.orderType && args.report !== "orders") {
      throw badInput("orderType applies to the orders report only.");
    }
    const filter: Record<string, unknown> = {
      ...(args.startDate && { startDate: berlinDateTime(args.startDate) }),
      ...(args.endDate && { endDate: berlinDateTime(args.endDate, true) }),
      ...(args.contactId && { contact: { id: args.contactId, objectName: "Contact" } }),
      ...(args.orderType && { orderType: args.orderType }),
    };
    const sevQuery = {
      modelName: report.modelName,
      objectName: "SevQuery",
      ...(Object.keys(filter).length > 0 && { filter }),
    };
    // sevQuery is a nested object in the query string; the fallback's
    // builder already flattens it to sevQuery[filter][contact][id]=… and
    // checks the result against the spec's parameter list.
    let path: string;
    try {
      path = buildRequest(config.baseUrl, report.operationId, {
        ...(report.view && { view: "all" }),
        sevQuery,
      }).path;
    } catch (error) {
      if (error instanceof RequestBuildError) throw badInput(error.message);
      throw error;
    }
    const get = sevdesk.api.request as unknown as UntypedGet;
    const file = decodeFile(await sevdesk.call(get("get", path, {})), "application/pdf");
    const resourceUri = `sevdesk://report/${args.report}`;
    return present(
      {
        report: args.report,
        filename: file.filename,
        mimeType: file.mimeType,
        sizeBytes: file.sizeBytes,
        resourceUri,
      },
      {
        summary: `${args.report} report: ${file.filename ?? "unnamed"}, ${file.sizeBytes} bytes.`,
        content: [fileContent(resourceUri, file)],
      },
    );
  },
});
