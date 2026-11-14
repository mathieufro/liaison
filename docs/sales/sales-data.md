---
title: Query your sales data
description: "Ask agents about customer spend in Shopify, read your own database through a read-only connector, and link call transcripts to contacts and deal tasks."
---

Agents can answer sales questions from the data you already have: customer spend and repeat purchases in your Shopify store, the tables of your own database, and the transcripts of your calls. This page shows what each source gives an agent and what to connect first. You ask in plain words, for example "Who are our customers who spent over 1,000 this year?", and the agent picks the tools.

## Where deals live

Deals live in Liaison, on a pipeline in [Projects](../apps/projects.md), with an amount, a company and a contact (see [Track deals on a pipeline](deals.md)). Ask the agent about them with `deals_search`, and sum them with `deals_rollup` (see [Forecast your pipeline](forecast.md)).

If your deals live in your own CRM or ERP, connect it with the API connector. An adapter that fills the `deal.list` role shows a customer's **Deals** on the customer card and lets agents read them. See [Connect your own CRM or ERP](connect-your-crm.md). A call transcript can be linked to a deal task (see below).

## Ask about Shopify customers

With the Shopify store connected (see [Store](../apps/store.md)), agents use these tools. All need `shopify:customers:read`.

| Tool | What it answers |
| --- | --- |
| `shopify__customers_search` | Find customers. Each result carries the lifetime spend (`amountSpent`) and order count (`numberOfOrders`). Results come in pages of about 100, with the total count of matches |
| `shopify__customers_segment_search` | Customers who spent more than an amount (`minSpend`). Shopify evaluates the threshold itself, and returns only the matches and their total count |
| `shopify__repeat_rate` | The share of customers with more than one order, with a sample of repeat customers. It does not split customers by an event or a date cohort |

When an agent read only part of a list, it must say how many it reviewed out of the total.

To mark customers for follow-up, an agent can tag them in Shopify with `shopify__customers_tag` (`shopify:customers:write`), or tag them and put them in a group in Liaison's own Contacts. See [Keep customers and prospects in Contacts](contacts.md).

## Read your own database

The **Database** connector gives agents a read-only window onto a Postgres database of yours. Writes are impossible, and columns holding secrets are not readable.

1. Create a read-only database role. On the same machine or a private network, `scripts/db-readonly-role.ts --create` mints one. You paste its connection string in the next step.
2. Open **Settings › Connectors › Database**.
3. Connect it in one of two ways, never both:
   - **Direct**: paste the Postgres connection string into `connectionString`. A host that resolves to a public address needs TLS (`sslmode=require`).
   - **Gate**: run the `liaison-db-gate` sidecar next to your database with a `catalog.yaml` of curated reads, then enter its `gateUrl` and bearer `gateToken`. Use this when the connection crosses an untrusted network.
4. After connecting, the safety probe runs and warns about any write or execute rights the role should not have. Review it before you rely on the connection.

You can also add a second connection, `warehouse`, for an analytics warehouse or a replica: a connection string, a `dialect` (`postgres` or `redshift`) and an optional `statementTimeoutMs`.

What agents can do:

| Tool | What it does | Scope |
| --- | --- | --- |
| `db_describe` | List the tables the role can read, or one table's columns | `database:reads:read` |
| `db_list_reads`, `db_read` | List and run the curated, named reads of the catalog, if your deployment ships one | `database:reads:read` |
| `db_query` | Run one read-only `SELECT` (or `WITH … SELECT`) | `database:query:read` |
| `db_probe` | Run the safety probe again | `database:reads:read` |

No database tool is gated by default. If an admin adds an approval policy to one, `database:approve` is the scope that lets a person approve, edit or deny those requests. It is not part of the **member** or **admin** role, so grant it where needed.

The connector's **member** role gets the curated reads, its **admin** role adds `db_query`. A deployment can turn raw queries off with `LIAISON_DATABASE_ALLOW_RAW_QUERY=false`. Every call on the `warehouse` connection needs `database:query:read`.

### Restrict reports by domain

Each curated read belongs to a domain (revenue, customers, returns...). An
admin can keep a domain's reports to some people in **Settings › Connectors › Database ›
Report access**:

- **Internal**: every member who can read reports (the default).
- **Confidential**: only the roles you add.
- **Restricted**: only the people you add.

Admins and members who can run raw queries always see every report. A
member's agent does not list the reports the member may not run; asked for
one by name, it says the report is restricted and to ask an admin for access.
Raw SQL queries (admins only) are not limited by these tiers.

To write a catalog of curated reads for your schema, see [Adapt the database connector](../database-connector.md).

## Link call transcripts to a contact and a deal

The Calls app turns transcripts from a meeting bot or a phone transcriber into knowledge documents, one per call, titled `Appel — <callRef>`. Transcripts arrive only through a signed webhook from your transcript tool. There is no upload button. See [Calls](../apps/calls.md) to connect one.

An agent links a call to a contact and to a deal task with `calls_set_links`, for example: "Link today's call with Inês to her contact and to the Northwind deal task." It records the links in the call's document.

| Tool | What it does | Scope |
| --- | --- | --- |
| `calls_list` | List the calls that have a transcript | `calls:transcripts:read` |
| `calls_segments_since` | Read a call's transcript, from a point in time on | `calls:transcripts:read` |
| `calls_set_links` | Link a call to a contact (`contactId`) and a deal task (`dealTaskId`) | `calls:transcripts:write` |
| `webhook_info` | Show the webhook signing secret, for setup | `calls:admin` |

## Related pages

- [Research prospects and draft replies](research-prospects.md)
- [Send quotes and follow-up documents](quotes.md)
