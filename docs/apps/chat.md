---
title: Chat
description: "Message colleagues and agents in direct messages, group conversations and channels, reply in threads, and bring agents in with an @-mention."
screenshot: "assets/screens/chat.webp"
screenshotAlt: "The Shipping exceptions channel in Chats, with messages from teammates and an agent and the thread list on the left."
---

Chat is where your team and your agents talk. You can message one person or agent, start a group conversation, or open a channel for a topic. An agent answers when you message it directly or @-mention it.

## Start a conversation

1. Click **Messages** in the activity bar.
2. Click **New message**.
3. In **To**, type a name. The list groups **Conversations**, **Agents** and **People**. Pick several people for a group conversation.
4. Type your first message and click **Start conversation**.

If you already talk with the people you picked, Liaison opens that conversation instead of starting a new one.

## Create or join a channel

1. In **Messages**, click **New channel**.
2. Enter a **Name**. A leading `#` (a full-width `＃` too), the spaces around the name and invisible characters such as zero-width spaces are dropped; the dialog shows the name that will be saved. Only channel names lose their `#`: an agent conversation titled "#1 priority" keeps it.
3. Under **Visibility**, choose **Public** (anyone in the workspace can find and join it) or **Private** (only the people added can see it).
4. Optionally **Add people**, then click **Create channel**.

To join an existing public channel, click **Browse channels** and open one from **Channels you can join**.

## Sort and filter channels

Above the list, choose how channels are ordered: **Recent activity**, **Name A-Z** or **Unread first**. Your choice is remembered on this device. The **Unread**, **Mentions** and **Muted** chips narrow the list, and the second menu shows all channels, only **Channels I'm in**, or only **Channels I'm not in** (the public ones you can join).

## Write and reply

1. Click **Write a message**. Type `@` to mention people or agents and `#` to link a thread.
2. Use **Attach** for files, **Emoji** for emoji, **Fix spelling & grammar** to clean up your text, or **Dictate** to speak.
3. Press Enter to send.

A message is posted once, even when the app sends it again after a network drop. When the network loses the answer to a send, the app sends the same message once more after a second; the server keeps only one copy. While the app is reconnecting, a page that fails to load does not show an error message: it loads again once the connection is back.

Hover a message to **Reply in thread**, **Quote** it, **Copy text**, or **Edit** and **Delete** your own messages. Replies in a thread stay under the original message. Threads you follow are listed under **Followed threads**.

**Copy link** in a conversation's actions menu copies its address, and the same entry is in the right-click menu of every tab. Pasting an address of a project, task, conversation or ticket from this server into the message box turns it into a chip, which never notifies anyone; an address from another site stays a link. A pasted address never adds a mention of a person by itself.

**Close other tabs** and **Close tabs to the right** ask first when one of those tabs holds a message you have not sent or an attached file, and list what would be lost.

A new message counts as read only once you see it: on a computer, the conversation must be open in the window you are using. A window left open behind other apps keeps it unread, on your phone too, until you come back to that window.

The app icon (phone and desktop app), the browser tab title and Home count your unread direct messages, mentions and replies in threads you follow, plus the approvals you decide, not the rest of the channel traffic (see [Notifications](../notifications.md#the-badge)). Reading a conversation on one device clears it on the others, its notifications included.

A channel notifies you on your phone and computer only when a post mentions you or replies in a reply thread you follow; the rest waits in the feed. To be told of every post of one channel, switch on **Notify me of every message** in its actions menu (see [Notifications](../notifications.md#what-interrupts-you)).

## Work with agents in chat

- Message an agent directly: pick it under **Agents** in **New message**. It answers every message.
- Bring an agent into a group or channel: @-mention it. The agent replies in that conversation.
- In a new workspace, the first administrator's conversation with their agent opens with a **Set up your space** card: what is set up, what is left, and a link to the demo. See [Set up a new workspace with your agent](../agents/how-agents-work.md#set-up-a-new-workspace-with-your-agent).
- When the agent runs on one of your computers and needs your OK for a step, the request shows above the message box with **Allow** and **Deny**; Home shows **{agent} needs your OK in the chat**. After you answer, a muted line says **You allowed: {tool}** or **You denied: {tool}**. While the turn runs on your computer, its steps show live, as a cloud turn's do. See [Guardrails](../computers/guardrails.md) and [Run a conversation on your computer](../computers/run-work.md#run-a-conversation-on-your-computer).
- Each agent's picture or bolt sits on its own color, the same in the chats list, in messages and on its page. The agents of a workspace get different colors; change one in the agent's **Settings** under **Color**.
- Your own agent's handle names it as yours, never as you: Ada's agent is `@adas-agent`. A mention of an agent always shows its current handle, also in older messages.
- A personal agent's messages are signed with its owner's name, **Ada's agent** (**Agent de Ada** in French), with the **Agent** badge, also in older messages and in a reply thread's list of who answered. So when your agent posts into your conversation with a colleague, they see that your agent wrote it, not you. Other agents sign with their own name, and a routine's posts with **Routine *name***.
- Under its newest reply an agent may offer up to four next steps as buttons: one sends its words as your message, another opens a tab. They are gone once anything is said after that reply.
- A message an agent writes after reading data that needs a scope is shown only to the people who hold that scope. When your agent would post into a conversation where some people do not, the message waits for your approval first; approving shares it with them.

A globe beside the conversation name means the agent read text from outside your company here, so what it writes or sends waits for your approval. Click it to see what it read, or to clear the mark. See [See and clear the mark](../agents/approvals.md#see-and-clear-the-mark).

The agent acts with its own permissions, and anything sensitive it does waits for approval. Once an approved action has run, a muted line says **request-N ran; its result was passed to the agent**. When an approved action fails, the reason shows as a muted line too, never as a message from you. When the agent's turn itself fails, its reply says so with a short line in your language and, under it, the error itself (such as the AI service's own message, never a stack trace or a key). When the AI service stops answering mid-turn, the agent first tries that step again; if it still gets no answer, its reply says the AI service stopped responding, and you can say "continue". On a managed instance whose payment failed, the turn says **AI features are paused until the open invoice is paid. An admin can pay it in Billing.** with an **Open Billing** link, and a message that cannot be sent for that reason says the same. See [How agents work](../agents/how-agents-work.md) and [Approve what agents do](../agents/approvals.md).

A message you send while the server restarts (an upgrade) is not lost: if it reaches a server that is shutting down, another one starts the agent's reply. An answer the agent is writing when the server restarts or stops is carried on by another server, and the one reply appears in the conversation when it is done. Closing the tab does not stop the answer either. An open conversation keeps showing the answer as the other server carries it on, without repeating the part that was cut. See [How agents work](../agents/how-agents-work.md).

### Ask an agent to open something

Ask "Open that invoice" or "Show me the support channel" and the agent opens its tab for you, like any tab you open yourself: a ticket, a task, a project, a contact, a conversation, a document, a routine. It only opens what you can see, and it says so when it cannot. In a shared conversation, an agent working for a colleague never moves your tabs. A routine has nobody watching, so it opens nothing.

A Shopify order has no tab in Liaison: the agent gives you the link to its page in Shopify.

## Follow a routine's run in a conversation

A routine can post its runs in a conversation: your chat with your personal agent, or a channel such as #marketing. See [Where a routine posts its runs](../agents/routines.md#where-a-routine-posts-its-runs). There, each run shows:

- a muted line **Routine *name* is running**. While the run waits for an approval it reads **Routine *name* is waiting for an approval**, and the run carries on once the request is decided (see [When a run waits for an approval](../agents/routines.md#when-a-run-waits-for-an-approval)). When the run ends it reads **Routine *name* finished** or **Routine *name* did not finish**. The routine's owner also sees **See the full run**.
- each approval the run asks for, as its approval card, posted by **Routine *name***. It is the same request as in Home: approve or deny it in either place and both cards show the decision. A member who may not decide it sees no card.
- the run's summary, posted by **Routine *name***.

The summary and the approval posts count as unread for the members, with the usual notification. That includes the routine's owner in their own chat with their agent. The **is running** line never counts as unread.

## Organise conversations

From a conversation's header menu you can:

| Action | What it does |
|---|---|
| **Add participant** | Add someone. If the room has earlier messages, Liaison warns that the new person will not see them. |
| **Pin** / **Pin for all** | Keep the conversation at the top of your list, or of everyone's |
| **Mute** | Stop notifications for it |
| **Archive thread** / **Unarchive thread** | Move it to **Archived threads** and back |
| **Set topic**, **Edit description** | Describe a channel |
| **Discoverable** | Let members of the workspace find and join the channel |
| **Leave thread** | Leave the conversation |

Use **Search threads...** at the top of the list to find a conversation by name.

A task's discussion is a conversation too. Opened as a conversation (from an old link, for example), it shows the task it belongs to above the messages, with **Open task**.

Any app can give its records a discussion the same way: one conversation per record, which everyone who can see the record may read and write. Opening the record's page seats you in it. Someone who cannot see the record never sees its discussion, and when a record's sharing narrows, people who lost access are taken out of it. If the discussion cannot be opened, the page says **The discussion could not be opened.** with **Retry**, and the rest of the page still works.

## Scopes

Chat is part of the core workspace, so its scopes are kernel scopes.

| Scope | What it allows |
|---|---|
| `kernel:threads:read` | Read threads |
| `kernel:threads:write` | Write threads |
| `kernel:threads:admin` | Administer threads, such as pinned threads for the whole organization |

See the [scope reference](../reference/scopes.md).

## What agents can do

| Tool | What it does | Scope |
|---|---|---|
| `threads_list` | List recent threads the user takes part in | `kernel:threads:read` |
| `threads_read` | Read a thread's messages in order | `kernel:threads:read` |
| `threads_create` | Create a thread with the given participants | `kernel:threads:write` |
| `threads_reply` | Post a message into a thread | `kernel:threads:write` |
| `agents_ask` | Ask another agent a question, without adding it to the conversation | `kernel:threads:write` |
| `agents_invite` | Add another agent to this conversation, once a person approves | `kernel:threads:write` |
| `create_pinned_thread` | Create an organization-wide pinned thread | `kernel:threads:admin` |

See the [agent tool reference](../reference/agent-tools.md).
