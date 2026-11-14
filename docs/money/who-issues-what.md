---
title: Choose who issues your card invoices
description: "Decide whether Liaison or Stripe issues the invoice of each card subscription charge, so no sale is invoiced twice."
---

Each issuer profile sells in up to three streams. Open **Settings › Invoicing › Issuer profiles** and find **Who issues what**.

| Kind of sale | Who invoices |
|---|---|
| Subscriptions paid by card | You choose: Liaison or Stripe. Shown only while Stripe is connected |
| Recurring by transfer | Always Liaison: not billed from Stripe |
| One-off invoices | Always Liaison: not billed from Stripe |

If both invoiced the same sale, it would be invoiced twice.

## Decide for card subscriptions

Until a person decides, the card stream reads **Not decided yet** and nothing is issued for it. Choose one:

- **Liaison invoices, Stripe only takes the payment:** each charge gets a Liaison invoice, with a Liaison number.
- **Stripe invoices, Liaison only shows you a copy:** Stripe's invoice is the legal one. Liaison keeps a copy and takes no number.

A French company is offered Liaison as the default. Other companies are offered nothing.

A change asks you to confirm: "Starts with the next renewal, after you confirm. Invoices Liaison already issued stay as they are, with their numbers. Check the change with your accountant." It applies to Stripe invoices finalized after the confirmation. Earlier ones keep their issuer.

An agent that proposes a change (`issuer_stream_set`) does not change anything: its request waits for a person's approval.

## Standing e-invoice authorization

Each stream also shows whether it may send its e-invoices with no person at issue: off, who turned it on, when, and until when. It lasts 90 days. See [Invoicing](../apps/invoicing.md).

Next: [turn off Stripe's own emails](turn-off-stripe-emails.md).
