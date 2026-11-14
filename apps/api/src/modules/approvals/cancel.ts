// SPDX-License-Identifier: FSL-1.1-ALv2

import { sql as drizzleSql } from "drizzle-orm"
import { extractRows, type PrivilegedDb, type RlsClient, type RlsTx } from "~/db"
import { withPrivilegedDb } from "~/db/privileged"
import { schemaRef } from "~/db/schema-ref"
import { enqueueRoutineDecisionTurn } from "~/modules/approvals/approval-result-turn"
import { loadApprovalSummary } from "~/modules/approvals/event-data"

type SqlClient = RlsClient | RlsTx | PrivilegedDb

const DEFAULT_TICKET_GATED_TOOLS = ["tickets:reply", "tickets:nudge", "tickets:close"]

/**
 * Cancel pending gated tickets:* approvals for a ticket. `toolNames` scopes
 * which gated tools are cancelled -- defaults to the full reply/nudge/close
 * family (merge.ts's existing behaviour: a merge really does obsolete every
 * pending draft on the source ticket, unchanged). A narrower caller (a sent
 * reply superseding a stale suggested REPLY draft, tools.ts) passes just
 * `['tickets:reply']` so it never cancels an unrelated pending nudge or close
 * someone else queued on the same ticket.
 */
export async function cancelApprovalsForSourceTicket(
  _tx: SqlClient,
  orgId: string,
  sourceTicketId: string,
  reason: string,
  toolNames: string[] = DEFAULT_TICKET_GATED_TOOLS,
  // The caller's privileged transaction, when it holds one: the update then
  // runs on it rather than on a second connection (tickets/privileged-read.ts).
  privilegedTx?: PrivilegedDb,
): Promise<{ cancelledCount: number }> {
  // An empty list would render `tool_name IN ()`, a Postgres syntax error --
  // and semantically "cancel nothing" is exactly what an empty list means, so
  // short-circuit rather than let a future empty-array caller crash.
  if (toolNames.length === 0) return { cancelledCount: 0 }
  const run = <T>(fn: (tx: PrivilegedDb) => Promise<T>): Promise<T> =>
    privilegedTx ? fn(privilegedTx) : withPrivilegedDb(orgId, "tickets-cancel-approvals", fn)
  const cancelled = await run(async (tx) => {
    const kernelSchema = drizzleSql.raw(schemaRef("kernel"))
    // `tool_name = ANY(${toolNames})` sends the JS array as a single bound
    // parameter, which postgres.js does not coerce into a Postgres array
    // literal -- it fails with "malformed array literal". `sql.join(... IN
    // (...))` is the established pattern elsewhere in this codebase (see
    // digest-jobs.ts, files/service.ts): each tool name is its own bound
    // parameter, so it round-trips correctly regardless of list length.
    const toolNameList = drizzleSql.join(
      toolNames.map((name) => drizzleSql`${name}`),
      drizzleSql`, `,
    )
    const result = await tx.execute(drizzleSql`
      UPDATE ${kernelSchema}.approval_requests
      SET status = 'cancelled',
          decided_at = now(),
          reason = ${reason}
      WHERE org_id = ${orgId}
        AND status = 'pending'
        AND tool_name IN (${toolNameList})
        AND (
          tool_params @> jsonb_build_object('ticketId', ${sourceTicketId}::text)
          OR current_payload @> jsonb_build_object('ticketId', ${sourceTicketId}::text)
        )
      RETURNING id::text AS id
    `)
    return extractRows<{ id: string }>(result).map((r) => r.id)
  })
  // A routine run waiting on one of these carries on (approval-result-turn.ts),
  // once committed: inside a caller's transaction the waiting-run sweep does it.
  if (!privilegedTx) {
    for (const id of cancelled) await enqueueRoutineDecisionTurn(orgId, id)
  }
  return { cancelledCount: cancelled.length }
}

/** What a request shows once the ticket it would act on was merged into another. */
export const TICKET_MERGED_REASON = "Cancelled: the ticket was merged into another"

/** What an approval list shows for an approval its requester's deletion cancelled. */
export const REQUESTER_DELETED_REASON = "Cancelled: the requester deleted their account"
/** And for one whose only approver deleted their account. */
export const SOLE_APPROVER_DELETED_REASON = "Cancelled: the only approver deleted their account"

/**
 * Cancel the PENDING approvals a departing user leaves behind (spec S19): the
 * ones they requested, which nobody should approve on their behalf once they
 * are gone, and the ones where they are the only approver, which nobody could
 * decide any more. "Only approver" is the routing the rows carry: an approval
 * owner routed to this user (a draft on their personal mailbox, decidable by
 * them alone), or one whose notified audience is this user and nobody else.
 * Approvals routed to other people too stay pending for them.
 *
 * Each cancelled row gets a readable reason and emits the same update event
 * every other terminal transition emits, so an open approval list shows why.
 * `approving` rows are left alone: their executor is already running. Runs in
 * the caller's privileged transaction; returns the cancelled ids.
 */
export async function cancelApprovalsForDeletedAccount(
  tx: PrivilegedDb,
  orgId: string,
  userId: string,
): Promise<string[]> {
  const kernelSchema = drizzleSql.raw(schemaRef("kernel"))
  const requested = extractRows<{ id: string }>(
    await tx.execute(drizzleSql`
      UPDATE ${kernelSchema}.approval_requests
         SET status = 'cancelled', decided_at = now(), reason = ${REQUESTER_DELETED_REASON}
       WHERE org_id = ${orgId} AND status = 'pending' AND requested_by = ${userId}
      RETURNING id::text AS id`),
  ).map((r) => r.id)
  const soleApprover = extractRows<{ id: string }>(
    await tx.execute(drizzleSql`
      UPDATE ${kernelSchema}.approval_requests
         SET status = 'cancelled', decided_at = now(), reason = ${SOLE_APPROVER_DELETED_REASON}
       WHERE org_id = ${orgId} AND status = 'pending'
         AND (resource_owner_id = ${userId}
              OR notify_user_ids = ARRAY[${userId}::uuid])
      RETURNING id::text AS id`),
  ).map((r) => r.id)
  const cancelled = [...requested, ...soleApprover]
  for (const id of cancelled) {
    await tx.queueEvent({
      app: "kernel",
      entity: "approval_request",
      action: "update",
      entityId: id,
      orgId,
      actorId: userId,
      actorType: "user",
      data: await loadApprovalSummary(tx, orgId, id),
    })
  }
  return cancelled
}

/** What a request shows once the task it would change was deleted. */
export const TARGET_TASK_DELETED_REASON = "Cancelled: the task it would change was deleted"

/** Where a request cancelled for its deleted task keeps the reason it had, for the way back. */
const REASON_BEFORE_KEY = "reasonBeforeTaskDeleted"

/** And once the app its tool belongs to was switched off or removed. */
export function appSwitchedOffReason(app: string): string {
  return `Cancelled: the ${app} app was switched off, so this request can no longer run`
}

/** Who caused a cancel or a reopen: the person who deleted, restored or switched off. */
export interface ApprovalChangeActor {
  actorId: string | null
  actorType: "user" | "agent" | "system"
}

/** Tell every open approval list about the rows a cancel or reopen changed. */
async function queueApprovalUpdates(
  tx: PrivilegedDb,
  orgId: string,
  ids: readonly string[],
  actor: ApprovalChangeActor,
): Promise<void> {
  for (const id of ids) {
    await tx.queueEvent({
      app: "kernel",
      entity: "approval_request",
      action: "update",
      entityId: id,
      orgId,
      actorId: actor.actorId,
      actorType: actor.actorType,
      data: await loadApprovalSummary(tx, orgId, id),
    })
  }
}

/**
 * Cancel the PENDING requests of the projects app that would change one of these tasks, once they
 * are deleted: nobody should approve a change to a task in the bin, and the person who asked reads
 * why on the request. Rows already `approving` are left alone (their executor is running, often
 * the delete itself). Taking the task back out of the bin reopens them
 * (`reopenApprovalsForRestoredTasks`). Returns the cancelled ids.
 */
export async function cancelApprovalsForDeletedTasks(
  orgId: string,
  taskIds: readonly string[],
  actor: ApprovalChangeActor,
): Promise<string[]> {
  if (taskIds.length === 0) return []
  const ids = drizzleSql.join(
    taskIds.map((id) => drizzleSql`${id}`),
    drizzleSql`, `,
  )
  const cancelled = await withPrivilegedDb(orgId, "approvals-cancel-deleted-task", async (tx) => {
    const kernelSchema = drizzleSql.raw(schemaRef("kernel"))
    const rows = extractRows<{ id: string }>(
      await tx.execute(drizzleSql`
        UPDATE ${kernelSchema}.approval_requests
           SET status = 'cancelled', decided_at = now(), reason = ${TARGET_TASK_DELETED_REASON},
               metadata = metadata || jsonb_build_object(${REASON_BEFORE_KEY}::text, reason)
         WHERE org_id = ${orgId} AND status = 'pending'
           AND starts_with(tool_name, 'projects:')
           AND (tool_params->>'taskId' IN (${ids}) OR current_payload->>'taskId' IN (${ids}))
        RETURNING id::text AS id`),
    ).map((r) => r.id)
    await queueApprovalUpdates(tx, orgId, rows, actor)
    return rows
  })
  for (const id of cancelled) await enqueueRoutineDecisionTurn(orgId, id)
  return cancelled
}

/**
 * The way back: a task taken out of the bin gets back the requests its deletion cancelled, pending
 * as they were. A request a routine run was waiting on stays cancelled, since that run has already
 * carried on with the cancellation. Returns the reopened ids.
 */
export async function reopenApprovalsForRestoredTasks(
  orgId: string,
  taskIds: readonly string[],
  actor: ApprovalChangeActor,
): Promise<string[]> {
  if (taskIds.length === 0) return []
  const ids = drizzleSql.join(
    taskIds.map((id) => drizzleSql`${id}`),
    drizzleSql`, `,
  )
  return withPrivilegedDb(orgId, "approvals-reopen-restored-task", async (tx) => {
    const kernelSchema = drizzleSql.raw(schemaRef("kernel"))
    const rows = extractRows<{ id: string }>(
      await tx.execute(drizzleSql`
        UPDATE ${kernelSchema}.approval_requests
           SET status = 'pending', decided_at = NULL,
               reason = metadata->>${REASON_BEFORE_KEY}::text,
               metadata = metadata - ${REASON_BEFORE_KEY}::text
         WHERE org_id = ${orgId} AND status = 'cancelled'
           AND reason = ${TARGET_TASK_DELETED_REASON}
           AND expires_at > now()
           AND NOT (metadata ? 'originRoutineRunId')
           AND starts_with(tool_name, 'projects:')
           AND (tool_params->>'taskId' IN (${ids}) OR current_payload->>'taskId' IN (${ids}))
        RETURNING id::text AS id`),
    ).map((r) => r.id)
    await queueApprovalUpdates(tx, orgId, rows, actor)
    return rows
  })
}

/**
 * Cancel the PENDING requests whose tool belongs to an app that was switched off or removed: its
 * tools are gone from the catalog, so the request could never run, and Home stops listing it. The
 * rows stay (the audit of who asked for what), each reading cancelled with why. Switching the app
 * back on does not reopen them: the person asks again if it still matters. Returns the ids.
 *
 * A waiting mail draft whose pinned send check names a record of that app (a follow-up about a
 * deal, `projects:deal`) goes too, with the same line: nothing could any longer say whether it
 * may leave. Done here, in the switch-off call itself, so no lost event leaves one behind.
 */
export async function cancelApprovalsForSwitchedOffApp(
  orgId: string,
  app: string,
  actor: ApprovalChangeActor,
): Promise<string[]> {
  const cancelled = await withPrivilegedDb(orgId, "approvals-cancel-app-off", async (tx) => {
    const kernelSchema = drizzleSql.raw(schemaRef("kernel"))
    const rows = extractRows<{ id: string }>(
      await tx.execute(drizzleSql`
        UPDATE ${kernelSchema}.approval_requests
           SET status = 'cancelled', decided_at = now(), reason = ${appSwitchedOffReason(app)}
         WHERE org_id = ${orgId} AND status = 'pending'
           AND (
             starts_with(tool_name, ${`${app}:`})
             OR (
               tool_name IN ('mail:compose', 'mail:reply')
               AND EXISTS (
                 SELECT 1
                   FROM jsonb_array_elements(
                     CASE WHEN jsonb_typeof(current_payload->'sendGuard'->'refs') = 'array'
                          THEN current_payload->'sendGuard'->'refs' ELSE '[]'::jsonb END
                   ) AS ref
                  WHERE starts_with(ref->>'kind', ${`${app}:`})
               )
             )
           )
        RETURNING id::text AS id`),
    ).map((r) => r.id)
    await queueApprovalUpdates(tx, orgId, rows, actor)
    return rows
  })
  for (const id of cancelled) await enqueueRoutineDecisionTurn(orgId, id)
  return cancelled
}
