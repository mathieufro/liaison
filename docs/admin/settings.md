---
title: Find your way around Settings
description: Know what each Settings page controls, who can see it, and where to change your organization's name, models, agent safety, exports and updates.
screenshot: "assets/screens/settings.webp"
screenshotAlt: "The Settings landing page on the Profile section, with the settings menu for personal, AI, workspace and app settings."
---

**Settings** lists its pages in five groups: **You**, **AI**, **Workspace**, **Apps** and **Connectors**. You only see the pages your scopes open.

## Change your own settings (You)

| Page | What you change | Who sees it |
|---|---|---|
| **Profile** | **Profile picture** (PNG, JPEG, WEBP or GIF, up to 5 MB), **Display name**, **Language** (English, French or the organization default), **Theme** (System, Light or Dark), timezone. **Away**: the days you are away (first and last day) and your **Next in line**, who sees what needs you on Home while you are away and gets no new rights (your personal mail, direct conversations and personal agent stay private); **Set away** saves at once, with **Undo** for a few seconds, and **End early** ends a range. **Next in line by default** is saved as soon as you pick it and is used when a range names nobody. Your next in line's Home says that you are away and until when. Days from your own calendar are marked **From your calendar**, and an event that looks like leave asks **Yes** or **No** first ([Calendar](../apps/calendar.md)). Only dates are kept, never why | everyone |
| **Security** | **Change password**, two-factor authentication (**Enable 2FA**), **Delete my account**; for admins, **Sign-in methods** | everyone |
| **Notifications** | **How each kind reaches you**: each kind set to **Interrupt**, **Inbox only** or **Off** (muted on every channel, still in your inbox, unread but quiet, not on the badge). How each kind of notification reaches you per channel (in Liaison, on your computer, on your phone or by email), the **Email digest** cadence, and **Approval reminders**: how often your agent reminds you of your requests waiting for approval (daily by default, every 3 days, weekly or off). **Work hours** and time zone: outside them are your quiet hours, on by default from 20:00 to 08:00 on weekdays and all weekend, once your time zone is known (set by you, reported by your browser or app, or the organization's). **Muted conversations** with **Unmute**, and **Channels that notify you of every message** with **Mentions only**. **On call**: who incidents interrupt, the admins until an admin picks people. A routine run waiting for your private mailbox always reaches you in Liaison: no rule turns it off | everyone; **On call** edited by admins |
| **Sidebar** | Which apps your sidebar shows: one **Show in the sidebar** switch per app, saved as you switch it | everyone |
| **Computers** | Your computers, this computer's setup in the desktop app, and each computer's folders, agents and settings | everyone |
| **Connected tools** | The AI clients connected to Liaison over MCP, and the MCP servers you connect for yourself | everyone |

See [Invite and manage users](users.md#set-how-people-sign-in), [Connect a computer](../computers/connect.md) and [MCP servers](../agents/mcp-servers.md).

**Sign-in methods** also holds the workspace's Google client, used by Gmail and Google Calendar. When the server provides a Google client for every workspace, it reads **Google OAuth client provided by this deployment** and nothing needs to be set; a client saved here replaces the server's for this workspace. The card refreshes by itself when the client is saved elsewhere, for example from a conversation with the agent.

### Hide apps from your sidebar

Hide the apps you never use, so your sidebar shows only the ones you need.

- In **Settings › Sidebar**, switch an app off. It leaves the sidebar at once, on the computer and tablet and in the phone's **Work** list.
- Or right-click an app in the sidebar and choose **Hide from sidebar**. With the keyboard, press Shift+F10 or the menu key on the app.
- To bring an app back, switch it on again in **Settings › Sidebar**.

Your choice is saved to your account, so your other devices show the same sidebar. Hidden apps stay available from search, the command palette and links, and hiding an app never changes what you can access. Your agent can also hide or show apps for you when you ask it. An admin can set a starting list for you from your page in **Users**; you can change it back here at any time.

## Set up AI for the organization (AI)

| Page | What you change | Scope |
|---|---|---|
| **Models** | Provider API keys, which models are switched on, the model **Auto** runs, the **Default reasoning level** for turns that set none, **Blocked hosts** (OpenRouter hosts your requests never go to), **Voice dictation** (the dictation model, which needs an OpenRouter or Google key) and **Conversation history** (when long conversations are summarised) | `kernel:org:admin` |
| **Agent behavior** | **Agent safety** (**Ask for approval after outside content**), **Media analysis** (which attachments agents look inside: tickets, email, images, videos) | `kernel:org:admin` |
| **Usage** | Model usage and transactions | `kernel:billing:read` |
| **Plan** | The subscription plan, its status and the end of the current period, on a managed instance only | `kernel:org:admin` |

**Ask for approval after outside content** is on by default and recommended. Once a conversation has read text from outside the organization (an inbound email, a web page, a tool result), the agent's actions that leave the organization and its writes to memory and Knowledge wait for a person's approval, unless an auto-approve policy covers them. If you turn it off, anyone who can email you or publish a page the agent reads may be able to steer what it sends or saves.

An agent or an MCP client changes the same settings, apart from keys and **Blocked hosts**, with the `ai_models_set` tool, after approval.

A provider key saved on **Models** also answers an agent that asked for that key on a card in a conversation: the card reads saved and the agent carries on.

On a managed instance, models run on the service's own keys: adding a provider key or a model server is refused.

On a managed instance, AI use is counted in credits, not money. **Usage** shows the **Credits left** (included and purchased) and how much of this period's credits is used, as a percentage. Amounts in the chart and the transactions are credits. **AI models** and the model picker show each model's cost against Auto (**Cost vs Auto**, for example ≈ 1.4× or ≈ 3×), and voice dictation shows credits per minute. The provider keys and own server sections are hidden.

See [Choose models](../agents/models.md) and [Approve what agents do](../agents/approvals.md).

## Run the organization (Workspace)

| Page | What you change | Scope |
|---|---|---|
| **Organization** | **Details**: **Organization name**, **Timezone**, **Default locale**. **Usage and limits**: seats, mailboxes, storage and background jobs this hour, each used of its limit or unlimited (read only). **Export your data**: a copy of the organization's data. **Export organization**: the whole organization as one archive. **Imports**: the import runs and **Undo** | `kernel:org:admin` (export your data: `kernel:users:admin`; imports: `kernel:imports:read`, undo: `kernel:imports:undo`) |
| **Billing** | The plan and next invoice, **Change plan**, the payment card, **Invoices** (PDF), **Buy credits**, **Automatic top-up** and **Cancel subscription**, on a managed instance only | `kernel:org:admin` |
| **Documents** | The organization's document templates: rich text templates and uploaded PDF forms, their fields, and a preview | `kernel:org:admin` |
| **Users** | Invitations, roles per person, deactivation (with who takes over the companies a person manages) | `kernel:users:admin` |
| **Roles & access** | **Roles**, **Access requests**, **Data access** | `kernel:users:admin` |
| **App store** | Install apps and read each app's listing | `kernel:apps:admin` |
| **System** | Version and health, **Dependencies**, migration head, **Update checks** | `kernel:org:admin` |

See [Invite and manage users](users.md), [Set up roles](roles.md) and [Control data visibility with dimensions](dimensions.md).

### Pay for a managed workspace

On a managed instance, **Settings › Billing** holds everything about paying for the workspace:

- **Plan**: the current plan, when it renews and the next invoice. **Switch to** another plan: a larger plan applies once its prorated invoice is paid, a smaller one at the end of the period. A switch to a plan too small for what the workspace uses is refused, with the limits it would break.
- **Payment card**: **Change card** opens a secure payment form inside the page. Card details and payment confirmations (such as a bank's 3-D Secure check) are only ever typed there.
- **Buy credits**: any whole number of credits from the minimum the page shows, at the price it shows. Bought credits are used after the plan's own.
- **Automatic top-up**: buys credits with the card when the balance falls below a threshold, at most once an hour. If a payment fails or the bank asks for a confirmation, it turns off and admins are told.
- **Invoices**: every invoice and credit note, with **Download PDF**.
- **Cancel subscription**: ends it at the end of the period; **Resume subscription** undoes that until then.

### When a payment fails or the subscription ends

On a managed instance, the workspace follows the state of its subscription:

- **Payment failed**: AI use (chat, titles, side calls), web search and dictation stop with a message to pay the open invoice in **Settings › Billing**; a conversation shows it with an **Open Billing** link. Everything else keeps working. Once the invoice is paid they work again.
- **Suspended** (the invoice stayed unpaid, or the subscription ended): only admins can sign in, and only to use **Settings › Billing** and to export the organization, until the date the refusal names. Everyone else is refused, and so are apps connected through MCP or the API and live updates. The workspace's background jobs and incoming webhooks pause; exports and deletion still run. Paying the open invoice restores everything, and paused routines run again at their next time.
- **Closed**: nobody can sign in, admins included. The workspace and its data are deleted afterwards, never sooner than 25 days after it was closed.

While a payment has failed, **Settings › Billing** opens with **Payment failed: pay the open invoice to keep using AI features.**, the amount and the date to pay it by. **Pay the open invoice** opens the secure payment form on that invoice. **Buy credits** and **Automatic top-up** are hidden until it is paid.

Once the workspace is suspended or closed, every screen shows **Workspace suspended**, with the billing contact to write to. An admin who still has access also gets **Export your data** and **Billing** on that page, and **Reload** to return to the workspace once the invoice is paid.

Export the organization while it is suspended: [Export the whole organization](#export-the-whole-organization).

### See your organization's limits

1. Open **Settings › Organization**.
2. Under **Usage and limits**, each row shows what the organization uses: **Seats** (active people), **Mailboxes** (connected addresses), **Storage** (stored files) and **Background jobs this hour**, as used of the limit, or unlimited. Once the organization has a limit on its apps, or its apps ran today, three more rows follow: **App runs today**, **App calls today** and **App CPU today (ms)**, counted since midnight UTC (CPU is measured about every hour).

On a managed instance the plan also limits the organization's custom apps (apps an admin installs for this organization only, which no other organization sees, on any edition; deleting the organization removes them; see [Custom apps](../app-development.md#9-installing-on-a-deployed-liaison); on a self-hosted server they are unlimited unless the operator sets a cap) and how long its audit log is kept: audit entries older than the plan's number of days are deleted every night. An admin may keep them for fewer days (`settings.auditRetentionDays` in `PATCH /api/org`), never more; a longer choice is refused.

Limits are set by whoever runs the server; you cannot change them here. A row at its limit says **Limit reached**. You get a notification when a limit reaches 80 % and 100 %, once per crossing: it comes again only after use has dropped back under 80 %. A notification that could not be sent is sent at the next change in use. The notification is written in the organization's default language. For **Storage**, the 80 % notification asks you to upgrade or free space, otherwise new files will be refused once storage is full; at the limit, files from people and agents are refused, while incoming mail attachments and legal records such as issued invoices are still kept. Background work past its hourly limit waits for the next hour; nothing is lost. Past a daily app limit, tools answer that the limit is reached, and webhooks, events and background work of the apps run after midnight UTC. How the limits work: [Limit an organization](../provisioning-cli.md#limit-an-organization).

On a managed instance, **Everything stored (estimate)** adds what the organization occupies beyond its files: mail, tickets, conversations, knowledge, thumbnails and the search index. It is measured each night and it is an estimate. Above the plan's storage limit, admins get one notification per crossing; it never blocks anything. Self-hosted servers do not measure it.

### Send email from your own domain

On a managed instance, an admin can have the organization's invitations, notification digests and survey emails sent from the organization's own domain.

1. Open **Settings › Organization**.
2. Under **Email sender**, type the domain (for example `mail.example.com`) and click **Add domain**.
3. Add each DNS record of the table (**Type**, **Name**, **Value**, **Priority**) at your DNS host. **Copy** copies a name or a value.
4. Click **Verify**. DNS changes can take a few minutes to an hour; click **Verify** again until the status reads **Verified**.

Until a domain is verified, these emails are sent as "<organization> via Liaison". Sign-in codes, sign-in links and password resets always come from the service's own address, whatever the organization's domain. **Remove domain** goes back to the "via Liaison" sender. A domain already used by another organization is refused, and so is a domain that cannot be added right now: the service's operator is told.

### Export the organization's data

1. Open **Settings › Organization**.
2. Under **Export your data**, pick the **Apps to export**, the **Format** (**JSON** or **CSV**) and optionally a **From** and **To** date.
3. Click **Export**.

The file downloads in your browser as `liaison-export.zip`. If some apps could not be exported, the page lists them under **Some apps were skipped**. This is a data export, not a backup you can restore: for that, see [Back up and restore](backups.md).

### Export the whole organization

1. Open **Settings › Organization**.
2. Under **Export organization**, click **Export organization**.
3. When it is ready (you get a notification), click **Download** next to it. The archive downloads as a file, its size shown in your language's units, and you stay on the page.

The button stays off while an export runs. An archive can be downloaded for 7 days; then it shows **Expired**. What the archive holds: [Export a whole organization](backups.md#export-a-whole-organization).

Only whoever runs the server can delete an organization, and only after such an archive was downloaded: [Delete an organization](backups.md#delete-an-organization).

### Import from another tool yourself

1. Open **Settings › Organization**.
2. Under **New import**, choose the **Export files** to upload (none for a transform that reads an API connection). Large files upload in parts. After a dropped connection the upload resumes and sends only the parts still missing. If it keeps failing, it stops: choose the same file again to continue where it stopped.
3. Pick a **Transform**: one the agent wrote and saved for your export, or one you saved. Set the **Source label** (it prefixes every record's source id, so importing again skips what came before).
4. Click **Preview**. It reads the start of the export and writes nothing: you see the records per kind, the ones it refused and where they came from, and a few samples.
5. Click **Start import**. The import runs in the background as you, with your permissions, and its card follows it: counts per kind, refused records, the final report and **Undo**. If Liaison restarts during the import, the run stops after its current batch, goes back to **queued** and starts again on a running process; the records it already wrote are skipped.

An import whose preview refused more than 5% of the records cannot be started: ask the agent to fix the transform, then preview again. Previews do not appear in the list of runs.

Every file an import attaches to a record is a new copy that counts toward the organization's storage limit. When the limit is reached, that record fails with **STORAGE_QUOTA_EXCEEDED** in its error and the file is not attached; the rest of the run goes on.

### Undo an import

1. Open **Settings › Organization**.
2. Under **Imports**, find the run. Each run shows what it imported, its source, its status and how many records were created, skipped and failed.
3. Click **Undo** on a finished run.

Undo deletes what the run created. A record someone changed or added to after the import (an edited ticket or contact, a reply, a comment, a checklist item) is kept, with everything that record imported. A person or contact the run created stays while anything else still uses it.

Imported agent skills and routines never carry more than the person importing holds: a skill's required scopes and a routine's scopes must be within that person's (and, for a routine, within its owner's too). Imported routines arrive switched off: their owner turns them on. An imported routine that its owner's personal agent runs posts its runs in the owner's chat with that agent. A shared routine needs `kernel:apps:admin`, and a routine imported for someone else is theirs alone (personal).

Imports the agent runs appear here too, with the previews it made before starting them (see [Import from another tool](../agents/tools.md#import-from-another-tool)).

A run that is already undone cannot be undone again: **Undo** says so. Only the person who started the run, the person who asked the agent for it, or an admin, can undo or cancel it, and they need the same permissions the import needed. A run whose worker stopped is marked **Failed** after about ten minutes, so it can be undone.

### Manage document templates

**Settings › Documents** lists the organization's document templates: letters, declarations, certificates, labels that people and agents print from a record (a shipment, for example). Each row shows the template's **Name**, its **Kind** (**Rich text** or **PDF form**), its **Record type** and whether it is **In use** or **Turned off**, with the date it was **Updated**. Only org admins see the page; every member who reads files can print with the templates.

Agents do most of the authoring. The hint at the top, **Ask your agent to design a document from an example**, has a prompt you can copy into a chat with your agent along with an example document. Use this page to review what the agent made and to make small edits.

To create a template yourself:

1. Click **New template**.
2. Choose **Rich text**, or **Upload a PDF form** and pick the PDF. The PDF needs fillable form fields; an encrypted PDF or an XFA form is refused, and the reason shows under the form.
3. Give it a **Name**, pick its **Record type** (what it prints from), and click **Create template**.

A template's page has its **Name**, **Record type**, an on/off switch and **Archive template** (an archived template leaves every list and no longer prints). Below are its tabs:

- **Content** (rich text): the blocks in order: **Heading**, **Paragraph**, **List** (one line per item of a list in the record, such as the order lines), **Image** (a PNG or JPEG uploaded to the template) and **Space**. Move a block with the arrows, or **Delete** it. In a text, **Insert field…** puts a field of the record type at the cursor, written `{{order.name}}`; in a list line, the fields are those of one item. Click **Save**. When the server refuses the content, the message shows under the blocks and the block it names is marked.
- **Fields & mapping** (PDF form): one row per field of the PDF. Each field **Takes its value from** a record field, a fixed value or an image (a signature, a stamp), or nothing. **Placeholder when empty** is the grey text printed when the value is missing. Click **Save**.
- **Rules**: the rules that say which records need this template, for a template that has a record type. A rule matches a record when it meets every condition it lists: one of its **SKUs**, one of its **Destination countries** (two-letter codes such as US) and one of its **Carriers**. Click **Add rule**, fill in the conditions (values separated by commas) and save; **Edit**, **Delete** and the switch change a rule in place.
- **Preview**: choose **Sample values** (each field shows its name) or **A record** and its id, then click **Preview**. The saved template is shown here as a PDF, with **Open** and **Download**; nothing is stored. The fields that printed blank are listed: someone has to fill them.

A value that is missing never prints a default: it prints as a grey placeholder. A list with more items than a template has room for is refused, never cut.

### Check the version and turn off update checks

**Settings › System** shows the instance's **Channel** (see [Choose a channel](upgrades.md#choose-a-channel)), the **Running** and **Latest** versions, an **Update available** line with **Release notes** when one exists (**Security update available** when a newer release fixes a security issue), and the health of each dependency. Liaison periodically checks GitHub for newer releases. Click **Disable update checks** to opt out. See [Upgrade Liaison](upgrades.md).

### Share with the Liaison team

The **Liaison team** section of **Settings › System** has four switches, all off until an admin turns them on. Nothing is sent before that.

- **Register this server with the Liaison team** sends the Liaison version, the edition, the number of active users and a random server id, once and then once a day. It sends no domain, email address or name.
- **Allow sending bug reports to the Liaison team** can be turned on only while registration is on.
- **Send bug reports only to the Liaison team** can be turned on only while bug report forwarding is on. Reports from the organization that runs the server are then not filed in a local inbox; each one still shows exactly what is sent, with the reporter's email.
- **Share app performance with the Liaison team** can be turned on only while registration is on. It sends app run numbers once an hour (run counts, times, timeouts and errors per app and lane, how busy the sandbox was), with no names of organizations or people, no content and no custom app names. **See what is sent** shows the report exactly as it would be sent now.

Below the switches, **State** reads Off, Registering, Registered, Leaving or Error; on an error it shows the last error. The admins of the organization that runs the server also see the server id and, when messages are waiting, failed or expired, how many. On a shared server (demo or managed), other organizations' admins see the switches but cannot change them. If the server is set up without a Liaison team endpoint, the section says sharing is not available. The full list of what is sent, how it is delivered and how to turn it off is in [Share with the Liaison team](../self-hosting/liaison-team.md).

### Which documents a record needs

Document rules say which templates a record needs, by SKU, destination country, carrier or product attribute ([Generate shipping papers automatically](shipping-documents.md)). Apps and agents can ask which templates a whole list of records needs in one call; the answer names the matching rules and templates, and only says what is needed, never that a document was printed. Anyone who can read files can ask; listing the rules themselves needs an organization admin.

## Configure an app (Apps)

Each installed app has one row under **Apps**, for example **Mail**, **Tickets** or **Calendar**. An app whose package is no longer on the server (an app retired in favour of another) has no row: **Settings › App store** lists it under **Installed** as **Retired, no longer available**, with **Remove** to take it out of the workspace. The app's page holds its own settings, such as Mail's connected mailboxes or Tickets' inboxes and categories. See the page for each app, starting with [Mail](../apps/mail.md) and [Tickets](../apps/tickets.md), and the [app settings reference](../reference/app-settings.md). A link to `/settings/apps/<app>?section=<id>` opens the page on that section, with the focus on its first control. On **Google Drive**, a Drive account connected in picked mode lists, in its **Connection** section, the files and folders picked for Liaison, each with a remove button, and **Choose files** ([Google Drive](../apps/google-drive.md#choose-the-files-liaison-sees)). Its **Shared drives** section (admins) lists, per organization Drive connection, the shared drives the team can see, with **Save** ([Google Drive](../apps/google-drive.md#share-the-organizations-shared-drives)).

Each app the workspace has on shows how it runs in **Settings › App store**: **Running**, **Failed to load** or **Upgrade failed**, with the reason under its name. The server operator can roll an installed app back to its previous version from its listing. See [Upgrades](upgrades.md#roll-an-app-back).

Each app's page in **Settings › App store** names its **Publisher**, including an app installed from a URL without a listing (it reads **Unlisted**, with the publisher its package declares). The publisher of an app from outside Liaison is what its package says, so it reads **(self-declared)**. An app from outside Liaison cannot install under the name or label of a built-in app or of a Liaison page such as **Settings** or **Security**, even spelled with look-alike letters, nor name Liaison as its publisher: the install is refused and says which name is taken.

An app can offer features that the organization switches off. While a feature is off, its tools are not given to agents, and its tabs, panels and settings sections are not shown. If an agent still calls a tool of a feature that is off, the answer says that the feature is off and what to do next, and a request already approved for such a tool closes with the same words. Switching a feature needs the administration scope the app names for it.

An installed app's page in **Settings › App store** also shows its **Outbound access**: the hosts its code may reach under **Allowed**, and hosts a new version declares under **Waiting for approval**, which stay blocked until an admin allows them. Installing an app from a URL lists the hosts it asks for, and an upgrade lists its new ones; confirming grants them. The install screen also lists any page of the app that puts a connected account's access in your browser (a provider's file picker, run by Liaison: the app receives only what you pick), with the connection and the access it is limited to. The server operator (for an app installed for the whole server) or your organization's admin (for your organization's own app) can **Revoke** a host or **Allow** a waiting one; the change holds from the app's next run. An app installed before hosts were approved one by one reads **Every host it declares**.

An app's page with changes you have not saved asks before you leave it, and before the desktop app reloads or other tabs close.

In a desktop or phone app older than the server, a setting the app cannot show yet says **This setting needs a newer version of Liaison. Update Liaison to change it.** Update the app, or change it from the browser.

## Connect outside services (Connectors)

The **Connectors** heading opens one page with a card for each connector you administer, and the organization's MCP servers for org admins. A card that has nothing connected yet shows **No account connected yet.** with one **Connect**; once connected it shows the connection's health with **Check again**, then each account with **Disconnect** and, for an account you may manage (your own, or the organization's when you administer the connector), **Reconnect** for a signed-in account, whatever its health, or **Replace** for a credential. **Reconnect** signs that same account in again, which picks up scopes an app added since; for a per-store connector it goes straight to that account's store. An app with several accounts of one connection (the API connector's, one per system) opens the same credential dialog for one account and only the fields it needs. See [Connecting apps](../connecting-apps.md) and [MCP servers](../agents/mcp-servers.md). An admin can also send a member a one-time link that connects the member's own account: the link opens a **Connect your account** page that works only for that member, signed in as themselves, once, within 30 minutes (for a mailbox it asks **Transparent or private mailbox?**). If the connect is refused, the member comes back to that page, which says **Nothing was connected.** and why. Each organization MCP server's page has **Who can use it**, the same choice as an app's access: **Everyone in the workspace** or **Only selected roles and people**.
