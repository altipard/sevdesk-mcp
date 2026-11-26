import type { RequestHandler } from "msw";
import { describe, expect, it } from "vitest";
import {
  address,
  checkAccount,
  communicationWay,
  contact,
  invoice,
  list,
  order,
  receiptGuide,
} from "../../fixtures/sevdesk.js";
import {
  HttpResponse,
  http,
  sevdeskError,
  sevdeskUrl,
  structured,
  textOf,
} from "../../support/harness.js";
import { READ_TOOLS } from "../../support/tool-names.js";
import { connectWrites, mockSevdeskWrites, previewOf } from "../../support/write-harness.js";

const api = mockSevdeskWrites();

const WRITE_TOOLS = [
  "create_contact",
  "update_contact",
  "create_invoice_draft",
  "create_order_draft",
  "create_invoice_from_order",
  "mark_invoice_sent",
  "book_invoice_payment",
  "send_invoice_email",
  "cancel_invoice",
];
const X_TOOLS = ["send_invoice_email", "cancel_invoice"];

const reads: RequestHandler[] = [
  http.get(sevdeskUrl("/Contact/2001"), () =>
    HttpResponse.json(list([{ ...contact(), addresses: [address()] }])),
  ),
  http.get(sevdeskUrl("/ReceiptGuidance/forRevenue"), () =>
    HttpResponse.json({ objects: [receiptGuide()] }),
  ),
  http.get(sevdeskUrl("/Invoice"), () => HttpResponse.json(list([invoice()]))),
  http.get(sevdeskUrl("/Order"), () => HttpResponse.json(list([order()]))),
  http.get(sevdeskUrl("/Order/7001"), () => HttpResponse.json(list([order()]))),
  http.get(sevdeskUrl("/Invoice/1001"), () => HttpResponse.json(list([invoice()]))),
  http.get(sevdeskUrl("/CheckAccount/9001"), () => HttpResponse.json(list([checkAccount()]))),
  http.get(sevdeskUrl("/CommunicationWay"), () => HttpResponse.json(list([communicationWay()]))),
];

const position = [{ name: "X", quantity: 1, priceNet: 10, taxRate: 19 }];

/** Each tool with the write that fails and arguments that reach it. */
const CASES: Array<{
  tool: string;
  confirmed: boolean;
  failing: RequestHandler;
  args: Record<string, unknown>;
}> = [
  {
    tool: "create_contact",
    confirmed: false,
    failing: http.post(sevdeskUrl("/Contact"), () => sevdeskError(500)),
    args: { organisation: "X GmbH", customerNumber: "1" },
  },
  {
    tool: "update_contact",
    confirmed: false,
    failing: http.put(sevdeskUrl("/Contact/2001"), () => sevdeskError(500)),
    args: { contactId: 2001, vatNumber: "DE1" },
  },
  {
    tool: "create_invoice_draft",
    confirmed: false,
    failing: http.post(sevdeskUrl("/Invoice/Factory/saveInvoice"), () => sevdeskError(500)),
    args: { contactId: 2001, positions: position },
  },
  {
    tool: "create_order_draft",
    confirmed: false,
    failing: http.post(sevdeskUrl("/Order/Factory/saveOrder"), () => sevdeskError(500)),
    args: { contactId: 2001, positions: position },
  },
  {
    tool: "create_invoice_from_order",
    confirmed: false,
    failing: http.post(sevdeskUrl("/Invoice/Factory/createInvoiceFromOrder"), () =>
      sevdeskError(500),
    ),
    args: { orderId: 7001 },
  },
  {
    tool: "mark_invoice_sent",
    confirmed: true,
    failing: http.put(sevdeskUrl("/Invoice/1001/sendBy"), () => sevdeskError(500)),
    args: { invoiceId: 1001, sendType: "VP" },
  },
  {
    tool: "book_invoice_payment",
    confirmed: true,
    failing: http.put(sevdeskUrl("/Invoice/1001/bookAmount"), () => sevdeskError(500)),
    args: { invoiceId: 1001, amount: 50, paymentType: "N", checkAccountId: 9001 },
  },
  {
    tool: "send_invoice_email",
    confirmed: true,
    failing: http.post(sevdeskUrl("/Invoice/1001/sendViaEmail"), () => sevdeskError(500)),
    args: { invoiceId: 1001, toEmail: "buchhaltung@muster.example", subject: "S", text: "T" },
  },
  {
    tool: "cancel_invoice",
    confirmed: true,
    failing: http.post(sevdeskUrl("/Invoice/1001/cancelInvoice"), () => sevdeskError(500)),
    args: { invoiceId: 1001 },
  },
];

describe("sevdesk server errors on writes", () => {
  it.each(CASES)(
    "$tool reports that the outcome is unknown",
    async ({ tool, confirmed, failing, args }) => {
      api.server.use(failing, ...reads);
      const c = await connectWrites({ config: { enableTools: X_TOOLS } });
      let result: Awaited<ReturnType<typeof c.call>>;
      if (confirmed) {
        const { token } = await previewOf(c, tool, args);
        result = await c.call(tool, { ...args, confirmation_token: token });
      } else {
        result = await c.call(tool, args);
      }
      expect(result.isError).toBe(true);
      expect(textOf(result)).toContain("sevdesk server error (500)");
      expect(textOf(result)).toContain("The outcome is unknown: check sevdesk before retrying.");
      expect(c.audit().at(-1)).toMatchObject({ tool, outcome: "error", status: 500 });
    },
  );
});

describe("write tools and modes", () => {
  it("registers none of them in read mode, even when SEVDESK_ENABLE_TOOLS lists them", async () => {
    const c = await connectWrites({ config: { mode: "read", enableTools: WRITE_TOOLS } });
    const names = (await c.client.listTools()).tools.map((t) => t.name);
    expect(names).toEqual([...READ_TOOLS, "sevdesk_api_request"]);
  });

  it("registers W and W+ in write mode and X only in full mode with SEVDESK_ENABLE_TOOLS", async () => {
    const write = await connectWrites({ config: { mode: "write", enableTools: X_TOOLS } });
    const writeNames = (await write.client.listTools()).tools.map((t) => t.name);
    expect(WRITE_TOOLS.filter((name) => writeNames.includes(name))).toEqual(
      WRITE_TOOLS.filter((name) => !X_TOOLS.includes(name)),
    );
    const full = await connectWrites({ config: { mode: "full", enableTools: X_TOOLS } });
    const fullNames = (await full.client.listTools()).tools.map((t) => t.name);
    expect(WRITE_TOOLS.filter((name) => fullNames.includes(name))).toEqual(WRITE_TOOLS);
  });
});

describe("send_invoice_email after the approval", () => {
  it("still sends when reading the invoice number fails, so the invoice is not blocked unsent", async () => {
    // The preview reads once; every read after it fails, retries included.
    let invoiceReads = 0;
    api.server.use(
      http.get(sevdeskUrl("/Invoice/1001"), () => {
        invoiceReads++;
        return invoiceReads >= 2 ? sevdeskError(503) : HttpResponse.json(list([invoice()]));
      }),
      ...reads,
      http.post(sevdeskUrl("/Invoice/1001/sendViaEmail"), () =>
        HttpResponse.json({ objects: { id: "5002" } }, { status: 201 }),
      ),
    );
    const c = await connectWrites({ config: { enableTools: ["send_invoice_email"] } });
    const args = {
      invoiceId: 1001,
      toEmail: "buchhaltung@muster.example",
      subject: "Rechnung",
      text: "Anbei.",
    };
    const { token } = await previewOf(c, "send_invoice_email", args);
    const result = await c.call("send_invoice_email", { ...args, confirmation_token: token });
    expect(structured(result)).toMatchObject({ invoiceNumber: null, emailId: 5002 });
    expect(textOf(result).split("\n")[0]).toBe(
      "Invoice 1001 was sent by e-mail to buchhaltung@muster.example.",
    );
    expect(api.requests.filter((r) => r.method === "POST")).toHaveLength(1);
  });
});
