// SPDX-License-Identifier: FSL-1.1-ALv2
/**
 * Deals: a deal is a root task of a pipeline project, with a row in
 * `app_projects.deals` (company, contact, outcome) and one in
 * `app_projects.deal_values` (the amount, behind projects:deals:read).
 *
 * The outcome of a deal follows the stage its task sits in: a stage whose
 * `deal_outcome` is `won` or `lost` closes the deal, any other stage leaves it
 * open. {@link syncDealOutcome} is the ONE place that writes `outcome`,
 * `closed_at`, `closed_by`, `lost_reason` and `reopen_status_id`, and every
 * write of a task's status in this service calls it in the same transaction
 * (create, update, move, cross-project move, the column migration of a status
 * delete, a stage losing its outcome). `deal-outcome-writer.guard.test.ts`
 * fails on a status write that does not, and on an outcome written anywhere
 * else.
 *
 * Deleting a deal's task archives it (deleteTask): its deal rows stay, every
 * deal read here leaves archived tasks out, and a restore brings the deal back
 * whole, amount, company and outcome included.
 */
import { sql as drizzleSql, type SQL } from "drizzle-orm"
import { kernelRel, projectsRel } from "~/apps/projects/schema-refs"
import { extractRows, type RlsClient, type RlsTx } from "~/db"
import type { UserContext } from "~/db/rls"
import { schemaRef } from "~/db/schema-ref"
import { classifyInbound } from "~/modules/mail/classify-inbound"
import * as suppressions from "~/modules/mail/suppressions"
import { hasScope } from "~/modules/permissions/permissions"
import { ProjectsServiceError } from "./statuses"
import { formatTaskKey } from "./task-key"

type SqlClient = RlsClient | RlsTx

export type DealOutcome = "open" | "won" | "lost"

/** One outcome change {@link syncDealOutcome} made. */
export interface DealOutcomeChange {
  taskId: string
  from: DealOutcome
  to: DealOutcome
  companyId: string | null
}

export interface SyncDealOutcomeOptions {
  /** The status each task held before the write, when the caller knows it: a
   *  deal closed from an open stage remembers that stage, so a reopen goes back
   *  to it. */
  fromStatusIds?: Readonly<Record<string, string>>
  /** Stored as the lost reason when this write closes a deal as lost. */
  lostReason?: string | null
}

// ---------------------------------------------------------------------------
// Failpoint: proves the outcome write and the status write commit together.
// ---------------------------------------------------------------------------

type DealOutcomeFailpoint = () => Promise<void> | void
let afterDealOutcomeWrite: DealOutcomeFailpoint | null = null

/** Arm a fault right after the outcome is written. Refused in production. */
export function armAfterDealOutcomeFailpoint(fn: DealOutcomeFailpoint): () => void {
  if (process.env.NODE_ENV === "production") {
    throw new Error("The deal outcome failpoint cannot be armed in production")
  }
  afterDealOutcomeWrite = fn
  return () => {
    afterDealOutcomeWrite = null
  }
}

function idList(ids: readonly string[]): SQL {
  return drizzleSql.join(
    ids.map((id) => drizzleSql`${id}::uuid`),
    drizzleSql`, `,
  )
}

/**
 * Bring the deal rows of `taskIds` in line with the stage each task sits in,
 * after a write of their status. Idempotent: a task whose outcome already
 * matches its stage is left alone and emits nothing, so a second "mark won"
 * is a no-op.
 *
 * - A live root task of a pipeline with no deal row gets one, and its empty
 *   value row through `ensure_deal_value` (a task created in, moved into, or
 *   promoted to the root of a pipeline).
 * - Reaching a `won` or `lost` stage sets the outcome, `closed_at` and
 *   `closed_by` and emits `projects/deal:closed`.
 * - Leaving a closing stage for an open one clears the outcome, the close
 *   stamps and the lost reason and emits `projects/deal:reopened`.
 * - Won to lost (or back) emits `reopened` then `closed`.
 */
export async function syncDealOutcome(
  tx: SqlClient,
  orgId: string,
  actor: UserContext,
  taskIds: readonly string[],
  options: SyncDealOutcomeOptions = {},
): Promise<DealOutcomeChange[]> {
  if (taskIds.length === 0) return []
  const ids = idList(taskIds)

  const created = extractRows<{ task_id: string }>(
    await tx.execute(drizzleSql`
      INSERT INTO ${projectsRel("deals")} (task_id, org_id)
      SELECT t.id, t.org_id
      FROM ${projectsRel("tasks")} t
      JOIN ${projectsRel("projects")} p ON p.id = t.project_id AND p.org_id = t.org_id
      WHERE t.id IN (${ids})
        AND t.org_id = ${orgId}::uuid
        AND t.parent_task_id IS NULL
        AND t.archived_at IS NULL
        AND p.kind = 'pipeline'
      ON CONFLICT (task_id) DO NOTHING
      RETURNING task_id
    `),
  )
  for (const row of created) {
    await tx.execute(drizzleSql`SELECT ${projectsRel("ensure_deal_value")}(${row.task_id}::uuid)`)
  }

  // A remembered reopen stage of another project (the deal crossed pipelines)
  // no longer applies.
  await tx.execute(drizzleSql`
    UPDATE ${projectsRel("deals")} d
    SET reopen_status_id = NULL, updated_at = now()
    FROM ${projectsRel("tasks")} t, ${projectsRel("project_statuses")} rs
    WHERE d.task_id IN (${ids}) AND d.org_id = ${orgId}::uuid
      AND t.id = d.task_id AND t.org_id = d.org_id
      AND rs.id = d.reopen_status_id AND rs.project_id <> t.project_id
  `)

  const rows = extractRows<{
    task_id: string
    outcome: DealOutcome
    company_id: string | null
    target: DealOutcome
    project_id: string
  }>(
    await tx.execute(drizzleSql`
      SELECT d.task_id, d.outcome, d.company_id, t.project_id,
             COALESCE(s.deal_outcome, 'open') AS target
      FROM ${projectsRel("deals")} d
      JOIN ${projectsRel("tasks")} t ON t.id = d.task_id AND t.org_id = d.org_id
      LEFT JOIN ${projectsRel("project_statuses")} s ON s.id = t.status_id AND s.org_id = t.org_id
      WHERE d.task_id IN (${ids}) AND d.org_id = ${orgId}::uuid
      ORDER BY d.task_id
      FOR UPDATE OF d
    `),
  )

  const changes: DealOutcomeChange[] = []
  for (const row of rows) {
    if (row.outcome === row.target) continue
    const change: DealOutcomeChange = {
      taskId: row.task_id,
      from: row.outcome,
      to: row.target,
      companyId: row.company_id,
    }
    if (row.target === "open") {
      await tx.execute(drizzleSql`
        UPDATE ${projectsRel("deals")}
        SET outcome = 'open', closed_at = NULL, closed_by = NULL, lost_reason = NULL,
            reopen_status_id = NULL, updated_at = now()
        WHERE task_id = ${row.task_id}::uuid AND org_id = ${orgId}::uuid
      `)
    } else {
      const fromStatusId = options.fromStatusIds?.[row.task_id]
      // Only an open stage of the same project is a place to reopen to; a deal
      // going from won to lost keeps the stage it was first closed from.
      const reopenSql =
        row.outcome === "open" && fromStatusId
          ? drizzleSql`(SELECT id FROM ${projectsRel("project_statuses")}
                WHERE id = ${fromStatusId}::uuid AND org_id = ${orgId}::uuid
                  AND project_id = ${row.project_id}::uuid AND NOT terminal)`
          : row.outcome === "open"
            ? drizzleSql`NULL`
            : drizzleSql`reopen_status_id`
      const reason = row.target === "lost" ? options.lostReason?.trim() || null : null
      await tx.execute(drizzleSql`
        UPDATE ${projectsRel("deals")}
        SET outcome = ${row.target}, closed_at = now(), closed_by = ${actor.userId}::uuid,
            lost_reason = ${reason}, reopen_status_id = ${reopenSql}, updated_at = now()
        WHERE task_id = ${row.task_id}::uuid AND org_id = ${orgId}::uuid
      `)
    }
    if (afterDealOutcomeWrite) await afterDealOutcomeWrite()
    if (change.from !== "open") {
      await tx.queueEvent({
        app: "projects",
        entity: "deal",
        action: "reopened",
        entityId: row.task_id,
        data: {
          taskId: row.task_id,
          outcome: "open",
          from: change.from,
          companyId: row.company_id,
        },
        actorId: actor.userId,
        actorType: "user",
        orgId,
      })
    }
    if (change.to !== "open") {
      await tx.queueEvent({
        app: "projects",
        entity: "deal",
        action: "closed",
        entityId: row.task_id,
        data: { taskId: row.task_id, outcome: change.to, companyId: row.company_id },
        actorId: actor.userId,
        actorType: "user",
        orgId,
      })
    }
    changes.push(change)
  }
  return changes
}

// ---------------------------------------------------------------------------
// Pipelines and their stages
// ---------------------------------------------------------------------------

/** The stages of a new pipeline: [label, color]. Won and Lost close a deal. */
export const PIPELINE_OPEN_STAGES: ReadonlyArray<readonly [string, string]> = [
  ["Lead", "#6b7280"],
  ["Qualified", "#3b82f6"],
  ["Demo", "#f59e0b"],
  ["Proposal", "#8b5cf6"],
]
export const PIPELINE_CLOSING_STAGES: ReadonlyArray<
  readonly [string, string, Exclude<DealOutcome, "open">]
> = [
  ["Won", "#22c55e", "won"],
  ["Lost", "#ef4444", "lost"],
]

export async function projectKind(
  tx: SqlClient,
  orgId: string,
  projectId: string,
): Promise<"work" | "pipeline" | null> {
  const rows = extractRows<{ kind: "work" | "pipeline" }>(
    await tx.execute(drizzleSql`
      SELECT kind FROM ${projectsRel("projects")}
      WHERE id = ${projectId}::uuid AND org_id = ${orgId}::uuid LIMIT 1
    `),
  )
  return rows[0]?.kind ?? null
}

async function hasDealRow(tx: SqlClient, orgId: string, taskId: string): Promise<boolean> {
  const rows = extractRows<{ task_id: string }>(
    await tx.execute(drizzleSql`
      SELECT task_id FROM ${projectsRel("deals")}
      WHERE task_id = ${taskId}::uuid AND org_id = ${orgId}::uuid LIMIT 1
    `),
  )
  return rows.length > 0
}

/**
 * Only a top-level task of a pipeline is a deal, so a deal cannot be put
 * under another task: it would be counted twice on the board and in every
 * sum. Refused before anything is written.
 */
export async function refuseDealAsSubtask(
  tx: SqlClient,
  orgId: string,
  taskId: string,
): Promise<void> {
  if (!(await hasDealRow(tx, orgId, taskId))) return
  throw new ProjectsServiceError(
    409,
    "deal_cannot_be_subtask",
    "This task is a deal, and a deal stays a top-level task of its pipeline. Nothing was moved. To group it with another deal, link the two or merge them.",
  )
}

/**
 * A cross-project move of a deal: refused into a work project (a deal needs a
 * pipeline), and into another pipeline the stage it lands on follows its
 * outcome (a won deal lands on the won stage), then the first open stage.
 * Returns the stage to use, or undefined when the task is not a deal (the
 * move's own rule applies).
 */
export async function dealTargetStatusForMove(
  tx: SqlClient,
  orgId: string,
  taskId: string,
  targetProjectId: string,
): Promise<string | undefined> {
  if (!(await hasDealRow(tx, orgId, taskId))) return undefined
  if ((await projectKind(tx, orgId, targetProjectId)) !== "pipeline") {
    throw new ProjectsServiceError(
      409,
      "deal_needs_pipeline",
      "This task is a deal and can only move to another pipeline. Nothing was moved.",
    )
  }
  const rows = extractRows<{ id: string }>(
    await tx.execute(drizzleSql`
      SELECT s.id
      FROM ${projectsRel("project_statuses")} s
      JOIN ${projectsRel("deals")} d ON d.task_id = ${taskId}::uuid AND d.org_id = s.org_id
      WHERE s.project_id = ${targetProjectId}::uuid AND s.org_id = ${orgId}::uuid
        AND (CASE WHEN d.outcome = 'open' THEN NOT s.terminal ELSE s.deal_outcome = d.outcome END)
      ORDER BY s."order" ASC
      LIMIT 1
    `),
  )
  return rows[0]?.id
}

/**
 * The closing stages of a pipeline, by name, for a status reference that named
 * none of its stages ("mark it done"): nothing is changed and the answer names
 * the stages that close a deal. Rethrows anything else unchanged.
 */
export async function explainClosingStages(
  tx: SqlClient,
  orgId: string,
  projectId: string,
  err: unknown,
): Promise<never> {
  if (!(err instanceof ProjectsServiceError) || err.code !== "status_not_found") throw err
  if ((await projectKind(tx, orgId, projectId)) !== "pipeline") throw err
  const closing = extractRows<{ id: string; label: string; deal_outcome: DealOutcome }>(
    await tx.execute(drizzleSql`
      SELECT id, label, deal_outcome FROM ${projectsRel("project_statuses")}
      WHERE project_id = ${projectId}::uuid AND org_id = ${orgId}::uuid
        AND deal_outcome IS NOT NULL
      ORDER BY "order" ASC
    `),
  )
  if (closing.length === 0) throw err
  const names = closing.map((s) => JSON.stringify(s.label)).join(" or ")
  throw new ProjectsServiceError(
    err.status,
    err.code,
    `This board is a pipeline: a deal closes on ${names}. Say which one; nothing was changed.`,
    {
      ...((err.details as Record<string, unknown> | undefined) ?? {}),
      closingStages: closing.map((s) => ({ id: s.id, label: s.label, outcome: s.deal_outcome })),
    },
  )
}

/**
 * A pipeline keeps at least one won and one lost stage. Called before a stage
 * is deleted or stops closing deals; refuses with `last_closing_stage`.
 */
export async function assertKeepsClosingStages(
  tx: SqlClient,
  orgId: string,
  projectId: string,
  statusId: string,
): Promise<void> {
  const rows = extractRows<{ deal_outcome: DealOutcome | null; label: string; others: number }>(
    await tx.execute(drizzleSql`
      SELECT s.deal_outcome, s.label,
             (SELECT COUNT(*)::int FROM ${projectsRel("project_statuses")} o
               WHERE o.project_id = s.project_id AND o.org_id = s.org_id
                 AND o.id <> s.id AND o.deal_outcome = s.deal_outcome) AS others
      FROM ${projectsRel("project_statuses")} s
      WHERE s.id = ${statusId}::uuid AND s.project_id = ${projectId}::uuid
        AND s.org_id = ${orgId}::uuid
      LIMIT 1
    `),
  )
  const row = rows[0]
  if (!row?.deal_outcome || row.others > 0) return
  throw new ProjectsServiceError(
    409,
    "last_closing_stage",
    `${JSON.stringify(row.label)} is this pipeline's only ${row.deal_outcome} stage, and a pipeline keeps one won and one lost stage. Nothing was changed.`,
  )
}

// ---------------------------------------------------------------------------
// Merge
// ---------------------------------------------------------------------------

/**
 * Before two tasks merge: two deals naming different companies are refused
 * (`deals_different_company`), and so is a deal merged into a task that is
 * not a deal (`deal_merge_target_not_deal`: its company and amount would be
 * lost). The survivor keeps its own deal rows, taking the source's company and
 * contact when it names none; the source's rows are removed (its value row
 * goes with it).
 */
export async function mergeDealRows(
  tx: SqlClient,
  orgId: string,
  sourceId: string,
  targetId: string,
): Promise<void> {
  const rows = extractRows<{
    task_id: string
    company_id: string | null
    contact_id: string | null
  }>(
    await tx.execute(drizzleSql`
      SELECT task_id, company_id, contact_id FROM ${projectsRel("deals")}
      WHERE task_id IN (${sourceId}::uuid, ${targetId}::uuid) AND org_id = ${orgId}::uuid
    `),
  )
  const source = rows.find((r) => r.task_id === sourceId)
  const target = rows.find((r) => r.task_id === targetId)
  if (!source) return
  if (!target) {
    throw new ProjectsServiceError(
      409,
      "deal_merge_target_not_deal",
      "This task is a deal and the task it would merge into is not, so its company and amount would be lost. Nothing was changed. Merge it into another deal of the pipeline instead.",
    )
  }
  if (source.company_id && target.company_id && source.company_id !== target.company_id) {
    throw new ProjectsServiceError(
      409,
      "deals_different_company",
      "These two deals name different companies, so they are not merged. Nothing was changed.",
    )
  }
  if ((!target.company_id && source.company_id) || (!target.contact_id && source.contact_id)) {
    await tx.execute(drizzleSql`
      UPDATE ${projectsRel("deals")}
      SET company_id = COALESCE(company_id, ${source.company_id}::uuid),
          contact_id = COALESCE(contact_id, ${source.contact_id}::uuid),
          updated_at = now()
      WHERE task_id = ${targetId}::uuid AND org_id = ${orgId}::uuid
    `)
  }
  await tx.execute(drizzleSql`
    DELETE FROM ${projectsRel("deals")}
    WHERE task_id = ${sourceId}::uuid AND org_id = ${orgId}::uuid
  `)
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

export interface DealValue {
  amountMinor: number | null
  currency: string | null
  amountPeriod: "once" | "month" | "year"
  probability: number | null
}

export interface DealRow {
  taskId: string
  projectId: string
  title: string
  statusId: string
  assigneeId: string | null
  companyId: string | null
  contactId: string | null
  outcome: DealOutcome
  nextStep: string | null
  lostReason: string | null
  closedAt: string | null
  closedBy: string | null
  /** The task's display key, e.g. SALES-14. */
  key: string
  /** The stage the deal sits in, and the outcome that stage gives (null: open). */
  statusLabel: string | null
  stageOutcome: "won" | "lost" | null
  createdAt: string
  /** Null when the reader cannot see the company. */
  companyName: string | null
  /** Null when the reader has no deal access (the value row is not visible). */
  value: DealValue | null
}

export interface ListDealsFilter {
  taskId?: string
  projectId?: string
  companyId?: string
  contactId?: string
  outcome?: DealOutcome
  /** Closed at or after / strictly before these instants (ISO 8601). */
  closedAfter?: string
  closedBefore?: string
  limit?: number
}

function iso(value: Date | string | null): string | null {
  if (value === null) return null
  return value instanceof Date ? value.toISOString() : value
}

/**
 * The deals the reader can see, live top-level tasks only: a deleted
 * (archived) deal is left out until it is restored. The value is read under the reader's own
 * access and is null without it.
 */
export async function listDeals(
  tx: SqlClient,
  orgId: string,
  filter: ListDealsFilter = {},
): Promise<DealRow[]> {
  const conds: SQL[] = [
    drizzleSql`d.org_id = ${orgId}::uuid`,
    drizzleSql`t.archived_at IS NULL`,
    // Only a top-level task is a deal: a row left on a subtask is not counted.
    drizzleSql`t.parent_task_id IS NULL`,
  ]
  if (filter.taskId) conds.push(drizzleSql`d.task_id = ${filter.taskId}::uuid`)
  if (filter.projectId) conds.push(drizzleSql`t.project_id = ${filter.projectId}::uuid`)
  if (filter.companyId) conds.push(drizzleSql`d.company_id = ${filter.companyId}::uuid`)
  if (filter.contactId) conds.push(drizzleSql`d.contact_id = ${filter.contactId}::uuid`)
  if (filter.outcome) conds.push(drizzleSql`d.outcome = ${filter.outcome}`)
  if (filter.closedAfter) conds.push(drizzleSql`d.closed_at >= ${filter.closedAfter}::timestamptz`)
  if (filter.closedBefore) conds.push(drizzleSql`d.closed_at < ${filter.closedBefore}::timestamptz`)
  const limit = Math.min(Math.max(filter.limit ?? 100, 1), 500)
  const rows = extractRows<{
    task_id: string
    project_id: string
    title: string
    status_id: string
    assignee_id: string | null
    company_id: string | null
    contact_id: string | null
    outcome: DealOutcome
    next_step: string | null
    lost_reason: string | null
    closed_at: Date | string | null
    closed_by: string | null
    project_key: string
    number: number
    status_label: string | null
    stage_outcome: "won" | "lost" | null
    created_at: Date | string
    company_name: string | null
    has_value: boolean
    amount_minor: string | number | null
    currency: string | null
    amount_period: "once" | "month" | "year" | null
    probability: number | null
  }>(
    await tx.execute(drizzleSql`
      SELECT d.task_id, t.project_id, t.title, t.status_id, t.assignee_id,
             d.company_id, d.contact_id, d.outcome, d.next_step, d.lost_reason,
             d.closed_at, d.closed_by, p.key AS project_key, t.number,
             s.label AS status_label, s.deal_outcome AS stage_outcome, t.created_at,
             co.name AS company_name,
             (v.task_id IS NOT NULL) AS has_value,
             v.amount_minor, v.currency, v.amount_period, v.probability
      FROM ${projectsRel("deals")} d
      JOIN ${projectsRel("tasks")} t ON t.id = d.task_id AND t.org_id = d.org_id
      JOIN ${projectsRel("projects")} p ON p.id = t.project_id AND p.org_id = t.org_id
      LEFT JOIN ${projectsRel("project_statuses")} s ON s.id = t.status_id AND s.org_id = t.org_id
      LEFT JOIN ${kernelRel("companies")} co ON co.id = d.company_id AND co.org_id = d.org_id
      LEFT JOIN ${projectsRel("deal_values")} v ON v.task_id = d.task_id AND v.org_id = d.org_id
      WHERE ${drizzleSql.join(conds, drizzleSql` AND `)}
        AND p.archived_at IS NULL
      ORDER BY t.updated_at DESC, d.task_id
      LIMIT ${limit}
    `),
  )
  return rows.map((r) => ({
    taskId: r.task_id,
    projectId: r.project_id,
    title: r.title,
    statusId: r.status_id,
    assigneeId: r.assignee_id,
    companyId: r.company_id,
    contactId: r.contact_id,
    outcome: r.outcome,
    nextStep: r.next_step,
    lostReason: r.lost_reason,
    closedAt: iso(r.closed_at),
    closedBy: r.closed_by,
    key: formatTaskKey(r.project_key, Number(r.number)),
    statusLabel: r.status_label,
    stageOutcome: r.stage_outcome,
    createdAt: iso(r.created_at) as string,
    companyName: r.company_name,
    value: r.has_value
      ? {
          amountMinor: r.amount_minor === null ? null : Number(r.amount_minor),
          currency: r.currency,
          amountPeriod: r.amount_period ?? "once",
          probability: r.probability,
        }
      : null,
  }))
}

// ---------------------------------------------------------------------------
// Setting an outcome directly (a "Mark won" card action, the deal update tool)
// ---------------------------------------------------------------------------

export interface SetDealOutcomeArgs {
  tx: RlsClient
  orgId: string
  actor: UserContext
  taskId: string
  outcome: DealOutcome
  reason?: string | null
}

export interface SetDealOutcomeResult {
  taskId: string
  outcome: DealOutcome
  statusId: string
  closedAt: string | null
  /** False when the deal already had this outcome: nothing was written. */
  changed: boolean
}

/**
 * Close or reopen a deal by moving its task: `won` and `lost` move it to the
 * pipeline's first stage with that outcome, `open` back to the stage it was
 * closed from, else the last open stage. The move writes the outcome through
 * {@link syncDealOutcome}, like a drag on the board. The same outcome twice is
 * a no-op.
 */
export async function setDealOutcome(args: SetDealOutcomeArgs): Promise<SetDealOutcomeResult> {
  const { tx, orgId, actor, taskId, outcome } = args
  return tx.transaction(async (innerTx) => {
    const deals = await listDeals(innerTx, orgId, { taskId })
    const deal = deals[0]
    if (!deal) {
      throw new ProjectsServiceError(404, "deal_not_found", "No live deal has this task id.")
    }
    if (deal.outcome === outcome) {
      return {
        taskId,
        outcome,
        statusId: deal.statusId,
        closedAt: deal.closedAt,
        changed: false,
      }
    }
    const target =
      outcome === "open"
        ? extractRows<{ id: string }>(
            await innerTx.execute(drizzleSql`
              SELECT s.id FROM ${projectsRel("project_statuses")} s
              LEFT JOIN ${projectsRel("deals")} d ON d.task_id = ${taskId}::uuid AND d.org_id = s.org_id
              WHERE s.project_id = ${deal.projectId}::uuid AND s.org_id = ${orgId}::uuid
                AND NOT s.terminal
              ORDER BY COALESCE(s.id = d.reopen_status_id, false) DESC, s."order" DESC
              LIMIT 1
            `),
          )[0]
        : extractRows<{ id: string }>(
            await innerTx.execute(drizzleSql`
              SELECT id FROM ${projectsRel("project_statuses")}
              WHERE project_id = ${deal.projectId}::uuid AND org_id = ${orgId}::uuid
                AND deal_outcome = ${outcome}
              ORDER BY "order" ASC
              LIMIT 1
            `),
          )[0]
    if (!target) {
      throw new ProjectsServiceError(
        409,
        "no_stage_for_outcome",
        outcome === "open"
          ? "This pipeline has no open stage to reopen the deal to. Nothing was changed."
          : `This pipeline has no ${outcome} stage. Nothing was changed.`,
      )
    }
    const { moveTask } = await import("./move-task")
    await moveTask({
      tx: innerTx as RlsClient,
      orgId,
      actor,
      taskId,
      statusId: target.id,
      lostReason: args.reason ?? null,
    })
    const after = (await listDeals(innerTx, orgId, { taskId }))[0]!
    return {
      taskId,
      outcome: after.outcome,
      statusId: after.statusId,
      closedAt: after.closedAt,
      changed: true,
    }
  })
}

/**
 * Save, change or clear the reason of a deal that is already lost (the note
 * bar after a drag to Lost, typed once the move is done). Nothing else of the
 * deal changes, and a deal that is not lost keeps no reason: false then.
 */
export async function setLostReason(
  tx: SqlClient,
  orgId: string,
  taskId: string,
  reason: string | null,
): Promise<boolean> {
  const rows = extractRows<{ task_id: string }>(
    await tx.execute(drizzleSql`
      UPDATE ${projectsRel("deals")}
      SET lost_reason = ${reason?.trim() || null}, updated_at = now()
      WHERE task_id = ${taskId}::uuid AND org_id = ${orgId}::uuid AND outcome = 'lost'
      RETURNING task_id
    `),
  )
  return rows.length > 0
}

// ---------------------------------------------------------------------------
// Deal fields written with a task (company, contact, amount)
// ---------------------------------------------------------------------------

export interface DealFieldsInput {
  companyId?: string | null
  contactId?: string | null
  amountMinor?: number | null
  currency?: string | null
  amountPeriod?: "once" | "month" | "year"
  probability?: number | null
  nextStep?: string | null
}

const CURRENCY_RE = /^[A-Z]{3}$/

/** True when `input` names any deal field. */
export function hasDealFields(input: DealFieldsInput): boolean {
  return (
    input.companyId !== undefined ||
    input.contactId !== undefined ||
    input.amountMinor !== undefined ||
    input.currency !== undefined ||
    input.amountPeriod !== undefined ||
    input.probability !== undefined ||
    input.nextStep !== undefined
  )
}

/** Refuses deal fields on anything that is not a pipeline (`not_a_pipeline`). */
export async function assertPipelineForDealFields(
  tx: SqlClient,
  orgId: string,
  projectId: string,
  isSubtask: boolean,
): Promise<void> {
  const kind = await projectKind(tx, orgId, projectId)
  if (kind !== "pipeline" || isSubtask) {
    throw new ProjectsServiceError(
      409,
      "not_a_pipeline",
      kind !== "pipeline"
        ? "This project is not a pipeline, so a task in it has no company, contact or amount. Nothing was created."
        : "Only a top-level task of a pipeline is a deal; a subtask has no company, contact or amount. Nothing was created.",
    )
  }
}

/** A company the caller can read, else `company_not_found` (an unseen one reads as missing). */
export async function assertVisibleCompany(
  tx: SqlClient,
  orgId: string,
  companyId: string,
): Promise<{ id: string; name: string }> {
  const rows = /^[0-9a-f-]{36}$/i.test(companyId)
    ? extractRows<{ id: string; name: string }>(
        await tx.execute(drizzleSql`
          SELECT id::text AS id, name FROM ${kernelRel("companies")}
          WHERE id = ${companyId}::uuid AND org_id = ${orgId}::uuid LIMIT 1
        `),
      )
    : []
  if (!rows[0]) {
    throw new ProjectsServiceError(
      404,
      "company_not_found",
      "No company you can see has this id. Nothing was changed.",
    )
  }
  return rows[0]
}

async function assertVisibleContact(tx: SqlClient, orgId: string, contactId: string) {
  const rows = /^[0-9a-f-]{36}$/i.test(contactId)
    ? extractRows<{ id: string }>(
        await tx.execute(drizzleSql`
          SELECT id::text AS id FROM ${kernelRel("contacts")}
          WHERE id = ${contactId}::uuid AND org_id = ${orgId}::uuid LIMIT 1
        `),
      )
    : []
  if (!rows[0]) {
    throw new ProjectsServiceError(
      404,
      "contact_not_found",
      "No contact you can see has this id. Nothing was changed.",
    )
  }
}

/**
 * Write a deal's company, contact, next step and amount. The company and the
 * contact must be ones the caller can read; the amount needs
 * projects:deals:write (refused `deal_access_needed` without it) and a
 * currency. Run inside the caller's transaction, after the deal rows exist.
 */
export async function writeDealFields(
  tx: SqlClient,
  orgId: string,
  scopes: readonly string[],
  taskId: string,
  input: DealFieldsInput,
): Promise<void> {
  if (input.companyId) await assertVisibleCompany(tx, orgId, input.companyId)
  if (input.contactId) await assertVisibleContact(tx, orgId, input.contactId)
  const sets: SQL[] = []
  if (input.companyId !== undefined) sets.push(drizzleSql`company_id = ${input.companyId}::uuid`)
  if (input.contactId !== undefined) sets.push(drizzleSql`contact_id = ${input.contactId}::uuid`)
  if (input.nextStep !== undefined) {
    sets.push(drizzleSql`next_step = ${input.nextStep?.trim() || null}`)
  }
  if (sets.length > 0) {
    await tx.execute(drizzleSql`
      UPDATE ${projectsRel("deals")} SET ${drizzleSql.join(sets, drizzleSql`, `)}, updated_at = now()
      WHERE task_id = ${taskId}::uuid AND org_id = ${orgId}::uuid
    `)
  }
  const valueSets: SQL[] = []
  if (input.amountMinor !== undefined || input.currency !== undefined) {
    const amount = input.amountMinor ?? null
    const currency = input.currency ? input.currency.trim().toUpperCase() : null
    if (amount !== null && (!Number.isInteger(amount) || amount < 0)) {
      throw new ProjectsServiceError(
        400,
        "invalid_amount",
        "amountMinor is a whole number of minor units (cents), 0 or more. Nothing was changed.",
      )
    }
    if ((amount === null) !== (currency === null) || (currency && !CURRENCY_RE.test(currency))) {
      throw new ProjectsServiceError(
        400,
        "invalid_amount",
        "An amount needs its currency as a three-letter code (EUR), and a currency needs an amount. Nothing was changed.",
      )
    }
    valueSets.push(drizzleSql`amount_minor = ${amount}`, drizzleSql`currency = ${currency}`)
  }
  if (input.amountPeriod !== undefined) {
    valueSets.push(drizzleSql`amount_period = ${input.amountPeriod}`)
  }
  if (input.probability !== undefined) {
    const pr = input.probability
    if (pr !== null && (!Number.isInteger(pr) || pr < 0 || pr > 100)) {
      throw new ProjectsServiceError(
        400,
        "invalid_probability",
        "probability is a whole percent from 0 to 100. Nothing was changed.",
      )
    }
    valueSets.push(drizzleSql`probability = ${pr}`)
  }
  if (valueSets.length === 0) return
  if (!hasScope("projects:deals:write", [...scopes])) {
    throw new ProjectsServiceError(
      403,
      "deal_access_needed",
      "Setting an amount or a probability needs deal access (projects:deals:write). Nothing was changed.",
    )
  }
  await tx.execute(drizzleSql`
    UPDATE ${projectsRel("deal_values")} SET ${drizzleSql.join(valueSets, drizzleSql`, `)}, updated_at = now()
    WHERE task_id = ${taskId}::uuid AND org_id = ${orgId}::uuid
  `)
}

// ---------------------------------------------------------------------------
// Quiet: days since the last inbound mail from the deal's people
// ---------------------------------------------------------------------------

export const MAIL_READ_SCOPE = "mail:conversations:read"
const DAY_MS = 86_400_000
/** Newest messages read per person; the newest real reply is among them in practice. */
const QUIET_MESSAGES_PER_PERSON = 25

export interface DealQuiet {
  lastInboundAt: string | null
  lastOutboundAt: string | null
  quietDays: number
  /** Every contact counted for the deal: its contact and its company's people. */
  contactIds: string[]
}

interface QuietDeal {
  taskId: string
  companyId: string | null
  contactId: string | null
  createdAt: string
}

/**
 * Quiet for each deal, read as the caller: whole days since the last inbound
 * mail from any contact of the deal's company or from its contact, never an
 * automatic reply, a bounce or a bulk mail; with no inbound, days since the
 * deal was created. A deal with no person the caller can see has no entry
 * (unknown). Returns null when the caller cannot read mail (no mail scope, or
 * the read failed), so nobody is shown a silence they cannot see.
 */
export async function readDealQuiet(
  tx: SqlClient,
  orgId: string,
  scopes: readonly string[],
  deals: readonly QuietDeal[],
  now: Date = new Date(),
): Promise<Map<string, DealQuiet> | null> {
  if (!hasScope(MAIL_READ_SCOPE, [...scopes])) return null
  const companyIds = [...new Set(deals.map((d) => d.companyId).filter((x): x is string => !!x))]
  const contactIds = [...new Set(deals.map((d) => d.contactId).filter((x): x is string => !!x))]
  const people =
    companyIds.length + contactIds.length === 0
      ? []
      : await rowsOrNull<{ id: string; email: string | null; company_id: string | null }>(
          tx,
          drizzleSql`
            SELECT id::text AS id, lower(email) AS email, company_id::text AS company_id
            FROM ${kernelRel("contacts")}
            WHERE org_id = ${orgId}::uuid
              AND (company_id = ANY(${`{${companyIds.join(",")}}`}::uuid[])
                   OR id = ANY(${`{${contactIds.join(",")}}`}::uuid[]))
          `,
        )
  if (people === null) return null
  const messages =
    people.length === 0
      ? []
      : await rowsOrNull<{
          contact_id: string
          direction: string
          at: Date | string
          raw_headers: unknown
          subject: string | null
          text_body: string | null
          sender: string | null
        }>(
          tx,
          drizzleSql`
            SELECT x.id::text AS contact_id, r.direction, r.at, r.raw_headers, r.subject,
                   r.text_body, r.sender
            FROM jsonb_to_recordset(${JSON.stringify(people.map((p) => ({ id: p.id, email: p.email })))}::jsonb)
                 AS x(id uuid, email text)
            CROSS JOIN LATERAL (
              SELECT m.direction, COALESCE(m.sent_at, m.synced_at) AS at, m.raw_headers,
                     m.subject, m.text_body, m.from_address->>'email' AS sender
              FROM ${drizzleSql.raw(`${schemaRef("app_mail")}.messages`)} m
              JOIN ${drizzleSql.raw(`${schemaRef("app_mail")}.conversations`)} c ON c.id = m.conversation_id
              WHERE m.org_id = ${orgId}::uuid
                AND (c.contact_id = x.id
                     OR (x.email IS NOT NULL AND m.direction = 'inbound'
                         AND lower(m.from_address->>'email') = x.email))
              ORDER BY COALESCE(m.sent_at, m.synced_at) DESC NULLS LAST
              LIMIT ${QUIET_MESSAGES_PER_PERSON}
            ) r
          `,
        )
  if (messages === null) return null
  const lastIn = new Map<string, number>()
  const lastOut = new Map<string, number>()
  for (const m of messages) {
    const at = new Date(m.at).getTime()
    if (Number.isNaN(at)) continue
    if (m.direction === "outbound") {
      if (at > (lastOut.get(m.contact_id) ?? -Infinity)) lastOut.set(m.contact_id, at)
      continue
    }
    if (m.direction !== "inbound") continue
    if (classifyInbound(m.raw_headers, m.subject, m.text_body, m.sender) !== "reply") continue
    if (at > (lastIn.get(m.contact_id) ?? -Infinity)) lastIn.set(m.contact_id, at)
  }
  const out = new Map<string, DealQuiet>()
  for (const deal of deals) {
    const ids = people
      .filter((p) => p.id === deal.contactId || (deal.companyId && p.company_id === deal.companyId))
      .map((p) => p.id)
    const newest = (map: Map<string, number>) =>
      ids.reduce<number | null>((acc, id) => {
        const v = map.get(id)
        return v !== undefined && (acc === null || v > acc) ? v : acc
      }, null)
    // Nobody to hear from: quiet is unknown, not "since the deal was created".
    if (ids.length === 0) continue
    const inbound = newest(lastIn)
    const outbound = newest(lastOut)
    const since = inbound ?? new Date(deal.createdAt).getTime()
    out.set(deal.taskId, {
      lastInboundAt: inbound === null ? null : new Date(inbound).toISOString(),
      lastOutboundAt: outbound === null ? null : new Date(outbound).toISOString(),
      quietDays: Math.max(0, Math.floor((now.getTime() - since) / DAY_MS)),
      contactIds: ids,
    })
  }
  return out
}

/** A read in its own savepoint: a refusal gives null and leaves the transaction usable. */
async function rowsOrNull<T>(tx: SqlClient, query: SQL): Promise<T[] | null> {
  try {
    return await tx.transaction(async (inner) => extractRows<T>(await inner.execute(query)))
  } catch {
    return null
  }
}

// ---------------------------------------------------------------------------
// The board
// ---------------------------------------------------------------------------

/** Year and month of an instant in a time zone, "2026-11". */
function monthIn(at: Date, timeZone: string): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
  }).formatToParts(at)
  const y = parts.find((p) => p.type === "year")?.value
  const m = parts.find((p) => p.type === "month")?.value
  return `${y}-${m}`
}

/**
 * The org's time zone. The organizations table is closed to row-level
 * readers, so this one column is read privileged; it names no person.
 */
export async function orgTimeZone(orgId: string): Promise<string> {
  const { withPrivilegedDb } = await import("~/db/privileged")
  const rows = await withPrivilegedDb(orgId, "deal-board-timezone", async (tx) =>
    extractRows<{ timezone: string | null }>(
      await tx.execute(
        drizzleSql`SELECT timezone FROM ${kernelRel("organizations")} WHERE id = ${orgId}::uuid LIMIT 1`,
      ),
    ),
  )
  const tz = rows[0]?.timezone ?? "UTC"
  try {
    new Intl.DateTimeFormat("en", { timeZone: tz })
    return tz
  } catch {
    return "UTC"
  }
}

export interface BoardDeal {
  taskId: string
  key: string
  title: string
  assigneeId: string | null
  companyId: string | null
  companyName: string | null
  contactId: string | null
  nextStep: string | null
  closedAt: string | null
  /** Null when the reader cannot read mail. */
  quietDays: number | null
  /** Present only for a reader with deal access. */
  amount?: { amountMinor: number | null; currency: string | null; amountPeriod: string }
}

export interface BoardColumn {
  statusId: string
  label: string
  dealOutcome: "won" | "lost" | null
  count: number
  /** Present only for a reader with deal access: one sum per currency. */
  sums?: Array<{ currency: string; sum_minor: number }>
  deals: BoardDeal[]
}

export interface DealBoard {
  projectId: string
  timeZone: string
  /** The month (in the org's time zone) whose closed deals the Won and Lost columns show. */
  closedMonth: string
  columns: BoardColumn[]
}

const BOARD_DEALS_MAX = 500

/**
 * A pipeline's board as the reader sees it: each stage with its deals and,
 * for a reader with deal access, its sum per currency. Won and Lost show only
 * the deals closed this calendar month in the org's time zone. Open stages put
 * the quietest deal first and a deal whose quiet is unknown last.
 */
export async function dealBoard(
  tx: SqlClient,
  orgId: string,
  scopes: readonly string[],
  projectId: string,
  now: Date = new Date(),
): Promise<DealBoard> {
  if ((await projectKind(tx, orgId, projectId)) !== "pipeline") {
    throw new ProjectsServiceError(404, "not_a_pipeline", "No pipeline you can see has this id.")
  }
  const statuses = extractRows<{ id: string; label: string; deal_outcome: "won" | "lost" | null }>(
    await tx.execute(drizzleSql`
      SELECT id::text AS id, label, deal_outcome FROM ${projectsRel("project_statuses")}
      WHERE project_id = ${projectId}::uuid AND org_id = ${orgId}::uuid
      ORDER BY "order" ASC
    `),
  )
  const timeZone = await orgTimeZone(orgId)
  const month = monthIn(now, timeZone)
  const open = await listDeals(tx, orgId, { projectId, outcome: "open", limit: BOARD_DEALS_MAX })
  // Every deal closed this month in any zone closed within the last 32 days.
  const recent = await listDeals(tx, orgId, {
    projectId,
    closedAfter: new Date(now.getTime() - 32 * DAY_MS).toISOString(),
    limit: BOARD_DEALS_MAX,
  })
  const closed = recent.filter(
    (d) => d.outcome !== "open" && d.closedAt && monthIn(new Date(d.closedAt), timeZone) === month,
  )
  const deals = [...open, ...closed]
  const quiet = await readDealQuiet(tx, orgId, scopes, open, now)
  const dealAccess = hasScope("projects:deals:read", [...scopes])

  const columns: BoardColumn[] = statuses.map((s) => {
    const inColumn = deals.filter((d) => d.statusId === s.id)
    const cards: BoardDeal[] = inColumn.map((d) => ({
      taskId: d.taskId,
      key: d.key,
      title: d.title,
      assigneeId: d.assigneeId,
      companyId: d.companyId,
      companyName: d.companyName,
      contactId: d.contactId,
      nextStep: d.nextStep,
      closedAt: d.closedAt,
      quietDays: d.outcome === "open" ? (quiet?.get(d.taskId)?.quietDays ?? null) : null,
      ...(dealAccess && d.value
        ? {
            amount: {
              amountMinor: d.value.amountMinor,
              currency: d.value.currency,
              amountPeriod: d.value.amountPeriod,
            },
          }
        : {}),
    }))
    if (s.deal_outcome === null) {
      cards.sort((a, b) => {
        if (a.quietDays === b.quietDays) return a.key.localeCompare(b.key)
        if (a.quietDays === null) return 1
        if (b.quietDays === null) return -1
        return b.quietDays - a.quietDays
      })
    } else {
      cards.sort((a, b) => (b.closedAt ?? "").localeCompare(a.closedAt ?? ""))
    }
    const column: BoardColumn = {
      statusId: s.id,
      label: s.label,
      dealOutcome: s.deal_outcome,
      count: cards.length,
      deals: cards,
    }
    if (dealAccess) column.sums = sumsByCurrency(inColumn, () => 1)
    return column
  })
  return { projectId, timeZone, closedMonth: month, columns }
}

function sumsByCurrency(
  deals: readonly DealRow[],
  weight: (d: DealRow) => number,
): Array<{ currency: string; sum_minor: number }> {
  const sums = new Map<string, number>()
  for (const d of deals) {
    const v = d.value
    if (!v || v.amountMinor === null || !v.currency) continue
    sums.set(v.currency, (sums.get(v.currency) ?? 0) + v.amountMinor * weight(d))
  }
  return [...sums.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([currency, sum]) => ({ currency, sum_minor: Math.round(sum) }))
}

// ---------------------------------------------------------------------------
// Rollup
// ---------------------------------------------------------------------------

export interface DealRollupArgs {
  projectId?: string
  groupBy: "stage" | "owner" | "month"
  weighted?: boolean
  closedAfter?: string
  closedBefore?: string
}

export interface DealRollupGroup {
  key: string
  label: string | null
  count: number
  sumByCurrency: Array<{ currency: string; sum_minor: number }>
  weightedByCurrency?: Array<{ currency: string; sum_minor: number }>
}

/**
 * Deal counts and amounts grouped by stage, owner or month (the month a deal
 * closed, or was created while open, in the org's time zone), one sum per
 * currency, never converted. `weighted` also gives the sum times each deal's
 * probability (a deal with none counts 0).
 */
export async function dealsRollup(
  tx: SqlClient,
  orgId: string,
  args: DealRollupArgs,
): Promise<{ groups: DealRollupGroup[]; dealCount: number; truncated: boolean }> {
  const deals = await listDeals(tx, orgId, {
    ...(args.projectId ? { projectId: args.projectId } : {}),
    ...(args.closedAfter ? { closedAfter: args.closedAfter } : {}),
    ...(args.closedBefore ? { closedBefore: args.closedBefore } : {}),
    limit: BOARD_DEALS_MAX,
  })
  const timeZone = args.groupBy === "month" ? await orgTimeZone(orgId) : "UTC"
  const groups = new Map<string, { label: string | null; rows: DealRow[] }>()
  for (const d of deals) {
    const [key, label] =
      args.groupBy === "stage"
        ? [d.statusId, d.statusLabel]
        : args.groupBy === "owner"
          ? [d.assigneeId ?? "unassigned", null]
          : [monthIn(new Date(d.closedAt ?? d.createdAt), timeZone), null]
    const g = groups.get(key) ?? { label, rows: [] }
    g.rows.push(d)
    groups.set(key, g)
  }
  return {
    dealCount: deals.length,
    truncated: deals.length >= BOARD_DEALS_MAX,
    groups: [...groups.entries()].map(([key, g]) => ({
      key,
      label: g.label,
      count: g.rows.length,
      sumByCurrency: sumsByCurrency(g.rows, () => 1),
      ...(args.weighted
        ? { weightedByCurrency: sumsByCurrency(g.rows, (d) => (d.value?.probability ?? 0) / 100) }
        : {}),
    })),
  }
}

// ---------------------------------------------------------------------------
// Follow-up candidates
// ---------------------------------------------------------------------------

export type FollowupSkip =
  | "not_quiet"
  | "no_contact"
  | "opted_out"
  | "no_basis"
  | "consumer"
  | "consumer_unknown"
  | "country_needs_consent"
  | "draft_waiting"
  | "mail_not_visible"
  | "no_sender"

export interface FollowupCandidate {
  taskId: string
  key: string
  title: string
  ownerId: string | null
  companyId: string | null
  contactId: string | null
  /** The contact's name and address: who the follow-up is written to. */
  contactName: string | null
  address: string | null
  contactIds: string[]
  lastInboundAt: string | null
  lastOutboundAt: string | null
  quietDays: number | null
  /** The deal owner's mailbox the caller can send from: the `accountId` to draft from. */
  accountId: string | null
  skip: FollowupSkip | null
}

const BASIS_SKIPS = new Set<FollowupSkip>([
  "no_basis",
  "consumer",
  "consumer_unknown",
  "country_needs_consent",
])

/** Deal task ids with a pending mail draft naming them (a draft waiting for approval). */
async function dealsWithWaitingDraft(
  tx: SqlClient,
  orgId: string,
  taskIds: readonly string[],
): Promise<Set<string>> {
  if (taskIds.length === 0) return new Set()
  const rows = await rowsOrNull<{ id: string }>(
    tx,
    drizzleSql`
      SELECT DISTINCT ref->>'id' AS id
      FROM ${kernelRel("approval_requests")} ar,
           jsonb_array_elements(COALESCE(ar.current_payload->'sendGuard'->'refs', '[]'::jsonb)) AS ref
      WHERE ar.org_id = ${orgId}::uuid AND ar.status = 'pending'
        AND ar.tool_name IN ('mail:compose', 'mail:reply')
        AND ref->>'kind' = 'projects:deal'
        AND ref->>'id' = ANY(${`{${taskIds.join(",")}}`}::text[])
    `,
  )
  return new Set((rows ?? []).map((r) => r.id))
}

/** The oldest connected mailbox of each owner among the rows `db` can read. */
function senderMailboxQuery(orgId: string, ownerIds: readonly string[]): SQL {
  return drizzleSql`
    SELECT DISTINCT ON (a.owner_id) a.id::text AS id, a.owner_id::text AS owner_id
    FROM ${drizzleSql.raw(`${schemaRef("app_mail")}.accounts`)} a
    WHERE a.org_id = ${orgId}::uuid AND a.owner_type = 'user'
      AND a.owner_id = ANY(${`{${ownerIds.join(",")}}`}::uuid[])
      AND a.disconnected_at IS NULL
      AND COALESCE(a.sync_status, '') <> 'disconnected'
    ORDER BY a.owner_id, a.created_at, a.id
  `
}

/**
 * For each deal owner, the mailbox of theirs a follow-up may go from: the
 * caller's own mailbox for the caller's own deals, and for another owner's
 * deals one of that owner's mailboxes the caller can see under row-level
 * security (shared with them). A personal mailbox of someone else is never
 * visible, so a deal it would have to go from has no sender. Never another
 * mailbox in its place: a follow-up signed by the deal's owner leaves from the
 * owner's mailbox or not at all.
 *
 * The caller's own mailbox is read by owner, outside row-level security, so a
 * person who sends from their mailbox without the mailbox-listing scope is not
 * told they have none; it names only the caller's own mailbox.
 */
async function senderMailboxes(
  tx: SqlClient,
  orgId: string,
  callerUserId: string | null,
  ownerIds: readonly string[],
): Promise<Map<string, string>> {
  const out = new Map<string, string>()
  const others = ownerIds.filter((id) => id !== callerUserId)
  if (callerUserId && ownerIds.includes(callerUserId)) {
    const { withPrivilegedDb } = await import("~/db/privileged")
    const own = await withPrivilegedDb(orgId, "deal-followup-own-mailbox", async (db) =>
      extractRows<{ id: string; owner_id: string }>(
        await db.execute(senderMailboxQuery(orgId, [callerUserId])),
      ),
    ).catch(() => [])
    for (const r of own) out.set(r.owner_id, r.id)
  }
  if (others.length > 0) {
    const rows =
      (await rowsOrNull<{ id: string; owner_id: string }>(tx, senderMailboxQuery(orgId, others))) ??
      []
    for (const r of rows) out.set(r.owner_id, r.id)
  }
  return out
}

/**
 * The open deals of the pipelines the caller reads, each with whether a
 * follow-up may be drafted now (`skip` null) or why not, decided here and not
 * by a model: the mail is not readable, the deal has no person, it is not
 * quiet enough, the person opted out or may not be written to, the caller
 * cannot send from the deal owner's mailbox, or a draft is already waiting.
 */
export async function followupCandidates(
  tx: SqlClient,
  orgId: string,
  scopes: readonly string[],
  args: { quietDays: number; projectId?: string; callerUserId?: string | null },
  now: Date = new Date(),
): Promise<FollowupCandidate[]> {
  const deals = await listDeals(tx, orgId, {
    outcome: "open",
    ...(args.projectId ? { projectId: args.projectId } : {}),
    limit: BOARD_DEALS_MAX,
  })
  const quiet = await readDealQuiet(tx, orgId, scopes, deals, now)
  const waiting = await dealsWithWaitingDraft(
    tx,
    orgId,
    deals.map((d) => d.taskId),
  )
  const emails = new Map<string, string>()
  const names = new Map<string, string>()
  const allContactIds = [...new Set(deals.flatMap((d) => quiet?.get(d.taskId)?.contactIds ?? []))]
  if (allContactIds.length > 0) {
    const rows =
      (await rowsOrNull<{ id: string; email: string | null; name: string | null }>(
        tx,
        drizzleSql`SELECT id::text AS id, lower(email) AS email, name FROM ${kernelRel("contacts")}
          WHERE org_id = ${orgId}::uuid AND id = ANY(${`{${allContactIds.join(",")}}`}::uuid[])`,
      )) ?? []
    for (const r of rows) {
      if (r.email) emails.set(r.id, r.email)
      if (r.name) names.set(r.id, r.name)
    }
  }
  const senders = await senderMailboxes(tx, orgId, args.callerUserId ?? null, [
    ...new Set(deals.map((d) => d.assigneeId).filter((x): x is string => !!x)),
  ])
  const out: FollowupCandidate[] = []
  for (const d of deals) {
    const q = quiet?.get(d.taskId) ?? null
    const contactIds = q?.contactIds ?? (d.contactId ? [d.contactId] : [])
    const recipient = d.contactId ?? contactIds[0] ?? null
    let skip: FollowupSkip | null = null
    if (!d.contactId && !d.companyId) skip = "no_contact"
    else if (quiet === null) skip = "mail_not_visible"
    else if (q === null || !recipient) skip = "no_contact"
    else if (q.quietDays < args.quietDays) skip = "not_quiet"
    else {
      const address = emails.get(recipient)
      if (!address) skip = "no_contact"
      else if ((await suppressions.suppressedAmong(orgId, [address])).length > 0) skip = "opted_out"
      else {
        const problem = await suppressions.lawfulBasisProblem(orgId, [recipient], [address])
        if (problem) {
          skip = BASIS_SKIPS.has(problem.code as FollowupSkip)
            ? (problem.code as FollowupSkip)
            : "no_basis"
        } else if (!d.assigneeId || !senders.has(d.assigneeId)) skip = "no_sender"
        else if (waiting.has(d.taskId)) skip = "draft_waiting"
      }
    }
    out.push({
      taskId: d.taskId,
      key: d.key,
      title: d.title,
      ownerId: d.assigneeId,
      companyId: d.companyId,
      contactId: recipient,
      contactName: recipient ? (names.get(recipient) ?? null) : null,
      address: recipient ? (emails.get(recipient) ?? null) : null,
      contactIds,
      lastInboundAt: q?.lastInboundAt ?? null,
      lastOutboundAt: q?.lastOutboundAt ?? null,
      quietDays: q?.quietDays ?? null,
      accountId: d.assigneeId ? (senders.get(d.assigneeId) ?? null) : null,
      skip,
    })
  }
  return out
}

// ---------------------------------------------------------------------------
// The send guard's say over a mail about a deal
// ---------------------------------------------------------------------------

export type DealSendState =
  | { stop: false }
  | { stop: true; code: "deal_closed" | "deal_deleted"; label: string }

/**
 * Whether a mail about a deal may still leave: an open deal passes; a won or
 * lost one stops (`deal_closed`); a missing or deleted (archived) task stops
 * (`deal_deleted`).
 */
export async function dealSendState(
  tx: SqlClient,
  orgId: string,
  taskId: string,
): Promise<DealSendState> {
  const rows = /^[0-9a-f-]{36}$/i.test(taskId)
    ? extractRows<{ title: string; outcome: DealOutcome; archived: boolean }>(
        await tx.execute(drizzleSql`
          SELECT t.title, d.outcome, (t.archived_at IS NOT NULL) AS archived
          FROM ${projectsRel("deals")} d
          JOIN ${projectsRel("tasks")} t ON t.id = d.task_id AND t.org_id = d.org_id
          WHERE d.task_id = ${taskId}::uuid AND d.org_id = ${orgId}::uuid
          LIMIT 1
        `),
      )
    : []
  const row = rows[0]
  if (!row || row.archived) {
    return {
      stop: true,
      code: "deal_deleted",
      label: "The deal this mail is about was deleted",
    }
  }
  if (row.outcome !== "open") {
    return {
      stop: true,
      code: "deal_closed",
      label: `${row.title} is closed`,
    }
  }
  return { stop: false }
}
