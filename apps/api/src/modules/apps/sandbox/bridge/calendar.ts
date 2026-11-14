// SPDX-License-Identifier: FSL-1.1-ALv2

import { enqueueAppJob } from "~/infra/jobs/jobs"
import type { BridgeContext } from "~/modules/apps/sandbox/bridge/context"
import { hasScope } from "~/modules/permissions/permissions"

/**
 * Whether the caller may manage org calendar connections. Scopes reach the bridge unexpanded:
 * an org admin holds the literal '*' (or 'calendar:*' / 'calendar'), so a literal includes()
 * refused them. hasScope applies the same wildcard and prefix rules as the RLS scope check.
 */
export function isCalendarAdmin(callerScopes: string[] | undefined): boolean {
  return hasScope("calendar:accounts:admin", callerScopes ?? [])
}

/**
 * Calendar create/update-event tools declare `start`/`end` as plain ISO strings in their
 * manifest param schema (matching the frontend's `CreateEventInput`/`UpdateEventInput`), but
 * `~/apps/calendar/sync.ts`'s `createLocalEvent`/`updateLocalEvent` persist the `start`/`end`
 * JSONB columns in Google's `{dateTime}`/`{date}` point shape (the same shape `listEventsForCaller`
 * reads back with `toDate()`). Passing the bare string straight through silently JSON-stringifies
 * it into a scalar JSONB value instead of a point object — `toDate()` then fails to parse it,
 * so the event vanishes from every window-scoped read (list/search) without ever erroring.
 * Converts at the bridge boundary so `sync.ts` always receives the point shape it expects.
 */
function isoStringToCalendarPoint(
  iso: string | undefined,
  allDay: boolean | undefined,
): { dateTime: string } | { date: string } | undefined {
  if (!iso) return undefined
  return allDay ? { date: iso.slice(0, 10) } : { dateTime: iso }
}

/** A create/update carrying a conference change is pushed by the tool handler itself, so the
 * Meet link can be returned; its queued push job waits this long and only acts if that
 * immediate push did not land. */
const CONFERENCE_PUSH_BACKUP_DELAY_MS = 60_000

/** The calendar app surface. */
export function createCalendarMethods(ctx: BridgeContext): Record<string, any> {
  const { callerScopes, orgId, requireApp, txDb, userId } = ctx
  return {
    /** Rows for a company's or a contact's timeline, read under the caller's row security. */
    calendar_activityRead: async (paramsJson: string): Promise<string> => {
      if (ctx.appName !== "calendar")
        throw new Error("calendar_activityRead is only available to the calendar app")
      const { hasScope } = await import("~/modules/permissions/permissions")
      if (!hasScope("calendar:events:read", ctx.callerScopes ?? [])) {
        throw new Error("forbidden: missing scope calendar:events:read")
      }
      const { calendarActivityRows } = await import("~/apps/calendar/activity-source")
      const { withReadOnlySource } = await import("~/modules/contacts/activity")
      const params = JSON.parse(paramsJson)
      return JSON.stringify(
        await withReadOnlySource(ctx.txDb as never, (tx) =>
          calendarActivityRows(tx, ctx.orgId, params),
        ),
      )
    },
    // --- Calendar-specific bridge methods (gated; only meaningful when appName === "calendar") ---
    // Host-side sync logic lives in ~/apps/calendar/*.ts (plain host modules, not sandboxed);
    // these methods are the only seam the calendar app's sandboxed handlers.ts can reach it
    // through — see spec-plan Amendment 1 (calendar is trusted:true but handlers.ts stays a
    // thin sandboxed delegator, mirroring tickets).
    calendar_onAccountConnected: async (eventJson: string): Promise<void> => {
      requireApp("calendar", "calendar_onAccountConnected")
      const { onAccountConnected } = await import("~/apps/calendar/sync")
      const event = JSON.parse(eventJson)
      await onAccountConnected(txDb, orgId, event, async (jobName, payload) => {
        await enqueueAppJob("calendar", jobName, payload)
      })
    },

    calendar_grantOrgAccess: async (userId: string): Promise<void> => {
      requireApp("calendar", "calendar_grantOrgAccess")
      const { grantOrgCalendarAccessToUser } = await import("~/apps/calendar/sync")
      await grantOrgCalendarAccessToUser(txDb, orgId, userId)
    },

    calendar_onAccountDisconnected: async (eventJson: string): Promise<void> => {
      requireApp("calendar", "calendar_onAccountDisconnected")
      const { onAccountDisconnected } = await import("~/apps/calendar/sync")
      const event = JSON.parse(eventJson)
      await onAccountDisconnected(txDb, orgId, event)
    },

    calendar_runJob: async (_jobName: string, _payloadJson: string): Promise<void> => {
      requireApp("calendar", "calendar_runJob")
      // calendar-import is handled directly by the sandboxed calendarImport handler (needs
      // ctx.fetch/connections_getToken) via calendar_importCalendars below. Tasks 5-6 fill in
      // push / watch-renewal / poll-fallback here.
    },

    calendar_getCalendar: async (calendarId: string): Promise<string> => {
      requireApp("calendar", "calendar_getCalendar")
      const { getCalendarById } = await import("~/apps/calendar/sync")
      const calendar = await getCalendarById(txDb, orgId, calendarId)
      return JSON.stringify(calendar ?? null)
    },

    calendar_applyInitialSyncPages: async (
      calendarId: string,
      calaccess: string,
      pagesJson: string,
    ): Promise<string> => {
      requireApp("calendar", "calendar_applyInitialSyncPages")
      const { applyInitialSyncPages } = await import("~/apps/calendar/sync")
      const pages = JSON.parse(pagesJson)
      const result = await applyInitialSyncPages(txDb, orgId, calendarId, calaccess, pages)
      return JSON.stringify(result)
    },

    calendar_applyIncrementalSyncPages: async (
      calendarId: string,
      pagesJson: string,
    ): Promise<string> => {
      requireApp("calendar", "calendar_applyIncrementalSyncPages")
      const { applyIncrementalSyncPages } = await import("~/apps/calendar/sync")
      const pages = JSON.parse(pagesJson)
      const result = await applyIncrementalSyncPages(txDb, orgId, calendarId, pages)
      return JSON.stringify(result)
    },

    calendar_recoverFromSyncTokenGone: async (calendarId: string): Promise<void> => {
      requireApp("calendar", "calendar_recoverFromSyncTokenGone")
      const { recoverFromSyncTokenGone } = await import("~/apps/calendar/sync")
      await recoverFromSyncTokenGone(txDb, orgId, calendarId, async (jobName, payload) => {
        await enqueueAppJob("calendar", jobName, payload)
      })
    },

    calendar_getAccount: async (accountId: string): Promise<string> => {
      requireApp("calendar", "calendar_getAccount")
      const { getAccountById } = await import("~/apps/calendar/sync")
      const account = await getAccountById(txDb, orgId, accountId)
      return JSON.stringify(account ?? null)
    },

    calendar_importCalendars: async (accountId: string, entriesJson: string): Promise<string> => {
      requireApp("calendar", "calendar_importCalendars")
      const { runCalendarImport } = await import("~/apps/calendar/sync")
      const entries = JSON.parse(entriesJson) as Array<{
        id: string
        summary?: string
        backgroundColor?: string
        timeZone?: string
        accessRole?: string
      }>
      const result = await runCalendarImport(
        txDb,
        orgId,
        accountId,
        async () => entries,
        async (jobName, payload) => {
          await enqueueAppJob("calendar", jobName, payload)
        },
      )
      return JSON.stringify(result)
    },

    calendar_recordImportFailure: async (
      accountId: string,
      status: number,
      bodyText: string,
    ): Promise<string> => {
      requireApp("calendar", "calendar_recordImportFailure")
      const { recordCalendarImportFailure } = await import("~/apps/calendar/sync")
      const result = await recordCalendarImportFailure(txDb, orgId, accountId, status, bodyText)
      return JSON.stringify(result)
    },

    calendar_retryImport: async (paramsJson: string): Promise<void> => {
      requireApp("calendar", "calendar_retryImport")
      const { requestCalendarReimport } = await import("~/apps/calendar/sync")
      const params = JSON.parse(paramsJson) as { accountId: string }
      await requestCalendarReimport(
        txDb,
        orgId,
        params.accountId,
        async (jobName, payload) => {
          await enqueueAppJob("calendar", jobName, payload)
        },
        {
          isAdmin: isCalendarAdmin(callerScopes),
          userId: userId && /^[0-9a-f-]{36}$/i.test(userId) ? userId : null,
        },
      )
    },

    calendar_setSelected: async (paramsJson: string): Promise<void> => {
      requireApp("calendar", "calendar_setSelected")
      const { setCalendarSelectedAndSync } = await import("~/apps/calendar/sync")
      const params = JSON.parse(paramsJson) as { calendarId: string; selected: boolean }
      await setCalendarSelectedAndSync(
        txDb,
        orgId,
        params.calendarId,
        params.selected,
        async (jobName, payload) => {
          await enqueueAppJob("calendar", jobName, payload)
        },
        {
          isAdmin: isCalendarAdmin(callerScopes),
          userId: userId && /^[0-9a-f-]{36}$/i.test(userId) ? userId : null,
        },
      )
    },

    calendar_handleWebhook: async (headersJson: string): Promise<void> => {
      requireApp("calendar", "calendar_handleWebhook")
      const { handleGooglePushNotification } = await import("~/apps/calendar/sync")
      const headers = JSON.parse(headersJson) as Record<string, string>
      const channelId = headers["x-goog-channel-id"] ?? headers["X-Goog-Channel-ID"] ?? ""
      const resourceId = headers["x-goog-resource-id"] ?? headers["X-Goog-Resource-ID"] ?? ""
      if (!channelId || !resourceId) return
      await handleGooglePushNotification(
        txDb,
        orgId,
        channelId,
        resourceId,
        async (jobName, payload, opts) => {
          await enqueueAppJob(
            "calendar",
            jobName,
            payload,
            opts ? { jobId: opts.jobId as string } : undefined,
          )
        },
      )
    },

    // The push token for ONE watch channel: HMAC(org push secret, channel id). The DB-less
    // verify seam recomputes it from the channel id Google echoes, so a token learned from
    // (or leaked for) one channel authenticates nothing else, and the org secret itself
    // never leaves the app.
    calendar_channelToken: async (secret: string, channelId: string): Promise<string> => {
      requireApp("calendar", "calendar_channelToken")
      const { createHmac } = await import("node:crypto")
      return createHmac("sha256", secret).update(channelId, "utf8").digest("base64")
    },

    calendar_recordWatchChannel: async (calendarId: string, infoJson: string): Promise<void> => {
      requireApp("calendar", "calendar_recordWatchChannel")
      const { recordWatchChannel } = await import("~/apps/calendar/sync")
      const info = JSON.parse(infoJson)
      await recordWatchChannel(txDb, orgId, calendarId, info)
    },

    calendar_findCalendarsForWatchRenewal: async (withinHours: number): Promise<string> => {
      requireApp("calendar", "calendar_findCalendarsForWatchRenewal")
      const { findCalendarsForWatchRenewal } = await import("~/apps/calendar/sync")
      const rows = await findCalendarsForWatchRenewal(txDb, orgId, withinHours)
      return JSON.stringify(rows)
    },

    calendar_stopWatchChannelOnly: async (calendarId: string, channelId: string): Promise<void> => {
      requireApp("calendar", "calendar_stopWatchChannelOnly")
      const { stopWatchChannelOnly } = await import("~/apps/calendar/sync")
      await stopWatchChannelOnly(txDb, orgId, calendarId, channelId)
    },

    calendar_findCalendarsForPollFallback: async (staleMinutes: number): Promise<string> => {
      requireApp("calendar", "calendar_findCalendarsForPollFallback")
      const { findCalendarsForPollFallback } = await import("~/apps/calendar/sync")
      const rows = await findCalendarsForPollFallback(txDb, orgId, staleMinutes)
      return JSON.stringify(rows)
    },

    calendar_markCalendarPolled: async (calendarId: string): Promise<void> => {
      requireApp("calendar", "calendar_markCalendarPolled")
      const { markCalendarPolled } = await import("~/apps/calendar/sync")
      await markCalendarPolled(txDb, orgId, calendarId)
    },

    calendar_listCalendars: async (): Promise<string> => {
      requireApp("calendar", "calendar_listCalendars")
      const { listCalendarsForCaller } = await import("~/apps/calendar/tools")
      const rows = await listCalendarsForCaller(txDb, orgId)
      return JSON.stringify(rows)
    },

    calendar_listAccounts: async (): Promise<string> => {
      requireApp("calendar", "calendar_listAccounts")
      const { listAccountsForCaller } = await import("~/apps/calendar/tools")
      // Ensure-on-read: a calendar connection the caller holds must have its app account row
      // (bound, owned, granted) before the list answers, else the calendar home asks to connect
      // an account Settings shows connected. Privileged: the faulty row may be invisible to the
      // caller. Import jobs are queued after that transaction commits (the job reads the row).
      // A one-SELECT health check runs first: the repair transaction (row locks, upserts) opens
      // only when a row is missing, mis-bound, disconnected, or the caller's grant is absent.
      const { withPrivilegedDb } = await import("~/db/privileged")
      if (userId && /^[0-9a-f-]{36}$/i.test(userId)) {
        const { callerCalendarAccountsNeedRepair, ensureCallerCalendarAccounts } = await import(
          "~/apps/calendar/sync"
        )
        const needsRepair = await withPrivilegedDb(orgId, "calendar-check-accounts", (tx) =>
          callerCalendarAccountsNeedRepair(tx, orgId, userId),
        )
        if (needsRepair) {
          const { jobs } = await withPrivilegedDb(orgId, "calendar-ensure-accounts", (tx) =>
            ensureCallerCalendarAccounts(tx, orgId, userId),
          )
          for (const payload of jobs) await enqueueAppJob("calendar", "calendar-import", payload)
        }
      }
      // A disconnect reaches the app through an asynchronous event: catch it up, so the list
      // Settings re-reads right after Disconnect no longer shows the account (one SELECT when
      // nothing is pending). After the rebind above, and never for an address that still has
      // an active connection (a re-auth): that account is kept.
      const { reconcileDisconnectedCalendarAccounts } = await import("~/apps/calendar/sync")
      await withPrivilegedDb(orgId, "calendar-reconcile-disconnected", (tx) =>
        reconcileDisconnectedCalendarAccounts(tx, orgId),
      )
      const rows = await listAccountsForCaller(txDb, orgId)
      return JSON.stringify(rows)
    },

    calendar_listEvents: async (paramsJson: string): Promise<string> => {
      requireApp("calendar", "calendar_listEvents")
      const { listEventsForCaller } = await import("~/apps/calendar/tools")
      const params = JSON.parse(paramsJson) as {
        calendarId?: string
        timeMin: string
        timeMax: string
      }
      const rows = await listEventsForCaller(txDb, orgId, params)
      return JSON.stringify(rows)
    },

    calendar_searchEvents: async (paramsJson: string): Promise<string> => {
      requireApp("calendar", "calendar_searchEvents")
      const { searchEventsForCaller } = await import("~/apps/calendar/tools")
      const params = JSON.parse(paramsJson) as { query: string; limit?: number }
      const rows = await searchEventsForCaller(txDb, orgId, params.query, params.limit)
      return JSON.stringify(rows)
    },

    calendar_createEvent: async (paramsJson: string): Promise<string> => {
      requireApp("calendar", "calendar_createEvent")
      const { createLocalEvent, getCalendarById } = await import("~/apps/calendar/sync")
      const { isWellFormedEmail, resolveConferenceIntent } = await import("~/apps/calendar/tools")
      const params = JSON.parse(paramsJson) as {
        calendarId: string
        title?: string
        description?: string
        location?: string
        attendees?: string[]
        recurrence?: string[]
        start?: string
        end?: string
        allDay?: boolean
        conference?: string
      }
      const { conference, location } = resolveConferenceIntent(params, "create")
      for (const email of params.attendees ?? []) {
        if (!isWellFormedEmail(email)) {
          throw new Error(`calendar_createEvent: malformed attendee email "${email}"`)
        }
      }
      const calendar = await getCalendarById(txDb, orgId, params.calendarId)
      if (!calendar) throw new Error(`calendar ${params.calendarId} not found`)
      const { eventId } = await createLocalEvent(
        txDb,
        orgId,
        params.calendarId,
        calendar.calaccess,
        {
          title: params.title,
          description: params.description,
          location,
          attendees: params.attendees,
          recurrence: params.recurrence,
          allDay: params.allDay,
          start: isoStringToCalendarPoint(params.start, params.allDay),
          end: isoStringToCalendarPoint(params.end, params.allDay),
          conference,
        },
      )
      // One job per row version: a duplicate request does not push twice. A conference change
      // is pushed by the tool handler right away (to return the Meet link); the job then only
      // backs it up.
      await enqueueAppJob(
        "calendar",
        "calendar-push",
        { orgId, eventId },
        {
          jobId: `calendar-push:${eventId}:v1:a0`,
          ...(conference ? { delay: CONFERENCE_PUSH_BACKUP_DELAY_MS } : {}),
        },
      )
      return JSON.stringify({ eventId, conference: conference ?? null })
    },

    calendar_updateEvent: async (paramsJson: string): Promise<string> => {
      requireApp("calendar", "calendar_updateEvent")
      const { resolveUpdateTarget, updateLocalEvent } = await import("~/apps/calendar/sync")
      const { isWellFormedEmail, resolveConferenceIntent } = await import("~/apps/calendar/tools")
      const params = JSON.parse(paramsJson) as {
        eventId: string
        title?: string
        description?: string
        location?: string
        attendees?: string[]
        recurrence?: string[]
        start?: string
        end?: string
        allDay?: boolean
        conference?: string
        calendarId?: string
        scope?: "occurrence" | "series"
        occurrenceStart?: string
      }
      const { conference, location } = resolveConferenceIntent(params, "update")
      for (const email of params.attendees ?? []) {
        if (!isWellFormedEmail(email)) {
          throw new Error(`calendar_updateEvent: malformed attendee email "${email}"`)
        }
      }
      // A recurring meeting needs an explicit scope: one occurrence (its own row, created for
      // Google's instance when needed) or the whole series (the master row).
      const target = await resolveUpdateTarget(txDb, orgId, {
        eventId: params.eventId,
        calendarId: params.calendarId,
        scope: params.scope,
        occurrenceStart: params.occurrenceStart,
        changesRecurrence: params.recurrence !== undefined,
      })
      const eventId = target.eventId
      const { syncVersion } = await updateLocalEvent(txDb, orgId, eventId, {
        title: params.title,
        description: params.description,
        location,
        attendees: params.attendees,
        recurrence: params.recurrence,
        allDay: params.allDay,
        start: isoStringToCalendarPoint(params.start, params.allDay),
        end: isoStringToCalendarPoint(params.end, params.allDay),
        conference,
      })
      await enqueueAppJob(
        "calendar",
        "calendar-push",
        { orgId, eventId },
        {
          jobId: `calendar-push:${eventId}:v${syncVersion}:a0`,
          ...(conference ? { delay: CONFERENCE_PUSH_BACKUP_DELAY_MS } : {}),
        },
      )
      return JSON.stringify({
        eventId,
        ...(target.scope ? { scope: target.scope } : {}),
        conference: conference ?? null,
      })
    },

    calendar_deleteEvent: async (paramsJson: string): Promise<string> => {
      requireApp("calendar", "calendar_deleteEvent")
      const { deleteLocalEvent, resolveUpdateTarget } = await import("~/apps/calendar/sync")
      const params = JSON.parse(paramsJson) as {
        eventId: string
        calendarId?: string
        scope?: "occurrence" | "series"
        occurrenceStart?: string
      }
      // A recurring meeting needs an explicit scope, as for update_event: one occurrence (Google
      // cancels that instance only) or the whole series (the master is deleted).
      let target: { eventId: string; scope: "occurrence" | "series" | null }
      try {
        target = await resolveUpdateTarget(txDb, orgId, { ...params, tool: "delete_event" })
      } catch (err) {
        // Already gone (a repeated delete): nothing to do, as before.
        if ((err as { status?: number }).status === 404) {
          return JSON.stringify({ eventId: params.eventId, needsGooglePush: false, notFound: true })
        }
        throw err
      }
      const eventId = target.eventId
      // An event Google has (or may have: a create in flight) becomes a tombstone that the push
      // deletes on Google, retrying like any push; the import cannot resurrect it meanwhile.
      const { needsGooglePush, syncVersion } = await deleteLocalEvent(txDb, orgId, eventId)
      if (needsGooglePush && syncVersion !== null) {
        await enqueueAppJob(
          "calendar",
          "calendar-push",
          { orgId, eventId },
          { jobId: `calendar-push:${eventId}:v${syncVersion}:a0` },
        )
      }
      return JSON.stringify({
        eventId,
        ...(target.scope ? { scope: target.scope } : {}),
        needsGooglePush,
      })
    },

    calendar_restoreRefusedDelete: async (
      eventId: string,
      message: string,
      syncVersion: number,
      remoteJson: string,
    ): Promise<string> => {
      requireApp("calendar", "calendar_restoreRefusedDelete")
      const { restoreRefusedDelete } = await import("~/apps/calendar/sync")
      return JSON.stringify(
        await restoreRefusedDelete(
          txDb,
          orgId,
          eventId,
          message,
          syncVersion,
          JSON.parse(remoteJson || "null"),
        ),
      )
    },

    calendar_finalizeRemoteDelete: async (eventId: string): Promise<void> => {
      requireApp("calendar", "calendar_finalizeRemoteDelete")
      const { finalizeRemoteDelete } = await import("~/apps/calendar/sync")
      await finalizeRemoteDelete(txDb, orgId, eventId)
    },

    calendar_getEvent: async (eventId: string): Promise<string> => {
      requireApp("calendar", "calendar_getEvent")
      const { getEventById } = await import("~/apps/calendar/sync")
      const event = await getEventById(txDb, orgId, eventId)
      return JSON.stringify(event ?? null)
    },

    calendar_applyPushResult: async (eventId: string, resultJson: string): Promise<string> => {
      requireApp("calendar", "calendar_applyPushResult")
      const { applyPushResult } = await import("~/apps/calendar/sync")
      const result = JSON.parse(resultJson)
      return JSON.stringify(await applyPushResult(txDb, orgId, eventId, result))
    },

    calendar_handlePushConflict: async (eventId: string, inputJson: string): Promise<string> => {
      requireApp("calendar", "calendar_handlePushConflict")
      const { handlePushConflict } = await import("~/apps/calendar/sync")
      const input = JSON.parse(inputJson)
      const result = await handlePushConflict(txDb, orgId, eventId, input)
      return JSON.stringify(result)
    },

    calendar_findStalePendingPushes: async (staleMinutes: number): Promise<string> => {
      requireApp("calendar", "calendar_findStalePendingPushes")
      const { findStalePendingPushes } = await import("~/apps/calendar/sync")
      return JSON.stringify(await findStalePendingPushes(txDb, orgId, staleMinutes))
    },

    calendar_applyRemoteDeletion: async (eventId: string, syncVersion: number): Promise<void> => {
      requireApp("calendar", "calendar_applyRemoteDeletion")
      const { applyRemoteDeletion } = await import("~/apps/calendar/sync")
      await applyRemoteDeletion(txDb, orgId, eventId, syncVersion)
    },

    calendar_markPushRejected: async (
      eventId: string,
      message: string,
      syncVersion: number,
    ): Promise<void> => {
      requireApp("calendar", "calendar_markPushRejected")
      const { markPushRejected } = await import("~/apps/calendar/sync")
      await markPushRejected(txDb, orgId, eventId, message, syncVersion)
    },

    calendar_notePushFailure: async (eventId: string, syncVersion: number): Promise<string> => {
      requireApp("calendar", "calendar_notePushFailure")
      const { notePushFailure } = await import("~/apps/calendar/sync")
      return JSON.stringify(await notePushFailure(txDb, orgId, eventId, syncVersion))
    },

    calendar_revertToRemote: async (
      eventId: string,
      remoteJson: string,
      detail: string,
      syncVersion: number,
    ): Promise<void> => {
      requireApp("calendar", "calendar_revertToRemote")
      const { revertEventToGoogle } = await import("~/apps/calendar/sync")
      await revertEventToGoogle(txDb, orgId, eventId, JSON.parse(remoteJson), detail, syncVersion)
    },

    calendar_recordPushFailure: async (
      eventId: string,
      calendarId: string,
      errorKind: string,
      detail: string,
    ): Promise<void> => {
      requireApp("calendar", "calendar_recordPushFailure")
      const { recordPushFailure } = await import("~/apps/calendar/sync")
      await recordPushFailure(txDb, orgId, eventId, calendarId, errorKind, detail)
    },
  }
}
