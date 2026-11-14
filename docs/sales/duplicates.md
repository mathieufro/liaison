---
title: Find and merge duplicate contacts
description: "Merge two records of the same person in Contacts, let an agent find every duplicate for you, and mark senders you trust."
---

The same customer can end up in Contacts twice, for example once per email address. This page shows how to merge two contacts yourself, how to have an agent find the duplicates in your whole list, and how trusted senders affect the way mail links to contacts.

## Merge two contacts

A merge keeps one contact, the survivor, and permanently deletes the other. The contact you open is the one that goes away.

1. Open the duplicate contact, the one you want to remove.
2. Click **Merge with...**. The **Merge contacts** dialog opens.
3. Type in **Search contacts** and click **Search**. Pick the contact to keep.
4. For **Name**, **Email**, **Phone** and **Company**, choose the value to keep: the **Survivor** column or the **Duplicate** column. External ids from both records are kept, with the survivor's value winning when both have one. Metadata is combined.
5. Click **Continue**. The summary reads **<survivor> will absorb <duplicate>.**, shows how many mail conversations will be reassigned, and names the duplicate's email that will be discarded.
6. Click **Confirm Merge**. You see **Contacts merged**.

The duplicate's mail conversations, invoices, recurring invoice schedules and linked Stripe customers move to the survivor in the same step. A merge you start yourself runs at once, with no approval. It cannot be undone. Click **Back** on the summary to change your choices first.

## Let an agent find every duplicate

There is no find-duplicates button. Ask your agent, for example: "Find the duplicate contacts and merge the obvious ones."

The agent calls `contacts_find_duplicates`. It scans your contact list on the server. It compares emails without case, dots or `+tag` parts, folds accents, abbreviations and typos in names, and matches shared external ids. It returns clusters of contacts that look like the same person, each with a confidence:

| Confidence | Meaning | What the agent does |
| --- | --- | --- |
| `high` | The names agree and a second signal matches (same email, same company or a shared external id), or a shared external id alone | Proposes a merge |
| `needs_confirmation` | A shared surname with a different first name, or a name variant with nothing else in common | Lists it and asks you first |

The scan reads up to 500 contacts by default (`scanCap`, at most 1,000). The result says how many it scanned out of the total. When it did not reach them all, the agent must say so.

To merge, the agent calls `contacts_merge`. It names the survivor (`targetId`) and the contact to delete (`sourceId`), and can choose the survivor's name, email, phone and company (`resolvedFields`). The merge is gated: it files an approval that names which contact survives and which is deleted, and nothing happens until a person approves it. See [Approve what agents do](../agents/approvals.md).

| Tool | Scope | Approval |
| --- | --- | --- |
| `contacts_find_duplicates` | `kernel:contacts:read` | No |
| `contacts_merge` | `kernel:contacts:write` | Yes |

## Merge duplicate companies

Ask your agent, for example: "Arlon Studio and Maison Arlon are the same client, keep Maison Arlon." It calls `companies_merge` with the company to delete (`sourceId`) and the one to keep (`targetId`). The merge is gated: the approval card names both companies, both account managers and which one stays, and says that sharing does not widen.

When it runs, everything that named the deleted company names the kept one: its people (their company name follows), portal accounts, deals, pipelines and the approvals waiting on it, which then go to the kept company's account manager. The kept company keeps its own account manager; without one it takes the other's. Its discussion joins the kept company's. The merge is all or nothing, and it cannot be undone.

A company the organization sees cannot be merged into a restricted one: merge the other way round. A restricted company cannot be merged into one the organization sees either, nor into a company shared with someone it is not shared with, and a view-only company cannot be merged into an editable one: widen its sharing first, then merge. Someone still editing the deleted company is told **This company was merged into** the kept one.

| Tool | Scope | Approval |
| --- | --- | --- |
| `companies_merge` | `kernel:companies:write` | Yes |

## Mark a trusted sender

A trusted sender is an address or a whole domain your organization vouches for. Mail from it counts as verified when it carries no verdict of its own from the mail provider: for the acknowledgement email, desk routing, linking the mail to a contact and adding participants. A trusted sender also counts as a known guest on calendar invitations. Mail the provider marks as forged stays forged.

1. Open the contact. Next to its email, click **Trust this sender**.
2. Choose **Trust <address>**, or **Trust every address at <domain>**. A public mail provider's domain can only be trusted one address at a time.

The contact then shows **Trusted sender**. Click it and choose **Remove trust** to undo. The same control appears on a ticket's conversation.

Changing the list needs `kernel:contacts:admin` or `tickets:settings:admin`. Anyone with `kernel:contacts:read` or `tickets:tickets:read` sees it.

## Related pages

- [Keep customers and prospects in Contacts](contacts.md)
- [Tickets](../apps/tickets.md)
