---
title: Approve what agents do
description: "Review, edit, approve or reject the actions agents prepare, and set who must approve what, including two-approver rules."
screenshot: "assets/screens/approvals.webp"
screenshotAlt: "An approval request on Home expanded to show the drafted ticket reply to a customer, with Edit, Approve and Reject buttons."
---

Agents prepare sensitive actions and wait for a person to decide. This page shows how to work through the **Approvals** queue, who is allowed to decide, and how an administrator tightens or loosens the rules.

## What waits for approval

A gated tool never runs on its own. The agent calls it, Liaison records the exact payload as an approval request, and nothing happens until someone approves. Examples you will meet in the queue:

| Area | Actions that ask first |
| --- | --- |
| Mail | reply, forward, compose, archive, convert to ticket |
| Tickets | reply, nudge, close, edit or delete a note, merge, create, assign, set status |
| Invoicing | issue or create-and-issue an invoice, quote, proforma, purchase order or credit note; send a document to the customer; mark paid; record a refund |
| Shipping | create or cancel a shipment, open a claim |
| Calendar and files | create, update or delete an event; upload or import a Google Drive file |
| Social | reply to a post, send a direct message, like a post |
| Knowledge and projects | create, update, archive or verify a document; create, update, delete, merge or move tasks |
| Workspace | create, edit or delete a role; assign a role; invite a user; grant a scope; create, update, delete or run a routine; create, update or delete a skill; set an approval policy; connect an MCP server; merge contacts |

An action can also wait because of what the agent read. See [Hold actions after outside content](#hold-actions-after-outside-content).

The same list holds everything else that waits on your decision, in the same row layout:

- An **Access request**: an agent or a colleague asks for a permission, for example **Sales agent asks for access to Shopify**, with what it allows and why. Its pill takes the colour of the app the permission belongs to. Decide it with **Grant** or **Deny** on the row, or open **Details** to read every permission asked for. Only people who can decide access requests see it. See [Decide access requests](permissions.md#decide-access-requests).
- A run of your own routine that waits for your private mailbox: **Private mailbox**, ***name* waits for you**, with **Run now** and **Dismiss**, and **Details** for the run's facts. It is not an agent's action to approve, so only you see it and no approval permission is involved. See [When a run waits for your private mailbox](routines.md#when-a-run-waits-for-your-private-mailbox). Several waiting runs show as one item with **Run all** and **Dismiss all** ([routines](routines.md)).

When several kinds wait, the filter chips above the list include **Access requests** and **Routine runs**.

A message an agent drafts for a person never reaches the queue with a blank left in it. A mail reply, forward or compose, a ticket reply, nudge or close, a social reply or direct message, and a document sent to a customer are refused while their text still holds a slot such as `[DATE]`, `[Name]`, `{{firstName}}`, `<insert date>`, `XX/XX` or `TBD`. The agent is told today's date and asked to write the real value, or to say plainly in the message that it will confirm it. The same check applies when an agent edits a pending request. Text you type or edit yourself is not checked.

## Decide a request

1. Open **Home** and find the **Approvals** card. Each request you are asked to decide counts in the number on **Home**, which is the total of its **Needs you** section, and in the badge on the app icon (see [Notifications](../notifications.md#the-badge)). On a phone, the **Approvals** screen lists the same requests full width, with their count and **Soonest expires in** the time left (or **Nothing expiring soon**).
2. Click a request (or its **›** chevron) to unfold its card, and again to fold it. You can select and copy any text in it: a click that ends a selection does not fold the card. Read the card. It names who asked (**Requested by**): the agent or routine that proposed the action (your own agent shows as "{your name}'s agent", a routine as "Routine {name}", an app's scheduled job as "Scheduled job ({app})"), or a person when they made the request themselves. It also shows what the action does and the exact payload. **Exact payload** and **Technical details** show the raw call.
3. Click **Approve**, **Reject**, or **Edit** (see below). **Edit** only appears when the tool exposes editable fields.
4. If you click **Reject**, **Why are you rejecting this?** asks for an optional reason, then click **Reject** again.

When an agent wants to add another agent to a conversation, the card asks it in that conversation, for example **Support Desk wants to add Finance Desk to this discussion**, with **Add** and **Don't add**. No policy approves it for you.

A decision does not leave at once. The card hides and a toast counts down (**Approving in Ns** or **Rejecting in Ns**) with **Undo**. **Undo all** takes back every decision in the toast. After eight seconds the decision is sent and the toast moves through **Approving…** to **Approved**. If it fails, the card comes back. If you close the page inside those eight seconds, the decision is sent then, or at the next start within 15 minutes; an older one is not sent, and its row on **Home** says **Not sent: this decision was more than 15 minutes old. Decide again.**

On **Home**, the approval rows and the items that wait on you are one list, most urgent first. Over five rows, the first three show and **Show N more** opens the rest in the same order. The approval rows count in the number on **Home**; the row leaves and the count drops as soon as you decide, and **Undo** in the toast brings both back. Each row leads with its pill, the action in its app's colour (**Tickets: reply**). An app can name a kind of send itself: a payment reminder written for a Stripe invoice reads **Stripe: payment reminder**, not **Mail: compose**. **Details** opens the whole request in place.

A mail draft an agent wrote is checked again before it goes out, and its row on **Home** says what that check says: **Will not go out if they reply first, even after you approve.** A draft held by an automatic reply is not on **Home** and not counted until its hold ends, then it comes back by itself. A draft the check stopped (a reply came in, the address bounced or opted out) shows why, offers **Dismiss** only, and is not counted. So does the notice of a send stopped as it went out. Its card also lists, for each recipient who is a contact, what is recorded about them, as the mail composer shows it: the lawful basis (or **No recorded basis**), **Business**, **Consumer** or **Consumer or business not recorded**, and **Not opted out** or the day they opted out. It shows on any agent mail, commercial or not: approving makes the mail your send. A draft held by an automatic reply shows **Send now** in place of **Approve**; see [The check before an agent's mail goes out](../apps/mail.md#the-check-before-an-agents-mail-goes-out).

Who may decide a request is fixed when the request is raised: the permission the tool's own action needs, kept on the request. Later changes to the tool or to a colleague's role do not change who can decide an open request, and the card names the permission it asks for.

Items that are not approvals offer **Ask agent to draft**, which asks your Personal agent, in your conversation with it, to draft what the item needs, and **Not now** on the ones Liaison stored for you: the item leaves **Home** until next Monday at 00:00 in your time zone (**Settings**, **Profile**), then comes back unless it was resolved meanwhile. Set on a Monday, it means the Monday after. An app that does not answer is named in its own card, **Could not load what Stripe has for you**, with **Retry**; everything else still shows.

The card also shows how long is left (**N min left**). A request that nobody decides expires and nothing runs. The default lifetime is 168 hours. A tool can set its own, for example connecting an MCP server expires after 24 hours.

Each workspace numbers its requests on its own: **request-1**, **request-2**, and so on.

Once decided, the conversation gets a line that says who decided. You can see the final state on the card: **Approved**, **Denied**, **Expired**, **Withdrawn** or **Cancelled**. A pending request is cancelled, and leaves **Home**, when what it would act on goes away: the task it would change is deleted (taking the task back out of the bin makes the request pending again), or the app its tool belongs to is switched off or removed (switching the app back on does not reopen it; ask again). A mail draft about a record of an app, such as a follow-up about a deal, is cancelled when that record closes (the deal is won or lost) and when that app is switched off or removed. The card says why, and the request stays in the history.

### Reminders for requests you forget

When your own agent proposed a request for you, or you made it from your own MCP client (such as Claude), and it has waited more than a day, your agent tells you in your conversation with it. This is on for everyone by default, once a day. It writes one short message listing what is still waiting, with a link to each request. Before writing, it checks each request is still current: when what the request acts on moved on (a newer customer message on the ticket a reply was drafted for, a record already changed), it says the request looks outdated and suggests rejecting or redrafting it. For the ones you can decide, it says you can approve or reject them. For the ones only someone else can decide, it says who it is waiting on. You get at most one reminder a day, and only while such a request is still pending. Requests a routine raised are not part of it.

To change how often, open **Settings**, **Notifications**, and under **Approval reminders** pick **Daily**, **Every 3 days**, **Weekly** or **Off** for **Remind me of my requests waiting for approval**. With **Every 3 days** or **Weekly**, a request is part of a reminder once it has waited that long, and you get at most one reminder in that time. **Off** stops the reminders; your requests still wait in Approvals. You can also ask your agent: "stop reminding me about my approvals" or "remind me weekly".

An operator can send one at once from the server, without waiting for the hourly check: `liaison approval-reminders run --user <member email> [--org <slug>]`. Add `--force` to send even if the member was already reminded within their interval, or turned reminders off. Nothing is sent when no request of theirs has waited long enough (a day, or their longer interval).

### Card numbers in a request

A card number or a payment key an agent writes into a request is masked before the request is stored, on the card and in what the approved call sends: a card keeps its last four digits, a key its prefix. Identity values are never masked: a parameter that names a SIRET, SIREN, VAT, tax or registration number, an IBAN or BIC, an IMEI or serial, an order or invoice number, a product code or an id keeps its value, so the approved call runs with it.

### If the request changes while you read it

Approving is bound to the version you saw. If the request was edited meanwhile, the card says it changed after you first saw it. Tick **I have read the new version**, then decide again. Without this the server refuses with `payload_changed`.

### What the agent gets back

When an approved action runs, its result goes back to the conversation that asked for it. The agent reads it in its next turn, and the conversation shows **request-N ran; its result was passed to the agent**. If an agent asked for it in your conversation, that agent then answers from the result once, without you writing again, unless you already wrote after the decision. When one turn asked for several actions at once, such as two web searches, the agent answers once, after the last of them is decided, from every result. A rejection, a routine's request and a sequence that still has steps to run do not start that answer. Only people who could have made the call themselves can see that line. The agent reads the result as untrusted data. When the approved action was the agent asking you for a secret or a sign-in, its card appears under that line. When a step must follow, such as the secret card after an API connection is saved without credentials (it names the app, its connection and the connection's slug), Liaison states it to the agent itself, after the untrusted result, from a fixed list of steps that only Liaison's own tools can name. No text from the result is ever passed on as an instruction. On the card and in the feed, text a summary quotes from outside the organization shows as a labelled quote. A result from outside the organization, such as an MCP server's, marks the conversation as having read outside content, exactly as the same call made directly would.

### If the action fails after approval

A request you decided yourself reads **Approved by you** (or **Denied by you**); one a teammate decided names them.

An approved action can still fail. When it only reads (a lookup, a read on a connected tool), its error is the answer: the request is done, the conversation says the tool returned an error, and the agent gets the error as the result so it can try something else. Approving it again would only repeat the same read. Only a brief database failure on Liaison's side, before the read ran, puts it back to pending. When an action that changes something fails, the card shows **Last attempt failed** with the reason. When approving the same request again can never work (the plan or preview it was approved for has changed since), the request is closed instead, the conversation says why in the action's own words (for example, a bug report a routine prepared, once reports go only to the Liaison team), and the agent proposes it again if it still applies. If the outcome is unknown, the card tells you to check whether it took effect, then click **Close request**. Some actions check for you: when the tool can ask the provider whether the action happened (a social reply, for example), Liaison asks about a minute after the outcome became unknown. If it happened, the request is recorded as approved; if it did not, the request goes back to pending so you can approve it again. Only when the provider cannot tell does the request wait for you.

## Edit before you approve

Some fields can be edited by the person who asked or by an approver, for example the text of a ticket reply or the name, prompt and schedule of a routine.

Anyone who may approve a request may edit it, even when the request waits in a conversation they never joined, such as a team channel an agent posted it in. The edit is then kept on the request and its history, without a note in that conversation. Someone who may not approve it, and is not in that conversation, cannot edit it.

1. On the card, click **Edit**.
2. Change the text.
3. Click **Save** (or **Cancel** to drop the change), then click **Approve**.

A draft from a personal mailbox stays encrypted in the request: only the mailbox's owner sees it on the card and approves it. To edit it, unlock the mailbox on that device: **Edit** opens on the decrypted text, and saving encrypts the new text to the mailbox again, so the request never holds it readable. Until the mailbox is unlocked, the card shows **Unlock** instead of **Edit**. An agent can edit such a draft the same way. When the edit cannot carry every encrypted part of the draft (a reply's subject, for example), it is refused: the agent withdraws the request and drafts a new one.

Values the server set when the request was made (for example the exact API address and adapter version of a connector write, or the plan of a configuration change) can never be edited. If the tool exposes no editable field, **Edit** is not shown. An agent edits a pending request it can see as requester or approver with `approval_update_payload`, and a requester retracts its own pending request with `approval_withdraw`. Withdrawing means the request should not exist at all, for example because it rests on stale information. Both need only `kernel:approvals:read` for a request the agent's person raised, so an agent fixes or retracts its own request instead of raising it again; every agent declared in the config file holds that scope. Editing someone else's request also needs `kernel:approvals:write`. Any edit changes the version approvers saw, so they must read the new version before approving.

## Who can approve

Each request has one deciding scope.

| Rule | Detail |
| --- | --- |
| App approvals | The deciding scope is `<app>:approve`, for example `mail:approve` or `tickets:approve`. Anyone holding it can decide. |
| Custom deciding scope | A tool can name its own. Skill changes use `kernel:skills:approve`, narrowed by the skills domain. |
| Kernel actions | A built-in action is decided by the scope that lets a person do it: anyone holding `kernel:contacts:write` decides a contact edit, their own included. Administrative actions (roles, users, policies, routines, apps, configuration and connections) use `kernel:approve`. A request about only your own things (your own routine, your own personal connection, a skill hidden for you alone) is a private request instead: you decide it yourself (see **Private requests**). |
| After reading scoped data | An action that normally runs on its own can wait because the conversation read data that some people who can see where it lands may not see. Approving it shares that data, so anyone who holds every scope the conversation read decides it: no approve scope is needed, and the person who asked can approve it. Actions that always ask first keep their own deciding scope. |
| Dimension limits | An approval can be limited to a dimension value, such as a territory. Only approvers whose grants cover it can decide. Holders of `*`, `kernel` or `kernel:approvals:admin` are not limited by the dimension. |
| Private requests | When the action targets a personal resource, such as a personal mailbox draft, the request goes only to the resource owner. The card reads **Routed privately to the resource owner. Only they can see and decide it.** Nobody else sees it, administrators included. A personal agent's memory, your own memory, your notification settings and your thread mutes are personal resources: a write to them that waits for approval goes to you alone. A role agent's memory is shared by everyone who uses the agent, so its writes go to the organization's approvers. Your own routines are personal too: creating, editing, running, deleting or resetting a routine that runs as you, and enabling a routine template for yourself, go to you alone, so you approve the routine your agent drafted for you without an administrator. A scope it lists that you do not hold does not change that: approving cannot grant it, so the routine is made without it and the scope is filed as a request to an administrator. So do a link to connect your own account, disconnecting your own personal connection, and hiding an app skill for yourself only. A routine that runs as another person, an organization connection or a change for the whole organization keeps the organization's approvers, and so does any of these when an approval policy asks for two approvers. |
| After reading scoped data, any request | Whatever made a request wait (the outside-content hold, an approval policy, a tool that always asks), when the conversation had read scoped data the request goes only to approvers who hold every scope it read, and only they can decide it. When nobody who may decide it holds them, the agent is told at once instead of leaving the request waiting. |
| Requester | You can reject your own request. You can approve it if you also hold the deciding scope, or when it is a private request routed to you. |

When a request is about a company (a company or one of its contacts, or a deal of that company), Home puts it with the company's account manager, after the person who asked it, when they can approve their own (a routine or an app's scheduled job never counts as that person, even though its request is filed under a member), and the person the item is with, such as a ticket's assignee or a deal's owner. The manager is read each time Home loads, so giving a company to someone else moves its waiting requests at once. A manager who cannot approve that kind of request is skipped and the request goes to the usual approvers, without naming them. A request about several companies goes to the usual approvers.

A scope counts here the way it counts everywhere: granted to the person, through a role, or one every member of the organization holds, unless the app is restricted and the person is not on its list.

An organization's administrators hold every scope, so every request has someone who can decide it. The `kernel:approvals:read` scope lets a person read approval requests, and the `approvals_list` tool lists what is waiting on you.

When two colleagues can both approve their own requests, each sees the other's requests. The **Approvals** card on **Home** hides those by default. The phone **Approvals** screen does not. Click **Show N more, from colleagues who can approve their own requests** to see them, or **Hide requests from colleagues who can approve their own** to hide them again. Your own requests and requests raised by routines are always shown. Those requests from colleagues never send you a phone, computer or email notification: only the person who asked is notified. A request raised in the conversation you are reading right now does not notify you on your phone or computer either, since its card is on your screen; the decision on a request you made reaches your feed and digest quietly (**Decisions on your requests** in **Settings**, **Notifications**).

The person who owns a routine can choose who approves its drafts. See [Choose who approves a routine's drafts](../agents/routines.md#choose-who-approves-a-routines-drafts).

## Approve several steps in one go

When an agent makes several gated calls in one step, an operator can bundle them with `PARALLEL_APPROVAL_BUNDLING=true` (off by default). A sequence, where later steps use earlier results, is named after its last step, the outcome you approve, with the number of steps: a CRM contact, then a quote, then the reply that sends it reads as the reply, **3 steps**, on **Home** and on the card. On **Home**, the row lists what happens, in order: each step by its own title, numbered. The card shows each step in full, as it would read alone: the email that goes out (recipients, subject, the whole **Message** and its attachments), the quote (customer, every line with its quantity, price and discount, the total, how long it is valid and the customer reference), the record a CRM write creates (each field it sends). It says whether a step **needs a separate approval** or **runs automatically after approval**. What a step takes from an earlier one reads as that step, with its request and the fact that the value comes later, for example "Tracking: FedEx the shipment tracking number from step 1 (request-12, filled in when that step runs)". Once that earlier step has run, the step shows the value it returned instead (the tracking number itself). A file an earlier step makes is attached once that step has run. **Approve sequence** approves the bundle. The toast that follows is one item, named after the outcome, with **3 steps** and each step by name; its **Undo** takes back the whole sequence, since no step runs before the eight seconds are over. A step that sends an email from an end-to-end encrypted personal mailbox stays encrypted in the sequence, and Liaison cannot send it alone: when the steps before it have run, it becomes its own request for the mailbox's owner, with any file an earlier step made already attached. The owner approves it from a device where that mailbox is unlocked, then the steps after it run. Rejecting it cancels the steps after it. If the first step expires, the steps that wait behind it are cancelled. If a step fails when it runs, or cannot use the result of the step before it, the steps after it are cancelled and never run. The agent (or the routine run) that proposed the sequence is told the real error and which steps ran, and proposes a corrected sequence as a new request: the failed one cannot be approved again.

## Require two approvers

An administrator can make a tool need a second, different person. This is a tightening policy. It can add an approval or raise the number of approvers, never remove one.

1. Ask your personal agent for the rule in plain words, for example: "Credit notes over 200 EUR need a second approver."
2. The agent calls `approval_policy_set` with the tool, conditions on the call, `requireApproval` and `minApprovers` (1 to 10). Amounts are in minor units, so 200 EUR is `20000`.
3. The policy itself is a request in the queue (**Tighten approval policy**). Approve it.

Setting a policy needs `kernel:policies:admin`. Reading policies needs `kernel:policies:read`, with `approval_policy_get`. `kernel:policies:write` reads auto-approve policies only. There is no settings screen for policies: you set and read them through these agent tools.

When a policy applies, the card reads **Org policy requires multiple distinct approvers before this executes** and counts **sign-offs**. After the first approval the conversation says it is awaiting a second approver. If you try to sign twice, the card says **You have already signed off on this request. It needs a second, different approver.**

## Let low-risk actions skip approval

The opposite rule is an auto-approve policy. It lets a gated tool run without a person while its conditions hold.

- `policy_set` creates or updates one, `policy_get` lists them (with `kernel:policies:read`). Setting one needs `kernel:policies:admin` and is itself approved by a person (**Set auto-approve policy**).
- A policy has conditions on the call (`lte`, `lt`, `gte`, `gt`, `eq`, `in`, `contains`), optional limits (`perCallMax`, `windowSeconds`, `windowMax`) and an optional `requiresScope` the acting user must hold.
- To let agents edit contacts without approval, set a policy for `kernel:contacts_write` with no conditions. Contact edits stay in the organization, so the policy covers them even after the agent read outside text. Like any gated action, an edit still waits for a person once the conversation has read data that needs a scope, such as a contact search.
- A call that grants scopes, such as creating a routine, always waits for a person.
- After an agent has read outside text, a policy does not approve an action that leaves the organization unless it sets `allowAfterUntrustedContent`.

## Hold actions after outside content

Emails, web pages and replies from connected tools can carry instructions written by a stranger. By default Liaison protects against this: after a conversation has read outside content, actions that leave the organization wait for a person.

An administrator controls this in **Settings › Agent behavior › Outside content**:

1. Open **Settings › Agent behavior**.
2. Under **Outside content**, find **Ask for approval after outside content**.
3. Leave it on. Turn it off only if you accept that anyone who can email you or publish a page the agent reads may steer what it sends or saves.

The switch edits `organizations.settings.webContentProtection`. It has three values: `standard` (the default), `hardened` and `off`.

| Value | Effect |
| --- | --- |
| `standard` | After the agent read outside text, a tool with an outward effect (send, post, upload) becomes an approval request. |
| `hardened` | Every tool that crosses a trust boundary becomes one. The switch keeps `hardened` when you turn it off and on again. |
| `off` | Nothing waits because of outside text. The text is still fenced. |

One exception holds in every setting. If all the outside text the conversation has read came from one MCP server, a tool on that same server that the server marks read-only runs without waiting. At most, injected text can make the agent read more of that server. A tool that changes data still waits, even when the server is set to **Allow everything**.

Reading the web never waits, in any setting. `web_search` and `web_fetch` only read: they run at once in a chat, a routine run, a sub-agent or an MCP client, whatever the conversation read before. The page or results are still outside content: they mark the conversation, and the actions that write or send after them still wait as described above.

### Limits on reading the web

A search query or a page address leaves your organization, so Liaison limits what it can carry. A call over a limit is refused at once with the reason, and the agent carries on with what it found; nothing waits for approval.

| Limit | Default | Setting |
| --- | --- | --- |
| Length of a search query | 200 characters | `LIAISON_WEB_SEARCH_MAX_QUERY_CHARS` |
| Length of a fetched address | 512 characters | `LIAISON_WEB_FETCH_MAX_URL_CHARS` |
| Length of its query string (after `?`) | 150 characters | `LIAISON_WEB_FETCH_MAX_QUERY_CHARS` |
| Searches and fetches in one turn | 20 | `LIAISON_WEB_READS_PER_TURN` |
| Searches and fetches in a row, with no other tool between | 12 | `LIAISON_WEB_READS_CONSECUTIVE` |
| Different sites fetched in one turn | 10 | `LIAISON_WEB_FETCH_HOSTS_PER_TURN` |
| Searches and fetches per conversation in any hour | 60 | `LIAISON_WEB_READS_PER_THREAD_HOUR` |

An address with a user name or password (`user:pass@`) is always refused. Once the turn has read workspace data (a CRM record, a ticket, a knowledge document, a contact, memory, earlier messages of the conversation), a query or address is also refused when it carries an email address, an IBAN, a card or phone number, a key or token, or a long encoded string, and a query when it carries a number of 9 digits or more. Search for the public subject instead: a company name, a product, a topic. A fetch of exactly one of the turn's own search results skips these checks, since the search service wrote that address, not the agent. The limits are environment variables on the server; see [Environment variables](../reference/env.md).

A fetch your fetch policy refuses is answered the same way. When the address is outside your fetch allowlist, or on your blocklist, Liaison refuses it before any request leaves the server.

Saving this needs `kernel:org:admin`. The mark covers one turn. A new turn you type or a new routine run starts clean.

### See and clear the mark

While a conversation is marked, a globe shows beside its name: **Outside text** in the Chats header, the globe alone in a dock window. It pulses when an action waits because of the mark. Click it to see what marked the conversation: the tool, what it read and when.

- **Clear the mark** lifts it at once, with no approval card: you are the person who would approve it. Your agent stops asking before it writes, until it reads outside text again. Only a person in the conversation can clear it, from a full sign-in. An agent cannot, and neither can a device or CLI session.
- **Approval settings** opens **Settings › Agent behavior**. It shows only to administrators.

You can also ask the agent why something is waiting. It uses `outside_text_sources` to list what marked the conversation, and `outside_text_clear` to ask you to lift the mark. That request is an approval, and no policy can approve it for you.

## Approvals for your computer

An agent can only say an approval card is waiting when one really is: a card already decided earlier in the conversation does not count. If it claims otherwise, its reply is corrected.

Starting work on your own computer, sharing a folder, cloning a repository and importing a session are approvals that only the owner of the computer can decide. An administrator cannot approve them for someone else. See [Run work on your computer](../computers/run-work.md). Permission prompts raised while a session works are a separate step, described in [Guardrails and permission modes](../computers/guardrails.md).

## Preview details for approvers

An approval card shows a summary built by the app that owns the action, for example a before and after of the record. The summary is built once, when the request is made, and again when its details are edited; opening the card reads the stored summary. An older request saved without a summary shows a generic summary of its parameters. While it still awaits a decision, Liaison builds its real summary in the background, a few at a time. A decided request keeps the generic summary. A card lists at most 8 lines, except a card that pools a whole request into one numbered line per change (a dashboard change, up to 50 lines): its list scrolls inside the card. An API connector write whose adapter declares what its card shows (`approval`, see [API connector](../api-connector.md)) lists the record's current content as quotes, then the drafted text in full, up to 8000 characters with its line breaks, and a link to the record: up to 16 lines. Apps that run in the sandbox cannot read the record to build it, so the card then shows the raw parameters. A self-hosting operator can name host-reviewed bundled apps in `LIAISON_TRUSTED_SUMMARIZER_APPS` (comma-separated app names, empty by default) to run their summarizers on the host, which restores those previews.

An app can also draw a panel inside its own tool's cards, for example the rows of a month-end invoicing run, which open and change in place.

A call to an MCP server's tool has a card of its own: the server's name and the action as its title, for example **CRM · Manage CRM objects**, the tool's short description, then the call's arguments as lines, the text to be written first, each up to 500 characters. Argument text shows as plain text, never as formatting or links.

## Next steps

- [Agent permissions](../agents/permissions.md)
- [Schedule routines](../agents/routines.md)
- [Roles](../admin/roles.md)
