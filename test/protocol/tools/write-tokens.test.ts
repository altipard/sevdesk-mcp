import type { RequestHandler } from "msw";
import { describe, expect, it } from "vitest";
import { checkAccount, communicationWay, contact, invoice, list } from "../../fixtures/sevdesk.js";
import {
  HttpResponse,
  http,
  sevdeskError,
  sevdeskUrl,
  structured,
  textOf,
} from "../../support/harness.js";
import { connectWrites, mockSevdeskWrites, previewOf } from "../../support/write-harness.js";

const api = mockSevdeskWrites();

const reads: RequestHandler[] = [
  http.get(sevdeskUrl("/Invoice/1001"), () => HttpResponse.json(list([invoice()]))),
  http.get(sevdeskUrl("/Contact/2001"), () => HttpResponse.json(list([contact()]))),
  http.get(sevdeskUrl("/CheckAccount/9001"), () => HttpResponse.json(list([checkAccount()]))),
  http.get(sevdeskUrl("/CommunicationWay"), () => HttpResponse.json(list([communicationWay()]))),
];

const EMAIL = {
  invoiceId: 1001,
  toEmail: "buchhaltung@muster.example",
  subject: "Rechnung",
  text: "Anbei.",
  ccEmail: ["chef@muster.example"],
};
const BOOKING = {
  invoiceId: 1001,
  amount: 119,
  date: "2026-03-05",
  paymentType: "FULL_PAYMENT",
  checkAccountId: 9001,
};

/** Tool, the arguments the token was issued for, and one changed argument. */
const CHANGED: Array<[string, Record<string, unknown>, Record<string, unknown>]> = [
  ["mark_invoice_sent", { invoiceId: 1001, sendType: "VP" }, { invoiceId: 1002 }],
  ["mark_invoice_sent", { invoiceId: 1001, sendType: "VP" }, { sendType: "VM" }],
  ["book_invoice_payment", BOOKING, { amount: 1190 }],
  ["book_invoice_payment", BOOKING, { checkAccountId: 9002 }],
  ["book_invoice_payment", BOOKING, { invoiceId: 1002 }],
  ["book_invoice_payment", BOOKING, { paymentType: "N" }],
  ["book_invoice_payment", BOOKING, { date: "2026-01-01" }],
  ["send_invoice_email", EMAIL, { toEmail: "fremd@example.org" }],
  ["send_invoice_email", EMAIL, { ccEmail: ["fremd@example.org"] }],
  ["send_invoice_email", EMAIL, { bccEmail: ["fremd@example.org"] }],
  ["send_invoice_email", EMAIL, { invoiceId: 1002 }],
  ["send_invoice_email", EMAIL, { subject: "Mahnung" }],
  ["send_invoice_email", EMAIL, { text: "Anderer Text" }],
  ["cancel_invoice", { invoiceId: 1001 }, { invoiceId: 1002 }],
];

describe("a confirmation token only works for the arguments it was issued for", () => {
  it.each(CHANGED)(
    "%s refuses the token with %j changed and sends nothing",
    async (tool, args, change) => {
      api.server.use(...reads);
      const c = await connectWrites({
        config: { enableTools: ["send_invoice_email", "cancel_invoice"] },
      });
      const { token } = await previewOf(c, tool, args);
      const result = await c.call(tool, { ...args, ...change, confirmation_token: token });
      expect(result.isError).toBe(true);
      expect(textOf(result)).toContain("was issued for different arguments");
      expect(api.requests.filter((r) => r.method !== "GET")).toEqual([]);
      expect(c.audit().at(-1)).toMatchObject({
        tool,
        outcome: "denied",
        reason: "wrong_arguments",
      });
    },
  );
});

describe("cancel_invoice after a definite rejection", () => {
  it("frees the invoice again after a 4xx, so a corrected attempt can run", async () => {
    let attempts = 0;
    api.server.use(
      ...reads,
      http.post(sevdeskUrl("/Invoice/1001/cancelInvoice"), () => {
        attempts++;
        return attempts === 1
          ? sevdeskError(400, "invoice not cancellable")
          : HttpResponse.json(
              { objects: invoice({ id: "1201", invoiceNumber: "SR-1001", invoiceType: "SR" }) },
              { status: 201 },
            );
      }),
    );
    const c = await connectWrites({ config: { enableTools: ["cancel_invoice"] } });
    const first = await previewOf(c, "cancel_invoice", { invoiceId: 1001 });
    const rejected = await c.call("cancel_invoice", {
      invoiceId: 1001,
      confirmation_token: first.token,
    });
    expect(textOf(rejected)).toBe("sevdesk rejected the request (400): invoice not cancellable");
    const second = await previewOf(c, "cancel_invoice", { invoiceId: 1001 });
    const done = await c.call("cancel_invoice", {
      invoiceId: 1001,
      confirmation_token: second.token,
    });
    expect(structured(done)).toMatchObject({ cancellationInvoice: { invoiceNumber: "SR-1001" } });
    expect(attempts).toBe(2);
  });
});
