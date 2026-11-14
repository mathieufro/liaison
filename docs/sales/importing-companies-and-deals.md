---
title: Import companies and deals
description: "Bring companies, deals and the company of each contact in from another CRM or a spreadsheet, preview the run, and undo it."
---

You can move your companies and deals into Liaison from another tool. An import is the same run as any other import in Liaison: the agent or you pick a transform, preview what it would do, start it, and can undo it. This page shows what each kind takes.

For the steps of a run (the transform, the preview, **Start import** and **Undo**), see [Import from another tool yourself](../admin/settings.md#import-from-another-tool-yourself) and [Import from another tool](../agents/tools.md#import-from-another-tool).

## The three kinds

| Kind | What it imports | Needs |
| --- | --- | --- |
| `contacts.company` (**Companies**) | `externalId` and `name`, plus `domain`, `description` and `tags` | `kernel:companies:write` |
| `contacts.contact` (**Contacts**) | As before, plus `companyName` and `companyDomain` to link the person | `kernel:contacts:write` |
| `projects.deal` (**Deals**) | `externalRef`, `pipeline` and `title`, plus the stage, company, contact, owner, amount, probability, next step and lost reason | `projects:tasks:write` and `projects:projects:write`, and `projects:deals:write` for amounts |

## How a company is found

A company's domain is the website domain without `www`; a personal mail domain such as gmail.com is not saved and the record carries a notice. A contact or a deal that names a company is linked to the one with that domain, else the one with that name, among the companies you can see: a restricted company you cannot see is never matched, named or linked into. When there is none, the import creates it, and the preview counts it. A company you cannot write is never created.

A record that was imported before, by its `externalId` (`externalRef` for a deal), is skipped and left unchanged. Importing again does not duplicate.

## How a deal is placed

- The **pipeline** is found by its exact name, and created with the default stages when it does not exist (see [Track deals on a pipeline](deals.md)). A project that is not a pipeline refuses the record.
- The **stage** is found by its label in that pipeline. An unknown stage refuses the record and names the stages; with none, the deal goes to the first stage. A lost stage keeps the **lost reason**.
- The **contact** is found by email. An unknown one is reported and the deal is still imported.
- The **amount** is whole minor units (cents) with a three-letter currency, once, per month or per year; an amount needs its currency. It needs deal write access.

## Preview and undo

A preview runs the same checks without writing, and lists each refused row with its error. **Undo** deletes what the run created: a deal goes with its task, discussion and amount, and a company only when nothing else uses it.
