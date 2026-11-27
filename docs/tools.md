# Tools

[Back to the README](../README.md)

Instead of exposing the whole sevdesk API, the server offers a small set of curated tools
with compact answers, plus a guarded fallback for everything else.

Each tool wraps one or a few sevdesk API calls and returns a short text plus compact
structured JSON. `get_document_pdf` and `get_report` return the file as an embedded
resource. Which tools are registered depends on the mode (see [Security](security.md)):
`read` offers only the read tools.

## Read tools

Available in every mode.

| Tool | What it does |
| --- | --- |
| `get_account_info` | Checks the connection, returns the bookkeeping system version and the server's mode. |
| `search_contacts` | Finds contacts by name, customer number or e-mail. Name and e-mail search scan at most 500 contacts or addresses, plus up to 100 organisations from sevdesk's own name filter, and say when they stopped early. |
| `get_contact` | One contact with master data, addresses and communication ways. |
| `search_invoices` | Lists invoices by status, date range, contact or invoice number, with open amounts. |
| `get_invoice` | One invoice with positions, amounts, dates and status. |
| `list_open_receivables` | Open and partially paid invoices with days overdue, totals per currency and type. Recurring-invoice templates (WKR) are left out by default; the answer can be marked incomplete after a timeout or failed page. |
| `get_document_pdf` | The rendered PDF of an invoice, credit note or order, without marking it as sent. |
| `search_orders` | Estimates, order confirmations and delivery notes by status, date, contact or number. |
| `search_vouchers` | Vouchers (incoming invoices, receipts) by status, date, text, debit/credit or supplier. |
| `get_voucher` | One voucher with positions, booking accounts and tax rates. |
| `list_bank_accounts` | Payment accounts (bank, cash, clearing) with balance and IBAN. |
| `search_transactions` | Bank transactions by account, date, reference, payer/payee, booked or open, direction. |
| `search_parts` | Parts (products and services) with prices, tax rate and stock. |
| `get_tax_guidance` | Which booking accounts, tax rules and tax rates sevdesk allows together. |
| `get_report` | sevdesk's rendered list report (usually a PDF) of invoices, orders, contacts or vouchers. |
| `sevdesk_api_request` | Guarded fallback: calls one sevdesk operation without a dedicated tool by `operationId`. |

## Write tools

Class `W` runs directly from `SEVDESK_MODE=write` on. Class `W+` also needs `write` and
runs in two steps with a confirmation token. Class `X` needs `full`, is off until the
operator lists it in `SEVDESK_ENABLE_TOOLS`, and needs a confirmation token plus approval
by a human (elicitation) or, on clients without elicitation, the operator release that this
listing stands for. There is no delete tool. The classes are explained in
[Security](security.md).

| Tool | Class | What it does |
| --- | --- | --- |
| `create_contact` | W | Creates an organisation or person, by default as customer with the next free customer number, optionally with invoice address, e-mail and phone. |
| `update_contact` | W | Changes master data of a contact and, where unambiguous, its address, e-mail or phone; with several entries it fails and lists their IDs. |
| `create_invoice_draft` | W | Creates an invoice draft (RE) with free-text or article positions; tax rule and rates are checked first. No invoice number, not sent. |
| `create_order_draft` | W | Creates an estimate (AN) or order confirmation (AB) as draft, with the same checks. Not sent. |
| `create_invoice_from_order` | W | Turns an estimate or order confirmation into an invoice draft: whole (RE), partial (TR) or advance (AR). |
| `create_voucher` | W | Creates a voucher (Beleg) as draft, optionally with the receipt file attached; accounts, tax rule and rates are checked first. |
| `tag_document` | W | Sets a tag by name on an invoice, voucher, order or credit note; sevdesk creates the tag if it does not exist. |
| `mark_invoice_sent` | W+ | Marks an invoice as sent (printed, by post, by e-mail outside sevdesk, downloaded) without sending anything; a draft gets its invoice number. |
| `book_invoice_payment` | W+ | Books a payment on an open or partially paid invoice to a payment account, with an explicit payment type (full, partial, Skonto, bank charges, other, reminder fees). |
| `book_voucher_payment` | W+ | Books a payment on an unpaid or partially paid voucher, with the same payment types. |
| `reset_document_status` | W+ | Resets an invoice, credit note or voucher to draft or to open; linked payments are unlinked. Enshrined documents are refused. |
| `send_invoice_email` | X | Sends an invoice to the customer by e-mail through sevdesk, with explicit recipient, subject and text. |
| `cancel_invoice` | X | Cancels an invoice by creating a numbered cancellation invoice (Stornorechnung). |
| `enshrine_document` | X | Enshrines (festschreiben) an invoice, credit note or voucher; afterwards it can never be changed, reset or deleted (GoBD). |

`create_voucher` attaches a receipt as PDF, PNG or JPEG up to 10 MiB, passed as base64.
The draft tools create a new object on every call, and the payment tools book again on
every confirmed call.

> [!CAUTION]
> **Try write tools on test data first.** They are tested against the sevdesk OpenAPI spec
> and a mocked API, but the spec is incomplete and some request shapes can only be
> verified against a live account. Start with a test contact and a test draft, check the
> result in sevdesk, and only then use them on real bookkeeping data.

## The fallback: `sevdesk_api_request`

`sevdesk_api_request` only accepts operations on its allowlist. By default that is a
curated list of side-effect-free reads; `SEVDESK_API_ALLOW` replaces it. Every listed
operation still has to fit the mode and goes through the same confirmation rules as the
tools.

> [!NOTE]
> Everything a tool reads (customer names, IBANs, amounts, PDFs) goes to your MCP client
> and from there to the client's model provider.
