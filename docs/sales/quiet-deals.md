---
title: Find deals that went quiet
description: "See which open deals have had no mail from the client for days, put a due date on what you owe them, and let a routine draft the follow-up."
---

A deal goes quiet when the client stops writing. This page shows where Liaison says so, what counts as silence, and what to set up so quiet deals do not wait for you to remember them.

## See quiet deals on the board

On a pipeline (see [Track deals on a pipeline](deals.md)), a card reads **Quiet for N days** (**Active today** when the client wrote today). In each open column the quietest deals come first. No colour marks them. The header says "Quiet deals come first in each column."

Silence counts whole days since the last mail **from** the client: from the deal's contact or from anyone at the deal's company. An automatic reply, a delivery failure or a bulk mail does not count. A deal with no mail from them counts from the day it was created. A deal with no person on it has no line.

A reader who cannot read mail sees no quiet line: nobody is shown a silence they cannot check. Mail Liaison has not imported yet is not seen (see [Mail](../apps/mail.md#what-an-imap-mailbox-keeps-in-step) for how often a mailbox is read).

Ask the agent: "which of my deals have been quiet for two weeks?". It uses `deals_followup_candidates`, which names the reason when a deal should not get a mail.

## Put a due date on what you owe

A deal is a task, so it has a **Due** date and an assignee. A task assigned to you that is past its date shows on **Home** as overdue, with the number of days. Set the date on the next step you owe the client; it does not depend on their silence.

## Let a routine draft the follow-up

The routine template `deal-followups` drafts a follow-up for each quiet deal. See [Follow up on quiet deals](follow-ups.md).
