---
title: Send payment reminders
description: "Remind customers about unpaid invoices from Stripe or from Invoicing, and know when a reminder stops by itself."
---

A payment reminder is a mail with a follow-up attached to one invoice. Liaison checks the invoice again just before the mail goes out.

## Card invoices on Stripe

The [failed-payments routine](failed-payments-routine.md) drafts these. You can also ask an agent to draft one. The draft carries a link to change the card (`card_update_link`).

Just before the send, Liaison reads the invoice from Stripe:

- **Paid, void or uncollectible:** the reminder is not sent.
- **Stripe cannot be reached:** the reminder waits and is checked again.

## Invoices issued by Liaison

Invoicing scans every day at 06:00 for issued invoices past their due date and raises one attention item per overdue invoice, as "Overdue: <number>: <n> days past due". A reminder about such an invoice is checked at send time against the document: it stops when the invoice is paid, credited or voided.

## Good to know

- A reminder is a service message, so it carries no unsubscribe footer.
- No reminder is sent by itself: a person approves each mail.
