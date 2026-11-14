---
title: Keep customers and prospects in Contacts
description: "Find the people you deal with in Contacts, edit their details, sort them into groups and share them with your team."
---

Contacts is Liaison's own directory of the people and companies you deal with. This page shows how contacts get there, how to find and edit them, how to group and share them, and what agents can do with them. Each person can belong to a [company](companies.md), which has its own page with a timeline, and deals are kept in [Projects](deals.md). To read deals from your own CRM instead, see [Connect your own CRM or ERP](connect-your-crm.md).

## What a contact holds

| Field | What it is |
| --- | --- |
| Name, email, phone, company | The fields you see and edit on the contact page. |
| Tags | Labels such as `prospect` or `dealer`. Agents set and filter by them. |
| External ids | The record's id in another system, for example its Shopify customer id. |
| Metadata | Free fields that have no column of their own, such as a website or a postal address. |

Each contact also has an owner and a sharing setting. See [Share a contact with your team](#share-a-contact-with-your-team).

## How contacts get into Liaison

There is no **New contact** button. Contacts appear on their own:

- **Mail you receive.** A sender in your personal mailbox becomes a contact that belongs to you alone. A sender in a shared mailbox becomes a contact visible to the people who can open that mailbox. Newsletters and no-reply senders are linked to an existing contact, never created.
- **Tickets.** A ticket's customer who is known only by an address becomes a contact shared with the ticket's team.
- **Agents.** An agent creates or updates a contact with `contacts_write`. The change waits in **Approvals** until a person approves it, unless an admin turned that off (see [Let agents edit contacts without approval](#let-agents-edit-contacts-without-approval)). A contact an agent creates is private to the person it works for until someone shares it.

A sender who already has a contact the whole organization can see is linked to it, never duplicated.

## Find a contact

1. Click **Contacts** in the activity bar.
2. Type in **Search people…**. Search matches the name, email and company.
3. Choose **People** to hide notification senders, or **All** to include automated senders. An automated sender carries the **auto** badge.
4. To narrow the list to a group, click the group under **Groups** in the sidebar. The list header shows **Group: <name>**. Click **Show all contacts** to clear it.

If a search under **People** finds nothing, click **Search all senders instead**.

## Edit a contact

1. Open the contact.
2. Under **Identity**, click **Name**, **Phone** or **Company** to edit it in place, then confirm. The email is shown but cannot be edited here.
3. The **Activity** section is the person's timeline: their mail, tickets, invoices, meetings and deals, newest first. **Follow-ups** says whether commercial mail to them is allowed. Their **Company** links to the company's page. See [Companies](companies.md#the-persons-own-page).

To delete a contact, click **More actions**, then **Delete contact**, then confirm **Delete this contact permanently?**. A contact that a recurring invoice schedule still bills cannot be deleted until that schedule ends or bills another person. Linked Stripe customers and ended schedules lose the link to the person.

## Discuss a contact with your team and agents

Every contact has a **Discussion**, like a task. On a wide screen it is the column to the right of the contact; on a phone it follows the contact's details.

1. Open the contact.
2. Under **Discussion**, type in **Write about …, or @ an agent**. Attach files, dictate with the microphone or proofread with the magic wand, as in every composer.
3. Click **Send**, or press Cmd+Enter (Ctrl+Enter on Windows and Linux).

Everyone who can see the contact reads and writes its discussion. A private contact's discussion is private, and when you change who a contact is shared with, its discussion follows. New messages, a teammate's or an agent's, appear without reloading the page.

To bring an agent in, type @ and pick it: it answers in the discussion, as in a task. An agent's message there is shown as the agent's and needs no approval. A change it proposes to the contact (`contacts_write`) or to your CRM waits for approval, as a card in the discussion.

Notes written on a contact before the discussion existed are in its discussion, with their author and date, and search finds them like any other message.

When you merge two contacts, the discussion of the one that goes joins the discussion of the one you keep: every message keeps its author and date, in the order it was written. Who reads it is then decided by the contact you keep. Deleting a contact deletes its discussion.

To fix a contact that exists twice, see [Find and merge duplicate contacts](duplicates.md).

## Organize contacts into groups

Groups are lists of contacts you pick by hand, for example dealers or prospects. A mail routine can react only to mail from a group (see [Research prospects and draft replies](research-prospects.md)).

**Create a group:**

1. In the **Contacts** sidebar, next to **Groups**, click **New group**.
2. Type the **Group name** and click **Create**.

**Add contacts to a group:**

1. In the contact list, tick the contacts you want. The bar shows **N selected**.
2. Click **Add to group** and pick the group.

Or open one contact and click **Add to group**. The menu ticks the groups the contact is already in. Click a ticked group to take the contact out of it.

## Share a contact with your team

A contact you own is private until you share it. The contact page shows its visibility: **Private**, **Organisation** or **Shared with you**.

1. Open the contact and click **Share**.
2. Under **General access**, choose one:
   - **Private**: only you and the people added above.
   - **Anyone in the organisation can view**: adds it to the organisation's contacts, read only.
   - **Anyone in the organisation can edit**: adds it to the organisation's contacts.
3. Optionally, add people under **Add people…** or roles under **Add roles…**, each as **Viewer** or **Editor**.
4. Click **Save**.

Only the contact's owner changes its sharing. For a contact nobody owns, such as a shared-mailbox contact, a contacts admin (`kernel:contacts:admin`) does. Editors edit, they never re-share. Once a ticket, an invoice or another mailbox's conversation uses an organisation contact, it cannot be made private again.

## What agents can do with contacts

Gated tools file an approval and do nothing until a person approves them. See [Approve what agents do](../agents/approvals.md).

| Tool | What it does | Scope | Approval |
| --- | --- | --- | --- |
| `contacts_search` | Search by name, email or company. Filters: `tag`, `notContactedSince`, `createdWithinDays`, `hasNoCompany`, `hasNoPhone`, with cursor paging | `kernel:contacts:read` | No |
| `contacts_read` | Read one contact with its mail and timeline | `kernel:contacts:read` | No |
| `contacts_write` | Create or update a contact, including tags, external ids and metadata. The card shows the contact and each field with its new value | `kernel:contacts:write` | Yes |
| `threads_reply` with `contactId` | Post in a contact's discussion (what it learned about the person, what they asked for, the next step), as the agent | `kernel:threads:write` | No |
| `contacts_export` | Export the contacts you can see to a CSV file, all of them or one group or tag | `kernel:contacts:export` and `kernel:contacts:read` | Yes |
| `contacts_share` | Change who a contact is shared with | `kernel:contacts:write` | Yes |
| `contacts_find_duplicates`, `contacts_merge` | Find and merge duplicates | see [Find and merge duplicate contacts](duplicates.md) | Merge only |
| `contacts_groups_list`, `contacts_group_members` | List groups and their members | `kernel:contacts:read` | No |
| `contacts_group_create`, `contacts_group_rename`, `contacts_group_add`, `contacts_group_remove` | Create, rename and fill groups | `kernel:contacts:write` | No |
| `contacts_group_delete` | Delete a group (its contacts are kept) | `kernel:contacts:write` | Yes |
| `contacts_addresses_list` | List a contact's postal addresses with their verification | `kernel:contacts:read` | No |
| `contacts_address_upsert` | Add or change an address. It is always saved as not verified | `kernel:contacts:write` | Yes |
| `contacts_address_verify` | Propose to mark an address verified, with its source. No auto-approve policy skips it | `kernel:contacts:write` | Always |

Export happens only through an agent. There is no export button. The agent returns the CSV as a file.

### Let agents edit contacts without approval

An agent's contact edits wait for a person by default. An admin can let them run at once with an auto-approve policy on the tool, like any gated tool: ask the agent to set one for `kernel:contacts_write`, then approve the **Set auto-approve policy** request. Setting a policy needs `kernel:policies:admin`. Like any gated action, an edit still waits for a person once the conversation has read data that needs a scope, such as a contact search. See [Let low-risk actions skip approval](../agents/approvals.md#let-low-risk-actions-skip-approval). A person editing a contact themselves never waits for approval.

`contacts_write` writes to Liaison's own contacts, never to your CRM. A change in your CRM goes through the API connector and its approval. See [Connect your own CRM or ERP](connect-your-crm.md).

## Keep verified postal addresses

A contact has an address book: billing, delivery and other addresses. An address is either **verified** (a person checked it against a source, such as a purchase order, an email or a phone call) or not verified. A shipping app reads the book through `contacts_addresses_list` and can tell the two apart.

- An address that is added, imported or copied from an order is never verified.
- Changing the name, company, street, city, postal code, region or country of a verified address makes it not verified again. Changing its phone or email keeps the verification.
- Only a person verifies. Through the API, `POST /api/contacts/<id>/addresses/<address id>/verify` with a `source` (`purchase_order`, `email`, `phone_call` or `other`), an optional `note` and an optional `fileId` records the signed-in person as the verifier. A restricted device session (a command-line tool or an agent on a computer) is refused.
- An agent can only propose it with `contacts_address_verify`. The approval card shows the full address, the source, the note and a link to the source file. No auto-approve policy skips it, not even one on `kernel:*`, and the person who approves is recorded as the verifier. Agents are told never to verify from an email alone.
- The source file must be one you can open.
- Apps cannot verify. An app's screen works with your sign-in, so Liaison refuses the verify action to every app, built in or added: it happens only on the contact page or through an agent's approval card.

### Manage addresses on the contact page

Open the contact. Under **Addresses** each address shows its role (**Billing**, **Delivery** or **Other**) and **Not verified**, or who verified it, when and against what, for example "Verified 2 Nov 2026 by Ada Martin from a purchase order".

1. Click **Add an address**, fill in the fields and click **Save**. A new address is not verified.
2. To verify one, click **Verify**, choose what you checked it against (**Purchase order**, **Email**, **Phone call** or **Other**), add a note and, if you want, a file stored on the contact, then click **Mark verified**.
3. Click **Edit** to change an address, **Mark stale** when it may be out of date, or **Archive** to remove it from the list.

If you can see a contact but not edit it, you see its addresses without these buttons.

## Review prospects who have gone quiet

Once a day, contacts recorded under professional interest that have sent no mail or ticket and had no deal for three years are listed on one Home item, for each person who is an admin and can edit contacts. Liaison deletes nothing: open the list and decide whom to keep. Not now hides the item until next week; once read, it comes back only when the list changes. Which contacts may get commercial mail at all is in [Mail](../apps/mail.md).

## Scopes

| Scope | What it allows |
| --- | --- |
| `kernel:contacts:read` | Read contacts |
| `kernel:contacts:write` | Write contacts |
| `kernel:contacts:export` | Export the contact registry |
| `kernel:contacts:admin` | Change who can see contacts nobody owns (shared-mailbox and imported contacts), and manage trusted senders |

See [Control what agents can access](../agents/permissions.md) and the [scope reference](../reference/scopes.md).
