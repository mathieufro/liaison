---
title: Connect your Shopify store
description: "Connect a Shopify store over OAuth, browse orders, customers, products and markets, and see which agent tools change the store only after approval."
screenshot: "assets/screens/store.webp"
screenshotAlt: "The Shopify app home with the shop name, low inventory items and a list of unfulfilled orders past their SLA."
---

The Shopify app brings your store's orders, customers, products, markets, draft orders, refunds, fulfillments and returns into Liaison. Reading is open to anyone with the read scopes. Changes to the store are made by agents and wait for a person's approval.

## Connect the store

You need the store's `your-store.myshopify.com` domain. A free development store works for testing.

### When your server provides the Shopify app

Some servers bring one Shopify app for every workspace (set by whoever runs the server, see [Connect apps](../connecting-apps.md)). Then there is no app to create: ask the agent to connect Shopify, or open **Settings › Shopify › Store connection**, click **Connect**, fill in **shop** and approve. If you want your workspace to use its own Shopify app instead, give its client ID and secret in the form card or the connect dialog: your own app replaces the server's.

For whoever runs the server: an instance Shopify app (`SHOPIFY_APP_CLIENT_ID` / `SHOPIFY_APP_CLIENT_SECRET`) must use **custom distribution**. An app distributed through the Shopify App Store must answer Shopify's mandatory compliance webhooks (`customers/data_request`, `customers/redact`, `shop/redact`), and Liaison does not implement them yet. Each store's webhook is accepted only for the organization that has that store connected.

### Create the Shopify app with the agent

Ask the agent to set up Shopify. It creates nothing for you to install: it walks you through creating the app in the Shopify Dev Dashboard, with the values computed for your instance (`kernel__shopify_setup`, or `liaison guide shopify` on the command line). There is no app review and no CLI. One step at a time:

1. Sign in to `dev.shopify.com/dashboard` with the store owner's account (or a staff account that can manage apps), click **Create app** and name it.
2. In the new version, enter the **App URL** (`https://<your-liaison-host>`), the **Redirect URL** (`https://<your-liaison-host>/api/connections/callback`), then the **Scopes**, as given, and leave **Optional scopes** empty. The scopes include `read_all_orders`. Turn **Embed app in Shopify admin** off and **Use legacy install flow** off (Shopify-managed installation: a store gets exactly the scopes of the released version), set the webhooks API version to the one given, and click **Release**.
3. Full order history needs nothing more: an app your store's own organization creates in the Dev Dashboard gets `read_all_orders` without a review by Shopify. Only if **Release** fails on `read_all_orders` (the app belongs to a Partner organization), remove it from the scopes, release again, and request it: in the Partner Dashboard (partners.shopify.com), open **Apps**, then the app, then **API access requests**, then **Read all orders**. Shopify asks why the app needs orders older than 60 days: paste the answer the agent gives you (below). Go on without waiting for the approval.
4. On the app's Home, in its **Distribution** card, choose **Custom distribution**, enter your store's domain and open the install link.
5. Copy the app's client ID and secret from its settings into the form card the agent shows you. The secret also verifies Shopify's webhooks.
6. When `read_all_orders` stayed in the scopes, the agent turns on **Full order history** first (an approval card), then posts the **Connect** card: connect the store and approve, and it grants all orders on the first connect.
7. Only after a Partner Dashboard request: until Shopify approves it, Liaison sees the last 60 days of orders. Once it has, add `read_all_orders` back to the scopes, click **Release**, and tell the agent. It turns on **Full order history** and posts the **Connect** card again: reconnect the store and approve.

### Create the Shopify app with the Shopify CLI

If you prefer the Shopify CLI, ask the agent for the app configuration file instead (`kernel__shopify_app_toml`). It posts a `shopify.app.toml` built from the Shopify app's own scopes and your instance's `BASE_URL`, with these steps. The file uses Shopify-managed installation (`use_legacy_install_flow = false`) and has no `optional_scopes`: Shopify grants each store exactly the scopes listed under `[access_scopes] scopes`, whatever the connect asks for.

1. Save the file in an empty folder as `shopify.app.toml`. It arrives as `shopify-app.toml`, and the Shopify CLI reads only the first name.
2. Install the Shopify CLI: `npm install -g @shopify/cli@latest`.
3. Run `shopify auth login` yourself, in your own terminal: it opens the browser to sign in. Sign in with the account that owns the store and choose the store's own organization. The agent never runs this login for you.
4. In that folder, run `shopify app config link` and choose to create a new app. Give the agent the `client_id` the CLI wrote into the file: it posts the file again with the ID inside, because linking can replace the file's URLs. Save it in place of the old one.
5. Run `shopify app deploy`. Shopify now has the permissions Liaison asks for and its callback.
6. Then continue with steps 3 to 6 above. Once Shopify approves **Read all orders**, tell the agent: it turns on **Full order history** and posts the file again, now with `read_all_orders` in its scopes. Replace the file, run `shopify app deploy`, then reconnect the store and approve.

To add a scope later (a newer Liaison asks for one, and **Permissions update required** appears), ask the agent for the file again, or add the scope to `[access_scopes] scopes` yourself, run `shopify app deploy`, then click **Reconnect** and approve. A reconnect alone never adds a scope the released configuration lacks.

The file has no webhook subscriptions: Liaison subscribes to the store's webhooks itself when the store connects. Disconnecting the store deletes those subscriptions, and so does a reconnect for any left from an earlier connection of the same workspace; subscriptions of other workspaces or other servers on the store are left alone. A template of the file ships as `bundled-apps/shopify/shopify.app.toml.example`.

### Create the Shopify app by hand

1. In the Shopify Dev Dashboard, create an app and note its client ID and secret.
2. Add `https://<your-liaison-host>/api/connections/callback` to the app's redirect URLs. It must match your instance's `BASE_URL` exactly, or Shopify answers `redirect_uri_mismatch`. List every scope Liaison needs in the app's scopes, leave optional scopes empty and turn **Use legacy install flow** off: Shopify grants a store only the scopes of the released version.
3. In Liaison, open **Settings › Shopify › Store connection** and click **Connect**.
4. If the app has no OAuth client yet, fill in **Client ID** and **Client secret**. When a client is already configured, the dialog asks for none.
5. Fill in **shop** with your store domain. `acme` and `acme.myshopify.com` both work.
6. Click **Connect via OAuth** (just **Connect** when a client is already configured), review the Admin API permissions on the Shopify screen and approve them. Shopify sends you back and the connection is made. No token is copied by hand.
7. Request **Read all orders** in the Partner Dashboard, as in step 3 above. Once Shopify has approved it, tell the agent: it turns on **Full order history** (`fullOrderHistory`) for you (an approval card in the app; with a coding agent, `apps[].settings.fullOrderHistory: true` and `liaison config apply`). Add `read_all_orders` to the app's scopes and release that version, then reconnect the store and approve.

Connect the store for the whole organization, not as a personal account. A personal connection returns `not_connected` to everyone else and to agents acting for someone else. See [Connect apps](../connecting-apps.md).

### Connect with a store's access token

A store whose custom app gives you an Admin API access token (`shpat_…`) can connect without the OAuth round trip, from the server's command line: `liaison connect shopify/shop --token-env SHOP_TOKEN --account your-store`, with the token in the `SHOP_TOKEN` environment variable (`--client-secret-env` for the app's secret, which signs its webhooks). The token is stored like an OAuth grant and never printed. The customer backfill and scope-seed jobs can then be run at once with `liaison app run-job shopify <job> --wait`. See the [provisioning CLI](../provisioning-cli.md).

### Full order history

Liaison needs the store's full order history for support, invoicing and imports. Shopify shows an app only the last 60 days of orders until the app holds `read_all_orders`, a protected permission. An app the store's own organization creates in the Dev Dashboard gets it by listing it in its scopes; a Partner organization's app needs Shopify's approval first. The configuration file lists it only once **Full order history** is on, so `shopify app deploy` and the connect work while the approval is pending. Because Shopify grants a store only the scopes of the released configuration, full order history takes these steps: Shopify approves `read_all_orders` for the app, you turn on **Full order history**, the agent hands you the file again (it now lists `read_all_orders`), you run `shopify app deploy`, then you reconnect the store. Liaison also asks for it when the store being reconnected already holds it.

The answer to paste in Shopify's form, in English for Shopify's reviewers:

> Liaison is a support, operations and invoicing workspace for the merchant's own store, installed only on their store (custom distribution). It needs the store's complete order history to: answer customer support requests about orders of any age (warranty claims, returns, repairs and order questions often concern purchases made months or years ago); issue credit notes, refunds and corrected invoices that must reference the original order, whatever its date, as accounting and tax rules require; import the merchant's past orders when they first set up the workspace, so customer histories and reports are complete from day one. Order data is used only inside the merchant's own workspace and is never shared with third parties.

While the store's grant lacks `read_all_orders`, **Attention** shows an item: request it from Shopify, then turn on **Full order history**, add it to the Shopify app's configuration and release it, and reconnect. Once the setting is on, the item asks you to add it to the configuration, release it and reconnect. If Shopify refuses the release (`shopify app deploy` or **Release**) because of `read_all_orders`, the approval is not through yet: turn **Full order history** off, and try again once Shopify confirms.

When your server provides the Shopify app, its operator requests the access for that app; you only connect.

When the agent searches orders in a date window, the window is on each order's placed date (`processedAt`), which differs from its creation date for an imported or backdated order. An order can then be missing from a window although its number falls between two orders shown, so the agent looks a neighbouring order up by its number before calling it the previous one.

If **Permissions update required** appears in the settings, the connection was approved before the app asked for a newer permission, and Shopify limits what the tools can see (for example order history older than 60 days). Shopify grants only the scopes of your Shopify app's configuration, so **Reconnect** alone cannot add it: first add the missing scopes to the configuration (download the current `shopify.app.toml` from the setup guide, or add them to `[access_scopes] scopes`) and run `shopify app deploy` (in the Dev Dashboard: add them to the **Scopes** and click **Release**), then click **Reconnect** and approve. A store connected before the app asked for the locations permission (`read_locations`) is one: until it reconnects, `locations_list` and the stock-per-location reads are refused.

## Browse the store

Open **Shopify** in the activity bar.

- **Home** shows **Recent orders** and three attention cards: **Low inventory**, **Unfulfilled past SLA** and **Pending returns**.
- **Orders** lists orders with a search box and the filters **All**, **Open**, **Unfulfilled**, **Cancelled**, **Refunded** and **Drafts**. When [Invoicing](invoicing.md) is installed, an order's invoice number shows on its row. Click it to open the invoice.
- **Has items to ship** narrows the orders list to orders with at least one item that needs shipping. It hides software-only orders and drafts, and works together with the other filters.
- **Items** sums up each order's cart with your product short codes, for example `1×E2, 2×FS`. A product with no short code shows as `1×?`: hover it to see the product name. An order with more lines than the list reads ends with `+N more`. Short codes are kept per SKU in Liaison's product attributes (a shipping app such as [Boxtal](boxtal.md) fills them from its shipping profiles, or an agent sets them with `product_attributes_upsert`).
- **Tags** shows each order's Shopify tags.
- **Customers**, **Products** and **Markets** are searchable lists.

Click a row to open its detail. Each detail has **Open in Shopify ↗** to jump to the same record in the Shopify admin.

To change anything in the store (a refund, a fulfillment, a stock count, a discount), ask an agent. Its change waits for your approval, see below.

## Map Liaison users to Shopify staff

**Settings › Shopify › Diagnostics and mappings** (needs `shopify:admin:identity-map`) shows **Sync diagnostics** and **Identity mappings**.

1. Find the Liaison user in **Identity mappings**.
2. Click **Map manually**, type the **Shopify staff id** and click **Save**.
3. To undo a manual mapping, click **Remove override**.

## Choose who gets Shopify's shipping email

**Settings › Shopify › Shipping emails › Send Shopify's shipping email to** (`customerShippingEmail`) decides whether Shopify emails the customer, with the tracking, when an order is fulfilled from Liaison: by an agent, by Boxtal's Packed tick or by a carrier scan.

| Option | Who gets the email |
| --- | --- |
| **As each fulfillment asks** (the default) | Whoever the fulfillment asks for. Boxtal's tick and carrier scans ask for none. |
| **Retail orders only (never B2B)** | Retail customers. B2B buyers never do. When Liaison cannot read the order or the settings, no email is sent. |
| **Every order** | Every customer. |
| **No order** | Nobody. |

An order is B2B when its buyer is a Shopify B2B company, or when a line item's sku ends with one of the **B2B sku suffixes** (`b2bSkuSuffixes`: comma separated, not case sensitive, for example `-B2B`). Under **Retail orders only** and **Every order**, a customer gets one shipping email per fulfillment, and it carries the tracking: a fulfillment created without a tracking number sends nothing, the tracking update that gives it its first number sends the email, and a later change of number, carrier or link never emails again. The agent's result says whether Shopify emailed the customer, and the approval card says what will happen: **Customer will be notified: retail order**, **Customer will not be notified: B2B order**, **Customer will not be notified: no tracking number yet**, **Customer will not be notified: the fulfillment already has a tracking number**, or that the notification is decided at execution when the order cannot be read before approval. With a coding agent, set both under `apps[].config` and run `liaison config apply`.

## Quotes and paid orders

With Invoicing installed and a shop mapped to an issuer profile, a Shopify draft order and an Invoicing quote are the same object, and a paid order issues its invoice automatically. A refund or cancellation in Shopify issues the matching credit note. See [Issue invoices and quotes](invoicing.md).

An order read shows the tax it charged, whether it was tax exempt and the B2B company that bought it, and a customer read shows whether the customer is tax exempt and the companies they buy for. Invoicing reads these to tell a business customer in another EU country from a consumer. `orders_search` and `customers_search` take an optional `timeout_ms` (500 to 10000): a caller on a time budget, such as that check, gets an error at once when Shopify is slow or rate limits it, instead of waiting.

## Scopes

| Scope | What it allows |
| --- | --- |
| `shopify:orders:read` / `shopify:orders:write` | Read orders and abandoned checkouts / update tags, notes, cancel |
| `shopify:draft-orders:read` / `shopify:draft-orders:write` | Read / create, change, send and complete draft orders |
| `shopify:refunds:create` | Refund an order |
| `shopify:returns:read` / `shopify:returns:write` | Read / open, approve, decline, refund and close returns |
| `shopify:fulfillments:read` / `shopify:fulfillments:write` | Read / create, cancel and update fulfillments |
| `shopify:locations:read` | List fulfillment locations |
| `shopify:customers:read` / `shopify:customers:write` | Read / update customers, tags and marketing consent |
| `shopify:products:read` / `shopify:products:write` | Read / change products and variants, publish and unpublish |
| `shopify:inventory:read` / `shopify:inventory:write` | Read / adjust stock |
| `shopify:markets:read` | Read markets |
| `shopify:analytics:read` | Sales analytics |
| `shopify:discounts:read` / `shopify:discounts:write` | Read / change discount codes |
| `shopify:metafields:read` / `shopify:metafields:write` | Read / change metafields |
| `shopify:admin:identity-map` | Diagnostics, staff mappings, disconnect, webhook repair |
| `shopify:admin:scope-seed` | Apply a reviewed scope-seed suggestion |
| `shopify:approve` | Decide Shopify approvals |
| `shopify:internal` | Used by the app itself |

## What agents can do

Read tools never wait. Every tool marked "Always" files an approval and changes nothing until a person approves it.

| Tool | What it does | Approval |
| --- | --- | --- |
| `home_load` | The Home dashboard | No |
| `orders_search`, `orders_get`, `orders_invoice_links` | Find and read orders and their invoices | No |
| `fulfillment_orders_get`, `fulfillments_get`, `refunds_get`, `returns_search` | Read fulfillment, refund and return records | No |
| `abandoned_checkouts_list` | Abandoned checkouts with recovery links | No |
| `customers_search`, `customers_segment_search`, `customers_get`, `customers_get_by_external_id`, `repeat_rate` | Find customers, spend segments, repeat purchase rate | No |
| `draft_orders_list`, `draft_orders_get` | Read draft orders | No |
| `products_search`, `products_get`, `products_publication_targets`, `variants_search`, `variants_get`, `variants_brief`, `variants_market_price` | Read products, their sales channels, variants and market prices | No |
| `inventory_levels_list`, `inventory_value`, `locations_list` | Stock per location and stock value | No |
| `markets_list`, `markets_get` | Read markets | No |
| `analytics_query` | Sales totals over a period, by SKU or market | No |
| `discounts_search`, `metafields_list` | Read discount codes and metafields | No |
| `order_note_set` | Set an order's internal staff note | No |
| `webhooks_repair` | Re-register the store webhooks | No |
| `settings_load` | The settings panel data | No |
| `order_update`, `order_cancel` | Change tags or note, cancel an order | Always |
| `refunds_create` | Refund an order | Always |
| `draft_orders_create`, `draft_orders_update`, `draft_orders_delete`, `draft_orders_send`, `draft_orders_complete` | Draft orders (quotes) | Always |
| `fulfillments_create`, `fulfillments_cancel`, `fulfillments_update_tracking` | Fulfillments | Always |
| `products_create`, `products_update`, `products_delete`, `products_merge`, `products_publish`, `products_unpublish` | Products | Always |
| `variants_create`, `variants_update`, `variants_delete` | Variants | Always |
| `inventory_adjust`, `inventory_set_on_hand` | Change stock by a delta or to a count | Always |
| `discounts_create`, `discounts_bulk_create`, `discounts_update`, `discounts_delete` | Discount codes | Always |
| `returns_request`, `returns_approve`, `returns_decline`, `returns_refund`, `returns_close` | Returns | Always |
| `customers_update`, `customers_tag`, `customers_email_marketing_consent_update`, `customers_sms_marketing_consent_update` | Customers and consent | Always |
| `metafields_set`, `metafields_delete` | Metafields | Always |
| `connection_disconnect`, `staff_overrides_upsert`, `staff_overrides_delete`, `apply_seed_suggestion` | Admin actions | Always |

`analytics_query` may return `partial: true` when the store's plan does not offer ShopifyQL. Treat that result as an estimate.

`products_publish` with only a product publishes it on every sales channel it is not on yet, and `products_unpublish` takes it off the channels it is on. The approval card names each channel. Both need the store's sales channel permission: a connection approved before the app asked for it shows **Permissions update required**, and the tools refuse to stage a request until you click **Reconnect**.

Related: [Invoicing](invoicing.md), [Boxtal](boxtal.md), [Approve what agents do](../agents/approvals.md), [Agent tools](../reference/agent-tools.md), [App settings](../reference/app-settings.md).
