---
title: Contacts
description: "Find the people you work with, edit their details, see their mail and tickets, group, share and merge contacts, and mark trusted senders."
screenshot: "assets/screens/contacts.webp"
screenshotAlt: "The Contacts list showing people with their email addresses and the time of the last activity."
---

Contacts is the list of people your organization deals with. It fills itself: contacts appear as you exchange mail or when an agent mentions someone. You edit, group, share and merge them here, and agents read and update them for you.

For sales workflows built on Contacts, see [Keep customers and prospects in Contacts](../sales/contacts.md), [Keep companies and see everything about one](../sales/companies.md) and [Find and merge duplicate contacts](../sales/duplicates.md).

Companies are the second list of Contacts: click **Companies** in the sidebar.

## Find a contact

1. Click **Contacts** in the activity bar.
2. Type in **Search people…**.
3. Use the filter to switch between **People** (hides notification senders) and **All** (includes automated senders). Senders detected as notification or no-reply addresses carry an **auto** badge.
4. In the sidebar, pick a group under **Groups**, or **All contacts**.

From a row you can start an **Email** or a **Call**.

## Edit a contact

1. Open the contact. Click any field to edit it: **Name**, **Email**, **Phone**, **Company**.
2. Save your change.

Under **Addresses** you add, edit, verify, mark stale or archive the contact's postal addresses. See [Keep verified postal addresses](../sales/contacts.md#keep-verified-postal-addresses).

Under **Activity** you see the person's timeline: mail, tickets, invoices, meetings and deals. **Follow-ups** says whether commercial mail to them is allowed. Click their company to open its page. See [Companies](../sales/companies.md).

To delete a contact, open **More actions** and click **Delete contact**.

## Group contacts

1. In the sidebar, under **Groups**, click **New group**, enter a **Group name** and click **Create**.
2. To add people, select contacts in the list and click **Add to group**, or use **Add to group** on a contact.

Deleting a group keeps its contacts.

## Share a contact

1. Open the contact and click **Share**.
2. Choose who can see it, for example everyone with access to a shared mailbox.

A contact becomes the organization's only when it is shared.

## When an account manager changes

When a company is given to someone else, its previous account manager gets one row on **Home** naming who gave which companies to whom. When an account manager is deactivated, the admin who does it says who takes their companies over (see [Deactivate a user](../admin/users.md#deactivate-a-user)).

## Merge duplicates

1. Open one of the contacts and click **Merge with...**.
2. Search for the duplicate and pick which record survives (**Survivor**) and which is the **Duplicate**.
3. Review the comparison and click **Confirm Merge**.

External IDs are combined, with the survivor winning on conflicts. Agents can find duplicates across the whole list. See [Find and merge duplicate contacts](../sales/duplicates.md).

## Trust a sender

On a contact, click **Trust this sender** to trust the address, or every address at its domain. A trusted sender counts as verified for inbound mail that arrives without a provider verdict, and as a known guest for calendar invitations. Public mail domains such as gmail.com can only be trusted address by address. The trust actions are shown to people who hold the contacts or tickets settings admin scope.

## Clean up contact ownership from the command line

Four commands fix contacts that personal mailboxes created as shared org contacts. They need the org id (`--org <uuid>`). Each one that changes data writes a backup file first, and has a matching restore command. See the [CLI reference](../reference/cli.md#contacts-privatize-mailbox-senders).

| Command | What it does |
| --- | --- |
| `liaison contacts privatize-mailbox-senders --org <uuid> [--print-sql \| --execute --backup <new file>]` | Makes org contacts that personal mailboxes created private to their owner again. Nothing is deleted. Dry run unless `--execute`. |
| `liaison contacts restore-privatized-senders --org <uuid> --backup <path>` | Puts back what the command above changed, from its backup. Skips a contact whose address has an org contact again. |
| `liaison contacts apply-provenance --org <uuid> --delete-unused-created-by <uuid> --orphans-to <uuid> [--actor <uuid>] [--plan-out <new file> \| --execute --plan <json> --backup <new file>]` | Applies your decisions on a contacts provenance report in one transaction: deletes unused contacts created by one person, makes contacts whose creator no longer exists private to another user, and privatizes every personal-source contact to its mailbox owner. Dry run unless `--execute`. |
| `liaison contacts restore-provenance --org <uuid> --backup <path>` | Puts back everything `apply-provenance` changed, from its backup. |

Run `apply-provenance` once without `--execute` and review the plan. With `--execute` you pass that reviewed plan in `--plan`; the command recomputes it under row locks and refuses if it differs.

## Scopes

Contacts is part of the core workspace, so its scopes are kernel scopes.

| Scope | What it allows |
|---|---|
| `kernel:contacts:read` | Read contacts |
| `kernel:contacts:write` | Write contacts |
| `kernel:contacts:export` | Export the contact list |
| `kernel:contacts:admin` | Change who can see contacts nobody owns (shared-mailbox and imported contacts) |

See the [scope reference](../reference/scopes.md).

## What agents can do

| Tool | What it does | Approval |
|---|---|---|
| `contacts_search` | Search contacts by name, email or company | No |
| `contacts_read` | Read a contact with recent mail and timeline, and one line per other app that holds records for them (only what you may read there) | No |
| `contacts_write` | Create or update a contact | Yes, unless an auto-approve policy covers it |
| `threads_reply` with `contactId` | Post in a contact's discussion, as the agent | No |
| `threads_create` with `createdFrom` naming the contact | Post in the contact's discussion, as the agent: the same conversation, never a second one | No |
| `contacts_export` | Export the contacts you can see to a CSV file | Yes |
| `contacts_find_duplicates` | Find likely duplicates across the whole list | No |
| `contacts_merge` | Merge two duplicate contacts | Yes |
| `contacts_share` | Change who a contact is shared with | Yes |
| `contacts_groups_list`, `contacts_group_members` | List groups and their members | No |
| `contacts_group_create`, `contacts_group_rename`, `contacts_group_add`, `contacts_group_remove` | Create, rename and fill groups | No |
| `contacts_group_delete` | Delete a group (the contacts are kept) | Yes |

## Import contacts

Contacts import as the `contacts.contact` kind: one record per contact with its source id (`externalId`). A contact already known by that id or by its email is skipped and left unchanged. Importing contacts needs `kernel:contacts:write`. Each import is a run you can undo from **Settings › Organization › Imports** (see [Undo an import](../admin/settings.md#undo-an-import)).

See the [agent tool reference](../reference/agent-tools.md).
