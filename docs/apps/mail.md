---
title: Mail
description: "Connect Gmail or IMAP/SMTP mailboxes, read and send email, and let agents draft replies that wait for your approval."
screenshot: "assets/screens/mail.webp"
screenshotAlt: "The Mail inbox with a folder list on the left and a list of customer conversations, each with a Claim button."
---

Mail brings your Gmail or IMAP/SMTP mailboxes into Liaison. You read and answer email in the **Mail** tab, and agents can search it and draft replies that wait for your approval before anything is sent.

## Connect a mailbox

Mailboxes are managed in **Settings › Apps › Mail**, under **Your email accounts**.

Until a mailbox is connected, the **Mail** tab shows "Connect an email account to get started" and a **Connect an Account** button that opens this settings page.

### Connect Gmail

1. Open **Settings › Apps › Mail**.
2. Under **Connect an Account**, click **Connect Gmail**.
3. Sign in with Google and approve the requested access (read, modify and send mail).
4. If your mailbox is private, set a mailbox password when asked (see [Choose how your mailbox is encrypted](#choose-how-your-mailbox-is-encrypted)). A transparent mailbox asks for nothing and starts syncing at once.

Gmail needs the workspace's Google client. If it is not set up, the page says so and a mail admin sees an **Open Mail Setup** link, which scrolls to **Mailbox types** and puts the focus on the **Gmail mailboxes** toggle. An admin with `kernel:org:admin` sets the client under **Gmail & Google sign-in** on the same page. It is the same Google client as Google sign-in. A mail admin can also turn Gmail off for the workspace with the **Gmail mailboxes** toggle under **Mailbox types**. On a self-hosted server the toggle starts off; a managed (Liaison Cloud) workspace starts with it on, since the service provides the Google client. While it is off, no Gmail mailbox connects: the agent asks an admin to turn it on (a configuration change they approve) before it shows a Connect card. The page updates by itself when the toggle changes, the Google client is saved or a mailbox connects, including when the change was made from a conversation with the agent.

You can also ask the agent to connect your Gmail: it shows a Connect card in the conversation that does the same steps.

### Connect an IMAP/SMTP mailbox

1. Open **Settings › Apps › Mail**.
2. Click **Connect IMAP/SMTP**.
3. Pick a preset (**Fastmail**, **Yahoo**, **iCloud**) to fill the hosts and ports, or type them yourself. **SMTP security** sets the SMTP port: STARTTLS uses 587, SSL/TLS uses 465. A port you typed yourself stays as it is.
4. Enter your email address, username and password, then click **Connect**.

If your provider uses two-factor authentication, use an app password, not your normal password. Use TLS ports: IMAP 993, SMTP 465 (implicit TLS) or 587 (STARTTLS). Common settings:

| Provider | IMAP | SMTP |
|---|---|---|
| Gmail | `imap.gmail.com`:993 | `smtp.gmail.com`:465 |
| Outlook | `outlook.office365.com`:993 | `smtp.office365.com`:587 |
| iCloud | `imap.mail.me.com`:993 | `smtp.mail.me.com`:587 |

For a personal Gmail address, turn on [2-Step Verification](https://myaccount.google.com/signinoptions/twosv) first, then create an [app password](https://myaccount.google.com/apppasswords) and paste it as shown, spaces included. When the agent connects it for you, the form comes filled with Gmail's servers.

If the server refuses the sign-in, the row says why: the password is wrong, an app password is needed, IMAP is turned off for the mailbox, Google held the sign-in back until you confirm it in a browser, or there are too many connections at once (this one passes on its own).

#### What an IMAP mailbox keeps in step

The mailbox row says what it keeps in step with the server, for example "Kept in step with the server: read and star, archive, trash, Sent mail imported. New mail every 2 minutes."

- **Read and star** made in Liaison reach the server, and the server's read and star come back.
- **Archive** reaches the server: on Gmail it removes the message from the inbox; elsewhere it moves it to the Archive folder. A server without an Archive folder keeps the archive in Liaison only, and the row says "Archive stays in Liaison: the server has no Archive folder."
- **Trash** moves the message to the server's Trash folder, and back.
- Mail archived or deleted in another client leaves the inbox here too; mail moved back to the inbox reopens. An inbox of more than 20,000 messages is too large to track: archive done elsewhere is then not seen here, and the row says so. On Gmail, archive needs the **All Mail** folder shown in IMAP (Gmail settings, **Labels**), as it is by default; otherwise the row says archive stays in Liaison.
- A conversation you trash in Liaison stays in Trash here even if the server reports a change on it before the move is done.
- The **Sent** folder is imported, so replies sent from another client show in the conversation. A thread holding only your own mail (its other half was archived before you connected) arrives archived and shows in **Sent**, not in the inbox. A conversation that starts with mail you sent, from Liaison or from another client, is linked to the contact of its first To address when that address already has one, so it shows under that contact; sending never creates a contact. Mail sent from Liaison is also filed in Sent about 30 seconds later, unless the server does it itself (Gmail, Outlook and Microsoft 365, Yahoo, AOL) or already has it.
- New mail arrives every 2 minutes, not at once.
- Mail always syncs most recent first. The first import starts with the newest mail, so recent messages show within the first minute, then works back through the rest of the inbox in the background, a short batch at a time, however large the mailbox; mail arriving meanwhile comes in first. After a pause (the server was unreachable, Liaison was down, the mailbox was paused), the newest waiting mail comes in first and the rest follows, newest to oldest. The Sent folder is imported after the inbox, newest first too. A very large message (over 1 MB) is imported with its text only; its attachments stay on the server. In an encrypted mailbox, a message whose text is over 1 MB is stored cut at 1 MB, ending with a note that gives its full size and tells you to open it in your mail provider (Gmail, Outlook) to read all of it; the rest of the mailbox keeps syncing.

Changes made to many conversations at once reach the server in groups of 15, one sign-in per group. When the server refuses a change, the change stays in Liaison and the row says "Not written to the mail server: …".

### Connect a shared team mailbox

A mail admin (`mail:accounts:admin`) sees **Organization-owned accounts** on the same page.

1. Click **Connect shared Gmail** or **Connect shared IMAP/SMTP**.
2. Once connected, click **Manage access** on the mailbox row to choose which roles can use it. Access is granted per mailbox through the `mail:inbox` dimension in [roles](../admin/roles.md) and [dimensions](../admin/dimensions.md).

An organization's IMAP mailbox is checked on schedule whether or not anyone is signed in, so mail-driven work runs overnight too. A personal IMAP mailbox is checked on schedule only while someone who can read it is online. Connecting a second address adds a second shared mailbox; re-entering the password of an address, in any upper or lower case, updates its mailbox.

### One owner per address

A mailbox belongs to whoever connected it: you alone, or the organization. Connecting an address as your own never takes over the organization's mailbox for that address, and the reverse is also true. If the other owner's mailbox is still connected, the new connection is refused and you get an alert saying why. If that connection is gone (disconnected, or taken over by an admin for the organization), the old mailbox is replaced: its imported mail, settings and access grants are removed, and the address starts again as a new mailbox for its new owner. An IMAP connection replaces another owner's mailbox only when its login works; otherwise it is refused and the other mailbox is left as it is.

### When the organization has no mailbox left

Whoever runs the server can limit how many mailboxes an organization connects. At the limit, connecting a new Gmail or IMAP mailbox is refused with "This organization uses all of its mailboxes. Whoever runs the server can raise the limit, or an admin can disconnect a mailbox first." Saving new credentials for a mailbox that is already connected is never refused. Admins see the limit under Settings → Organization → **Usage and limits**.

A send from a mailbox whose connection is gone (disconnected, or its account deleted) is refused before anything leaves: the composer says "This mailbox is no longer connected, so nothing was sent. Reconnect it in Settings → Connections, or send from another mailbox.", and the reply tool answers `connection_not_connected` naming the mailbox.

### Keep a mailbox healthy

Each mailbox row shows its last sync and its state. A mailbox that has not synced yet says "Not synced yet", "Syncing…", or, while its encryption is not set up, "Syncs once the mailbox is set up". When a sync fails, the row says what went wrong in a sentence, for example "The mail server could not be reached. Check its address and port; Liaison tries again on its own."; hold the pointer over it to see the server's own error. During the first import, a refused password stays an error until you reconnect the mailbox; any other failure (an unreachable server, a timeout) is tried again after 15 minutes, then after twice as long each time, up to every 6 hours, and the sync resumes where it stopped. Once an IMAP mailbox is imported, a failing sync waits 2 minutes, then twice as long after each new failure, up to 6 hours (a refused password waits the 6 hours), and the row says "Next try at …" with the time in your language (only the time when the retry is today). A failing Sent folder waits on its own and never holds back the inbox. **Sync Now** (or **Retry now**) tries at once, and so does saving new credentials. A personal mailbox whose encryption is not set up yet offers no **Sync Now**: setting it up is what starts its sync. Use **Sync Now** to pull new mail, and **Re-authorize** when the row says **Re-authorization required**. A shared mailbox in error shows **Retry now**, to try again without waiting, and, for an IMAP mailbox, **Edit credentials**, which opens the IMAP form for that mailbox so you can fix its servers or password. The form opens with the mailbox's stored servers, ports and username; only the password is empty. If the server refuses a retry, the row says why. Disconnecting a mailbox deletes the conversations, messages, drafts and attachments imported from it, and their search results. The mail itself stays in the mailbox, and tickets already created from those conversations are kept. For a Gmail mailbox, Liaison also tells Google to stop sending it change notifications and removes its access to the account, unless another connection on the server still uses that access (for example Calendar on the same Google account). If Google is unavailable, Liaison keeps trying for up to 3 days.

## Choose how your mailbox is encrypted

Mail from a personal mailbox is always encrypted at rest. The section **Mailbox encryption** on the same page sets how, for the mailboxes you connect next:

- **Transparent** (the default on a new Liaison): encrypted with a key the server holds for that one mailbox. You and your agent read it, including in routines, with no mailbox password. Your organization's admins cannot read it. Whoever runs the Liaison server holds the key, so they could.
- **Private**: only you can read it, on devices where you unlock it with your mailbox password or a passkey. The server cannot read it, and neither can an admin or a coworker, so your agent reads it only while your mailbox is unlocked in one of your open Liaison apps (any page: Mail does not need to be open). For security, routines and agents can't read private mail while you're offline: those runs wait for you (**Run now** in your approvals, see [Routines](../agents/routines.md)). When a new email started such a run, **Run now** opens that email for the run as you click, so you can close the window at once.

Any of your unlocked apps answers for your own agent's requests. With several Liaison apps open (the phone app, the desktop app, a browser tab), it does not matter which one you asked the question in: any of them where your mailbox is unlocked decrypts the mail for your agent, without asking. You can ask on your phone while the mailbox is locked there, and your unlocked desktop app answers. An app where the mailbox is locked never answers in place of one that is unlocked: the agent waits until each of your unlocked apps has answered. If none can, the agent says "Your mailbox is locked on all your open Liaison apps; unlock it on any of them." The app you asked in answers like the others: the agent reads any of your mail it needs, including a conversation it found through a contact or a ticket, whether or not you opened it in Mail. Only your own signed-in apps are asked: another person, an admin included, never receives the request and cannot answer it. A read asked by an app you connected over MCP (Claude desktop, Claude Code) is answered the same way, without asking, while your mailbox is unlocked and **Let the assistant read this mailbox** is on ([MCP](../developers/mcp.md)). Turning mail into a ticket still needs your yes in the app you asked in, and only for mail that turn showed. A read of a few messages waits up to 45 seconds; each message past five adds 3 seconds.

Each mailbox row says **Transparent** or **Private**. **Make private** re-encrypts a transparent mailbox so only you can read it (you set a mailbox password first if you have none): its messages, drafts, conversation previews and attachments. **Make transparent** re-encrypts a private mailbox with its own server key: choose **Email me a code** and enter the 6-digit code we email you to confirm it's you, then your unlocked browser decrypts the mail and hands it back to be re-encrypted, so keep the page open until it says it is done. The server checks each message and attachment it gets back against the encrypted copy it holds, so nothing but the real content of your mailbox can be written. When the move is done, you get a notice in your feed saying the mailbox is now transparent; if you did not make the change, change your password and sign out your other sessions. Either way the mailbox keeps working while it changes, and switches mode only once everything is re-encrypted. If it stops part way (you closed the page, the server restarted), the row shows **Finish making private** or **Finish making transparent**: choose it to carry on. The agent can also make your mailbox private from a conversation, when you ask it to.

A routine reads your transparent mailbox only if you set it up and nobody else changed it since, and only on its schedule, its event or when you run it yourself. A routine someone else created to run as you, or edited, or ran for you, cannot read it.

A mail admin decides whether private mailboxes are allowed, with **Allow private mailboxes** in the same section. Turning it off makes new mailboxes transparent; mailboxes that are already private stay private.

On a self-hosted Liaison, `MAILBOX_ENCRYPTION_DEFAULT` (`managed` or `private`) sets the default for people who have not chosen. It is a default, not a lock: people can still pick the other mode. Unset, it is decided once and kept: a Liaison where someone had already set up a private mailbox stays private, any other is transparent. `MAILBOX_ENCRYPTION_ALLOW_MANAGED=false` locks every personal mailbox to private. See [Docker](../self-hosting/docker.md#mail-encryption) and [Security](../security.md#mail-encryption).

## Read and organise email

1. Click **Mail** in the activity bar.
2. Use the sidebar to switch between **Inbox**, **Assigned to me**, **Starred**, **Sent**, **Drafts** and **Trash**.
3. Use **Search conversations...** at the top of the list to filter by text. The search covers the whole folder, not only the conversations already loaded in the list: after you type two characters or more, conversations further down are found too ("Searching all conversations…" shows while it runs). For a private mailbox the text is searched in your browser, and only the matching message ids are sent to the server.
4. Switch between **All**, **Primary** and **Other** when the category switch is shown.

A card number in an email is hidden before the email is stored: it shows as `•••• •••• •••• 4242`, a security code next to it as `•••`, and the email ends with "[A card number was hidden.]". Order and invoice numbers, tracking numbers, SIRET and SIREN numbers, VAT numbers, IMEIs, IBANs and phone numbers stay as written: a number counts as a card only when its first digits and its length match a card network, and a number right after a label such as SIRET, IMEI, order or invoice is never taken for one. In a private mailbox with end-to-end encryption the server never holds the text, so it is hidden where an agent reads the email instead.
5. Hover a row to **Claim** it (assign it to yourself), **Mark read** or **Mark unread**, **Archive** it, or **Star** it.

An open conversation catches up after a connection drop: mail that arrived while you were offline shows once the app reconnects.

Earlier emails quoted under a message are folded away. Click **··· N earlier emails** to list them, one row each: an email already in the conversation shows **In this thread ↑**, which takes you to it, and any other shows its text. **Show original** shows the quoted part as it was sent. A reply sent from Liaison is always shown whole.

### Find your place in a long conversation

On a computer, a conversation longer than about two and a half screens shows a thread map on its right: one block per message, with a band over the part you are reading. Hover the map to see who wrote each message, when, and its first line. Click a block or a line to jump to the top of that message, or drag on the map to scroll.

On a phone, tap **Open thread map** in the top bar (shown from 3 messages), or the position pill that appears while you scroll. **This conversation** lists every message; tap one to jump to it.

## Reply, forward and write email

1. Open a conversation and click **Reply…**, **Reply all** or **Forward**.
2. Write your message. You can attach files.
3. Click **Send**.

To start a new message, click **Compose** in the sidebar, fill in **From**, **To**, **Cc/Bcc** and **Subject**, then **Send** or **Discard**. Email you write yourself is sent directly. Only agent drafts wait for approval.

A message is sent once, however many times **Send** is pressed or retried: Liaison waits up to 2 minutes for Gmail or the SMTP server to accept it. While a send is under way, another **Send** of the same message says "This message is still being sent. Wait a moment, then check Sent." If the mail provider never confirms a message that had already left, the composer keeps it and says it may already have been delivered: check **Sent** first, then press **Send** again only if you want it sent anyway. A message the provider refused was not sent, and **Send** tries again.

From a conversation you can also **Convert to ticket**, which moves it into [Tickets](tickets.md), or **Discuss**, which opens a chat with your agent about it.

## Have an agent draft a reply

1. Ask your agent to draft a reply, for example "Draft a reply to the latest email from orders@resonantaudiolabs.example".
2. The agent finds the conversation, checks [Knowledge](knowledge.md) for any policy it cites, and calls `mail__reply`.
3. The draft appears as a pending approval. You review it, edit it if needed, and approve it to send. See [Approve what agents do](../agents/approvals.md).

An agent's draft can attach files by their id, or a file an earlier step of the same approval request creates (a quote's PDF, for example), cited by that step's reference.

On **Home**, a draft's row says what the check before sending says. A draft held by an automatic reply leaves **Home** until the hold ends; one the check stopped shows why and offers **Dismiss** only, and neither counts in the number on **Home** (see [Approve what agents do](../agents/approvals.md)). An app that declares a `pill` for the kind of record a mail is about names the row with it.

There is one pending reply draft per conversation. A new agent draft replaces your own waiting draft. It is refused when a colleague's draft is already waiting.

If the agent's turn is refused because the server restarts, the mail app sends it again once, after the wait the server asks for (a second, at most five).

### The check before an agent's mail goes out

When you approve an agent's draft, Liaison looks at the conversation once more before it sends:

- **A reply came in** after the draft was written: the draft is not sent, and the row says who replied. A reply from a colleague of the recipient counts too: anyone whose contact is at the same company, including someone who became a contact after the draft was written.
- **A delivery failure came back** for the address: not sent.
- **An automatic reply came in** (an out-of-office, for example): the draft is held until the return date the message states, or for a default wait when it states none, then it comes back to **Home** by itself. The card offers **Send now** in place of **Approve**. **Send now** sends anyway; Liaison checks again first, and a reply or a failure that arrived since still stops it.
- **A recipient opted out of commercial mail**: not sent, and the card asks you to remove them from the recipients or leave the draft unsent.
- **The record the mail is about says not to send it**: not sent. An app that holds such records says why in its own words.

A stop caused by a reply or a failure is final: approving the same draft again cannot pass, so the card offers **Dismiss** only. If the check itself could not run, the card says so and you can try again shortly.

The check can only see mail Liaison has already imported. A reply that reached the mailbox but has not synced yet (a few minutes at most, see [What an IMAP mailbox keeps in step](#what-an-imap-mailbox-keeps-in-step)) is not seen, so a draft approved in that window can still go out. The check narrows the risk; it does not remove it.

The check applies to drafts written by agents only. A message you write yourself in the composer is sent as you send it, and is never held or stopped by it.

### Record an opt-out

When someone asks to receive no more commercial mail, ask your agent to note it (tool `mail:suppression_add`). Anyone who can write mail can record one. Liaison keeps only a fingerprint of the address, never the address itself. Drafts of commercial mail already waiting for that address are withdrawn at once, and the check before sending refuses any new one. A service message, such as an invoice or an order update, still goes.

When someone answers a mail asking to stop ("unsubscribe", "stop", "ne plus recevoir", "abmelden", "darme de baja", "cancellami" and other phrases in English, French, German, Spanish and Italian), Liaison raises an opt-out request for approval in the name of the mailbox's owner (for a shared mailbox, the person who connected it). Nothing is recorded until someone approves it, and each person gets one request however often they ask. A short reply counts; in a longer one the phrase must stand on a line of its own, and text quoted from an earlier mail never counts. Newsletters, automatic mail and the history imported when a mailbox is first connected raise no request. A sealed mailbox's mail cannot be read, so its replies raise no request: its reply still stops the draft it answers, and the opt-out is then for a person to record.

A new sender whose address is at a company's domain is linked to that company, when exactly one company holds the domain. A conversation that starts with mail you send is linked to the contact of its first To address, when that address already has a contact; sending never creates one.

An agent can check up to 50 addresses at a time (`mail:suppression_check`, scope `mail:suppressions:read`). It says when and how each person opted out.

Lifting an opt-out (`mail:suppression_remove`) waits for a mail admin's approval. The card says who opted out, when and how.

### Commercial mail: identity, opt-out link and one recipient

A commercial mail is a follow-up, or a new message to someone the data marks as a prospect: a contact on an open deal (directly or through their company), recorded under professional interest, or added from a third party or an enrichment. The agent does not decide it; the recipient's record does. A reply in the person's own conversation is never commercial this way.

Before any commercial mail can go, set the organization's legal name and postal address in **Settings > Organization > Commercial identity** (or `email.commercialIdentity` in `liaison config apply`, the agent tool `kernel:config_email`). Until both are set, the agent is told that nothing was staged and where to set them.

Every commercial mail ends with that legal name and address, a link to stop commercial messages, and "or reply stop". The same link goes in the `List-Unsubscribe` header with `List-Unsubscribe-Post: List-Unsubscribe=One-Click`, so a mail client's unsubscribe button works too, on Gmail and on IMAP/SMTP mailboxes. Liaison adds all of it as the mail leaves, so an approver's edit cannot remove it. No tracking image is ever added.

A commercial mail goes to one person outside the organization, so each one gets their own link; colleagues may stay on copy. An agent's new message to someone who opted out is refused, commercial or not: it can still reply in that person's own conversation.

The same rules hold for a mail you write yourself. When a recipient of your new message is a prospect, the composer shows the lines that will be added below your text; you cannot remove them, and they leave with the mail with its own opt-out link and headers. Your mail still needs no approval. If that prospect opted out, or the mail names more than one outside person, the composer says so and the mail is not sent. A new message to someone who opted out but is not a prospect, such as a supplier, goes, and the composer shows that they opted out.

The footer is written in the recipient's language: the language recorded on their contact (`language` in its details), else the organization's language. English and French are available.

### Who commercial mail may go to

An agent's commercial mail goes only to someone whose contact records a lawful basis: consent, existing customer, professional interest, or a generic company address. The check refuses it, and names the person, when:

- no basis is recorded (contacts that existed before these fields have none until someone records one);
- the person is recorded as a consumer, or nobody recorded whether they are one, and the basis is not consent. With nothing recorded, a contact counts as a business only when it is linked to a company whose domain is a business one (not a free mail provider such as gmail.com, hotmail.fr or t-online.de) and its own address is on that domain; any other contact with nothing recorded counts as a consumer;
- their country's rule asks for consent and the basis is something else. The default rule is opt-out for France and consent everywhere else. A contact with no recorded country takes the country of its first current address that has one (verified addresses first), and with neither it takes the rule for everywhere else. The refusal names the countries where the rule is opt-out, so you know whether recording a country would help;
- two contacts at the same address record different bases. A person keeps one, by merging the contacts or correcting one.

A generic company address passes in France without a consumer status. A service message skips this check.

A mail you write yourself to a prospect is not stopped for a missing basis: you are the sender who answers for it. The composer says calmly that no basis is recorded for writing to that person commercially, and lets you record one on their contact from there; you can still send. An address that opted out stays refused for everyone. Under the message, the composer lists what is recorded about each recipient who is a contact: the basis, business or consumer, and whether they opted out; an agent mail's approval card shows the same line.

The first commercial mail to someone whose address did not come from them (recorded as from a third party, an enrichment, or with no recorded source) also says where the address came from and that they can object. Their contact then records that this notice went out, and later mails do not repeat it.

Every commercial mail is recorded in the audit log as it leaves: who approved it, a fingerprint of its text with the footer, the basis, its class and the opt-out check. The record holds no address.

Once a day, contacts recorded under professional interest that have sent no mail or ticket and had no deal for three years are listed on one Home item for each person who is both an admin and allowed to edit contacts. Nothing is deleted: you decide whether to keep them. Not now hides the item until next week; once read, it comes back only when the list changes.

The link opens a page that asks once and records the opt-out with one button. Opening the page changes nothing (mail scanners open links), and pressing again changes nothing more. The page shows the organization's legal name and address, never the recipient's address, in English or French. Links older than three years stop working.

## Scopes

| Scope | What it allows |
|---|---|
| `mail:accounts:read` | List connected mailboxes and their sync status |
| `mail:accounts:write` | Disconnect a mailbox |
| `mail:accounts:admin` | Turn mailbox types on or off, connect organization-owned mailboxes |
| `mail:conversations:read` | Search, read and export conversations |
| `mail:conversations:write` | Reply, forward, compose, archive, label and convert to ticket |
| `mail:drafts:read` | Read mail drafts |
| `mail:approve` | Approve, edit or deny the mail drafts agents propose |
| `mail:suppressions:read` | See who has opted out of mail |
| `mail:suppressions:write` | Lift an opt-out |

Mail's `member` role holds `mail:suppressions:read`, so everyone with the Full Member role sees who has opted out before writing to them. Anyone who holds `mail:conversations:write` can record an opt-out; lifting one stays with mail admins.

See the [scope reference](../reference/scopes.md) and [roles](../admin/roles.md).

## What agents can do

| Tool | What it does | Approval |
|---|---|---|
| `listAccounts` | List the mailboxes the person can use with their sync status, last sync error and next retry (hides disconnected ones by default) | No |
| `disconnectAccount` | Disconnect a mailbox (an agent connects one through the mail configuration change and a secret card) | No |
| `search` | Search conversations by text, sender, date range, contact, status, assignee or unread | No |
| `read` | Read a conversation, optionally with message bodies | No |
| `export_conversations` | Write a set of conversations to one downloadable CSV or Markdown file | No |
| `reply` | Reply to a conversation | Yes |
| `forward` | Forward a message with its attachments | Yes |
| `compose` | Write a new email. For a colleague, agents post in a Liaison conversation instead, unless you ask for an email | Yes |
| `archive` | Archive conversations | No |
| `setLabels` | Add or replace labels on conversations | No |
| `convertToTicket` | Turn a conversation into a ticket | No |

To read an attachment, the agent calls `kernel__mail_attachment_read` with the attachment's id from `read`. It returns the text of a PDF, Word, Excel or PowerPoint file, or a description of an image or a video. In a private mailbox, your unlocked Liaison window opens the attachment for that turn only and nothing about it is stored on the server; attachments over 25 MB are refused, a video can't be analysed yet, and a locked mailbox makes the agent ask you to unlock it.

See the [agent tool reference](../reference/agent-tools.md).
