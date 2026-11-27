# sevdesk accounting reference

## Status codes

| Document | Codes |
| --- | --- |
| Invoice | 50 deactivated recurring, 100 draft, 200 open, 750 partially paid, 1000 paid |
| Credit note | 100 draft, 200 open, 750 partially paid, 1000 paid |
| Order (estimate, confirmation) | 100 draft, 200 delivered, 300 rejected, 500 accepted, 750 partially calculated, 1000 calculated |
| Voucher | 50 draft, 100 unpaid, 150 transferred, 750 partially paid, 1000 paid |
| Bank transaction | 100 created, 200 linked, 300 private, 350 auto booked, 400 booked |
| Contact | 100 lead, 500 pending, 1000 active |

Invoice types: RE invoice, SR cancellation, MA reminder, TR partial, AR advance, ER final
invoice (Schlussrechnung), WKR recurring template. Order types: AN estimate, AB order confirmation, LI delivery note.

Status changes the tools can make:

- Invoice draft to open: `mark_invoice_sent` or `send_invoice_email`.
- Open to partially paid or paid: `book_invoice_payment`, `book_voucher_payment`.
- Back: `reset_document_status`. Invoices and credit notes go to draft only from open (a
  paid one first to open), to open only from partially paid or paid. Vouchers go to draft
  from any later status, to open from transferred, partially paid or paid.
- Voucher draft to unpaid: only in sevdesk itself.

## Tax rules (bookkeeping 2.0)

Invoices and income vouchers (C):

| Rule | Meaning | Rates |
| --- | --- | --- |
| 1 | Taxable sales (Umsatzsteuerpflichtige Umsätze) | 0, 7, 19 % |
| 2 | Exports (Ausfuhren) | 0 % |
| 3 | Intra-EU deliveries (Innergemeinschaftliche Lieferungen) | 0, 7, 19 % |
| 4 | Tax-free sales §4 UStG | 0 % |
| 5 | Reverse charge §13b UStG | 0 % |
| 11 | Kleinunternehmer §19 UStG, no VAT charged | 0 % |
| 17 | Not taxable in Germany | 0 % |
| 18, 19, 20 | One Stop Shop (goods, electronic services, other services); invoices only | per country |
| 21 | Reverse charge §18b UStG; invoices only | 0 % |

Expense vouchers (D):

| Rule | Meaning | Rates |
| --- | --- | --- |
| 8 | Intra-EU acquisitions | 0, 7, 19 % |
| 9 | Input tax deductible (Vorsteuerabziehbare Aufwendungen) | 0, 7, 19 % |
| 10 | Not deductible | 0 % |
| 12 | Reverse charge §13b (2) with input tax deduction | 0 % |
| 13 | Reverse charge §13b without input tax deduction | 0 % |
| 14 | Reverse charge §13b (1) EU | 0 % |

The server checks rule and rates against this table and against the account's own tax
guidance before anything is sent. An account set up as Kleinunternehmer only allows rule
11 for revenue: do not suggest 19 % VAT there. If the guidance could not be read, the answer
warns that only the documented table was checked; mention that to the user.

Default tax text on documents: "Umsatzsteuer" for rule 1, otherwise the rule's German name
(for rule 11 "Steuer nicht erhoben nach §19 UStG (Kleinunternehmer)").

## Reverse charge (§13b UStG)

With reverse charge the recipient, not the supplier, owes the VAT. Typical cases: software
subscriptions and other services from businesses abroad, construction services. The
supplier's invoice shows no German VAT, so a voucher with 0 % positions from a foreign
supplier booked with rule 9 is often a reverse charge case booked as a normal expense.

`reverse_charge_report` splits the 13b tax base (net amounts) into:

- nets_to_zero: rules 12 and 14. You owe the tax and deduct it as input tax in the same
  return, so it usually nets to zero, but it must appear in the VAT return.
- payable: rule 13. You owe the tax without input tax deduction; it is a real cost.
- revenue: rule 5. Your own sales where your customer owes the tax.

Cancellation invoices (SR) and credit notes with rule 5 reduce own revenue. The API
documentation does not say whether sevdesk stores them negative, so the tools subtract their
amount either way. A final invoice (ER) next to advance or partial invoices (AR, TR) may
repeat their amounts; the answer then says so instead of guessing. Documents count by their
document date, an approximation of the tax period.

The spec lists rules 12 to 14 as "0% (19%)" without saying whether sevdesk shows the
self-assessed tax in the voucher's tax sum, so `audit_vat` skips tax amount checks for rules
8, 12, 13 and 14 and compares only net sums.

Intra-EU acquisitions of goods (rule 8) are taxed under §1a UStG, not §13b, and are not in
the report. Whether a case is reverse charge, and with or without input tax deduction, is a
decision for the user and their Steuerberater; the tools only point to likely cases.

## Payment types for bookings

| Type | When |
| --- | --- |
| FULL_PAYMENT | Amount equals the open amount |
| N | Partial payment; the rest stays open |
| CB | Less because of a cash discount (Skonto); settles the document |
| MTC | Less because of bank charges; settles the document |
| O | Less or more for another reason; settles the document |
| OF | More because of reminder fees |

Overpayments are only accepted as O or OF. The preview warns when the type does not fit
the amount; show that warning and let the user choose.

## Pitfalls documented in the server

- Every create call makes a new object; there is no deduplication. Check before retrying.
- `create_contact` writes address, e-mail and phone as separate objects; a partial failure
  leaves the contact in place. Complete it with `update_contact`.
- `create_invoice_draft` refuses a delivery date after the invoice date (only advance
  invoices allow that). Invoice and order dates default to today, German time.
- The recipient address of a document comes from the contact (invoice address, else the
  first address). Fix the contact first if it is wrong.
- `create_voucher` only creates drafts; payments need the voucher completed in sevdesk.
- Online bank accounts need the bank transaction ID when booking a payment.
- `reset_document_status` unlinks payments and bank transactions and resets voucher
  depreciation; sevdesk refuses it when a linked transaction is enshrined.
- `cancel_invoice` warns that sevdesk does not cancel drafts or existing cancellation
  invoices.
- `send_invoice_email` and `cancel_invoice` run at most once per invoice within 24 hours,
  `enshrine_document` once per document, and a refused repeat is intentional. With the
  plugin (stdio) this record is kept in memory only: a server restart clears it, so check
  sevdesk before any repeat. An unknown outcome still means: check in sevdesk, do not retry.
- Fetching a PDF never marks a document as sent.
- `list_open_receivables` counts neither reminders nor cancellations, so totals are not
  doubled; recurring templates appear through their generated invoices.
- Searches by name may miss spelling and umlaut variants; try again with a shorter name.
- Confirmation tokens are bound to the exact arguments and the user, expire after 5
  minutes by default and work once. If the server restarted, request a new preview.
