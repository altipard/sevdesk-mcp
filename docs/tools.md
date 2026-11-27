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
| `list_open_receivables` | Open and partially paid invoices with days overdue and aging bucket (not due, 0-30, 31-60, 61-90, over 90 days overdue), totals per currency and type, open amounts per aging bucket. Recurring-invoice templates (WKR) are left out by default; the answer can be marked incomplete after a timeout or failed page. |
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

## Audit and analysis tools

Read tools (class `R`, every mode) that look at all documents of a period instead of one
page, so questions like "check my month-end close" or "revenue in Q2" get a small answer.
They never change anything. Each call reads at most 2000 documents per list, stops after
45 seconds and sends at most 4 requests at a time; `audit_vat` also reads positions for at
most 130 vouchers and looks up at most 30 suppliers. These caps fit the default pace of
4 requests per second (`SEVDESK_RATE_LIMIT`): 45 s are about 180 requests. `audit_vat` reads
the positions of likely reverse charge cases first and keeps the last 10 seconds for the
supplier lookups. If a cap, the time limit, a failed request or a 429 from sevdesk stopped a
call early, the answer has `truncated: true` and a note naming the cause; `audit_vat` says
for how many vouchers it read positions and for how many suppliers the country, and how many
possible reverse charge cases stayed unchecked. After a 429 that the retries could not get
past, a call sends nothing more. Amounts are in euro: invoices and credit notes from their
sums (the foreign amount is reported separately), vouchers from `sumNet` etc., and
foreign-currency vouchers from their accounting sums (`sumNetAccounting` etc.). A
foreign-currency voucher whose accounting sums are missing or 0 falls back to `sumNet` etc.,
and the note says its euro amount is unconfirmed.

Where the sevdesk API documentation leaves semantics open, the tools take the cautious side
and say so in the answer: cancellation invoices (SR) and credit notes are subtracted whatever
sign sevdesk stores, and `summarize_documents` and `reverse_charge_report` add a note whenever
such documents are in the sums; a final invoice (ER) next to advance or partial invoices gets
a note that amounts may count twice; `audit_vat` skips tax amount checks for the
self-assessed rules 8, 12, 13 and 14. Credit notes are paged like the other lists (sevdesk
documents limit and offset for every list); should sevdesk repeat a page, the repeat is
dropped and the answer is marked truncated.

| Tool | What it does |
| --- | --- |
| `summarize_documents` | Count, net, tax and gross in euro of invoices (with credit notes, which are subtracted like cancellations) or vouchers (income and expenses always apart) in a period, per month, status or contact and in total. |
| `audit_vat` | Checks the vouchers of a period for likely VAT booking mistakes: foreign supplier with a domestic expense rule and only 0 % positions (possible reverse charge, with candidate rules to check), tax rule from the wrong side, rule not allowed for the booking account, rate contradicting the rule, sums that do not add up, one supplier with different rules. Findings are hints, not tax advice. |
| `reverse_charge_report` | The §13b tax base of a period from vouchers, invoices and credit notes: nets to zero (rules 12, 14), payable (rule 13) and own revenue (rule 5), with totals in euro and document counts. Documents count by their document date. |
| `find_duplicate_vouchers` | Vouchers with the same number and amount per supplier within 90 days (a description counts as number only with a digit other than a year), the same supplier and amount within a few days, and old drafts. |
| `find_subscription_gaps` | Detects suppliers billed monthly and lists the months of the period without a voucher. |
| `reconcile_transactions` | Matches open bank transactions with open vouchers and invoices by amount and date, with a confidence, and lists payments without document and documents without payment. |

`audit_vat` and `reverse_charge_report` need sevdesk bookkeeping 2.0 (tax rules); on
bookkeeping 1.0 accounts they refuse with an explanation, the other tools work on both.
The tax rule table they use is in `src/tools/tax-rules.ts`, taken from the "Tax Rules"
section of the sevdesk OpenAPI spec.

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
