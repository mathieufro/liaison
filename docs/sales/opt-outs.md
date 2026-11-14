---
title: Respect opt-outs of commercial mail
description: "Record that someone asked for no more sales mail, see who opted out before you write, and allow them again. What an opt-out stops and what it does not."
---

When someone asks to receive no more commercial mail, Liaison records it once and then holds every agent's commercial draft to it. This page shows how an opt-out gets recorded, what it stops, what it never stops and how to allow someone again.

## How an opt-out is recorded

- **They click the link.** Every commercial mail ends with a link to stop, and the same link serves the mail client's own unsubscribe button. The page asks once and records it with one button. Opening it changes nothing, since mail scanners open links. It shows your legal name and address, never the person's address, in English or French.
- **They reply "stop".** Liaison raises an opt-out request. A reply that came into a person's own mailbox goes to that person alone; one that came into a shared mailbox goes to the people who approve mail. A reply whose sender the receiving mail provider found forged raises none. A short reply counts; in a longer one the phrase must be on a line of its own, and quoted text never counts. Nothing is recorded until someone approves it, and each person gets one request. A mail in a **Private** mailbox cannot be read by the server, so no request is raised for it: a person records the opt-out.
- **You record it.** Tell the agent: "Alex asked to stop receiving our mail." It uses `suppression_add`, which anyone who can write mail may use.

Liaison keeps only a fingerprint of the address, never the address.

## What an opt-out stops

- Commercial drafts already waiting for that address are withdrawn at once, and the check before sending refuses any new one (see [Mail](../apps/mail.md#the-check-before-an-agents-mail-goes-out)).
- The [follow-up routine](follow-ups.md) skips the person.
- An agent's new message to that address is refused, commercial or not.
- A mail you write yourself to a prospect who opted out is refused too. A new message of yours to someone who opted out but is not a prospect, such as a supplier, goes, and the composer shows that they opted out.

## What it does not stop

- Invoices, order updates and other service messages go out.
- A reply in the person's own conversation can still be written.
- The record is not an erasure: the contact stays, and its page shows **Opted out of commercial mail.** with the date and how: **the link in an earlier message**, **a reply asking to stop**, **a person in this organization** or **an imported list**.

## See who opted out

Everyone with the Full Member role holds `mail:suppressions:read`, so they see who opted out before they write. An agent checks up to 50 addresses with `suppression_check`, which says when and how each person opted out. Only holders of that scope can call it.

## Allow them again

Ask the agent to lift it (`suppression_remove`). It waits for approval by someone who holds `mail:suppressions:write` (an admin), and the approval card says who opted out, when and how. Do it only when the person asked you to write to them again.

## Before any commercial mail goes

Set your legal name and postal address in **Settings > Organization > Commercial identity**, and see [Mail](../apps/mail.md#commercial-mail-identity-opt-out-link-and-one-recipient) for the footer, the one-recipient rule and who commercial mail may go to.
