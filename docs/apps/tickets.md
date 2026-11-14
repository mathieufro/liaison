---
title: Tickets
description: "Run customer support in Tickets: connect support inboxes, triage and answer tickets, set response targets, and let agents draft replies."
screenshot: "assets/screens/tickets.webp"
screenshotAlt: "A support ticket open with the customer messages, an internal note, the reply editor, and a side panel with status, assignees and category."
---

Tickets is your support desk. Customer email arrives in support inboxes and becomes tickets your team triages, answers and closes. Agents can search, sort and draft replies, and the replies they draft wait for approval.

## Connect a support inbox

Tickets arrive through inboxes. An inbox is a connected Gmail or IMAP mailbox, or an API inbox that receives tickets from your website or app.

1. Open **Settings › Apps › Tickets**, section **Inboxes**. You need `tickets:inboxes:admin`.
2. Connect a Gmail or IMAP mailbox, or click **Create API inbox**. You can also ask the agent to connect the mailbox: it posts a Connect card in the conversation, and the inbox is created once the mailbox shows as connected.
3. Click **Configure** on an inbox to set how it routes and replies:
   - **From display name**, **Reply-to base address (e.g. support@example.com)** and **Reply-from email (optional)**
   - **Default team** for new tickets
   - **Signature (HTML)** and **Signature (plain text)**
   - **Send acknowledgement email on new ticket**, with an optional acknowledgement body
   - One inbox for several teams: write `{{team}}` in the **From display name**, the signatures or the acknowledgement body, and each ticket's team replaces it. On a ticket with no team, the placeholder is dropped with the dash or short word (such as "for") in front of it
   - **Monitoring inbox: keep out of the attention feed**, for automated streams such as bug reports (reports from **Report a bug** keep their attached files on the ticket, and carry the server's recent error signatures only when the reporter belongs to the org that runs the server; a report can also be sent to the Liaison team, see [Share with the Liaison team](../self-hosting/liaison-team.md#forward-a-bug-report))
   - **Notify on new ticket**, off by default, see [Hear about new tickets](#hear-about-new-tickets)
   - **No SLA: exempt this inbox's tickets from SLA**
4. Click **Save**.

For an API inbox, click **Generate API key**. The key is scoped to that inbox: it can only create tickets there. The key is shown only once. The **API keys** section lists the keys that create tickets through the public ingest endpoint, with their **Allowed origins** (one https origin per line, empty means any origin).


## Hear about new tickets

A ticket from a website form or another API inbox raises no notification by itself. To be told, tick **Notify on new ticket** when you click **Configure** on the inbox, or switch it on from the command line or the agent:

```bash
liaison tickets inbox update --id <inboxId> --notify-new-ticket true
```

The agent tool is `inboxes.update` with `notifyNewTicket: true`, and a mailbox inbox in a provisioning file takes `notifyNewTicket: true`. It is off by default.

With it on, each new ticket in that inbox raises one attention item for the people who hold `tickets:inboxes:admin`. The item names the inbox, the subject and the requester, never the message body.

- A message added to an existing ticket raises nothing.
- A **Monitoring inbox** stays silent even with the option on.
- Imports, a newly connected mailbox's history, mail more than three days old and a thread you opened by writing first raise nothing.
- The person who opens a ticket by hand is not told about it. The other admins are.
- The item leaves the feed once someone replies to the ticket, snoozes it or closes it.

Each person hears about it through their own notification settings. By default it reaches the phone, the computer and the digest, under the same row as approvals. Quiet hours apply, and many at once arrive as one summary.

## Find tickets

1. Click **Tickets** in the activity bar.
2. Pick a view in the sidebar. **Smart filters** are **Needs attention now**, **Awaiting customer**, **Follow-ups**, **Closed last 30d** and **All open work**. The default saved views are **My open tickets**, **Unassigned** and **SLA approaching**.
3. Narrow the list with the filter bar: **Status**, **Priority**, **Inbox**, **Team**, **Audience** and **Category**. Sort newest or oldest first.
4. Type in **Search tickets…** to search by text.

Ticket statuses are **Open**, **Awaiting customer**, **Awaiting follow-up** and **Closed**.

## Create a ticket

1. In Tickets, click **New ticket**.
2. Enter a **Subject**, and a **Contact email** and **Contact name** (or an existing contact id).
3. Choose an **Inbox**, a **Priority** (**Low**, **Normal**, **High**, **Urgent**), a **Category**, an **Assignee**, a **Team** and a **Sensitivity** (**Internal**, **Confidential**, **Restricted**).
4. Add **Initial content** as an **Internal note** or as the **Initial inbound** message.
5. Click **Create**.

Every ticket belongs to an inbox, so a new workspace needs one first: the dialog links to [Connect a support inbox](#connect-a-support-inbox), where an API inbox is enough if you have no mailbox yet.

To turn an email into a ticket, open the conversation in [Mail](mail.md) and click **Convert to ticket**. Choose the **Tickets inbox** and **Priority**, add a **Note (optional)**, and click **Convert**. You need a connected support inbox first. To hand a ticket back to email, use **Convert to Mail** in the ticket and pick a **Send-from account**.

## Answer a ticket

1. Open the ticket and choose **Reply** or **Note**. When the ticket has a team, its header shows it next to the SLA as **Team**.
2. For a reply, write in **Reply to customer…**. Add Cc recipients, attach files, or click **Insert saved reply** to use a saved reply.
3. Tick **Set follow-up** if you want the ticket back in your queue later.
4. Click **Send reply**. A note (**Add note**) is visible to agents only and posts immediately.

Your own reply is sent right away. If your organization requires two approvals for replies, it waits for a second person and the composer says so.

### Card numbers in tickets and mail

A card number a customer writes in a mail or a ticket message is hidden before it is stored: it shows as `•••• •••• •••• 4242` (its last four digits), and a security code written next to it (CVC, CVV, cryptogramme, security code) as `•••`. The message ends with a note, "[A card number was hidden.]". Notes you add are masked the same way, and so are Stripe keys (only their prefix is kept). Only numbers that are real card numbers are hidden: a number counts as a card only when its first digits and its length match a card network, so an order or invoice number, a tracking number, a SIRET, SIREN or VAT number, an IMEI, an IBAN or a phone number stays as written, and so does any number right after a label that names it (SIRET, IMEI, order, invoice). People and agents only ever see the masked text. In a mailbox with end-to-end encryption the server never holds the text, so it is masked where an agent reads it.

An open ticket catches up after a connection drop: a reply or note written while you were offline, by a person or a routine, shows within seconds of the app reconnecting. A ticket in another tab catches up when you switch to it.

Earlier emails quoted under a customer's message are folded away. Click **··· N earlier emails** to list them: **In this thread ↑** takes you to a copy already in the ticket, and **Show original** shows the quoted part as it was sent. A reply sent from Liaison is always shown whole.

### Find your place in a long conversation

On a computer, a ticket longer than about two and a half screens shows a thread map on its right: one block per message, with a band over the part you are reading. Hover the map to see who wrote each message, when, and its first line. Click a block or a line to jump to the top of that message, or drag on the map to scroll.

On a phone, tap **Open thread map** in the top bar (shown from 3 messages), or the position pill that appears while you scroll. **This conversation** lists every message and note; tap one to jump to it.

Your signature is set per person in **Settings › Apps › Tickets**, section **Your reply signature**. The reply box starts with it below an empty line; if you start typing before the ticket has loaded, it is added once, after what you typed.

## Triage and close

In a ticket you can **Assign** (or **Assign to me**), **Change status**, **Change priority**, **Change category**, **Schedule follow-up** or **Clear follow-up**, **Send nudge** to a customer who has not replied, and **Reopen ticket**.

To close, click **Close**, pick a reason (**Resolved**, **Duplicate**, **Spam**, **No response**) and add an optional **Final reply**.

### Close tickets when the customer stays silent

Each inbox can close tickets on its own once the customer stops answering. It is off by default. In **Settings › Apps › Tickets**, section **Inboxes**, click **Configure** on the inbox and tick **Close tickets when the customer stays silent**:

1. Set **Send the nudge after** (7 days by default) and **then close** (5 days after the nudge by default).
2. Edit the **Nudge text**, or leave it empty to send the default wording in the customer's language.
3. Click **Save**.

A ticket counts as silent when it is **Awaiting customer**, our message is the last one and the customer has not written since. Open tickets and tickets waiting on you are never touched. Only tickets you write to after switching the option on count, so turning it on does not sweep the backlog. Each hourly run handles at most 20 tickets.

The nudge and the close go through the same approvals as any other send: by default each ticket gets its own approval card, one for the nudge and later one for the close. An auto-approve policy on `tickets:nudge` or `tickets:close` lets that step run without a card. The close uses the reason **No response** and sends no email. If the customer replies after the nudge, the ticket reopens, a pending nudge or close is cancelled, and a later silence starts over with a new nudge. A card also stops applying once you write to the customer or move the ticket out of **Awaiting customer**: it is cancelled, and approving a card late does nothing if anything was said since it was raised.

The option acts through a routine, **Close silent tickets**, which belongs to the person who switched it on: it works with that person's permissions, but it never speaks as them. The approval cards name the routine as the requester, the nudge shows **Routine: Close silent tickets** as its author, and the history records the steps as the routine's. The routine appears in that person's routines, switched off: it has no schedule or agent of its own, and the inbox option is what turns it on and off. Only someone allowed to reply to and close tickets can switch it on. If that person's account is deactivated, or they lose those permissions, the option switches off on the inboxes they enabled it for, and everyone who manages inboxes gets a notice to switch it on again. The routine itself cannot be edited, handed to an agent or deleted: the inbox option is its only switch.

To act on many tickets at once, click **Select** in the list. Bulk actions are **Close tickets…**, **Assign…**, **Change priority…**, **Set B2B / B2C…**, **Change team…**, **Merge…** (two or more tickets) and **Move to inbox…**. A merge moves every conversation started from a merged ticket to the ticket that remains.

## Set up categories, response times and ticket ids

All in **Settings › Apps › Tickets**:

| Section | What you set | Scope |
|---|---|---|
| **Categories** | A category tree. Drag to reorder or nest, click a name to rename. Two levels at most. | `tickets:categories:admin` |
| **Response times & email** | **Urgent first response** (default 1 h), **High first response** (2 h), **Normal first response** (8 h), **Low first response** (24 h), counted in business hours; **Time zone**, **Business hours**, **Holidays**; **Email header name**, **Email footer**, **Accent color**; **Approve ticket replies from Home** | `tickets:settings:admin` |
| **Ticket ID prefixes** | Prefix ticket numbers by audience, team, category or inbox, such as ticket-B2B-12 | `tickets:settings:admin` |
| **API keys** | Keys for the public ingest endpoint | `tickets:settings:admin` |

| Setting key | Label | What it does |
|---|---|---|
| `signature.text` | **Signature** (under **Your reply signature**, per user) | Added under the replies you send from a ticket. |
| `sla.targets.urgent`, `sla.targets.high`, `sla.targets.normal`, `sla.targets.low` | **Urgent first response**, **High first response**, **Normal first response**, **Low first response** | First-response target per priority. Defaults 3600, 7200, 28800 and 86400 seconds. |
| `sla.businessHours.timezone` | **Time zone** | Zone of the business hours. Default Europe/Paris. |
| `sla.businessHours.weekly` | **Business hours** | The weekly schedule the response clock runs in. |
| `sla.businessHours.holidays` | **Holidays** | Days the response clock does not run. |
| `emailTemplate.headerName` | **Email header name** | Shown at the top of ticket emails. Empty uses the organization name. |
| `emailTemplate.footerText` | **Email footer** | Footer text of ticket emails. |
| `emailTemplate.accentColor` | **Accent color** | A hex color such as #2563eb. |

With **Approve ticket replies from Home** off (the default), a pending agent reply is approved, edited or rejected inside its ticket. On, it can also be decided from its Home card. See [Approve what agents do](../agents/approvals.md).

## Roles and scopes

Tickets ships three roles. See [roles](../admin/roles.md).

| Role | Scopes |
|---|---|
| `support` | `tickets:tickets:read`, `tickets:tickets:write`, `tickets:tickets:reply`, `tickets:approve`, `tickets:inboxes:read`, `tickets:categories:read` |
| `support_lead` | `support` plus `tickets:tickets:close`, `tickets:inboxes:admin`, `tickets:categories:admin`, `tickets:accounts:admin` |
| `admin` | `support_lead` plus `tickets:settings:admin` |

`tickets:approve` decides the approvals that gated ticket tools raise. Full list: [scope reference](../reference/scopes.md).

## What agents can do

Tools marked "Yes" create an approval instead of acting.

| Tool | What it does | Approval |
|---|---|---|
| `search`, `get`, `listForContact` | Find tickets and read one with its recent messages | No |
| `create` | Create a ticket, optionally with files on its first message | No |
| `reply` | Reply to the customer on a ticket | Yes |
| `nudge` | Send a polite follow-up while awaiting the customer | Yes |
| `close` | Close a ticket, optionally with a final email | Yes |
| `addNote` | Add an internal note to a Liaison ticket, optionally with files (never a note in a connected CRM; its result names the ticket) | No |
| `editNote`, `deleteNote` | Edit or delete an internal note | Yes |
| `assign`, `setStatus`, `setPriority`, `setCategory`, `setLanguage`, `setTeam`, `setAudience` | Change ticket fields | No |
| `setFollowup`, `clearFollowup`, `reopen`, `merge`, `markRead` | Follow-ups, reopen, merge, read state | No |
| `convertToMail` | Hand a ticket back to Mail | No |
| `inboxCounts`, `backlogHealth`, `slaReport` | Unread counts, backlog health, weekly SLA breach report | No |
| `teams.list`, `teams.rename` | List teams, rename a team on every ticket | No |
| `categories.list`, `categories.create`, `categories.update`, `categories.archive` | Manage categories | No |
| `templates.list`, `templates.create`, `templates.update`, `templates.delete` | Manage saved replies | No |
| `csat.request`, `csat.summary`, `csat.list` | Send satisfaction surveys on closed tickets and read the results | No |
| `inboxes.list`, `inboxes.disconnect` | List or disconnect inboxes | No |
| `inboxes.create`, `inboxes.update` | Create or change an inbox | Yes |
| `idSegment.get`, `approveFromHome.get`, `apiKeys.list`, `apiKeys.revoke` | Read settings, revoke an API key | No |
| `idSegment.set`, `approveFromHome.set`, `apiKeys.create` | Change settings, create an API key | Yes |

### Attach files to a new ticket or a note

`create`, `addNote` and `reply` take Liaison file ids in `attachments` (from `files_list`, for example). On `create` the files go on the ticket's first message, so the call needs `initialMessage` too. The files then show on that message like any other attachment.

The same checks apply to all three tools:

- The agent can only attach files it can read, from its own organization. Any other id is refused as not visible.
- Executable and script file types are refused.
- At most 10 files per call, 25 MB per file and 35 MB in total.

A refused file stops the whole call: no ticket or note is created.

An app can attach one of its own files the same way. It stores the file on one of its own records (`files_importAttachment`), then calls `tickets:create` or `tickets:addNote` with that id, a call it declares in `cross_app_calls`. The tickets tool reads the file with the calling app's access, so the app needs no tickets scopes of its own, and a file the app cannot read is refused like any other.

### Open a ticket only once

`create` and `addNote` take an optional `idempotencyKey`. A second call with the same key and the same parameters returns the first call's result, for 24 hours, instead of opening a second ticket or adding a second note. The same key with different parameters is refused. While the first call is still running, a second one is told to retry. An app's webhook handler can pass the delivery id as the key, so a redelivered event never opens a duplicate ticket.

## Import tickets

Tickets, their messages and attachments import as the `tickets.ticket` kind: one record per ticket, matched on `externalRef`, so a ticket already imported is skipped, never updated. Importing a ticket needs `tickets:tickets:write` and access to its team. Each import is a run you can undo from **Settings › Organization › Imports** (see [Undo an import](../admin/settings.md#undo-an-import)).

Categories import as the `tickets.category` kind: one record per category path, such as `Hardware / Power`. A missing level is created, an existing one (matched on its name, in any case) is reused and left as it is. Categories nest at most two levels. Importing categories needs `tickets:categories:admin`. In a run that also imports tickets, categories go first, so a ticket can name a category the same run creates.

A preview of the import runs the same checks as the run, without writing anything: a ticket that names a category that does not exist (and that no earlier record of the import creates), or a team you have no access to, is counted as refused before anyone approves the run.

Reply templates import as the `tickets.reply-template` kind, matched on their name: a template whose name exists is skipped and keeps its text. Importing templates needs `tickets:tickets:write`.

See the [agent tool reference](../reference/agent-tools.md).
