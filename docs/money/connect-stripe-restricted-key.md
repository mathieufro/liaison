---
title: Connect Stripe with a restricted key
description: "Create a restricted key with the nine read permissions and Refunds write, and check it."
---

Liaison never asks for your secret key. It uses a restricted key. The steps and the permission table are on [Connect Stripe](../apps/stripe.md#create-a-restricted-key). In short:

1. In the Stripe Dashboard, open **Developers › API keys › Create restricted key**.
2. Give **Read** to Customers, Subscriptions, Invoices, Charges, Disputes, Payment methods, Products, Prices and Events, and **Write** to Refunds. Leave every other permission at None.
3. Paste the key into **Restricted key** in Liaison.
4. Ask the agent to check the key (`connection_check`).

A secret key (`sk_`) is refused before anything is stored. The key is stored encrypted, and only `api.stripe.com` is called.

## Optional: let the agent cancel subscriptions

The default key cannot cancel a subscription. To allow it, give the key **Write** on **Subscriptions**, then run the check again. A cancellation still waits for a person's approval.

## The link to change a card

`card_update_link` gives the customer portal's login link when one is saved in the app's configuration (it must be a `https://billing.stripe.com/p/login/` link). Otherwise it gives the Stripe page of the customer's open invoice, which pays that invoice with a new card but may not change the card for later renewals. With neither, it says why there is no link.
