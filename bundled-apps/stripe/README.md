# stripe — payments connector

Connects an organisation's Stripe account to Liaison through a **restricted key**
and a **signed webhook**. The app keeps a read mirror of customers,
subscriptions, invoices, payments, refunds and disputes in the `app_stripe`
schema, so agents and screens read money facts from the mirror, never from
text a customer wrote.

## What it stores

| Table | Holds | Read scope |
|---|---|---|
| `stripe_customers` | name, email, currency, billing address, tax ids, the link to a Liaison company or contact | `stripe:customers:read` |
| `stripe_subscriptions` | status, plan, items, MRR in minor units, period, trial, card brand / last 4 / expiry | `stripe:subscriptions:read` |
| `stripe_invoices` | number, status, totals in minor units, period, who issued it | `stripe:invoices:read` |
| `stripe_payments`, `stripe_refunds`, `stripe_disputes` | charges, refunds and disputes, amounts in minor units | `stripe:payments:read` |
| `stripe_mrr_events` | append-only MRR movements | `stripe:subscriptions:read` |
| `sync_state`, `install_metadata`, `webhook_deliveries` | sync cursors, connection state, the webhook ledger (no body) | internal |

No column can hold a card number or a CVC, raw event bodies are never kept, and
Stripe `metadata` is not stored (`src/schema-guard.test.ts`).

## How it calls Stripe

Every request goes through `src/http.ts` (`stripeFetch`): only to
`api.stripe.com`, with the pinned `Stripe-Version`, and with the restricted key
added by the host, so the key never enters the app's sandbox.

## Roles

`member` reads the mirror. `billing` adds customer links, refunds and
cancellations (both through approvals). `admin` connects the account.
