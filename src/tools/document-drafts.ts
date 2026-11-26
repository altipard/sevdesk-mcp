import { z } from "zod";
import { defineTool, type ToolCall } from "../policy/registry.js";
import { SevdeskError } from "../sevdesk/errors.js";
import {
  amount,
  asRecord,
  badInput,
  entityId,
  integer,
  isoDate,
  isoDateOf,
  notFound,
  ORDER_STATUS,
  objectsOf,
  type Raw,
  refId,
  statusOf,
  text,
  todayIso,
} from "./format.js";
import { present } from "./result.js";
import {
  type ContactPerson,
  CREATE_ANNOTATIONS,
  checkTax,
  contactForDocument,
  contactPersonInput,
  contactPersonSchema,
  contactPersonText,
  currencyInput,
  defaultTaxText,
  inputText,
  invoiceLabel,
  invoiceStateSchema,
  mapInvoiceState,
  money,
  netSum,
  positionBody,
  positionsInput,
  type ResolvedPosition,
  ref,
  resolveContactPerson,
  resolvePositions,
  sevdeskDate,
  sumWarning,
  type TaxCheck,
  taxCheckSchema,
  taxRuleInput,
} from "./write-common.js";

// ---------------------------------------------------------------------------
// Shared parts of invoice and order drafts

const draftInput = {
  contactId: entityId.describe("sevdesk ID of the customer (search_contacts); required."),
  positions: positionsInput,
  taxRule: taxRuleInput,
  taxText: inputText(200).optional().describe("Tax note on the document; default per tax rule."),
  header: inputText(200).optional().describe("Document title."),
  headText: inputText(5000).optional().describe("Text above the positions."),
  footText: inputText(5000).optional().describe("Text below the positions."),
  currency: currencyInput,
  contactPersonId: contactPersonInput,
};

const draftCommonOutput = {
  contactId: z.number().int(),
  address: z.string().nullable().describe("Recipient address taken from the contact."),
  addressId: z.number().int().nullable(),
  contactPerson: contactPersonSchema,
  taxRule: taxCheckSchema,
  positions: z.number().int().describe("Number of positions sent."),
  expectedSumNet: z.number().describe("Net sum of the positions as sent."),
  warnings: z.array(z.string()),
};

interface Prepared {
  positions: ResolvedPosition[];
  tax: TaxCheck;
  address: string | null;
  addressId: number | null;
  countryId: number;
  contactPerson: ContactPerson;
  warnings: string[];
}

/** Everything a draft needs, read and checked before anything is written. */
async function prepareDraft(
  call: ToolCall,
  args: {
    contactId: number;
    positions: z.infer<typeof positionsInput>;
    taxRule: number;
    contactPersonId?: number | undefined;
  },
  prefer: "invoice" | "order",
): Promise<Prepared> {
  const warnings: string[] = [];
  const positions = await resolvePositions(call, args.positions);
  const tax = await checkTax(
    call,
    args.taxRule,
    positions.map((p) => p.taxRate),
    warnings,
  );
  const contact = await contactForDocument(call, args.contactId, warnings);
  const contactPerson = await resolveContactPerson(call, args.contactPersonId, prefer);
  return {
    positions,
    tax,
    address: contact.address,
    addressId: contact.addressId,
    countryId: contact.countryId,
    contactPerson,
    warnings,
  };
}

/** Fields shared by Model_Invoice and Model_Order for a draft. */
function documentBody(
  args: {
    contactId: number;
    taxText?: string | undefined;
    header?: string | undefined;
    headText?: string | undefined;
    footText?: string | undefined;
    currency: string;
  },
  prepared: Prepared,
  objectName: string,
) {
  return {
    objectName,
    mapAll: true,
    contact: ref(args.contactId, "Contact"),
    contactPerson: ref(prepared.contactPerson.id, "SevUser"),
    // Drafts only; the server pins this field as well.
    status: 100,
    ...(prepared.address !== null && { address: prepared.address }),
    addressCountry: ref(prepared.countryId, "StaticCountry"),
    taxRate: 0,
    taxRule: ref(prepared.tax.id, "TaxRule"),
    taxText: args.taxText ?? defaultTaxText(prepared.tax.id),
    currency: args.currency,
    showNet: true,
    ...(args.header !== undefined && { header: args.header }),
    ...(args.headText !== undefined && { headText: args.headText }),
    ...(args.footText !== undefined && { footText: args.footText }),
  };
}

function commonOutput(contactId: number, prepared: Prepared, warnings: string[]) {
  return {
    contactId,
    address: prepared.address,
    addressId: prepared.addressId,
    contactPerson: prepared.contactPerson,
    taxRule: prepared.tax,
    positions: prepared.positions.length,
    expectedSumNet: netSum(prepared.positions),
    warnings,
  };
}

function noIdError(what: string): SevdeskError {
  return new SevdeskError(
    "http_error",
    `sevdesk accepted the ${what} but returned no ID; check sevdesk before creating it again.`,
  );
}

const warningsText = (warnings: readonly string[]) =>
  warnings.length > 0 ? ` ${warnings.length} warning(s), see warnings.` : "";

// ---------------------------------------------------------------------------
// create_invoice_draft

export const createInvoiceDraft = defineTool({
  name: "create_invoice_draft",
  title: "Create a sevdesk invoice draft",
  description:
    "Creates an invoice (type RE) as draft in sevdesk. Positions are free text or articles " +
    "(partId) with quantity, net unit price, tax rate and unit. The recipient address comes " +
    "from the contact (its invoice address, else its first address). Tax rule and position " +
    "tax rates are checked against sevdesk's documented rules and the account's tax guidance " +
    "before anything is sent. The draft gets no invoice number and is not sent; use " +
    "mark_invoice_sent or send_invoice_email for that. Every call creates a new draft.",
  class: "W",
  operationId: "createInvoiceByFactory",
  operations: ["getContactById", "getPartById", "getInvoices", "getOrders", "forRevenue"],
  inputSchema: z.object({
    ...draftInput,
    invoiceDate: isoDate.optional().describe("YYYY-MM-DD; default today (German time)."),
    deliveryDate: isoDate
      .optional()
      .describe("YYYY-MM-DD, not after invoiceDate; default: sevdesk's own default."),
    timeToPay: z.number().int().min(0).max(365).optional().describe("Payment term in days."),
    customerInternalNote: inputText(250)
      .optional()
      .describe("Customer reference or order number (Referenz/Bestellnummer)."),
  }),
  outputSchema: z.object({ invoice: invoiceStateSchema, ...draftCommonOutput }),
  annotations: CREATE_ANNOTATIONS,
  async handler(args, call) {
    const invoiceDate = args.invoiceDate ?? todayIso();
    if (args.deliveryDate !== undefined && args.deliveryDate > invoiceDate) {
      throw badInput(
        "deliveryDate must not be after invoiceDate: sevdesk only allows that for advance " +
          "invoices (AR), which this tool does not create.",
      );
    }
    const prepared = await prepareDraft(call, args, "invoice");
    const body = {
      invoice: {
        ...documentBody(args, prepared, "Invoice"),
        invoiceDate: sevdeskDate(invoiceDate),
        ...(args.deliveryDate !== undefined && { deliveryDate: sevdeskDate(args.deliveryDate) }),
        ...(args.timeToPay !== undefined && { timeToPay: args.timeToPay }),
        ...(args.customerInternalNote !== undefined && {
          customerInternalNote: args.customerInternalNote,
        }),
        discount: 0,
        invoiceType: "RE",
      },
      invoicePosSave: prepared.positions.map((p, i) => positionBody(p, "InvoicePos", i)),
      invoicePosDelete: null,
      discountSave: [],
      discountDelete: null,
    };
    const { sevdesk } = call;
    const result = await sevdesk.call(
      sevdesk.api.POST("/Invoice/Factory/saveInvoice", { body: body as never }),
    );
    const saved = asRecord(objectsOf(result)[0]?.invoice);
    if (integer(saved.id) === null) throw noIdError("invoice draft");
    const invoice = mapInvoiceState(saved);
    const warnings = [...prepared.warnings];
    const expected = netSum(prepared.positions);
    const mismatch = sumWarning(expected, invoice.sumNet);
    if (mismatch) warnings.push(mismatch);
    if (invoice.status !== 100) {
      warnings.push(
        `sevdesk reports status ${invoice.status ?? "unknown"} instead of draft (100); check the invoice in sevdesk.`,
      );
    }
    return present(
      { invoice, ...commonOutput(args.contactId, prepared, warnings) },
      {
        summary:
          `Created invoice draft ${invoiceLabel(invoice)} for contact ${args.contactId}: ` +
          `${prepared.positions.length} positions, net ${money(invoice.sumNet ?? expected, invoice.currency ?? args.currency)}, ` +
          `tax rule ${prepared.tax.id}, contact person ${contactPersonText(prepared.contactPerson)}.` +
          warningsText(warnings),
      },
    );
  },
});

// ---------------------------------------------------------------------------
// create_order_draft

const orderStateSchema = z.object({
  id: z.number().int(),
  orderNumber: z.string().nullable(),
  orderType: z.string().nullable(),
  status: z.number().int().nullable(),
  statusName: z.string().nullable(),
  orderDate: z.string().nullable(),
  contactId: z.number().int().nullable(),
  currency: z.string().nullable(),
  sumNet: z.number().nullable(),
  sumGross: z.number().nullable(),
});

function mapOrderState(raw: Raw): z.infer<typeof orderStateSchema> {
  return {
    id: integer(raw.id) ?? 0,
    orderNumber: text(raw.orderNumber),
    orderType: text(raw.orderType),
    ...statusOf(raw.status, ORDER_STATUS),
    orderDate: isoDateOf(raw.orderDate),
    contactId: refId(raw.contact),
    currency: text(raw.currency),
    sumNet: amount(raw.sumNet),
    sumGross: amount(raw.sumGross),
  };
}

const ORDER_HEADERS = { AN: "Angebot", AB: "Auftragsbestätigung" } as const;

export const createOrderDraft = defineTool({
  name: "create_order_draft",
  title: "Create a sevdesk estimate draft",
  description:
    "Creates an estimate (Angebot, type AN) or an order confirmation (AB) as draft in sevdesk, " +
    "with the same positions, address and tax checks as create_invoice_draft. It is not sent. " +
    "Turn it into an invoice later with create_invoice_from_order. Every call creates a new draft.",
  class: "W",
  operationId: "createOrder",
  operations: ["getContactById", "getPartById", "getInvoices", "getOrders", "forRevenue"],
  inputSchema: z.object({
    ...draftInput,
    orderType: z
      .enum(["AN", "AB"])
      .default("AN")
      .describe("AN estimate (default), AB order confirmation."),
    orderDate: isoDate.optional().describe("YYYY-MM-DD; default today (German time)."),
    orderNumber: inputText(100).optional().describe("Order number; default: sevdesk assigns one."),
    deliveryTerms: inputText(500).optional(),
    paymentTerms: inputText(500).optional(),
  }),
  outputSchema: z.object({ order: orderStateSchema, ...draftCommonOutput }),
  annotations: CREATE_ANNOTATIONS,
  async handler(args, call) {
    const prepared = await prepareDraft(call, args, "order");
    const body = {
      order: {
        ...documentBody(
          { ...args, header: args.header ?? ORDER_HEADERS[args.orderType] },
          prepared,
          "Order",
        ),
        orderType: args.orderType,
        orderDate: sevdeskDate(args.orderDate ?? todayIso()),
        ...(args.orderNumber !== undefined && { orderNumber: args.orderNumber }),
        ...(args.deliveryTerms !== undefined && { deliveryTerms: args.deliveryTerms }),
        ...(args.paymentTerms !== undefined && { paymentTerms: args.paymentTerms }),
        version: 0,
      },
      orderPosSave: prepared.positions.map((p, i) => positionBody(p, "OrderPos", i)),
      orderPosDelete: null,
    };
    const { sevdesk } = call;
    const result = await sevdesk.call(
      sevdesk.api.POST("/Order/Factory/saveOrder", { body: body as never }),
    );
    const saved = asRecord(objectsOf(result)[0]?.order);
    if (integer(saved.id) === null) throw noIdError("order draft");
    const order = mapOrderState(saved);
    const warnings = [...prepared.warnings];
    const expected = netSum(prepared.positions);
    const mismatch = sumWarning(expected, order.sumNet);
    if (mismatch) warnings.push(mismatch);
    if (order.status !== 100) {
      warnings.push(
        `sevdesk reports status ${order.status ?? "unknown"} instead of draft (100); check the order in sevdesk.`,
      );
    }
    const kind = args.orderType === "AN" ? "estimate" : "order confirmation";
    return present(
      { order, ...commonOutput(args.contactId, prepared, warnings) },
      {
        summary:
          `Created ${kind} draft ${order.orderNumber ? `${order.orderNumber} (ID ${order.id})` : `ID ${order.id}`} ` +
          `for contact ${args.contactId}: ${prepared.positions.length} positions, net ` +
          `${money(order.sumNet ?? expected, order.currency ?? args.currency)}, tax rule ${prepared.tax.id}, ` +
          `contact person ${contactPersonText(prepared.contactPerson)}.${warningsText(warnings)}`,
      },
    );
  },
});

// ---------------------------------------------------------------------------
// create_invoice_from_order

export const createInvoiceFromOrder = defineTool({
  name: "create_invoice_from_order",
  title: "Create a sevdesk invoice from an order",
  description:
    "Turns an estimate (AN) or order confirmation (AB) into an invoice draft with its " +
    "positions. partialType RE (default) invoices the whole order; TR (partial) and AR " +
    "(advance) need amountType and amount. Delivery notes (LI) cannot be invoiced. The new " +
    "invoice is not sent; check it with get_invoice. Every call creates another invoice.",
  class: "W",
  operationId: "createInvoiceFromOrder",
  operations: ["getOrderById"],
  inputSchema: z.object({
    orderId: entityId.describe("sevdesk ID of the estimate or order (search_orders)."),
    partialType: z
      .enum(["RE", "TR", "AR"])
      .default("RE")
      .describe("RE final invoice (default), TR partial invoice, AR advance invoice."),
    amountType: z
      .enum(["percentage", "net", "gross"])
      .optional()
      .describe("How amount is meant; required for TR and AR."),
    amount: z
      .number()
      .positive()
      .max(1_000_000_000)
      .optional()
      .describe("Percentage or amount to invoice; required for TR and AR."),
  }),
  outputSchema: z.object({
    orderId: z.number().int(),
    orderType: z.string().nullable(),
    invoice: invoiceStateSchema,
    warnings: z.array(z.string()),
  }),
  annotations: CREATE_ANNOTATIONS,
  async handler(args, { sevdesk }) {
    const partial = args.partialType !== "RE";
    if (partial && (args.amountType === undefined || args.amount === undefined)) {
      throw badInput(`partialType ${args.partialType} needs amountType and amount.`);
    }
    if (!partial && (args.amountType !== undefined || args.amount !== undefined)) {
      throw badInput("amountType and amount are only for partialType TR or AR.");
    }
    if (args.amountType === "percentage" && (args.amount ?? 0) > 100) {
      throw badInput("A percentage amount must not exceed 100.");
    }
    const orderBody = await sevdesk.call(
      sevdesk.api.GET("/Order/{orderId}", { params: { path: { orderId: args.orderId } } }),
    );
    const order = objectsOf(orderBody)[0];
    if (order === undefined) throw notFound("order", args.orderId);
    const orderType = text(order.orderType);
    if (orderType === "LI") {
      throw badInput(
        `Order ${args.orderId} is a delivery note (LI); only estimates (AN) and order ` +
          "confirmations (AB) can be invoiced.",
      );
    }

    const result = await sevdesk.call(
      sevdesk.api.POST("/Invoice/Factory/createInvoiceFromOrder", {
        body: {
          order: ref(args.orderId, "Order"),
          ...(partial && {
            partialType: args.partialType,
            type: args.amountType,
            amount: args.amount,
          }),
        } as never,
      }),
    );
    const raw = objectsOf(result)[0];
    if (raw === undefined || integer(raw.id) === null) throw noIdError("invoice");
    const invoice = mapInvoiceState(raw);
    const warnings: string[] = [];
    if (invoice.status !== 100) {
      warnings.push(
        `The new invoice has status ${invoice.status ?? "unknown"} (${invoice.statusName ?? "unknown"}), ` +
          "not draft (100). Check it in sevdesk before doing anything else with it.",
      );
    }
    if (orderType !== "AN" && orderType !== "AB") {
      warnings.push(`sevdesk did not report the order type of order ${args.orderId}.`);
    }
    return present(
      { orderId: args.orderId, orderType, invoice, warnings },
      {
        summary:
          `Created invoice ${invoiceLabel(invoice)} (${invoice.statusName ?? "unknown status"}) ` +
          `from order ${args.orderId}, gross ${money(invoice.sumGross, invoice.currency)}.` +
          warningsText(warnings),
      },
    );
  },
});
