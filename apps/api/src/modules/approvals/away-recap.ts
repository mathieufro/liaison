// SPDX-License-Identifier: FSL-1.1-ALv2
//
// "WHILE YOU WERE AWAY". Back from an away range, a person finds on Home one computed row
// listing the decisions colleagues took for them meanwhile (`metadata.decidedFor` naming them),
// at most three, then "and N more". It reads the requests as the person, under the same select
// policy and the same feed rule as their approvals feed, so a request they cannot read today
// never reaches the row, title included. Owner-routed requests never pass on, so none is listed.
// Dismiss stores one read event in `attention_events`; the row then stays gone. No decision
// while away: no row.

import { type AttentionItem, type AttentionKind, personLocalDate } from "@liaison/shared"
import { sql as drizzleSql } from "drizzle-orm"
import { extractRows, type RlsClient } from "~/db"
import { schemaRef } from "~/db/schema-ref"
import { appsLogger as log } from "~/lib/logger"
import { apiViewer, authorityFacts, canSeeInFeed } from "~/modules/approvals/authority"
import { humanizeToolName } from "~/modules/approvals/event-data"

const K = drizzleSql.raw(schemaRef("kernel"))

/** The row's kind, and the entity its Dismiss is stored against. */
export const AWAY_RECAP_KIND = "kernel:away.recap"
export const AWAY_RECAP_ENTITY = "away_range"
/** The kind of the read event a Dismiss stores. */
export const AWAY_RECAP_DISMISSED_KIND = "kernel:away.recap_dismissed"
/** Lines the row lists before "and N more". */
export const AWAY_RECAP_LINES = 3
/** Days after the range's last day the row still shows if never dismissed. */
export const AWAY_RECAP_SHOW_DAYS = 14

export interface AwayRecapLine {
  approvalId: string
  title: string
  outcome: "approved" | "denied"
  decidedByName: string | null
}

interface EndedRange {
  id: string
  starts_on: string
  last_day: string
}

interface DecidedRow {
  id: string
  tool_name: string
  status: string
  summary: { title?: unknown } | null
  approve_scope: string | null
  resource_owner_id: string | null
  notify_user_ids: string[] | null
  requested_by: string
  decided_by_name: string | null
}

function addDays(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00Z`)
  d.setUTCDate(d.getUTCDate() + days)
  return d.toISOString().slice(0, 10)
}

async function readScopes(tx: RlsClient): Promise<string[]> {
  const [row] = extractRows<{ scopes: string | null }>(
    await tx.execute(drizzleSql`SELECT rls_ctx.scopes() AS scopes`),
  )
  if (!row?.scopes) return []
  if (row.scopes === "*") return ["*"]
  return row.scopes
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
}

/** The person's latest dated range that ended before today, within the show window. */
async function readEndedRange(
  tx: RlsClient,
  orgId: string,
  userId: string,
  today: string,
): Promise<EndedRange | null> {
  const [range] = extractRows<EndedRange>(
    await tx.execute(drizzleSql`
      SELECT id, starts_on::text AS starts_on,
             (CASE WHEN ended_early_on IS NOT NULL AND ended_early_on <= ends_on
                   THEN ended_early_on - 1 ELSE ends_on END)::text AS last_day
      FROM ${K}.away_ranges
      WHERE org_id = ${orgId}::uuid AND user_id = ${userId}::uuid AND status = 'active'
        AND ends_on IS NOT NULL
        AND (CASE WHEN ended_early_on IS NOT NULL AND ended_early_on <= ends_on
                  THEN ended_early_on - 1 ELSE ends_on END) < ${today}::date
        AND (CASE WHEN ended_early_on IS NOT NULL AND ended_early_on <= ends_on
                  THEN ended_early_on - 1 ELSE ends_on END) >= ${addDays(today, -AWAY_RECAP_SHOW_DAYS)}::date
      ORDER BY last_day DESC
      LIMIT 1`),
  )
  return range ?? null
}

/** Home's "While you were away" row for `userId`, or none. Runs as the person. */
export async function getAwayRecapAttentionItems(
  tx: RlsClient,
  orgId: string,
  userId: string,
): Promise<AttentionItem[]> {
  try {
    const [me] = extractRows<{ timezone: string | null }>(
      await tx.execute(drizzleSql`
        SELECT timezone FROM ${K}.users WHERE id = ${userId}::uuid AND org_id = ${orgId}::uuid`),
    )
    const today = personLocalDate(new Date(), me?.timezone ?? null, null)
    const range = await readEndedRange(tx, orgId, userId, today)
    if (!range) return []

    const dismissed = extractRows<{ id: string }>(
      await tx.execute(drizzleSql`
        SELECT id FROM ${K}.attention_events
        WHERE user_id = ${userId}::uuid AND app = 'kernel'
          AND entity_type = ${AWAY_RECAP_ENTITY} AND entity_id = ${range.id}
          AND kind = ${AWAY_RECAP_DISMISSED_KIND}
        LIMIT 1`),
    )
    if (dismissed.length > 0) return []

    // The person's own read of the requests: the select policy hides what they cannot read today.
    const decided = extractRows<DecidedRow>(
      await tx.execute(drizzleSql`
        SELECT ar.id, ar.tool_name, ar.status, ar.summary, ar.approve_scope,
               ar.resource_owner_id, ar.notify_user_ids, ar.requested_by,
               u.name AS decided_by_name
        FROM ${K}.approval_requests ar
        LEFT JOIN ${K}.users u ON u.id = ar.decided_by
        WHERE ar.org_id = ${orgId}::uuid
          AND ar.resource_owner_id IS NULL
          AND ar.metadata -> 'decidedFor' ->> 'userId' = ${userId}
          AND ar.decided_at >= ${range.starts_on}::date
          AND ar.decided_at < ${addDays(range.last_day, 1)}::date + INTERVAL '1 day'
        ORDER BY ar.decided_at DESC
        LIMIT 200`),
    )
    const scopes = await readScopes(tx)
    const viewer = apiViewer(userId, scopes)
    // And the feed's own rule on top: what the approvals feed would not show, this row does not.
    const readable = decided.filter((r) => canSeeInFeed(authorityFacts(r), viewer))
    if (readable.length === 0) return []

    const lines: AwayRecapLine[] = readable.slice(0, AWAY_RECAP_LINES).map((r) => ({
      approvalId: r.id,
      title:
        typeof r.summary?.title === "string" && r.summary.title.length > 0
          ? r.summary.title.slice(0, 120)
          : humanizeToolName(r.tool_name),
      outcome: r.status === "denied" ? "denied" : "approved",
      decidedByName: r.decided_by_name,
    }))
    return [
      {
        id: `kernel:away_recap:${range.id}`,
        app: "kernel",
        entity: AWAY_RECAP_ENTITY,
        entityId: range.id,
        // A kernel row's kind beside the listed kinds, as app event kinds ride in `kind`.
        kind: AWAY_RECAP_KIND as AttentionKind,
        summary: "While you were away",
        urgency: 30,
        occurredAt: new Date(`${range.last_day}T00:00:00Z`).toISOString(),
        action: { type: "open_entity", tabType: "kernel:approvals", entityId: "approvals" },
        metadata: {
          awayRecap: {
            from: range.starts_on,
            to: range.last_day,
            lines,
            more: readable.length - lines.length,
          },
        },
      },
    ]
  } catch (err) {
    log.warn({ err, orgId }, "could not read what was decided while the person was away")
    return []
  }
}

/** Dismiss: one read event of the person's own, so the row stays gone. Runs as the person. */
export async function dismissAwayRecap(
  tx: RlsClient,
  orgId: string,
  userId: string,
  rangeId: string,
): Promise<boolean> {
  const own = extractRows<{ id: string }>(
    await tx.execute(drizzleSql`
      SELECT id FROM ${K}.away_ranges
      WHERE id = ${rangeId}::uuid AND org_id = ${orgId}::uuid AND user_id = ${userId}::uuid`),
  )
  if (own.length === 0) return false
  await tx.execute(drizzleSql`
    INSERT INTO ${K}.attention_events
      (org_id, user_id, app, entity_type, entity_id, kind, urgency, summary, actor_id, actor_type,
       occurred_at, read_at, digest_state, digest_eligible_at)
    SELECT ${orgId}::uuid, ${userId}::uuid, 'kernel', ${AWAY_RECAP_ENTITY}, ${rangeId},
           ${AWAY_RECAP_DISMISSED_KIND}, 0, 'While you were away: dismissed', ${userId}::uuid,
           'user', now(), now(), 'not_eligible', now()
    WHERE NOT EXISTS (
      SELECT 1 FROM ${K}.attention_events
      WHERE user_id = ${userId}::uuid AND app = 'kernel' AND entity_type = ${AWAY_RECAP_ENTITY}
        AND entity_id = ${rangeId} AND kind = ${AWAY_RECAP_DISMISSED_KIND})`)
  return true
}
