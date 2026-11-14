---
title: Issue invoices and quotes
description: "Set up issuer profiles, issue quotes, proformas and purchase orders, invoice paid Shopify orders automatically, and see which agent tools wait for approval."
screenshot: "assets/screens/invoicing.webp"
screenshotAlt: "The Invoicing documents list with invoices, quotes, proformas and credit notes, their status and payment state, and filters above the table."
---

The Invoicing app issues invoices, quotes, proformas, purchase orders and credit notes with gap-free numbering, a PDF for each document, and a tax treatment worked out from the customer's country. This page shows how to set it up, issue documents by hand, and let paid Shopify orders invoice themselves.

## Create an issuer profile

An issuer profile is the legal entity your documents are issued from. Nothing can be issued until one exists.

1. Open **Settings › Invoicing › Issuer profiles**, or click **Invoicing settings** at the foot of the Invoicing side panel (shown to people who may read the settings).
2. Click **+ New issuer profile**.
3. Fill in **Legal name**, **Country** and **Default currency** (required), and optionally **VAT ID**, **IBAN** and **Default language** (`en`, `fr` or `de`).
4. Turn **Prices include tax** on if the prices you type include tax. Match your Shopify tax setting when the profile is mapped to a shop.
5. Click **Save**. To add a logo, save the profile first, then upload the logo.

Reading profiles needs `invoicing:settings:read` and editing their ordinary fields needs `invoicing:settings:write`. Changing a bank or control field (`iban`, `swift_bic`, `bank_name`, the approval thresholds, `require_two_eyes`, `auto_email_enabled`, `mail_account_id`) or deleting a profile also needs `invoicing:issuer:admin`. Only the admin role holds that scope by default. A profile still referenced by documents cannot be deleted.

A document's issue date and its number year are the date in the issuer's time zone when its number is taken. Set the zone in **Time zone** on the profile, for example `Europe/Paris`; an unknown name is refused. A profile with no zone chosen follows the organization's time zone, or UTC when the organization has none, and the profile list shows **Not chosen** until someone picks one. To keep UTC on purpose, type `UTC`. An agent reads the same reminder from `einvoicing_readiness` and sets the zone with `settings_issuer_profile_update`.

The first time a document is issued on a profile with no zone chosen, in an organization that has none either, Home shows one line to people who can edit settings: the profile has no time zone and dates follow UTC until one is set. Issuing is not blocked and nothing issued changes. Setting a zone, or typing `UTC` to keep it, clears the line, and it is never raised again for that profile. A profile that already has issued documents is not asked.

A line is one of four kinds: goods, software, service or shipping. A service line (consulting, a retainer) counts as a service in the operation type of an e-invoice and in the legal mention, as a software line does; it is never customs goods. A document issued before the service kind existed reads exactly as it did.

A credit note can state an earlier date. The date decides the number's year: a date in a past year takes that year's series, never this year's number. A date before the last number of that series is refused, and so is a date after today. A payment date nobody states, from **Mark paid** or from a Shopify order, is read in the same time zone. A credit note that names its invoice cannot be dated before it, and moving either date later cannot put the credit note first. An imported document keeps the date it came with.

A document's number is taken in the same step that saves the document, its lines and anything that goes with it (the draft it replaces, the "credited" entry on the invoice a credit note reverses). If that step fails, nothing is saved and the number is not used, so the series has no gap and no number twice, even when several documents are issued at once. If the issue stops after that step (a restart, for example), the document stays numbered and its PDF is made later: a job finds a document still waiting for its PDF after ten minutes and has `deferred-retry` render it and, for a paid Shopify order, send the invoice email the issue owed. An automatic credit note for a Shopify refund or cancellation is never issued twice for the same invoice, even when the event arrives again. The same holds for a paid order's invoice: when the order event arrives twice at once, one invoice is issued per order and scope, and the other run issues nothing and uses no number.

If the issuer's zone is not one the host knows, nothing is numbered. A paid order or a Shopify draft order waits in `deferred_list` with what it needs, and its invoice or quote is made once the zone is fixed. A draft order deleted or completed meanwhile closes its wait.

You can also create issuer profiles from a config file with [`liaison config apply`](../reference/config.md), including the Shopify shop mapping, approval threshold and auto-email that the form does not show.

An agent can propose an issuer profile too. Its approval card lists every legal identity field the profile sets: legal form, address, SIREN, SIRET, VAT number, IBAN. The agent takes these from you. A SIREN, SIRET, VAT number, IBAN, BIC or tax id that is in no message you wrote and no file you attached in the conversation is refused, whichever tool the agent uses, and so is a SIREN or SIRET whose checksum fails: the agent then asks you to type the right one. A VAT number computed from a SIREN you gave counts as given. Spaces, dots and dashes in a SIREN or SIRET are ignored. The address and legal form are not checked: read them on the card. An invoice import into a workspace with no issuer profile is refused until one exists.

## Invoice paid Shopify orders automatically

Invoicing issues the invoice of a Shopify order as soon as the order is paid. You do not need a routine for this: it is configuration on the issuer profile.

1. Connect your shop in the [Store app](store.md).
2. Map the shop to an issuer profile. In a config file, set `shopifyShop: auto` on the issuer profile (it uses the shop domain of your active Shopify connection) and run `liaison config apply`.
3. Set `invoiceApprovalThresholdMinor` on the profile. A paid order over the threshold waits for approval; one under it issues straight away.
4. Set `autoEmail: true` if the invoice should be emailed to the customer when it issues.

**Settings › Invoicing › Shopify shop mappings** lists each **Shop URL** with its **Issuer profile**. Without a mapping, paid orders are parked and no invoice issues.

When an order cannot be invoiced automatically, it appears under **Deferred** in the Invoicing sidebar (the row shows only when something is waiting). An order whose tax needs a decision offers **Issue with Shopify's tax** and **Issue as computed**. Both file an approval.

A retried order reads the Shopify order as it is now: a VAT number added as a custom attribute named `VAT number`, or a billing company, after the order was parked is used, and a customer with a VAT number is invoiced under the billing company's name.

An order to a customer in another EU country that Shopify charged no VAT (tax exempt, or 0%) and that carries no VAT number is not invoiced: it would be neither a reverse charge nor a consumer invoice. It waits under **Deferred** for a tax decision. For a business, add its VAT number to the Shopify order (custom attribute `VAT number`), then choose **Issue with Shopify's tax**: the invoice is a reverse charge. For a consumer, **Issue as computed** charges the VAT of the customer's country.

## Create a quote, proforma or purchase order

Only quotes, proformas and purchase orders are started by hand. Invoices come from paid orders or from converting a quote or proforma.

1. Open **Invoicing** and click **+ New quote** in the sidebar. Use the arrow next to it to pick **New proforma** or **New purchase order** instead. The button is shown to people who hold `invoicing:documents:write`.
2. Pick the **Issuer**, then the **Issue date** and **Due date**. A date you pick decides the year of the document's number: a date in a past year takes that year's series. A date after today is refused. A quote from an issuer mapped to a Shopify shop takes the day its draft order is created, so another date is refused there. A date that would be refused says why under the field, before you click.
3. Optionally, search a contact in **Contact** and pick it: the document is linked to that contact, which shows by its name, and an empty customer name and email are filled from it. **Unlink** removes the link.
4. Fill in **Customer name**, **Customer email**, **Customer VAT ID**, **Customer country** and **Customer address**. Add a **Shipping address (if different)** when the parcel goes elsewhere.
5. Click **+ Add line** for each line.
6. Click **Preview PDF** in the bar at the top of the editor to check it, then **Create quote** (or **Issue proforma**, **Issue purchase order**). The **+ email** variant also emails it to the customer.

A purchase order here is one you send to a supplier. A customer's own purchase order number goes in the `po_number` field of their quote or invoice.

### Quotes and Shopify draft orders

When the issuer profile is mapped to a Shopify shop, a quote and a Shopify draft order are the same object. Creating a quote creates the draft order in Shopify, and a draft order created in Shopify creates the quote. Editing the draft order in Shopify updates a quote that is still `sent`. Deleting it rejects the quote. Without a mapping, the quote stays local.

A draft order or order placed for a Shopify B2B company is addressed to the company: its name, its location's billing address (else its shipping address) and its location's tax registration number as the VAT number. Each draft order and order splits net and tax by its own Shopify setting, so a net B2B catalog price gets VAT added while a retail price that includes VAT is divided out. **Prices include tax** on the issuer profile applies only when Shopify gives no setting. A tax-exempt company location is charged no VAT. A catalog price or a price override shows as the unit price, with no discount.

### Customers in another EU country

For an issuer in the EU, a customer in another EU country is either a business or a consumer. A business gives its VAT number: the document charges no VAT (reverse charge). A consumer has none: the document charges the VAT of the customer's country, at that country's standard rate (for example 22% for Italy).

- A VAT number you enter is checked with the EU VIES service. A number VIES rejects is refused. When VIES cannot be reached, the document is still issued and its approval card says the number is not verified.
- An agent that leaves the VAT number empty is refused when your own data says the customer is a business: an earlier document for the same contact, email or address that has a VAT number or no VAT, or was issued to a company; a Shopify order or customer tagged B2B, tax exempt, bought by a company or charged no VAT; or a company legal form in the customer's name. Any match counts, even one on the street alone. Addresses are compared by house number, street and postcode, however they are written (a name in front, lines or commas, with or without the country). Shopify is searched by the customer's email, by the order numbers on matching earlier documents, by name and by postcode and street, so a customer who never gave an email is found too. The refusal names that evidence, the company on the earlier documents as the likely legal entity, and where to look for the number: VIES (`vat_validate`), the company register or the customer's website legal notice.
- The refusal names the exact next call: `vat_lookup` with the likely company name, the country, and the city and postcode of the customer's address. The company name comes from your own data: an earlier document of this customer, including the invoice of a Shopify order that matched the customer by name. When no company is on record, the refusal tells the agent to ask you for the company's legal name, never to use the person's name.
- `vat_lookup` searches the web for the company (at most 2 searches), reads the VAT numbers of that country's format off the results, checks each one with VIES (at most 6) and drops the ones VIES rejects. A number is a strong match when the name VIES holds contains every word of the company name given and its VIES address is in the city, postcode or street given. A company that only shares one word with a person's name (a customer "Elio Fabbro Rocca", a company "FABBRO SRL") is never a strong match. When the organization has no web search, `vat_lookup` says so and looks nothing up.
- Even a strong match only says that VIES knows the company. The agent uses a VAT number it found only once something ties that company to this customer: the same company name on an earlier document or order of the customer, the customer's email domain, the company named in the customer's own mail or signature, or a VAT number already on file. Without such a link it asks you for the VAT number. It shows weaker matches to you and asks which one is right.
- When Shopify cannot be searched (an error or no answer within a few seconds) and nothing else shows a business, the approval card says the business status is not verified and a person decides.
- A VAT number is filled in only from a sure match: an earlier document for the same contact, or for the same street, postcode and city under a similar name, or the company tax id of the customer's Shopify orders. The card says where it came from. A number found on a weaker match (the same email or street only) is offered in the refusal, never filled in.
- When VIES registers the number to a name unlike the customer's, the card shows both names and flags the mismatch.
- If the customer really is a consumer, the agent says so (`buyer_is_consumer`). That is refused when a VAT number is on record for the customer. Against any other business evidence, every tool, drafts, edits and quotes below the approval threshold included, waits for a person, whatever auto-approve policy the org set: the approval card says the agent declared a private consumer and lists the evidence. A draft that waits for another reason, such as what the conversation read, gets a card saying what the call does: it names a private consumer only when the call declares one.

The approval card of a new document states its tax treatment and rate, whether the prices were typed with VAT included (**Prices include tax** on the issuer profile) or net, and the net, VAT and total that will be issued.

A credit note's card states its total, its lines, its issue date and the invoice it reverses, with that invoice's date. With no stated date it says the note takes the day it is approved. Whatever parks the request, the card says the same.

A credit note's total must be negative: a positive one, or one of nothing, is refused before anything parks and takes no number. A positive line against a larger negative one is fine (a restocking fee against a return). A zero credit note is accepted only against an invoice whose own total is zero.

An amount in minor units is a whole number: 41940 for 419.40. Anything else, such as `899.00` or `-1260.50`, is refused before anything parks, and the refusal says what to send. It is never read as a guess. A card that still meets such an amount says the request will be refused and prints no total.

## Turn a quote or proforma into an invoice

1. Open the quote (once it is sent or accepted) or the proforma (once it is sent).
2. Click **Convert to invoice** and confirm.

For a quote linked to a Shopify draft order, this completes the draft order in Shopify with payment pending. Shopify creates the order and the invoice is issued from it moments later. Do not issue a second invoice by hand. Any other quote or proforma converts here in one step: if it fails, the quote is left as it was and no number is used.

## Work with an issued document

Open a document from **Documents** in the sidebar (**All**, **Invoices**, **Quotes**, **Proformas**, **Purchase Orders**, **Credit notes**). The list footer counts the rows with the right noun ("1 invoice", "2 invoices"). An empty list names the dates it looked at ("No documents from 1 Oct 2026 to 31 Oct 2026."), or says "No documents yet." when no date or filter is set. The buttons at the top of a document, next to its number and status, offer:

| Button | What it does |
| --- | --- |
| **Edit** | Edit the document. Saving re-renders its PDF. |
| **Mark paid** | Record full payment. Not shown on credit notes, nor on an invoice Stripe collects: that one shows **Collected by Stripe** with its Stripe invoice, which opens the Stripe customer. |
| **Send to customer** | Email the PDF to the customer. |
| **Convert to invoice** | Quotes and proformas only, see above. |
| **Preview PDF** / **Download PDF** | Open or download the rendered PDF. When it is not ready, they say so. |

The **PDF** tab shows the document in the page, in browsers with a PDF viewer. A browser with none, such as most phones, says so and leaves **Preview** and **Download**.

Issued documents are never deleted. A correction is a credit note, with its own `CN-` number series. The date of an issued document stays in its number's year: a date in another year is refused, and the correction is a credit note and a new invoice (for a quote, proforma or purchase order, a new one). The date of an issued invoice or credit note also stays between the numbers just before and just after it, and is never after today. A refund or cancellation taken in Shopify issues the matching credit note automatically.

**Pending Approval** in the sidebar lists the invoicing approvals waiting for a decision. Deciding them needs `invoicing:approve`; the row is shown to people who hold it or `invoicing:documents:write`. See [Approve what agents do](../agents/approvals.md).

## Handle e-invoicing

**Settings › Invoicing › E-invoicing** (needs `invoicing:settings:write`) holds the **E-invoicing platform** (an installed app such as [Pennylane](pennylane.md)), the **Cut-over date** (invoices issued from that date are sent and booked), and the **Send e-invoices** and **Book reported sales** switches. Their settings keys are `provider_app`, `cutover_date`, `send_enabled` and `book_enabled`; the `einvoicing_settings_set` tool takes the same names.

- **E-invoicing readiness** in the sidebar lists what still blocks e-invoicing, per customer and document. A customer shows under the name of its contact (read as you), or the name stored on its documents when the contact cannot be read. It is shown to people who hold `invoicing:documents:write`.
- **Received** in the sidebar lists supplier e-invoices received through the platform. Refusing or disputing one goes through an approval.
- An e-invoice in another currency than the euro also states its VAT in euros, at the European Central Bank reference rate, fetched when the invoice is issued (once per currency and day). If the ECB cannot be reached and no rate from the last 7 days is stored, the invoice is not issued and uses no number: issue it again a few minutes later. A paid Shopify order waits in **Deferred** and is retried by itself.
- An approved e-invoice is deposited at the platform once, even when the server restarts in the middle of the send: the deposit is claimed before it is made, and a run that cannot tell whether an earlier one reached the platform asks the platform first and keeps the invoice it already holds.
- **Month-end runs.** Approving a run's card also approves its e-invoice sends: each row's invoice is sent once it is issued, with no card of its own. A send goes only for the invoice its row names; if the row changed, nothing is sent and the send is asked for again.
- **Daily send card.** An e-invoice issued with no person (a run whose schedules all issue by themselves) waits, and once a day one card lists every such invoice and the oldest wait. Approving it sends them. A rejected or expired card keeps them for the next day's card. An invoice waiting more than two days raises one Home line for people who hold `invoicing:settings:write`.
- **Standing authorization.** A person can let the card-subscription stream or the recurring-by-transfer stream send its e-invoices issued with no person at issue, with no daily card: `issuer_stream_set` with `stream` and `einvoiceStanding: true`. It is off on every stream until then, an agent's call waits for a person, and it records who turned it on and when. It lasts 90 days: a renewal card goes to the person who turned it on a week before the end, and if it is not renewed the stream goes back to the daily card, said once on Home. `einvoice_standing_off` turns it off at once. A send goes only for an invoice of that stream. In **Settings, Invoicing, Issuer profiles**, under **Who issues what**, each stream shows whether it is on, who turned it on, when and until when. **Turn on** asks you to confirm what it does, and your confirm is the decision; an agent's call waits for a person instead. With no e-invoicing platform chosen, the section says to choose one first and offers no **Turn on**. **Turn off** counts down 8 seconds before it runs, and **Undo** inside those seconds changes nothing.
- **Collections.** Where VAT is due on receipt (a domestic sale, not on the debits option), marking an invoice paid, a refund and a Stripe payment report the amounts by VAT rate to the platform, once per payment. The debits option, reverse charge and sales out of French VAT report nothing ("Not needed"). A platform that does not take collections shows "To report at your platform" and one Home line, "Enter this collection at your platform".
- **Status on an invoice.** An issued invoice shows one e-invoice status: **Waiting for payment**, **Collected** (only once the platform accepted the collection report), **Partly collected**, **Not needed**, **Refused by the buyer**, **Not sent** or **To report at your platform**. An invoice from a Stripe payment or a schedule also shows **Issued by Liaison**, and a card payment through Stripe that is in shows **Collected by Stripe**.
- **Refusals.** A buyer refusing an e-invoice on their platform opens a Home item; no invoice or credit note is made by itself.
- **Payment reminders.** A payment reminder about an invoice that is paid, credited or voided by the time it would leave is not sent.
- When the organization is deleted, its issued invoices and credit notes (with their lines and PDFs) and its e-invoicing transmission records go into the encrypted legal archive; drafts, quotes and proformas do not ([Delete an organization](../admin/backups.md#delete-an-organization)).

## Import past documents

Invoices, credit notes and proformas issued in another tool can be imported with their original numbers, dates, totals and PDFs: with `liaison invoicing import` (see [Config as code](../provisioning-cli.md)) or as **Invoicing documents** (`invoicing.document`) records. The import needs `invoicing:documents:write`.

- Each document keeps its number. Numbering then continues after the highest imported number for that issuer, type and year, so a new document never reuses one.
- A credit note is linked to its original invoice when that invoice was imported too. It keeps the sign its source states.
- With several issuer profiles, each record names its issuer profile. With none, or several and none named, the record fails with `issuer_ambiguous`. A preview of the import runs the same checks, so it already counts these refusals before anyone approves the run.
- A document imported before is skipped. A document whose number the issuer already used, or that an earlier document of the same import uses (in any batch of it, in a preview too), fails with `numberTaken`, and so does one whose number and number_int disagree or whose status contradicts its payment.
- An imported document keeps its PDF as its original: marking it paid or editing it never renders a new one.
- The import does not record legal originals. Once you have checked the imported documents, run `einvoicing_backfill_legacy_originals` to record them from the PDFs.
- Until then, the run can be undone under **Settings › Organization › Imports**. A document that changed since, for example once its legal original is recorded, is kept.

## Recurring invoice schedules

The task-first guide is [Recurring invoices](recurring.md). This section is the reference.

A schedule bills one customer on a fixed cadence: every month, quarter or year, on the last day of the period, on a day from 1 to 28, or on a given date for a year. It names the issuer profile, the customer and the lines. A line may hold `{period}`, filled in with the period it bills. Prices are in minor units and the VAT rate is in basis points (2000 is 20%). A schedule shows on its customer's **Activity** timeline, with its cadence and its amount before VAT.

- **Dates.** An invoice issues on its billing day, and the draft is made three days before it. A draft day that falls on a Saturday or Sunday moves back to the Friday; no holiday calendar is held, so a public holiday does not move it. The billing day itself never moves, even on a Saturday. A day past the end of the month, such as 30 February, is that month's last day. All dates are the issuer's civil dates, in the time zone set on its profile.
- **Starting one.** `recurring_schedule_create` saves a schedule and starts it, or saves it as a draft that bills nothing yet. It refuses a missing customer, billing day or line and says which. A schedule created this way always issues for review: **issue by itself** is off, and only `recurring_schedule_update` turns it on.
- **Approval.** When an agent asks to save or change a schedule, it files an approval and nothing is saved until a person approves it. Turning **issue by itself** on is never approved by an organization's auto-approve policy, and the schedule records who turned it on and when. When a person saves a schedule in the editor, it is saved at once.
- **Pausing.** `recurring_schedule_pause` stops the schedule: nothing is drafted while it is paused. With `until`, it resumes on that date and the days inside the pause are not billed afterwards. Pausing a paused schedule changes nothing. A pause asked for by an agent that has read outside text (a customer's email, for example) waits for a person.
- **Ending.** `recurring_schedule_update` with `status` set to `ended` stops billing for good. A schedule whose end date falls before a period creates nothing for it.
- **Reading.** `recurring_list` shows the schedules with their next issue day and draft day. Reading and saving need `invoicing:documents:read` and `invoicing:documents:write`; reading the issuer's time zone needs `invoicing:settings:read`, and a member without it is told the issuer cannot be read.
- **Importing.** Schedules from another tool can be imported as **Recurring invoice schedules** (`recurring-schedule`) records. They arrive as drafts that bill nothing until a person starts them.

### Work with schedules in the app

- **Recurring, Schedules** in the sidebar lists the schedules soonest first, with how many active schedules bill. Its first line says when the next drafts come and when they issue, for example "Soonest first. Next: 7 drafts on Fri 27 Nov, to issue on Mon 30 Nov." Filter **All**, **Active** or **Paused**. A schedule for a customer who also pays a Stripe subscription shows what it bills instead in its **Bills** column.
- **New schedule** opens the editor in a tab. **Pause**, **Preview next invoice** and **Start** (or **Save** for an existing schedule) sit at the top. **Start** stays off until the schedule has an issuer, a customer and a valid line. With **Card link** as **Paid by**, give the link's https address. The side column shows the totals, the next invoices with their draft days, and how the number is taken: no number shows before an invoice issues.
- When the customer already pays a live Stripe subscription, saving opens a panel with **Open their subscription**, **Pick another customer** and **Bill something else**. **Bill something else** asks "What does this schedule bill instead?" (at least 5 characters); **Start** stays off until it is answered.
- A month-end run opens in its own tab (`/invoicing/run/<id>`). Before it issues, it says where it stands (drafted and waiting for approval, approved and not issued yet, past its last day), lists the drafts it will issue with no number, and says nothing is billed yet. Once issued: when it issued, who approved it (on the issuer's day), the period and the number range. "None missing" shows only when the run's numbers follow each other in one series. Each invoice shows its e-invoice status. A partial run lists the rows that could not issue, each with **Fix**, which opens its draft. **Download all** saves each invoice's PDF.

## The month-end run

Each schedule's invoice for a period is made by the **month-end run** of its issuer and issue day, in four steps. No model is asked anything along the way.

- **Drafted.** On a schedule's draft day (in the issuer's time zone), an hourly job makes one unnumbered draft for the period from the schedule alone: its lines, prices, rates and terms, with `{period}` filled. Each draft joins the run as one row, with flags taken from the data ("First invoice", "Same as October", "Changed since October", "October is still unpaid"). A row that bills five times its schedule's last invoice or more, or a fifth of it or less, also reads "Check the amount: October was 149.00 EUR excl.", on the row, on the card and in what the agent reads of the run, and the flag follows each edit of the row. It stays on the card: the approver decides. A first invoice has nothing to compare with and gets no such flag. Running the job twice, or twice at the same time, adds nothing: the draft, the row and the run each have a unique key. A draft and its lines are written in one transaction, so a job stopped halfway leaves no draft and the next hour writes it whole. A draft found already written whose lines differ from its schedule gets the row **needs fix** ("Lines differ from the schedule") and never issues by itself. The draft bills the customer of the schedule's last invoice; for a first invoice, it bills the schedule's company when it names one (the company's name, the contact's billing address and the VAT number recorded for the contact), else the contact's name and email.
- **Approved.** The run gets one card listing every row, its total and its account manager. The card is for the rows' account manager when they all have the same one. Approving it records each row as approved; **no number is taken at approval**. To change a row, change its draft (`drafts_update`, `drafts_create`, `drafts_discard`): the card follows. A run draft is never issued, edited in place or deleted around its run: `invoice_issue`, `documents_update` and `drafts_discard` refuse it and name the run. `recurring_run_unapprove` undoes an approval until the first number is taken, keeping every edit.
- **Issued.** From 08:00 on the issue day, and only until the run's last issue day, the rows issue in order, each in its own transaction, at most 25 every five minutes: a large run takes several passes and stays **issuing** until done. A row that fails stays an unnumbered draft and uses no number; the others keep consecutive numbers and the run ends **partial**, with one attention item naming the draft. A row whose draft changed after approval is not issued and waits for a new approval. Two passes, or a pass and a person, never issue a row twice. Only the run's own job issues a row: no person, agent, API or MCP client can call `recurring_item_issue`. A one-off invoice issued meanwhile simply takes the next number.
- **Late.** Three days before the run's last issue day (the billing month's last day), its attention item rises; on the day it says it ends today; after it, the run is **late** and nothing issues by itself: a person decides. A rejected card keeps the drafts and asks again on the issue day, or the next working day.

When the organisation reaches its daily app limit, the run's jobs wait for the next day, and one attention item says until when ("Month-end invoicing is held until ...") instead of the run going quiet. A run whose last issue day passes during the hold is late the next day.

A run where every row comes from a schedule set to **issue by itself**, and none is above the issuer's approval threshold, issues with no card.

`recurring_run_get` shows a run: its state, issue and last days, and each row with its draft id, amounts, account manager, latest change and flags.

### Change the run from its card

The run's card on Home shows every row under its summary, with the line **Drafts, no legal numbers yet. Everything here can still change: click a row to open it.** At the top it counts the invoices to approve and their total; a row that waits for a fix says, before any row, that it stays a draft, uses no number and comes back to you once fixed.

- **Open a row.** A click opens the row where it is, with the document editor's own fields: customer, notes, due date and lines. The row's amounts, the total and the count change as you type, and the row says **Not saved yet**. **Save for November only** or **Save from now on** saves it (an added row has one **Save**); **Cancel** puts the saved amounts back. **Open the full editor** opens the draft in its own tab.
- **Take out.** **Take out of November** leaves the row out this month only; **End the schedule** with **Last month billed** stops the schedule. A taken-out row has **Put back**.
- **Add an invoice someone forgot.** Lists the active schedules whose customer has no row in the run; picking one adds its invoice for the run's period. A customer with no schedule is added with one line (what it bills, quantity, unit price excl. VAT). The run refuses a second row with the same customer and lines, and the card says why.
- **Fix an address.** A row held for a missing billing address has **Fix**, which takes the address in place. When an agent found one, the row shows it with **Use it**. Either saves the address on this month's draft.
- **Ask.** Each row names its account manager, or **None**. **Ask** puts a mention of that person and the row's customer in the run's discussion, for you to finish and send.
- **Rights.** People with `invoicing:documents:write` change rows. Without it, a row opens read-only. Without the right to decide, the card says someone who can approve invoices decides it. Everyone who can decide has **Approve N** (with the total) at the top of the panel. The card names the period, the customers and the total, and a card the run's job drafted reads as the job's, never as a person's request.
- **A long run.** Above 20 rows, rows with nothing to look at fold under one line ("280 same as October"); they still count in the total. Search finds any row by customer.
- **A run that changed.** When a row changes while you have the card open, the card lists what changed, who changed it, and the total you saw against the total now, and offers **Approve N** on what is there now.

### The month-end check routine

The **month-end-check** routine template runs when a month-end run is drafted. It reads the run with `recurring_run_get` and what other records say about its customers (deals, Stripe subscriptions, payments and earlier invoices, where those apps are installed), and says in at most two sentences what may be worth a look, naming what it read. It holds read scopes only, so it never changes a row, and the card is complete without it. It is off until someone turns it on from **Routines**.

## Who issues what

When Stripe is connected, each issuer profile sells in three streams, and each stream has exactly one issuer. **Settings, Invoicing, Issuer profiles** shows them under **Who issues what**:

| Stream | Who invoices |
| --- | --- |
| **Subscriptions paid by card** (only while Stripe is connected) | Your choice: **Liaison** (a legal invoice from Liaison for each charge, in your series) or **Stripe** (Stripe's invoice is the legal one, Liaison keeps a copy) |
| **Recurring by transfer** | Always Liaison: not billed from Stripe |
| **One-off invoices** | Always Liaison: not billed from Stripe |

- **Deciding.** When Stripe connects, each issuer profile gets a card asking who invoices its card subscriptions. A French profile (country FR, or a VAT number starting with FR) has Liaison pre-selected, with the reason; another profile has nothing selected. Until a person decides, the stream is **Not decided yet**. The choice (`issuer_stream_set`, `invoicing:settings:write`) always waits for a person: no auto-approve policy decides it.
- **Switching.** A change applies to Stripe invoices finalized after you confirm it. Invoices issued before keep their issuer and their numbers, and if some of them are unpaid an attention item says so. Check a change with your accountant.
- **Stripe's own emails.** Stripe can email customers its own invoices, credit notes and receipts, and Liaison cannot read that setting. The section asks you to turn them off in Stripe (Settings, Billing) until a person clicks **I checked, they are off**; the date is kept. An agent cannot say it for you: its request waits for a person.
- **One customer, one issuer.** A customer who pays a live Stripe subscription is not invoiced again by hand. `invoice_issue`, `invoice_create_and_issue`, `drafts_create` (invoices), `drafts_update` (when the customer changes), `recurring_schedule_create` and `recurring_schedule_update` refuse with `subscription_stream_conflict`, and a month-end row for such a customer shows **Billed by Stripe** and is not issued, including a schedule made before Stripe was connected. Stripe customers not yet linked to a contact are found by email. When the invoice bills something else, a person says what in `billsOtherThanStripe` (at least 5 characters); an agent's statement waits for a person.
- **While Stripe cannot answer.** Until Stripe's customers and subscriptions are fully imported, or while its key is refused or cannot read them, the same calls refuse with `subscription_check_unavailable`: try again later. Liaison asks Stripe whether it is connected rather than trusting its own record, so a missed connection is caught at the next invoice. When Stripe says it is not connected, or the Stripe app is off, nothing is refused. Shopify orders, credit notes and quotes are never checked.

### Card payments when Liaison issues them

When **Subscriptions paid by card** is issued by **Liaison**, each Stripe invoice becomes one Liaison invoice, on its own:

- **Finalized.** One invoice per Stripe invoice, in your series, with Stripe's lines, the period in each line's description and the tax Stripe charged. It is dated, and numbered, on the day it is issued in the issuer's time zone, never on Stripe's finalization date, and it is due that day. A second delivery of the same event makes nothing more. A total of zero makes no invoice; a negative total waits for a person.
- **Waits instead of guessing.** A missing email or address, a tax that differs from Liaison's by more than 1 cent on a line, or an e-invoicing identity that is not complete keeps the invoice in **Waiting** with the reason, and no number is taken. Above the issuer's approval threshold, a person approves it first.
- **Paid.** The invoice is marked paid on the day of the card payment and its PDF shows the amount paid. A failed payment never changes the invoice; you are told only when Stripe will not try again or the card has expired. A Stripe invoice voided or marked uncollectible is reported and changes nothing.
- **Refunds.** Each refund that Stripe confirms becomes one credit note (CN- series) citing the invoice, split over the invoice's VAT rates (89.40 at 20% is 74.50 plus 14.90 VAT); a cent left over by the split goes on one **Rounding adjustment** line, so the credit note equals the refund. A pending refund waits, a failed one makes none and is reported. A refund made directly in Stripe gets the same credit note. When Stripe issues the invoices, no credit note is made.
- **A payment with no invoice** waits in the queue with an attention item. A person creates its invoice (`invoice_from_stripe_payment`, which takes the next number) or links it to an invoice already issued (`payment_link_to_invoice`, once). Both always wait for a person: no auto-approve policy runs them.
- **Before a decision.** Stripe invoices finalized while nobody had decided who issues stay waiting; once a person picks Liaison, an attention item lists them, and each is issued only on a person's click.
- **Missed events.** Every 10 minutes Liaison asks Stripe what an event may have missed (invoicing turned off, an event that failed) and hands it to the same steps: the missing invoice, a payment, a credit note. It never issues anything by itself beyond that.


## Settings

| Section | Who can edit | What it holds |
| --- | --- | --- |
| **Issuer profiles** | `invoicing:settings:read` to open | Legal entities, bank details, logo, numbering |
| **Shopify shop mappings** | `invoicing:settings:read` | Which issuer profile invoices each shop |
| **Tax regimes** | `invoicing:settings:read` | Overrides of the built-in tax treatments |
| **HS code library** | `invoicing:settings:read` | Customs codes and descriptions |
| **E-invoicing** | `invoicing:settings:write` | Platform, cut-over date, send and booking switches |

## Scopes

| Scope | What it allows |
| --- | --- |
| `invoicing:documents:read` | Search, read and download documents |
| `invoicing:documents:write` | Create, issue, edit and send documents |
| `invoicing:settings:read` | Read issuer profiles, mappings, tax regimes and HS codes |
| `invoicing:settings:write` | Edit issuer profiles, the HS code library and e-invoicing settings |
| `invoicing:issuer:admin` | Change bank and control fields, delete issuer profiles |
| `invoicing:contacts:read` | Read customer and vendor classification, check VAT numbers |
| `invoicing:contacts:write` | Set classification and e-invoicing identity |
| `invoicing:received:read` | Read received supplier e-invoices |
| `invoicing:received:write` | Refresh and act on received supplier e-invoices |
| `invoicing:approve` | Decide invoicing approvals |
| `invoicing:internal` | Used by the app itself |

## Find a customer's earlier sales

- An agent's document search matches the words of the query, in any case and order, in the document number, the customer's name, address and email (billing and shipping), the Shopify order, the PO number, the notes and the line descriptions. A person named only in the address of a company's invoice is found by their name. Exact numbers and whole-word name matches come first, partial-word matches last.
- A search by contact also returns the documents made out to the contact's email or to one of its addresses, not only the ones linked to it.
- `customer_history` answers "the same price as last time": it returns the customer's invoices, proformas and quotes with each line's list unit price and the price paid per unit after the line's discount (both before VAT), the latest sale of the product asked at the price paid, and the customer's Shopify orders found by name, email or order number.
- A search that finds nothing tells the agent to try `customer_history` or the Shopify order search with the customer's name.
- The global search finds a document by its address, email, order number and line descriptions too.

## What agents can do

"Always" means the call files an approval and nothing happens until a person approves it. "Threshold" means it waits for approval when the amount is over the issuer profile's threshold (an unset threshold means always).

| Tool | What it does | Approval |
| --- | --- | --- |
| `documents_search`, `documents_get`, `documents_for_orders` | Find and read documents, including those of Shopify orders | No |
| `customer_history` | A customer's earlier sales: each line's unit price, the latest sale of a product and their Shopify orders | No |
| `documents_download_pdf` | Get a document's PDF | No |
| `pending_approvals_list` | List your pending invoicing approvals (read only) | No |
| `deferred_list` | List paid orders whose invoice did not issue, and why | No |
| `vat_validate` | Check an EU VAT number with the EU VIES service | No |
| `vat_lookup` | Find a business customer's VAT number from its legal name and city (web search, then VIES) | No |
| `contact_relationships_get`, `contact_relationships_set` | Read or set customer/vendor classification | No |
| `hs_codes_lookup`, `hs_codes_assign`, `hs_codes_unassign` | Look up and assign customs codes on products | No |
| `hs_codes_library_upsert`, `hs_codes_library_delete` | Edit the HS code library | No |
| `settings_issuer_profile_list`, `settings_shop_mapping_list`, `settings_tax_regime_list`, `settings_hs_code_list` | Read settings | No |
| `settings_issuer_profile_create`, `settings_issuer_profile_update`, `settings_issuer_profile_delete` | Change issuer profiles | Always |
| `invoice_issue`, `invoice_create_and_issue` | Issue an invoice | Always |
| `proforma_issue`, `proforma_create_and_issue` | Issue a proforma | Always |
| `quote_issue` | Issue a quote from a legacy draft | Always |
| `quote_create_and_issue` | Create a quote (and its Shopify draft order when mapped) | Threshold when local |
| `po_issue`, `po_create_and_issue` | Issue a purchase order to a supplier | Threshold |
| `credit_note_issue`, `credit_note_create_and_issue` | Issue a credit note | Threshold |
| `documents_convert_to_invoice` | Convert a quote or proforma | Always |
| `documents_update` | Edit a document | Always |
| `documents_send_to_customer` | Email a document | Always |
| `documents_mark_paid`, `documents_record_refund` | Record a payment or a refund (payment status only) | Always |
| `recurring_list` | List recurring invoice schedules with their next issue day | No |
| `recurring_schedule_create`, `recurring_schedule_update` | Save or change a recurring schedule; turning on issue by itself is never auto-approved | Always |
| `recurring_schedule_pause` | Pause a schedule, until a date or until resumed | No, unless the turn read outside text |
| `recurring_run_get` | Read a month-end run and its rows | No |
| `recurring_run_issue` | Stage a month-end run's card when it has none (a waiting card is decided by a person on it); numbers are taken on the issue day | Always, never auto-approved |
| `recurring_run_unapprove` | Undo a run's approval before its first number | No, unless the turn read outside text |
| `documents_retry_pdf` | Re-render a failed PDF | No |
| `order_reissue_apply` | Reissue an invoice after a Shopify order edit changed lines or amounts: the credit note and the replacement invoice are issued together or not at all | Always |
| `deferred_tax_override` | Issue a parked order with a chosen tax decision | Always |
| `drafts_create`, `drafts_update`, `drafts_discard` | Unissued drafts; a month-end run's draft issues only through its run's card | No |
| `einvoicing_classify`, `einvoicing_readiness`, `einvoicing_settings_get` | Explain e-invoicing status and blockers | No |
| `einvoicing_settings_set` | Change e-invoicing settings | Always |
| `counterparty_identity_get`, `counterparty_identity_lookup`, `counterparty_identity_set` | Read, look up and record a customer's SIREN/SIRET identity | No |
| `counterparty_territory_set` | Decide whether a Monaco or overseas buyer is treated as French | Always |
| `einvoicing_backfill_identities`, `einvoicing_backfill_legacy_originals` | Backfill identities and legal originals | Always |
| `einvoice_send_request` | Ask for approval to send one e-invoice | Files an approval |
| `einvoice_status_refresh`, `einvoice_transmission_get` | Read an e-invoice's platform status | No |
| `legal_originals_verify` | Check stored legal originals are intact | No |
| `received_einvoices_list`, `received_einvoices_get`, `received_einvoices_refresh` | Read received supplier e-invoices | No |
| `received_einvoice_action_request` | Ask to refuse, dispute or withdraw a dispute on a received e-invoice | Files an approval |

`einvoice_send`, `einvoice_book_batch`, `received_einvoice_set_status`, `einvoicing_settings_values` and `einvoicing_provider_options` are not offered to agents. They run after an approval or back the settings page.

Related: [Store](store.md), [Boxtal](boxtal.md), [Pennylane](pennylane.md), [Agent tools](../reference/agent-tools.md), [App settings](../reference/app-settings.md), [Scopes](../reference/scopes.md).
