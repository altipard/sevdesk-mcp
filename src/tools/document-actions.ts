import { z } from "zod";
import { defineTool, type ToolCall } from "../policy/registry.js";
import { SevdeskError } from "../sevdesk/errors.js";
import {
  capitalized,
  DOCUMENT_LABELS,
  type DocumentFacts,
  documentFactsSchema,
  documentIdInput,
  documentLabel,
  documentLine,
  OBJECT_NAMES,
  readDocument,
  readDocumentWithRaw,
  statusText,
} from "./document-common.js";
import { asRecord, badInput, FOREIGN_DATA_NOTE, integer, objectsOf, text } from "./format.js";
import { present } from "./result.js";
import {
  CREATE_ANNOTATIONS,
  IRREVERSIBLE_ANNOTATIONS,
  inputText,
  oneLineText,
  ref,
  STATUS_CHANGE_ANNOTATIONS,
  shapedOutput,
} from "./write-common.js";

/**
 * Status resets, tags and enshrining for invoices, credit notes, vouchers
 * and orders. reset_document_status (W+) and enshrine_document (X) return
 * a preview and a confirmation token first (guard.ts); the preview only
 * reads.
 */

// ---------------------------------------------------------------------------
// reset_document_status

const RESETTABLE = ["invoice", "credit_note", "voucher"] as const;
type Resettable = (typeof RESETTABLE)[number];
type Target = "draft" | "open";

/** Status codes of draft and open per document type. */
const TARGET_STATUS: Readonly<Record<Resettable, Record<Target, number>>> = {
  invoice: { draft: 100, open: 200 },
  credit_note: { draft: 100, open: 200 },
  voucher: { draft: 50, open: 100 },
};

/**
 * Statuses the spec allows each reset from: invoices and credit notes go
 * to draft only from open (resetToOpen first for anything paid), vouchers
 * from any higher status; to open only from a higher status.
 */
const RESET_FROM: Readonly<Record<Resettable, Record<Target, readonly number[]>>> = {
  invoice: { draft: [200], open: [750, 1000] },
  credit_note: { draft: [200], open: [750, 1000] },
  // The spec only says "from higher to lower" for vouchers.
  voucher: { draft: [100, 150, 750, 1000], open: [150, 750, 1000] },
};

/** Why a reset cannot run, or undefined. Checked in the preview and again before the reset. */
function resetProblem(
  type: Resettable,
  target: Target,
  facts: DocumentFacts,
  invoiceType: string | null,
): string | undefined {
  const label = `${DOCUMENT_LABELS[type]} ${facts.id}`;
  if (facts.enshrined) {
    return `The ${label} is enshrined (festgeschrieben); sevdesk does not reset enshrined documents. Nothing was changed.`;
  }
  if (type === "invoice" && invoiceType === "WKR") {
    return `The ${label} is a recurring invoice (WKR); sevdesk does not reset those to ${target}.`;
  }
  const allowed = RESET_FROM[type][target];
  if (facts.status !== null && allowed.includes(facts.status)) return undefined;
  const hint =
    target === "draft" &&
    type !== "voucher" &&
    facts.status !== null &&
    facts.status > TARGET_STATUS[type].open
      ? " Reset it to open first, then to draft."
      : "";
  return (
    `The ${label} is ${statusText(facts)}; sevdesk resets to ${target} only from status ` +
    `${allowed.join(", ")}.${hint}`
  );
}

function resetWarnings(type: Resettable, facts: DocumentFacts): string[] {
  const paid =
    facts.paidAmount !== null && facts.paidAmount > 0 ? ` (paid so far: ${facts.paidAmount})` : "";
  const warnings = [
    `Linked payments and bank transactions will be unlinked from the ${DOCUMENT_LABELS[type]}${paid}; ` +
      "they have to be booked again afterwards.",
  ];
  if (type === "voucher")
    warnings.push("Asset depreciation created for the voucher will be reset.");
  warnings.push("sevdesk refuses the reset if one of the linked bank transactions is enshrined.");
  return warnings;
}

/** The document and its reset problem, if any. */
async function readForReset(
  call: ToolCall,
  args: { documentType: Resettable; documentId: number; target: Target },
) {
  const { facts, raw } = await readDocumentWithRaw(call, args.documentType, args.documentId);
  const invoiceType = args.documentType === "invoice" ? text(raw.invoiceType) : null;
  return { facts, problem: resetProblem(args.documentType, args.target, facts, invoiceType) };
}

const resetOutput = z.object({
  document: documentFactsSchema.describe("The document as read before the reset."),
  target: z.enum(["draft", "open"]),
  statusBefore: z.number().int().nullable(),
  statusAfter: z
    .number()
    .int()
    .nullable()
    .describe("Status sevdesk reported after the reset; null if it returned none."),
});

export const resetDocumentStatus = defineTool({
  name: "reset_document_status",
  title: "Reset the status of a sevdesk document",
  description:
    "Resets an invoice, credit note or voucher to draft (resetToDraft) or to open " +
    "(resetToOpen). Linked payments and bank transactions are unlinked; for vouchers, asset " +
    "depreciation is reset. Invoices and credit notes go to draft only from open (reset a " +
    "paid one to open first), vouchers from any later status; to open only from partially " +
    "paid or paid (vouchers also from transferred). Recurring invoices (WKR) cannot be reset. Enshrined documents are refused before " +
    "anything is sent. The first call returns a preview with number, status before and " +
    "after and the warnings, plus a confirmation_token; repeat the call with that token to " +
    "execute." +
    FOREIGN_DATA_NOTE,
  class: "W+",
  operations: [
    "getInvoiceById",
    "getcreditNoteById",
    "getVoucherById",
    "getContactById",
    "invoiceResetToDraft",
    "invoiceResetToOpen",
    "creditNoteResetToDraft",
    "creditNoteResetToOpen",
    "voucherResetToDraft",
    "voucherResetToOpen",
  ],
  inputSchema: z.object({
    documentType: z.enum(RESETTABLE).describe("invoice, credit_note or voucher."),
    documentId: documentIdInput,
    target: z.enum(["draft", "open"]).describe("draft (resetToDraft) or open (resetToOpen)."),
  }),
  annotations: STATUS_CHANGE_ANNOTATIONS,
  targetId: (args) => `${args.documentType}:${args.documentId}`,
  summary: (args) =>
    `Reset ${DOCUMENT_LABELS[args.documentType]} ${args.documentId} to ${args.target}; ` +
    "linked payments are unlinked.",
  async preview(args, call) {
    const { facts, problem } = await readForReset(call, args);
    if (problem) throw badInput(problem);
    const warnings = resetWarnings(args.documentType, facts);
    const after = TARGET_STATUS[args.documentType][args.target];
    return {
      approval:
        `Reset ${documentLine(facts)} from ${statusText(facts)} to ${args.target} (${after}). ` +
        `Warnings: ${warnings.join(" ")}`,
      ...facts,
      target: args.target,
      statusBefore: facts.statusName,
      statusAfter: args.target,
      warnings,
    };
  },
  async handler(args, call) {
    // Checked again: the document may have been enshrined, paid or reset
    // since the preview.
    const { facts, problem } = await readForReset(call, args);
    if (problem) {
      throw badInput(
        `${problem} It changed since the preview; call the tool again without ` +
          "confirmation_token for a new preview.",
      );
    }
    const { sevdesk } = call;
    const { api } = sevdesk;
    const id = args.documentId;
    const draft = args.target === "draft";
    const request =
      args.documentType === "invoice"
        ? draft
          ? api.PUT("/Invoice/{invoiceId}/resetToDraft", { params: { path: { invoiceId: id } } })
          : api.PUT("/Invoice/{invoiceId}/resetToOpen", { params: { path: { invoiceId: id } } })
        : args.documentType === "credit_note"
          ? draft
            ? api.PUT("/CreditNote/{creditNoteId}/resetToDraft", {
                params: { path: { creditNoteId: id } },
              })
            : api.PUT("/CreditNote/{creditNoteId}/resetToOpen", {
                params: { path: { creditNoteId: id } },
              })
          : draft
            ? api.PUT("/Voucher/{voucherId}/resetToDraft", { params: { path: { voucherId: id } } })
            : api.PUT("/Voucher/{voucherId}/resetToOpen", { params: { path: { voucherId: id } } });
    const body = await sevdesk.call(request as Promise<{ data: unknown; response: Response }>);
    const returned = objectsOf(body)[0];
    const statusAfter = returned ? integer(returned.status) : null;
    const output = shapedOutput(
      resetOutput,
      { document: facts, target: args.target, statusBefore: facts.status, statusAfter },
      call.logger,
      "reset_document_status",
    );
    return present(output, {
      summary:
        `Reset ${DOCUMENT_LABELS[args.documentType]} ${documentLabel(facts)} to ${args.target}; ` +
        `status ${facts.status ?? "unknown"} -> ${statusAfter ?? "not reported"}.`,
    });
  },
});

// ---------------------------------------------------------------------------
// tag_document

const tagOutput = z.object({
  document: documentFactsSchema,
  tag: z.object({ id: z.number().int().nullable(), name: z.string() }),
  relationId: z.number().int().nullable().describe("ID of the TagRelation sevdesk created."),
  tagExisted: z
    .boolean()
    .nullable()
    .describe("A tag with this exact name existed before; null if that could not be read."),
  warnings: z.array(z.string()),
});

/** Existing tags named like `name` (exact, other case), or null if they cannot be read. */
async function existingTags(
  { sevdesk }: ToolCall,
  name: string,
): Promise<{ exact: boolean; otherCase: string[] } | null> {
  try {
    const body = await sevdesk.call(sevdesk.api.GET("/Tag", { params: { query: { name } } }));
    const names = objectsOf(body)
      .map((tag) => (typeof tag.name === "string" ? tag.name : null))
      .filter((value): value is string => value !== null);
    return {
      exact: names.includes(name),
      otherCase: names.filter((n) => n !== name && n.toLowerCase() === name.toLowerCase()),
    };
  } catch (error) {
    if (error instanceof SevdeskError && error.kind !== "policy") return null;
    throw error;
  }
}

export const tagDocument = defineTool({
  name: "tag_document",
  title: "Tag a sevdesk document",
  description:
    "Sets a tag by name on an invoice, voucher, order or credit note (Tag/Factory/create); " +
    "sevdesk creates the tag if no tag of that name exists. The document is read first, so " +
    "an unknown ID is reported without writing anything. Tags can be removed in sevdesk." +
    FOREIGN_DATA_NOTE,
  class: "W",
  operationId: "createTag",
  operations: [
    "getInvoiceById",
    "getcreditNoteById",
    "getVoucherById",
    "getOrderById",
    "getContactById",
    "getTags",
  ],
  inputSchema: z.object({
    documentType: z
      .enum(["invoice", "voucher", "order", "credit_note"])
      .describe("invoice, voucher, order or credit_note."),
    documentId: documentIdInput,
    tagName: inputText(100)
      .refine((value) => !/[\r\n\t]/.test(value), { error: "must be a single line" })
      .describe("Tag name, e.g. 'Q1 geprueft'."),
  }),
  outputSchema: tagOutput,
  annotations: CREATE_ANNOTATIONS,
  targetId: (args) => `${args.documentType}:${args.documentId}`,
  async handler(args, call) {
    const facts = await readDocument(call, args.documentType, args.documentId);
    const known = await existingTags(call, args.tagName);
    const warnings: string[] = [];
    if (known === null) {
      warnings.push("sevdesk's tag list could not be read; it is unknown whether the tag existed.");
    } else if (!known.exact && known.otherCase.length > 0) {
      warnings.push(
        `A tag with different case exists (${known.otherCase.map((n) => `"${oneLineText(text(n), 100)}"`).join(", ")}); ` +
          "sevdesk may have created a second tag.",
      );
    }
    const { sevdesk } = call;
    const body = await sevdesk.call(
      sevdesk.api.POST("/Tag/Factory/create", {
        body: {
          name: args.tagName,
          object: ref(args.documentId, OBJECT_NAMES[args.documentType]),
        } as never,
      }),
    );
    // Wrapped in `objects` like every other answer, or bare as in the spec.
    const relation = objectsOf(body)[0] ?? asRecord(body);
    const output = {
      document: facts,
      tag: { id: integer(asRecord(relation.tag).id), name: args.tagName },
      relationId: integer(relation.id),
      tagExisted: known === null ? null : known.exact,
      warnings,
    };
    return present(output, {
      summary:
        `Tagged ${DOCUMENT_LABELS[args.documentType]} ${documentLabel(facts)} with ` +
        `"${oneLineText(args.tagName, 100)}"${output.tagExisted === false ? " (new tag)" : ""}.` +
        (warnings.length > 0 ? ` ${warnings.length} warning(s), see warnings.` : ""),
    });
  },
});

// ---------------------------------------------------------------------------
// enshrine_document

const ENSHRINABLE = ["invoice", "credit_note", "voucher"] as const;

/** Lowest status sevdesk enshrines from: open (invoices, credit notes) or unpaid (vouchers). */
const ENSHRINE_FROM: Readonly<Record<(typeof ENSHRINABLE)[number], number>> = {
  invoice: 200,
  credit_note: 200,
  voucher: 100,
};

const enshrineOutput = z.object({
  documentType: z.enum(ENSHRINABLE),
  documentId: z.number().int(),
  enshrined: z.literal(true),
});

export const enshrineDocument = defineTool({
  name: "enshrine_document",
  title: "Enshrine a sevdesk document",
  description:
    "Enshrines (festschreiben) an invoice, credit note or voucher: afterwards it can never " +
    "be changed, reset or deleted. This is legally irreversible (GoBD). Off unless the " +
    "operator lists it in SEVDESK_ENABLE_TOOLS. Only open or later documents can be " +
    "enshrined. The first call returns a preview (document type, number, contact, amount, " +
    "status) and a confirmation_token; the call with the token asks the user for approval " +
    "where the client supports it. Runs at most once per document within 24 hours." +
    FOREIGN_DATA_NOTE,
  class: "X",
  defaultEnabled: false,
  operations: [
    "getInvoiceById",
    "getcreditNoteById",
    "getVoucherById",
    "getContactById",
    "invoiceEnshrine",
    "creditNoteEnshrine",
    "voucherEnshrine",
  ],
  inputSchema: z.object({
    documentType: z.enum(ENSHRINABLE).describe("invoice, credit_note or voucher."),
    documentId: documentIdInput,
  }),
  annotations: IRREVERSIBLE_ANNOTATIONS,
  // The type is part of the target: invoice 5 and voucher 5 are different documents.
  targetId: (args) => `${args.documentType}:${args.documentId}`,
  summary: (args) =>
    `Enshrine ${DOCUMENT_LABELS[args.documentType]} ${args.documentId}; this is legally irreversible.`,
  async preview(args, call) {
    const facts = await readDocument(call, args.documentType, args.documentId);
    if (facts.enshrined) {
      throw badInput(
        `The ${DOCUMENT_LABELS[args.documentType]} ${args.documentId} is already enshrined. ` +
          "Nothing to do.",
      );
    }
    const warnings: string[] = [];
    const from = ENSHRINE_FROM[args.documentType];
    if (facts.status !== null && facts.status < from) {
      warnings.push(
        `The ${DOCUMENT_LABELS[args.documentType]} is ${statusText(facts)}; sevdesk only ` +
          `enshrines from status ${from}, so it will refuse.`,
      );
    }
    return {
      approval:
        `Enshrine ${documentLine(facts)}, status ${statusText(facts)}. Enshrining is legally ` +
        "irreversible: the document can never be changed, reset or deleted afterwards." +
        `${warnings.length > 0 ? ` Warnings: ${warnings.join(" ")}` : ""}`,
      ...facts,
      effect: "The document is enshrined and can never be changed, reset or deleted.",
      warnings,
    };
  },
  // No checks before the request: the once-per-document lock is already
  // taken here, and a local refusal would hold it for 24 hours although
  // nothing was sent. sevdesk's own 4xx releases it.
  async handler(args, { sevdesk, logger }) {
    const { api } = sevdesk;
    const id = args.documentId;
    const request =
      args.documentType === "invoice"
        ? api.PUT("/Invoice/{invoiceId}/enshrine", { params: { path: { invoiceId: id } } })
        : args.documentType === "credit_note"
          ? api.PUT("/CreditNote/{creditNoteId}/enshrine", {
              params: { path: { creditNoteId: id } },
            })
          : api.PUT("/Voucher/{voucherId}/enshrine", { params: { path: { voucherId: id } } });
    await sevdesk.call(request as Promise<{ data: unknown; response: Response }>);
    const output = shapedOutput(
      enshrineOutput,
      { documentType: args.documentType, documentId: id, enshrined: true },
      logger,
      "enshrine_document",
    );
    return present(output, {
      summary: `${capitalized(DOCUMENT_LABELS[args.documentType])} ${id} was enshrined.`,
    });
  },
});
