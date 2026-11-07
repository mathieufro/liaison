---
title: Schedule routines
description: "Create a routine that an agent runs on a schedule or when an event happens, choose where it runs, and read its runs."
screenshot: "assets/screens/routines.webp"
screenshotAlt: "The Routines tab of the Support Desk agent, listing a scheduled morning triage routine and an event-triggered new ticket routine with the first one open."
---

A routine is a task you write once and an agent runs by itself: a morning brief, a weekly ticket review, a reply to every mail from a key customer. This page shows how to create one, how it runs, and what to do when it pauses.

## How a routine works

- A routine belongs to an agent and runs as its owner, with the scopes you pick on the routine. It never gets more than the owner holds.
- Each run is an agent turn with your prompt. The final message of the run is posted to the routine's output thread, which is its run log.
- Anything the routine does that needs approval still waits in **Approvals**. A schedule only controls when the routine fires, never whether a step is gated. See [Approve what agents do](../agents/approvals.md).

## When a run waits for an approval

A run that needs an approval waits for it. When a step is held for a person (a gated tool, an action held after the run read outside content), the run stops at that step instead of carrying on without its result:

- The run's status is **Waiting for approval**, and its line in the conversation says **Routine *name* is waiting for an approval**.
- Once the request is approved, the call runs and the same run carries on with its real result. When the run asked for several approvals at once, it carries on once all of them are decided.
- If the request is denied, expires or is withdrawn, the run carries on once, told that the call did not run, and then ends.
- When the held step hands out references to its result (a record id, a quote's PDF), the run first proposes the steps that use them, chained into one request you approve once, and then waits. While it does, it can look tools up, but any other call that would run at once is refused.
- A sequence of steps approved in one go makes the run wait for all of them: it carries on once, after the last step ran, with every step's result.
- If an approved call or a step of a sequence fails when it runs, the steps after it do not run. The run carries on, told the real error, which steps ran and which did not, and proposes a corrected call or sequence for you to approve. That new request counts toward the limit below; at the limit the run ends with a summary of what failed.
- A run that hits another held step after it carried on waits again, up to 5 times. After that it ends and says which requests are still pending.
- The run's final message is posted once, when the run really ends.

A waiting run uses no credits. The part it runs after the decision counts like any run. Runs the routine starts for an event go on while one waits; a scheduled run is skipped instead (**Skipped: an earlier run of this routine is waiting for an approval.**), so runs do not pile up behind the same approval. If the routine is switched off or paused while a run waits, that run ends when the decision comes, without carrying on. The same happens when its owner no longer holds a scope the routine needs, and the routine is paused as a scheduled run would pause it. A run that nothing picks up after its approvals are decided (a server restart, for example) is picked up within the hour, and a run whose approval expired without a decision ends.

## When a run waits for your private mailbox

A private mailbox can be read only in your own unlocked Liaison window: the server cannot read it. For security, routines and agents can't read private mail while you're offline, so a run of your routine that needs it waits for you instead of doing nothing:

- The run's status is **Waiting for your private mailbox**, and it shows in your approvals list, with everything else that waits on you: **Private mailbox**, ***name* waits for you**, what started it (a new email, an event, or its schedule; never the email's sender or subject, which only your browser can read), how long it still waits (**21h left**), and **Run now** and **Dismiss**. **Details** shows the run's facts: the routine, what started it, since when it waits, when it expires, and its state. It is not an approval of an agent's action, so it needs no approval permission: only you see it.
- **Run now** runs it from that window. If your mailbox is locked there, the unlock card shows right in the item, and the run starts by itself once you unlock. A mailbox you already unlocked in this login is not asked for again: the item waits the moment it takes to reopen it.
- When a new email started the run, your browser opens that email for the run as you click, and you can close the window right away: the run carries on and ends without it. The email is held for that run only, in memory, and never stored. If the run needs more of your private mail and no Liaison window of yours is open, that read says so (**needs your open Liaison window**) and the run reports which mail it could not read, instead of waiting.
- Once **Run now** starts it, the item leaves the list and a notice says ***name* is running**. If another run of the same routine is running, **Run now** queues this one: the notice says ***name* starts right after its current run**, and it starts once the other ends.
- When several runs wait, they show as one item with **Run all** and **Dismiss all**: ***name*: *n* runs wait for you**, or ***n* routine runs wait for you** when they come from several routines. **Run all** starts every one of them from that window, oldest first, without asking run by run, because each would have run by itself if the mailbox were not private. If your mailbox is locked, you unlock it once and they all start. Runs of the same routine go one after another. A queued run that has not started after 30 minutes returns to your list. **Dismiss all** asks first. **Details** lists each run with its own **Run now** and **Dismiss**.
- **Dismiss** declines it: the run does not happen, its status says **Dismissed: you chose not to run it**, and the item leaves the list.
- Only you can run or dismiss it, from your own session. A routine someone else created to run as you, or edited since it started waiting, is refused: it never reads your private mailbox.
- While one run waits, the routine's scheduled runs are skipped (**Skipped: an earlier run of this routine is waiting for you to open your private mailbox (Run now in your approvals). The routine runs on its schedule again once that run ran or expired (24 hours at most).**), so a routine that runs every hour still shows one item. Runs the routine starts for an event go on: each new email is its own run, and one that also needs your private mailbox waits as its own item, so no event is lost while you are away.
- For an event routine, the waiting run keeps only the event's ids; **Run now** reads the event back to handle it.
- A run nobody ran within 24 hours expires: it leaves the list, and its status in the run history says **Expired: nobody ran it**. The routine runs again at its next time.

A transparent mailbox is read on the server, so routines that read it run unattended and never wait. See [Mail](../apps/mail.md).

## Where a routine posts its runs

A routine can also post each run in a conversation you read: your chat with your personal agent, or a channel such as #marketing.

- A routine created from a conversation posts there.
- Otherwise, a routine your personal agent runs posts in your chat with that agent.
- A role agent's routine posts only in its own output thread, until you choose a conversation.

In that conversation, each run shows:

- a line **Routine *name* is running**, which changes to **Routine *name* is waiting for an approval** while the run waits (see above), and to **Routine *name* finished** or **Routine *name* did not finish** when the run ends, with **See the full run** for the routine's owner;
- every approval the run asks for, as its approval card. It is the same request as in **Approvals**: approve it in either place and both cards show the decision. A member who may not decide it sees no card, and a member who could not read what the run read does not see the post;
- the run's final message, labelled **Routine** with the routine's name.

A project task a run creates says **Created by Routine *name*** in its header, not the routine's owner.

The approval posts and the final message are unread for the conversation's members, with the usual notification, also for the routine's owner in their chat with their agent.

To change it, open the routine, click **Edit** and pick a conversation under **Post to**: any conversation or channel the routine's owner is a member of, or **Only its own run thread**. The routine's own run thread is always there and holds every run; it is not a choice of its own.

An agent sets the conversation with `create_routine` or `update_routine` and their `reportThreadId`: a conversation id, or a channel handle such as `#marketing`. The routine's owner must be a member of it. `null` keeps the runs in the routine's own thread only.
- A run that overlaps a run still in progress is skipped. Event-started runs wait and retry instead of being dropped.

## Create a routine

1. Open **Agents** and pick the agent that will own the routine. A personal agent is yours. A role agent needs `kernel:agents:admin` for you to write to it.
2. Open the **Routines** tab and click **+ New routine**.
3. Under **Type**, choose **Recurring**, **One-shot** or **When an event happens**.
4. Enter a **Name** in lowercase with hyphens, for example `daily-thread-digest`, and an optional **Description**.
5. Set the **Schedule** (or the **Trigger** for an event routine). See the next section.
6. Under **Prompt**, write what the agent should do. Spell out each step. The agent runs exactly what is written and infers nothing. Do not paste ids you looked up while chatting: they are stale by the next run.
7. Choose **Visibility**: **Personal** keeps the output thread private to you, **Shared** shows it to every active member.
8. Optionally pick an **Agent model** and a reasoning level. Without one, the routine follows the output thread's setting and then Auto. See [Choose a model](../agents/models.md).
9. Under **Scopes**, add the scopes the routine needs from **Search the scopes you hold**. See [Choose scopes](#choose-scopes).
10. Under **Runs on**, choose where it runs. See [Run a routine on your computer](#run-a-routine-on-your-computer).
11. Optionally set **Who approves its drafts** and the token fields.
12. Click **Create routine**.

An agent can create routines for you, too, with `create_routine`. That call is itself an approval request, and the card lists the next fire times.

### Schedule options

| Type | What you set | Notes |
| --- | --- | --- |
| **Recurring** | A preset: **Daily**, **Weekdays**, **Weekly** (pick the days **Mon** to **Sun**), **Monthly** (on the 1st) or **Custom**, plus a time and a timezone | **Custom** takes a 5-field cron expression with no seconds. The timezone is an IANA name such as `Europe/Paris`. |
| **One-shot** | **Run once at** a date and time in the future | The agent runs the prompt once, then the routine is marked **Done**. |
| **When an event happens** | An event, chosen with **Search events** | The routine runs every time that event happens. Events are named `app:entity:action`. |

For mail, the event `mail:message:create` takes a sender filter. Under **Only from**, choose contact groups or contacts. Mail from anyone else never starts the routine, and costs nothing, because the filter is checked before the agent runs. Leave it empty to react to every new mail the owner can read.

Several events in a short window are coalesced into one run (30 seconds by default), so a burst of mail does not start a run per message.

When Liaison runs as several server processes, an event starts the routine once, not once per process. A routine you create, change, pause or delete takes effect in every process.

## Choose scopes

**Allowed scopes** is the routine's own ceiling: what it may do when it runs. Each tool it calls needs its scope.

- Pick the smallest set that the prompt really uses. A digest or report that only reads and posts one summary holds read scopes only.
- Posting the result needs no write scope. The platform posts the final message for you. Do not add `kernel:threads:write` just to deliver a digest.
- Add a write or reply scope only if the prompt performs that write on every run. Each such action still arrives as its own approval.
- The picker lists the scopes you hold. An empty list means the routine can call no tool and can only write its reply.
- The `routine_tool_scopes` tool tells an agent which scopes a list of tools needs.

If the owner later loses one of the scopes, the routine pauses (see [Fix a paused routine](#fix-a-paused-routine)).

## Run a routine on your computer

**Runs on** has three choices.

| Choice | What happens |
| --- | --- |
| **Cloud** | Each run happens on the Liaison server. This is the default. Where the workspace has credits, only cloud runs use them. |
| **My computer** | Each run happens on one of your own computers, with your own Claude sign-in and local tools. An offline computer holds the run until it is back, and you get a notification. |
| **My computer, else the cloud** | The computer when one is online, otherwise the cloud. |

For a computer run you can also set **Folder**, **Repository URL** and **Model**. They default to **The agent's folder** and **The agent's model**. Only the routine's owner can choose them, because they refer to the owner's computer.

A scheduled run uses your own Claude configuration. A run started by an event runs isolated and is capped at the guardrail level in `NODE_EVENT_RUN_MAX_LEVEL` (`strict`, `standard` or `open`, default `strict`), whatever level the agent's profile sets. A routine run that was interrupted after it started is never repeated silently: the owner decides what to do with it. See [Run work on your computer](../computers/run-work.md) and [Guardrails and permission modes](../computers/guardrails.md).

## Choose who approves a routine's drafts

When a routine drafts something gated, such as a reply, the approval goes to everyone who may decide it. Under **Who approves its drafts**:

- **Whoever may approve them** is the default.
- **Only me, the routine's owner** keeps the drafts for you alone, also on a shared mailbox. It needs you to hold the right to approve them.

## Limit what a run can spend

| Field | Effect |
| --- | --- |
| **Token budget** | Told to the agent in each run's prompt. Leave it empty for none. |
| **Hard token limit** | The run stops once it has used this many tokens. Leave it empty for none. Set it above the budget. |

Both must be whole numbers above zero, and at most 50,000,000.

## Run a routine now and read its runs

1. Open the routine and click **Run now**. It queues a run outside the schedule.
2. Open the **Runs** tab. Each row shows how it started (**Scheduled**, **On event**, **Manual run** or **Retry**), its duration and its status. Click a row to open the transcript, or **Open the full log**.
3. Click **Open output thread** to read the run log as a conversation. Use **Show older runs** to go further back.

**Run now** is unavailable when the routine is switched off, paused, finished, or its app is turned off, and the button says why. For an event routine, an agent can pass sample event data to `run_routine_now` to simulate the trigger.

Run statuses: **Running**, **Waiting for approval**, **Waiting for your private mailbox**, **Expired: nobody ran it**, **Ran**, **Failed**, **Nothing to do**, **Skipped: missing access**, **Skipped: no credits**. Routine statuses: **Active**, **Done**, **Paused**, **Paused: missing access**, **Paused: no credits**.

A run is **Failed**, not **Ran**, when it could not do its job: a tool it needed was unavailable, its answer says it is blocked, or its turn ended in an error (the AI service refused or failed the request, credits ran out, or it stopped before a final answer). The run's error quotes the failure itself, with its code when it has one.

A routine that fails or pauses tells its owner on **Home**, under **Routines failed or paused**, as one item per routine with the latest error.

## Fix a paused routine

**Paused: missing access** means the owner no longer holds a scope the routine lists. A banner shows the fix: change the routine's scopes under **Edit** then **Scopes**, or ask your agent to update them. **Paused: no credits** means a cloud run had no credits left (only on a workspace that uses credits). The routine keeps checking at each scheduled run or event, and goes back to **Active** on its own once credits or a model key are added. A routine paused by missing access records **Skipped: missing access** for each run it skips. A plain **Paused** routine was paused by a person. Resume it to run it again.

## Edit, switch off or delete a routine

1. Open the routine and its **Settings** tab.
2. Click **Edit** to change the schedule or trigger, **Post to** (the conversation where each run posts), the prompt, the model, scopes and the rest.
3. Click **Save**. Changing a routine's schedule or scopes through an agent (`update_routine`) is an approval request, as are `delete_routine` and `run_routine_now`.

The Routines list groups routines as **Running** and **Switched off** and filters with **Mine** and **Shared**. A switched-off schedule routine shows **Switched off: no next run scheduled**.

## Start from a template

Apps and the platform ship routine templates. In the **Routines** list, **App templates** shows them, with **Built in** and **Enable**. The platform template `morning-brief` posts a short brief every weekday at 08:00 in your own timezone: overnight mail, drafts waiting for your approval and tasks due. It also sends you a one-line notification with the counts. Its newest brief shows on **Home** under **Today's brief**, with the time it was written; your own brief only, never a colleague's. With none, **Home** says **No brief set up** and offers **Set up a morning brief**, which opens your routines. An agent enables one with `enable_routine_template`, and puts a routine back to its template with `reset_routine_to_template`.

## Read the sender's website in a mail-started run

A run started by an inbound email from outside has read outside content, so its outward actions wait for a person (see [Hold actions after outside content](../agents/approvals.md#hold-actions-after-outside-content)). Reading the web does not: the run can search and fetch the sender's site, and use it in the records and replies it then prepares, without waiting. The [limits on reading the web](../agents/approvals.md#limits-on-reading-the-web) apply.

## Watch a web page between runs

Two routine-only tools let a routine remember across runs. `web_watch` fetches a page, extracts what you ask for and compares it with the previous run, stored under a key. Give every watched page its own distinct key. `watch_state` reads or writes a value that persists between runs. See [Tools agents can use](../agents/tools.md).

## Who can do what

| Scope | Allows |
| --- | --- |
| `kernel:routines:read` | List routines and read their runs (`list_routines`, `list_routine_events`). |
| `kernel:routines:write` | Create, edit, enable and delete your own routines, and run them now. |
| `kernel:routines:run` | Run shared routines on demand, with no edit rights. |
| `kernel:routines:delegate` | Create routines that run as another user, and edit or delete shared routines. |

## Re-run events a routine missed

If the server was down, event routines can miss events. A scheduled job already looks back 14 days (`ROUTINE_EVENT_RECONCILE_LOOKBACK_DAYS`). To backfill over a window you choose, run the reconciler once:

```
liaison routines reconcile [--since <iso date>] [--days <n>] [--org <slug>] [--routine <uuid>] [--max-per-routine <n>] [--execute]
```

Without `--execute` it is a dry run. With it, the retries are queued for the server's routine worker and the routines' incidents are raised or resolved. `--max-per-routine` limits retries started per routine in one pass (default 5). See the [CLI reference](../reference/cli.md#routines-reconcile).

## Tuning for self-hosting

These environment variables are optional. See the [environment reference](../reference/env.md).

| Variable | Default | Meaning |
| --- | --- | --- |
| `EVENT_ROUTINE_COALESCE_MS` | `30000` | Window in which repeated events start one run. |
| `ROUTINE_OVERLAP_DEFER_DELAY_MS` | `60000` | Wait before retrying an event run that met a run in progress. |
| `ROUTINE_OVERLAP_MAX_DEFERRALS` | `60` | How many times such a run retries before it is dropped. |
| `ROUTINE_EVENT_RECONCILE_LOOKBACK_DAYS` | `14` | How far back missed events are looked for. |
| `ROUTINE_EVENT_RECONCILE_MAX_RETRIES` | `3` | Retries for a missed event. |
| `NODE_EVENT_RUN_MAX_LEVEL` | `strict` | Highest guardrail level for computer runs started by an event. |
