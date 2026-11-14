---
title: Connect Pennylane accounting
description: "Connect your Pennylane book so agents answer finance questions (supplier bills, P&L, cash, runway) and book received supplier bills after approval."
---

The Pennylane connector links your Pennylane accounting book to Liaison. Agents then answer finance questions from the live ledger: supplier bills, P&L, cash, spend and runway. Pennylane can also serve as the e-invoicing platform of the [Invoicing app](invoicing.md).

Pennylane is a connector: it has no screen of its own in Liaison. You connect it from **Settings › Connectors** and use it through agents.

## Create a Pennylane API token

The token is shown once and cannot be retrieved later. Copy it right away.

- **For a company:** open Pennylane account settings (needs an Executive or Accountant role) and generate a Company API token.
- **For a firm:** open **Firm settings → Firm Tokens → Generate an API Token**, name it, and choose its scopes and expiry.

Grant the token the scopes Liaison needs to read invoices, the trial balance and transactions. Without the bank scope, cash and runway answers come back as unavailable instead of a number.

## Connect Pennylane

1. Open **Settings › Connectors** and open the Pennylane card.
2. Click **Connect**.
3. Paste the token into **API token**.
4. Set **Scope (company|firm)** to `company` or `firm`, matching where you created the token. A mismatch makes the reads fail.
5. For a firm token, fill in **Company ID (firm tokens only)**.

The API token never reaches the app's code: Liaison adds it to each Pennylane request (and to the first hop of a received e-invoice download) itself. The scope and company id are plain settings the app reads, and the e-invoicing webhook signature is checked by Liaison with the stored secret.

Connecting needs `pennylane:admin:connection`. Connect the book for the whole organization so agents and routines can reach it. A personal connection returns `not_connected` to everyone else. See [Connect apps](../connecting-apps.md).

## Ask finance questions

Ask an agent with the right scopes, for example "What is our runway?" or "Which supplier bills are due this month?". Money comes back in minor units (cents) and the agent converts it.

P&L and runway are derived figures: gross margin is revenue minus cost of goods sold over the trial balance, classed by account-code prefix, and runway is cash divided by trailing net burn. Runway is empty when net burn is not positive.

## Book a supplier bill

An agent can book a received supplier bill (a PDF it can read, for example a mail attachment) into Pennylane's accounts payable with `supplier_invoice_upload`.

1. Ask the agent to book the bill, giving the supplier and the figures. Pennylane does no OCR, so the figures come from the request.
   Amounts are whole minor units (41260 for 412.60). Anything else is refused before the approval, and the refusal says what to send.
2. The call waits for approval. See [Approve what agents do](../agents/approvals.md).
3. Once approved, the bill is imported into Pennylane. The same file imported twice reuses the first import.

The supplier must match exactly one Pennylane supplier, or the call is refused and nothing is created. Do not use this for supplier e-invoices received through the e-invoicing network: they are already in Pennylane.

## Use Pennylane for e-invoicing

Pennylane implements Liaison's e-invoicing platform contract. Pick it as **E-invoicing platform** in **Settings › Invoicing › E-invoicing**, then ask an agent to run `webhooks_setup` so status changes and received supplier e-invoices reach Liaison. That call waits for approval.

Pennylane does not take collections (payments received) from Liaison: an invoice paid where VAT is due on receipt shows "To report at your platform", and a Home line asks you to enter the collection in Pennylane.

## Scopes

| Scope | What it allows |
| --- | --- |
| `pennylane:invoices:read` | Read supplier and customer invoices |
| `pennylane:invoices:write` | Book received supplier bills |
| `pennylane:reports:read` | Trial balance, P&L, spend by category, runway |
| `pennylane:cash:read` | Cash position and bank transactions |
| `pennylane:admin:connection` | Connect Pennylane and set up its webhooks |
| `pennylane:approve` | Decide Pennylane approvals |
| `pennylane:internal` | Used by the app itself |

## What agents can do

| Tool | What it does | Approval |
| --- | --- | --- |
| `supplier_invoices_list`, `supplier_invoice_get` | Supplier (accounts payable) invoices | No |
| `customer_invoices_list` | Customer invoices as booked in the ledger | No |
| `trial_balance_get` | Trial balance for a period | No |
| `pnl_summary` | Revenue, cost of goods sold, operating expenses and gross margin for a period | No |
| `cash_position` | Cash per account and total per currency | No |
| `transactions_list` | Bank transactions | No |
| `spend_by_category` | Spend per P&L class for a period | No |
| `runway_estimate` | Runway in whole months | No |
| `supplier_invoice_upload` | Book a received supplier bill into Pennylane | Always |
| `webhooks_setup` | Subscribe Pennylane's e-invoicing events | Always |

The `einvoicing_*` tools (`einvoicing_registration_status`, `einvoicing_find`, `einvoicing_submit`, `einvoicing_advance`, `einvoicing_status`, `einvoicing_status_changes`, `einvoicing_find_booking`, `einvoicing_book`, `einvoicing_received_list`, `einvoicing_received_get`, `einvoicing_received_file`, `einvoicing_received_set_status`) are called by the Invoicing app, not by agents.

Related: [Invoicing](invoicing.md), [Agent tools](../reference/agent-tools.md), [App settings](../reference/app-settings.md), [Scopes](../reference/scopes.md).
