---
title: Keep companies and see everything about one
description: "Open a company in Contacts to see its people, its open deal, and one timeline of its mail, tickets, invoices, meetings and deals, and change its account manager, sharing and duplicates."
---

A company groups the people you work with there. Its page shows what is going on with all of them in one place. This page shows how to find a company, what its page holds, who looks after it, and how the person's own page fits in.

## Find a company

1. Click **Contacts** in the activity bar.
2. In the sidebar, click **Companies**. The number beside it counts the companies you can see.
3. Type in **Search companies...**. Search matches the name and the website domain. The list shows the latest activity first.

Each row says what the company is to you in one line: its domain, its newest open deal with its stage and amount (or **No deal**), and how many people work there. A row marked **Possible duplicate** is explained on the company's page (see [Merge two companies](#merge-two-companies)).

Click **New company**, type its name, add its **Website domain** if you know it, and save. When your contacts already name companies that do not exist yet, the empty list says how many and offers to ask the agent to create them.

A company is visible to everyone, to some people, or only to you. The page says which: **Visible to the whole team**, **Shared with some people** or **Only you see this company**. If a company is not shared with you, its link opens **No access**.

## What the company's page shows

- **Account manager**: the person who looks after it, with **away until** and a date when they are away. Anyone who can edit companies changes it with **Change the account manager**. When the change needs approval, the page says **Sent for approval. The account manager changes once it is approved.** The company may also say **Relationship ended**.
- **Waiting**: the approvals about this company that wait for someone, shown as on **Home**.
- **People**: everyone linked to the company, with its **Main contact**. Eight are shown; **Show all** lists the rest. With no people yet, **Ask the agent to find people here** and **Link past mail from this domain** ask the agent to link them.
- **Deals**: its newest open deal, with its stage and amount. Click it to open the deal. With none the page says **No open deal.**
- **Money**, **Support** and **Work**: its documents, its open tickets and its projects with their open tasks, each shown only to people who can read that app (see [Invoicing](../apps/invoicing.md), [Tickets](../apps/tickets.md) and [Projects](../apps/projects.md)).
- **Timeline**: see below.
- **Discussion**: a conversation about the company. An agent you mention reads the page first.

On a phone the page has three tabs: **Overview**, **Timeline** and **Discussion**.

## The timeline

The **Timeline** lists, newest first, what happened with the company's people and its deals: **Mail**, **Tickets**, **Invoicing** (documents issued, paid and credited, and the recurring schedules that bill them), **Calendar** meetings and **Deals** opened and closed. Each app answers for what you may read there. The filter lists only the apps that returned something; **All activity** clears it.

If one app does not answer, the page says "<app> did not answer, so its activity is missing here. The rest is up to date." The page asks that app once more on its own a moment later, and its activity replaces the notice when it answers; **Retry** asks again by hand. For a company with many people, the page says it shows the most recently active people, and older deals are said to be missing from the timeline. **Show older activity** loads the next page.

Ask the agent for the same list with the tool `company_timeline`.

## Add a person, share, merge or delete

The buttons at the top of the page need `kernel:companies:write` and a company you may change.

- **Add person**: search for a contact and add them. Their company becomes this one.
- **Share**: choose who sees the company. See below.
- **Merge with...**: see below.
- **More actions**, then **Delete**: removes the company and its discussion. Its people keep the company name as text but lose the link, and its deals and pipelines stop naming it. A company that has portal accounts cannot be deleted until they are removed or moved, nor one that a recurring invoice schedule still bills until that schedule ends or bills another company. Linked Stripe customers and ended schedules lose the link.

### Share a company

1. Open the company and click **Share**.
2. Add people with **Add people…**, and pick **Viewer** or **Editor** for each.
3. Under general access, pick **Private**, **Anyone in the organisation can view** or **Anyone in the organisation can edit**.
4. Click **Save**.

Only the person who created the company can change its sharing. For a company whose creator is no longer active, or that nobody created (an import), someone with `kernel:contacts:admin` can. Everyone else sees the dialog read only. A company nobody created stays visible to the organisation; you can still share it with people. Being its account manager gives no access.

### Merge two companies

1. Open the duplicate and click **Merge with...**.
2. Search for **the company to keep** and click **Merge into <name>**.
3. Confirm. The company you opened goes into the one you keep: its people, deals, recurring invoice schedules, linked Stripe customers and discussion move there, and the opened one is deleted.

The page says it merges in a few seconds and offers **Undo** until then. A page that shows **Looks like the same company as <name>** names the reason (the same web domain, a name typed two ways, or both) and merges nothing until you say so. **Keep them separate** stops the suggestion. Agents find duplicates with `companies_find_duplicates` and merge with `companies_merge`, which waits for approval.

## The person's own page

Open a person from the company, or from **Contacts**. Their page links to their company and shows its line (its domain or its open deal). Below, **Activity** is the same timeline limited to what involves this person, with the note "Only what involves <name>. Everything at the company is on <company>." A reader without `kernel:companies:read` sees no timeline. For a person without a company, the note is left out.

**Follow-ups** says what commercial mail to this person rests on:

| The page says | What it means |
| --- | --- |
| **Opted out of commercial mail.** with the date and how | Commercial mail to this person is stopped. See [Opt-outs](opt-outs.md). |
| **No recorded basis. Commercial follow-ups skip this person.** | No lawful basis is recorded on the contact yet. |
| **Sales follow-ups allowed: <basis>.** | The basis recorded: **they agreed to them**, **existing customer**, **professional interest** or **generic business address**, with the date. |
| **Opt-out status could not be read. Commercial follow-ups wait for it.** | The check failed; nothing goes until it can be read. |

Invoices and account messages always go out.

## What agents can do

| Tool | What it does | Approval |
| --- | --- | --- |
| `companies_search`, `companies_read` | Find a company, and read its account manager, people, main contact and open deal | No |
| `companies_write` | Create or change a company, or set its account manager | Yes |
| `companies_propose_from_contacts` | Group people who have no company by their company text and mail domain | No |
| `companies_link_contacts`, `companies_link_batch` | Link people to a company, or create several companies and link their people | Yes |
| `companies_find_duplicates`, `companies_mark_not_same` | Find duplicates, and stop suggesting a pair | No |
| `companies_merge` | Merge a duplicate into another | Yes |
| `company_timeline` | A company's or a person's timeline | No |

See the [agent tool reference](../reference/agent-tools.md) and [Find and merge duplicate contacts](duplicates.md).
