// SPDX-License-Identifier: FSL-1.1-ALv2
// Calendar handlers: a core app's server module (modules/apps/core/registry.ts).
// Every handler the manifest names is a named export `(params, ctx, ...extra)`,
// imported and called in the API process with a typed host ctx
// (modules/apps/core/ctx.ts): the run's bridge methods, called directly. The
// host-side sync logic lives in the sibling modules (sync.ts, tools.ts) behind
// the `calendar_*` methods.

import type { CoreCtx } from "~/modules/apps/core/ctx"

export interface CalendarMethods {
  calendar_activityRead(paramsJson: string): Promise<string>
  getUserId(): string
  getOrgId(): string
  db_findMany(entity: string, optsJson: string): Promise<string>
  db_findOne(entity: string, id: string): Promise<string>
  db_insert(entity: string, dataJson: string): Promise<string>
  db_update(entity: string, id: string, dataJson: string): Promise<void>
  db_delete(entity: string, id: string): Promise<void>
  emit(eventJson: string): Promise<void>
  enqueueJob(jobName: string, payloadJson: string, optsJson?: string): Promise<void>
  connections_getToken(connectionName: string, identifier?: string): Promise<string>
  config_get(key: string): Promise<string | null>
  crypto_timingSafeEqual(a: string, b: string): Promise<boolean>
  fetch(url: string, optsJson: string): Promise<string>
  log_info(msg: string, dataJson?: string): void
  log_warn(msg: string, dataJson?: string): void
  log_error(msg: string, dataJson?: string): void
  calendar_onAccountConnected: (eventJson: string) => Promise<void>
  calendar_onAccountDisconnected: (eventJson: string) => Promise<void>
  calendar_grantOrgAccess: (userId: string) => Promise<void>
  calendar_runJob: (jobName: string, payloadJson: string) => Promise<void>
  calendar_handleWebhook: (headersJson: string) => Promise<void>
  calendar_listCalendars: () => Promise<string>
  calendar_listAccounts: () => Promise<string>
  calendar_listEvents: (paramsJson: string) => Promise<string>
  calendar_searchEvents: (paramsJson: string) => Promise<string>
  calendar_createEvent: (paramsJson: string) => Promise<string>
  calendar_updateEvent: (paramsJson: string) => Promise<string>
  calendar_deleteEvent: (paramsJson: string) => Promise<string>
  calendar_getAccount: (accountId: string) => Promise<string>
  calendar_importCalendars: (accountId: string, entriesJson: string) => Promise<string>
  calendar_recordImportFailure: (accountId: string, status: number, body: string) => Promise<string>
  calendar_retryImport: (paramsJson: string) => Promise<void>
  calendar_setSelected: (calendarIdJson: string) => Promise<void>
  calendar_getCalendar: (calendarId: string) => Promise<string>
  calendar_applyInitialSyncPages: (
    calendarId: string,
    calaccess: string,
    pagesJson: string,
  ) => Promise<string>
  calendar_applyIncrementalSyncPages: (calendarId: string, pagesJson: string) => Promise<string>
  calendar_recoverFromSyncTokenGone: (calendarId: string) => Promise<void>
  calendar_getEvent: (eventId: string) => Promise<string>
  /** Returns `{ rowExists }` JSON: false when the row was deleted while the push was in flight. */
  calendar_applyPushResult: (eventId: string, resultJson: string) => Promise<string | undefined>
  calendar_handlePushConflict: (eventId: string, inputJson: string) => Promise<string>
  calendar_revertToRemote: (
    eventId: string,
    remoteJson: string,
    detail: string,
    syncVersion: number,
  ) => Promise<void>
  calendar_findStalePendingPushes: (staleMinutes: number) => Promise<string>
  calendar_applyRemoteDeletion: (eventId: string, syncVersion: number) => Promise<void>
  calendar_markPushRejected: (
    eventId: string,
    message: string,
    syncVersion: number,
  ) => Promise<void>
  calendar_notePushFailure: (eventId: string, syncVersion: number) => Promise<string>
  calendar_finalizeRemoteDelete: (eventId: string) => Promise<void>
  calendar_restoreRefusedDelete: (
    eventId: string,
    message: string,
    syncVersion: number,
    remoteJson: string,
  ) => Promise<string>
  calendar_recordPushFailure: (
    eventId: string,
    calendarId: string,
    errorKind: string,
    detail: string,
  ) => Promise<void>
  calendar_recordWatchChannel: (calendarId: string, infoJson: string) => Promise<void>
  calendar_channelToken: (secret: string, channelId: string) => Promise<string>
  calendar_findCalendarsForWatchRenewal: (withinHours: number) => Promise<string>
  calendar_stopWatchChannelOnly: (calendarId: string, channelId: string) => Promise<void>
  calendar_findCalendarsForPollFallback: (staleMinutes: number) => Promise<string>
  calendar_markCalendarPolled: (calendarId: string) => Promise<void>
}

type CalendarCtx = CoreCtx<CalendarMethods>

interface KernelConnectionEvent {
  orgId: string
  actorId: string
  data: {
    id: string
    appName: string
    ownerType: string
    ownerId: string | null
    identifier: string
    connectionName: string
  }
}

interface KernelDisconnectEvent {
  orgId: string
  data: { id: string; appName: string }
}

// --- Event handlers ---

export async function onAccountConnected(
  event: KernelConnectionEvent,
  ctx: CalendarCtx,
): Promise<void> {
  if (event.data?.appName !== "calendar") return
  await ctx.calendar_onAccountConnected(JSON.stringify(event))
}

export async function onAccountDisconnected(
  event: KernelDisconnectEvent,
  ctx: CalendarCtx,
): Promise<void> {
  if (event.data?.appName !== "calendar") return
  await ctx.calendar_onAccountDisconnected(JSON.stringify(event))
}

/** kernel/user:registered — a user who joins AFTER an org calendar was connected must still
 * receive the calendar:calaccess grants for org-owned accounts (import-time fan-out only
 * covers users active at import). */
export async function onUserRegistered(
  event: { entityId?: string },
  ctx: CalendarCtx,
): Promise<void> {
  const userId = event?.entityId
  if (!userId) return
  await ctx.calendar_grantOrgAccess(userId)
}

// --- Job handlers ---

const GOOGLE_CALENDAR_API_BASE = "https://www.googleapis.com/calendar/v3"

interface FetchResult {
  status: number
  headers: Record<string, string>
  body: string
}

/**
 * calendarImport — the `calendar-import` job. Resolves the OAuth token
 * (ctx.connections_getToken) and issues HTTP through ctx.fetch. Lists
 * calendarList.list, then hands the raw entries to the host `calendar_importCalendars` bridge
 * method, which does the DB persistence, membership-dimension grant, and per-calendar
 * initial-sync job enqueue (host-side logic in sync.ts's runCalendarImport).
 */
/** A query string from `params`, built with encodeURIComponent. Skips null/undefined values. */
function buildQueryString(params: Record<string, string | null | undefined>): string {
  const parts: string[] = []
  for (const key of Object.keys(params)) {
    const value = params[key]
    if (value === null || value === undefined) continue
    parts.push(`${encodeURIComponent(key)}=${encodeURIComponent(value)}`)
  }
  return parts.join("&")
}

export async function calendarImport(payload: unknown, ctx: CalendarCtx): Promise<void> {
  const { accountId } = (payload ?? {}) as { accountId?: string }
  if (!accountId) return
  const accountJson = await ctx.calendar_getAccount(accountId)
  const account = JSON.parse(accountJson) as { email_address: string } | null
  if (!account) return

  const token = await ctx.connections_getToken("google-calendar", account.email_address)
  const entries: unknown[] = []
  let pageToken: string | undefined
  do {
    const qs = buildQueryString({ minAccessRole: "reader", pageToken })
    const raw = await ctx.fetch(
      `${GOOGLE_CALENDAR_API_BASE}/users/me/calendarList?${qs}`,
      JSON.stringify({ method: "GET", headers: { Authorization: `Bearer ${token}` } }),
    )
    const res = JSON.parse(raw) as FetchResult
    if (res.status < 200 || res.status >= 300) {
      // Never import an empty list as a success: the account goes to `error` with Google's
      // reason stored as last_sync_error (retry_import or a reconnect clears it).
      const failure = JSON.parse(
        await ctx.calendar_recordImportFailure(accountId, res.status, res.body ?? ""),
      ) as { reason: string | null; message: string }
      ctx.log_error(
        "calendar import: calendarList.list failed",
        JSON.stringify({
          accountId,
          status: res.status,
          reason: failure.reason,
          error: failure.message,
        }),
      )
      return
    }
    const body = JSON.parse(res.body) as { items?: unknown[]; nextPageToken?: string }
    entries.push(...(body.items ?? []))
    pageToken = body.nextPageToken
  } while (pageToken)

  await ctx.calendar_importCalendars(accountId, JSON.stringify(entries))
}

interface CalendarRowShape {
  id: string
  account_id: string
  google_calendar_id: string
  sync_token: string | null
  calaccess: string
}

interface AccountRowShape {
  id: string
  email_address: string
}

/** Frozen events.list param set (Design section): singleEvents=false always; never
 * showDeleted=false alongside a syncToken (omit it on incremental, true on initial). */
function buildEventsListQuery(opts: {
  syncToken?: string | null
  pageToken?: string | null
}): string {
  return buildQueryString({
    singleEvents: "false",
    syncToken: opts.syncToken ?? undefined,
    showDeleted: opts.syncToken ? undefined : "true",
    pageToken: opts.pageToken ?? undefined,
  })
}

interface EventsListPage {
  items?: unknown[]
  nextPageToken?: string
  nextSyncToken?: string
}

async function fetchEventsListPages(
  ctx: CalendarCtx,
  token: string,
  googleCalendarId: string,
  syncToken: string | null,
  onPage: (page: EventsListPage) => Promise<void>,
): Promise<{ gone: boolean }> {
  // Pages are handed on one at a time via onPage, so a multi-thousand-event calendar's
  // full page set is never held in memory at once.
  let pageToken: string | undefined
  for (;;) {
    const qs = buildEventsListQuery({ syncToken: syncToken ?? undefined, pageToken })
    const raw = await ctx.fetch(
      `${GOOGLE_CALENDAR_API_BASE}/calendars/${encodeURIComponent(googleCalendarId)}/events?${qs}`,
      JSON.stringify({ method: "GET", headers: { Authorization: `Bearer ${token}` } }),
    )
    const res = JSON.parse(raw) as FetchResult
    if (res.status === 410) {
      return { gone: true }
    }
    if (res.status < 200 || res.status >= 300) {
      ctx.log_error("calendar sync: events.list failed", JSON.stringify({ status: res.status }))
      break
    }
    const body = JSON.parse(res.body) as EventsListPage
    await onPage(body)
    pageToken = body.nextPageToken
    if (!pageToken) break
  }
  return { gone: false }
}

export async function calendarInitialSync(payload: unknown, ctx: CalendarCtx): Promise<void> {
  const { calendarId } = (payload ?? {}) as { calendarId?: string }
  if (!calendarId) return
  const calendarJson = await ctx.calendar_getCalendar(calendarId)
  const calendar = JSON.parse(calendarJson) as CalendarRowShape | null
  if (!calendar) return
  const accountJson = await ctx.calendar_getAccount(calendar.account_id)
  const account = JSON.parse(accountJson) as AccountRowShape | null
  if (!account) return

  const token = await ctx.connections_getToken("google-calendar", account.email_address)
  await fetchEventsListPages(ctx, token, calendar.google_calendar_id, null, async (page) => {
    await ctx.calendar_applyInitialSyncPages(calendarId, calendar.calaccess, JSON.stringify([page]))
  })
  await registerWatchChannel(ctx, token, calendar.google_calendar_id, calendarId)
}

/** registerWatchChannel — events.watch per calendar with a fresh UUID channelId; the channel
 * `token` is HMAC(org-wide push secret, channelId): the DB-less `verify` seam cannot look up a
 * per-row secret, but it can recompute this from the channel id, so each channel has its own
 * token and the org secret is never sent to Google. watchExpiration is read from the RESPONSE body
 * (Google decides/caps the TTL — never hardcoded). */
async function registerWatchChannel(
  ctx: CalendarCtx,
  token: string,
  googleCalendarId: string,
  calendarId: string,
): Promise<void> {
  const secret = await ctx.config_get("calendarPushSecret")
  if (typeof secret !== "string" || secret.length === 0) {
    ctx.log_warn("calendar: skipping watch registration — calendarPushSecret not configured")
    return
  }
  // The channel id only needs uniqueness (auth lives in the `token` secret).
  const channelId = crypto.randomUUID()
  const webhookUrl = await ctx.config_get("calendarWebhookUrl")
  const raw = await ctx.fetch(
    `${GOOGLE_CALENDAR_API_BASE}/calendars/${encodeURIComponent(googleCalendarId)}/events/watch`,
    JSON.stringify({
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        id: channelId,
        type: "web_hook",
        address: webhookUrl,
        token: await ctx.calendar_channelToken(secret, channelId),
      }),
    }),
  )
  const res = JSON.parse(raw) as FetchResult
  if (res.status < 200 || res.status >= 300) {
    ctx.log_error("calendar: events.watch failed", JSON.stringify({ status: res.status }))
    return
  }
  const body = JSON.parse(res.body) as { resourceId: string; expiration?: string }
  // events.watch effectively always returns an expiration (TTL-capped ~1 week). If it is somehow
  // absent, log it and fall back to a conservative ~24h so renewal fires well before any real cap,
  // rather than inventing a longer TTL that could let the channel silently lapse.
  if (!body.expiration) {
    ctx.log_warn("calendar: events.watch response missing expiration; using 24h fallback")
  }
  const expirationMs = body.expiration ? Number(body.expiration) : Date.now() + 24 * 3_600_000
  await ctx.calendar_recordWatchChannel(
    calendarId,
    JSON.stringify({
      channelId,
      resourceId: body.resourceId,
      expiration: new Date(expirationMs).toISOString(),
    }),
  )
}

export async function calendarIncrementalSync(payload: unknown, ctx: CalendarCtx): Promise<void> {
  const { calendarId } = (payload ?? {}) as { calendarId?: string }
  if (!calendarId) return
  const calendarJson = await ctx.calendar_getCalendar(calendarId)
  const calendar = JSON.parse(calendarJson) as CalendarRowShape | null
  if (!calendar) return
  const accountJson = await ctx.calendar_getAccount(calendar.account_id)
  const account = JSON.parse(accountJson) as AccountRowShape | null
  if (!account) return

  const token = await ctx.connections_getToken("google-calendar", account.email_address)
  const { gone } = await fetchEventsListPages(
    ctx,
    token,
    calendar.google_calendar_id,
    calendar.sync_token,
    async (page) => {
      await ctx.calendar_applyIncrementalSyncPages(calendarId, JSON.stringify([page]))
    },
  )
  if (gone) {
    await ctx.calendar_recoverFromSyncTokenGone(calendarId)
    return
  }
}

interface EventRowShape {
  id: string
  calendar_id: string
  google_event_id: string | null
  etag: string | null
  title: string | null
  description: string | null
  location: string | null
  start: unknown
  end: unknown
  all_day: boolean
  attendees: unknown
  recurrence: unknown
  liaison_sync_version: number
  pending_push: string
  /** The attendee list a local attendee edit started from; null = attendees not edited. */
  attendees_base?: unknown
  /** A conference change for Google: "add" (create a Google Meet) or "remove"; null = none. */
  conference_request?: string | null
  hangout_link?: string | null
  push_error?: string | null
}

/** Google's createRequest for a Meet. The requestId is stable per row version, so a retried push
 * of the same edit is the same request to Google (it creates one conference, not two). */
function meetCreateRequest(event: EventRowShape): Record<string, unknown> {
  return {
    createRequest: {
      requestId: `liaison-${event.id}-v${event.liaison_sync_version}`,
      conferenceSolutionKey: { type: "hangoutsMeet" },
    },
  }
}

/** The video link of a Google event resource: hangoutLink (Meet), else the conference's video
 * entry point. Null when it has none. */
function conferenceLinkOfResource(
  resource: Record<string, unknown> | null | undefined,
): string | null {
  if (!resource) return null
  if (typeof resource.hangoutLink === "string" && resource.hangoutLink) return resource.hangoutLink
  const entryPoints = (resource.conferenceData as { entryPoints?: unknown } | null | undefined)
    ?.entryPoints
  if (!Array.isArray(entryPoints)) return null
  for (const ep of entryPoints) {
    const e = ep as { entryPointType?: unknown; uri?: unknown } | null
    if (e?.entryPointType === "video" && typeof e.uri === "string" && e.uri) return e.uri
  }
  return null
}

/** Whether a Google event resource already carries a conference (or one being created). */
function hasConference(resource: Record<string, unknown>): boolean {
  const data = resource.conferenceData as
    | { conferenceId?: unknown; entryPoints?: unknown; createRequest?: unknown }
    | null
    | undefined
  if (!data || typeof data !== "object") return false
  return Boolean(data.conferenceId || Array.isArray(data.entryPoints) || data.createRequest)
}

/**
 * buildGoogleEventBody — maps the local row to a Google event body. `remoteExtended` is the
 * remote resource's existing `extendedProperties` (passed on update) so we DEEP-merge our liaison
 * markers into it instead of replacing the whole object — preserving `shared` props and any other
 * `private` keys set by Google or other integrations. On create there is no remote, so we emit
 * just our markers.
 */
function buildGoogleEventBody(
  event: EventRowShape,
  remoteExtended?: { private?: Record<string, string>; shared?: Record<string, string> } | null,
  extra?: Record<string, unknown>,
): Record<string, unknown> {
  const markers = {
    liaisonSource: "liaison",
    liaisonEventId: event.id,
    liaisonSyncVersion: String(event.liaison_sync_version),
  }
  const extendedProperties: { private: Record<string, string>; shared?: Record<string, string> } = {
    private: { ...(remoteExtended?.private ?? {}), ...markers },
  }
  if (remoteExtended?.shared) extendedProperties.shared = remoteExtended.shared
  return {
    summary: event.title ?? undefined,
    description: event.description ?? undefined,
    location: event.location ?? undefined,
    start: event.start ?? undefined,
    end: event.end ?? undefined,
    attendees: event.attendees ?? undefined,
    recurrence: event.recurrence ?? undefined,
    extendedProperties,
    ...extra,
  }
}

/**
 * calendarPush — the `calendar-push` job. Handles create/update/delete against Google with
 * markers + If-Match, per Task 5.1. Update does get -> merge local changes onto the full
 * Google resource -> events.update (preserving unmodelled fields like colorId/conferenceData).
 * `sendUpdates: 'none'` on every write (attendees never emailed by sync/tool writes).
 */
export async function calendarPush(payload: unknown, ctx: CalendarCtx): Promise<void> {
  const params = (payload ?? {}) as {
    eventId?: string
    deleted?: boolean
    googleEventId?: string
    etag?: string | null
    calendarId?: string
    /** Legacy: retry counts now live on the row (push_attempts). */
    retry?: number
    /** Set on the one re-queue after a 401, so a second 401 routes the account to re-auth. */
    authRetry?: boolean
  }
  if (params.deleted) {
    await pushDelete(params, ctx)
    return
  }
  if (!params.eventId) return
  const eventJson = await ctx.calendar_getEvent(params.eventId)
  const event = JSON.parse(eventJson) as EventRowShape | null
  if (!event || event.pending_push === "none") return
  const authRetry = params.authRetry === true
  try {
    await pushRow(event, ctx, authRetry)
  } catch (err) {
    // Anything that throws before Google answered (the token lookup, a bridge call) still
    // counts as an attempt, so backoff, the sweep and the 24-hour give-up all advance; the job
    // itself completes, so no failed job is left holding its id.
    ctx.log_error("calendar push: threw", JSON.stringify({ eventId: event.id, error: String(err) }))
    await recordAndMaybeRetry(
      ctx,
      event,
      "push",
      0,
      JSON.stringify({ error: { message: `push failed: ${String(err)}` } }),
      authRetry,
    )
  }
}

async function pushRow(event: EventRowShape, ctx: CalendarCtx, authRetry: boolean): Promise<void> {
  const calendarJson = await ctx.calendar_getCalendar(event.calendar_id)
  const calendar = JSON.parse(calendarJson) as {
    google_calendar_id: string
    account_id: string
  } | null
  if (!calendar) return
  const accountJson = await ctx.calendar_getAccount(calendar.account_id)
  const account = JSON.parse(accountJson) as { email_address: string } | null
  if (!account) return
  const token = await ctx.connections_getToken("google-calendar", account.email_address)

  if (event.pending_push === "delete") {
    await pushDeleteTombstone(event, calendar.google_calendar_id, token, ctx, authRetry)
    return
  }
  if (!event.google_event_id) {
    await pushCreate(event, calendar.google_calendar_id, token, ctx, authRetry)
  } else {
    await pushUpdate(event, calendar.google_calendar_id, token, ctx, 0, authRetry)
  }
}

/** One push job per row version and attempt: a duplicate enqueue (the sweep finding a row
 * whose retry is already queued, a double click) is the same job and runs once. */
function pushJobId(eventId: string, syncVersion: number, attempts: number): string {
  return `calendar-push:${eventId}:v${syncVersion}:a${attempts}`
}

/** ctx.fetch for the push path: a network failure (the call throws) is reported as status 0,
 * which counts as an attempt and is retried like a 5xx instead of failing the job. */
async function pushFetch(ctx: CalendarCtx, url: string, optsJson: string): Promise<FetchResult> {
  try {
    return JSON.parse(await ctx.fetch(url, optsJson)) as FetchResult
  } catch (err) {
    return {
      status: 0,
      headers: {},
      body: JSON.stringify({ error: { message: `network error: ${String(err)}` } }),
    }
  }
}

/** The Google event id a local event is created with: its own uuid without dashes (32 chars of
 * 0-9a-f, inside Google's base32hex alphabet a-v0-9, 5-1024 chars). A retried insert that Google
 * already committed answers 409 instead of creating the event twice. */
function googleIdForLocalEvent(eventId: string): string {
  return eventId.replace(/-/g, "").toLowerCase()
}

// --- Push failure handling ---

/** A failing row version is re-queued with backoff 1, 2, 4, 8 minutes, then left to the
 * periodic sweep (every 30 minutes, least recently tried first). Only after it has been failing
 * for PUSH_GIVE_UP_AFTER_MS (so a Google outage or a daily quota does not throw edits away) is
 * the change marked refused (push_error) and no longer pushed. Counted on the row, so neither
 * the sweep nor a re-queue resets it; a new edit does. */
const PUSH_GIVE_UP_AFTER_MS = 24 * 60 * 60 * 1000
/** Re-queue delays beyond this are left to the 30-minute sweep (enqueueJob caps job delays). */
const PUSH_RETRY_MAX_DELAY_MS = 15 * 60 * 1000

/** Google 403 reasons that mean "this account may not make this change": the edit will never be
 * accepted, so the row takes Google's version. */
const PERMISSION_REFUSAL_REASONS = new Set([
  "forbiddenForNonOrganizer",
  "forbidden",
  "requiredAccessLevel",
  "insufficientPermissions",
  "forbiddenForServiceAccounts",
])
/** Google 403/429 reasons that mean "slow down": keep the edit, retry later. */
const RATE_LIMIT_REASONS = new Set([
  "rateLimitExceeded",
  "userRateLimitExceeded",
  "quotaExceeded",
  "dailyLimitExceeded",
  "RATE_LIMIT_EXCEEDED",
  "RESOURCE_EXHAUSTED",
])

/** The reason Google gives in an error body: errors[0].reason, else an ErrorInfo detail's
 * reason, else error.status. */
function googleErrorReason(body: string | undefined): string | null {
  try {
    const parsed = JSON.parse(body ?? "") as {
      error?: {
        status?: string
        errors?: Array<{ reason?: string }>
        details?: Array<{ reason?: string }>
      }
    }
    const err = parsed?.error
    if (!err || typeof err !== "object") return null
    const first = err.errors?.find((e) => typeof e?.reason === "string")?.reason
    if (first) return first
    const detail = err.details?.find((d) => typeof d?.reason === "string")?.reason
    if (detail) return detail
    return typeof err.status === "string" ? err.status : null
  } catch {
    return null
  }
}

/** Google's human-readable error message (error.message, else errors[0].message). */
function googleErrorMessage(body: string | undefined): string | null {
  try {
    const err = (
      JSON.parse(body ?? "") as {
        error?: { message?: string; errors?: Array<{ message?: string }> }
      }
    )?.error
    const message =
      err?.message ?? err?.errors?.find((e) => typeof e?.message === "string")?.message
    return typeof message === "string" && message ? message : null
  } catch {
    return null
  }
}

type PushFailureClass = "permission" | "retry" | "fatal"

function classifyPushFailure(status: number, reason: string | null): PushFailureClass {
  if (status === 403) {
    if (reason && PERMISSION_REFUSAL_REASONS.has(reason)) return "permission"
    // Rate/quota limits, and any 403 we cannot identify: keep the edit and retry.
    return "retry"
  }
  // 0 = the request never got an answer (network error): like a 5xx.
  if (status === 0 || status === 429 || status >= 500) return "retry"
  return "fatal"
}

/** Stops pushing a change Google will not take. A delete brings the event back, refreshed from
 * Google's current copy when it can be read (a restored local edit is pushed again). */
async function giveUp(
  ctx: CalendarCtx,
  event: EventRowShape,
  message: string,
  refetch?: () => Promise<FetchResult>,
): Promise<void> {
  const version = event.liaison_sync_version
  if (event.pending_push !== "delete") {
    await ctx.calendar_markPushRejected(event.id, message, version)
    return
  }
  let remote: unknown = null
  if (refetch) {
    const res = await refetch()
    if (res.status >= 200 && res.status < 300) remote = JSON.parse(res.body)
    else if (res.status === 404 || res.status === 410) remote = { status: "cancelled" }
  }
  const restored = JSON.parse(
    (await ctx.calendar_restoreRefusedDelete(event.id, message, version, JSON.stringify(remote))) ??
      "null",
  ) as { pendingRestored?: boolean } | null
  if (restored?.pendingRestored) {
    await ctx.enqueueJob(
      "calendar-push",
      JSON.stringify({ eventId: event.id }),
      JSON.stringify({ jobId: `calendar-push:${event.id}:restored:${Date.now()}` }),
    )
  }
}

/**
 * A failed push. Decides from Google's answer, always against the row version the push read
 * (a row edited meanwhile is left to its own, newer push):
 * - 401: the token was refused. One re-queue (connections_getToken refreshes); a second 401
 *   flags the account reauth-required. The edit stays pending either way, never dropped.
 * - 404/410 on an existing event: deleted on Google, deleted locally.
 * - a refusal on a create, a 400 and the like: marked refused on the row, not retried.
 * - 403 rate/quota or unidentified, 429, 5xx, failed read: counted on the row and re-queued
 *   with backoff, up to PUSH_ATTEMPT_CAP attempts, then marked refused.
 */
async function recordAndMaybeRetry(
  ctx: CalendarCtx,
  event: EventRowShape,
  operation: string,
  status: number,
  body: string | undefined,
  authRetry: boolean,
  /** For a delete: reads Google's current copy, applied when the event comes back. */
  refetch?: () => Promise<FetchResult>,
): Promise<void> {
  const reason = googleErrorReason(body)
  const kind = classifyPushFailure(status, reason)
  const version = event.liaison_sync_version
  const isInsert = operation === "events.insert"
  const isDelete = operation === "events.delete"
  const gone = (status === 404 || status === 410) && !isInsert && !isDelete
  const unauthorized = status === 401
  // A permission refusal of an insert or a delete can never be accepted (an update's is
  // reverted to Google's version by the caller before reaching here).
  const refused =
    !gone &&
    !unauthorized &&
    (kind === "fatal" || (kind === "permission" && (isInsert || isDelete)))
  const errorKind = unauthorized
    ? authRetry
      ? "AuthRevoked"
      : "Unauthorized"
    : gone
      ? "Gone"
      : refused
        ? "Rejected"
        : reason && RATE_LIMIT_REASONS.has(reason)
          ? "RateLimited"
          : "Unknown"
  ctx.log_error(`calendar push: ${operation} failed`, JSON.stringify({ status, reason, errorKind }))
  // AuthRevoked also flags the account reauth-required (recordPushFailure).
  await ctx.calendar_recordPushFailure(
    event.id,
    event.calendar_id,
    errorKind,
    `${operation} failed with status ${status}${reason ? ` (${reason})` : ""}`,
  )
  if (unauthorized) {
    if (!authRetry) {
      await ctx.enqueueJob(
        "calendar-push",
        JSON.stringify({ eventId: event.id, authRetry: true }),
        JSON.stringify({ delay: 60_000, jobId: `calendar-push:${event.id}:v${version}:auth` }),
      )
    }
    return
  }
  if (gone) {
    // As an inbound cancellation would: the event goes, and its pending edit with it.
    await ctx.calendar_applyRemoteDeletion(event.id, version)
    return
  }
  const message = `${isDelete ? "deleting this event: " : ""}${googleErrorMessage(body) ?? `HTTP ${status}`}`
  if (refused) {
    // Google rejected the change itself: retrying cannot help. Stop pushing it and show why.
    await giveUp(ctx, event, message, refetch)
    return
  }
  const failure = JSON.parse(await ctx.calendar_notePushFailure(event.id, version)) as {
    attempts: number
    failingForMs: number
  } | null
  if (failure === null) return // edited since: the newer edit's push takes over
  if (failure.failingForMs >= PUSH_GIVE_UP_AFTER_MS) {
    await giveUp(
      ctx,
      event,
      `Not accepted by Google after ${failure.attempts} attempts over 24 hours: ${message}`,
      refetch,
    )
    return
  }
  const delay = 60_000 * 2 ** (failure.attempts - 1)
  if (delay > PUSH_RETRY_MAX_DELAY_MS) return // the 30-minute sweep takes it from here
  await ctx.enqueueJob(
    "calendar-push",
    JSON.stringify({ eventId: event.id }),
    JSON.stringify({ delay, jobId: pushJobId(event.id, version, failure.attempts) }),
  )
}

async function pushCreate(
  event: EventRowShape,
  googleCalendarId: string,
  token: string,
  ctx: CalendarCtx,
  authRetry = false,
): Promise<void> {
  const googleId = googleIdForLocalEvent(event.id)
  const wantsMeet = event.conference_request === "add"
  const body = {
    ...buildGoogleEventBody(event),
    id: googleId,
    ...(wantsMeet ? { conferenceData: meetCreateRequest(event) } : {}),
  }
  // conferenceDataVersion=1: without it Google ignores conferenceData and creates no Meet.
  const res = await pushFetch(
    ctx,
    `${GOOGLE_CALENDAR_API_BASE}/calendars/${encodeURIComponent(googleCalendarId)}/events?sendUpdates=none${wantsMeet ? "&conferenceDataVersion=1" : ""}`,
    JSON.stringify({
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }),
  )
  let created: Record<string, unknown> & { id: string; etag: string; updated: string }
  if (res.status === 409) {
    // The id is already taken on Google: an earlier attempt of this same insert was committed
    // (its answer was lost). Adopt that event instead of creating a second one.
    const getRes = await pushFetch(
      ctx,
      `${GOOGLE_CALENDAR_API_BASE}/calendars/${encodeURIComponent(googleCalendarId)}/events/${googleId}`,
      JSON.stringify({ method: "GET", headers: { Authorization: `Bearer ${token}` } }),
    )
    if (getRes.status < 200 || getRes.status >= 300) {
      await recordAndMaybeRetry(ctx, event, "events.get", getRes.status, getRes.body, authRetry)
      return
    }
    created = JSON.parse(getRes.body)
    if ((created as { status?: string }).status === "cancelled") {
      // Created, then deleted on Google before we heard back: it is gone.
      await ctx.calendar_applyRemoteDeletion(event.id, event.liaison_sync_version)
      return
    }
  } else if (res.status < 200 || res.status >= 300) {
    await recordAndMaybeRetry(ctx, event, "events.insert", res.status, res.body, authRetry)
    return
  } else {
    created = JSON.parse(res.body)
  }
  const applied = JSON.parse(
    (await ctx.calendar_applyPushResult(
      event.id,
      JSON.stringify({
        googleEventId: created.id,
        etag: created.etag,
        googleUpdatedAt: created.updated,
        hangoutLink: conferenceLinkOfResource(created),
        ...(res.status === 409 ? { remote: created } : {}),
        syncVersion: event.liaison_sync_version,
      }),
    )) ?? "null",
  ) as { rowExists?: boolean } | null
  if (applied?.rowExists === false) {
    // The user deleted the event while its create was in flight: delete it on Google too, so it
    // does not come back with the next sync.
    const del = await pushFetch(
      ctx,
      `${GOOGLE_CALENDAR_API_BASE}/calendars/${encodeURIComponent(googleCalendarId)}/events/${encodeURIComponent(created.id)}?sendUpdates=none`,
      JSON.stringify({ method: "DELETE", headers: { Authorization: `Bearer ${token}` } }),
    )
    if (del.status >= 300 && del.status !== 404 && del.status !== 410) {
      ctx.log_error(
        "calendar push: delete after in-flight create failed",
        JSON.stringify({ status: del.status }),
      )
    }
  }
}

/**
 * The attendee list to PUT, as a 3-way merge. `base` is the list the local attendee edit
 * started from (null when this edit did not touch attendees): only the edit's own adds and
 * removes are applied, on top of Google's CURRENT list, so a guest added or removed on Google
 * since the last sync is neither dropped nor re-invited. An attendee Google already has is sent
 * as Google's object (responseStatus, comment, organizer/self/optional... survive).
 */
function mergeAttendeesForPush(local: unknown, base: unknown, remote: unknown): unknown {
  if (base === null || base === undefined || !Array.isArray(local)) return remote
  const emailOf = (item: unknown): string | null => {
    if (typeof item === "string") return item.toLowerCase()
    const e = (item as { email?: unknown } | null)?.email
    return typeof e === "string" ? e.toLowerCase() : null
  }
  const baseSet = new Set((Array.isArray(base) ? base : []).map(emailOf).filter(Boolean))
  const localSet = new Set(local.map(emailOf).filter(Boolean))
  const removed = new Set([...baseSet].filter((e) => !localSet.has(e)))
  const remoteList = Array.isArray(remote) ? (remote as unknown[]) : []
  const out: unknown[] = remoteList.filter((a) => {
    const e = emailOf(a)
    return e === null || !removed.has(e)
  })
  const present = new Set(out.map(emailOf).filter(Boolean))
  for (const item of local) {
    const e = emailOf(item)
    if (!e || baseSet.has(e) || present.has(e)) continue
    out.push(typeof item === "string" ? { email: item } : item)
    present.add(e)
  }
  return out
}

async function pushUpdate(
  event: EventRowShape,
  googleCalendarId: string,
  token: string,
  ctx: CalendarCtx,
  attempt: number,
  authRetry = false,
): Promise<void> {
  // get -> merge local changes onto the full remote resource (preserves unmodelled fields).
  const getRes = await pushFetch(
    ctx,
    `${GOOGLE_CALENDAR_API_BASE}/calendars/${encodeURIComponent(googleCalendarId)}/events/${encodeURIComponent(event.google_event_id!)}`,
    JSON.stringify({ method: "GET", headers: { Authorization: `Bearer ${token}` } }),
  )
  if (getRes.status < 200 || getRes.status >= 300) {
    await recordAndMaybeRetry(ctx, event, "events.get", getRes.status, getRes.body, authRetry)
    return
  }
  const remote = JSON.parse(getRes.body) as Record<string, unknown>
  const remoteExtended =
    (remote.extendedProperties as {
      private?: Record<string, string>
      shared?: Record<string, string>
    } | null) ?? null
  // Google's PUT replaces the whole resource: a field our body leaves undefined must keep the
  // remote value, never be dropped (an absent `attendees` would uninvite everyone).
  const body = buildGoogleEventBody(event, remoteExtended)
  const merged: Record<string, unknown> = { ...remote }
  for (const [key, value] of Object.entries(body)) {
    if (value !== undefined) merged[key] = value
  }
  merged.attendees = mergeAttendeesForPush(event.attendees, event.attendees_base, remote.attendees)
  if (merged.attendees === undefined) delete merged.attendees
  // Conference changes are sent only when asked for (conferenceDataVersion=1); otherwise Google
  // keeps the event's conference as it is.
  const conferenceChange =
    event.conference_request === "add" || event.conference_request === "remove"
  if (event.conference_request === "add" && !hasConference(remote)) {
    merged.conferenceData = meetCreateRequest(event)
  } else if (event.conference_request === "remove") {
    merged.conferenceData = null
    delete merged.hangoutLink
  }

  // Source If-Match from THIS invocation's own GET (the freshest etag Google gave us), not the
  // etag threaded in by the caller — on a retry the caller's etag is the previous attempt's stale
  // value, which would provoke an avoidable 412. Omit the header entirely when no etag is known
  // (an empty If-Match is not a valid precondition; servers treat it as an unconditional write).
  const freshEtag = (remote as { etag?: string }).etag ?? event.etag ?? null
  const putHeaders: Record<string, string> = {
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/json",
  }
  if (freshEtag) putHeaders["If-Match"] = freshEtag

  const putRes = await pushFetch(
    ctx,
    `${GOOGLE_CALENDAR_API_BASE}/calendars/${encodeURIComponent(googleCalendarId)}/events/${encodeURIComponent(event.google_event_id!)}?sendUpdates=none${conferenceChange ? "&conferenceDataVersion=1" : ""}`,
    JSON.stringify({
      method: "PUT",
      headers: putHeaders,
      body: JSON.stringify(merged),
    }),
  )
  if (putRes.status >= 200 && putRes.status < 300) {
    const updated = JSON.parse(putRes.body) as Record<string, unknown> & {
      id: string
      etag: string
      updated: string
    }
    await ctx.calendar_applyPushResult(
      event.id,
      JSON.stringify({
        googleEventId: updated.id,
        etag: updated.etag,
        googleUpdatedAt: updated.updated,
        hangoutLink: conferenceLinkOfResource(updated),
        // What Google really stored (it ignores a non-organizer's guest changes).
        remote: updated,
        syncVersion: event.liaison_sync_version,
      }),
    )
    return
  }
  if (
    putRes.status === 403 &&
    classifyPushFailure(403, googleErrorReason(putRes.body)) === "permission"
  ) {
    // Google refuses this write for good (not the organizer / no write access): show Google's
    // version locally instead of leaving an edit pending that will never be accepted. Any
    // other 403 (rate or quota limit, unidentified) keeps the edit and retries below.
    ctx.log_error(
      "calendar push: events.update refused",
      JSON.stringify({ status: 403, reason: googleErrorReason(putRes.body) }),
    )
    await ctx.calendar_revertToRemote(
      event.id,
      JSON.stringify(remote),
      "events.update refused by Google (403); local edit replaced by Google's version",
      event.liaison_sync_version,
    )
    return
  }
  if (putRes.status === 412) {
    const remoteEtag = (remote as { etag?: string }).etag ?? ""
    const remoteUpdated = (remote as { updated?: string }).updated ?? new Date(0).toISOString()
    const conflictRaw = await ctx.calendar_handlePushConflict(
      event.id,
      JSON.stringify({
        remoteEtag,
        remoteUpdated,
        remoteSnapshot: {
          title: (remote as { summary?: string }).summary,
          description: (remote as { description?: string }).description,
          location: (remote as { location?: string }).location,
          start: (remote as { start?: unknown }).start,
          end: (remote as { end?: unknown }).end,
          attendees: (remote as { attendees?: unknown }).attendees,
          recurrence: (remote as { recurrence?: unknown }).recurrence,
          organizer: (remote as { organizer?: unknown }).organizer,
          guestsCanModify: (remote as { guestsCanModify?: unknown }).guestsCanModify,
          hangoutLink: conferenceLinkOfResource(remote),
        },
        capturedSyncVersion: event.liaison_sync_version,
      }),
    )
    const conflict = JSON.parse(conflictRaw) as { outcome: "remote-won" | "retry" | "abort-stale" }
    if (conflict.outcome === "retry" && attempt < 2) {
      const refreshedJson = await ctx.calendar_getEvent(event.id)
      const refreshed = JSON.parse(refreshedJson) as EventRowShape | null
      if (refreshed) {
        // The retry's own GET fetches the freshest etag and sources If-Match from it, so we do NOT
        // thread the stale remoteEtag in here (it's superseded by the internal fresh GET).
        await pushUpdate(refreshed, googleCalendarId, token, ctx, attempt + 1, authRetry)
      }
      return
    }
    if (conflict.outcome === "retry") {
      // Retry exhaustion (3rd attempt still conflicted) — leave pendingPush set, sanitized log.
      await ctx.calendar_recordPushFailure(
        event.id,
        event.calendar_id,
        "EtagMismatch",
        "events.update 412 after 3 attempts; pendingPush retained",
      )
    }
    return
  }
  await recordAndMaybeRetry(ctx, event, "events.update", putRes.status, putRes.body, authRetry)
}

/**
 * pushDeleteTombstone — deletes on Google an event deleted locally (the row is a tombstone until
 * this succeeds). No If-Match: the user deleted it whatever changed since. 2xx, 404 and 410
 * (already gone) remove the tombstone. Failures go through the push failure rules: retried with
 * backoff and the sweep; a refusal (for example a calendar this account cannot write) or 24
 * hours of failures brings the event back with the refusal shown on it.
 */
async function pushDeleteTombstone(
  event: EventRowShape,
  googleCalendarId: string,
  token: string,
  ctx: CalendarCtx,
  authRetry: boolean,
): Promise<void> {
  const res = await pushFetch(
    ctx,
    `${GOOGLE_CALENDAR_API_BASE}/calendars/${encodeURIComponent(googleCalendarId)}/events/${encodeURIComponent(event.google_event_id!)}?sendUpdates=none`,
    JSON.stringify({ method: "DELETE", headers: { Authorization: `Bearer ${token}` } }),
  )
  if ((res.status >= 200 && res.status < 300) || res.status === 404 || res.status === 410) {
    await ctx.calendar_finalizeRemoteDelete(event.id)
    return
  }
  await recordAndMaybeRetry(ctx, event, "events.delete", res.status, res.body, authRetry, () =>
    pushFetch(
      ctx,
      `${GOOGLE_CALENDAR_API_BASE}/calendars/${encodeURIComponent(googleCalendarId)}/events/${encodeURIComponent(event.google_event_id!)}`,
      JSON.stringify({ method: "GET", headers: { Authorization: `Bearer ${token}` } }),
    ),
  )
}

async function pushDelete(
  params: { eventId?: string; googleEventId?: string; etag?: string | null; calendarId?: string },
  ctx: CalendarCtx,
): Promise<void> {
  if (!params.googleEventId || !params.calendarId) return
  const calendarJson = await ctx.calendar_getCalendar(params.calendarId)
  const calendar = JSON.parse(calendarJson) as {
    google_calendar_id: string
    account_id: string
  } | null
  if (!calendar) return
  const accountJson = await ctx.calendar_getAccount(calendar.account_id)
  const account = JSON.parse(accountJson) as { email_address: string } | null
  if (!account) return
  const token = await ctx.connections_getToken("google-calendar", account.email_address)
  const deleteHeaders: Record<string, string> = { Authorization: `Bearer ${token}` }
  // Omit If-Match when no etag is known — an empty-string value is not a valid precondition.
  if (params.etag) deleteHeaders["If-Match"] = params.etag
  const res = await pushFetch(
    ctx,
    `${GOOGLE_CALENDAR_API_BASE}/calendars/${encodeURIComponent(calendar.google_calendar_id)}/events/${encodeURIComponent(params.googleEventId)}?sendUpdates=none`,
    JSON.stringify({
      method: "DELETE",
      headers: deleteHeaders,
    }),
  )
  if (res.status >= 200 && res.status < 300) return
  if (res.status === 404 || res.status === 410) return // already gone on Google — fine.
  ctx.log_error("calendar push: events.delete failed", JSON.stringify({ status: res.status }))
}

interface RenewalCalendarShape {
  id: string
  account_id: string
  google_calendar_id: string
  watch_channel_id: string | null
}

/** calendarWatchRenewal — Task 6.1 renewal cron: for every calendar whose channel expires within
 * 12h, create a NEW channel first, then stop the OLD one (overlap — no gap in coverage). */
export async function calendarWatchRenewal(_payload: unknown, ctx: CalendarCtx): Promise<void> {
  const rowsJson = await ctx.calendar_findCalendarsForWatchRenewal(12)
  const rows = JSON.parse(rowsJson) as RenewalCalendarShape[]
  for (const calendar of rows) {
    const accountJson = await ctx.calendar_getAccount(calendar.account_id)
    const account = JSON.parse(accountJson) as { email_address: string } | null
    if (!account) continue
    const token = await ctx.connections_getToken("google-calendar", account.email_address)
    const oldChannelId = calendar.watch_channel_id
    await registerWatchChannel(ctx, token, calendar.google_calendar_id, calendar.id)
    if (oldChannelId) {
      await ctx.calendar_stopWatchChannelOnly(calendar.id, oldChannelId)
    }
  }
}

interface PollCalendarShape {
  id: string
}

/** calendarPollFallback — Task 6.1 poll cron: enqueues incremental sync for any selected
 * calendar whose lastPolledAt is older than 30 min, and marks it polled. */
export async function calendarPollFallback(_payload: unknown, ctx: CalendarCtx): Promise<void> {
  const rowsJson = await ctx.calendar_findCalendarsForPollFallback(30)
  const rows = JSON.parse(rowsJson) as PollCalendarShape[]
  for (const calendar of rows) {
    await ctx.enqueueJob("calendar-incremental-sync", JSON.stringify({ calendarId: calendar.id }))
    await ctx.calendar_markCalendarPolled(calendar.id)
  }
  // Local edits still waiting for Google (a push failed and its bounded retries ran out, or
  // its job was lost): push them again, without needing another local edit.
  const pending = JSON.parse(await ctx.calendar_findStalePendingPushes(30)) as Array<{
    id: string
    liaison_sync_version: number
    push_attempts: number
  }>
  const sweepRun = Math.floor(Date.now() / (30 * 60 * 1000))
  for (const row of pending) {
    // The sweep only takes rows not tried for 30 minutes, past the longest queued retry delay,
    // so it does not race a retry still waiting in the queue.
    await ctx.enqueueJob(
      "calendar-push",
      JSON.stringify({ eventId: row.id }),
      // Unique per sweep run: a job id that once failed and is retained by the queue can
      // never block later sweeps of the same row.
      JSON.stringify({
        jobId: `${pushJobId(row.id, row.liaison_sync_version, row.push_attempts)}:sweep${sweepRun}`,
      }),
    )
  }
}

/** UI-callable: toggle a calendar's `selected` flag (deselect purges local events + stops the
 * watch channel; select re-enqueues initial sync). Exposed via calendar_setSelected bridge. */
export async function calendarSetSelected(params: unknown, ctx: CalendarCtx): Promise<void> {
  await ctx.calendar_setSelected(JSON.stringify(params ?? {}))
}

/** retry_import tool: re-runs the `calendar-import` job for one account (Settings "Retry"). */
export async function calendarRetryImport(params: unknown, ctx: CalendarCtx): Promise<unknown> {
  await ctx.calendar_retryImport(JSON.stringify(params ?? {}))
  return { queued: true }
}

// --- Webhook handlers ---

interface WebhookVerifyCtx {
  config_get: (key: string) => Promise<unknown>
  crypto_timingSafeEqual: (a: string, b: string) => Promise<boolean>
  crypto_hmacSha256Base64: (secret: string, body: string) => Promise<string>
}

interface WebhookRequestData {
  body?: string
  query?: Record<string, string>
  headers?: Record<string, string>
}

/**
 * `verify` runs on a DB-less bridge: reads the org-wide webhook secret via
 * `config_get`, constant-time-compares it against the X-Goog-Channel-Token header
 * (Google Calendar sends the channel token as a HEADER, not a query param).
 * Returns a replayKey ("channelId:messageNumber") for the route-level Redis replay
 * claim, so we do NOT hash the (empty) notification body.
 * Ignores the `X-Goog-Resource-State: sync` handshake (still valid, just a no-op ping).
 */
export async function verifyGooglePush(
  requestData: WebhookRequestData,
  ctx: WebhookVerifyCtx,
): Promise<unknown> {
  const headers = requestData.headers ?? {}
  const channelToken = headers["x-goog-channel-token"] ?? headers["X-Goog-Channel-Token"] ?? ""
  const channelId = headers["x-goog-channel-id"] ?? headers["X-Goog-Channel-ID"] ?? ""
  const messageNumber = headers["x-goog-message-number"] ?? headers["X-Goog-Message-Number"] ?? ""
  const secret = await ctx.config_get("calendarPushSecret")
  if (typeof secret !== "string" || secret.length === 0) {
    return { valid: false, status: 500, _reason: "secret_not_configured" }
  }
  if (!channelId) {
    return { valid: false, status: 401, _reason: "missing_channel_id" }
  }
  // The token is per channel: HMAC(org push secret, channel id).
  const expected = await ctx.crypto_hmacSha256Base64(secret, channelId)
  if (!channelToken || !(await ctx.crypto_timingSafeEqual(channelToken, expected))) {
    return { valid: false, status: 403, _reason: "bad_channel_token" }
  }
  return {
    valid: true,
    replayKey: `${channelId}:${messageNumber}`,
  }
}

/** Post-verify handler (has DB): binds the notification to a calendar by channel id. */
export async function onGooglePush(
  _payload: unknown,
  ctx: CalendarCtx,
  headers: Record<string, string>,
): Promise<void> {
  await ctx.calendar_handleWebhook(JSON.stringify(headers ?? {}))
}

// --- Tool handlers ---

export async function calendarListCalendars(_params: unknown, ctx: CalendarCtx): Promise<unknown> {
  return JSON.parse(await ctx.calendar_listCalendars())
}

export async function calendarListAccounts(_params: unknown, ctx: CalendarCtx): Promise<unknown> {
  return JSON.parse(await ctx.calendar_listAccounts())
}

export async function calendarListEvents(params: unknown, ctx: CalendarCtx): Promise<unknown> {
  return JSON.parse(await ctx.calendar_listEvents(JSON.stringify(params ?? {})))
}

export async function calendarSearchEvents(params: unknown, ctx: CalendarCtx): Promise<unknown> {
  return JSON.parse(await ctx.calendar_searchEvents(JSON.stringify(params ?? {})))
}

export async function calendarCreateEvent(params: unknown, ctx: CalendarCtx): Promise<unknown> {
  const result = JSON.parse(await ctx.calendar_createEvent(JSON.stringify(params ?? {}))) as {
    eventId: string
    conference?: string | null
  }
  return withConferenceOutcome(result, ctx)
}

export async function calendarUpdateEvent(params: unknown, ctx: CalendarCtx): Promise<unknown> {
  const result = JSON.parse(await ctx.calendar_updateEvent(JSON.stringify(params ?? {}))) as {
    eventId: string
    conference?: string | null
  }
  return withConferenceOutcome(result, ctx)
}

/**
 * A create/update that asks for a conference change is pushed to Google right away, so the tool
 * result can carry the Meet link (or say plainly why there is none). The queued push job is
 * delayed for such calls and finds nothing left to do; when this immediate push cannot run (no
 * token in this context, Google unreachable), that job delivers the change as usual.
 */
async function withConferenceOutcome(
  result: { eventId: string; conference?: string | null },
  ctx: CalendarCtx,
): Promise<unknown> {
  const requested = result.conference
  if (requested !== "add" && requested !== "remove") return result
  let event: EventRowShape | null = null
  try {
    event = JSON.parse(await ctx.calendar_getEvent(result.eventId)) as EventRowShape | null
    if (event && event.pending_push !== "none") {
      await pushRow(event, ctx, false)
      event = JSON.parse(await ctx.calendar_getEvent(result.eventId)) as EventRowShape | null
    }
  } catch (err) {
    ctx.log_warn(
      "calendar: immediate push for a conference change failed; the queued push will retry",
      JSON.stringify({ eventId: result.eventId, error: String(err) }),
    )
  }
  const meetLink = event?.hangout_link ?? null
  if (requested === "remove") {
    if (event && event.pending_push === "none" && !meetLink) {
      return { ...result, conference: "removed", meetLink: null }
    }
    return {
      ...result,
      conference: "removal_pending",
      message: event?.push_error
        ? `Google refused the change: ${event.push_error}`
        : "The video conference removal is saved and will reach Google shortly.",
    }
  }
  if (meetLink) return { ...result, conference: "google_meet", meetLink }
  if (event?.push_error) {
    return {
      ...result,
      conference: "failed",
      meetLink: null,
      message: `Google refused to add a Google Meet to this event: ${event.push_error}`,
    }
  }
  return {
    ...result,
    conference: "pending",
    meetLink: null,
    message:
      "Google is still creating the Google Meet link. It will appear on the event (list_events: hangoutLink) once Google has answered; check it there before sharing.",
  }
}

export async function calendarDeleteEvent(params: unknown, ctx: CalendarCtx): Promise<unknown> {
  return JSON.parse(await ctx.calendar_deleteEvent(JSON.stringify(params ?? {})))
}

/** Manifest `export` slot — export the connected Calendar accounts. */
export async function exportCalendar(params: unknown, ctx: CalendarCtx): Promise<unknown> {
  const raw = await ctx.db_findMany("accounts", JSON.stringify(params ?? {}))
  const rows = JSON.parse(raw) as Array<Record<string, unknown>>
  return rows.map((r) => ({
    id: r.id,
    connectionName: "google-calendar",
    identifier: r.email_address,
    displayName: r.display_name ?? r.email_address,
    status: r.sync_status,
    createdAt: r.created_at,
  }))
}

/** Timeline rows for the kernel's activity read (activitySources), host-side. */
export async function activityRead(params: unknown, ctx: CalendarCtx): Promise<unknown> {
  return JSON.parse(await ctx.calendar_activityRead(JSON.stringify(params ?? {})))
}
