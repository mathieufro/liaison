---
title: Follow up on quiet deals
description: "Turn on the routine that drafts a follow-up for each quiet deal from the deal owner's mailbox, and see what stops a draft before it goes out."
---

The routine `deal-followups` writes the follow-ups you would otherwise forget. It only drafts: nothing goes out until it is approved, by the deal's owner when it sends from their own mailbox, by the people who approve mail when it sends from a shared one. This page shows how to turn it on, who it writes to and what stops it.

## Turn it on

1. In your agent's routines, open **App templates** and find `deal-followups` (see [Routines](../agents/routines.md)), or ask the agent to enable it.
2. Choose how many quiet days it waits (7 if you choose none) and one pipeline, or all of them.
3. Approve the card. It names who approves the drafts, and lists the deals it would skip today and why.

Every weekday at 08:00, in the owner's timezone, it drafts one mail for each open deal that has been quiet at least that long (see [Find deals that went quiet](quiet-deals.md)).

## What a draft is

- It goes from the **deal owner's own mailbox**, signed by them. A deal whose owner's mailbox you cannot send from is skipped, and the run says so. It never goes from another mailbox instead.
- It waits on **Home** for the deal's owner to approve (the mail approvers, for a shared mailbox) (see [Approve what agents do](../agents/approvals.md)).
- It is a commercial mail: the footer with your legal name and address, the link to stop and one recipient. See [Opt-outs](opt-outs.md) and [Mail](../apps/mail.md#commercial-mail-identity-opt-out-link-and-one-recipient).

## Who it skips

A deal gets no draft when it has no person on it, when the person opted out (see [Opt-outs](opt-outs.md)), when no lawful basis is recorded or their country needs consent, when a draft is already waiting for the deal, when the mail cannot be read, or when the owner has no mailbox the routine can send from. The run's summary names each skipped deal and its reason.

## What stops a draft

Liaison looks at the conversation again when you approve the draft, and the draft is not sent when:

- anyone at the deal's company has written since the draft was made, even a colleague who became a contact after it;
- a delivery failure came back for the address;
- the person opted out, or the deal was closed or deleted.

An out-of-office reply holds the draft until the date it states. Closing a deal cancels the drafts waiting about it. Pausing the routine stops new drafts; the ones already waiting stay on **Home**.

## How late the check can be

The check sees only mail Liaison has imported. An IMAP mailbox is read every 2 minutes, so a reply that arrived a minute ago may not be seen yet, and a draft approved in that window can still go out. The check narrows the risk; it does not remove it.

A **Private** mailbox (see [Mail](../apps/mail.md#choose-how-your-mailbox-is-encrypted)) is unreadable by the server. A reply in it still stops the draft it answers, but the words "stop" or "unsubscribe" in that reply are not read: the opt-out has to be recorded by a person.

## Hold a follow-up for a client

There is no button that holds one deal's follow-up. To stop them, pause or edit the routine, or close the deal. Tell the agent a condition such as "wait until they pay" as a change to the routine.
