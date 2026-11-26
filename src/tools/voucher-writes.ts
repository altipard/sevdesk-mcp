import { z } from "zod";
import { defineTool } from "../policy/registry.js";
import { SevdeskError } from "../sevdesk/errors.js";
import { documentLabel, documentLine, readDocument, statusText } from "./document-common.js";
import {
  amount,
  asRecord,
  badInput,
  entityId,
  FOREIGN_DATA_NOTE,
  integer,
  isoDate,
  isoDateOf,
  objectsOf,
  type Raw,
  refId,
  statusOf,
  text,
  unixSeconds,
  VOUCHER_STATUS,
} from "./format.js";
import { present } from "./result.js";
import {
  bookingLogId,
  CREATE_ANNOTATIONS,
  checkVoucherTax,
  contactName,
  inputText,
  money,
  OVERPAYING_PAYMENT_TYPES,
  oneLineText,
  openAfterPayment,
  overpaymentOf,
  overpaymentWarning,
  PAYMENT_TYPES,
  paymentAmountInput,
  paymentTypeMismatch,
  readContact,
  ref,
  SETTLING_PAYMENT_TYPES,
  STATUS_CHANGE_ANNOTATIONS,
  sevdeskDate,
  shapedOutput,
  taxCheckSchema,
  toCents,
  VOUCHER_TAX_RULE_IDS,
  wholeCents,
} from "./write-common.js";

/**
 * Vouchers (Belege): create a draft with an optional file (class W) and
 * book a payment on it (class W+, preview and confirmation token first).
 */

// ---------------------------------------------------------------------------
// File upload checks (all before anything is sent)

/**
 * Largest file accepted, decoded. The file travels as base64 inside the
 * JSON-RPC message (4/3 of its size plus the JSON envelope). The SDK's HTTP
 * transport refuses bodies over 4 MiB and an oversized stdio message ends
 * the whole session, so 2.5 MiB (about 3.4 MiB as base64) keeps every
 * transport safely below its limit. Raise it together with the transports.
 */
export const MAX_VOUCHER_FILE_BYTES = 2.5 * 1024 * 1024;
const MAX_FILE_MIB = MAX_VOUCHER_FILE_BYTES / 1024 / 1024;
/** Base64 length of the largest file, with padding. */
const MAX_BASE64_LENGTH = Math.ceil(MAX_VOUCHER_FILE_BYTES / 3) * 4;

const FILE_TYPES = {
  "application/pdf": { extensions: [".pdf"], magic: [[0x25, 0x50, 0x44, 0x46, 0x2d]] },
  "image/png": {
    extensions: [".png"],
    magic: [[0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]],
  },
  "image/jpeg": { extensions: [".jpg", ".jpeg"], magic: [[0xff, 0xd8, 0xff]] },
} as const satisfies Record<string, { extensions: readonly string[]; magic: readonly number[][] }>;
type FileType = keyof typeof FILE_TYPES;
const MIME_TYPES = Object.keys(FILE_TYPES) as [FileType, ...FileType[]];

const fileInput = z
  .object({
    content: z
      .string()
      .min(1)
      .max(MAX_BASE64_LENGTH)
      .describe("File content as plain base64 (no data: prefix, no line breaks)."),
    filename: inputText(200)
      .refine((value) => !/[/\\\r\n\t"]/.test(value), {
        error: "must be a plain file name without path, quotes or line breaks",
      })
      .describe("Original file name, e.g. rechnung-4711.pdf; the extension must fit mimeType."),
    mimeType: z.enum(MIME_TYPES).describe("application/pdf, image/png or image/jpeg."),
  })
  .describe(`Receipt file to attach: PDF, PNG or JPEG up to ${MAX_FILE_MIB} MiB.`);
type FileInput = z.infer<typeof fileInput>;

const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/;
const BASE64_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

/**
 * Whether the bits a padded group leaves unused are zero. Buffer.from
 * ignores them, so "QR==" and "QQ==" would decode alike; only the
 * canonical form is accepted. Checked on the string, without re-encoding.
 */
function canonicalPadding(content: string): boolean {
  const padding = content.endsWith("==") ? 2 : content.endsWith("=") ? 1 : 0;
  if (padding === 0) return true;
  const last = BASE64_ALPHABET.indexOf(content.charAt(content.length - padding - 1));
  return (last & (padding === 2 ? 0x0f : 0x03)) === 0;
}

/**
 * PDF readers accept the header anywhere in the first 1024 bytes and look
 * for the end marker in the last 1024. Requiring both keeps out files that
 * only carry "%PDF-" in a preamble (polyglots).
 */
const PDF_WINDOW = 1024;
const PDF_END = Buffer.from("%%EOF", "latin1");

/**
 * The decoded file, or an input error: strict base64 (Buffer.from skips
 * anything it does not understand), size limit and content that matches
 * the declared type and extension.
 */
export function decodeVoucherFile(file: FileInput): Buffer {
  const { content, filename, mimeType } = file;
  if (content.length % 4 !== 0 || !BASE64.test(content)) {
    throw badInput(
      "file.content is not valid base64 (only A-Z, a-z, 0-9, + and /, padded with = to a " +
        "multiple of 4 characters, without data: prefix or line breaks). Nothing was sent.",
    );
  }
  if (!canonicalPadding(content)) {
    throw badInput("file.content is not canonical base64. Nothing was sent.");
  }
  const bytes = Buffer.from(content, "base64");
  if (bytes.length === 0) throw badInput("file.content is empty. Nothing was sent.");
  if (bytes.length > MAX_VOUCHER_FILE_BYTES) {
    throw badInput(
      `The file has ${bytes.length} bytes; at most ${MAX_VOUCHER_FILE_BYTES} (${MAX_FILE_MIB} MiB) are ` +
        "accepted. Nothing was sent.",
    );
  }
  const type = FILE_TYPES[mimeType];
  const matches =
    mimeType === "application/pdf"
      ? bytes.subarray(0, PDF_WINDOW).includes(Buffer.from(type.magic[0])) &&
        bytes.subarray(Math.max(0, bytes.length - PDF_WINDOW)).includes(PDF_END)
      : type.magic.some((magic) => magic.every((byte, i) => bytes[i] === byte));
  if (!matches) {
    throw badInput(
      `The file content is not a ${mimeType} file (its start or end markers do not match). Only PDF, ` +
        "PNG and JPEG are accepted. Nothing was sent.",
    );
  }
  const lower = filename.toLowerCase();
  if (!type.extensions.some((extension) => lower.endsWith(extension))) {
    throw badInput(
      `file.filename must end with ${type.extensions.join(" or ")} for ${mimeType}. Nothing was sent.`,
    );
  }
  return bytes;
}

// ---------------------------------------------------------------------------
// create_voucher

const MAX_VOUCHER_POSITIONS = 100;

const voucherPositionInput = z.object({
  accountDatevId: entityId.describe(
    "Booking account (accountDatevId from get_tax_guidance, scope expense or revenue).",
  ),
  taxRate: z.number().min(0).max(100).describe("Tax rate in percent, e.g. 19, 7 or 0."),
  amount: z
    .number()
    .positive()
    .max(1_000_000_000)
    .refine(wholeCents, { error: "must have at most two decimal places" })
    .describe("Position amount, gross or net as set in amountsAre, at most two decimals."),
  comment: inputText(250).optional().describe("Text of the position."),
});

const voucherStateSchema = z.object({
  id: z.number().int(),
  description: z.string().nullable().describe("Voucher number or text, as entered."),
  status: z.number().int().nullable(),
  statusName: z.string().nullable(),
  creditDebit: z.string().nullable(),
  voucherDate: z.string().nullable(),
  supplierId: z.number().int().nullable(),
  supplierName: z.string().nullable(),
  currency: z.string().nullable(),
  sumNet: z.number().nullable(),
  sumGross: z.number().nullable(),
  hasDocument: z.boolean().describe("sevdesk reports an attached file."),
});

function mapVoucherState(raw: Raw): z.infer<typeof voucherStateSchema> {
  return {
    id: integer(raw.id) ?? 0,
    description: text(raw.description),
    ...statusOf(raw.status, VOUCHER_STATUS),
    creditDebit: text(raw.creditDebit),
    voucherDate: isoDateOf(raw.voucherDate),
    supplierId: refId(raw.supplier),
    supplierName: text(raw.supplierName),
    currency: text(raw.currency),
    sumNet: amount(raw.sumNet),
    sumGross: amount(raw.sumGross),
    hasDocument: refId(raw.document) !== null,
  };
}

const createVoucherOutput = z.object({
  voucher: voucherStateSchema,
  taxRule: taxCheckSchema,
  positions: z.number().int().describe("Number of positions sent."),
  amountsAre: z.enum(["gross", "net"]),
  expectedSum: z.number().describe("Sum of the position amounts as sent (gross or net)."),
  file: z
    .object({
      filename: z.string(),
      mimeType: z.string(),
      bytes: z.number().int(),
      sevdeskFilename: z.string().describe("Name sevdesk gave the uploaded file."),
    })
    .nullable(),
  warnings: z.array(z.string()),
});

/** sevdesk's name for an uploaded file: a hash with an extension. */
const SEVDESK_FILENAME = /^[A-Za-z0-9._-]{1,200}$/;

/**
 * Error for a failed upload. saveVoucher was not called, so no voucher can
 * exist, whatever the upload's own outcome; the message says so instead of
 * sending the caller to look for one.
 */
function uploadFailed(error: unknown): unknown {
  if (!(error instanceof SevdeskError) || error.kind === "policy") return error;
  return new SevdeskError(
    error.kind,
    `The file upload failed: ${error.message} No voucher was created.`,
    error.status === undefined ? {} : { status: error.status },
  );
}

/** Error for a saveVoucher that failed after the file was uploaded. */
function afterUpload(error: unknown): unknown {
  if (!(error instanceof SevdeskError) || error.kind === "policy") return error;
  const status = error.status;
  const refused = status !== undefined && status >= 400 && status < 500;
  return new SevdeskError(
    error.kind,
    `The file was uploaded to sevdesk's temporary storage, but saving the voucher failed: ` +
      `${error.message}${refused ? " No voucher was created; the uploaded file is not attached to anything." : ""}`,
    status === undefined ? {} : { status },
  );
}

const warningsText = (warnings: readonly string[]) =>
  warnings.length > 0 ? ` ${warnings.length} warning(s), see warnings.` : "";

export const createVoucher = defineTool({
  name: "create_voucher",
  title: "Create a sevdesk voucher",
  description:
    "Creates a voucher (Beleg) as draft (status 50) in sevdesk, optionally with the receipt " +
    `file attached (PDF, PNG or JPEG up to ${MAX_FILE_MIB} MiB, given as base64). creditDebit D is an ` +
    "expense (incoming invoice, receipt), C an income. Each position has a booking account " +
    "(accountDatevId), a tax rate and an amount; tax rule, accounts and rates are checked " +
    "against sevdesk's documented rules and the account's tax guidance (get_tax_guidance) " +
    "before anything is sent. The draft must be completed and registered in sevdesk before " +
    "a payment can be booked on it. Every call creates a new voucher." +
    FOREIGN_DATA_NOTE,
  class: "W",
  operationId: "voucherFactorySaveVoucher",
  operations: ["voucherUploadFile", "forExpense", "forRevenue", "getContactById"],
  inputSchema: z.object({
    creditDebit: z.enum(["D", "C"]).default("D").describe("D expense (default), C income."),
    voucherDate: isoDate.describe("Date of the receipt, YYYY-MM-DD."),
    deliveryDate: isoDate.optional().describe("Date of delivery or service; default voucherDate."),
    paymentDeadline: isoDate.optional().describe("Due date, YYYY-MM-DD."),
    description: inputText(100)
      .optional()
      .describe("Voucher number or short text, e.g. the supplier's invoice number."),
    supplierId: entityId
      .optional()
      .describe("sevdesk contact of the supplier (or customer for C); or give supplierName."),
    supplierName: inputText(200)
      .optional()
      .describe("Supplier name without a sevdesk contact; not together with supplierId."),
    taxRule: z
      .number()
      .int()
      .refine((id) => VOUCHER_TAX_RULE_IDS.includes(id), {
        error: `must be a voucher tax rule: ${VOUCHER_TAX_RULE_IDS.join(", ")}`,
      })
      .describe(
        "sevdesk tax rule (bookkeeping 2.0). Expense (D): 8 EU acquisitions, 9 input tax " +
          "deductible (0/7/19 %), 10 not deductible, 12-14 reverse charge. Income (C): 1 taxable " +
          "(0/7/19 %), 2 exports, 3 EU deliveries, 4 tax-free, 5 reverse charge, 11 small " +
          "business, 17 not taxable in Germany.",
      ),
    amountsAre: z
      .enum(["gross", "net"])
      .default("gross")
      .describe("Whether position amounts are gross (default) or net; the same for all."),
    positions: z
      .array(voucherPositionInput)
      .min(1)
      .max(MAX_VOUCHER_POSITIONS)
      .describe(`1-${MAX_VOUCHER_POSITIONS} positions.`),
    file: fileInput.optional(),
  }),
  outputSchema: createVoucherOutput,
  annotations: CREATE_ANNOTATIONS,
  async handler(args, call) {
    // Local checks first: a bad file or input sends nothing at all.
    if (args.supplierId !== undefined && args.supplierName !== undefined) {
      throw badInput("Give supplierId or supplierName, not both.");
    }
    const fileBytes = args.file ? decodeVoucherFile(args.file) : undefined;

    const warnings: string[] = [];
    if (args.deliveryDate !== undefined && args.deliveryDate > args.voucherDate) {
      warnings.push(
        `deliveryDate ${args.deliveryDate} is after voucherDate ${args.voucherDate}; check that ` +
          "both dates are right.",
      );
    }
    let supplierName: string | null = args.supplierName ?? null;
    if (args.supplierId !== undefined) {
      supplierName = contactName(await readContact(call, args.supplierId));
    }
    const tax = await checkVoucherTax(
      call,
      args.creditDebit,
      args.taxRule,
      args.positions,
      warnings,
    );

    const { sevdesk } = call;
    let sevdeskFilename: string | undefined;
    if (args.file && fileBytes) {
      const form = new FormData();
      form.append(
        "file",
        // A view on the decoded bytes, no copy.
        new Blob([fileBytes as Uint8Array<ArrayBuffer>], { type: args.file.mimeType }),
        args.file.filename,
      );
      let uploaded: unknown;
      try {
        uploaded = await sevdesk.call(
          sevdesk.api.POST("/Voucher/Factory/uploadTempFile", {
            body: form as never,
            bodySerializer: (body: unknown) => body as FormData,
          }),
        );
      } catch (error) {
        throw uploadFailed(error);
      }
      const name = text(objectsOf(uploaded)[0]?.filename);
      if (name === null || !SEVDESK_FILENAME.test(name)) {
        throw new SevdeskError(
          "http_error",
          "sevdesk accepted the file upload but returned no usable file name. No voucher was " +
            "created; the uploaded file is not attached to anything.",
        );
      }
      sevdeskFilename = name;
    }

    const net = args.amountsAre === "net";
    const body = {
      voucher: {
        objectName: "Voucher",
        mapAll: true,
        voucherDate: sevdeskDate(args.voucherDate),
        deliveryDate: sevdeskDate(args.deliveryDate ?? args.voucherDate),
        ...(args.paymentDeadline !== undefined && {
          paymentDeadline: sevdeskDate(args.paymentDeadline),
        }),
        ...(args.supplierId !== undefined && { supplier: ref(args.supplierId, "Contact") }),
        ...(args.supplierName !== undefined && { supplierName: args.supplierName }),
        ...(args.description !== undefined && { description: args.description }),
        // Drafts only; the server pins this field as well.
        status: 50,
        taxRule: ref(tax.id, "TaxRule"),
        creditDebit: args.creditDebit,
        voucherType: "VOU",
      },
      voucherPosSave: args.positions.map((p) => ({
        objectName: "VoucherPos",
        mapAll: true,
        accountDatev: ref(p.accountDatevId, "AccountDatev"),
        taxRate: p.taxRate,
        net,
        ...(net ? { sumNet: p.amount } : { sumGross: p.amount }),
        ...(p.comment !== undefined && { comment: p.comment }),
      })),
      // The spec asks for these two last, in this order.
      voucherPosDelete: null,
      ...(sevdeskFilename !== undefined && { filename: sevdeskFilename }),
    };
    let saved: unknown;
    try {
      saved = await sevdesk.call(
        sevdesk.api.POST("/Voucher/Factory/saveVoucher", { body: body as never }),
      );
    } catch (error) {
      throw sevdeskFilename === undefined ? error : afterUpload(error);
    }
    const raw = asRecord(objectsOf(saved)[0]?.voucher ?? asRecord(saved).voucher);
    if (integer(raw.id) === null) {
      throw new SevdeskError(
        "http_error",
        "sevdesk accepted the voucher but returned no ID; check sevdesk before creating it again.",
      );
    }
    const voucher = mapVoucherState(raw);
    const expectedCents = args.positions.reduce((sum, p) => sum + toCents(p.amount), 0);
    const expectedSum = expectedCents / 100;
    const reported = net ? voucher.sumNet : voucher.sumGross;
    if (reported !== null && Math.abs(toCents(reported) - expectedCents) > args.positions.length) {
      warnings.push(
        `Sum mismatch: sevdesk reports a ${args.amountsAre} sum of ${reported}, the positions ` +
          `add up to ${expectedSum}. Check the voucher in sevdesk.`,
      );
    }
    if (voucher.status !== 50) {
      warnings.push(
        `sevdesk reports status ${voucher.status ?? "unknown"} instead of draft (50); check the voucher in sevdesk.`,
      );
    }
    if (sevdeskFilename !== undefined && !voucher.hasDocument) {
      warnings.push("sevdesk did not report an attached document; check the file in sevdesk.");
    }
    const output = {
      voucher: { ...voucher, supplierName: voucher.supplierName ?? supplierName },
      taxRule: tax,
      positions: args.positions.length,
      amountsAre: args.amountsAre,
      expectedSum,
      file:
        args.file && fileBytes && sevdeskFilename
          ? {
              filename: args.file.filename,
              mimeType: args.file.mimeType,
              bytes: fileBytes.length,
              sevdeskFilename,
            }
          : null,
      warnings,
    };
    return present(output, {
      summary:
        `Created voucher draft ${voucher.id} (${args.creditDebit === "D" ? "expense" : "income"}): ` +
        `${args.positions.length} positions, ${args.amountsAre} ${money(reported ?? expectedSum, voucher.currency)}, ` +
        `tax rule ${tax.id}${output.file ? ", file attached" : ""}.${warningsText(warnings)}`,
    });
  },
});

// ---------------------------------------------------------------------------
// book_voucher_payment

/** Statuses sevdesk books payments on: unpaid, transferred and partially paid. */
const BOOKABLE = [100, 150, 750];

const enshrinedText = (id: number) =>
  `Voucher ${id} is enshrined (festgeschrieben); this server refuses payments on enshrined ` +
  "vouchers. Nothing was booked.";

const bookVoucherOutput = z.object({
  voucherId: z.number().int(),
  voucherNumber: z.string().nullable().describe("Description of the voucher, as entered."),
  bookedAmount: z.number(),
  date: z.string(),
  paymentType: z.enum(PAYMENT_TYPES),
  checkAccountId: z.number().int(),
  openBefore: z.number().nullable(),
  openAfterExpected: z
    .number()
    .nullable()
    .describe(
      "Open amount before minus the booking, at least 0; 0 for CB, MTC and O (expected settled).",
    ),
  overpayment: z.number().describe("Amount above the open amount, 0 if none."),
  logId: z.number().int().nullable().describe("ID of sevdesk's booking log entry."),
});

export const bookVoucherPayment = defineTool({
  name: "book_voucher_payment",
  title: "Book a payment on a sevdesk voucher",
  description:
    "Books a payment on an unpaid or partially paid voucher (bookAmount) to a check account " +
    "(list_bank_accounts). paymentType is required: FULL_PAYMENT when the amount equals the " +
    "open amount; N for a partial payment, the rest stays open; CB less because of a cash " +
    "discount (Skonto), MTC less because of bank charges, O less or more for another reason " +
    "(these three settle the voucher); OF more because of reminder fees. Drafts cannot be " +
    "booked. Reversible in sevdesk (reset to open) unless the voucher is enshrined. The " +
    "first call returns a preview with the open amount before and after, warns about " +
    "overpayment and a type that does not fit, plus a confirmation_token; repeat the call " +
    "with that token to book. Every confirmed call books again." +
    FOREIGN_DATA_NOTE,
  class: "W+",
  operationId: "bookVoucher",
  operations: ["getVoucherById", "getContactById", "getCheckAccountById"],
  inputSchema: z.object({
    voucherId: entityId.describe("sevdesk ID of the voucher (search_vouchers)."),
    amount: paymentAmountInput.describe("Amount paid, at most two decimals."),
    // Required: a default would be resolved again at execution and is not
    // bound to the token.
    date: isoDate.describe("Payment date YYYY-MM-DD (German calendar)."),
    paymentType: z
      .enum(PAYMENT_TYPES)
      .describe("FULL_PAYMENT, N partial, CB Skonto, MTC bank charges, O other, OF reminder fees."),
    checkAccountId: entityId.describe("sevdesk check account the money left or arrived on."),
    checkAccountTransactionId: entityId
      .optional()
      .describe("Bank transaction to link (search_transactions); required for online accounts."),
  }),
  annotations: { ...STATUS_CHANGE_ANNOTATIONS, idempotentHint: false },
  targetId: (args) => `voucher:${args.voucherId}`,
  summary: (args) =>
    `Book a payment of ${args.amount} (${args.paymentType}) on voucher ${args.voucherId} to ` +
    `check account ${args.checkAccountId}.`,
  async preview(args, call) {
    const voucher = await readDocument(call, "voucher", args.voucherId);
    if (voucher.enshrined) throw badInput(enshrinedText(args.voucherId));
    const open = voucher.openAmount;
    const warnings: string[] = [];
    if (voucher.status === null || !BOOKABLE.includes(voucher.status)) {
      warnings.push(
        `The voucher is ${statusText(voucher)}; sevdesk only books payments on unpaid or ` +
          "partially paid vouchers, so the booking will be refused.",
      );
    }
    const overpayment = overpaymentOf(args.amount, open);
    if (overpayment > 0 && !OVERPAYING_PAYMENT_TYPES.includes(args.paymentType)) {
      warnings.push(overpaymentWarning(args.amount, overpayment, open));
    }
    const after = openAfterPayment(args.paymentType, args.amount, open);
    // Expected only: the spec says these types settle the rest, not that
    // sevdesk then lists the voucher as paid.
    const expectedSettled = SETTLING_PAYMENT_TYPES.includes(args.paymentType);
    const mismatch = paymentTypeMismatch(args.paymentType, args.amount, open);
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
      approval:
        `Book ${money(args.amount, voucher.currency)} (${args.paymentType}) dated ${args.date} on ` +
        `${documentLine(voucher)} to check account ${args.checkAccountId}` +
        `${checkAccount.name ? ` (${oneLineText(checkAccount.name, 100)})` : ""}; open ` +
        `${open ?? "unknown"} -> ${after ?? "unknown"}${expectedSettled ? " (expected settled)" : ""}.` +
        `${warnings.length > 0 ? ` Warnings: ${warnings.join(" ")}` : ""}`,
      voucher,
      amount: args.amount,
      date: args.date,
      paymentType: args.paymentType,
      checkAccount,
      ...(args.checkAccountTransactionId !== undefined && {
        checkAccountTransactionId: args.checkAccountTransactionId,
      }),
      openBefore: open,
      openAfter: after,
      expectedSettled,
      overpayment,
      warnings,
    };
  },
  async handler(args, call) {
    const voucher = await readDocument(call, "voucher", args.voucherId);
    // Checked again: the voucher may have changed since the preview.
    if (voucher.status === null || !BOOKABLE.includes(voucher.status)) {
      throw badInput(
        `Voucher ${args.voucherId} is ${statusText(voucher)} now, so sevdesk would refuse the ` +
          "booking. Nothing was booked; call the tool again without confirmation_token for a " +
          "new preview.",
      );
    }
    if (voucher.enshrined) {
      throw badInput(
        `${enshrinedText(args.voucherId)} Call the tool again without confirmation_token for a new preview.`,
      );
    }
    const open = voucher.openAmount;
    // The open amount may have dropped since the preview (another payment);
    // an overpayment sevdesk can only book as O or OF is refused here.
    const overpayment = overpaymentOf(args.amount, open);
    if (overpayment > 0 && !OVERPAYING_PAYMENT_TYPES.includes(args.paymentType)) {
      throw badInput(
        `Voucher ${args.voucherId} has ${open} open now; ${args.amount} would overpay it by ` +
          `${overpayment}; this server refuses overpayments without type O or OF. Nothing was booked; call the tool ` +
          "again without confirmation_token for a new preview.",
      );
    }
    const { sevdesk } = call;
    const body = await sevdesk.call(
      sevdesk.api.PUT("/Voucher/{voucherId}/bookAmount", {
        params: { path: { voucherId: args.voucherId } },
        body: {
          amount: args.amount,
          date: unixSeconds(args.date),
          type: args.paymentType,
          checkAccount: ref(args.checkAccountId, "CheckAccount"),
          ...(args.checkAccountTransactionId !== undefined && {
            checkAccountTransaction: ref(args.checkAccountTransactionId, "CheckAccountTransaction"),
          }),
        } as never,
      }),
    );
    const output = shapedOutput(
      bookVoucherOutput,
      {
        voucherId: args.voucherId,
        voucherNumber: voucher.number,
        bookedAmount: args.amount,
        date: args.date,
        paymentType: args.paymentType,
        checkAccountId: args.checkAccountId,
        openBefore: open,
        openAfterExpected: openAfterPayment(args.paymentType, args.amount, open),
        overpayment,
        logId: bookingLogId(body),
      },
      call.logger,
      "book_voucher_payment",
    );
    return present(output, {
      summary:
        `Booked ${money(args.amount, voucher.currency)} (${args.paymentType}) on voucher ` +
        `${documentLabel(voucher)}; open ${output.openBefore ?? "unknown"} -> ` +
        `${output.openAfterExpected ?? "unknown"}${overpayment > 0 ? `, overpaid by ${overpayment}` : ""}.`,
    });
  },
});
