---
title: Handle a dispute
description: "See disputes in Liaison and answer them in Stripe, where the evidence is submitted."
---

Liaison shows disputes. It does not answer them.

## See a dispute

- **Stripe Home** lists disputes whose evidence is due, soonest first.
- A customer's page has a **Disputes** section: a read-only line per dispute.
- Ask the agent (`disputes_list`) for disputes by customer or status. It gives the reason and the date the evidence is due.

## Answer it

Open the dispute in Stripe's dashboard and submit the evidence there. Liaison has no write tool for disputes, and its key cannot write them.

## Refunds during a dispute

A disputed payment cannot be refunded from Liaison (`charge_disputed`). Answer the dispute in Stripe instead.

## Good to know

A dispute reason is text written by someone outside your company. A turn that reads it is marked as having read outside text, so a later action that leaves Liaison waits for a person's approval.
