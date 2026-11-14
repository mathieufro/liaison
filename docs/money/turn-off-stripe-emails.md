---
title: Turn off Stripe's own customer emails
description: "Stop Stripe from emailing invoices, credit notes and receipts your customers already get from Liaison."
---

When Liaison issues the invoices of your card subscriptions, your customers would get two: Liaison's and Stripe's. Turn Stripe's off.

Liaison cannot read this setting from Stripe, so it never says it is off. It asks, until a person says they checked.

## Turn them off

1. In Stripe, open **Settings › Billing**.
2. Turn off the emails for finalized invoices, credit notes and payment receipts.
3. In Liaison, open **Settings › Invoicing › Issuer profiles**, find **Who issues what** and click **I checked, they are off**.

Until then the line reads: "Please check in Stripe, Settings, Billing: finalized invoices, credit notes and payment receipts should not email customers. Liaison cannot read this setting." Afterwards it reads "Checked by a person on <date>. Liaison cannot read this setting, so check again if someone changes it."

The click records who and when. An agent can record it too (`issuer_emails_confirm`).

Failed-payment and expiring-card emails from Stripe are your choice. You can leave them on, or use the [failed-payments routine](failed-payments-routine.md) instead.
