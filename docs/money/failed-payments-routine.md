---
title: Turn on the failed-payments routine
description: "Have an agent draft a payment reminder each morning for card payments Stripe no longer retries."
---

The **failed-payments** routine drafts a reminder for each card payment that failed and that Stripe will not retry. It is off until you turn it on, and it never sends anything: each draft waits for a person.

## Turn it on

1. Find **failed-payments** among the routines and turn it on.
2. It runs every morning at 07:00 UTC.

## What it does

For each failed Stripe payment that Stripe no longer retries and that has no reminder waiting, it drafts a mail linked to the Stripe invoice. The draft:

- carries the link from `card_update_link`, and says what that link does;
- mentions the customer's open tickets;
- skips payments Stripe still retries. Those are one quiet line on Stripe Home, "Nothing to do yet".

The routine can read customers, invoices and payments in Stripe, read tickets, and write mail conversations. It cannot refund, cancel or change anything in Stripe.

## Before a reminder is sent

A person approves the mail. Just before it goes out, Liaison reads the invoice from Stripe. A paid, void or uncollectible invoice stops the reminder, and an unreachable Stripe makes it wait. See [Payment reminders](payment-reminders.md).
