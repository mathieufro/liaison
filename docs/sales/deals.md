---
title: Track deals on a pipeline
description: "Keep deals on a board with stages, an amount, a company and a next step, mark them won or lost, and let agents search, create and change them."
---

Liaison keeps deals in [Projects](../apps/projects.md): a sales pipeline is a project whose board shows deals, and a deal is a task with an amount, a company and a contact. This page shows how to set up a pipeline, what a deal holds and who may see its amount.

## Set up a pipeline

Ask the agent: "create a sales pipeline called Partners". It uses `deals_pipeline_create` and makes a board with the stages **Lead**, **Qualified**, **Demo**, **Proposal**, then **Won** and **Lost**. A deal import creates a missing pipeline the same way (see [Import companies and deals](importing-companies-and-deals.md)). A pipeline's closing stages, Won and Lost, stay in place.

Under its name the pipeline says how many deals are open and their total, for example "9 open deals, €68,660". One total is given per currency; two currencies are never added together. Click **New deal** to add one.

## What a deal holds

Open a deal. The **Deal** panel shows:

- **Amount**: a sum in one currency, once, **per month** or **per year**.
- **Company** and **Contact**: the company's page lists the deal, and the deal counts for the company's people.
- **Next step**: one line, shown on the card as **Next:** and the step.
- The owner is the deal's assignee, shown by initials on the card.
- A probability, a whole percent from 0 to 100, set by the agent. It feeds the [forecast](forecast.md).

**Mark won** and **Mark lost** close the deal, **Mark lost** with an optional reason (**Why was it lost? (optional)**). **Reopen** puts it back. You can also drag a card to **Won** or **Lost**. A deal is never a subtask.

## Who sees the amount

Seeing deals is part of seeing tasks. Seeing and changing **amounts and probabilities** takes `projects:deals:read` and `projects:deals:write`, held by the `sales` and `lead` roles of Projects. Without them a card reads **Needs deal access**, column sums are hidden, and the agent's answers leave the amounts out. See [Projects](../apps/projects.md) for the roles.

## Name a client on a project

For work that is not a deal, open **Edit project** and pick the company in **Client (optional)**. The company's page lists that project under **Work**.

## What agents can do

| Tool | What it does | Approval |
| --- | --- | --- |
| `deals_pipeline_create` | Create a pipeline with the stages above | No |
| `deals_search` | Find deals by pipeline, company, contact, outcome or close date | No |
| `deals_update` | Change a deal's company, contact, amount, probability, next step or outcome | No |
| `deals_rollup` | Counts and sums per stage, owner or month (see [Forecast](forecast.md)) | No |
| `deals_followup_candidates` | Open deals quiet for a number of days, with the reason not to write to each | No |

Create a deal with the Projects tools, as a task in the pipeline. See the [agent tool reference](../reference/agent-tools.md).

Related: [Quiet deals](quiet-deals.md), [Follow-ups](follow-ups.md), [Companies](companies.md).
