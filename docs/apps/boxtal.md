---
title: Ship orders with Boxtal
description: "Connect Boxtal, prepare and ship Shopify orders from the To prepare queue, print labels, follow returns and see which agent tools wait for approval."
---

The Boxtal app ships parcels over the Boxtal carrier network: carrier quotes, shipments and prepaid return labels, tracking, and customs documents. This page shows how to connect Boxtal, work the order queue, and what agents can do.

## Connect Boxtal

Boxtal has two API generations and the app needs a key pair for each.

1. Create a free account at boxtal.com: a test account for the sandbox, a normal account for live shipping.
2. In your Boxtal account's API / developer area, generate the v3 access key and secret, then the legacy v1 (EnvoiMoinsCher) key and secret.
3. In Liaison, open **Settings › Boxtal › Boxtal account** and click **Connect**.
4. Fill in **v1 API key**, **v1 API secret**, **v3 API key**, **v3 API secret**, and **Environment (sandbox|production)** (`sandbox` or `production`).

The four keys stay with the server: Liaison adds them to each Boxtal request itself, so the app's code never reads them. Only **Environment** is readable by the app, to pick the sandbox or production API.

Connecting needs `boxtal:admin:connection`. Connect a shared company account as an organization connection, or other people and agents get `not_connected`. See [Connect apps](../connecting-apps.md).

Boxtal posts tracking and document events back to Liaison through two webhooks, signed with a secret Liaison generates (`boxtalWebhookSecret`). If tracking stops updating, an agent can re-register them with `webhooks_repair`.

## Set the ship-from address and label format

Open **Settings › Boxtal**. Editing these sections needs `boxtal:catalog:write`.

| Section | Fields |
| --- | --- |
| **Ship-from address** | **Company or name**, **Phone (E.164)**, **Email**, **Street**, **Postal code**, **City**, **Country (ISO code, e.g. FR)** |
| **Pickup points** | **Exclude relay and pickup point services** |
| **Labels** | **Label format** (for example `PDF_10x15` for a 10x15 cm thermal printer) |

The settings keys behind these fields are `street`, `postalCode` and `countryIsoCode` (the address, saved together by the sender-address tool) and `exclude_pickup_point_services` (a toggle, on by default). When it is on, quotes and shipments skip relay and access point delivery so a home delivery order is never quoted at a relay price. Turn it off to allow relay offers.

A new label format applies to shipments created after the change.

## Prepare and ship orders

**To prepare** has one row per open, unfulfilled Shopify order. A row leaves the queue when Shopify reports the order fulfilled or when you exclude it.

1. Open **Boxtal** and click **To prepare** in the sidebar.
2. Click **Pull orders** to fetch new orders and refresh quotes. **Refresh stale** re-quotes only the rows whose estimate is out of date.
3. On each row, set the status: **To prepare**, **Validated** or **On hold** (waiting on stock, a customer or a repair). An agent's call names the row by its `order_key` or its invoice's `document_ref`: one that names no row, order or document is refused and writes nothing, and so are two that name different rows.
4. Set the category, which decides the shipping document: **Sale** ships on the order's issued invoice. **Repair** and **Sample** ship on a proforma the app issues through [Invoicing](invoicing.md). That proforma may wait for approval, and the category is locked until it is decided.
5. Pick the carrier offer if you do not want the cheapest one.
6. Click **Ship**. A label purchase waits for approval. Someone who can approve sees **Approve and buy** and **Decline** on the row.

The **Country** column shows the destination's two-letter code (hover it for the country's name). Click its header to sort by country, and use **All countries** to show one country only.

Click **x** on a row to exclude it from the worklist, tick **Show excluded** to see excluded rows, and **Restore** to put one back.

To ship something with no Shopify order (a repaired unit going back, a sample), click **Add shipment**.

### Which address a label goes to

A shipment takes its whole address (street, postal code, city, country) from one place, in this order:

1. The recipient typed on a shipment added with **Add shipment**.
2. The ship-to on the Shopify order.
3. A verified delivery address in the customer's contact (see [Contacts](../sales/contacts.md)), only when the order has no ship-to.
4. The address copied onto the customer's contact.
5. The customer's default address in Shopify.
6. The address printed on the invoice.

A phone, an email or a state can come from another of these only when that one is at the same address. Two addresses count as the same when the country, the postal code and the street match once case, accents, punctuation and short forms ("Str.", "Av.") are set aside. The house numbers must be the same.

When the order has a ship-to and the customer has a verified delivery address that is not the same place, the row shows **Address differs** and cannot ship until someone picks:

1. Click **Address differs** on the row. The order's address and the verified address open side by side under it.
2. Click **Use order address** or **Use verified address**.

The pick holds until either address changes; then the row shows **Address differs** again. An agent can ask for the same pick (`prep_set_address_choice`), which always waits for a person to approve it. Its approval card shows the two addresses as they read when it was asked. If either one changes before the approval, approving stores nothing, says so, and the row stays held: ask again. An agent is told at once when there is nothing to pick. For a return, which has no **To prepare** row, the pick is made the same way with `prep_set_address_choice` on the sale invoice.

Two addresses are the same place only when the country, postal code, city, street and house number all match (spelling, accents and common abbreviations aside). If the store cannot be reached when the label is bought, nothing is bought and the label is refused with "Could not read the order's address from the store; try again" rather than guessing an address.

Once the customer has a verified address, the label's approval card says which address the label goes to and whether it is verified, for example "Address: from the order, verified 2026-10-20 by Sam from a purchase order". A customer with no verified address ships as before: no **Address differs**, no extra line on the card.

## Print and pack

**Ready to ship** lists shipments whose label is bought, oldest first.

1. Click **Print pack** on a row. The label and the invoice print as two separate jobs. **Label** and **Invoice** open each one alone. An issued invoice whose PDF was never rendered is rendered then. A draft invoice is not printed: issue it in Invoicing first. If the render fails, open the invoice and use its retry action, then print again.
2. Select several rows and click **Print N packs** to get every label in one PDF and every invoice in another.
3. Tick the row as packed when the parcel is boxed. This fulfils the Shopify order with the tracking number and its carrier. Whether Shopify emails the customer is the Shopify app's **Shipping emails** setting (see [Shopify](store.md)).

The **Country** column, its **Country** sort and the **All countries** filter work as in To prepare.

**Tracking numbers.** Boxtal's own number is used when it gives one at purchase. A carrier that issues its number only at the first scan prints it on the label, so the app reads it there once the label exists: FedEx from the label text, UPS and DHL Express from the label text, or from the label image through the workspace's media analysis. A number read from a label is kept only when it has the carrier's format and check digit and the label shows the recipient's postcode. Ticking the row then fulfils the order with it; a number read from a label never fulfils an order by itself. When no number can be confirmed (media analysis off, no model key, no recipient postcode on file to check the read against, or the read did not pass the checks), the row says **Tracking to confirm** until the carrier's first scan brings the number. A read that fails for a passing reason (a timeout, a model or storage error) is tried again on the next pass, up to three times.

**Missing labels.** When a bought label still has no label document 15 minutes after purchase, the people who can ship (`boxtal:shipments:write`) get one attention item naming the orders. It is updated as labels arrive and clears itself once they all have. Labels bought more than 3 days ago are left out.

You can also attach the label to a ticket reply from the row.

### Print your own documents for a parcel

Each row also has **Print documents**: the organisation's document templates for shipments (a customs declaration, a certificate, a thank-you letter). Open it, tick the templates and click **Print**. A field the shipment does not hold prints as a grey blank for a person to fill.

The invoice, customer, address, carrier and lines come from the moment the label was bought, so a later change to the invoice does not change them. The tracking number is the row's current one, and stays blank until the carrier issues it. For FedEx it is labelled AWB. Labels bought before this existed print those fields as blanks.

When a document rule matches a parcel (by SKU, destination country or carrier), the row's **Paperwork** mark lists the templates it asks for, and **Print documents** opens with them ticked and marked **Needed**. Document rules are kept under the workspace's document templates.

## Follow shipments and returns

- **In transit**, **Delivered** and **All shipments** in the sidebar list shipments by state.
- **Returns** lists inbound return parcels, with **Download return label** and the number of the document each return is linked to (**Document**). Return labels are created by an agent with `create_shipment` and `is_return: true`, which waits for approval.
- **Packages & products** (the **Catalog**) shows **Product shipping profiles**, **Packs (compound)** and **Local products**. Agents edit them with `product_profile_upsert`, `pack_upsert`, `pack_delete` and `local_product_upsert`.

### Share one shipping profile between variants

A shipping profile (unit weight, carton dimensions, short code, content category) can serve several product variants, for example the retail and the wholesale variant of the same item. Each variant links to at most one profile, so a weight or a code is changed once for all of them.

- **Product shipping profiles** in the **Catalog** lists each profile with its **Variants**. A profile no variant uses shows **Unused** and a **Delete** button.
- **Variants without a shipping profile** lists the variants a prepared order found with no profile. **Link to existing profile** picks a profile for the variant.
- Linking does not recalculate orders already prepared: they keep their parcels until the next sync (**Pull orders**).
- Agents use `product_profile_link` and `product_profile_unlink` for one variant, `product_profile_merge` to fold duplicate profiles into one, and `product_profile_delete` for a profile no variant uses. A merge first shows which variants move and which fields differ; it is refused when fields differ unless the agent names the profile whose values win. A delete is refused while a variant still links to the profile.
- `product_profile_upsert` changes only the fields it is given. On a variant that shares its profile with others it is refused, naming those variants, unless the agent confirms the edit is for all of them.
- Moving a variant that already has a profile to another one is shown first: the fields that change, and the fact that the variant then goes into that profile's packs. It is applied only once confirmed.

### Short codes live on the product

A profile's short code is also saved on the SKU of every variant linked to it, in Liaison's product attributes, so other apps can show it (the Shopify **Orders** list sums up each cart with it). Changing a profile's code updates its SKUs at once. If that update waits for an approval or fails, the catalog row shows **Short code not synced yet**, drafts use the profile's new code meanwhile, and Boxtal retries every night. When two profiles linked to one SKU give it different codes, Boxtal writes neither and the row shows **Short code conflicts with another profile**. Every night Boxtal also fills in the codes the product attributes do not have yet and never overwrites one set elsewhere. When a draft is built, a variant's short code is read from the product attributes first; the profile's own code is used when the SKU has none or is not synced yet.

Profiles created before this existed are converted automatically, one profile per variant. Duplicates are not merged until you or an agent merges them.

### Settle an unfinished label purchase

A label purchase can be cut off after Boxtal took the order but before Liaison saved its id. After 15 minutes such a row shows in `stuck_list` as `create_orphan`, and the invoice cannot get another label while it is there. Liaison never buys, cancels or retries anything for it on its own.

Look the invoice up in the Boxtal dashboard, then settle the row with `settle_orphan_create`:

- **A label exists:** `outcome: "adopt"` with the Boxtal order id from the dashboard. Liaison reads that order back from Boxtal and links it to the row, which then tracks like any other shipment.
- **No label was bought:** `outcome: "release"`. The row is closed in Liaison only (it tells Boxtal nothing), leaves `stuck_list`, and the invoice can get a new label.

Release is refused when the row already holds a Boxtal order id. Both are refused on a row that is not an unfinished purchase. Anyone with `boxtal:shipments:write` can settle a row; an agent's call waits for approval. An unsettled row is logged once, then once a day.

A shipment is refused, not silently created, when a product has no shipping profile (`no_profile`), a parcel has no weight (`missing_weight`), or an export line lacks an HS code, origin or customs value.

The order prep list and the label use the same rule for which invoice lines are parcels, so a row shows ready only when its label can be bought. A line with no product link that is a shipping charge ("Shipping", "Frais de port", "Versandkosten" and the like), a shipping or software line, or a line with no quantity packs nothing and never blocks. Any other line with no product link is a product whose link is missing: the row shows **Unresolved pack** and the label is refused until it is resolved or the carton is set by hand. On an export, the customs declaration lists the same lines: a shipping charge is not declared as goods, and every product line is.

## Import products, packs and shipping profiles

An import (`POST /api/imports`, see [Settings](../admin/settings.md#undo-an-import)) can bring your shipping catalog from another tool. It needs `boxtal:catalog:write`.

- **Local products** (`boxtal.local-product`): a SKU and a label. A SKU that already exists is skipped.
- **Packs** (`boxtal.pack`): a name, dimensions, gross weight and the products inside, each named by SKU or Shopify product id. Local products are imported first, so a pack can name one from the same file. A pack whose products cannot all be found is not imported.
- **Shipping profiles** (`boxtal.shipping-profile`): the unit weight and shipping details of one product, imported as a profile of its own linked to that product. A product that already has a profile is skipped.

An import never changes a row that is already there. The run can be undone under **Settings › Organization › Imports**.

## Scopes

| Scope | What it allows |
| --- | --- |
| `boxtal:quotes:read` | Get carrier quotes |
| `boxtal:shipments:read` | Read shipments, drafts, queues and tracking |
| `boxtal:shipments:write` | Create, cancel and manage shipments and queue rows |
| `boxtal:documents:read` | Fetch labels and customs documents |
| `boxtal:catalog:read` | Read profiles, packs, products and shipping settings |
| `boxtal:catalog:write` | Edit profiles, packs, products and shipping settings |
| `boxtal:admin:connection` | Connect the Boxtal account |
| `boxtal:approve` | Decide shipping approvals, such as label purchases |
| `boxtal:internal` | Used by the app itself |

## What agents can do

Tools marked "Always" file an approval and nothing happens until a person approves it.

| Tool | What it does | Approval |
| --- | --- | --- |
| `quote`, `quote_batch` | Carrier quotes for one draft or route, or a whole batch of orders | No |
| `shipment_draft_create` | Start a shipment draft from an invoicing document | No |
| `shipment_draft_get` | Read a shipment draft | No |
| `shipment_draft_set_package`, `shipment_draft_set_customs` | Change a draft's cartons or a customs line | No |
| `create_shipment` | Buy the label for a draft (`is_return: true` for a prepaid return) | Always |
| `cancel_shipment` | Cancel a shipment not yet dispatched | Always |
| `claim_open` | Open a carrier claim on a lost or damaged parcel | Always |
| `settle_orphan_create` | Settle an unfinished label purchase: link the Boxtal order, or release it when no label was bought | Always |
| `track`, `get_shipment`, `get_documents` | Tracking, live status, labels and customs documents | No |
| `search`, `queue_counts`, `to_prepare_list`, `ready_list`, `returns_list`, `exceptions_list`, `stuck_list` | Find shipments and read the queues | No |
| `prep_list`, `prep_sync`, `prep_unlinked_list`, `prep_order_prefill`, `prep_document_pdf` | Read and refresh the To prepare queue | No |
| `prep_set_status`, `prep_set_category`, `prep_select_offer`, `prep_set_note`, `prep_exclude`, `prep_restore`, `prep_add_shipment` | Work queue rows. A row given by `document_ref` must name an existing invoicing document (id or number), else the call is refused as `document_not_found` | No |
| `prep_set_address_choice` | Pick the order's address or the verified one when they differ | Always for an agent |
| `ready_set_packed` | Tick a parcel packed, which fulfils the Shopify order | No |
| `print_pack`, `print_pack_batch` | Prepare print documents | No |
| `print_record_get` | Read a shipment as the data its document templates fill | No |
| `import_shipments`, `import_label_document` | Import existing Boxtal orders and labels | No |
| `attention_rules_list`, `attention_rule_upsert`, `attention_rule_delete` | Rules that flag shipments needing extra paperwork | No |
| `list_content_categories` | Boxtal customs content categories | No |
| `packages_list`, `product_profile_upsert`, `product_profile_link`, `product_profile_unlink`, `product_profile_merge`, `product_profile_delete`, `pack_upsert`, `pack_delete`, `local_product_upsert` | Read and edit the shipping catalog | No |
| `settings_sender_address_get` | Read the ship-from address | No |
| `settings_sender_address_set` | Set the ship-from address | Always |
| `settings_carrier_allowlist_get`, `settings_carrier_allowlist_set` | Carriers used in routine quoting | No |
| `settings_label_format_get`, `settings_label_format_set` | Default label format | No |
| `settings_product_codes_get`, `settings_product_codes_set` | Short product codes in the To prepare grid | No |
| `settings_packaging_policy_get`, `settings_packaging_policy_set` | How leftover items are boxed, nominal proforma value | No |
| `webhooks_repair` | Re-register the Boxtal webhooks | No |

`prep_sync` also copies an order's ship-to onto the recipient's contact, under its shipping address, when the contact has none (or lacks its state, phone or email). It never overwrites a filled field. This is the app's own write, so it runs without the approval an agent's contact edit waits for.

When Boxtal refuses a row's quote or returns no offer, the row has no estimate and says why, for example "Quote failed: no offers returned". `prep_sync` lists the failed rows (how many, and the first three with their reason) in its result.

`settings_sender_form_get`, `settings_form_get` and `settings_form_set` back the settings page and are not offered to agents.

Related: [Invoicing](invoicing.md), [Store](store.md), [Approve what agents do](../agents/approvals.md), [Agent tools](../reference/agent-tools.md), [App settings](../reference/app-settings.md).
