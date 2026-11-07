// SPDX-License-Identifier: FSL-1.1-ALv2
// Host-side Calendar sync engine. Plain host TypeScript (not sandboxed) — imported only from
// the app-id-gated `calendar_*` bridge methods in ~/modules/apps/sandbox/rpc-bridge.ts.
// Filled in incrementally: Task 1 provides only the account-connect skeleton so the calendar
// app registers and boots; Tasks 3-6 add import/initial-sync/incremental-sync/push/webhooks.
//
// IMPORTANT — RLS dimension gotcha discovered in Task 1 (read before writing calendars/events
// insert helpers): the generated RLS policy for a *direct* membership-dimension column always
// appends `::uuid` to the grant-array cast (apps/api/src/modules/permissions/rls-generator.ts
// `needsUuidCast`, unconditional whenever a bare column ref with no dot is used) — this is a
// framework quirk, not something this app can opt out of. `calendars`/`events`/`sync_log` each
// declare their OWN plain `calaccess: "string"` field + a same-named `membership` dimension
// (single lowercase word, no `column`/`inheritFrom` override — required so RLS self-detects the
// backing column via `fieldKeys.includes(snakeKey)` without a case-mismatched quoteIdent(key)).
// `inheritFrom` (reading a differently-named parent column) hits an analogous uuid/text cast
// mismatch and does NOT work for this app. Consequence: every INSERT into calendars/events/
// sync_log MUST set `calaccess` explicitly to the owning account's id **as a string** (not
// omitted, not passed as uuid) — it is the sole access-control column those tables rely on.

import { applyAwayFromCalendar } from "~/apps/calendar/away-from-calendar"
import { conferenceLinkOf } from "~/apps/calendar/tools"
import type { RlsClient } from "~/db"
import { schemaRef } from "~/db/schema-ref"
import { appsLogger as log } from "~/lib/logger"
import { deleteCalendarAwayRanges } from "~/modules/users/away"

const CALENDAR_SCHEMA = () => schemaRef("app_calendar")
const KERNEL_SCHEMA = () => schemaRef("kernel")

/** What the account-connect helpers need from a handle: an RLS-scoped client or a privileged
 * one (the connect event handler and the ensure-on-read repair both run privileged). */
type AccountDb = Pick<RlsClient, "execute" | "queueEvent">

export interface CalendarKernelConnectionEvent {
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

export interface CalendarKernelDisconnectEvent {
  orgId: string
  data: { id: string; appName: string }
}

export interface CalendarAccountRow {
  id: string
  connected_account_id: string
  owner_type: string
  owner_id: string | null
  email_address: string
  display_name: string | null
  sync_status: string
  last_sync_error: string | null
  disconnected_at: string | null
}

/**
 * onAccountConnected — mirrors mail's onAccountConnected (handlers.ts ~line 858): upsert the
 * `accounts` row from the kernel connection-created event, then enqueue `calendar-import`.
 * Reconnect of an existing account (same emailAddress) is idempotent — updates the existing row
 * rather than inserting a duplicate.
 *
 * The row takes the owner of the connection that now holds the address. `email_address` is
 * unique per org and the kernel keeps one active connection per address whatever its owner, so
 * a reconnect by another user (or a switch between personal and org) rebinds the one row. Keeping
 * the previous owner left the row visible to that previous owner only: the user who had just
 * connected saw "connect your account" on the calendar home while Settings showed the connection.
 *
 * The `calendar:calaccess` grant is written here too, not only by the import job: an import that
 * fails (Google refusal, lost job) never reached the grant, so the account's calendars stayed
 * hidden from its owner.
 */
export async function onAccountConnected(
  db: AccountDb,
  orgId: string,
  event: CalendarKernelConnectionEvent,
  enqueueJob: (jobName: string, payload: Record<string, unknown>) => Promise<void>,
): Promise<{ accountId: string; created: boolean }> {
  const { id, ownerType, ownerId, identifier } = event.data
  const { accountId, created } = await upsertAccount(db, orgId, {
    connected_account_id: id,
    owner_type: ownerType,
    owner_id: ownerId,
    email_address: identifier,
    display_name: identifier,
    sync_status: "pre-sync",
  })
  await grantCalendarAccessDimension(db, orgId, accountId, ownerType, ownerId)
  await enqueueJob("calendar-import", { orgId, accountId })
  return { accountId, created }
}

/**
 * callerCalendarAccountsNeedRepair — the read-only health check `list_accounts` runs before
 * deciding to open the repair transaction. True when any ACTIVE calendar connection the caller
 * holds (personal or org-wide) lacks a live app `accounts` row bound to it with the same owner,
 * or the caller lacks that row's `calendar:calaccess` grant. One SELECT, no writes: the healthy
 * path, which is nearly every read, never takes a row lock. Must run on a privileged handle for
 * the same reason as the repair (the faulty row may be invisible to the caller).
 */
export async function callerCalendarAccountsNeedRepair(
  db: AccountDb,
  orgId: string,
  userId: string,
): Promise<boolean> {
  const { sql } = await import("drizzle-orm")
  const schema = CALENDAR_SCHEMA()
  const rows = (await db.execute(sql`
    SELECT EXISTS (
      SELECT 1 FROM ${sql.raw(KERNEL_SCHEMA())}.connected_accounts c
      WHERE c.org_id = ${orgId}::uuid AND c.app_name = 'calendar' AND c.status = 'active'
        AND ((c.owner_type = 'user' AND c.owner_id = ${userId}::uuid) OR c.owner_type = 'org')
        AND NOT EXISTS (
          SELECT 1 FROM ${sql.raw(schema)}.accounts a
          WHERE a.org_id = c.org_id AND a.connected_account_id = c.id
            AND a.disconnected_at IS NULL
            AND a.owner_type = c.owner_type AND a.owner_id IS NOT DISTINCT FROM c.owner_id
            AND EXISTS (
              SELECT 1 FROM ${sql.raw(KERNEL_SCHEMA())}.user_dimension_grants g
              WHERE g.user_id = ${userId}::uuid AND g.org_id = c.org_id
                AND g.dimension_key = 'calendar:calaccess'
                AND g.dimension_values @> jsonb_build_array(a.id::text)
            )
        )
    ) AS needs_repair
  `)) as unknown as { rows?: Array<{ needs_repair: boolean }> } | Array<{ needs_repair: boolean }>
  const list = Array.isArray(rows) ? rows : (rows.rows ?? [])
  return list[0]?.needs_repair === true
}

/**
 * ensureCallerCalendarAccounts — ensure-on-read repair run before `list_accounts` answers.
 * For every ACTIVE kernel calendar connection the caller holds (their personal ones and the
 * org-wide ones), the app must have a live `accounts` row bound to it with the same owner, and
 * the caller must hold its `calendar:calaccess` grant. A connection whose app row is missing
 * (the `connected_account:create` event was lost or its handler failed), bound to another
 * connection, disconnected, or owned by someone else is repaired through the same upsert as
 * the connect event, and its import is queued. Must run on a privileged handle: the row to
 * repair may be invisible to the caller, which is the very fault being repaired.
 * Returns the import jobs to queue AFTER the transaction commits (the job reads the row).
 */
export async function ensureCallerCalendarAccounts(
  db: AccountDb,
  orgId: string,
  userId: string,
): Promise<{ repaired: string[]; jobs: Array<Record<string, unknown>> }> {
  const { sql } = await import("drizzle-orm")
  const schema = CALENDAR_SCHEMA()
  const connRows = (await db.execute(sql`
    SELECT id, owner_type, owner_id, identifier, connection_name
    FROM ${sql.raw(KERNEL_SCHEMA())}.connected_accounts
    WHERE org_id = ${orgId}::uuid AND app_name = 'calendar' AND status = 'active'
      AND ((owner_type = 'user' AND owner_id = ${userId}::uuid) OR owner_type = 'org')
    ORDER BY created_at
  `)) as unknown as
    | { rows?: Array<Record<string, string | null>> }
    | Array<Record<string, string | null>>
  const connections = Array.isArray(connRows) ? connRows : (connRows.rows ?? [])
  const repaired: string[] = []
  const jobs: Array<Record<string, unknown>> = []
  for (const conn of connections) {
    const connId = conn.id as string
    const ownerType = conn.owner_type as string
    const ownerId = conn.owner_id ?? null
    const boundRows = (await db.execute(sql`
      SELECT id, owner_type, owner_id FROM ${sql.raw(schema)}.accounts
      WHERE org_id = ${orgId}::uuid AND connected_account_id = ${connId}::uuid
        AND disconnected_at IS NULL
      LIMIT 1
    `)) as unknown as
      | { rows?: Array<Record<string, string | null>> }
      | Array<Record<string, string | null>>
    const bound = (Array.isArray(boundRows) ? boundRows : (boundRows.rows ?? []))[0]
    if (bound && bound.owner_type === ownerType && (bound.owner_id ?? null) === ownerId) {
      // Healthy row: only make sure the caller's own grant is there (no org-wide fan-out on a
      // read), and write it only when it is actually missing.
      if (!(await userHoldsCalendarAccess(db, orgId, userId, bound.id as string))) {
        await grantCalendarAccessDimension(db, orgId, bound.id as string, "user", userId)
      }
      continue
    }
    const { accountId } = await onAccountConnected(
      db,
      orgId,
      {
        orgId,
        actorId: userId,
        data: {
          id: connId,
          appName: "calendar",
          ownerType,
          ownerId,
          identifier: conn.identifier as string,
          connectionName: (conn.connection_name as string) ?? "google-calendar",
        },
      },
      async (_jobName, payload) => {
        jobs.push(payload)
      },
    )
    repaired.push(accountId)
  }
  return { repaired, jobs }
}

/**
 * onAccountDisconnected — the kernel `connected_account:disconnect` event. Disconnecting deletes
 * what was stored for the account (its calendars, their events and sync log) and marks the
 * account row disconnected; a reconnect of the address revives the row and its import brings
 * the calendars back from Google. Scoped to the accounts bound to that connection: an account
 * since rebound to a newer connection of the same address is not touched.
 */
export async function onAccountDisconnected(
  db: RlsClient,
  orgId: string,
  event: CalendarKernelDisconnectEvent,
): Promise<void> {
  const rows = await findAccountsByConnectedAccountId(db, orgId, event.data.id)
  for (const row of rows) {
    // A Google re-auth replaces the connection (old one disconnected, new one active for the
    // same address): the account lives on and is rebound by the `create` event.
    if (await hasActiveCalendarConnection(db, orgId, row.email_address)) continue
    await purgeCalendarAccount(db, orgId, row.id)
  }
}

/** SQL: an ACTIVE kernel calendar connection exists for the account row `a`'s address. The
 * kernel keeps one active connection per (org, app, connection, identifier) whatever its owner,
 * and a re-auth swaps it for a new one without a disconnect event: while it exists the account
 * is being kept, never purged. */
async function activeConnectionForAddressSql() {
  const { sql } = await import("drizzle-orm")
  return sql`EXISTS (
    SELECT 1 FROM ${sql.raw(KERNEL_SCHEMA())}.connected_accounts c
    WHERE c.org_id = a.org_id AND c.app_name = 'calendar' AND c.status = 'active'
      AND lower(c.identifier) = lower(a.email_address)
  )`
}

async function hasActiveCalendarConnection(
  db: AccountDb,
  orgId: string,
  emailAddress: string,
): Promise<boolean> {
  const { sql } = await import("drizzle-orm")
  const rows = (await db.execute(sql`
    SELECT 1 AS held FROM ${sql.raw(KERNEL_SCHEMA())}.connected_accounts
    WHERE org_id = ${orgId}::uuid AND app_name = 'calendar' AND status = 'active'
      AND lower(identifier) = lower(${emailAddress})
    LIMIT 1
  `)) as unknown as { rows?: unknown[] } | unknown[]
  return (Array.isArray(rows) ? rows : (rows.rows ?? [])).length > 0
}

/**
 * purgeCalendarAccount — deletes one account's calendars, events and sync log and marks it
 * disconnected, in one transaction. With its calendars gone, nothing schedules a sync for it:
 * the watch-renewal and poll-fallback jobs walk calendars, and a queued sync or push job finds
 * no calendar (or event) and returns.
 */
async function purgeCalendarAccount(
  db: AccountDb & Pick<RlsClient, "transaction">,
  orgId: string,
  accountId: string,
): Promise<void> {
  const { sql } = await import("drizzle-orm")
  const schema = sql.raw(CALENDAR_SCHEMA())
  // Read before the delete: the away days these calendars made go once the account is purged.
  const calendarRows = (await db.execute(sql`
    SELECT id FROM ${schema}.calendars WHERE org_id = ${orgId}::uuid AND account_id = ${accountId}::uuid
  `)) as unknown as { rows?: Array<{ id: string }> } | Array<{ id: string }>
  const ids = (Array.isArray(calendarRows) ? calendarRows : (calendarRows.rows ?? [])).map(
    (r) => r.id,
  )
  await db.transaction(async (tx) => {
    const ofAccount = sql`calendar_id IN (
      SELECT id FROM ${schema}.calendars WHERE org_id = ${orgId}::uuid AND account_id = ${accountId}::uuid
    )`
    // Local edits still owed to Google cannot be pushed once the account is gone: say so.
    const pending = (await tx.execute(sql`
      SELECT count(*)::int AS n FROM ${schema}.events
      WHERE org_id = ${orgId}::uuid AND ${ofAccount} AND pending_push <> 'none'
    `)) as unknown as { rows?: Array<{ n: number }> } | Array<{ n: number }>
    const unpushed = (Array.isArray(pending) ? pending : (pending.rows ?? []))[0]?.n ?? 0
    if (unpushed > 0) {
      log.warn(
        { orgId, accountId, unpushed },
        "calendar disconnect: deleting local changes that never reached Google",
      )
    }
    await tx.execute(
      sql`DELETE FROM ${schema}.events WHERE org_id = ${orgId}::uuid AND ${ofAccount}`,
    )
    await tx.execute(
      sql`DELETE FROM ${schema}.sync_log WHERE org_id = ${orgId}::uuid AND ${ofAccount}`,
    )
    await tx.execute(sql`
      DELETE FROM ${schema}.calendars WHERE org_id = ${orgId}::uuid AND account_id = ${accountId}::uuid
    `)
    await tx.execute(sql`
      UPDATE ${schema}.accounts
      SET sync_status = 'disconnected', disconnected_at = COALESCE(disconnected_at, now())
      WHERE org_id = ${orgId}::uuid AND id = ${accountId}::uuid
    `)
    // The away days its calendars made go with it, on this transaction; what the person said stays.
    await deleteCalendarAwayRanges(tx, orgId, ids)
  })
}

/**
 * reconcileDisconnectedCalendarAccounts — run before `list_accounts` answers. The disconnect
 * event reaches the app asynchronously (outbox), so Settings re-reading the accounts right after
 * the click still found the account connected: the first click looked like it did nothing.
 * Purges every account whose kernel connection is disconnected but whose app row is not yet,
 * and every disconnected account that still holds calendars (a lost event, or a disconnect from
 * before disconnect deleted data), unless an active connection exists for the same address: a
 * Google re-auth disconnects the old connection and creates a new one, and the row is rebound
 * (ensureCallerCalendarAccounts, or the `create` event), not emptied. One SELECT when there is
 * nothing to do. Privileged handle:
 * the rows may belong to another user. Returns the purged account ids.
 */
export async function reconcileDisconnectedCalendarAccounts(
  db: AccountDb & Pick<RlsClient, "transaction">,
  orgId: string,
): Promise<string[]> {
  const { sql } = await import("drizzle-orm")
  const schema = sql.raw(CALENDAR_SCHEMA())
  const rows = (await db.execute(sql`
    SELECT a.id FROM ${schema}.accounts a
    WHERE a.org_id = ${orgId}::uuid AND NOT ${await activeConnectionForAddressSql()} AND (
      (a.disconnected_at IS NULL AND EXISTS (
        SELECT 1 FROM ${sql.raw(KERNEL_SCHEMA())}.connected_accounts c
        WHERE c.org_id = a.org_id AND c.id = a.connected_account_id AND c.status = 'disconnected'
      ))
      OR (a.disconnected_at IS NOT NULL AND EXISTS (
        SELECT 1 FROM ${schema}.calendars cal WHERE cal.org_id = a.org_id AND cal.account_id = a.id
      ))
    )
  `)) as unknown as { rows?: Array<{ id: string }> } | Array<{ id: string }>
  const ids = (Array.isArray(rows) ? rows : (rows.rows ?? [])).map((r) => r.id)
  for (const id of ids) await purgeCalendarAccount(db, orgId, id)
  return ids
}

// --- Minimal RLS-scoped DB helpers (host-side, plain SQL via the Drizzle RlsClient) ---
// These are intentionally narrow (accounts table only) at Task-1 skeleton stage; Tasks 3-6
// extend this module with calendars/events helpers as the sync engine grows.

async function findAccountsByConnectedAccountId(
  db: RlsClient,
  orgId: string,
  connectedAccountId: string,
): Promise<CalendarAccountRow[]> {
  const { sql } = await import("drizzle-orm")
  const schema = CALENDAR_SCHEMA()
  const rows = (await db.execute(sql`
    SELECT id, connected_account_id, owner_type, owner_id, email_address, display_name,
           sync_status, last_sync_error, disconnected_at
    FROM ${sql.raw(schema)}.accounts
    WHERE org_id = ${orgId}::uuid AND connected_account_id = ${connectedAccountId}::uuid
  `)) as unknown as { rows?: CalendarAccountRow[] } | CalendarAccountRow[]
  return Array.isArray(rows) ? rows : (rows.rows ?? [])
}

/**
 * Insert the account row for an address, or rebind the existing one (UNIQUE (org_id,
 * email_address)) to this connection and owner, reviving it. One statement, so two concurrent
 * connects or ensure-on-read repairs of the same address converge on one row instead of the
 * second failing on the unique constraint. `created` is true only when the row was inserted.
 */
async function upsertAccount(
  db: AccountDb,
  orgId: string,
  fields: {
    connected_account_id: string
    owner_type: string
    owner_id: string | null
    email_address: string
    display_name: string | null
    sync_status: string
  },
): Promise<{ accountId: string; created: boolean }> {
  const { sql } = await import("drizzle-orm")
  const schema = CALENDAR_SCHEMA()
  const rows = (await db.execute(sql`
    INSERT INTO ${sql.raw(schema)}.accounts
      (id, org_id, connected_account_id, owner_type, owner_id, email_address, display_name, sync_status)
    VALUES
      (gen_random_uuid(), ${orgId}::uuid, ${fields.connected_account_id}::uuid, ${fields.owner_type},
       ${fields.owner_id}::uuid, ${fields.email_address}, ${fields.display_name}, ${fields.sync_status})
    ON CONFLICT (org_id, email_address) DO UPDATE SET
      connected_account_id = EXCLUDED.connected_account_id,
      owner_type = EXCLUDED.owner_type,
      owner_id = EXCLUDED.owner_id,
      sync_status = EXCLUDED.sync_status,
      last_sync_error = NULL,
      disconnected_at = NULL
    RETURNING id, (xmax = 0) AS created
  `)) as unknown as
    | { rows?: Array<{ id: string; created: boolean }> }
    | Array<{ id: string; created: boolean }>
  const list = Array.isArray(rows) ? rows : (rows.rows ?? [])
  const row = list[0]
  if (!row?.id) throw new Error("calendar accounts upsert returned no id")
  return { accountId: row.id, created: row.created === true }
}

/** Whether the user's `calendar:calaccess` grant already names the account (read only). */
async function userHoldsCalendarAccess(
  db: AccountDb,
  orgId: string,
  userId: string,
  accountId: string,
): Promise<boolean> {
  const { sql } = await import("drizzle-orm")
  const rows = (await db.execute(sql`
    SELECT 1 AS held FROM ${sql.raw(KERNEL_SCHEMA())}.user_dimension_grants
    WHERE user_id = ${userId}::uuid AND org_id = ${orgId}::uuid
      AND dimension_key = 'calendar:calaccess'
      AND dimension_values @> ${JSON.stringify([accountId])}::jsonb
    LIMIT 1
  `)) as unknown as { rows?: unknown[] } | unknown[]
  return (Array.isArray(rows) ? rows : (rows.rows ?? [])).length > 0
}

async function updateAccount(
  db: AccountDb,
  orgId: string,
  accountId: string,
  fields: Record<string, string | null>,
): Promise<void> {
  const { sql } = await import("drizzle-orm")
  const schema = CALENDAR_SCHEMA()
  const setClauses = Object.entries(fields)
    .map(([col, val]) => sql`${sql.raw(col)} = ${val}`)
    .reduce((acc, clause, i) => (i === 0 ? clause : sql`${acc}, ${clause}`))
  await db.execute(sql`
    UPDATE ${sql.raw(schema)}.accounts SET ${setClauses}
    WHERE org_id = ${orgId}::uuid AND id = ${accountId}::uuid
  `)
}

async function getAccountById(
  db: RlsClient,
  orgId: string,
  accountId: string,
): Promise<CalendarAccountRow | undefined> {
  const { sql } = await import("drizzle-orm")
  const schema = CALENDAR_SCHEMA()
  const rows = (await db.execute(sql`
    SELECT id, connected_account_id, owner_type, owner_id, email_address, display_name,
           sync_status, last_sync_error, disconnected_at
    FROM ${sql.raw(schema)}.accounts
    WHERE org_id = ${orgId}::uuid AND id = ${accountId}::uuid
    LIMIT 1
  `)) as unknown as { rows?: CalendarAccountRow[] } | CalendarAccountRow[]
  const list = Array.isArray(rows) ? rows : (rows.rows ?? [])
  return list[0]
}

/**
 * grantCalendarAccessDimension — writes the `calendar:calaccess` membership-dimension grant
 * directly into `kernel.user_dimension_grants` (mirrors what `grantUserDimension` persists,
 * bypassing its actor-escalation checks because this runs as a SYSTEM job context, exactly
 * as mail's onAccountConnected performs its account-row writes as a system actor). For a
 * personal connection, only the connecting user is granted the account's id value. For an
 * org-wide connection, EVERY current org member is granted the value (merged into their
 * existing values array, not overwritten) so org calendars are visible org-wide per the
 * Design section. Idempotent: re-running (reconnect) merges without duplicating the value.
 *
 * KNOWN LIMITATION (task-tier boundary — mirrors mail's membership-dimension pattern): org-member
 * grants are computed ONCE at connect/import time. There is no lifecycle hook that (a) grants the
 * calaccess value to a user who JOINS the org AFTER an org calendar is connected — they see the
 * org calendars only once a reconnect re-runs this fan-out — nor (b) explicitly revokes the grant
 * when a user is deactivated/removed. The retained-grant case is NOT a live access path: kernel
 * `deactivateUser` bumps the user's `auth_version`, so a deactivated user's tokens stop
 * authenticating org-wide immediately and cannot establish any RLS context to read the calendar
 * rows — the stale grant row is inert unless the user is reactivated (at which point re-grant is
 * moot, they're a member again). A full member-lifecycle reconciliation (grant on join / revoke on
 * removal) is deferred; adding it kernel-wide would also close the identical mail gap.
 */
async function grantCalendarAccessDimension(
  db: AccountDb,
  orgId: string,
  accountId: string,
  ownerType: string,
  ownerId: string | null,
): Promise<void> {
  const { sql } = await import("drizzle-orm")
  const dimensionKey = "calendar:calaccess"
  const userIds: string[] = []
  if (ownerType === "user" && ownerId) {
    userIds.push(ownerId)
  } else if (ownerType === "org") {
    const rows = (await db.execute(sql`
      SELECT id FROM ${sql.raw(KERNEL_SCHEMA())}.users WHERE org_id = ${orgId}::uuid AND status = 'active'
    `)) as unknown as { rows?: Array<{ id: string }> } | Array<{ id: string }>
    const list = Array.isArray(rows) ? rows : (rows.rows ?? [])
    userIds.push(...list.map((r) => r.id))
  }
  for (const userId of userIds) {
    // The WHERE skips a user who already holds the value, so RETURNING yields a
    // row only when this user's grant actually changed.
    const res = (await db.execute(sql`
      INSERT INTO ${sql.raw(KERNEL_SCHEMA())}.user_dimension_grants (id, user_id, org_id, dimension_key, dimension_values)
      VALUES (gen_random_uuid(), ${userId}::uuid, ${orgId}::uuid, ${dimensionKey}, ${JSON.stringify([accountId])}::jsonb)
      ON CONFLICT (user_id, org_id, dimension_key) DO UPDATE SET
        dimension_values = (
          SELECT jsonb_agg(DISTINCT v)
          FROM jsonb_array_elements(
            ${sql.raw(KERNEL_SCHEMA())}.user_dimension_grants.dimension_values || ${JSON.stringify([accountId])}::jsonb
          ) AS v
        )
      WHERE NOT (${sql.raw(KERNEL_SCHEMA())}.user_dimension_grants.dimension_values @> ${JSON.stringify([accountId])}::jsonb)
      RETURNING user_id
    `)) as unknown as { rows?: unknown[] } | unknown[]
    const changed = Array.isArray(res) ? res : (res.rows ?? [])
    if (changed.length > 0) {
      // Delivery carrier: `resolveGrantInvalidations` resolves the affected
      // user and their thread ids from this event plus the database at
      // delivery time, so queuing it in the SAME transaction as the grant is
      // what makes the invalidation reach the user's own sockets.
      await db.queueEvent({
        app: "kernel",
        entity: "user_dimension",
        action: "grant",
        entityId: userId,
        orgId,
        data: { targetUserId: userId, dimension: dimensionKey },
      })
    }
  }
}

/**
 * grantOrgCalendarAccessToUser — grant fan-out for a user who joins the org AFTER an org
 * calendar was connected (the import-time fan-out in grantCalendarAccessDimension only covers
 * users active at import). Wired to the `kernel/user:registered` event via the manifest's
 * onUserRegistered handler. Idempotent (same DISTINCT-merge upsert as the import-time grant).
 */
export async function grantOrgCalendarAccessToUser(
  db: RlsClient,
  orgId: string,
  userId: string,
): Promise<number> {
  const { sql } = await import("drizzle-orm")
  const schema = CALENDAR_SCHEMA()
  const rows = (await db.execute(sql`
    SELECT id FROM ${sql.raw(schema)}.accounts
    WHERE org_id = ${orgId}::uuid AND owner_type = 'org' AND disconnected_at IS NULL
      AND sync_status <> 'imported'
  `)) as unknown as { rows?: Array<{ id: string }> } | Array<{ id: string }>
  const accounts = Array.isArray(rows) ? rows : (rows.rows ?? [])
  let changed = false
  for (const account of accounts) {
    const res = (await db.execute(sql`
      INSERT INTO ${sql.raw(KERNEL_SCHEMA())}.user_dimension_grants (id, user_id, org_id, dimension_key, dimension_values)
      VALUES (gen_random_uuid(), ${userId}::uuid, ${orgId}::uuid, 'calendar:calaccess', ${JSON.stringify([account.id])}::jsonb)
      ON CONFLICT (user_id, org_id, dimension_key) DO UPDATE SET
        dimension_values = (
          SELECT jsonb_agg(DISTINCT v)
          FROM jsonb_array_elements(
            ${sql.raw(KERNEL_SCHEMA())}.user_dimension_grants.dimension_values || ${JSON.stringify([account.id])}::jsonb
          ) AS v
        )
      WHERE NOT (${sql.raw(KERNEL_SCHEMA())}.user_dimension_grants.dimension_values @> ${JSON.stringify([account.id])}::jsonb)
      RETURNING user_id
    `)) as unknown as { rows?: unknown[] } | unknown[]
    if ((Array.isArray(res) ? res : (res.rows ?? [])).length > 0) changed = true
  }
  if (changed) {
    // Delivery carrier: `resolveGrantInvalidations` resolves the affected
    // user and their thread ids from this event plus the database at
    // delivery time, so queuing it in the SAME transaction as the grant is
    // what makes the invalidation reach the user's own sockets.
    await db.queueEvent({
      app: "kernel",
      entity: "user_dimension",
      action: "grant",
      entityId: userId,
      orgId,
      data: { targetUserId: userId, dimension: "calendar:calaccess" },
    })
  }
  return accounts.length
}

// --- Calendars table helpers ---

export interface CalendarRow {
  id: string
  account_id: string
  google_calendar_id: string
  name: string
  color: string | null
  time_zone: string | null
  access_role: string | null
  selected: boolean
  sync_token: string | null
  watch_channel_id: string | null
  watch_resource_id: string | null
  watch_expiration: string | null
  last_polled_at: string | null
  sync_pending: boolean
  calaccess: string
}

export interface GoogleCalendarListEntry {
  id: string
  summary?: string
  backgroundColor?: string
  timeZone?: string
  accessRole?: string
}

async function findCalendarsByAccountId(
  db: RlsClient,
  orgId: string,
  accountId: string,
): Promise<CalendarRow[]> {
  const { sql } = await import("drizzle-orm")
  const schema = CALENDAR_SCHEMA()
  const rows = (await db.execute(sql`
    SELECT id, account_id, google_calendar_id, name, color, time_zone, access_role, selected,
           sync_token, watch_channel_id, watch_resource_id, watch_expiration, last_polled_at,
           sync_pending, calaccess
    FROM ${sql.raw(schema)}.calendars
    WHERE org_id = ${orgId}::uuid AND account_id = ${accountId}::uuid
  `)) as unknown as { rows?: CalendarRow[] } | CalendarRow[]
  return Array.isArray(rows) ? rows : (rows.rows ?? [])
}

async function upsertCalendar(
  db: RlsClient,
  orgId: string,
  accountId: string,
  calaccess: string,
  entry: GoogleCalendarListEntry,
): Promise<{ id: string; created: boolean }> {
  const { sql } = await import("drizzle-orm")
  const schema = CALENDAR_SCHEMA()
  const rows = (await db.execute(sql`
    INSERT INTO ${sql.raw(schema)}.calendars
      (id, org_id, account_id, google_calendar_id, name, color, time_zone, access_role, selected, calaccess)
    VALUES
      (gen_random_uuid(), ${orgId}::uuid, ${accountId}::uuid, ${entry.id}, ${entry.summary ?? entry.id},
       ${entry.backgroundColor ?? null}, ${entry.timeZone ?? null}, ${entry.accessRole ?? null}, true, ${calaccess})
    ON CONFLICT (org_id, account_id, google_calendar_id) DO UPDATE SET
      name = EXCLUDED.name, color = EXCLUDED.color, time_zone = EXCLUDED.time_zone,
      access_role = EXCLUDED.access_role
    RETURNING id, (xmax = 0) AS inserted
  `)) as unknown as
    | { rows?: Array<{ id: string; inserted: boolean }> }
    | Array<{ id: string; inserted: boolean }>
  const list = Array.isArray(rows) ? rows : (rows.rows ?? [])
  const row = list[0]
  if (!row) throw new Error("calendar calendars upsert returned no id")
  return { id: row.id, created: row.inserted }
}

/**
 * Resolve Google's `"primary"` calendar alias to a concrete local calendar row.
 * Agents (and Google's own API convention) address a user's default calendar as
 * the literal string `"primary"` rather than a uuid — passing it straight into
 * the `id = $::uuid` lookup blows up as a Postgres "22P02 invalid input syntax
 * for type uuid" 500. Google's primary calendar is the one whose calendar id
 * equals the account's own email address (and carries access_role='owner'), so
 * we map the alias to that row. If the caller can see exactly one such primary
 * calendar we use it; if none is visible, or more than one (multiple connected
 * accounts, so "primary" is ambiguous), we throw an agent-actionable error
 * naming list_calendars — never leak the alias into a uuid query.
 */
async function resolvePrimaryCalendar(db: RlsClient, orgId: string): Promise<CalendarRow> {
  const { sql } = await import("drizzle-orm")
  const schema = CALENDAR_SCHEMA()
  // Read visible accounts and calendars as two SEPARATE RLS-scoped reads rather
  // than a single JOIN: the `accounts` and `calendars` tables carry different
  // RLS visibility (calaccess dimension vs owner), and a JOIN evaluates the
  // stricter side, hiding a calendar the caller can legitimately see. Match the
  // primary in-memory: Google's primary calendar id equals its account email.
  const accountRows = (await db.execute(sql`
    SELECT id, email_address FROM ${sql.raw(schema)}.accounts
    WHERE org_id = ${orgId}::uuid AND disconnected_at IS NULL
  `)) as unknown as { rows?: Array<{ email_address: string }> } | Array<{ email_address: string }>
  const accounts = Array.isArray(accountRows) ? accountRows : (accountRows.rows ?? [])
  const emails = new Set(accounts.map((a) => a.email_address))
  const calRows = (await db.execute(sql`
    SELECT id, account_id, google_calendar_id, name, color, time_zone, access_role, selected,
           sync_token, watch_channel_id, watch_resource_id, watch_expiration, last_polled_at,
           sync_pending, calaccess
    FROM ${sql.raw(schema)}.calendars
    WHERE org_id = ${orgId}::uuid
  `)) as unknown as { rows?: CalendarRow[] } | CalendarRow[]
  const cals = Array.isArray(calRows) ? calRows : (calRows.rows ?? [])
  const list = cals.filter((c) => emails.has(c.google_calendar_id))
  // Deliberate typed 4xx (status + code) so execute-tool's severity-follows-
  // HTTP-class rule logs these agent-correctable rejections at warn, not the
  // error level that pages the prod watchdog as a new-signature critical.
  if (list.length === 0) {
    throw Object.assign(
      new Error(
        `No primary calendar is available. Call list_calendars and pass a specific calendar id instead of "primary".`,
      ),
      { status: 422, code: "invalid_params" },
    )
  }
  if (list.length > 1) {
    throw Object.assign(
      new Error(
        `"primary" is ambiguous: more than one connected account has a primary calendar. Call list_calendars and pass a specific calendar id.`,
      ),
      { status: 422, code: "invalid_params" },
    )
  }
  return list[0]!
}

export async function getCalendarById(
  db: RlsClient,
  orgId: string,
  calendarId: string,
): Promise<CalendarRow | undefined> {
  // "primary" is Google's alias for the account's default calendar, not a uuid —
  // resolve it before the id = $::uuid query (else 22P02). See resolvePrimaryCalendar.
  if (calendarId === "primary") {
    return resolvePrimaryCalendar(db, orgId)
  }
  const { sql } = await import("drizzle-orm")
  const schema = CALENDAR_SCHEMA()
  const rows = (await db.execute(sql`
    SELECT id, account_id, google_calendar_id, name, color, time_zone, access_role, selected,
           sync_token, watch_channel_id, watch_resource_id, watch_expiration, last_polled_at,
           sync_pending, calaccess
    FROM ${sql.raw(schema)}.calendars
    WHERE org_id = ${orgId}::uuid AND id = ${calendarId}::uuid
    LIMIT 1
  `)) as unknown as { rows?: CalendarRow[] } | CalendarRow[]
  const list = Array.isArray(rows) ? rows : (rows.rows ?? [])
  return list[0]
}

async function setCalendarSelected(
  db: RlsClient,
  orgId: string,
  calendarId: string,
  selected: boolean,
): Promise<void> {
  const { sql } = await import("drizzle-orm")
  const schema = CALENDAR_SCHEMA()
  const rows = (await db.execute(sql`
    UPDATE ${sql.raw(schema)}.calendars SET selected = ${selected}
    WHERE org_id = ${orgId}::uuid AND id = ${calendarId}::uuid
    RETURNING id
  `)) as unknown as { rows?: Array<{ id: string }> } | Array<{ id: string }>
  // RLS turns a write the caller may not make into a 0-row UPDATE, not an error: report it.
  const list = Array.isArray(rows) ? rows : (rows.rows ?? [])
  if (list.length === 0) {
    throw new Error(`calendar: could not update calendar ${calendarId} (no write access)`)
  }
}

async function deleteEventsForCalendar(
  db: RlsClient,
  orgId: string,
  calendarId: string,
): Promise<void> {
  const { sql } = await import("drizzle-orm")
  const schema = CALENDAR_SCHEMA()
  // A tombstone still owes Google its delete: it stays (and is pushed), or the event would
  // survive on Google and come back when the calendar is selected again.
  await db.execute(sql`
    DELETE FROM ${sql.raw(schema)}.events
    WHERE org_id = ${orgId}::uuid AND calendar_id = ${calendarId}::uuid
      AND pending_push <> 'delete'
  `)
}

async function stopCalendarWatch(db: RlsClient, orgId: string, calendarId: string): Promise<void> {
  const { sql } = await import("drizzle-orm")
  const schema = CALENDAR_SCHEMA()
  await db.execute(sql`
    UPDATE ${sql.raw(schema)}.calendars
    SET watch_channel_id = NULL, watch_resource_id = NULL, watch_expiration = NULL, sync_token = NULL
    WHERE org_id = ${orgId}::uuid AND id = ${calendarId}::uuid
  `)
}

/**
 * runCalendarImport — the `calendar-import` job. Lists the account's Google calendars via
 * calendarList.list (through the injected `listCalendars` fetcher, which the sandboxed handler
 * wires to `ctx.fetch` + google-client.ts), upserts `calendars` rows (selected=true default),
 * then enqueues `calendar-initial-sync` per selected calendar. Idempotent on reconnect: existing
 * calendars are updated in place, not duplicated (unique (accountId, googleCalendarId)).
 */
export async function runCalendarImport(
  db: RlsClient,
  orgId: string,
  accountId: string,
  listCalendars: () => Promise<GoogleCalendarListEntry[]>,
  enqueueJob: (jobName: string, payload: Record<string, unknown>) => Promise<void>,
): Promise<{ calendarIds: string[] }> {
  const account = await getAccountById(db, orgId, accountId)
  if (!account) throw new Error(`calendar account ${accountId} not found`)

  await grantCalendarAccessDimension(db, orgId, accountId, account.owner_type, account.owner_id)

  const entries = await listCalendars()
  const calendarIds: string[] = []
  for (const entry of entries) {
    const { id: calendarId } = await upsertCalendar(db, orgId, accountId, accountId, entry)
    calendarIds.push(calendarId)
  }

  for (const calendarId of calendarIds) {
    await enqueueJob("calendar-initial-sync", { orgId, accountId, calendarId })
  }

  // A successful import clears any error a previous failed import left behind.
  await updateAccount(db, orgId, accountId, {
    sync_status: entries.length > 0 ? "syncing" : "active",
    last_sync_error: null,
  })

  return { calendarIds }
}

const MAX_SYNC_ERROR_LENGTH = 1000

/**
 * describeCalendarListFailure — turns a non-2xx Google `calendarList.list` response into a
 * reason code (for logs) and a readable message (stored as the account's `last_sync_error`).
 * Google's error body: `{ error: { code, message, status, errors: [{ reason }],
 * details: [{ reason, metadata: { activationUrl } }] } }`. A project without the Calendar API
 * enabled answers 403 `accessNotConfigured` / `SERVICE_DISABLED`, which only an administrator
 * of the Google Cloud project can fix, so that case names the fix and its URL.
 */
export function describeCalendarListFailure(
  status: number,
  bodyText: string,
): { reason: string | null; message: string } {
  let error: {
    message?: string
    status?: string
    errors?: Array<{ reason?: string }>
    details?: Array<{ reason?: string; metadata?: { activationUrl?: string } }>
  } = {}
  try {
    const parsed = JSON.parse(bodyText) as { error?: typeof error }
    if (parsed && typeof parsed.error === "object" && parsed.error) error = parsed.error
  } catch {
    // not JSON — fall back to the raw body below
  }
  const detail = (error.details ?? []).find((d) => typeof d?.reason === "string")
  const reason = detail?.reason ?? error.errors?.[0]?.reason ?? error.status ?? null
  const googleMessage = (error.message ?? bodyText ?? "").trim()

  let message: string
  if (reason === "SERVICE_DISABLED" || reason === "accessNotConfigured") {
    const activationUrl = (error.details ?? []).find((d) => d?.metadata?.activationUrl)?.metadata
      ?.activationUrl
    message =
      "The Google Calendar API is not enabled in the Google Cloud project used for this " +
      `connection. An administrator of that project must enable it${
        activationUrl ? ` at ${activationUrl}` : ""
      }, then retry the import. Google said: ${googleMessage}`
  } else {
    message = `Google Calendar refused to list this account's calendars (HTTP ${status}${
      reason ? `, ${reason}` : ""
    })${googleMessage ? `: ${googleMessage}` : "."}`
  }
  if (message.length > MAX_SYNC_ERROR_LENGTH) {
    message = `${message.slice(0, MAX_SYNC_ERROR_LENGTH - 1)}…`
  }
  return { reason, message }
}

/**
 * recordCalendarImportFailure — a failed `calendar-import` leaves the account in `error` with a
 * readable `last_sync_error`, instead of importing an empty calendar list as a success.
 */
export async function recordCalendarImportFailure(
  db: RlsClient,
  orgId: string,
  accountId: string,
  status: number,
  bodyText: string,
): Promise<{ reason: string | null; message: string }> {
  const described = describeCalendarListFailure(status, bodyText)
  await updateAccount(db, orgId, accountId, {
    sync_status: "error",
    last_sync_error: described.message,
  })
  return described
}

/**
 * requestCalendarReimport — the `retry_import` tool: re-enqueues `calendar-import` for an
 * account the caller can see (RLS: a personal account only for its owner). Re-importing an
 * org account is an admin action, like the rest of org calendar management. The account row
 * is left as is: the job (system context) sets 'syncing'/'active' and clears the error on
 * success, or records the new error; a member's own RLS context cannot write `accounts`.
 */
export async function requestCalendarReimport(
  db: RlsClient,
  orgId: string,
  accountId: string,
  enqueueJob: (jobName: string, payload: Record<string, unknown>) => Promise<void>,
  caller: SetSelectedCaller,
): Promise<void> {
  const account = await getAccountById(db, orgId, accountId)
  if (!account || account.disconnected_at) {
    throw new Error(`calendar account ${accountId} not found`)
  }
  if (account.owner_type === "org" && !caller.isAdmin) {
    throw new Error("calendar: retrying an org account import requires the calendar admin scope")
  }
  await enqueueJob("calendar-import", { orgId, accountId })
}

export interface SetSelectedCaller {
  /** Whether the caller holds the calendar:accounts:admin scope. */
  isAdmin: boolean
  /** The acting user's id (for the personal-ownership branch). */
  userId: string | null
}

/**
 * setSelected — UI-driven calendar_setSelected: deselect stops the watch channel and purges
 * that calendar's local events (Design: "deselect → stop channel + delete that calendar's
 * local events; select → enqueue initial sync").
 *
 * Authorization (security boundary — success criterion #4 / Amendment 5): toggling an ORG
 * calendar is admin-only (deselect is destructive — it purges every member's mirrored events for
 * that calendar). A member may toggle a PERSONAL calendar they own. Enforced here, not by the
 * tool scope alone (the tool is member-reachable so the personal path works).
 */
export async function setCalendarSelectedAndSync(
  db: RlsClient,
  orgId: string,
  calendarId: string,
  selected: boolean,
  enqueueJob: (jobName: string, payload: Record<string, unknown>) => Promise<void>,
  caller: SetSelectedCaller,
): Promise<void> {
  const calendar = await getCalendarById(db, orgId, calendarId)
  if (!calendar) throw new Error(`calendar ${calendarId} not found`)
  const account = await getAccountById(db, orgId, calendar.account_id)
  if (!account) throw new Error(`calendar account ${calendar.account_id} not found`)

  if (account.owner_type === "org") {
    if (!caller.isAdmin) {
      throw new Error("calendar: selecting an org calendar requires the calendar admin scope")
    }
  } else {
    // Personal calendar — only the owning user (or an admin) may toggle it.
    if (!caller.isAdmin && (!caller.userId || account.owner_id !== caller.userId)) {
      throw new Error("calendar: only the owning user may toggle a personal calendar")
    }
  }

  await setCalendarSelected(db, orgId, calendarId, selected)
  if (selected) {
    await enqueueJob("calendar-initial-sync", { orgId, calendarId })
  } else {
    await stopCalendarWatch(db, orgId, calendarId)
    await deleteEventsForCalendar(db, orgId, calendarId)
  }
}

// --- Events table helpers + inbound sync (Task 4) ---

export interface GoogleEventItem {
  id: string
  status?: string
  etag?: string
  summary?: string
  description?: string
  location?: string
  start?: { date?: string; dateTime?: string; timeZone?: string }
  end?: { date?: string; dateTime?: string; timeZone?: string }
  attendees?: Array<{ email: string; [field: string]: unknown }>
  recurrence?: string[]
  organizer?: { email?: string; self?: boolean }
  creator?: { email?: string; self?: boolean }
  /** Google's event type: default, outOfOffice, focusTime, workingLocation, birthday, fromGmail. */
  eventType?: string
  guestsCanModify?: boolean
  recurringEventId?: string
  originalStartTime?: { date?: string; dateTime?: string; timeZone?: string }
  updated?: string
  extendedProperties?: { private?: Record<string, string> }
  hangoutLink?: string
  conferenceData?: unknown
}

export interface EventRow {
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
  status: string
  attendees: unknown
  recurrence: unknown
  recurring_event_id: string | null
  original_start_time: unknown
  extended_props: unknown
  hangout_link: string | null
  liaison_sync_version: number
  pending_push: string
  updated_at: string
  google_updated_at: string | null
  calaccess: string
  /** The attendee list as last synced, recorded when a local edit first changes attendees and
   * cleared once that edit reaches Google. Null = attendees not edited locally. */
  attendees_base?: unknown
  organizer_self?: boolean | null
  guests_can_modify?: boolean | null
  /** Why Google refused this row's last push (400 and the like); null when none. */
  push_error?: string | null
  /** Why a refused delete brought this event back (shown in the dialog; not a push error). */
  push_notice?: string | null
  /** The edit a delete superseded (create/update), restored if Google refuses the delete. */
  pending_before_delete?: string | null
  /** Set while a local delete waits to reach Google (the row is a tombstone: hidden from every
   * read, kept so the import cannot bring the event back). */
  deleted_at?: string | null
  /** A conference change waiting to reach Google: "add" (create a Google Meet) or "remove";
   * null when none. Cleared once Google answers the push. */
  conference_request?: string | null
}

export async function getEventByGoogleId(
  db: RlsClient,
  orgId: string,
  calendarId: string,
  googleEventId: string,
): Promise<EventRow | undefined> {
  const { sql } = await import("drizzle-orm")
  const schema = CALENDAR_SCHEMA()
  const rows = (await db.execute(sql`
    SELECT id, calendar_id, google_event_id, etag, title, description, location, start, "end",
           all_day, status, attendees, recurrence, recurring_event_id, original_start_time,
           extended_props, hangout_link, liaison_sync_version, pending_push, updated_at, google_updated_at, calaccess
    FROM ${sql.raw(schema)}.events
    WHERE org_id = ${orgId}::uuid AND calendar_id = ${calendarId}::uuid AND google_event_id = ${googleEventId}
    LIMIT 1
  `)) as unknown as { rows?: EventRow[] } | EventRow[]
  const list = Array.isArray(rows) ? rows : (rows.rows ?? [])
  return list[0]
}

function mapGoogleItemToRow(item: GoogleEventItem): {
  title: string | null
  description: string | null
  location: string | null
  start: unknown
  end: unknown
  allDay: boolean
  attendees: unknown
  recurrence: unknown
  recurringEventId: string | null
  originalStartTime: unknown
  extendedProps: unknown
  hangoutLink: string | null
  etag: string | null
  googleUpdatedAt: string | null
  organizerSelf: boolean | null
  guestsCanModify: boolean | null
  eventType: string | null
} {
  const allDay = Boolean(item.start?.date && !item.start?.dateTime)
  return {
    title: item.summary ?? null,
    description: item.description ?? null,
    location: item.location ?? null,
    start: item.start ?? null,
    end: item.end ?? null,
    allDay,
    attendees: item.attendees ?? null,
    recurrence: item.recurrence ?? null,
    recurringEventId: item.recurringEventId ?? null,
    originalStartTime: item.originalStartTime ?? null,
    extendedProps: item.extendedProperties?.private ?? null,
    hangoutLink: conferenceLinkOf(item),
    etag: item.etag ?? null,
    googleUpdatedAt: item.updated ?? null,
    // Google omits `organizer.self` when false and `guestsCanModify` when false (its documented
    // default), so an absent field means false. No organizer at all: unknown (null).
    organizerSelf: item.organizer ? item.organizer.self === true : null,
    guestsCanModify: item.guestsCanModify === true,
    eventType: typeof item.eventType === "string" ? item.eventType : null,
  }
}

/** Rows per upsert statement: 22 bound parameters each, far under the 65535 ceiling. */
const EVENT_UPSERT_CHUNK = 500

/**
 * upsertEventsFromGoogle — upsert Google event items into `events`, one INSERT ... ON CONFLICT
 * per chunk instead of one statement per event (a sync page is up to 250 events; the
 * row-at-a-time loop was 250 round trips inside the job's transaction). Used by BOTH initial
 * sync (no echo/LWW check needed — first sync, nothing local to conflict with) and incremental
 * sync (caller does echo + LWW gating BEFORE calling this).
 *
 * One statement may not touch the same row twice (`ON CONFLICT DO UPDATE command cannot affect
 * row a second time`), so a page that lists one event twice keeps its LAST occurrence, which is
 * what applying the items in order used to leave behind.
 */
async function upsertEventsFromGoogle(
  db: RlsClient,
  orgId: string,
  calendarId: string,
  entries: Array<{ calaccess: string; item: GoogleEventItem }>,
): Promise<void> {
  if (entries.length === 0) return
  const { sql } = await import("drizzle-orm")
  const schema = CALENDAR_SCHEMA()
  const lastById = new Map<string, { calaccess: string; item: GoogleEventItem }>()
  for (const entry of entries) {
    lastById.delete(entry.item.id)
    lastById.set(entry.item.id, entry)
  }
  const unique = [...lastById.values()]
  for (let start = 0; start < unique.length; start += EVENT_UPSERT_CHUNK) {
    const tuples = unique.slice(start, start + EVENT_UPSERT_CHUNK).map(({ calaccess, item }) => {
      const mapped = mapGoogleItemToRow(item)
      return sql`(gen_random_uuid(), ${orgId}::uuid, ${calendarId}::uuid, ${item.id}, ${mapped.etag},
       ${mapped.title}, ${mapped.description}, ${mapped.location},
       ${JSON.stringify(mapped.start)}::jsonb, ${JSON.stringify(mapped.end)}::jsonb, ${mapped.allDay}::boolean,
       ${item.status ?? "confirmed"}, ${JSON.stringify(mapped.attendees)}::jsonb,
       ${JSON.stringify(mapped.recurrence)}::jsonb, ${mapped.recurringEventId},
       ${JSON.stringify(mapped.originalStartTime)}::jsonb, ${JSON.stringify(mapped.extendedProps)}::jsonb,
       ${mapped.hangoutLink}, ${mapped.googleUpdatedAt}::timestamptz,
       COALESCE(${mapped.googleUpdatedAt}::timestamptz, now()), ${calaccess},
       ${mapped.organizerSelf}::boolean, ${mapped.guestsCanModify}::boolean, ${mapped.eventType})`
    })
    await db.execute(sql`
      INSERT INTO ${sql.raw(schema)}.events
        (id, org_id, calendar_id, google_event_id, etag, title, description, location, start, "end",
         all_day, status, attendees, recurrence, recurring_event_id, original_start_time,
         extended_props, hangout_link, google_updated_at, updated_at, calaccess,
         organizer_self, guests_can_modify, event_type)
      VALUES ${sql.join(tuples, sql.raw(", "))}
      ON CONFLICT (org_id, calendar_id, google_event_id) WHERE google_event_id IS NOT NULL DO UPDATE SET
        etag = EXCLUDED.etag, title = EXCLUDED.title, description = EXCLUDED.description,
        location = EXCLUDED.location, start = EXCLUDED.start, "end" = EXCLUDED."end",
        all_day = EXCLUDED.all_day, status = EXCLUDED.status, attendees = EXCLUDED.attendees,
        recurrence = EXCLUDED.recurrence, recurring_event_id = EXCLUDED.recurring_event_id,
        original_start_time = EXCLUDED.original_start_time, extended_props = EXCLUDED.extended_props,
        hangout_link = EXCLUDED.hangout_link,
        google_updated_at = EXCLUDED.google_updated_at,
        updated_at = COALESCE(EXCLUDED.google_updated_at, now()), pending_push = 'none',
        organizer_self = EXCLUDED.organizer_self, guests_can_modify = EXCLUDED.guests_can_modify,
        event_type = EXCLUDED.event_type,
        attendees_base = NULL, push_error = NULL, push_notice = NULL, conference_request = NULL
      -- A local delete waiting to reach Google is not undone by the import.
      WHERE ${sql.raw(schema)}.events.deleted_at IS NULL
    `)
  }
}

/** The local rows of `googleEventIds` on one calendar, keyed by Google id, in one query. */
async function getEventsByGoogleIds(
  db: RlsClient,
  orgId: string,
  calendarId: string,
  googleEventIds: string[],
): Promise<Map<string, EventRow>> {
  const out = new Map<string, EventRow>()
  if (googleEventIds.length === 0) return out
  const { sql } = await import("drizzle-orm")
  const schema = CALENDAR_SCHEMA()
  const rows = (await db.execute(sql`
    SELECT id, calendar_id, google_event_id, etag, updated_at, calaccess, push_error, pending_push
    FROM ${sql.raw(schema)}.events
    WHERE org_id = ${orgId}::uuid AND calendar_id = ${calendarId}::uuid
      AND google_event_id IN (${sql.join(
        googleEventIds.map((id) => sql`${id}`),
        sql.raw(", "),
      )})
  `)) as unknown as { rows?: EventRow[] } | EventRow[]
  for (const row of Array.isArray(rows) ? rows : (rows.rows ?? [])) {
    if (row.google_event_id) out.set(row.google_event_id, row)
  }
  return out
}

async function setCalendarSyncToken(
  db: RlsClient,
  orgId: string,
  calendarId: string,
  syncToken: string | null,
): Promise<void> {
  const { sql } = await import("drizzle-orm")
  const schema = CALENDAR_SCHEMA()
  await db.execute(sql`
    UPDATE ${sql.raw(schema)}.calendars SET sync_token = ${syncToken}
    WHERE org_id = ${orgId}::uuid AND id = ${calendarId}::uuid
  `)
}

export interface SyncPage {
  items?: GoogleEventItem[]
  nextPageToken?: string | null
  nextSyncToken?: string | null
}

/** The Google id a local event is created with (handlers.ts googleIdForLocalEvent): its uuid
 * without dashes. */
export function googleIdForLocalEvent(eventId: string): string {
  return eventId.replace(/-/g, "").toLowerCase()
}

/**
 * attachPendingCreates — an inbound Google event whose id is the uuid hex of a local row on the
 * same calendar that has no google_event_id yet is OUR create, committed on Google before its
 * push heard back. Attach it to that row (google_event_id set; a pending create becomes an
 * update) instead of importing a second copy. The caller's normal echo/LWW rules then decide
 * between Google's version and a local edit made since.
 */
async function attachPendingCreates(
  db: RlsClient,
  orgId: string,
  calendarId: string,
  googleIds: string[],
): Promise<void> {
  const uuids = googleIds
    .filter((id) => /^[0-9a-f]{32}$/.test(id))
    .map(
      (h) =>
        `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`,
    )
  if (uuids.length === 0) return
  const { sql } = await import("drizzle-orm")
  const schema = CALENDAR_SCHEMA()
  await db.execute(sql`
    UPDATE ${sql.raw(schema)}.events
    SET google_event_id = replace(id::text, '-', ''),
        pending_push = CASE WHEN pending_push = 'create' THEN 'update' ELSE pending_push END
    WHERE org_id = ${orgId}::uuid AND calendar_id = ${calendarId}::uuid
      AND google_event_id IS NULL
      AND id IN (${sql.join(
        uuids.map((u) => sql`${u}::uuid`),
        sql.raw(", "),
      )})
  `)
}

/**
 * gateInboundItems — the rules every import (full or incremental) applies before writing Google
 * items over local rows: an echo of our own last write (same etag) is skipped, and a local row
 * edited more recently than Google's change keeps its pending edit (Google wins ties). Items
 * with no local row are imported with `defaultCalaccess`.
 */
async function gateInboundItems(
  db: RlsClient,
  orgId: string,
  calendarId: string,
  items: GoogleEventItem[],
  defaultCalaccess: string,
): Promise<Array<{ calaccess: string; item: GoogleEventItem }>> {
  const existingById = await getEventsByGoogleIds(
    db,
    orgId,
    calendarId,
    items.map((item) => item.id),
  )
  const upserts: Array<{ calaccess: string; item: GoogleEventItem }> = []
  for (const item of items) {
    const existing = existingById.get(item.id)
    // A change Google refused (push_error, nothing pending) holds no edit to protect: Google's
    // version is the truth again, so Retry import or a reconnect resets it. Google never took
    // the edit, so its etag is usually the one we stored: this is decided before the echo check.
    const refusedOnly = Boolean(existing?.push_error) && existing?.pending_push === "none"
    if (!refusedOnly && existing?.etag && item.etag && existing.etag === item.etag) {
      // Echo of our own last-recorded write for this exact revision — skip. (A successful push
      // clears push_error, so real echoes still land here.)
      continue
    }
    if (existing && !refusedOnly) {
      const remoteUpdatedAt = item.updated ? new Date(item.updated).getTime() : 0
      const localUpdatedAt = new Date(existing.updated_at).getTime()
      if (remoteUpdatedAt < localUpdatedAt) {
        // Strictly older remote change — local edit wins, do not clobber.
        continue
      }
      // remoteUpdatedAt >= localUpdatedAt: Google wins (including the exact tie case).
    }
    upserts.push({ calaccess: existing?.calaccess ?? defaultCalaccess, item })
  }
  return upserts
}

/**
 * applyInitialSyncPages — Task 4.1 initial sync. Upserts every item across the paginated
 * pages (no echo/LWW gating — nothing local yet), then persists the FINAL page's
 * nextSyncToken (only the last page carries it; earlier pages carry nextPageToken).
 */
export async function applyInitialSyncPages(
  db: RlsClient,
  orgId: string,
  calendarId: string,
  calaccess: string,
  pages: SyncPage[],
): Promise<{ syncToken: string | null }> {
  let syncToken: string | null = null
  for (const page of pages) {
    await attachPendingCreates(
      db,
      orgId,
      calendarId,
      (page.items ?? []).map((item) => item.id),
    )
    // A full sync (first import, re-select, expired sync token) follows the same rules as the
    // incremental one: a pending local edit newer than Google's change is not overwritten.
    await upsertEventsFromGoogle(
      db,
      orgId,
      calendarId,
      await gateInboundItems(db, orgId, calendarId, page.items ?? [], calaccess),
    )
    // What the person's own calendar says about their away days (only their own primary).
    await applyAwayFromCalendar(db, orgId, calendarId, page.items ?? [])
    if (page.nextSyncToken) syncToken = page.nextSyncToken
  }
  // The sandbox streams pages one call at a time (accumulating a large calendar's pages in
  // QuickJS exhausts the sandbox memory cap); only the final page carries nextSyncToken, so a
  // null here means "not the final page yet" — never overwrite a stored token with null.
  if (syncToken !== null) {
    await setCalendarSyncToken(db, orgId, calendarId, syncToken)
    await markAccountActiveIfFullySynced(db, orgId, calendarId)
  }
  return { syncToken }
}

/** When the last selected calendar of an account receives its initial syncToken, flip the
 * account from 'syncing' to 'active' (the transition the UI's sync-status banner reads —
 * runCalendarImport sets 'syncing' and nothing else completed the lifecycle). */
async function markAccountActiveIfFullySynced(
  db: RlsClient,
  orgId: string,
  calendarId: string,
): Promise<void> {
  const { sql } = await import("drizzle-orm")
  const schema = CALENDAR_SCHEMA()
  await db.execute(sql`
    UPDATE ${sql.raw(schema)}.accounts a
    SET sync_status = 'active', updated_at = now()
    WHERE a.org_id = ${orgId}::uuid
      AND a.sync_status = 'syncing'
      AND a.id = (SELECT account_id FROM ${sql.raw(schema)}.calendars
                  WHERE org_id = ${orgId}::uuid AND id = ${calendarId}::uuid)
      AND NOT EXISTS (
        SELECT 1 FROM ${sql.raw(schema)}.calendars c
        WHERE c.org_id = ${orgId}::uuid AND c.account_id = a.id
          AND c.selected = true AND c.sync_token IS NULL
      )
  `)
}

/**
 * applyIncrementalSyncPages — Task 4.1 incremental sync. For each item: `status=cancelled` ->
 * delete the local row. Else: echo check FIRST (etag-based — an item is our own echo ONLY when
 * its etag matches the etag we currently have recorded for that row, i.e. it is the exact
 * revision our last push/sync wrote) -> skip. Otherwise LWW: apply when
 * `googleUpdatedAt >= local updatedAt` (Google wins ties). Persists the final page's
 * nextSyncToken EVEN WHEN there are zero items across all pages (do not early-return before
 * storing it) — this is what lets the "empty incremental still advances the token" case pass.
 */
export async function applyIncrementalSyncPages(
  db: RlsClient,
  orgId: string,
  calendarId: string,
  pages: SyncPage[],
): Promise<{ syncToken: string | null }> {
  // The calaccess value for any row on this calendar is the owning account's id — carried on the
  // calendars row's own `calaccess` column (set at import). A brand-new event arriving via
  // incremental sync (no existing local row) MUST inherit that same account-id calaccess, NOT the
  // calendarId, or the generated calendarAccess RLS (keyed on account-id grant values) would make
  // the row invisible to the owning user. Resolve it once from the calendar row.
  const calendar = await getCalendarById(db, orgId, calendarId)
  const calendarCalaccess = calendar?.calaccess ?? calendarId
  let syncToken: string | null = null
  for (const page of pages) {
    // Items apply in order, so for an event listed twice in one page the LAST entry decides
    // (as the old one-at-a-time loop left it): cancelled -> delete, else the upsert gates.
    const lastById = new Map<string, GoogleEventItem>()
    for (const item of page.items ?? []) {
      lastById.delete(item.id)
      lastById.set(item.id, item)
    }
    const items = [...lastById.values()]
    // Our own creates whose answer we never got come back as "new" events: attach them first, so
    // they are matched (and a cancellation of one deletes it) instead of imported twice.
    await attachPendingCreates(
      db,
      orgId,
      calendarId,
      items.map((item) => item.id),
    )
    const cancelled = items.filter((item) => item.status === "cancelled").map((item) => item.id)
    if (cancelled.length > 0) {
      const { sql } = await import("drizzle-orm")
      await db.execute(sql`
        DELETE FROM ${sql.raw(CALENDAR_SCHEMA())}.events
        WHERE org_id = ${orgId}::uuid AND calendar_id = ${calendarId}::uuid
          AND google_event_id IN (${sql.join(
            cancelled.map((id) => sql`${id}`),
            sql.raw(", "),
          )})
      `)
    }
    const live = items.filter((item) => item.status !== "cancelled")
    const upserts = await gateInboundItems(db, orgId, calendarId, live, calendarCalaccess)
    await upsertEventsFromGoogle(db, orgId, calendarId, upserts)
    // Cancelled and changed events alike: a cancelled one deletes its away row.
    await applyAwayFromCalendar(db, orgId, calendarId, [
      ...items.filter((item) => item.status === "cancelled"),
      ...upserts.map((u) => u.item),
    ])
    if (page.nextSyncToken) syncToken = page.nextSyncToken
  }
  // Same streaming rule as applyInitialSyncPages: pages arrive per call, only the final one
  // carries nextSyncToken — never null out the stored token on an intermediate page. The
  // "empty incremental still advances the token" case is unaffected (its single page DOES
  // carry a nextSyncToken).
  if (syncToken !== null) {
    await setCalendarSyncToken(db, orgId, calendarId, syncToken)
  }
  return { syncToken }
}

/**
 * recoverFromSyncTokenGone — Task 4.1 410 recovery. Deletes only the calendar's Google-born
 * events (`googleEventId IS NOT NULL AND pendingPush = 'none'`), preserving un-pushed
 * local-born rows and any row with a pending push (Design: "the wipe MUST exclude un-pushed
 * local-born rows ... and any row with pendingPush != 'none'"). Nulls the syncToken and
 * re-enqueues `calendar-initial-sync` exactly once. Keeps the watch channel (does not touch
 * watch_channel_id/watch_resource_id/watch_expiration — only stopCalendarWatch, used on
 * deselect, clears those).
 */
export async function recoverFromSyncTokenGone(
  db: RlsClient,
  orgId: string,
  calendarId: string,
  enqueueJob: (jobName: string, payload: Record<string, unknown>) => Promise<void>,
): Promise<void> {
  const { sql } = await import("drizzle-orm")
  const schema = CALENDAR_SCHEMA()
  await db.execute(sql`
    DELETE FROM ${sql.raw(schema)}.events
    WHERE org_id = ${orgId}::uuid AND calendar_id = ${calendarId}::uuid
      AND google_event_id IS NOT NULL AND pending_push = 'none'
  `)
  await setCalendarSyncToken(db, orgId, calendarId, null)
  await db.execute(sql`
    INSERT INTO ${sql.raw(schema)}.sync_log (id, org_id, calendar_id, operation, status, error_kind, detail, calaccess)
    SELECT gen_random_uuid(), ${orgId}::uuid, ${calendarId}::uuid, 'incremental-sync', 'error', 'SyncTokenGone',
           'sync token expired; wiped Google-born rows and re-enqueued initial sync', calaccess
    FROM ${sql.raw(schema)}.calendars WHERE id = ${calendarId}::uuid AND org_id = ${orgId}::uuid
  `)
  await enqueueJob("calendar-initial-sync", { orgId, calendarId })
}

// --- Outbound sync (Task 5): local mutation -> pendingPush -> push job, conflicts ---

export interface LocalEventInput {
  title?: string
  description?: string
  location?: string
  start?: unknown
  end?: unknown
  allDay?: boolean
  attendees?: unknown
  recurrence?: unknown
  /** Remote snapshots only (412 conflict): Google's organizer and guest permission. */
  organizer?: unknown
  guestsCanModify?: unknown
  /** Remote snapshots only (412 conflict): Google's video link, kept when its version wins. */
  hangoutLink?: string | null
  /** Local edits: "add" asks Google for a Meet, "remove" drops the event's conference;
   * undefined leaves the conference as it is. */
  conference?: "add" | "remove"
}

const EVENT_UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export async function getEventById(
  db: RlsClient,
  orgId: string,
  eventId: string,
): Promise<EventRow | undefined> {
  // `id` is the internal uuid; a lookup by internal id with a non-uuid value (e.g. a caller
  // passing a Google event id string) has no match by definition. Return not-found rather than
  // letting the `::uuid` cast below throw `invalid input syntax for type uuid` -- that surfaced
  // as an error-level "Failed query" log per calendar poll and tripped the watchdog.
  if (!EVENT_UUID_RE.test(eventId)) return undefined
  const { sql } = await import("drizzle-orm")
  const schema = CALENDAR_SCHEMA()
  const rows = (await db.execute(sql`
    SELECT id, calendar_id, google_event_id, etag, title, description, location, start, "end",
           all_day, status, attendees, recurrence, recurring_event_id, original_start_time,
           extended_props, hangout_link, liaison_sync_version, pending_push, updated_at, google_updated_at, calaccess,
           attendees_base, organizer_self, guests_can_modify, push_error, deleted_at,
           pending_before_delete, push_notice, conference_request
    FROM ${sql.raw(schema)}.events
    WHERE org_id = ${orgId}::uuid AND id = ${eventId}::uuid
    LIMIT 1
  `)) as unknown as { rows?: EventRow[] } | EventRow[]
  const list = Array.isArray(rows) ? rows : (rows.rows ?? [])
  return list[0]
}

/**
 * createLocalEvent — writes a local-born event row (googleEventId NULL), pendingPush='create',
 * liaisonSyncVersion=1. Caller (bridge method) enqueues `calendar-push` after this returns.
 */
export async function createLocalEvent(
  db: RlsClient,
  orgId: string,
  calendarId: string,
  calaccess: string,
  input: LocalEventInput,
): Promise<{ eventId: string }> {
  const { sql } = await import("drizzle-orm")
  const schema = CALENDAR_SCHEMA()
  const rows = (await db.execute(sql`
    INSERT INTO ${sql.raw(schema)}.events
      (id, org_id, calendar_id, title, description, location, start, "end", all_day, attendees,
       recurrence, liaison_sync_version, pending_push, calaccess, conference_request)
    VALUES
      (gen_random_uuid(), ${orgId}::uuid, ${calendarId}::uuid, ${input.title ?? null}, ${input.description ?? null},
       ${input.location ?? null}, ${JSON.stringify(input.start ?? null)}::jsonb, ${JSON.stringify(input.end ?? null)}::jsonb,
       ${input.allDay ?? false}, ${JSON.stringify(
         input.attendees !== undefined ? normalizeAttendees(input.attendees, null) : null,
       )}::jsonb,
       ${JSON.stringify(input.recurrence ?? null)}::jsonb, 1, 'create', ${calaccess},
       ${input.conference === "add" ? "add" : null})
    RETURNING id
  `)) as unknown as { rows?: Array<{ id: string }> } | Array<{ id: string }>
  const list = Array.isArray(rows) ? rows : (rows.rows ?? [])
  const id = list[0]?.id
  if (!id) throw new Error("calendar events insert returned no id")
  return { eventId: id }
}

// --- Which row an update changes: recurring meetings (series vs one occurrence) ---

export type UpdateScope = "occurrence" | "series"

export interface UpdateTargetParams {
  /** A local event uuid, or a Google event id (list_events returns a recurring master by it). */
  eventId: string
  /** Disambiguates a Google event id present on more than one calendar. */
  calendarId?: string
  scope?: UpdateScope
  /** The ORIGINAL start (ISO) of the occurrence to change, for scope "occurrence" on a series. */
  occurrenceStart?: string
  /** The edit sets a recurrence rule (only a series has one). */
  changesRecurrence?: boolean
  /** The tool asking, named in the messages (default update_event). */
  tool?: "update_event" | "delete_event"
}

function invalidParams(message: string): Error {
  // Typed 4xx: an agent-correctable request, logged at warn (see resolvePrimaryCalendar).
  return Object.assign(new Error(message), { status: 422, code: "invalid_params" })
}

function isRecurringMaster(row: EventRow): boolean {
  return (
    row.recurring_event_id === null && Array.isArray(row.recurrence) && row.recurrence.length > 0
  )
}

/** Google's id for one instance of a recurring event: `<master>_<YYYYMMDDTHHMMSSZ>` for a timed
 * series (the original start in UTC), `<master>_<YYYYMMDD>` for an all-day one. */
export function googleInstanceId(
  masterGoogleId: string,
  originalStart: Date,
  allDay: boolean,
): string {
  const iso = originalStart.toISOString() // YYYY-MM-DDTHH:MM:SS.sssZ
  const day = iso.slice(0, 10).replace(/-/g, "")
  if (allDay) return `${masterGoogleId}_${day}`
  return `${masterGoogleId}_${day}T${iso.slice(11, 19).replace(/:/g, "")}Z`
}

async function findEventForUpdate(
  db: RlsClient,
  orgId: string,
  eventId: string,
  calendarId: string | undefined,
): Promise<EventRow | undefined> {
  if (EVENT_UUID_RE.test(eventId)) {
    const row = await getEventById(db, orgId, eventId)
    if (row) return row
  }
  const { sql } = await import("drizzle-orm")
  const schema = CALENDAR_SCHEMA()
  const calendarFilter = calendarId ? sql`AND calendar_id = ${calendarId}::uuid` : sql``
  const rows = (await db.execute(sql`
    SELECT id FROM ${sql.raw(schema)}.events
    WHERE org_id = ${orgId}::uuid AND google_event_id = ${eventId} AND deleted_at IS NULL
      ${calendarFilter}
    LIMIT 2
  `)) as unknown as { rows?: Array<{ id: string }> } | Array<{ id: string }>
  const list = Array.isArray(rows) ? rows : (rows.rows ?? [])
  if (list.length > 1) {
    throw invalidParams(
      `Event "${eventId}" is on more than one calendar: pass calendarId (from list_events) to say which.`,
    )
  }
  return list[0] ? getEventById(db, orgId, list[0].id) : undefined
}

/**
 * resolveUpdateTarget — the row an update_event call changes. A plain event is itself. An event
 * that belongs to a recurring meeting needs an explicit scope, since "move the meeting" may mean
 * one occurrence or every one: without it the call is refused with a message telling the agent
 * to ask the user. "series" edits the master row; "occurrence" edits one instance: an exception
 * row when the occurrence was already edited, else a new row for Google's instance (its Google
 * id is derived from the master's, so the push updates that instance and nothing else).
 */
export async function resolveUpdateTarget(
  db: RlsClient,
  orgId: string,
  params: UpdateTargetParams,
): Promise<{ eventId: string; scope: UpdateScope | null }> {
  const row = await findEventForUpdate(db, orgId, params.eventId, params.calendarId)
  if (!row || row.deleted_at) {
    throw Object.assign(new Error(`calendar event ${params.eventId} not found`), {
      status: 404,
      code: "not_found",
    })
  }
  const isException = row.recurring_event_id !== null
  if (!isException && !isRecurringMaster(row)) return { eventId: row.id, scope: null }

  const title = row.title ? `"${row.title}"` : "This event"
  const tool = params.tool ?? "update_event"
  const verb = tool === "delete_event" ? "delete" : "change"
  if (params.scope !== "occurrence" && params.scope !== "series") {
    const which = isException
      ? `${title} is one occurrence of a recurring meeting.`
      : `${title} is a recurring meeting.`
    throw invalidParams(
      `${which} Ask the user whether to ${verb} only this occurrence or the whole series, then call ${tool} again with scope: "occurrence" (plus occurrenceStart, the original start of that occurrence as listed) or scope: "series".`,
    )
  }
  if (params.scope === "occurrence" && params.changesRecurrence) {
    throw invalidParams(
      `A single occurrence has no repeat rule: to change how the meeting repeats, use scope: "series".`,
    )
  }

  if (isException) {
    if (params.scope === "occurrence") return { eventId: row.id, scope: "occurrence" }
    const master = await getEventByGoogleId(db, orgId, row.calendar_id, row.recurring_event_id!)
    if (!master) {
      throw invalidParams(
        `The series of ${title} is not on this calendar here, so it cannot be changed as a whole; change this occurrence with scope: "occurrence".`,
      )
    }
    return { eventId: master.id, scope: "series" }
  }

  // A recurring master.
  if (params.scope === "series") return { eventId: row.id, scope: "series" }
  if (!params.occurrenceStart) {
    throw invalidParams(
      `scope: "occurrence" on a recurring meeting needs occurrenceStart: the original start (ISO date-time, or date for an all-day series) of the occurrence to change.`,
    )
  }
  const occurrence = new Date(params.occurrenceStart)
  if (Number.isNaN(occurrence.getTime())) {
    throw invalidParams(`occurrenceStart "${params.occurrenceStart}" is not a date.`)
  }
  if (!row.google_event_id) {
    throw invalidParams(
      `${title} has not reached Google yet; its occurrences can be changed once it has (try again in a minute).`,
    )
  }
  const instanceId = googleInstanceId(row.google_event_id, occurrence, row.all_day)
  const { sql } = await import("drizzle-orm")
  const schema = CALENDAR_SCHEMA()
  const existingRows = (await db.execute(sql`
    SELECT id, status, deleted_at FROM ${sql.raw(schema)}.events
    WHERE org_id = ${orgId}::uuid AND calendar_id = ${row.calendar_id}::uuid
      AND google_event_id = ${instanceId}
    LIMIT 1
  `)) as unknown as
    | { rows?: Array<{ id: string; status: string; deleted_at: unknown }> }
    | Array<{ id: string; status: string; deleted_at: unknown }>
  const existing = (Array.isArray(existingRows) ? existingRows : (existingRows.rows ?? []))[0]
  if (existing) {
    if (existing.deleted_at || existing.status === "cancelled") {
      throw invalidParams(
        `The occurrence of ${title} starting ${params.occurrenceStart} was cancelled; there is nothing to change.`,
      )
    }
    return { eventId: existing.id, scope: "occurrence" }
  }

  // Check the series really has an occurrence there (a simple rule can be expanded; a complex
  // one is left to Google, which refuses an instance that does not exist).
  const { expandRecurringEvent } = await import("~/apps/calendar/tools")
  const probe = expandRecurringEvent(
    row as unknown as Parameters<typeof expandRecurringEvent>[0],
    [],
    occurrence,
    new Date(occurrence.getTime() + 1),
  )
  const complex = probe.some((o) => o.recurrenceComplex)
  const matches = probe.some((o) => {
    const p = o.start as { date?: string; dateTime?: string } | null
    const at = p?.dateTime ? new Date(p.dateTime) : p?.date ? new Date(`${p.date}T00:00:00Z`) : null
    return at !== null && at.getTime() === occurrence.getTime()
  })
  if (!complex && !matches) {
    throw invalidParams(
      `${title} has no occurrence starting ${params.occurrenceStart}. Pass the original start of one of its occurrences (list_events shows the series' first start and its repeat rule).`,
    )
  }

  const masterStart = row.start as { date?: string; dateTime?: string; timeZone?: string } | null
  const masterEnd = row.end as { date?: string; dateTime?: string; timeZone?: string } | null
  const startMs = masterStart?.dateTime
    ? new Date(masterStart.dateTime).getTime()
    : new Date(`${masterStart?.date}T00:00:00Z`).getTime()
  const endMs = masterEnd?.dateTime
    ? new Date(masterEnd.dateTime).getTime()
    : new Date(`${masterEnd?.date}T00:00:00Z`).getTime()
  const durationMs = Number.isFinite(endMs - startMs) ? endMs - startMs : 0
  const point = (at: Date, template: typeof masterStart) =>
    row.all_day
      ? { date: at.toISOString().slice(0, 10) }
      : {
          dateTime: at.toISOString(),
          ...(template?.timeZone ? { timeZone: template.timeZone } : {}),
        }
  const start = point(occurrence, masterStart)
  const end = point(new Date(occurrence.getTime() + durationMs), masterEnd)
  // Google's instance as it stands (the series' fields at that time). pending_push stays 'none'
  // here: the edit that follows bumps the version and queues the push.
  const inserted = (await db.execute(sql`
    INSERT INTO ${sql.raw(schema)}.events
      (id, org_id, calendar_id, google_event_id, title, description, location, start, "end",
       all_day, status, attendees, recurrence, recurring_event_id, original_start_time,
       hangout_link, organizer_self, guests_can_modify, liaison_sync_version, pending_push,
       calaccess)
    VALUES
      (gen_random_uuid(), ${orgId}::uuid, ${row.calendar_id}::uuid, ${instanceId}, ${row.title},
       ${row.description}, ${row.location}, ${JSON.stringify(start)}::jsonb,
       ${JSON.stringify(end)}::jsonb, ${row.all_day}, 'confirmed',
       ${JSON.stringify(row.attendees ?? null)}::jsonb, NULL, ${row.google_event_id},
       ${JSON.stringify(start)}::jsonb, ${row.hangout_link}, ${row.organizer_self ?? null}::boolean,
       ${row.guests_can_modify ?? null}::boolean, 0, 'none', ${row.calaccess})
    RETURNING id
  `)) as unknown as { rows?: Array<{ id: string }> } | Array<{ id: string }>
  const id = (Array.isArray(inserted) ? inserted : (inserted.rows ?? []))[0]?.id
  if (!id) throw new Error("calendar occurrence insert returned no id")
  return { eventId: id, scope: "occurrence" }
}

/**
 * updateLocalEvent — applies a local edit: bumps liaisonSyncVersion, sets pendingPush='update'
 * (unless it's still an un-pushed local-born create, in which case pendingPush stays 'create').
 */
/**
 * normalizeAttendees — the stored attendee list for a write. Callers (the update/create tools,
 * the edit dialog) name attendees by email; a kept attendee keeps its stored object (Google's
 * responseStatus, displayName, organizer, self, optional, comment...), a new one becomes
 * `{ email }`. Never stores bare strings: Google expects objects.
 */
export function normalizeAttendees(
  next: unknown,
  existing: unknown,
): Array<Record<string, unknown>> {
  const stored = Array.isArray(existing) ? (existing as unknown[]) : []
  const byEmail = new Map<string, Record<string, unknown>>()
  for (const a of stored) {
    if (a && typeof a === "object" && typeof (a as { email?: unknown }).email === "string") {
      byEmail.set((a as { email: string }).email.toLowerCase(), a as Record<string, unknown>)
    }
  }
  const out: Array<Record<string, unknown>> = []
  const seen = new Set<string>()
  for (const item of Array.isArray(next) ? next : []) {
    const given =
      typeof item === "string"
        ? { email: item.trim() }
        : item && typeof item === "object"
          ? (item as Record<string, unknown>)
          : null
    if (!given || typeof given.email !== "string" || !given.email) continue
    const key = given.email.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    const kept = byEmail.get(key)
    out.push(
      kept ? { ...kept, ...(typeof item === "string" ? {} : given), email: kept.email } : given,
    )
  }
  return out
}

export async function updateLocalEvent(
  db: RlsClient,
  orgId: string,
  eventId: string,
  input: LocalEventInput,
): Promise<{ syncVersion: number }> {
  const { sql } = await import("drizzle-orm")
  const schema = CALENDAR_SCHEMA()
  const existing = await getEventById(db, orgId, eventId)
  if (!existing || existing.deleted_at) throw new Error(`calendar event ${eventId} not found`)
  const nextPendingPush = existing.pending_push === "create" ? "create" : "update"

  // If the caller flips all_day but does NOT supply a new start/end, the stored point is still in
  // the old {date}/{dateTime} shape and would disagree with the new flag — Google would 400 on the
  // subsequent PUT (start.date vs a timed all_day=false, or vice versa). Convert the existing
  // point's shape to match the new flag so the row is internally consistent.
  const nextAllDay = input.allDay ?? existing.all_day
  const allDayChanged = input.allDay !== undefined && input.allDay !== existing.all_day
  let start = input.start ?? null
  let end = input.end ?? null
  if (allDayChanged && !input.start) start = convertPointShape(existing.start, nextAllDay)
  if (allDayChanged && !input.end) end = convertPointShape(existing.end, nextAllDay)

  const rows = (await db.execute(sql`
    UPDATE ${sql.raw(schema)}.events SET
      title = COALESCE(${input.title ?? null}, title),
      description = COALESCE(${input.description ?? null}, description),
      location = COALESCE(${input.location ?? null}, location),
      start = COALESCE(${start ? JSON.stringify(start) : null}::jsonb, start),
      "end" = COALESCE(${end ? JSON.stringify(end) : null}::jsonb, "end"),
      all_day = COALESCE(${input.allDay ?? null}, all_day),
      attendees = COALESCE(${
        input.attendees !== undefined
          ? JSON.stringify(normalizeAttendees(input.attendees, existing.attendees))
          : null
      }::jsonb, attendees),
      recurrence = COALESCE(${input.recurrence !== undefined ? JSON.stringify(input.recurrence) : null}::jsonb, recurrence),
      -- First local attendee edit since the last sync: remember the list it started from, so the
      -- push applies only this edit's adds/removes to Google's current list (3-way merge).
      attendees_base = CASE
        WHEN ${input.attendees !== undefined}::boolean AND attendees_base IS NULL
          THEN COALESCE(attendees, '[]'::jsonb)
        ELSE attendees_base
      END,
      conference_request = COALESCE(${input.conference ?? null}, conference_request),
      liaison_sync_version = liaison_sync_version + 1,
      pending_push = ${nextPendingPush},
      push_error = NULL, push_notice = NULL, push_attempts = 0, last_push_attempt_at = NULL,
      first_push_failure_at = NULL,
      updated_at = now()
    WHERE org_id = ${orgId}::uuid AND id = ${eventId}::uuid
    RETURNING liaison_sync_version
  `)) as unknown as
    | { rows?: Array<{ liaison_sync_version: number }> }
    | Array<{ liaison_sync_version: number }>
  const list = Array.isArray(rows) ? rows : (rows.rows ?? [])
  return { syncVersion: Number(list[0]?.liaison_sync_version ?? existing.liaison_sync_version + 1) }
}

/**
 * convertPointShape — reshape a stored calendar point ({date} <-> {dateTime}) to match a target
 * all_day flag, so a pure all-day<->timed toggle that omits new start/end still leaves a body
 * Google accepts. all_day=true wants {date: 'YYYY-MM-DD'}; all_day=false wants {dateTime}.
 */
function convertPointShape(
  point: unknown,
  allDay: boolean,
): { date?: string; dateTime?: string; timeZone?: string } | null {
  const p = (point ?? null) as { date?: string; dateTime?: string; timeZone?: string } | null
  if (!p) return null
  if (allDay) {
    const iso = p.dateTime ?? (p.date ? `${p.date}T00:00:00Z` : undefined)
    if (!iso) return p
    return { date: new Date(iso).toISOString().slice(0, 10) }
  }
  // timed: promote a {date} to a start-of-day {dateTime}; keep an existing dateTime.
  if (p.dateTime) return p
  const dateTime = p.date ? `${p.date}T00:00:00.000Z` : undefined
  return dateTime ? { dateTime } : p
}

/**
 * deleteLocalEvent — a local delete. An event with no presence on Google (never pushed, and no
 * create in flight) is simply removed. Otherwise the row becomes a TOMBSTONE until Google
 * confirms the delete: hidden from every read and edit, pending_push = 'delete', and kept so
 * the import cannot bring the event back meanwhile. A create never acknowledged is deleted on
 * Google by its deterministic id (404 there is fine). The caller enqueues the push.
 */
export async function deleteLocalEvent(
  db: RlsClient,
  orgId: string,
  eventId: string,
): Promise<{ needsGooglePush: boolean; googleEventId: string | null; syncVersion: number | null }> {
  const existing = await getEventById(db, orgId, eventId)
  if (!existing || existing.deleted_at) {
    return { needsGooglePush: false, googleEventId: null, syncVersion: null }
  }
  const googleEventId =
    existing.google_event_id ??
    (existing.pending_push === "create" ? googleIdForLocalEvent(existing.id) : null)
  const { sql } = await import("drizzle-orm")
  const schema = CALENDAR_SCHEMA()
  if (googleEventId === null) {
    await db.execute(sql`
      DELETE FROM ${sql.raw(schema)}.events WHERE org_id = ${orgId}::uuid AND id = ${eventId}::uuid
    `)
    return { needsGooglePush: false, googleEventId: null, syncVersion: null }
  }
  const rows = (await db.execute(sql`
    UPDATE ${sql.raw(schema)}.events SET
      deleted_at = now(), pending_push = 'delete', google_event_id = ${googleEventId},
      pending_before_delete = CASE WHEN pending_push IN ('create', 'update') THEN pending_push END,
      liaison_sync_version = liaison_sync_version + 1, updated_at = now(),
      push_error = NULL, push_attempts = 0, last_push_attempt_at = NULL, first_push_failure_at = NULL
    WHERE org_id = ${orgId}::uuid AND id = ${eventId}::uuid
    RETURNING liaison_sync_version
  `)) as unknown as
    | { rows?: Array<{ liaison_sync_version: number }> }
    | Array<{ liaison_sync_version: number }>
  const list = Array.isArray(rows) ? rows : (rows.rows ?? [])
  return {
    needsGooglePush: true,
    googleEventId,
    syncVersion: Number(list[0]?.liaison_sync_version ?? existing.liaison_sync_version + 1),
  }
}

/**
 * restoreRefusedDelete — Google will not delete the event (a refusal, or 24 hours of failures):
 * it comes back with the reason in push_error. Its values are refreshed from Google's current
 * version (`remote`, fetched by the caller; changes made on Google while it was tombstoned were
 * skipped by the import), unless the delete had superseded a local edit not yet on Google:
 * that edit is restored and pending again, never silently dropped. A remote copy Google reports
 * as cancelled means it is gone after all: the tombstone goes. Returns whether an edit is
 * pending again (the caller queues its push).
 */
export async function restoreRefusedDelete(
  db: RlsClient,
  orgId: string,
  eventId: string,
  message: string,
  syncVersion: number,
  remote: GoogleEventItem | null,
): Promise<{ pendingRestored: boolean }> {
  const existing = await getEventById(db, orgId, eventId)
  if (!existing?.deleted_at || existing.liaison_sync_version !== syncVersion) {
    return { pendingRestored: false }
  }
  if (remote?.status === "cancelled") {
    await finalizeRemoteDelete(db, orgId, eventId)
    return { pendingRestored: false }
  }
  // A calendar switched off since the delete keeps no local events: drop the row rather than
  // bring an event back into a calendar the user no longer shows.
  const calendar = await getCalendarById(db, orgId, existing.calendar_id)
  if (!calendar?.selected) {
    await finalizeRemoteDelete(db, orgId, eventId)
    return { pendingRestored: false }
  }
  const pendingRestored =
    existing.pending_before_delete === "create" || existing.pending_before_delete === "update"
  const { sql } = await import("drizzle-orm")
  const schema = CALENDAR_SCHEMA()
  await db.execute(sql`
    UPDATE ${sql.raw(schema)}.events SET
      deleted_at = NULL, pending_before_delete = NULL,
      pending_push = ${pendingRestored ? "update" : "none"},
      push_attempts = 0, last_push_attempt_at = NULL, first_push_failure_at = NULL
    WHERE org_id = ${orgId}::uuid AND id = ${eventId}::uuid
  `)
  if (remote && !pendingRestored && existing.google_event_id) {
    await upsertEventsFromGoogle(db, orgId, existing.calendar_id, [
      { calaccess: existing.calaccess, item: { ...remote, id: existing.google_event_id } },
    ])
  }
  // The reason is a notice, not push_error: a restored edit stays an ordinary pending push
  // (swept, given up after 24 hours like any other); the notice clears when a push succeeds
  // or the user edits the event again.
  await db.execute(sql`
    UPDATE ${sql.raw(schema)}.events SET push_notice = ${message.slice(0, 500)}
    WHERE org_id = ${orgId}::uuid AND id = ${eventId}::uuid
  `)
  return { pendingRestored }
}

/** finalizeRemoteDelete — Google confirmed the delete (or already had none): the tombstone goes. */
export async function finalizeRemoteDelete(
  db: RlsClient,
  orgId: string,
  eventId: string,
): Promise<void> {
  const { sql } = await import("drizzle-orm")
  const schema = CALENDAR_SCHEMA()
  // A deleted occurrence of a recurring meeting stays as a cancelled exception, as Google keeps
  // it: removing the row would bring the occurrence back in the series' expansion.
  await db.execute(sql`
    UPDATE ${sql.raw(schema)}.events SET
      status = 'cancelled', deleted_at = NULL, pending_push = 'none',
      pending_before_delete = NULL, push_error = NULL, push_notice = NULL
    WHERE org_id = ${orgId}::uuid AND id = ${eventId}::uuid AND deleted_at IS NOT NULL
      AND recurring_event_id IS NOT NULL
  `)
  await db.execute(sql`
    DELETE FROM ${sql.raw(schema)}.events
    WHERE org_id = ${orgId}::uuid AND id = ${eventId}::uuid AND deleted_at IS NOT NULL
  `)
}

export interface PushResult {
  googleEventId: string
  etag: string
  googleUpdatedAt: string
  /** Google's response resource (what it actually stored); refreshes attendees and flags. */
  remote?: Omit<GoogleEventItem, "id">
  /** The event's video link as Google answered it (null: it has none). Undefined leaves the
   * stored link untouched. */
  hangoutLink?: string | null
  /** The liaison_sync_version the push read its payload from. When the row has moved on (a
   * local edit landed while the push was in flight), only Google's identifiers are stored:
   * the row stays pending, with its attendee base, so the queued push sends the newer edit. */
  syncVersion?: number
}

/**
 * applyPushResult — after a successful Google write (insert/update), store the returned
 * googleEventId + etag + googleUpdatedAt and clear pendingPush. The recorded etag is what the
 * inbound incremental sync's echo check matches against (Amendment 2 — etag-based suppression).
 */
export async function applyPushResult(
  db: RlsClient,
  orgId: string,
  eventId: string,
  result: PushResult,
): Promise<{ rowExists: boolean }> {
  const { sql } = await import("drizzle-orm")
  const schema = CALENDAR_SCHEMA()
  const current = await getEventById(db, orgId, eventId)
  // Deleted locally while the push was in flight: the caller deletes the event on Google.
  if (!current) return { rowExists: false }
  // Another row already holds this Google id: a copy the import made of our own create before
  // this push heard back (the import now attaches instead, but such copies may exist). This row
  // is the user's: the copy goes, so the unique (calendar, google id) index cannot fail the
  // push forever. A local delete never reaches Google, so the event itself stays.
  await db.execute(sql`
    DELETE FROM ${sql.raw(schema)}.events
    WHERE org_id = ${orgId}::uuid AND calendar_id = ${current.calendar_id}::uuid
      AND google_event_id = ${result.googleEventId} AND id <> ${eventId}::uuid
  `)
  // Anchor updated_at to Google's clock (not wall-clock-of-edit) so inbound LWW compares
  // apples-to-apples: a fast follow-on foreign edit whose Google "updated" is marginally later than
  // our local edit time is not wrongly skipped as older. Matches upsertEventFromGoogle's convention.
  // Google's response is what it really stored: a non-organizer's attendee change can be
  // ignored, so the guest list (and who organizes / may modify) is refreshed from it. The
  // local attendee edit has now reached Google: its base is cleared.
  const remote = result.remote ?? null
  const remoteMapped = remote ? mapGoogleItemToRow({ id: result.googleEventId, ...remote }) : null
  if (result.syncVersion !== undefined) {
    const rows = (await db.execute(sql`
      UPDATE ${sql.raw(schema)}.events SET
        google_event_id = ${result.googleEventId}, etag = ${result.etag},
        google_updated_at = ${result.googleUpdatedAt},
        -- The event now exists on Google: a queued follow-up must update it, not create it again.
        pending_push = CASE WHEN pending_push = 'create' THEN 'update' ELSE pending_push END
      WHERE org_id = ${orgId}::uuid AND id = ${eventId}::uuid
        AND liaison_sync_version <> ${result.syncVersion}
      RETURNING id
    `)) as unknown as { rows?: unknown[] } | unknown[]
    const moved = Array.isArray(rows) ? rows : (rows.rows ?? [])
    if (moved.length > 0) return { rowExists: true }
  }
  await db.execute(sql`
    UPDATE ${sql.raw(schema)}.events SET
      google_event_id = ${result.googleEventId}, etag = ${result.etag},
      google_updated_at = ${result.googleUpdatedAt}, pending_push = 'none',
      updated_at = COALESCE(${result.googleUpdatedAt}::timestamptz, now()),
      attendees_base = NULL, push_error = NULL, push_notice = NULL, push_attempts = 0,
      last_push_attempt_at = NULL, first_push_failure_at = NULL, conference_request = NULL,
      hangout_link = CASE WHEN ${result.hangoutLink !== undefined}::boolean
        THEN ${result.hangoutLink ?? null} ELSE hangout_link END,
      attendees = CASE WHEN ${remoteMapped !== null}::boolean
        THEN ${JSON.stringify(remoteMapped?.attendees ?? null)}::jsonb ELSE attendees END,
      organizer_self = CASE WHEN ${remoteMapped !== null}::boolean
        THEN ${remoteMapped?.organizerSelf ?? null}::boolean ELSE organizer_self END,
      guests_can_modify = CASE WHEN ${remoteMapped !== null}::boolean
        THEN ${remoteMapped?.guestsCanModify ?? null}::boolean ELSE guests_can_modify END
    WHERE org_id = ${orgId}::uuid AND id = ${eventId}::uuid${await versionGuard(result.syncVersion)}
  `)
  return { rowExists: true }
}

/**
 * revertEventToGoogle — Google refused the write (403: not the organizer, or no write access):
 * the local row takes Google's current version (attendees, recurrence and all), the pending push
 * is dropped, and the refusal is logged on the calendar's sync_log. Leaving it pending would
 * retry a write Google will never accept and show a state Google does not have.
 */
export async function revertEventToGoogle(
  db: RlsClient,
  orgId: string,
  eventId: string,
  remote: GoogleEventItem,
  detail: string,
  syncVersion?: number,
): Promise<void> {
  const existing = await getEventById(db, orgId, eventId)
  if (!existing?.google_event_id) return
  // Edited since the push read it: the newer edit is pushed (and judged) on its own.
  if (syncVersion !== undefined && existing.liaison_sync_version !== syncVersion) return
  await upsertEventsFromGoogle(db, orgId, existing.calendar_id, [
    { calaccess: existing.calaccess, item: { ...remote, id: existing.google_event_id } },
  ])
  await recordPushFailure(db, orgId, eventId, existing.calendar_id, "Forbidden", detail)
}

export interface PushConflictInput {
  remoteEtag: string
  remoteUpdated: string
  remoteSnapshot: LocalEventInput
  /** The liaisonSyncVersion this in-flight push captured its payload from, BEFORE re-fetching
   * the local row here. If the row's CURRENT version has advanced past this, a concurrent local
   * edit landed while the push was in flight — abort rather than re-push the stale payload. */
  capturedSyncVersion?: number
}

export type PushConflictOutcome = "remote-won" | "retry" | "abort-stale"

/**
 * handlePushConflict — Task 5.1 412 EtagMismatch handling (single LWW tie-break, Google wins
 * ties, matching inbound Task 4): if `remoteUpdated >= local.updatedAt` -> remote wins (apply
 * remote snapshot locally, clear pendingPush). Else: re-read the local row first — if its
 * liaisonSyncVersion advanced since this push captured its payload (capturedSyncVersion), a
 * concurrent edit landed mid-flight -> abort this push, leave pendingPush set so the re-enqueued
 * push carries the NEWEST payload. Otherwise -> retry (leave pendingPush set for a re-push with
 * the fresh etag; the caller is responsible for bounding attempts to 3 and calling
 * recordPushFailure on exhaustion).
 */
export async function handlePushConflict(
  db: RlsClient,
  orgId: string,
  eventId: string,
  input: PushConflictInput,
): Promise<{ outcome: PushConflictOutcome }> {
  const existing = await getEventById(db, orgId, eventId)
  if (!existing) throw new Error(`calendar event ${eventId} not found`)

  const remoteUpdatedAt = new Date(input.remoteUpdated).getTime()
  const localUpdatedAt = new Date(existing.updated_at).getTime()
  if (remoteUpdatedAt >= localUpdatedAt) {
    if (!existing.google_event_id) {
      // A 412 can only occur on an update to an already-pushed event, so google_event_id must be
      // present here. A null means our invariant was violated — fail loudly rather than upserting a
      // row with an empty-string google_event_id that would corrupt the (calendarId, googleEventId)
      // uniqueness semantics.
      throw new Error(
        `calendar handlePushConflict: event ${eventId} has no google_event_id in remote-won branch`,
      )
    }
    await upsertEventsFromGoogle(db, orgId, existing.calendar_id, [
      {
        calaccess: existing.calaccess,
        item: {
          id: existing.google_event_id,
          status: "confirmed",
          etag: input.remoteEtag,
          updated: input.remoteUpdated,
          summary: input.remoteSnapshot.title,
          description: input.remoteSnapshot.description,
          location: input.remoteSnapshot.location,
          start: input.remoteSnapshot.start as { date?: string; dateTime?: string } | undefined,
          end: input.remoteSnapshot.end as { date?: string; dateTime?: string } | undefined,
          // Google's version is applied whole: its guests and recurrence too, never nulled.
          attendees: input.remoteSnapshot.attendees as GoogleEventItem["attendees"],
          recurrence: input.remoteSnapshot.recurrence as string[] | undefined,
          organizer: input.remoteSnapshot.organizer as GoogleEventItem["organizer"],
          guestsCanModify: input.remoteSnapshot.guestsCanModify as boolean | undefined,
          hangoutLink: input.remoteSnapshot.hangoutLink ?? undefined,
        },
      },
    ])
    return { outcome: "remote-won" }
  }

  if (
    input.capturedSyncVersion !== undefined &&
    existing.liaison_sync_version > input.capturedSyncVersion
  ) {
    // Concurrent local edit landed while this push was in flight — do not re-push the stale
    // captured payload; leave pendingPush set so the newest edit is what gets (re-)pushed.
    return { outcome: "abort-stale" }
  }

  // Older remote, no concurrent edit — safe to retry with the fresh etag.
  return { outcome: "retry" }
}

/**
 * recordPushFailure — retry exhaustion / revoked-token path: leaves pendingPush set (never
 * silently drops the mutation) and logs a SANITIZED sync_log entry (operation + errorKind +
 * a short, secret-free detail string — never the raw upstream body, token, or event content).
 */
export async function recordPushFailure(
  db: RlsClient,
  orgId: string,
  eventId: string,
  calendarId: string,
  errorKind: string,
  detail: string,
): Promise<void> {
  const { sql } = await import("drizzle-orm")
  const schema = CALENDAR_SCHEMA()
  await db.execute(sql`
    INSERT INTO ${sql.raw(schema)}.sync_log (id, org_id, calendar_id, operation, status, error_kind, detail, calaccess)
    SELECT gen_random_uuid(), ${orgId}::uuid, ${calendarId}::uuid, 'push', 'error', ${errorKind}, ${detail}, calaccess
    FROM ${sql.raw(schema)}.calendars WHERE id = ${calendarId}::uuid AND org_id = ${orgId}::uuid
  `)
  if (errorKind === "AuthRevoked") {
    await db.execute(sql`
      UPDATE ${sql.raw(schema)}.accounts SET sync_status = 'reauth-required'
      WHERE org_id = ${orgId}::uuid AND id = (
        SELECT account_id FROM ${sql.raw(schema)}.calendars WHERE id = ${calendarId}::uuid AND org_id = ${orgId}::uuid
      )
    `)
  }
  void eventId // pendingPush is left as-is by design — this function only logs + flags the account.
}

// --- Watch channels, webhook binding, renewal + polling fallback (Task 6) ---

export interface WatchChannelInfo {
  channelId: string
  resourceId: string
  expiration: string
}

/** recordWatchChannel — persists channelId/resourceId/expiration from the events.watch RESPONSE
 * body (Google decides the TTL; never hardcode it). */
export async function recordWatchChannel(
  db: RlsClient,
  orgId: string,
  calendarId: string,
  info: WatchChannelInfo,
): Promise<void> {
  const { sql } = await import("drizzle-orm")
  const schema = CALENDAR_SCHEMA()
  await db.execute(sql`
    UPDATE ${sql.raw(schema)}.calendars
    SET watch_channel_id = ${info.channelId}, watch_resource_id = ${info.resourceId},
        watch_expiration = ${info.expiration}
    WHERE org_id = ${orgId}::uuid AND id = ${calendarId}::uuid
  `)
}

/** findCalendarByChannelId — binds an incoming notification to a calendar by
 * X-Goog-Channel-ID/X-Goog-Resource-ID. Unknown pair -> undefined (caller drops with 200,
 * no enumeration signal). */
export async function findCalendarByChannelId(
  db: RlsClient,
  orgId: string,
  channelId: string,
  resourceId: string,
): Promise<CalendarRow | undefined> {
  const { sql } = await import("drizzle-orm")
  const schema = CALENDAR_SCHEMA()
  const rows = (await db.execute(sql`
    SELECT id, account_id, google_calendar_id, name, color, time_zone, access_role, selected,
           sync_token, watch_channel_id, watch_resource_id, watch_expiration, last_polled_at,
           sync_pending, calaccess
    FROM ${sql.raw(schema)}.calendars
    WHERE org_id = ${orgId}::uuid AND watch_channel_id = ${channelId} AND watch_resource_id = ${resourceId}
    LIMIT 1
  `)) as unknown as { rows?: CalendarRow[] } | CalendarRow[]
  const list = Array.isArray(rows) ? rows : (rows.rows ?? [])
  return list[0]
}

/**
 * handleGooglePushNotification — post-verify handler (has DB): binds by channel/resource id.
 * Unknown -> no-op (drop, no job enqueued). Known -> enqueue `calendar-incremental-sync` with a
 * STABLE BullMQ jobId (`calendar-incremental:${calendarId}`) so rapid repeat notifications for
 * the same calendar collapse into one pending job at the queue layer (debounce).
 */
export async function handleGooglePushNotification(
  db: RlsClient,
  orgId: string,
  channelId: string,
  resourceId: string,
  enqueueJob: (
    jobName: string,
    payload: Record<string, unknown>,
    opts?: Record<string, unknown>,
  ) => Promise<void>,
): Promise<void> {
  const calendar = await findCalendarByChannelId(db, orgId, channelId, resourceId)
  if (!calendar) return
  await enqueueJob(
    "calendar-incremental-sync",
    { orgId, calendarId: calendar.id },
    { jobId: `calendar-incremental:${calendar.id}`, removeOnComplete: true },
  )
}

/** findCalendarsForWatchRenewal — calendars with a channel expiring within `withinHours` hours.
 * Boundary is EXCLUSIVE `<` (Design: "pick the inclusive/exclusive boundary explicitly — use <"):
 * a calendar exactly AT now+withinHours is NOT selected yet (it's selected on the next scan,
 * closer to actual expiry). */
export async function findCalendarsForWatchRenewal(
  db: RlsClient,
  orgId: string,
  withinHours: number,
): Promise<CalendarRow[]> {
  const { sql } = await import("drizzle-orm")
  const schema = CALENDAR_SCHEMA()
  const rows = (await db.execute(sql`
    SELECT id, account_id, google_calendar_id, name, color, time_zone, access_role, selected,
           sync_token, watch_channel_id, watch_resource_id, watch_expiration, last_polled_at,
           sync_pending, calaccess
    FROM ${sql.raw(schema)}.calendars
    WHERE org_id = ${orgId}::uuid AND selected = true AND watch_channel_id IS NOT NULL
      AND watch_expiration < (now() + (${withinHours} || ' hours')::interval)
      AND ${notImportedCalendar(sql, schema)}
  `)) as unknown as { rows?: CalendarRow[] } | CalendarRow[]
  return Array.isArray(rows) ? rows : (rows.rows ?? [])
}

/** stopWatchChannelOnly — clears only the watch-channel fields (channelId/resourceId/expiration),
 * leaving syncToken and events intact. Used by renewal (stop the OLD channel after the new one
 * is created — overlap, no gap) — distinct from `stopCalendarWatch` (deselect path), which also
 * nulls syncToken since deselect purges all local events too. `channelId` guards against a
 * stale renewal accidentally clearing a channel a newer renewal already replaced. */
export async function stopWatchChannelOnly(
  db: RlsClient,
  orgId: string,
  calendarId: string,
  channelId: string,
): Promise<void> {
  const { sql } = await import("drizzle-orm")
  const schema = CALENDAR_SCHEMA()
  await db.execute(sql`
    UPDATE ${sql.raw(schema)}.calendars
    SET watch_channel_id = NULL, watch_resource_id = NULL, watch_expiration = NULL
    WHERE org_id = ${orgId}::uuid AND id = ${calendarId}::uuid AND watch_channel_id = ${channelId}
  `)
}

/** `AND liaison_sync_version = v` when the caller names the version its push was read from. */
async function versionGuard(syncVersion: number | undefined) {
  const { sql } = await import("drizzle-orm")
  return syncVersion === undefined ? sql`` : sql` AND liaison_sync_version = ${syncVersion}`
}

/**
 * applyRemoteDeletion — a push found the event gone on Google (404/410): delete it locally, as an
 * inbound cancellation does, which drops the pending edit with it. The caller logs it. When the
 * row was edited after the push read it (`syncVersion` moved on), it is left for the newer push.
 */
export async function applyRemoteDeletion(
  db: RlsClient,
  orgId: string,
  eventId: string,
  syncVersion?: number,
): Promise<void> {
  const { sql } = await import("drizzle-orm")
  const schema = CALENDAR_SCHEMA()
  await db.execute(sql`
    DELETE FROM ${sql.raw(schema)}.events
    WHERE org_id = ${orgId}::uuid AND id = ${eventId}::uuid${await versionGuard(syncVersion)}
  `)
}

/**
 * markPushRejected — Google rejected the change itself (400 and the like, a refusal on a create,
 * or too many failed attempts): stop pushing it (pending_push cleared, so neither the retry
 * chain nor the periodic sweep sends it again), keep the local values so the user sees what was
 * refused, and record the message on the row for the event dialog. A new local edit clears it.
 * When the row was edited after the push read it, it stays pending for the newer push.
 */
export async function markPushRejected(
  db: RlsClient,
  orgId: string,
  eventId: string,
  message: string,
  syncVersion?: number,
): Promise<void> {
  const { sql } = await import("drizzle-orm")
  const schema = CALENDAR_SCHEMA()
  await db.execute(sql`
    UPDATE ${sql.raw(schema)}.events SET pending_push = 'none', push_error = ${message.slice(0, 500)},
      -- A refused conference request is not re-sent with every later edit.
      conference_request = NULL,
      -- A refused delete brings the event back, with the refusal on it.
      deleted_at = NULL
    WHERE org_id = ${orgId}::uuid AND id = ${eventId}::uuid${await versionGuard(syncVersion)}
  `)
}

/**
 * notePushFailure — counts a failed attempt to push this version of the row and returns how
 * many there were and for how long this version has been failing, or null when the row was
 * edited since (its newer push takes over).
 */
export async function notePushFailure(
  db: RlsClient,
  orgId: string,
  eventId: string,
  syncVersion: number,
): Promise<{ attempts: number; failingForMs: number } | null> {
  const { sql } = await import("drizzle-orm")
  const schema = CALENDAR_SCHEMA()
  const rows = (await db.execute(sql`
    UPDATE ${sql.raw(schema)}.events
    SET push_attempts = push_attempts + 1, last_push_attempt_at = now(),
        first_push_failure_at = COALESCE(first_push_failure_at, now())
    WHERE org_id = ${orgId}::uuid AND id = ${eventId}::uuid
      AND liaison_sync_version = ${syncVersion} AND pending_push <> 'none'
    RETURNING push_attempts,
      (EXTRACT(EPOCH FROM (now() - first_push_failure_at)) * 1000)::bigint AS failing_for_ms
  `)) as unknown as
    | { rows?: Array<{ push_attempts: number; failing_for_ms: number | string }> }
    | Array<{ push_attempts: number; failing_for_ms: number | string }>
  const list = Array.isArray(rows) ? rows : (rows.rows ?? [])
  const row = list[0]
  return row
    ? { attempts: Number(row.push_attempts), failingForMs: Number(row.failing_for_ms) }
    : null
}

export interface StalePendingPush {
  id: string
  liaison_sync_version: number
  push_attempts: number
}

/**
 * findStalePendingPushes — local creates/updates still waiting for Google whose last attempt
 * (or edit) is older than `staleMinutes`: a failed push whose re-queued job was lost. The
 * periodic poll re-queues them, least recently tried first, so one failing row cannot starve
 * the others. Rows with a recorded refusal, and rows of an account that must be reconnected,
 * are skipped (reconnecting resumes them).
 */
export async function findStalePendingPushes(
  db: RlsClient,
  orgId: string,
  staleMinutes: number,
  limit = 50,
): Promise<StalePendingPush[]> {
  const { sql } = await import("drizzle-orm")
  const schema = CALENDAR_SCHEMA()
  const rows = (await db.execute(sql`
    SELECT e.id, e.liaison_sync_version, e.push_attempts
    FROM ${sql.raw(schema)}.events e
    JOIN ${sql.raw(schema)}.calendars c ON c.id = e.calendar_id AND c.org_id = e.org_id
    JOIN ${sql.raw(schema)}.accounts a ON a.id = c.account_id AND a.org_id = e.org_id
    WHERE e.org_id = ${orgId}::uuid AND e.pending_push IN ('create', 'update', 'delete')
      AND e.push_error IS NULL AND a.sync_status NOT IN ('reauth-required', 'imported')
      AND COALESCE(e.last_push_attempt_at, e.updated_at) < (now() - (${staleMinutes} || ' minutes')::interval)
    ORDER BY COALESCE(e.last_push_attempt_at, e.updated_at)
    LIMIT ${limit}
  `)) as unknown as { rows?: StalePendingPush[] } | StalePendingPush[]
  return (Array.isArray(rows) ? rows : (rows.rows ?? [])).map((r) => ({
    id: r.id,
    liaison_sync_version: Number(r.liaison_sync_version),
    push_attempts: Number(r.push_attempts),
  }))
}

/**
 * A calendar of an IMPORTED account (an ICS import, modules/imports): local only, no connection
 * behind it, so no Google sync, watch or push ever touches it.
 */
function notImportedCalendar(
  sql: typeof import("drizzle-orm").sql,
  schema: string,
): ReturnType<typeof import("drizzle-orm").sql> {
  return sql`NOT EXISTS (
    SELECT 1 FROM ${sql.raw(schema)}.accounts ia
    WHERE ia.id = ${sql.raw(schema)}.calendars.account_id AND ia.sync_status = 'imported'
  )`
}

/** findCalendarsForPollFallback — selected calendars whose lastPolledAt is older than
 * `staleMinutes` (or has never been polled). */
export async function findCalendarsForPollFallback(
  db: RlsClient,
  orgId: string,
  staleMinutes: number,
): Promise<CalendarRow[]> {
  const { sql } = await import("drizzle-orm")
  const schema = CALENDAR_SCHEMA()
  const rows = (await db.execute(sql`
    SELECT id, account_id, google_calendar_id, name, color, time_zone, access_role, selected,
           sync_token, watch_channel_id, watch_resource_id, watch_expiration, last_polled_at,
           sync_pending, calaccess
    FROM ${sql.raw(schema)}.calendars
    WHERE org_id = ${orgId}::uuid AND selected = true
      AND (last_polled_at IS NULL OR last_polled_at < (now() - (${staleMinutes} || ' minutes')::interval))
      AND ${notImportedCalendar(sql, schema)}
  `)) as unknown as { rows?: CalendarRow[] } | CalendarRow[]
  return Array.isArray(rows) ? rows : (rows.rows ?? [])
}

export async function markCalendarPolled(
  db: RlsClient,
  orgId: string,
  calendarId: string,
): Promise<void> {
  const { sql } = await import("drizzle-orm")
  const schema = CALENDAR_SCHEMA()
  await db.execute(sql`
    UPDATE ${sql.raw(schema)}.calendars SET last_polled_at = now()
    WHERE org_id = ${orgId}::uuid AND id = ${calendarId}::uuid
  `)
}

export { findCalendarsByAccountId, getAccountById }
