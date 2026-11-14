---
title: Follow and steer sessions
description: "Watch what agents do on your computers, answer their questions, stop or redirect them, review changes, and import your Claude Code sessions."
---

A session is one run of Claude Code on one of your computers. The **Sessions** app lists them all, whoever or whatever started them: you, an agent from a chat, a routine, or another agent you attached. This page shows how to follow one, step in when it needs you, and bring in sessions you started elsewhere.

Only you see your sessions. No other user sees them, administrators included.

## Read the Sessions list

Open **Sessions**. The list is grouped:

| Group | Contains |
| --- | --- |
| **Needs you** | Sessions waiting for a permission, a question or a plan to approve |
| **Running** | Sessions at work |
| **Paused** | Sessions whose computer went offline. They resume when it returns. |
| **Done** | Sessions that finished |
| **Failed or stopped** | Sessions that failed or that you stopped |
| **Older** | Earlier sessions. Use **Load more**. |

A session has one of these statuses: **Queued**, **Running**, **Waiting on you**, **Paused**, **Done**, **Stopped**, **Failed** or **Needs you**. A row shows who started it (an agent, **Routine**, **You**, **Imported**, or an agent asked by someone else) and its elapsed time. The top of the page shows each computer as **online** or **offline**.

If you have no sessions yet the page says **Nothing running on your computer** and explains where sessions come from. If you have no computer, it says **No computer yet** and points you to **Settings › Computers**.

You are notified when a session needs you, is done or has failed: **Session needs you**, **Session done**, **Session failed**. On a phone the same list opens with a **Sessions** header.

## Start a session from the app

1. Open **Sessions** and click **New**.
2. In **New session on** the computer's name, fill in:

   | Field | What it does |
   | --- | --- |
   | **What should it do?** | The prompt. |
   | **Folder** | One of the folders you shared. **No folder (Liaison Node)** works in a fresh folder. Repositories get their own worktree and branch. |
   | **Model** | One the computer offers. |
   | **Agent** | Defaults to your personal agent. |
   | **Level** | **Strict**, **Standard** or **Open**. Defaults to the agent's level on this computer. |
   | **Run on its own** | The session continues without asking you when it can. |
   | **When finished** | **Open a pull request** (default), **Commit only** or **Leave uncommitted**. |

3. Click **Start**.

Choosing a level above the agent's saved one asks you to confirm it first, and **Open** always asks. See [Guardrails and permission modes](../computers/guardrails.md). If no computer is set up, the dialog says to set one up first.

## Open a session

The session page shows the whole run.

- **Header.** The folder, **Branch** (and **pushed** once it is), **Pull request** link, the model, the level, the computer, **Reasoning**, tokens (with a breakdown by cache), the **Context** used and whether the prompt cache is warm. **Open in VS Code** opens the folder, and **More actions** holds the rest.
- **Transcript.** The agent's words, its tool calls and results, and system lines such as **Hooks are off** or **Continued automatically after the interruption**. Results over 64 KB are cut. Click **Show full output** to ask the computer for the rest. It is kept on the computer for 24 hours, and the page says so if the computer is offline or the output is gone.
- **Files changed.** The drawer lists every file the session changed with its diff. A change cut at 64 KB says so.
- **Plan.** The session's to-do list, **N of N** done.
- **Subagents.** A panel of **Active** and **Finished** subagents, with tool-call counts, the last tool used and **stuck** warnings. Open one to read its events. **Stop subagent** stops that one alone.
- **Atelier steps.** For an Atelier pipeline, a stepper shows **Waiting for you**, **Complete** or **Failed**.

Click **Mute this session** to stop its notifications.

## Steer a session

Use the box at the bottom.

1. Type a message and click **Send**. A running session reads it at its next step. A queued session reads it when it starts. A paused session gets it when the computer is back. A finished session resumes where it stopped.
2. Click **Stop** to stop it.
3. Click **Mark done** in the header to close a session yourself. If the app on that computer is too old, the page asks you to update it.
4. Open **Session settings** to change the **Model**, the **Level**, the **Reasoning** effort or **Run on its own**. These apply from the next step.

Changing the level to a higher one asks you to confirm in the app: **Raise this session to** the level. The session restarts at the new level when its current step ends and keeps its conversation. Lowering it restarts it right away and asks nothing.

If a model is not offered by the computer, the session keeps its model.

### Answer what a session asks

A session can stop to ask you something. It then sits under **Needs you** and the page shows a card.

| Card | Choices |
| --- | --- |
| **Needs your OK to run** (a permission) | **Allow once**, **Allow for this session**, **Deny**. The session waits for you with no time limit. |
| **Question for you** | Pick an option or **Other**, type **Your answer**, then click **Answer**. Several questions are answered in their own cards. |
| **Plan to approve** | **Approve plan** or **Keep planning**. |

In **Auto**, a session asks before shell commands once it has read text from outside your organization. A download from the Liaison server the computer is connected to does not count. See [Security](security.md).

A browser test (a Playwright run) runs outside the sandbox. Its card warns that the repository's own code it loads runs with your full rights, and lists the files of that kind that changed. It is never allowed automatically.

You can also steer through your agent. In a chat it can list, read, message, stop, answer and change settings for your sessions with `computer_session_list`, `computer_session_read`, `computer_session_send`, `computer_session_stop`, `computer_session_answer` and `computer_session_settings`. Sending a message or an answer, or switching a session to run on its own, only works from a message you typed yourself. It is refused for routines, other agents and MCP clients, and waits for your approval if the turn read outside text. Raising a level cannot be done by an agent: it answers that a confirmation is required. A read of a session that has opened no pull request says so, with the session's status.

## When a computer goes offline

Running sessions become **Paused** and show that the computer went offline. Your messages wait. When the computer is back, the session resumes and says so (**Resumed after the computer was offline**). A session whose process ended is resumed in a new run with the same conversation (**Resumed after the process ended**). The computer, not the server, keeps your files, so nothing is lost.

A short drop does not pause anything: a computer that reconnects within 5 seconds keeps its sessions running. When the server restarts (an upgrade), the computer gets 30 seconds to reconnect before its sessions pause.

## Import your Claude Code sessions

You can bring Claude Code sessions you started in VS Code or a terminal into Liaison, to read them from anywhere or to keep working on them there.

1. In **Sessions**, click **Import**. The page **Import sessions** opens, headed **Import from** the computer's name. Pick the **Computer** if you have several.
2. Under **Working in**, pick a folder. The page lists the sessions Claude Code recorded there, each marked **Available**, **Open now** or **In Liaison**. Use **Search by title, folder or branch**, or **Search all sessions on this computer**.
3. Choose how to bring the session in:

   | Choice | What it does |
   | --- | --- |
   | **Follow** | A read-only live mirror. Liaison shows the session as you work on it in VS Code or the terminal. You cannot send it messages. It reads **Following VS Code** (or **Terminal**). |
   | **Take over** | Continue the session from Liaison. |

4. To stop mirroring a session, click **Stop following**. To remove a Liaison copy of an imported session, click **Delete from Liaison**. The transcript stays on your computer. A session that is running must be stopped first.

Good to know:

- A session is imported once. It then reads **Imported**, **In Liaison**.
- Folders with Claude Code sessions that are not shared appear under **Not shared yet**. Click **Share this folder** to list their sessions. Your home folder and hidden or system folders cannot be shared.
- Liaison removes keys, tokens, private keys and secret lines before anything leaves the computer. This is best effort. A transcript may also contain content the session read from outside the folder.
- If another Claude Code is driving the session right now (VS Code, a terminal or another), the header says so, for example **Driven from VS Code**. Taking over or sending a message then resumes it in Liaison as well, so you are asked to confirm by clicking **Take over** or **Send** a second time. An orphaned Claude process that still holds the session can be ended with **Stop it**.
- Older history beyond the window stays on the computer, and a session that is no longer in a shared folder cannot be imported.

An agent can list and import for you with `computer_session_import_list` and `computer_session_import` (mode `follow` or `take_over`). The import is an approval card that only you can decide, and no policy approves it.

## Next steps

- [Run work on your computer](../computers/run-work.md)
- [Guardrails and permission modes](../computers/guardrails.md)
- [Security of a computer](../computers/security.md)
