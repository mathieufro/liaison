---
title: Connect Stripe
description: "Connect your Stripe account with a restricted key so Liaison keeps a read mirror of customers, subscriptions, invoices and payments."
---

The Stripe connector links your Stripe account to Liaison. Liaison keeps a read mirror of your customers, subscriptions, invoices, payments, refunds and disputes, so people and agents read money facts from it.

Stripe is an app with its own page: **Stripe** in the activity bar opens **Home**, and **Customers** and a link to the Stripe dashboard sit in its sidebar. Its connection settings are on **Settings › Apps › Stripe**.

This page grows as the app does. Today it stores its connection, checks its key, keeps its mirror current from Stripe's webhook events, and shows the Stripe Home.

## The Stripe Home

Home reads Liaison's mirror, never Stripe, so it says when it last heard from Stripe.

- **Needs attention** lists what a person has to look at: payments that failed with no retry left (longest overdue first), refund and cancel requests waiting for you, and disputes whose evidence is due. **Review** opens the waiting request with its Approve and Deny. Cards Stripe is still retrying are one quiet line ("Nothing to do yet"), not a row.
- **Trials ending** lists trials ending within 7 days, with whether a card is on file.
- **Monthly recurring revenue** shows one block per currency, never converted: the amount, the change since the first of the month, the paying subscriptions by plan, and the movements. **How MRR is computed** shows the rule the figure is computed by.
- **While the first import runs** Home shows the progress per kind of record and no MRR. If the key is revoked, the account is not the one Liaison holds, Stripe stops sending updates or the key lacks a permission, Home says what happened, what to do next and keeps the last figures marked "as of" their time. Waiting approvals stay open but their Approve is held until the key works.
- On a phone, Home is one column and every control is at least 44 px tall.

## Create a restricted key

Liaison never asks for your secret key. It uses a restricted key with exactly these permissions:

| Permission | Level |
|---|---|
| Customers | Read |
| Subscriptions | Read |
| Invoices | Read |
| Charges | Read |
| Disputes | Read |
| Payment methods | Read |
| Products | Read |
| Prices | Read |
| Events | Read |
| Refunds | Write |

Leave every other permission at None.

1. In the Stripe Dashboard, open **Developers → API keys → Create restricted key**.
2. Set the permissions in the table above, and create the key. It starts with `rk_live_` (live mode) or `rk_test_` (test mode).
3. In Liaison, open **Settings › Apps › Stripe** (or **Connect Stripe** on Stripe's Home while it is not connected) and paste it into **Restricted key**, or ask the agent, which posts the same form in the conversation. The key is stored encrypted, and the connector's code never sees it: the server adds it to each request.

A secret key (`sk_live_` or `sk_test_`) is refused before anything is stored: the form says "That is your secret key, so I did not keep it." Create a restricted key and paste that one instead. A key Stripe refuses is not stored either, and the form says why.

## Check the key

After the key is saved, ask the agent to check it (it uses `connection_check`, which needs `stripe:admin:connection`). The check makes one read per permission above and a refund probe on a charge that cannot exist, so nothing is created in Stripe. It answers ten rows, one per permission:

- **Read works** or **Write allowed**: the permission is there.
- **Missing: give Read to Disputes** (for example): that permission is missing. The connection stays usable; what that permission covers is not read until you add it to the key in Stripe and run the check again.

Liaison also runs this check on a new key before it keeps it. The check refuses, and the key already saved stays the one Liaison uses, when:

| Answer | What happened | What to do |
|---|---|---|
| `key_invalid` | Stripe refused the key: it was revoked, rolled or mistyped | Create a new restricted key and save it |
| `different_account` | None of the records Liaison already holds exists in the key's account | Save the key of the account Liaison is connected to, or disconnect Stripe fully first |
| `mode_changed` | The key is a live-mode key and Liaison holds test-mode data, or the other way round | Save a key of the same mode, or disconnect Stripe fully first |

Stripe does not let a restricted key show the account name, so the check does not name the account.

## Receive Stripe's events

Stripe tells Liaison about changes through a webhook. In **Developers → Webhooks**, add an endpoint at the address Liaison shows, select the Customer, Invoice and Charge events, and give Liaison the endpoint's signing secret (it starts with `whsec_`).

- **Signed deliveries only.** Each delivery's signature is checked against your workspace's own signing secret, on the server. A delivery signed with another secret, with no secret saved yet, or signed more than 5 minutes before or after it arrives, is refused.
- **Rolling the secret.** While you roll the secret in Stripe, the previous one keeps working for at most 24 hours.
- **Once per event.** A redelivered event changes nothing. A delivery is acknowledged only once it has been handled: while another run still holds it, the delivery is answered as not done yet and comes again. An event whose handling was cut off (a restart mid-delivery) is taken up by a delivery that comes 45 seconds or more later. Events that arrive out of order still end in Stripe's current state: Liaison reads each object from Stripe again, and never uses the event's own copy.
- **The first event** moves the connection to **connected** and records that event's name and time.
- **When the key stops working**, an event is acknowledged and kept for the catch-up, and the connection reads `key_invalid` (or `partial` for one missing permission).
- **When Stripe says an object does not exist** and Liaison cannot confirm it is still the same account, nothing is changed and the connection reads `different_account`.
- **Card numbers.** A card number written in a customer's description or name, an invoice memo or line, a payment failure message or a dispute reason is hidden before anything is stored, and the connection's admins get one item on Home saying so.
- **Live and test.** An event of the other mode (a live event on a test connection) is acknowledged and changes nothing.

## What reaches Invoicing

When Invoicing is on and Liaison issues your card subscriptions' invoices (invoicing's **Who issues what**), the Stripe app tells it about money, from what it read from Stripe:

- **A finalized or paid invoice** carries each line's price before tax, its discount, its VAT rate and the tax Stripe charged, and the customer's name, email, country, address and VAT number as the mirror holds them (card numbers hidden).
- **A refund.** When a payment is refunded, Invoicing gets every refund of that payment, each by its own id and amount, never the payment's refunded total. A credit note follows each refund once Stripe says it succeeded, once: two partial refunds make two credit notes that add up to what was refunded. A refund still pending waits; one that fails or is canceled makes no credit note. A refund approved in Liaison is announced as soon as Stripe answers, without waiting for Stripe's event.
- **A payment no invoice explains** (a charge with no Stripe invoice behind it) goes to Invoicing's queue of unmatched payments, once.
- **Missed events.** Invoicing's safety job asks the Stripe app every 10 minutes for Stripe invoices of the last 35 days with no Liaison invoice, invoices paid in the last 3 days, and succeeded refunds of the last 35 days with no credit note. A refund made while Invoicing was off gets its credit note this way once Invoicing is on again.

## Keep the mirror current

Besides the webhook, Liaison reads Stripe on its own schedule.

- **First import.** Right after you connect, Liaison reads every customer, subscription, invoice, payment, refund and dispute, about 10 requests a second. It keeps its place per kind of record, so an import that stops picks up where it left off, and nothing is stored twice. Invoices finalized before you connected are kept as history and never become Liaison invoices.
- **While importing**, the Stripe page shows the progress per kind of record and no figures. Events that arrive meanwhile are applied to the mirror at once, and announced to the rest of Liaison once the import is done.
- **Every night at 03:00**, Liaison reads Stripe's lists again and updates what changed. A record missing from a list is never treated as deleted: Liaison reads it back by itself, and marks a customer deleted only when Stripe says so for an account it has just confirmed is still yours.
- **Every 15 minutes**, Liaison compares the last event it received with Stripe's event log. When Stripe has newer events and none reached Liaison for 2 hours, the connection reads **stalled**, its admins get a Home item, and the missed events are applied from the log. A quiet account with no new events is never stalled.
- **Events that could not be applied** (for example while the key was refused) are applied again each minute once the key works.
- **When the key is refused** (401), the connection reads **key_invalid** and nothing is read until an admin saves a working key. Waiting requests, such as a refund, stay waiting; approving one meanwhile changes nothing and says why.
- **When a permission is missing** (403), the connection reads **partial** and the page names what the key may not read; the rest keeps working.

## Link customers to companies and contacts

Each Stripe customer can name one Liaison company and one contact. Liaison links them by itself when a customer is created or changed in Stripe, in this order:

1. A customer whose email names no contact yet gets a new contact with that email, linked to it.
2. Otherwise, a contact that already carries the customer's Stripe id. The customer also takes that contact's company.

Whoever pays types the email at checkout and Stripe does not check it, so an email never links a customer to a contact that already exists: that contact is shown as a suggestion when you look at the customer (`customers_get`), and nothing is linked until a person confirms it with `customer_link`.

A company whose web domain matches the customer's email domain is only a suggestion: nothing is linked until a person links it. A free-mail address (gmail.com, hotmail.fr, t-online.de and the like) never suggests a company. A link a person made is never replaced by an automatic one, and Liaison never removes a link because a match found nothing.

To link by hand, ask the agent (it uses `customer_link`, which needs `stripe:customers:write`). It links only a company or a contact you can open, changes Liaison only and never Stripe, and says so. `undo` puts back the link it replaced, and `unlink` clears it.

When two companies or two contacts are merged, every Stripe customer that named the merged one names the one you keep, in the same step, even while the Stripe app is turned off.

## Read customers, subscriptions and payments

The agent reads the mirror, never Stripe directly. Each answer names its records and says when the mirror last changed them.

| Tool | Reads | Scope |
|---|---|---|
| `customers_search` | Customers by name, email or id (`cus_`), or those not linked, past due, on trial or cancelled | `stripe:customers:read` |
| `customers_get` | One customer, by id or by the contact or company it is linked to, with its subscriptions and open invoices | `stripe:customers:read` |
| `subscriptions_search` | Subscriptions by id, plan, status or customer | `stripe:subscriptions:read` |
| `mrr_query` | Monthly recurring revenue per currency, with the plan split and the month's movements | `stripe:subscriptions:read` |
| `invoices_search` | Stripe invoices by customer or status | `stripe:invoices:read` |
| `payments_search` | Payments by id (`ch_`), customer, invoice or status; `unmatched` for those no invoice explains | `stripe:payments:read` |
| `disputes_list` | Disputes by customer or status. Read only: answer a dispute in Stripe | `stripe:payments:read` |

Answers are masked: no address and no tax id, and a card shows only its brand, last 4 digits and expiry. Customer names, plans and dispute reasons are written by people outside your company, so a turn that reads them is marked as having read outside text, and a later action that leaves Liaison (including `customer_link`) waits for a person's approval.

On a ticket from a linked contact, and on a linked contact's or company's page, the agent also gets a few lines: the plan and its status, the card's brand and last 4 digits, and the unpaid invoices with the next retry date. A company's and a contact's **Activity** timeline shows Stripe rows: customer created, payment failed, retry failed, subscription started (dated when Stripe started it), subscription cancelled, refund and dispute. The card shown is the one the subscription bills: when the customer adds a new card, the new one shows. On a customer's page, an invoice Liaison issued shows Liaison's number and opens the Liaison invoice.

## Refund, cancel and send a card link

A refund or a cancellation always waits for a person's approval: no policy approves it by itself, and nothing reaches Stripe before someone approves it on Home.

**Refund a payment.** Ask the agent (it uses `refunds_create`, which needs `stripe:refunds:write`). Give the payment's id (`ch_…`) and, for a partial refund, the amount; without an amount it refunds what is left. Before any approval waits, Liaison reads the payment from Stripe and refuses, with nothing to approve, when:

| Answer | Why |
|---|---|
| `already_refunded` | The payment is already refunded in full |
| `charge_disputed` | The payment is disputed: answer the dispute in Stripe instead |
| `amount_over_refundable` | The amount is above what is left to refund |
| `no_invoice_for_refund` | Liaison issues your card subscriptions' invoices (invoicing's **Who issues what**) and no Liaison invoice is behind this payment: say which invoice its credit note goes against |
| `issuer_unknown` | Liaison could not read who issues your card subscriptions' invoices: try again in a minute |
| `card_number_refused` | The reason holds a card number. Liaison never takes card numbers |

- The approval card shows the payment, the card (brand and last 4 digits) and the amount, which the approver can change.
- One refund waits per payment. Asking again edits your own waiting refund; someone else's waiting refund is never changed, and the answer names it.
- When the refund is approved, Liaison reads the payment again and refuses an amount above what is left now, so two refunds approved at once never refund more than the payment holds.
- If Stripe's answer is lost on the way back, the request is marked as unknown and nothing is sent again by itself. Approving it again first looks in Stripe for the refund this approval made, and sends nothing if it exists, however long ago that was.
- With a ticket, the refund adds an internal note on that ticket. It never replies to the customer: a reply is its own approval.

**Cancel a subscription.** Ask the agent (it uses `subscription_cancel`, which needs `stripe:subscriptions:write`). It cancels at the end of the current period unless you say now. The card shows how MRR changes, which invoices stop or stay open, and the company's open deals. The default restricted key cannot cancel subscriptions: the agent then says "This key cannot cancel subscriptions" and nothing waits. Give the key **Write** on **Subscriptions** in Stripe, run the key check, then ask again.

**Send a link to change the card.** `card_update_link` (read only, `stripe:customers:read`) gives, first that applies:

1. Your customer portal's login link, when an admin set it: the customer signs in by email on a Stripe page and replaces the card.
2. The Stripe page of the customer's open invoice: it pays that invoice with a new card, and later renewals may still use the old card. A link more than 30 days old is read again from Stripe first.
3. No link, with the reason.

The answer carries the sentence that is true for the link it gives, so a reminder says exactly what the link does. The link is never stored.

**Payment reminders.** A reminder about a Stripe invoice is a mail with a follow-up on that invoice. Just before it is sent, Liaison reads the invoice from Stripe: if it is paid, void or uncollectible the reminder is not sent, and if Stripe cannot be reached the reminder waits. It is a service message, so it carries no unsubscribe footer. The **failed-payments** routine (every morning at 07:00, off until you turn it on) drafts these reminders for card payments Stripe no longer retries.

Disputes have no write tool: answer them in Stripe's dashboard.

## How MRR is computed

`mrr_query` answers per currency; nothing is converted. While the first import runs, or a resource the key cannot read is missing, it answers "partial" and gives no figure.

- **Counted:** subscriptions that are `active` or `past_due`. Not counted: `trialing`, `canceled`, `unpaid`, `incomplete`, `paused`, free, metered and one-off prices.
- **Per item:** price times quantity, in one month: a year is divided by 12, a quarter by 3, a week is multiplied by 52/12 and a day by 365/12. A price that includes tax is reduced to its net by its rate. Discounts that recur come off (percentages first, then amounts); a discount that applies once, or has ended, does not.
- **Rounding:** once per subscription, to the nearest minor unit, halves up. A currency's figure is the sum of those whole amounts.
- **Past due:** shown beside the figure; "without it" is the figure less the past due amount.
- **Movements:** each change of a subscription's counted amount is kept once as new, upgrade, downgrade or cancelled (an amount that falls to zero for any reason). A trial that converts is new on the day it converts, and a cancellation set for the end of a period counts until that day. The month starts at midnight on the 1st in your organization's time zone, and the amount at the start of the month is the amount now less the month's movements.
- **If an event was lost:** the nightly reconcile reads Stripe's events of the last 30 days and writes the movements that are missing. A change older than that with no event to explain it still corrects the figure, but its movement is dated the day the reconcile found it, and the answer says "Movements incomplete before <date>".

## More

- [Connect Stripe with a restricted key](../money/connect-stripe-restricted-key.md), [Who issues what](../money/who-issues-what.md) and [turn off Stripe's own emails](../money/turn-off-stripe-emails.md).
- [The failed-payments routine](../money/failed-payments-routine.md) and [payment reminders](../money/payment-reminders.md).
- [Refunds and credit notes](../money/refunds-and-credit-notes.md), [disputes](../money/disputes-in-stripe.md), [the MRR rules](../money/mrr-rules.md) and [what Liaison holds about cards](../money/no-card-data.md).
- Schedules for customers who pay by transfer: [Recurring invoices](recurring.md).

## Disconnect Stripe

Disconnecting removes every record Liaison kept from Stripe: the mirror, the event log and the connection's state. Invoices and credit notes in Liaison's invoicing are kept.

## What Liaison stores

- Customers, subscriptions, invoices, payments, refunds and disputes, with amounts in minor units.
- For a card: its brand, its last 4 digits and its expiry. Never the card number or the security code.
- No raw webhook body and no Stripe `metadata`.

Every request goes to `api.stripe.com` only, with a pinned API version. The key is added to each request by the server, so the connector's code never holds it.

## Who sees what

| Role of the app | Can |
|---|---|
| Member | Read customers, subscriptions, invoices, payments, refunds and disputes |
| Billing | Also link customers to companies and contacts, and request refunds and cancellations |
| Admin | Also connect the account, check its key and manage its webhook |

| Scope | Lets a person or an agent |
|---|---|
| `stripe:customers:read` | Read customers |
| `stripe:customers:write` | Link a customer to a company or a contact |
| `stripe:subscriptions:read` | Read subscriptions |
| `stripe:subscriptions:write` | Request a subscription's cancellation (approved by a person) |
| `stripe:invoices:read` | Read invoices |
| `stripe:payments:read` | Read payments, refunds and disputes |
| `stripe:refunds:write` | Request a refund (approved by a person) |
| `stripe:admin:connection` | Connect the account, check its key and manage its webhook |
| `stripe:approve` | Decide Stripe approvals |
| `stripe:internal` | Used by the app itself |

Connecting needs `stripe:admin:connection`. See [Connect apps](../connecting-apps.md).

## Scopes

| Scope | What it allows |
| --- | --- |
| `stripe:customers:read` | Read customers |
| `stripe:subscriptions:read` | Read subscriptions and their revenue changes |
| `stripe:invoices:read` | Read invoices |
| `stripe:payments:read` | Read payments, refunds and disputes |
| `stripe:customers:write` | Link customers to companies and contacts |
| `stripe:refunds:write` | Request refunds |
| `stripe:subscriptions:write` | Request cancellations |
| `stripe:admin:connection` | Connect the account and manage its key and webhook |
| `stripe:internal` | Used by the app itself |

Member holds the four read scopes, Billing adds the three write scopes, Admin adds the connection.
