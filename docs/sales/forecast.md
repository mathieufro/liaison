---
title: Forecast your pipeline
description: "Ask the agent for deal counts and sums per stage, owner or month, one sum per currency, with an optional weighting by probability."
---

There is no forecast screen. You ask the agent, and it sums your deals with `deals_rollup`. This page shows what to ask and how to read the answer.

## Ask

- "What is open in the Partners pipeline, by stage?"
- "How much did we win per month this year, by month?"
- "What does each person have open, weighted by probability?"

The agent groups by **stage**, **owner** or **month**, for one pipeline or all of them, and can limit the deals to a close date window.

## Read the answer

- Each group has a **count** and a **sum per currency**. Euros and dollars are never added together or converted.
- The **month** of a closed deal is the month it closed; an open deal is counted in the month it was created. Months follow the organization's timezone.
- With **weighted**, each group also gives its sum multiplied by each deal's probability (a deal with no probability counts 0). The probability is a whole percent on the deal; ask the agent to set it, or see [Track deals on a pipeline](deals.md).
- At most 500 deals are summed. When there are more, the answer says it is truncated, and the agent should say so.

## Who can ask

The tool needs `projects:deals:read`, held by the `sales` and `lead` roles of Projects. Without it, the agent has no amounts to sum.
