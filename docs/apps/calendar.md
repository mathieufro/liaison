---
title: Calendar
description: "Connect Google Calendar, choose which calendars to sync, and view, create and edit events in Liaison or through an agent."
screenshot: "assets/screens/calendar.webp"
screenshotAlt: "The Calendar in month view with a mini month, the team calendar and events such as a team offsite and daily stand-ups."
---

Calendar brings your Google calendars into Liaison. You see your events by day, week or month, create and edit them here, and agents can check your schedule and book meetings for you.

## Connect Google Calendar

1. Open **Settings › Apps › Calendar**, section **Calendar accounts**. From an empty calendar you can also click **Connect Google Calendar**.
2. Click **Connect**. You are sent to Google's consent screen.
3. Approve calendar access. Liaison stores only the tokens Google returns, never your password.
4. Under **Calendars to sync**, tick the calendars to import. Only selected calendars are synced and show events.

Calendar uses the workspace's Google OAuth client, shared with Gmail (see [Mail](mail.md#connect-gmail)). Calendar access is a Google-sensitive scope, so the Google app must be an Internal Google Workspace app or a verified External app.

A calendar admin (`calendar:accounts:admin`) manages org-wide calendar connections that everyone in the organization can see.

If an import fails, the account shows **Retry**. If access was revoked, reconnect the account. Disconnecting deletes the calendars and events imported from that account from Liaison. Your events stay in Google Calendar.

## Import an iCalendar file

You can bring events from another calendar tool as an `.ics` file. Upload the file, then start an import of **Calendar events** (`calendar.event`) with the format `ics` (`POST /api/imports`, which needs `kernel:imports:run`). The import itself needs `calendar:accounts:admin` and `calendar:events:write`.

- The events go into a calendar named **Imported** that belongs to the person who ran the import. Only they can see it: people who join later and others who import do not.
- An imported calendar is never synced with Google: Liaison does not poll it, watch it or push changes from it.
- Time zones, all-day events and recurring events are kept. A changed occurrence of a recurring event becomes its own event.
- Importing the same file again skips the events already there.
- The run appears under **Settings › Organization › Imports**, where you can undo it.

## View your calendar

1. Click **Calendar** in the activity bar.
2. Switch between **Day**, **Week** and **Month**. Use **Today**, **Previous** and **Next** to move around.
3. Your calendars are listed under **My calendars** in the sidebar.

## Create or edit an event

1. Click **New event**, or click an existing event to edit it.
2. Fill in **Title**, **Start** and **End** (or tick **All day**), **Description**, **Location**, **Calendar** and **Recurrence** (**Does not repeat**, **Daily**, **Weekly**, **Monthly**).
3. Add **Attendees** as comma-separated email addresses.
4. Click **Save**, or **Delete** to remove the event.

Attendees are not emailed: changes in Liaison do not send Google invitations. Only the organizer can change an event's guest list. A recurring event cannot be edited here yet, because a change would affect the whole series. An event with a Meet link shows **Join with Google Meet**.

## Away days from your calendar

Your own primary calendar, connected as your personal account, tells Liaison when you are away. Calendars shared with you, a colleague's included, and organization accounts never do.

- An **out-of-office** event you made that covers at least one whole working day (from your work hours) marks you away for those days at once. Home says so with the dates and who is next in line. Part of a day counts for nothing.
- An all-day event you organise or accepted whose title looks like leave (for example "Congés", "RTT", "Holiday", "PTO") is asked about once on Home and under **Away** on your profile: **Yes** counts it, **No** sets it aside for good. At most three questions are open at once; the others wait.
- Moving the event moves your away days, with a line on Home. If someone else moves an event you only accepted, it is asked about again. A range longer than 30 days is always asked about.
- Cancelling the event removes the days, unless you ended them early. A recurring event counts once per occurrence over the next 60 days, kept up to date every day.
- Disconnecting the account removes the days it added and keeps the ones you said yourself. Event titles are never stored with your away days: Home reads a question's title from your calendar when it shows it.

## Ask an agent

Ask, for example, "What is on my calendar tomorrow?" or "Book a 30 minute call with orders@resonantaudiolabs.example on Thursday at 10 with a Meet link". The agent can create a real Google Meet link. It cannot create Teams or Zoom links. The calendar tools are not approval-gated, unless your organization adds an approval policy (see [Approve what agents do](../agents/approvals.md)).

Ask "Open the quarter review" and the agent opens the calendar on that event's day, with the event open.

## Roles and scopes

| Role | Scopes |
|---|---|
| `member` | `calendar:events:read`, `calendar:events:write`, `calendar:calendars:read`, `calendar:accounts:read` |
| `admin` | `member` plus `calendar:accounts:admin` |

`calendar:approve` decides any Calendar approvals. See the [scope reference](../reference/scopes.md) and [roles](../admin/roles.md).

## What agents can do

| Tool | What it does | Scope |
|---|---|---|
| `list_accounts` | List connected Google Calendar accounts | `calendar:events:read` |
| `list_calendars` | List calendars and whether each is selected for sync | `calendar:events:read` |
| `list_events` | List events in a time window, with recurring events expanded | `calendar:events:read` |
| `search_events` | Search events by title, description and location | `calendar:events:read` |
| `create_event` | Create an event, optionally with a Google Meet link | `calendar:events:write` |
| `update_event` | Change time, title, description, location, guests or the Meet link, for one occurrence or the series | `calendar:events:write` |
| `delete_event` | Delete an event, one occurrence or the series | `calendar:events:write` |
| `set_selected` | Turn sync on or off for a calendar | `calendar:events:write` |
| `retry_import` | Re-run a failed account import | `calendar:events:write` |

See the [agent tool reference](../reference/agent-tools.md).
