---
title: Connect your own CRM or ERP
description: "Connect your CRM, ERP or any HTTPS API with an adapter, so agents read your customers, orders and deals and a customer card shows on mail and tickets."
---

Liaison keeps its own companies and deals (see [Companies](companies.md) and [Track deals on a pipeline](deals.md)). If your customers, orders, invoices or deals live in a CRM or ERP instead, connect it with the **API connector**. Agents then read it, and a **Customer** card shows on mail conversations and tickets. This page shows how to add a connection, enter its credentials, test it and see what agents and your team get.

## What you need

- An **adapter**: a YAML or JSON document that describes the API. It gives the base URL, the auth type and the named operations, each a read or a write, with its params and the fields it returns. The [API connector reference](../api-connector.md) has the format and a worked example, and the `api-connector-authoring` skill walks a coding agent through writing one from your API's docs or OpenAPI document.
- The credentials the adapter's auth type asks for.
- The API connector's **admin** role (`api-connector:admin` and `api-connector:accounts:admin`) to manage connections and their credentials.

Check an adapter before you upload it:

```
liaison api-connector validate crm.adapter.yaml
```

## Let the agent connect it

An admin can ask the agent instead: "connect our CRM, its API docs are at https://...".

1. The agent reads the API's documentation and the authoring guide, then writes the adapter.
2. It asks you to approve the save. The card shows the API's address, its auth type and the operations. When the change points the connection at another address or auth type, the card also says the stored credentials will be deleted. Only an API connector admin can approve it.
3. It asks for the credentials in a secure form, never in the chat.
4. It tests each read and tells you what the connection answers and what failed.

Every save keeps the adapter it replaces, so you can go back to it (see below).

## Add a connection

1. Open **Settings › Connectors › API connector**. The **Connections** section lists your connections.
2. Click **Add connection**.
3. Enter a **Connection name**: lowercase letters, digits and dashes, for example `crm` or `erp-eu`. Agents and the CLI refer to the connection by this name.
4. Paste the adapter under **Adapter (YAML or JSON)**, or use **Or load a file**.
5. Click **Save adapter**. An invalid adapter is refused, with each problem shown at its place in the document.

You can connect several systems, one connection each. To change a connection later, click **Replace adapter**. If the new adapter points at another address or auth type, Liaison warns that saving it deletes the stored credentials; click **Save and delete credentials** to go ahead, then enter them again. **Delete** removes the adapter and its credentials.

## Enter the credentials

1. On the connection, click **Credentials**. The form says how this system authenticates.
2. Fill in the fields for its auth type and click **Save credentials**. They are stored encrypted and never shown again.

| Auth type in the adapter | Fields |
| --- | --- |
| `apiKey` (sent in a header or a query parameter the adapter names) | **API key** |
| `bearer` | **Token** |
| `basic` | **Username**, **Password** |
| `oauth2ClientCredentials` (the token address is in the adapter) | **Client id**, **Client secret** |

Each connection shows its status: **Connected**, **Needs credentials** or **Error**, and the customer roles it fills (see below), or **No customer roles filled**.

## Test a read

1. On the connection, click **Test**.
2. Pick the **Operation**, fill in its params, and click **Run**.
3. You see the HTTP status, the time it took and the items it returned, or why it failed.

Only read operations can be tested. A write is refused without sending anything.

From a terminal, the same test is:

```
liaison api-connector test crm customer.lookup --param email=ines@northwind-acoustics.example
```

## Restore an earlier adapter

1. On the connection, click **History**. It lists the earlier versions of the adapter, with who saved each one and when (the last 20 saves).
2. Click **Restore** on the version you want.
3. If that version points at another address or auth type, Liaison warns that restoring it deletes the stored credentials. Click **Restore and delete credentials** to go ahead, then enter the credentials again.

## Fill the customer roles

An operation can declare one of six fixed roles. The customer card and the agent's automatic context use them, so an adapter that fills them gets those features for free.

| Role | What it does | Params |
| --- | --- | --- |
| `customer.lookup` | Find customers | one of `email`, `phone`, `domain` |
| `customer.summary` | One customer's summary | `customerId` |
| `customer.orders` | One customer's orders | `customerId` |
| `customer.invoices` | One customer's invoices | `customerId` |
| `deal.list` | One customer's deals | `customerId` |
| `stock.check` | Stock levels | `sku` or a free-text `query` |

## See the customer card

On a mail conversation and on a ticket, the **Customer** card shows who the person is in your system.

- Liaison looks the person up by email, then by phone, then by their company's domain. It skips free mail domains (gmail.com, hotmail.fr, t-online.de and the other common national providers) and your own domains. A record found by domain says **Matched by company domain**: it is the company, not the person.
- When several records match, the card says so and lets you pick one.
- The card lists **Recent orders**, **Invoices** and **Deals** when the adapter fills those roles, and offers **Open in** your system.
- The card is hidden when no connection fills `customer.lookup`, when you lack `api-connector:read`, or when there is no email to look up.

Answers are cached for 60 seconds.

## What agents do with a connection

| Tool | What it does | Scope | Approval |
| --- | --- | --- | --- |
| `connector_list_operations` | List the connections and their operations | `api-connector:read` | No |
| `connector_read` | Run a read operation | `api-connector:read` | No |
| `connector_write` | Run a write operation, such as adding a note, a contact or a company in the CRM | `api-connector:write` | Yes |

When you ask about a ticket or a mail, the agent also gets the matched customer's summary automatically, by email only, if the turn holds `api-connector:read`.

Agents treat the connection as the system of record for its customers. They answer about orders, invoices and deals from it first and say which system an answer came from. Before they create a contact or a company in the CRM, they look the person up by email and the company by domain and name, and add to the record that exists instead of making a duplicate. A change to Liaison's own contacts is never reported as a CRM change. See [Approve what agents do](../agents/approvals.md).

## Roles and scopes

| Role | Scopes |
| --- | --- |
| **member** | `api-connector:read`, `api-connector:write`: read operations, the customer card, and writes through approvals |
| **admin** | member, plus `api-connector:admin` and `api-connector:accounts:admin`: manage connections and their credentials |

The scopes cover every connection of the organization. They are not set per connection.

`api-connector:approve` is a separate scope. `connector_write` is gated, so each write waits for a person who holds it to approve, edit or deny the request. Give it to the people who may change records in your CRM or ERP. See [Approve what agents do](../agents/approvals.md).

## Limits and safety

- Only `https` addresses are allowed. Link-local and metadata addresses are always refused. Every redirect must stay on the adapter's host.
- Each request has 15 seconds and a 2 MB response cap. A call returns at most 200 items, over at most 5 pages within 45 seconds.
- Responses are cut down to each operation's declared fields.
- Errors report the status code and a fixed message, never the response body or a credential.
- For development only, `LIAISON_ALLOW_PRIVATE_API_CONNECTOR_HOSTS=true` lets plain `http` reach a loopback host and lets private addresses through. See the [environment reference](../reference/env.md).
- In the demo workspace, connections are read-only and only the sample connection is available.

## Set it up from a config file

`liaison config apply` loads connections through the `api-connector` app's entry: its `provision.connectors` lists each connection's `identifier` and `adapter` (inline, or `{ $file: <path> }` next to the config file), and its `connections` list holds each connection's `credentials`, which can use `${VAR}` references. `liaison config verify` probes each connection with a read. See [API connections in Provision an org from the CLI](../provisioning-cli.md#api-connections-appsprovision-of-api-connector).

## Related pages

- [Research prospects and draft replies](research-prospects.md)
- [Query your sales data](sales-data.md)
- [CLI reference](../reference/cli.md#api-connector-validate)
