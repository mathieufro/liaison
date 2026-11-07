// SPDX-License-Identifier: FSL-1.1-ALv2
import { zValidator } from "@hono/zod-validator"
import { sql } from "drizzle-orm"
import { Hono } from "hono"
import { z } from "zod"
import type { AppEnv } from "~/app"
import { extractRows } from "~/db"
import { schemaRef } from "~/db/schema-ref"
import { extractRlsContext, withRequestRls } from "~/lib/request-rls"
import { success } from "~/lib/response"
import { dismissAwayRecap } from "~/modules/approvals/away-recap"
import { aggregateAttentionItems } from "~/modules/apps/attention-aggregator"
import { nextMondayStart } from "~/modules/attention/set-aside"
import { broadcastReadState } from "~/modules/threads/read-state-broadcast"

const K = sql.raw(schemaRef("kernel"))

export const attentionRoutes = new Hono<AppEnv>()

attentionRoutes.get("/", async (c) => {
  const result = await aggregateAttentionItems({
    orgId: c.get("orgId"),
    actor: extractRlsContext(c),
  })
  return success(c, result)
})

const markReadEntitySchema = z.object({
  app: z.string().min(1),
  entityType: z.string().min(1),
  entityId: z.string().min(1),
})
const markReadAllSchema = z.object({ all: z.literal(true) })
// Group form: everything unread from one app, optionally narrowed to kinds.
// Backs the feed's per-group "mark read" action.
const markReadGroupSchema = z
  .object({
    app: z.string().min(1),
    kinds: z.array(z.string().min(1)).min(1).max(100).optional(),
  })
  // Strict so a malformed entity request (e.g. missing entityId) 400s instead
  // of silently degrading into an app-wide mark-read.
  .strict()
const markReadSchema = z.union([markReadEntitySchema, markReadAllSchema, markReadGroupSchema])

attentionRoutes.post("/mark-read", zValidator("json", markReadSchema), async (c) => {
  const body = c.req.valid("json")
  await withRequestRls(c, async (tx) => {
    if ("all" in body) {
      await tx.execute(sql`
        UPDATE ${K}.attention_events
        SET read_at = now()
        WHERE user_id = rls_ctx.user_id()::uuid
          AND read_at IS NULL`)
    } else if (!("entityId" in body)) {
      // Drizzle's sql`` spreads a JS array into separate comma-joined params, so
      // `= ANY(${kinds})` binds a scalar (or emits invalid syntax) instead of one
      // array param -- Postgres then throws "malformed array literal". Build an
      // explicit IN list from individually-bound params, which is length-safe.
      const kinds = body.kinds
      await tx.execute(sql`
        UPDATE ${K}.attention_events
        SET read_at = now()
        WHERE user_id = rls_ctx.user_id()::uuid
          AND read_at IS NULL
          AND app = ${body.app}
          ${
            kinds
              ? sql`AND kind IN (${sql.join(
                  kinds.map((k) => sql`${k}`),
                  sql`, `,
                )})`
              : sql``
          }`)
    } else {
      await tx.execute(sql`
        UPDATE ${K}.attention_events
        SET read_at = now()
        WHERE user_id = rls_ctx.user_id()::uuid
          AND read_at IS NULL
          AND app = ${body.app}
          AND entity_type = ${body.entityType}
          AND entity_id = ${body.entityId}`)
    }
  })
  // Committed: the reader's other devices refetch their feed now instead of on
  // the next minute's poll.
  await broadcastReadState(c.get("orgId"), c.get("userId"), { kind: "attention", ...body })
  return c.body(null, 204)
})

// --- Home's "Mark all as read" (D21) ----------------------------------------
//
// The Home panel clears the slice the viewer is looking at (Overview, Alerts,
// one alert cluster, Agents > Notifications, ...) in ONE request naming the
// entities it shows, so what is cleared is exactly what was on screen, not a
// server-side guess at the slice. Rows that need a DECISION are never read by
// it, whatever the client sends: an access request, a node permission prompt
// and an approval clear through their decision, never through a bulk read.
// Everything runs under the caller's RLS and is pinned to their own user id.

/** Upper bound on one bulk read; the feed caps persisted rows at 200. */
const MARK_READ_BULK_MAX = 1000

const markReadBulkSchema = z.object({
  items: z.array(markReadEntitySchema).min(1).max(MARK_READ_BULK_MAX),
})

/** Kinds a bulk read never clears: their row is a pending decision. */
const DECISION_KINDS = ["scope_request", "approval_pending"] as const

attentionRoutes.post("/mark-read-bulk", zValidator("json", markReadBulkSchema), async (c) => {
  const { items } = c.req.valid("json")
  const values = sql.join(
    items.map((i) => sql`(${i.app}, ${i.entityType}, ${i.entityId})`),
    sql`, `,
  )
  const rows = await withRequestRls(c, async (tx) =>
    extractRows<{ id: string; app: string; entity_type: string; entity_id: string }>(
      await tx.execute(sql`
        UPDATE ${K}.attention_events AS ae
        SET read_at = now()
        FROM (VALUES ${values}) AS v(app, entity_type, entity_id)
        WHERE ae.user_id = rls_ctx.user_id()::uuid
          AND ae.read_at IS NULL
          AND ae.app = v.app
          AND ae.entity_type = v.entity_type
          AND ae.entity_id = v.entity_id
          AND ae.kind NOT IN (${sql.join(
            DECISION_KINDS.map((k) => sql`${k}`),
            sql`, `,
          )})
          AND (ae.metadata -> 'nodePermissionPromptId') IS NULL
          AND (ae.metadata -> 'nodePermission') IS NULL
        RETURNING ae.id, ae.app, ae.entity_type, ae.entity_id`),
    ),
  )
  const marked = new Set(rows.map((r) => `${r.app}\u0000${r.entity_type}\u0000${r.entity_id}`)).size
  if (rows.length > 0) {
    await broadcastReadState(c.get("orgId"), c.get("userId"), { kind: "attention", bulk: true })
  }
  // `eventIds` is what the confirmation's Undo hands back to /mark-unread.
  return success(c, { marked, eventIds: rows.map((r) => r.id) })
})

const markUnreadSchema = z.object({
  eventIds: z
    .array(z.string().uuid())
    .min(1)
    .max(MARK_READ_BULK_MAX * 4),
})

/** Undo of a bulk read: puts back exactly the caller's rows it names. */
attentionRoutes.post("/mark-unread", zValidator("json", markUnreadSchema), async (c) => {
  const { eventIds } = c.req.valid("json")
  const rows = await withRequestRls(c, async (tx) =>
    extractRows<{ id: string }>(
      await tx.execute(sql`
        UPDATE ${K}.attention_events AS ae
        SET read_at = NULL
        WHERE ae.user_id = rls_ctx.user_id()::uuid
          AND ae.read_at IS NOT NULL
          AND ae.id IN (${sql.join(
            eventIds.map((id) => sql`${id}::uuid`),
            sql`, `,
          )})
          -- The same notice arrived again since the read: it is already
          -- unread, and a second unread row would break the dedupe index.
          AND NOT (ae.email_only = false AND EXISTS (
            SELECT 1 FROM ${K}.attention_events AS u
            WHERE u.user_id = ae.user_id
              AND u.app = ae.app
              AND u.entity_type = ae.entity_type
              AND u.entity_id = ae.entity_id
              AND u.kind = ae.kind
              AND u.read_at IS NULL
              AND u.email_only = false))
        RETURNING ae.id`),
    ),
  )
  if (rows.length > 0) {
    await broadcastReadState(c.get("orgId"), c.get("userId"), { kind: "attention", bulk: true })
  }
  return success(c, { restored: rows.length })
})

// "Not now": one persisted event of the caller's leaves the feed until next Monday 00:00 in
// their own time zone. A computed row has no event to set aside, so it has no Not now.
const setAsideSchema = z.object({ eventId: z.string().uuid() }).strict()

attentionRoutes.post("/set-aside", zValidator("json", setAsideSchema), async (c) => {
  const { eventId } = c.req.valid("json")
  const result = await withRequestRls(c, async (tx) => {
    const [me] = extractRows<{ timezone: string | null }>(
      await tx.execute(sql`
        SELECT timezone FROM ${K}.users WHERE id = rls_ctx.user_id()::uuid`),
    )
    const until = nextMondayStart(new Date(), me?.timezone ?? null)
    const rows = extractRows<{ id: string; summary: string }>(
      await tx.execute(sql`
        UPDATE ${K}.attention_events
        SET set_aside_until = ${until.toISOString()}::timestamptz
        WHERE id = ${eventId}::uuid
          AND user_id = rls_ctx.user_id()::uuid
          AND read_at IS NULL
        RETURNING id, summary`),
    )
    return { row: rows[0] ?? null, until, timeZone: me?.timezone ?? "UTC" }
  })
  if (!result.row) {
    return c.json(
      {
        error: {
          message: `No unread item ${eventId} of yours to set aside: it was read, resolved, or is not yours.`,
          code: "not_found",
        },
      },
      404,
    )
  }
  return success(c, {
    eventId: result.row.id,
    setAsideUntil: result.until.toISOString(),
    timeZone: result.timeZone,
  })
})

// "While you were away" (a computed row): Dismiss stores one read event, so it stays gone.
const awayRecapDismissSchema = z.object({ rangeId: z.string().uuid() }).strict()

attentionRoutes.post(
  "/away-recap/dismiss",
  zValidator("json", awayRecapDismissSchema),
  async (c) => {
    const { rangeId } = c.req.valid("json")
    const done = await withRequestRls(c, (tx) =>
      dismissAwayRecap(tx, c.get("orgId"), c.get("userId"), rangeId),
    )
    if (!done) {
      return c.json(
        {
          error: {
            message: `No away range ${rangeId} of yours: nothing was dismissed.`,
            code: "not_found",
          },
        },
        404,
      )
    }
    await broadcastReadState(c.get("orgId"), c.get("userId"), { kind: "attention", bulk: true })
    return success(c, { dismissed: rangeId })
  },
)
