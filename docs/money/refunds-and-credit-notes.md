---
title: Refund a payment and issue its credit note
description: "Request a refund, approve it, and see the credit note that follows."
---

A refund always waits for a person's approval. Nothing reaches Stripe before someone approves it.

## Request a refund

On a customer's page, click **Refund** next to the payment, or ask the agent (`refunds_create`). Give the payment's id (`ch_...`) and, for a partial refund, the amount.

Before any approval waits, Liaison reads the payment from Stripe and refuses, with nothing to approve, when the payment is already refunded in full (`already_refunded`), is disputed (`charge_disputed`), or the amount is above what is left (`amount_over_refundable`).

If Liaison issues your card subscriptions' invoices, it also refuses when no Liaison invoice is behind the payment (`no_invoice_for_refund`): say which invoice the credit note goes against. If it cannot read who issues them, it says `issuer_unknown`: try again in a minute. A reason that holds a card number is refused (`card_number_refused`).

## After approval

- Liaison reads the payment again and refuses an amount above what is left now.
- If Stripe's answer is lost, the request is marked as unknown and nothing is sent again by itself. Approving it again first looks for the refund in Stripe.
- With a ticket, the refund adds an internal note. It never replies to the customer.

## The credit note

When Liaison issues the card invoices, a credit note follows each refund once Stripe says it succeeded. Two partial refunds make two credit notes that add up to what was refunded. A pending refund waits. A refund that fails or is canceled makes none.

When Stripe issues the invoices, or nobody has decided yet, no Liaison credit note follows.

A refund made in Stripe's dashboard gets its credit note too, from the Invoicing safety job that looks at refunds of the last 35 days.
