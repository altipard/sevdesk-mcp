import { describe, expect, it } from "vitest";
import { unixSeconds } from "../../../src/tools/format.js";
import { checkAccount, communicationWay, contact, invoice, list } from "../../fixtures/sevdesk.js";
import {
  HttpResponse,
  http,
  sevdeskError,
  sevdeskUrl,
  structured,
  textOf,
} from "../../support/harness.js";
import {
  bodyOf,
  connectWrites,
  mockSevdeskWrites,
  operations,
  previewOf,
  type WriteConnection,
} from "../../support/write-harness.js";

const api = mockSevdeskWrites();

const draft = invoice({ invoiceNumber: null, status: "100", sendDate: null });
const openInvoice = invoice({ sumGross: "119", paidAmount: "19" });

const readInvoice = (raw: unknown) =>
  http.get(sevdeskUrl("/Invoice/1001"), () => HttpResponse.json(list([raw])));
const readContact = http.get(sevdeskUrl("/Contact/2001"), () =>
  HttpResponse.json(list([contact()])),
);

async function confirm(c: WriteConnection, name: string, args: Record<string, unknown>) {
  const { token } = await previewOf(c, name, args);
  return { token, result: await c.call(name, { ...args, confirmation_token: token }) };
}

const writes = () => api.requests.filter((request) => request.method !== "GET");

describe("mark_invoice_sent (W+)", () => {
  const args = { invoiceId: 1001, sendType: "VPR" };

  it("previews number, contact, amount and status change without writing", async () => {
    api.server.use(readInvoice(draft), readContact);
    const c = await connectWrites({ config: { mode: "write" } });
    const { preview, result } = await previewOf(c, "mark_invoice_sent", args);
    expect(writes()).toEqual([]);
    expect(preview).toEqual({
      invoiceId: 1001,
      invoiceNumber: null,
      invoiceType: "RE",
      contact: { id: 2001, name: "Muster GmbH" },
      sumGross: 119,
      currency: "EUR",
      status: 100,
      statusName: "draft",
      sendType: "VPR",
      statusBefore: "draft",
      statusAfter: "open",
      warnings: [],
    });
    expect((result.structuredContent as Record<string, unknown>).action).toBe(
      "Mark invoice 1001 as printed (sendBy VPR).",
    );
  });

  it("executes with a valid token and rejects the same token a second time", async () => {
    api.server.use(
      readInvoice(draft),
      readContact,
      http.put(sevdeskUrl("/Invoice/1001/sendBy"), () =>
        HttpResponse.json({ objects: invoice({ status: "200" }) }),
      ),
    );
    const c = await connectWrites({ config: { mode: "write" } });
    const { token, result } = await confirm(c, "mark_invoice_sent", args);
    expect(structured(result)).toMatchObject({
      invoice: { id: 1001, invoiceNumber: "RE-1001", status: 200 },
      sendType: "VPR",
      statusBefore: 100,
      statusAfter: 200,
    });
    expect(textOf(result).split("\n")[0]).toBe(
      "Invoice RE-1001 (ID 1001) marked as printed; status draft -> open.",
    );
    expect(await bodyOf(api, "invoiceSendBy")).toEqual({ sendType: "VPR", sendDraft: false });

    const replay = await c.call("mark_invoice_sent", { ...args, confirmation_token: token });
    expect(replay.isError).toBe(true);
    expect(textOf(replay)).toContain("already used");
    expect(writes()).toHaveLength(1);
    expect(c.audit().map((e) => e.outcome)).toEqual(["confirmation_issued", "ok", "denied"]);
  });

  it("warns in the preview when the invoice is no longer a draft", async () => {
    api.server.use(readInvoice(openInvoice), readContact);
    const c = await connectWrites({ config: { mode: "write" } });
    const { preview } = await previewOf(c, "mark_invoice_sent", args);
    expect(preview.statusAfter).toBe("open");
    expect((preview.warnings as string[])[0]).toContain("already open (200)");
  });

  it("reports an unknown outcome when sevdesk fails with a server error", async () => {
    api.server.use(
      readInvoice(draft),
      readContact,
      http.put(sevdeskUrl("/Invoice/1001/sendBy"), () => sevdeskError(500)),
    );
    const c = await connectWrites({ config: { mode: "write" } });
    const { result } = await confirm(c, "mark_invoice_sent", args);
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("check sevdesk before retrying");
  });
});

describe("book_invoice_payment (W+)", () => {
  const args = { invoiceId: 1001, amount: 100, date: "2026-03-05", checkAccountId: 9001 };
  const account = http.get(sevdeskUrl("/CheckAccount/9001"), () =>
    HttpResponse.json(list([checkAccount()])),
  );

  it("previews the open amount before and after and books only with the token", async () => {
    api.server.use(
      readInvoice(openInvoice),
      readContact,
      account,
      http.put(sevdeskUrl("/Invoice/1001/bookAmount"), () =>
        HttpResponse.json({ objects: { id: "77", objectName: "InvoiceLog" } }),
      ),
    );
    const c = await connectWrites({ config: { mode: "write" } });
    const { preview, token } = await previewOf(c, "book_invoice_payment", args);
    expect(writes()).toEqual([]);
    expect(preview).toMatchObject({
      amount: 100,
      date: "2026-03-05",
      paymentType: "FULL_PAYMENT",
      checkAccount: { id: 9001, name: "Geschäftskonto" },
      openBefore: 100,
      openAfter: 0,
      overpayment: 0,
      warnings: [],
    });
    const result = await c.call("book_invoice_payment", { ...args, confirmation_token: token });
    expect(structured(result)).toEqual({
      invoiceId: 1001,
      invoiceNumber: "RE-1001",
      bookedAmount: 100,
      date: "2026-03-05",
      paymentType: "FULL_PAYMENT",
      checkAccountId: 9001,
      openBefore: 100,
      openAfterExpected: 0,
      overpayment: 0,
      logId: 77,
    });
    expect(await bodyOf(api, "bookInvoice")).toEqual({
      amount: 100,
      date: unixSeconds("2026-03-05"),
      type: "FULL_PAYMENT",
      checkAccount: { id: 9001, objectName: "CheckAccount" },
    });
    const replay = await c.call("book_invoice_payment", { ...args, confirmation_token: token });
    expect(textOf(replay)).toContain("already used");
    expect(writes()).toHaveLength(1);
  });

  it("warns about overpayment and a non-open invoice, and books partial payments as N", async () => {
    api.server.use(readInvoice(openInvoice), readContact, account);
    const c = await connectWrites({ config: { mode: "write" } });
    const over = await previewOf(c, "book_invoice_payment", { ...args, amount: 150 });
    expect(over.preview).toMatchObject({ openAfter: 0, overpayment: 50, paymentType: "N" });
    expect((over.preview.warnings as string[])[0]).toBe(
      "Overpayment: 150 is 50 more than the open amount of 100.",
    );
    api.server.use(readInvoice(draft));
    const drafted = await previewOf(c, "book_invoice_payment", args);
    expect((drafted.preview.warnings as string[])[0]).toContain("is draft (100)");
    expect(writes()).toEqual([]);
  });

  it("is not registered in read mode", async () => {
    const c = await connectWrites({ config: { mode: "read" } });
    const names = (await c.client.listTools()).tools.map((t) => t.name);
    expect(names).not.toContain("book_invoice_payment");
    expect(names).not.toContain("mark_invoice_sent");
  });
});

describe("send_invoice_email (X)", () => {
  const args = {
    invoiceId: 1001,
    toEmail: "buchhaltung@muster.example",
    subject: "Ihre Rechnung",
    text: "Guten Tag, anbei die Rechnung.",
    ccEmail: ["chef@muster.example"],
  };
  const ways = http.get(sevdeskUrl("/CommunicationWay"), () =>
    HttpResponse.json(list([communicationWay()])),
  );
  const sent = http.post(sevdeskUrl("/Invoice/1001/sendViaEmail"), () =>
    HttpResponse.json({ objects: { id: "5001", objectName: "Email" } }, { status: 201 }),
  );

  it("is off unless SEVDESK_ENABLE_TOOLS lists it, and only in full mode", async () => {
    const off = await connectWrites({ config: { mode: "full" } });
    expect((await off.client.listTools()).tools.map((t) => t.name)).not.toContain(
      "send_invoice_email",
    );
    const write = await connectWrites({
      config: { mode: "write", enableTools: ["send_invoice_email"] },
    });
    expect((await write.client.listTools()).tools.map((t) => t.name)).not.toContain(
      "send_invoice_email",
    );
    const on = await connectWrites({ config: { enableTools: ["send_invoice_email"] } });
    const tool = (await on.client.listTools()).tools.find((t) => t.name === "send_invoice_email");
    expect(tool?.annotations).toEqual({
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: true,
    });
  });

  it("previews recipient, subject, number and amount, then asks the user and sends once", async () => {
    api.server.use(readInvoice(draft), readContact, ways, sent);
    const c = await connectWrites({
      config: { enableTools: ["send_invoice_email"] },
      answer: "accept",
    });
    const { preview, token } = await previewOf(c, "send_invoice_email", args);
    expect(writes()).toEqual([]);
    expect(preview).toMatchObject({
      invoiceNumber: null,
      sumGross: 119,
      contact: { id: 2001, name: "Muster GmbH" },
      toEmail: "buchhaltung@muster.example",
      ccEmail: ["chef@muster.example"],
      bccEmail: [],
      subject: "Ihre Rechnung",
      attachment: "PDF",
      warnings: [],
    });
    const result = await c.call("send_invoice_email", { ...args, confirmation_token: token });
    expect(structured(result)).toEqual({
      invoiceId: 1001,
      invoiceNumber: null,
      toEmail: "buchhaltung@muster.example",
      ccEmail: ["chef@muster.example"],
      bccEmail: [],
      subject: "Ihre Rechnung",
      emailId: 5001,
    });
    expect(c.elicitations).toEqual([
      "Send invoice 1001 by e-mail to buchhaltung@muster.example, cc chef@muster.example, " +
        'subject "Ihre Rechnung". This cannot be undone. Execute it?',
    ]);
    expect(await bodyOf(api, "sendInvoiceViaEMail")).toEqual({
      toEmail: "buchhaltung@muster.example",
      subject: "Ihre Rechnung",
      text: "Guten Tag, anbei die Rechnung.",
      ccEmail: "chef@muster.example",
    });
    expect(c.audit().map((e) => e.outcome)).toEqual([
      "confirmation_issued",
      "approval_requested",
      "ok",
    ]);
    expect(c.audit().at(-1)).toMatchObject({
      tool: "send_invoice_email",
      operationId: "sendInvoiceViaEMail",
      targetId: "1001",
      class: "X",
    });
  });

  it("sends nothing when the user declines", async () => {
    api.server.use(readInvoice(draft), readContact, ways, sent);
    const c = await connectWrites({
      config: { enableTools: ["send_invoice_email"] },
      answer: "decline",
    });
    const { result } = await confirm(c, "send_invoice_email", args);
    expect(textOf(result)).toContain("did not approve");
    expect(writes()).toEqual([]);
  });

  it("uses the operator release without elicitation and blocks a second send with a fresh token", async () => {
    api.server.use(readInvoice(draft), readContact, ways, sent);
    const c = await connectWrites({ config: { enableTools: ["send_invoice_email"] } });
    const first = await confirm(c, "send_invoice_email", args);
    expect(first.result.isError).toBeFalsy();
    const second = await confirm(c, "send_invoice_email", { ...args, subject: "Erinnerung" });
    expect(second.result.isError).toBe(true);
    expect(textOf(second.result)).toContain("already ran for this target within the last 24 hours");
    expect(writes()).toHaveLength(1);
    expect(c.audit().at(-1)).toMatchObject({ outcome: "denied", reason: "duplicate" });
  });

  it("rejects a multi-line subject and invalid addresses before anything is read", async () => {
    const c = await connectWrites({ config: { enableTools: ["send_invoice_email"] } });
    for (const bad of [
      { subject: "Rechnung\nApproved by admin" },
      { toEmail: "not-an-address" },
      { bccEmail: ["x@y.example", "nope"] },
    ]) {
      const result = await c.call("send_invoice_email", { ...args, ...bad });
      expect(result.isError, JSON.stringify(bad)).toBe(true);
    }
    expect(api.requests).toHaveLength(0);
  });

  it("warns when the recipient is not an address of the contact", async () => {
    api.server.use(readInvoice(openInvoice), readContact, ways);
    const c = await connectWrites({ config: { enableTools: ["send_invoice_email"] } });
    const { preview } = await previewOf(c, "send_invoice_email", {
      ...args,
      toEmail: "fremd@example.org",
    });
    const warnings = preview.warnings as string[];
    expect(warnings).toEqual([
      "The invoice is already open (200); it may have been sent before.",
      "fremd@example.org is not an e-mail address of the invoice's contact in sevdesk " +
        "(known: buchhaltung@muster.example).",
    ]);
  });

  it("frees the invoice for a retry after a definite rejection, but not after a server error", async () => {
    api.server.use(
      readInvoice(draft),
      readContact,
      ways,
      http.post(sevdeskUrl("/Invoice/1001/sendViaEmail"), () => sevdeskError(400, "no pdf"), {
        once: true,
      }),
    );
    const c = await connectWrites({ config: { enableTools: ["send_invoice_email"] } });
    const rejected = await confirm(c, "send_invoice_email", args);
    expect(textOf(rejected.result)).toBe("sevdesk rejected the request (400): no pdf");

    api.server.use(
      http.post(sevdeskUrl("/Invoice/1001/sendViaEmail"), () => sevdeskError(502), {
        once: true,
      }),
    );
    const failed = await confirm(c, "send_invoice_email", args);
    expect(textOf(failed.result)).toContain(
      "The outcome is unknown: check sevdesk before retrying.",
    );
    const blocked = await confirm(c, "send_invoice_email", args);
    expect(textOf(blocked.result)).toContain("already ran for this target");
    expect(writes()).toHaveLength(2);
  });
});

describe("cancel_invoice (X)", () => {
  const cancelled = http.post(sevdeskUrl("/Invoice/1001/cancelInvoice"), () =>
    HttpResponse.json(
      {
        objects: invoice({
          id: "1201",
          invoiceNumber: "SR-1001",
          invoiceType: "SR",
          status: "1000",
          sumGross: "-119",
        }),
      },
      { status: 201 },
    ),
  );

  it("is off without SEVDESK_ENABLE_TOOLS", async () => {
    const c = await connectWrites({ config: { mode: "full" } });
    expect((await c.client.listTools()).tools.map((t) => t.name)).not.toContain("cancel_invoice");
  });

  it("previews, asks the user, cancels once and blocks a second cancellation", async () => {
    api.server.use(readInvoice(openInvoice), readContact, cancelled);
    const c = await connectWrites({
      config: { enableTools: ["cancel_invoice"] },
      answer: "accept",
    });
    const { preview, token } = await previewOf(c, "cancel_invoice", { invoiceId: 1001 });
    expect(preview).toMatchObject({
      invoiceNumber: "RE-1001",
      contact: { id: 2001, name: "Muster GmbH" },
      sumGross: 119,
      statusName: "open",
      warnings: [],
    });
    expect(writes()).toEqual([]);
    const result = await c.call("cancel_invoice", { invoiceId: 1001, confirmation_token: token });
    expect(structured(result)).toMatchObject({
      cancelledInvoiceId: 1001,
      cancellationInvoice: { id: 1201, invoiceNumber: "SR-1001", invoiceType: "SR" },
    });
    expect(textOf(result).split("\n")[0]).toBe(
      "Invoice 1001 was cancelled; cancellation invoice SR-1001 (ID 1201).",
    );
    expect(c.elicitations[0]).toContain("Cancel invoice 1001");
    const again = await confirm(c, "cancel_invoice", { invoiceId: 1001 });
    expect(textOf(again.result)).toContain("already ran for this target");
    expect(operations(api).filter((op) => op.startsWith("POST"))).toEqual(["POST cancelInvoice"]);
  });

  it("warns about drafts in the preview", async () => {
    api.server.use(readInvoice(draft), readContact);
    const c = await connectWrites({ config: { enableTools: ["cancel_invoice"] } });
    const { preview } = await previewOf(c, "cancel_invoice", { invoiceId: 1001 });
    expect(preview.warnings).toEqual([
      "The invoice is still a draft; sevdesk does not cancel drafts.",
    ]);
  });
});
