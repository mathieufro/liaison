---
title: How agents work
description: "Learn what an agent is, who it acts for, where it runs, and how its work comes back to you for approval."
screenshot: "assets/screens/agent-chat.webp"
screenshotAlt: "A conversation with the user's personal agent, which summarises what needs attention this morning and answers follow-up questions."
---

An agent is a teammate that works inside Liaison under the permissions of the people it works for. You talk to it in a conversation, it reads and writes in your apps, and anything sensitive waits for a person to approve. This page explains the pieces, so the rest of the agent pages make sense.

## The three kinds of agent

Every agent has a name, a handle that people type in a mention (for example `@support`), instructions, a model and a permission ceiling. The kind decides who owns it. Each agent's page shows its kind as a chip next to the handle.

| Kind | Chip | Who it is for |
| --- | --- | --- |
| Personal agent | **Personal agent** | One per person. It is created with the account and works with that person's own permissions. A new one is named **Personal agent** until its owner renames it. Its handle names its owner's agent, never the owner: Ada's agent is `@adas-agent` (`@thomas-agent` for a name that already ends in "s"), so a mention of it never reads as a mention of Ada. |
| Role agent | **Role agent** | A shared agent for a job, such as support or logistics. An administrator creates it and sets what it may do. See [Create an agent](../agents/create-an-agent.md). |
| System agent | **System agent** | The workspace's base agent (`@base`): the permissions and skills every agent starts from. It is a template, so it has no **Message** button and cannot be archived. |

To see them all, open **Agents**. Your own agent is marked **Your agent** in the list. Search finds agents, their skills, routines and memory.

## Talk to an agent

1. Open **Agents** and pick an agent.
2. Click **Message** to open a direct conversation with it.

Some tool calls draw a card under the agent's message that you act on, such as a Connect card, or, on a server that sends bug reports only to the Liaison team, the bug report the agent prepared with **Send to the Liaison team** (only you see it, and nothing is sent until you click). A tool that opens one of an app's own pages (a file picker, a form) draws an **Open** button: it opens the page in a new window, once, for you only; an expired link says to ask again. Some tools also have a card of their own: an app can say how a tool's result is drawn, for example a few labelled facts and a button that opens the record. A card shows only what the tool returned to the agent, nothing more, and when a result does not fit the card, the conversation shows the ordinary tool row instead.

Under its reply the agent may offer up to four next steps as buttons. Clicking one either sends the words on the button as your own message or opens the tab it names. The buttons show only under the newest message, and never in a conversation that holds outside text, such as a mail or a web page the agent read.

The agent knows the page you send from. When a record is open there, whether the page is its own or a pane, a drawer or an expanded row of a list, "this" means that record, even if the conversation was about another one before. A record is open once you opened it: the first row a list shows by itself does not count until you click it.

A file you attach reaches the agent with your message, whether you type text with it or not, so you can attach an export and write "please import this".

The agent answers in the language you write in. When one message does not tell (an address, a company name, a one-word reply), it keeps the language of your earlier messages, then the language set in your settings (or the workspace's). What you paste and what its tools read never change it.

You can follow a turn while it runs from any open page. It shows as soon as the server takes your message on, before the agent writes anything, and a newer request to the same agent shows beside a turn still answering. A page you open or reload mid-turn shows what the agent has written and the tools it has called so far, then keeps up. A turn's activity stays readable for ten minutes after it ends. Several reads of apps in a row show as one line ("Read 3 apps"); an app reads as not answering only when none of its calls got an answer, so a call the agent made again and that then answered does not count. Its thinking, tool calls and text show in the order the agent wrote them, also after the connection drops and comes back mid-turn, and the saved message keeps that order when the turn ends.

When a turn fails, the agent's reply says so in the conversation: a short line in your language, then the error itself, such as the AI service's own message (never a stack trace or a key). If the agent had already written part of its answer, that part stays and the error follows it. Previews and notifications show the short line only. When the AI service stops answering in the middle of a step (a timeout or a dropped connection), the agent runs that step again from its last finished one, up to twice, a few seconds apart: what it had started writing in that step disappears and is written again, and nothing it already did is done twice. If the AI service still does not answer, the reply says the AI service stopped responding, and you can say "continue". A turn has no fixed length while it keeps making progress: it is stopped only when one step (the AI service's answer and the tools it calls) makes no progress for 5 minutes, and in any case after 20 minutes. A routine or a sub-agent with its own time budget keeps that budget as one limit for the whole run. A turn stopped by its time limit keeps what it had written and says under it that it ran out of time; ask it to continue.

When the agent finishes a turn you started, or a routine of yours finishes its run, you get one notification carrying its answer, on your phone, your computer and in your feed, whether you waited or went to do something else. It is held back only while that conversation is open in front of you. What the agent writes on the way (progress, its questions to other agents, the posts it makes elsewhere because you asked) never notifies you; it waits unread where it was written. See [Notifications](../notifications.md#your-own-actions-and-your-own-agent).

A turn refused before any model ran (no usable model key, no credits left) keeps your message in the conversation with the refusal under it, so you see what you sent and that nothing was done. Later turns do not act on it: the agent knows a message was refused, not what it asked. Send it again once the cause is fixed.

On a managed instance whose renewal payment failed, a turn is refused with **payment_required** and a message to pay the open invoice in **Settings › Billing**; so are web search, proofreading and dictation. Side work such as conversation titles is skipped without an error. They work again once the invoice is paid ([When a payment fails or the subscription ends](../admin/settings.md#when-a-payment-fails-or-the-subscription-ends)).

On a managed instance every AI call goes through OpenRouter: the agent's turns, the search embeddings that let the agent find a message by meaning, media analysis and web search. Embeddings, media analysis and the web search call ask OpenRouter for zero data retention, and each one uses the organization's credits like a turn. The calls Liaison makes in the background for an organization use its credits too: memory upkeep, conversation summaries, chat titles, ticket summaries and web page extraction. Web search runs on one fixed search engine, which zero data retention does not cover. While a renewal payment is unpaid, new messages are searchable by their words only; once the invoice is paid, Liaison adds the missing embeddings in the background.

You can also mention an agent by its handle in any conversation. A mention always shows the agent's current handle, even in a message written before the handle changed. An agent asks another agent a question, or hands it one piece of work, with `agents_ask`: the other agent answers in the conversation without being added to it. An agent never adds another agent to a conversation on its own. With `agents_invite` it asks first, in the conversation: **Support Desk wants to add Finance Desk to this discussion**, with **Add** and **Don't add**. Only after **Add** does the agent join, and the conversation shows **Support Desk added Finance Desk**. The invited agent speaks only when someone mentions it. The other agent answers with its own access, limited to what the person it works for and the conversation may see. Its answer is posted in the conversation, under the question. When it cannot answer (its turn was refused, failed, or lacked the access the question needs), it still replies there and says so, and the asking agent tells you why. When the answer takes longer than the asking agent waits, the asking agent says it handed the question over, and the answer appears in the conversation when it is ready.

In a conversation other people read, such as a task's discussion or a channel, the agent writes its reply for everyone in it: it posts only its final answer, without the notes it wrote between steps, and a failure reads as one plain sentence saying what did not happen. While it works, everyone in the conversation sees the steps it takes but not those notes, and its answer appears once it is written. In a direct conversation with you, it still shows each step's note where it wrote it, as it writes it. A step that runs on your computer also shows the command, file or address it acts on next to its name.

## Set up a new workspace with your agent

The first administrator to sign in to a new workspace finds a conversation with their own agent, pinned for them, marked unread and headed **Set up your space**. A workspace counts as new for 14 days after it is created (`LIAISON_SETUP_KICKOFF_ORG_MAX_AGE_DAYS`) and until somebody writes a message in it; a demo workspace never gets it.

The first card shows what is set up and what is left: **AI model key**, **Apps**, **Mail**, **Team**, **Company knowledge**, then the optional **Import from another tool**, **Roles** and **API connection**. Each item is read from the workspace itself, "as of" the time shown; nothing is stored as "done". When the workspace has no model key yet, the card holds the key card: type the key there, or save it in **Settings › AI models**, and the agent starts once it is saved. The card also offers the public demo once, a sample company with guided scenarios, at the address in `LIAISON_DEMO_URL` (`off` removes the offer).

From there the agent first asks which features you want (email and Google sign-in, a support inbox, imports from Jira, Freshdesk or another desk, calendar, Drive, Shopify, Facebook and Instagram, Google Ads), then starts with the basics: the model key, your mailbox and Google sign-in, the support inbox, the team, company knowledge and imports. Each message asks you for one thing and says how long it takes; you can skip any step and come back any time. For each mailbox and calendar it asks whether it is yours or a shared team one (a role address such as `support@` is the organization's). After the basics it offers the other connectors as a menu with their times, never as a to-do list. It proposes one step at a time and carries each one out with its usual tools, through approval cards and secret cards. A saved password is not yet a working mailbox: until its first sync ran, the agent says **credentials saved; first sync pending**, and it calls a mailbox or a connection live only once a status read shows it working. If something the agent wrote before a tool answered turns out wrong (it says an approval card is waiting when nothing needed approval, or that it posted a card again when the card was already there), Liaison keeps only the answer written after the result. To connect a system Liaison has no app for (a CRM such as HubSpot, an ERP, any HTTP API with a key or token), ask for it: the agent drafts the connection, you approve **Save the API connection** and type the key on a secret card, and the agent tests a read (see [API connections](../api-connector.md)). After each step it reads the checklist again with `setup_state` and shows it. Say "skip" to leave a step out. A person who is not an administrator can ask what is left, but the agent proposes nothing to them.

## What an agent may do

An agent never has more access than the people in the conversation. On every turn Liaison computes its effective access as an intersection:

- In a direct message: the agent's ceiling intersected with your permissions.
- In a channel or group conversation: the ceiling intersected with the permissions of every person in the room. Adding a colleague with less access narrows what the agent can do there.
- Which records it can read follows the person who asked: the documents shared with them, directly or through one of their roles. This holds when you mention an agent in a thread as well as in a DM, so a document shared with the Finance role is readable through any agent a Finance member asks, and through no agent anyone else asks.
- In a routine run: the routine runs as its owner with the scopes chosen on the routine. If the owner no longer holds one of them, the routine pauses.

An agent never sees a full card number or a Stripe key in what it reads: messages, tickets, notes, emails and the text of an encrypted mailbox reach it with card numbers shown as `•••• •••• •••• 4242` and keys cut to their prefix. Links an agent opens on the web may not carry a card number either.

When a room removes capabilities, the message says **Some capabilities are unavailable here** and offers **Continue in a DM**. See [Agent permissions](../agents/permissions.md).

## Where an agent runs

The agent page shows where its turns run.

| Label | Meaning |
| --- | --- |
| **Runs on: Liaison** | On the Liaison server, from any device, with the same memory and conversations. It cannot touch your files or run scripts. |
| **Runs on: this computer** | In the desktop app, in a folder on this machine, with your own Claude account. |
| **Runs on: Liaison, and your computer** followed by the computer's name | The cloud agent is also attached to one of your computers. |

In a conversation, the runtime menu (**Where turns run**) offers **Liaison**, **This machine** and **My computer**. Your computer works even while you are away, and you approve what it asks from wherever you are. See [What a computer is](../computers/what-is-a-node.md) and [Run work on your computer](../computers/run-work.md).

When the server restarts (an upgrade), a turn already running on Liaison gets time to finish before the server stops. A new turn asked in the few seconds while the server is being taken out of service still starts there and carries on like any other. After that, a new turn is not started on that server: it starts on a running one, or the request is refused with nothing saved so it can be sent again.

When the organization is moved to another server, new messages to an agent are refused for a few seconds (`503`, retry shortly) while the turns already running finish; the client sends them again once the move is over.

A turn still running when that time is up stops after the step it is in, and another server carries it on from there. When a server stops without warning (a crash), another one takes its turns over within about a minute. Either way you get one answer: the steps already done are not run again, and an action the agent was in the middle of is not done twice. When Liaison cannot tell whether such an action happened, the agent is told its outcome is unknown, so it checks before trying again. It carries on with the same model and reasoning level it started with, even when the agent's model was changed in the meantime: the new choice applies from the next answer. Before it carries on, the turn reads your permissions again: it works with what you may do now, never more than when it started, and it stops if your account was deactivated in the meantime. A turn that cannot carry on says so in the conversation: **This answer was interrupted and could not be resumed. Please ask again.** Liaison records why a turn did not finish: its server stopped and it could not carry on, it failed on its own (a model error), or the person left before the answer started. An operator can then check that an upgrade cut no turn (see [Docker](../self-hosting/docker.md#check-that-a-deploy-only-delayed-work)).

## How an agent is named in what it does

Agents never post as a human.

Asked to send a message to a colleague, an agent posts in a Liaison conversation with them (their direct conversation, opened if needed), not an email. It sends an email only to people outside the organization, or when you ask for an email. An external AI client connected through MCP follows the same rule.

- A reply in a conversation carries the agent's name. A message an agent posts into another conversation with `threads_reply` or `threads_create` is labelled with the agent's name too. A personal agent's messages are labelled "<Name>'s agent" after its owner, whatever the agent is called, so the people in a conversation can tell it from its owner and from other people's agents. When a person's external AI client posts through MCP with no agent behind it, the message is labelled "<Name>'s agent", never as the person.
- A routine posts its final message as the owner agent, labelled **Routine** with the routine's name.
- An approval request shows who asked. A role or system agent is named as itself. A personal agent acts as its person, so its requests show that person. An access request filed by an agent reads **via** and the agent's name.
- The audit log records the acting agent on each entry. An administrator can search it with the `audit_search` tool.
- When an external AI client connects through MCP, the device approval screen says which agent it will act as, limited to what that agent may do.

## The approval loop

Agents can read freely within their access, and they can prepare actions. Sending, paying, publishing and other sensitive changes are gated. The loop is:

1. The agent calls a gated tool. Liaison does not run it. It creates an approval request instead.
2. The people who may decide it see the request in the **Approvals** card on **Home** (on a phone, also on the **Approvals** screen), and get a notification. A request your agent raises in the conversation you are reading right now does not notify you: its card is on your screen.
3. An approver reads the exact payload, edits it when the tool allows it, then clicks **Approve** or **Reject**.
4. If approved, Liaison runs the action and posts the result in the conversation. If rejected, expired or withdrawn, nothing runs.

In the conversation, the card sits under the step that raised it. Repeated steps are grouped (for example **Enable App ×2**), and a group holding a request still waiting for a decision opens on its own, so its card is never hidden.

An import the agent starts shows a live card in the conversation: counts per kind, refused records, the final report and **Undo**. It appears as soon as the import is approved and keeps updating after a reload.

The agent sees the outcome as a fact in its transcript and carries on. When the approved action returns something, such as search results, the agent gets that result in its next turn. See [Approve what agents do](../agents/approvals.md).

When a request your own agent proposed for you waits more than a day, your agent writes to you about it in your conversation with it, once a day while it waits (or every 3 days, weekly, or never, as you choose in **Settings**, **Notifications**, **Approval reminders**), with a link to each request. It first reads each request and what it acts on, and tells you when one looks outdated instead of asking you to approve it. That message reaches your notifications like any new message. See [Reminders for requests you forget](approvals.md#reminders-for-requests-you-forget).

An organization can also hold back actions after an agent has read text from outside, such as an inbound email or a web page. See [Agent safety in Approvals](../agents/approvals.md#hold-actions-after-outside-content).

### When an agent says it will act and does not

If an agent ends its reply with "I'll do it now" but called no tool, Liaison gives it one more try in the same turn: it either calls the tool or says plainly what it cannot do, and that answer replaces the first. An offer that waits for you ("Give me the hosts and I'll update the mailbox") is left alone. If the second try calls no tool yet says something was done or checked, it is never shown: Liaison keeps the first answer and adds a line saying nothing was run yet, so a reply never reports an action that did not happen.

When an agent reads your private mail, any of your Liaison apps where your mailbox is unlocked decrypts it for that turn: any of your unlocked apps answers for your own agent's requests, not only the one you asked in. The agent waits up to 45 seconds for a read of a few messages, 3 seconds more for each message past five, and an app where the mailbox is locked never answers in place of an unlocked one. If none of your apps is unlocked, the agent says your mailbox is locked on all your open Liaison apps and asks you to unlock it on any of them. Other people, admins included, are never asked. See [Mail](../apps/mail.md).

An answer that points you at a card (a secret card, or an approval card "above") gets the same one more try when no such card is open in the conversation, and the new answer replaces all of the first one's text. Each turn also reads how the imports started in the conversation stand at that moment, so an agent never answers from an older "still running".

### When a call has the wrong arguments

A tool called with arguments it does not take answers with what is wrong and what it takes, and nothing runs. The agent corrects the call and tries again. It is not counted as a fault.

## What an agent remembers and does on its own

- **Memory.** Each agent keeps its own memory, which you can read on the agent's **Memory** tab when you have access. An agent writes to it only when you ask it to remember something, or when you correct it or tell it how you want it to work. It does not copy into memory what an app already holds, such as contacts, orders or prices, and it does not write memory on its own as part of a task. When a conversation goes quiet, Liaison may save such a preference from it, reading only the messages you typed, never the agent's replies or what an app returned. It saves nothing from a conversation in which you declined a memory approval.
- **Skills.** Skills are written playbooks an agent loads when a task matches. They live on the **Skills** tab.
- **Routines.** A routine is a task an agent runs on a schedule or when an event happens. See [Schedule routines](../agents/routines.md).
- **Sub-agents.** For a large job an agent can start a fresh-context sub-agent with `spawn_agent`, one per item, and gets one result back. This needs `kernel:agents:spawn`. See [Tools agents can use](../agents/tools.md).

## Agent page tabs

| Tab | What it shows |
| --- | --- |
| **Overview** | Purpose, charter, capabilities, channels the agent is in. |
| **Skills** | Skills the agent owns, and app skills. |
| **Routines** | Routines the agent owns, with **+ New routine**. |
| **Memory** | What the agent remembers. |
| **Knowledge** | The knowledge collections it reads. |
| **Activity** | Its recent turns, routine runs, approvals and sub-runs. Administrators and owners only. |
| **Settings** | Name, picture, instructions, model, capabilities. Administrators and owners only. |

## Next steps

- [Create an agent](../agents/create-an-agent.md)
- [Choose a model](../agents/models.md)
- [Connect external MCP servers](../agents/mcp-servers.md)
