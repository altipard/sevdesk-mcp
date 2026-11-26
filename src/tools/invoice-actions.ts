import { z } from "zod";
import type { Logger } from "../logger.js";
import { defineTool, type StrictToolAnnotations } from "../policy/registry.js";
import { SevdeskError } from "../sevdesk/errors.js";
import {
  badInput,
  cents,
  entityId,
  FOREIGN_DATA_NOTE,
  integer,
  isoDate,
  objectsOf,
  text,
  todayIso,
  unixSeconds,
} from "./format.js";
import { present } from "./result.js";
import {
  contactNameOf,
  emailInput,
  type InvoiceState,
  inputText,
  invoiceLabel,
  invoiceStateSchema,
  mapInvoiceState,
  money,
  readInvoice,
  ref,
} from "./write-common.js";

/**
 * Status changes and irreversible actions on invoices (classes W+ and X).
 * Their first call returns a preview and a confirmation token (guard.ts);
 * the preview only reads. These tools cannot declare an outputSchema, so
 * each handler result is checked against the schema defined here.
 */

const STATUS_CHANGE_ANNOTATIONS: StrictToolAnnotations = {
  readOnlyHint: false,
  destructiveHint: true,
  idempotentHint: true,
  openWorldHint: true,
};

const IRREVERSIBLE_ANNOTATIONS: StrictToolAnnotations = {
  readOnlyHint: false,
  destructiveHint: true,
  idempotentHint: false,
  openWorldHint: true,
};

/**
 * The handler result checked against its schema. The action has already
 * happened at this point, so a mismatch is logged and the result returned
 * anyway: an error here would invite a second booking or e-mail.
 */
function shaped<S extends z.ZodType>(schema: S, value: z.infer<S>, logger: Logger, tool: string) {
  const parsed = schema.safeParse(value);
  if (!parsed.success) logger.error("tool output does not match its schema", { tool });
  return parsed.success ? parsed.data : value;
}

const invoiceIdInput = entityId.describe("sevdesk ID of the invoice (search_invoices).");

const statusText = (invoice: InvoiceState) =>
  `${invoice.statusName ?? "unknown"}${invoice.status === null ? "" : ` (${invoice.status})`}`;

/** Invoice facts every preview shows. */
function invoiceFacts(invoice: InvoiceState, contactName: string | null) {
  return {
    invoiceId: invoice.id,
    invoiceNumber: invoice.invoiceNumber,
    invoiceType: invoice.invoiceType,
    contact: { id: invoice.contactId, name: contactName },
    sumGross: invoice.sumGross,
    currency: invoice.currency,
    status: invoice.status,
    statusName: invoice.statusName,
  };
}

/** One line of free text for the approval question; line breaks could fake extra lines. */
const oneLine = (value: string | null, max = 200): string => {
  const flat = (value ?? "").replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
};

/** "RE-1001 (ID 1001) for Muster GmbH, gross 119 EUR" from the preview's read. */
function invoiceLine(invoice: InvoiceState, contactName: string | null): string {
  const customer = contactName ? ` for ${oneLine(contactName, 100)}` : "";
  return `${oneLine(invoiceLabel(invoice), 120)}${customer}, gross ${money(invoice.sumGross, invoice.currency)}`;
}

// ---------------------------------------------------------------------------
// mark_invoice_sent

const SEND_TYPES = {
  VPR: "printed",
  VP: "sent by post",
  VM: "sent by e-mail outside sevdesk",
  VPDF: "downloaded as PDF",
} as const;

const markSentOutput = z.object({
  invoice: invoiceStateSchema,
  sendType: z.enum(["VPR", "VP", "VM", "VPDF"]),
  statusBefore: z.number().int().nullable(),
  statusAfter: z.number().int().nullable(),
});

export const markInvoiceSent = defineTool({
  name: "mark_invoice_sent",
  title: "Mark a sevdesk invoice as sent",
  description:
    "Marks an invoice as sent (sendBy) without sending anything: VPR printed, VP by post, VM " +
    "by e-mail outside sevdesk, VPDF downloaded. A draft becomes open (status 200) and gets " +
    "its invoice number; it can be reset to draft in sevdesk. The first call returns a " +
    "preview with invoice number, contact, amount and status before/after plus a " +
    "confirmation_token; repeat the call with that token to execute. To e-mail the invoice " +
    "through sevdesk use send_invoice_email instead." +
    FOREIGN_DATA_NOTE,
  class: "W+",
  operationId: "invoiceSendBy",
  operations: ["getInvoiceById", "getContactById"],
  inputSchema: z.object({
    invoiceId: invoiceIdInput,
    sendType: z
      .enum(["VPR", "VP", "VM", "VPDF"])
      .describe("VPR printed, VP post, VM e-mail outside sevdesk, VPDF downloaded PDF."),
  }),
  annotations: STATUS_CHANGE_ANNOTATIONS,
  summary: (args) =>
    `Mark invoice ${args.invoiceId} as ${SEND_TYPES[args.sendType]} (sendBy ${args.sendType}).`,
  async preview(args, call) {
    const invoice = mapInvoiceState(await readInvoice(call, args.invoiceId));
    const warnings: string[] = [];
    if (invoice.status !== 100) {
      warnings.push(
        `The invoice is already ${statusText(invoice)}, not a draft; sendBy only records the ` +
          "send type and does not change the status.",
      );
    }
    return {
      ...invoiceFacts(invoice, await contactNameOf(call, invoice.contactId)),
      sendType: args.sendType,
      statusBefore: invoice.statusName,
      statusAfter: invoice.status === 100 ? "open" : invoice.statusName,
      warnings,
    };
  },
  async handler(args, call) {
    const before = mapInvoiceState(await readInvoice(call, args.invoiceId));
    const { sevdesk } = call;
    const body = await sevdesk.call(
      sevdesk.api.PUT("/Invoice/{invoiceId}/sendBy", {
        params: { path: { invoiceId: args.invoiceId } },
        body: { sendType: args.sendType, sendDraft: false },
      }),
    );
    const returned = objectsOf(body)[0];
    // sevdesk answers with the invoice; if not, report what is known.
    const invoice = returned ? mapInvoiceState(returned) : before;
    const output = shaped(
      markSentOutput,
      {
        invoice,
        sendType: args.sendType,
        statusBefore: before.status,
        statusAfter: returned ? invoice.status : null,
      },
      call.logger,
      "mark_invoice_sent",
    );
    return present(output, {
      summary:
        `Invoice ${invoiceLabel(invoice)} marked as ${SEND_TYPES[args.sendType]}; status ` +
        `${before.statusName ?? "unknown"} -> ${returned ? (invoice.statusName ?? "unknown") : "not reported"}.`,
    });
  },
});

// ---------------------------------------------------------------------------
// book_invoice_payment

const PAYMENT_TYPES = ["FULL_PAYMENT", "N", "CB", "O", "OF", "MTC"] as const;
type PaymentType = (typeof PAYMENT_TYPES)[number];

const bookOutput = z.object({
  invoiceId: z.number().int(),
  invoiceNumber: z.string().nullable(),
  bookedAmount: z.number(),
  date: z.string(),
  paymentType: z.enum(PAYMENT_TYPES),
  checkAccountId: z.number().int(),
  openBefore: z.number().nullable(),
  openAfterExpected: z
    .number()
    .nullable()
    .describe("Open amount before minus the booking, at least 0."),
  overpayment: z.number().describe("Amount above the open amount, 0 if none."),
  logId: z.number().int().nullable().describe("ID of sevdesk's booking log entry."),
});

/** Whether the amount has at most two decimals (whole cents). */
const wholeCents = (value: number) => Math.abs(value * 100 - Math.round(value * 100)) < 1e-6;

const openOf = (invoice: InvoiceState) => invoice.openAmount;
const bookable = (invoice: InvoiceState) => invoice.status === 200 || invoice.status === 750;

/**
 * Hint when the chosen type does not fit the amount and the open amount.
 * Only a warning: which type is right is the bookkeeper's decision.
 */
function typeMismatch(type: PaymentType, amount: number, open: number | null): string | undefined {
  if (open === null) return undefined;
  const diff = cents(amount - open);
  if (type === "FULL_PAYMENT" && diff !== 0) {
    return `FULL_PAYMENT expects the open amount (${open}), not ${amount}; use N for a partial payment, CB, MTC or O for a reduced amount, OF for reminder fees.`;
  }
  if (type === "N" && diff >= 0) {
    return `N books a partial payment, but ${amount} covers the open amount of ${open}; FULL_PAYMENT may fit better.`;
  }
  if ((type === "CB" || type === "MTC") && diff >= 0) {
    return `${type} is for a payment below the open amount (${open}), not ${amount}.`;
  }
  if (type === "OF" && diff <= 0) {
    return `OF is for a payment above the open amount (${open}) because of reminder fees, not ${amount}.`;
  }
  return undefined;
}

export const bookInvoicePayment = defineTool({
  name: "book_invoice_payment",
  title: "Book a payment on a sevdesk invoice",
  description:
    "Books a payment on an open or partially paid invoice (bookAmount) to a check account " +
    "(list_bank_accounts). paymentType is required: FULL_PAYMENT when the amount equals the " +
    "open amount; N for a partial payment, the rest stays open; CB when the customer paid less " +
    "because of a cash discount (Skonto), MTC less because of bank charges, O less or more for " +
    "another reason (these three settle the invoice); OF more because of reminder fees. " +
    "Reversible in sevdesk (reset to open) unless the invoice is enshrined. The first call " +
    "returns a preview with the open amount before and after, warns about overpayment and a " +
    "type that does not fit, plus a confirmation_token; repeat the call with that token to " +
    "book. Every confirmed call books again." +
    FOREIGN_DATA_NOTE,
  class: "W+",
  operationId: "bookInvoice",
  operations: ["getInvoiceById", "getContactById", "getCheckAccountById"],
  inputSchema: z.object({
    invoiceId: invoiceIdInput,
    amount: z
      .number()
      .positive()
      .max(1_000_000_000)
      .refine(wholeCents, { error: "must have at most two decimal places" })
      .describe("Amount paid, in invoice currency, at most two decimals."),
    date: isoDate
      .optional()
      .describe("Payment date YYYY-MM-DD; default today (German time), shown in the preview."),
    paymentType: z
      .enum(PAYMENT_TYPES)
      .describe("FULL_PAYMENT, N partial, CB Skonto, MTC bank charges, O other, OF reminder fees."),
    checkAccountId: entityId.describe("sevdesk check account the money arrived on."),
    checkAccountTransactionId: entityId
      .optional()
      .describe("Bank transaction to link (search_transactions); required for online accounts."),
  }),
  annotations: { ...STATUS_CHANGE_ANNOTATIONS, idempotentHint: false },
  summary: (args) =>
    `Book a payment of ${args.amount} (${args.paymentType}) on invoice ${args.invoiceId} to ` +
    `check account ${args.checkAccountId}.`,
  async preview(args, call) {
    const invoice = mapInvoiceState(await readInvoice(call, args.invoiceId));
    const open = openOf(invoice);
    const warnings: string[] = [];
    if (!bookable(invoice)) {
      warnings.push(
        `The invoice is ${statusText(invoice)}; sevdesk only books payments on open or ` +
          "partially paid invoices, so the booking will be refused.",
      );
    }
    const overpayment = open === null ? 0 : Math.max(0, cents(args.amount - open));
    // OF (reminder fees) and O (other difference) are meant for a higher amount.
    if (overpayment > 0 && args.paymentType !== "OF" && args.paymentType !== "O") {
      warnings.push(
        `Overpayment: ${args.amount} is ${overpayment} more than the open amount of ${open}.`,
      );
    }
    const mismatch = typeMismatch(args.paymentType, args.amount, open);
    if (mismatch) warnings.push(mismatch);
    let checkAccount: { id: number; name: string | null } = { id: args.checkAccountId, name: null };
    const { sevdesk } = call;
    const accountBody = await sevdesk.call(
      sevdesk.api.GET("/CheckAccount/{checkAccountId}", {
        params: { path: { checkAccountId: args.checkAccountId } },
      }),
    );
    const account = objectsOf(accountBody)[0];
    if (account === undefined) {
      warnings.push(`sevdesk has no check account ${args.checkAccountId}.`);
    } else {
      checkAccount = { id: args.checkAccountId, name: text(account.name) };
    }
    return {
      ...invoiceFacts(invoice, await contactNameOf(call, invoice.contactId)),
      amount: args.amount,
      date: args.date ?? todayIso(),
      paymentType: args.paymentType,
      checkAccount,
      ...(args.checkAccountTransactionId !== undefined && {
        checkAccountTransactionId: args.checkAccountTransactionId,
      }),
      openBefore: open,
      openAfter: open === null ? null : Math.max(0, cents(open - args.amount)),
      overpayment,
      warnings,
    };
  },
  async handler(args, call) {
    const invoice = mapInvoiceState(await readInvoice(call, args.invoiceId));
    // Checked again: the invoice may have changed since the preview, and
    // sevdesk refuses bookings on drafts, paid or cancelled invoices.
    if (!bookable(invoice)) {
      throw badInput(
        `Invoice ${args.invoiceId} is ${statusText(invoice)} now, so sevdesk would refuse the ` +
          "booking. Nothing was booked; call the tool again without confirmation_token for a " +
          "new preview.",
      );
    }
    const open = openOf(invoice);
    const date = args.date ?? todayIso();
    const { sevdesk } = call;
    const body = await sevdesk.call(
      sevdesk.api.PUT("/Invoice/{invoiceId}/bookAmount", {
        params: { path: { invoiceId: args.invoiceId } },
        body: {
          amount: args.amount,
          date: unixSeconds(date),
          type: args.paymentType,
          checkAccount: ref(args.checkAccountId, "CheckAccount"),
          ...(args.checkAccountTransactionId !== undefined && {
            checkAccountTransaction: ref(args.checkAccountTransactionId, "CheckAccountTransaction"),
          }),
        },
      }),
    );
    const overpayment = open === null ? 0 : Math.max(0, cents(args.amount - open));
    const output = shaped(
      bookOutput,
      {
        invoiceId: args.invoiceId,
        invoiceNumber: invoice.invoiceNumber,
        bookedAmount: args.amount,
        date,
        paymentType: args.paymentType,
        checkAccountId: args.checkAccountId,
        openBefore: open,
        openAfterExpected: open === null ? null : Math.max(0, cents(open - args.amount)),
        overpayment,
        logId: integer((body as { objects?: { id?: unknown } } | undefined)?.objects?.id),
      },
      call.logger,
      "book_invoice_payment",
    );
    return present(output, {
      summary:
        `Booked ${money(args.amount, invoice.currency)} (${args.paymentType}) on invoice ` +
        `${invoiceLabel(invoice)}; open ${output.openBefore ?? "unknown"} -> ` +
        `${output.openAfterExpected ?? "unknown"}${overpayment > 0 ? `, overpaid by ${overpayment}` : ""}.`,
    });
  },
});

// ---------------------------------------------------------------------------
// send_invoice_email

const MAX_COPIES = 10;

const emailOutput = z.object({
  invoiceId: z.number().int(),
  invoiceNumber: z.string().nullable(),
  toEmail: z.string(),
  ccEmail: z.array(z.string()),
  bccEmail: z.array(z.string()),
  subject: z.string(),
  emailId: z.number().int().nullable().describe("ID of the e-mail sevdesk logged."),
});

const listText = (label: string, list: readonly string[] | undefined) =>
  list && list.length > 0 ? `, ${label} ${list.join(", ")}` : "";

export const sendInvoiceEmail = defineTool({
  name: "send_invoice_email",
  title: "Send a sevdesk invoice by e-mail",
  description:
    "Sends an invoice to the customer by e-mail through sevdesk (sendViaEmail). This cannot be " +
    "undone: the e-mail goes out and the invoice is marked as sent. Off unless the operator " +
    "lists it in SEVDESK_ENABLE_TOOLS. Recipient, subject and text are always given " +
    "explicitly. The first call returns a preview (recipient, subject, invoice number, " +
    "amount) and a confirmation_token; the call with the token asks the user for approval " +
    "where the client supports it. Runs at most once per invoice within 24 hours." +
    FOREIGN_DATA_NOTE,
  class: "X",
  operationId: "sendInvoiceViaEMail",
  operations: ["getInvoiceById", "getContactById", "getCommunicationWays"],
  inputSchema: z.object({
    invoiceId: invoiceIdInput,
    toEmail: emailInput.describe("Recipient address."),
    // One line: the subject is part of the approval question the user sees.
    subject: inputText(200).refine((value) => !/[\r\n]/.test(value), {
      error: "must be a single line",
    }),
    text: inputText(10_000).describe("E-mail body; sevdesk accepts simple HTML."),
    ccEmail: z.array(emailInput).max(MAX_COPIES).optional(),
    bccEmail: z.array(emailInput).max(MAX_COPIES).optional(),
    copy: z.boolean().optional().describe("Send a copy to the sevdesk account's own address."),
    sendXml: z.boolean().optional().describe("Attach the e-invoice XML instead of the PDF."),
  }),
  annotations: IRREVERSIBLE_ANNOTATIONS,
  targetId: (args) => args.invoiceId,
  summary: (args) =>
    `Send invoice ${args.invoiceId} by e-mail to ${args.toEmail}` +
    `${listText("cc", args.ccEmail)}${listText("bcc", args.bccEmail)}, subject ` +
    `"${args.subject.slice(0, 80)}${args.subject.length > 80 ? "…" : ""}".`,
  async preview(args, call) {
    const invoice = mapInvoiceState(await readInvoice(call, args.invoiceId));
    const warnings: string[] = [];
    if (invoice.status !== null && invoice.status !== 100) {
      warnings.push(`The invoice is already ${statusText(invoice)}; it may have been sent before.`);
    }
    const known: string[] = [];
    if (invoice.contactId !== null) {
      const { sevdesk } = call;
      const ways = await sevdesk.call(
        sevdesk.api.GET("/CommunicationWay", {
          params: {
            query: {
              "contact[id]": String(invoice.contactId),
              "contact[objectName]": "Contact",
              type: "EMAIL",
            },
          },
        }),
      );
      for (const way of objectsOf(ways)) {
        const value = text(way.value);
        if (value !== null) known.push(value);
      }
    }
    const recipientKnown = known.some(
      (value) => value.toLowerCase() === args.toEmail.toLowerCase(),
    );
    if (!recipientKnown) {
      warnings.push(
        `${args.toEmail} is not an e-mail address of the invoice's contact in sevdesk` +
          `${known.length > 0 ? ` (known: ${known.join(", ")})` : ""}.`,
      );
    }
    const contactName = await contactNameOf(call, invoice.contactId);
    const copies = [
      args.ccEmail?.length ? `cc ${args.ccEmail.join(", ")}` : "",
      args.bccEmail?.length ? `bcc ${args.bccEmail.join(", ")}` : "",
    ].filter(Boolean);
    return {
      approval:
        `Send invoice ${invoiceLine(invoice, contactName)}, by e-mail to ${args.toEmail}` +
        `${copies.length > 0 ? ` (${copies.join("; ")})` : ""}. Subject: "${oneLine(args.subject)}". ` +
        `Text: "${oneLine(args.text, 160)}". Attachment: ${args.sendXml ? "e-invoice XML" : "PDF"}.` +
        `${warnings.length > 0 ? ` Warnings: ${warnings.map((w) => oneLine(w, 300)).join(" ")}` : ""}`,
      ...invoiceFacts(invoice, contactName),
      toEmail: args.toEmail,
      ccEmail: args.ccEmail ?? [],
      bccEmail: args.bccEmail ?? [],
      subject: args.subject,
      textPreview: args.text.slice(0, 500),
      attachment: args.sendXml ? "e-invoice XML" : "PDF",
      warnings,
    };
  },
  async handler(args, call) {
    // Only for the invoice number in the answer. The idempotency key is
    // already taken here, so a failing read must not end the call: it would
    // block the invoice for 24 hours without anything having been sent.
    let invoiceNumber: string | null = null;
    try {
      invoiceNumber = mapInvoiceState(await readInvoice(call, args.invoiceId)).invoiceNumber;
    } catch (error) {
      if (!(error instanceof SevdeskError) || error.kind === "policy") throw error;
    }
    const { sevdesk } = call;
    const body = await sevdesk.call(
      sevdesk.api.POST("/Invoice/{invoiceId}/sendViaEmail", {
        params: { path: { invoiceId: args.invoiceId } },
        body: {
          toEmail: args.toEmail,
          subject: args.subject,
          text: args.text,
          ...(args.copy !== undefined && { copy: args.copy }),
          ...(args.ccEmail && args.ccEmail.length > 0 && { ccEmail: args.ccEmail.join(",") }),
          ...(args.bccEmail && args.bccEmail.length > 0 && { bccEmail: args.bccEmail.join(",") }),
          ...(args.sendXml !== undefined && { sendXml: args.sendXml }),
        },
      }),
    );
    const email = objectsOf(body)[0];
    const output = shaped(
      emailOutput,
      {
        invoiceId: args.invoiceId,
        invoiceNumber,
        toEmail: args.toEmail,
        ccEmail: args.ccEmail ?? [],
        bccEmail: args.bccEmail ?? [],
        subject: args.subject,
        emailId: email ? integer(email.id) : null,
      },
      call.logger,
      "send_invoice_email",
    );
    return present(output, {
      summary: `Invoice ${invoiceNumber ? `${invoiceNumber} (ID ${args.invoiceId})` : args.invoiceId} was sent by e-mail to ${args.toEmail}.`,
    });
  },
});

// ---------------------------------------------------------------------------
// cancel_invoice

const cancelOutput = z.object({
  cancelledInvoiceId: z.number().int(),
  cancellationInvoice: invoiceStateSchema.nullable().describe("The new cancellation invoice (SR)."),
});

export const cancelInvoice = defineTool({
  name: "cancel_invoice",
  title: "Cancel a sevdesk invoice",
  description:
    "Cancels an invoice by creating a numbered cancellation invoice (Stornorechnung, SR), " +
    "which sevdesk marks as paid; the original becomes cancelled. This cannot be undone. " +
    "Off unless the operator lists it in SEVDESK_ENABLE_TOOLS. The first call returns a " +
    "preview (invoice number, contact, amount, status) and a confirmation_token; the call " +
    "with the token asks the user for approval where the client supports it. Runs at most " +
    "once per invoice within 24 hours." +
    FOREIGN_DATA_NOTE,
  class: "X",
  operationId: "cancelInvoice",
  operations: ["getInvoiceById", "getContactById"],
  inputSchema: z.object({ invoiceId: invoiceIdInput }),
  annotations: IRREVERSIBLE_ANNOTATIONS,
  targetId: (args) => args.invoiceId,
  summary: (args) =>
    `Cancel invoice ${args.invoiceId}: sevdesk creates a numbered cancellation invoice.`,
  async preview(args, call) {
    const invoice = mapInvoiceState(await readInvoice(call, args.invoiceId));
    const warnings: string[] = [];
    if (invoice.status === 100) {
      warnings.push("The invoice is still a draft; sevdesk does not cancel drafts.");
    }
    if (invoice.invoiceType === "SR") {
      warnings.push("This is already a cancellation invoice (SR).");
    }
    const contactName = await contactNameOf(call, invoice.contactId);
    return {
      approval:
        `Cancel invoice ${invoiceLine(invoice, contactName)}: sevdesk creates a numbered ` +
        "cancellation invoice (SR) over the full amount." +
        `${warnings.length > 0 ? ` Warnings: ${warnings.join(" ")}` : ""}`,
      ...invoiceFacts(invoice, contactName),
      effect: "A cancellation invoice (SR) over the full amount is created and marked as paid.",
      warnings,
    };
  },
  async handler(args, { sevdesk, logger }) {
    const body = await sevdesk.call(
      sevdesk.api.POST("/Invoice/{invoiceId}/cancelInvoice", {
        params: { path: { invoiceId: args.invoiceId } },
      }),
    );
    const raw = objectsOf(body)[0];
    const cancellation = raw ? mapInvoiceState(raw) : null;
    const output = shaped(
      cancelOutput,
      {
        cancelledInvoiceId: args.invoiceId,
        cancellationInvoice: cancellation,
      },
      logger,
      "cancel_invoice",
    );
    return present(output, {
      summary: cancellation
        ? `Invoice ${args.invoiceId} was cancelled; cancellation invoice ${invoiceLabel(cancellation)}.`
        : `Invoice ${args.invoiceId} was cancelled; sevdesk returned no cancellation invoice, check sevdesk.`,
    });
  },
});
