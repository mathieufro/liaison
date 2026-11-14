---
title: Research prospects and draft replies
description: "Set up a routine that works in order when a prospect writes in: it checks the people and companies Liaison already knows, reads up on new companies, proposes their record, then drafts a reply, each waiting for your approval."
---

When a prospect writes in, a routine can do the first round of work for you: check what Liaison already knows about them (their contact, their company and any open deal), read up on their company if they are new, propose their record, draft a reply, and write a short brief on the prospect's contact. It works in order: the record first, then the reply. Nothing is saved and the reply is never sent until you approve it. The records are Liaison's own [contacts](contacts.md) and [companies](companies.md); a CRM you connected is read as well. The live demo at https://demo.liaison.sh runs this exact routine, **Research interested prospects**, in its sales scenario.

## How it works

1. A mail arrives. The routine starts on the `mail:message:create` event, but only for senders you chose.
2. The agent reads the email and looks the sender up in Liaison with `contacts_search` and `companies_search`: by their email, then their company by domain, then by name. If you connected a CRM, it also reads it with `connector_read`. These calls only read.
3. Only if neither the sender nor their company is known, it reads the company's website with `web_fetch`, at the bare home page of the domain in their address (`https://<domain>/`). Reading the web never waits for an approval, within the [limits on reading the web](../agents/approvals.md#limits-on-reading-the-web).
4. It proposes one change. In Liaison, a new sender becomes a contact with `contacts_write`, and a new company a company with `companies_write`; both are gated. With a CRM connected, the demo routine below proposes the CRM record with `connector_write` instead. Either way the card shows exactly what will be written, and the run waits for your decision.
5. Once you have decided, the run resumes and drafts a reply with the next step through `mail__reply`. That call is gated too, so the draft waits until a person approves it. A run that waits on a held call and carries on with its result is described in [Schedule routines](../agents/routines.md).
6. It writes a short brief: who they are, what their company does (and where it learned that), what they want, what the CRM knows about them, and what you approved.
7. It posts the brief in the discussion of the sender's Liaison contact with `threads_reply`, so the team finds it on the contact (see [Discuss a contact](contacts.md#discuss-a-contact-with-your-team-and-agents)). A post needs no approval. The same brief is the run's final message, posted where the routine posts.

If the prospect has an open deal, the company's page shows it. To follow prospects as deals, see [Track deals on a pipeline](deals.md); to keep them in your own CRM instead, see [Connect your own CRM or ERP](connect-your-crm.md). Commercial mail to a prospect follows [Opt-outs](opt-outs.md).

## Choose whose mail starts the routine

The mail event takes a sender filter, **Only from**, with contact groups or single contacts. Mail from anyone else never starts the routine and costs nothing.

- To react to known prospects, put them in a contact group, for example **Prospects** (see [Organize contacts into groups](contacts.md#organize-contacts-into-groups)), and pick that group.
- A first-time sender is not in any group yet, so a group filter never fires for them. To catch new prospects, leave **Only from** empty and let the prompt decide whether the mail is a sales enquiry. The routine then runs on every new mail the owner can read.

## Create the routine

1. Open **Agents**, pick the agent that will own the routine, and open its **Routines** tab.
2. Click **+ New routine**.
3. Under **Type**, choose **When an event happens**.
4. Enter a **Name** in lowercase with hyphens, for example `research-interested-prospects`, and a **Description** such as "When an interested prospect writes in: check the CRM, read up on their company when they are new, propose their CRM record, then draft a reply, each for me to approve."
5. Under **Trigger**, use **Search events** to pick `mail:message:create`.
6. Set **Only from** (see above).
7. Write the **Prompt**. See the example below.
8. Under **Scopes**, add the scopes in the next section.
9. Click **Create routine**.

To choose the conversation that receives each brief, open the routine's **Settings** tab, click **Edit** and set **Post to**. Every option is described in [Schedule routines](../agents/routines.md).

## Give it these scopes

| Scope | Why |
| --- | --- |
| `mail:conversations:read` | Read the incoming mail |
| `mail:conversations:write` | Draft the reply (`mail__reply`). The draft still needs approval |
| `mail:accounts:read` | The reply reads the conversation's mailbox before it drafts |
| `kernel:contacts:read` | Look the sender up in Contacts |
| `kernel:companies:read` | Read the sender's company and its open deal |
| `kernel:contacts:write`, `kernel:companies:write` | Stage the contact or company (`contacts_write`, `companies_write`). They still need approval |
| `kernel:threads:write` | Post the brief in the sender's contact discussion (`threads_reply`) |
| `kernel:agent:web` | Fetch the company website (`web_fetch`) |
| `api-connector:read` | Look the sender up in your CRM (`connector_read`), only if you connected one |
| `api-connector:write` | Stage the CRM record or note (`connector_write`). It still needs approval |

The run's final message needs no write scope: the platform posts it for you. Every write the routine stages waits for a person who may approve it: `api-connector:approve` for the CRM (see [Connect your own CRM or ERP](connect-your-crm.md#roles-and-scopes)).

## Example prompt

This is the prompt of the demo routine, which reads a connected CRM. A routine runs exactly what is written, so keep the steps explicit. Without a CRM, replace steps 1 and 3 with the same steps on Liaison's records: look the sender up with `contacts_search`, then their company with `companies_search`, and propose a contact or a company with `contacts_write` or `companies_write`.

```
An email has just arrived from a prospect. The event data names the message and its sender.

Work through these steps in order, one at a time.
1. Read the email. Look the sender up in the CRM through the connector, reading only: by their email first, then their company by its domain, then by its name.
2. If neither the sender nor their company is in the CRM, read their company's website with web_fetch, at exactly https://DOMAIN/ where DOMAIN is the part of the sender's address after the @ (for ana@example.com, fetch https://example.com/), with nothing after the last slash. Note what the company does, its size and any news that bears on the request. If the fetch fails, go on without it and say so in the brief.
3. Propose ONE CRM change with connector_write. A new sender: create the person with their company in the same call (create_contact, with companyName and companyDomain when the company is new too, and companyIndustry: one line on what it does, from its website). Someone the CRM already has: a note on their record with what they asked for. It waits for my approval; wait for it.
4. Once that is decided, draft a reply that answers their request with the next step, and that shows you know their company. The reply waits for my approval before it is sent.
5. Write a short brief: who they are, what their company does (say where you learned it), what they want, what the CRM knew about them, and what I approved.
6. Post the brief in the discussion of their Liaison contact, so the team finds it on the contact: find the contact with kernel__contacts_search by their email, then post with kernel__threads_reply and its contactId. Then give me the same brief as your answer.

Never say something was written or sent: it waits for my approval.
```

Do not paste ids into the prompt. They are stale by the next run.

## Review the record, the reply and the brief

1. Open **Approvals**, or the conversation where the routine posts. The CRM record (or note) waits there first, as an approval card. It is one request either way: approving it in one place settles both cards.
2. On the card, click **Approve**, **Edit** to change it first, or **Reject** to handle it yourself. Approving writes the record to your CRM.
3. The run resumes with your decision and drafts the reply. The reply draft then waits in **Approvals** the same way. Approving it sends it. See [Approve what agents do](../agents/approvals.md).
4. Read the brief on the prospect's contact, under **Discussion**, or where the routine posts. Open the mail conversation to see the **Customer** card, which shows what your CRM now knows about the sender.

## Good to know

- Website text and the incoming mail are external content. The agent treats them as data to summarize, never as instructions.
- One conversation holds at most one waiting reply draft. A second run on the same conversation replaces its own waiting draft instead of adding another.
- Several mails in a short window start one run, not one run per mail.

## Related pages

- [Schedule routines](../agents/routines.md)
- [Send quotes and follow-up documents](quotes.md)
- [Mail](../apps/mail.md)
