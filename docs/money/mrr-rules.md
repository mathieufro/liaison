---
title: Understand the MRR figure
description: "The rules behind Liaison's monthly recurring revenue, and what to check when it differs from Stripe's own report."
---

Stripe Home and `mrr_query` show monthly recurring revenue per currency. Nothing is converted between currencies. **How MRR is computed** on Home shows the same rules.

## What counts

- Subscriptions that are `active` or `past_due`.
- Not counted: `trialing`, `canceled`, `unpaid`, `incomplete`, `paused`, free, metered and one-off prices.

## How each subscription is valued

- Price times quantity, in one month: a year is divided by 12, a quarter by 3, a week is multiplied by 52/12 and a day by 365/12.
- A price that includes tax is reduced to its net by its rate.
- Discounts that recur come off, percentages first, then amounts. A discount that applies once, or has ended, does not.
- Rounding: once per subscription, to the nearest minor unit, halves up. A currency's figure is the sum of those whole amounts.

## Past due and movements

- **Past due** is shown beside the figure. "Without it" is the figure less that amount.
- Each change of a subscription's counted amount is kept once as new, upgrade, downgrade or cancelled. A trial that converts is new on the day it converts. A cancellation set for the end of a period counts until that day.
- The month starts at midnight on the 1st in your organization's time zone.

## When there is no figure

During the first import, or when the key cannot read subscriptions, `mrr_query` answers "partial" and gives no figure.

## If your figure differs from Stripe's report

Compare what each one counts before you doubt either:

- Trials, paused and unpaid subscriptions.
- Currencies: Liaison never converts.
- Tax-inclusive prices, recurring and one-time discounts.
- Rounding: once per subscription here.
- Lost events: the nightly reconcile reads the last 30 days of Stripe events. An older change that no event explains corrects the figure, but its movement is dated the day it was found, and the answer says "Movements incomplete before <date>".
