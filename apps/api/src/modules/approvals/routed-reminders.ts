// SPDX-License-Identifier: FSL-1.1-ALv2
//
// A ROUTED ROW IS NOT LOST.
//
// Home sorts a pending request under one person (the one it was asked of, or the one on the
// item), and a request only a person may sign (`noAutoApprove`) has no machine to fall back on.
// Someone who is absent without saying so, or a record that changed hands, must not be able to
// hide either until it expires. So a pending request of either kind that has waited 24 hours
// tells all of its deciders, once, and stays exactly where it was.
//
// `reminders.ts` is something else (the requester's own agent reminding the requester), so this
// is a sweep of its own. "Once" is `metadata.routedReminderAt`, set by one conditional UPDATE in
// the same transaction as the notification: two workers cannot both send it. The notification is
// an ordinary agent notification event, so it goes through the attention pipeline, the router and
// the person's settings like any other. Deciders are read the way the feed reads them (in the
// notify set, holding the deciding scope, not denied the app), so nobody learns of a request
// they could not already see; an owner-routed row reminds its owner alone.

import { decidingScope } from "@liaison/shared"
import { sql as drizzleSql } from "drizzle-orm"
import { extractRows } from "~/db"
import { withPrivilegedDb, withSystemDb } from "~/db/privileged"
import { schemaRef } from "~/db/schema-ref"
import { rootLogger } from "~/lib/logger"
import { authorityFacts } from "~/modules/approvals/authority"
import { approvalActionPhrase, deriveApprovalTitle } from "~/modules/approvals/payload-title"
import {
  type RoutableApprovalRow,
  readPeopleDecide,
  readRoutesIgnoringAway,
} from "~/modules/approvals/route-world"
import { toolRegistry } from "~/modules/apps/app-registries"
import { awaitOrgApps } from "~/modules/apps/init"
import {
  SKIPPED_MOVING,
  sweepSkippingMoving,
  writeUnlessMoving,
} from "~/modules/org/transfer-state/skip-moving"

const log = rootLogger.child({ module: "approval-routed-reminders" })
const K = drizzleSql.raw(schemaRef("kernel"))

/** How long a routed request waits before its deciders are told. */
export const ROUTED_REMINDER_HOURS = 24
/** The sweep's schedule: hourly, off the quarter hours. */
export const ROUTED_REMINDER_CRON = "37 * * * *"
const PAGE_SIZE = 200
const MAX_PAGES = 20

interface WaitingRow extends RoutableApprovalRow {
  org_id: string
  approve_scope: string | null
  summary: { title?: unknown } | null
  current_payload: unknown
  thread_id: string | null
}

// Every column is read: the route's inputs travel with the row to the routing module, which alone reads them.
async function scan(after: string | null, orgId?: string): Promise<WaitingRow[]> {
  const result: unknown = await sweepSkippingMoving((notMoving) =>
    withSystemDb("approval-routed-reminder-scan", (db) =>
      db.execute(drizzleSql`
        SELECT ar.*
          FROM ${K}.approval_requests ar
         WHERE ar.status = 'pending'
           AND ar.created_at <= now() - make_interval(hours => ${ROUTED_REMINDER_HOURS})
           AND ar.expires_at > now()
           AND (ar.bundle_id IS NULL OR ar.bundle_id = ar.id)
           AND NOT (ar.metadata ? 'routedReminderAt')
           AND COALESCE(ar.metadata->>'seeded', 'false') <> 'true'
           AND ${notMoving(drizzleSql.raw("ar.org_id"))}
           ${orgId ? drizzleSql`AND ar.org_id = ${orgId}::uuid` : drizzleSql``}
           ${after ? drizzleSql`AND ar.id > ${after}::uuid` : drizzleSql``}
         ORDER BY ar.id
         LIMIT ${PAGE_SIZE}`),
    ),
  )
  return extractRows<WaitingRow>(result)
}

function isNoAutoApprove(toolName: string, orgId: string): boolean {
  const at = toolName.indexOf(":")
  if (at < 0) return false
  return (
    toolRegistry.get([orgId, toolName.slice(0, at), toolName.slice(at + 1)])?.noAutoApprove === true
  )
}

function titleOf(r: WaitingRow): string {
  const authored = typeof r.summary?.title === "string" ? r.summary.title.trim() : ""
  if (authored) return authored
  const payload =
    r.current_payload && typeof r.current_payload === "object"
      ? (r.current_payload as Record<string, unknown>)
      : null
  return deriveApprovalTitle(r.tool_name, payload) ?? approvalActionPhrase(r.tool_name)
}

/** Remind the deciders of one org's waiting rows. Returns how many rows were reminded. */
async function remindOrg(orgId: string, rows: readonly WaitingRow[]): Promise<number> {
  // The sweep spans every org, an idle one included: its tools must be registered before
  // `noAutoApprove` is read, or a row only a person may sign would never be reminded.
  await awaitOrgApps(orgId)
  return withPrivilegedDb(orgId, "approval-routed-reminder", async (tx) => {
    const routes = await readRoutesIgnoringAway(tx, orgId, rows)
    const due = rows.filter((r) =>
      r.resource_owner_id == null
        ? routes.route(r.id).to === "person" || isNoAutoApprove(r.tool_name, orgId)
        : isNoAutoApprove(r.tool_name, orgId),
    )
    if (due.length === 0) return 0

    // Who decides each row: its notify set holding its deciding scope, active, not denied the app.
    const pairs = new Map<string, { userId: string; scope: string; app: string }>()
    const key = (userId: string, scope: string, app: string) =>
      `${userId}\u0000${scope}\u0000${app}`
    for (const r of due) {
      if (r.resource_owner_id != null) continue
      const scope = decidingScope(authorityFacts(r))
      const app = r.tool_name.split(":")[0] ?? ""
      for (const userId of r.notify_user_ids ?? [])
        pairs.set(key(userId, scope, app), { userId, scope, app })
    }
    const decides = await readPeopleDecide(tx, orgId, pairs)
    const everyone = [
      ...new Set(due.flatMap((r) => [...(r.notify_user_ids ?? []), r.resource_owner_id ?? ""])),
    ].filter(Boolean)
    const active = new Set(
      everyone.length === 0
        ? []
        : extractRows<{ id: string }>(
            await tx.execute(drizzleSql`
              SELECT id FROM ${K}.users
               WHERE org_id = ${orgId}::uuid AND status = 'active'
                 AND id IN (${drizzleSql.join(
                   everyone.map((id) => drizzleSql`${id}::uuid`),
                   drizzleSql`, `,
                 )})`),
          ).map((u) => u.id),
    )

    let reminded = 0
    for (const r of due) {
      const targets =
        r.resource_owner_id != null
          ? [r.resource_owner_id].filter((id) => active.has(id))
          : (r.notify_user_ids ?? []).filter(
              (id) =>
                active.has(id) &&
                decides.has(
                  key(id, decidingScope(authorityFacts(r)), r.tool_name.split(":")[0] ?? ""),
                ),
            )
      if (targets.length === 0) continue
      // The claim: only the worker whose UPDATE lands sends.
      const claimed = extractRows<{ id: string }>(
        await tx.execute(drizzleSql`
          UPDATE ${K}.approval_requests
             SET metadata = COALESCE(metadata, '{}'::jsonb)
                            || jsonb_build_object('routedReminderAt', to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'))
           WHERE id = ${r.id}::uuid AND status = 'pending'
             AND NOT (COALESCE(metadata, '{}'::jsonb) ? 'routedReminderAt')
          RETURNING id`),
      )
      if (claimed.length === 0) continue
      await tx.queueEvent({
        app: "kernel",
        entity: "agent_notification",
        action: "create",
        entityId: r.id,
        orgId,
        actorType: "system",
        timestamp: new Date().toISOString(),
        data: {
          summary: `Waiting more than ${ROUTED_REMINDER_HOURS} hours for a decision: ${titleOf(r)}`,
          urgency: 50,
          targetUserIds: [...targets],
          // The row's own conversation, where the request is read and decided.
          ...(r.thread_id ? { link: { tabType: "thread", entityId: r.thread_id } } : {}),
          routedReminder: { approvalId: r.id, hours: ROUTED_REMINDER_HOURS },
        },
      })
      reminded++
    }
    return reminded
  })
}

/**
 * The scheduled pass: every pending request that is routed to a person, or that only a person
 * may sign, and has waited 24 hours, tells its deciders once. `orgId` limits it to one org.
 */
export async function runRoutedReminderSweep(
  opts: { orgId?: string } = {},
): Promise<{ candidates: number; notified: number }> {
  let after: string | null = null
  let candidates = 0
  let notified = 0
  for (let page = 0; page < MAX_PAGES; page++) {
    const batch = await scan(after, opts.orgId)
    if (batch.length === 0) break
    candidates += batch.length
    const byOrg = new Map<string, WaitingRow[]>()
    for (const r of batch) byOrg.set(r.org_id, [...(byOrg.get(r.org_id) ?? []), r])
    for (const [orgId, rows] of byOrg) {
      try {
        const n = await writeUnlessMoving(orgId, () => remindOrg(orgId, rows))
        if (n !== SKIPPED_MOVING) notified += n
      } catch (err) {
        log.warn({ err, orgId }, "routed reminders failed for an org; the next sweep tries again")
      }
    }
    after = batch[batch.length - 1]?.id ?? null
    if (batch.length < PAGE_SIZE) break
  }
  return { candidates, notified }
}
