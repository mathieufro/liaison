---
title: Rank your leads
description: "Ask the agent to rank contacts and companies from what Liaison knows, and keep the result as a tag or a field you can filter by. Liaison has no score field and no sort by score."
---

Liaison does not calculate a lead score, has no score column and cannot sort a list by one. What it gives you is the facts a score rests on, in one place, and tags and fields to keep your own ranking.

## What the agent can look at

- The person and their company: `contacts_read`, `companies_read` (account manager, people, main contact, newest open deal).
- What happened: `company_timeline`, the mail, tickets, invoices, meetings and deals of a company or a person (see [Companies](companies.md)).
- The pipeline: `deals_search` and `deals_rollup` (see [Track deals on a pipeline](deals.md)).

Ask in plain words: "Which of the people at companies with an open deal wrote to us this month?" The agent reads these and answers from what it finds. A reader who lacks the scope for an app does not get that app's rows.

## Keep the ranking

Ask the agent to record what it decided:

- A **tag** on a contact or a company, such as `hot` or `prospect`. Search contacts by tag with `contacts_search` (filter `tag`), or put them in a group (see [Keep customers and prospects in Contacts](contacts.md)).
- A free **metadata** field on either, for a number or a note the agent should reuse.

Changing a contact waits for approval, unless an admin turned that off; changing a company always does.

## What it does not do

There is no automatic score, no list ordered by score and no rule that acts on one. Contacts are listed by their latest activity.
