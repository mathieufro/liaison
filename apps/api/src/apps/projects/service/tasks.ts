// SPDX-License-Identifier: FSL-1.1-ALv2
import { randomUUID } from "node:crypto"
import { sql as drizzleSql } from "drizzle-orm"
import { kernelRel, projectsRel } from "~/apps/projects/schema-refs"
import { extractRows, type RlsClient } from "~/db"
import type { UserContext } from "~/db/rls"
import { updateItemRoutePerson } from "~/modules/approvals/route-world"
import { appendChecklistOnMerge, readItems, readProjectLevels } from "./checklist"
import { type ChecklistStatus, checklistStatus } from "./checklist-status"
import { dueBucketSql } from "./due-status"
import {
  computeNextCompletedAt,
  computePosition,
  ensureProjectMutableForTasks,
  MAX_TASK_DEPTH,
  statusIsTerminal,
} from "./move-task"
import { normalizeRelease, releaseFilterSql } from "./release-filter"
import { assertTaskPriority, resolveAssignee, resolveStatusRef } from "./resolve"
import { ProjectsServiceError } from "./statuses"
import {
  type AssigneeRef,
  type DbTaskRow,
  loadTaskDetails,
  type Task,
  type TaskListDbRow,
  type TaskSummary,
  taskFromRow,
  taskSummaryFromRow,
  toIso,
} from "./task-detail"
import { formatTaskKey } from "./task-key"
import {
  applyTaskLabels,
  attachTaskLabels,
  type LabelInput,
  labelFilterCondition,
  resolveLabelInput,
} from "./task-labels"

export type { AssigneeRef, Task, TaskSummary } from "./task-detail"

export interface CreateTaskInput {
  projectId: string
  statusId?: string
  /** Status column by (case-insensitive) label — agent-ergonomic alternative to statusId. */
  statusLabel?: string | null
  parentTaskId?: string | null
  title: string
  description?: string | null
  assigneeId?: string | null
  priority?: string
  dueDate?: string | null
  startDate?: string | null
  blocked?: boolean
  /** Free-text release: trimmed, empty stores NULL, 1..RELEASE_MAX chars. */
  release?: string | null
  beforeTaskId?: string | null
  afterTaskId?: string | null
  /**
   * Bulk-import backdating (mirror of `createTicket`'s `createdAt` semantics,
   * apps/tickets/create.ts): imported/historical tasks may carry their real
   * creation time — when supplied, the task's `created_at` is anchored to it
   * instead of `now()`. ISO-8601; an unparsable value fails loudly.
   *
   * Deliberately NOT backdated: `updated_at` (the import IS the last touch),
   * the task's kernel thread `created_at` (the thread is created at import
   * time), `position` (board ordering is orthogonal to age), and the
   * `task:created` event (it records when the row appeared in THIS system).
   * `completed_at` is carried separately by `completedAt` below.
   */
  createdAt?: string | null
  /**
   * Bulk-import ONLY (never set from a request handler or an app bridge): the
   * source's resolution time. ISO-8601, validated like `createdAt` (an
   * unparsable value fails loudly with `invalid_completed_at`). Stored as
   * `completed_at` only when the resolved status is terminal; on a non-terminal
   * status it is ignored, because a ticket that is not done has no completion
   * (the same invariant `computeNextCompletedAt` keeps on a move).
   */
  completedAt?: string | null
  /**
   * Bulk-import ONLY: the kernel.users id of the historical author (the
   * source's reporter). Must belong to `orgId` (any status), else 404
   * `created_by_not_found`. Lands on the task's and its thread's `created_by`;
   * enrolled as a thread participant ONLY when the user is active (a
   * deactivated author or import placeholder must never receive reply
   * attention or digest mail). Absent → the actor, as for every live caller. The
   * `task:created` event keeps the actor: the importer is who acted here.
   */
  createdBy?: string | null
  /**
   * Bulk-import ONLY: accept an assignee whose account is not active (a person
   * who has left, or a deactivated placeholder the importer created so
   * attribution stays exact). Live callers keep the active-only rule.
   */
  allowInactiveAssignee?: boolean
  /**
   * Set when an agent creates the task (the projects bridge, from the acting
   * agent or routine): the attribution label the task header shows instead of
   * the person in `created_by` ("Routine <name>", a named agent, or
   * "<person>'s agent"). Absent for a person.
   */
  createdByAgentLabel?: string | null
  /**
   * Bulk-import idempotency key (source system's stable id — mirror of
   * `app_tickets.tickets.external_ref`). NOTE: createTask does NOT dedup on it;
   * the partial unique index `uniq_app_projects_tasks_external_ref` makes a
   * duplicate THROW — importers must pre-SELECT (same contract as tickets).
   */
  externalRef?: string | null
  /**
   * Own label values: key = label group name or id, value = value
   * name or id (null: no own value). Resolved before any write; an unknown or
   * archived value refuses the whole create (`label_not_found` /
   * `label_archived`). See `task-labels.ts`.
   */
  labels?: LabelInput
}

export interface CreateTaskArgs {
  tx: RlsClient
  orgId: string
  actor: UserContext
  input: CreateTaskInput
}

async function resolveStatusId(
  tx: RlsClient,
  orgId: string,
  projectId: string,
  preferred?: { statusId?: string | null; statusLabel?: string | null },
): Promise<string> {
  if (preferred?.statusId || preferred?.statusLabel) {
    return resolveStatusRef(tx, orgId, projectId, preferred)
  }
  const rows = extractRows<{ id: string }>(
    await tx.execute(drizzleSql`
      SELECT id FROM ${projectsRel("project_statuses")}
      WHERE project_id = ${projectId}::uuid AND org_id = ${orgId}::uuid
      ORDER BY "order" ASC
      LIMIT 1
    `),
  )
  if (rows.length === 0) {
    throw new ProjectsServiceError(409, "no_statuses", "project has no statuses")
  }
  return rows[0]!.id
}

/**
 * Append a `Source: <url> (web-sourced — verify)` citation line to a task body when the task was
 * built from web research. Used by the `create` task tool's `sourceUrl` param so a citation is an
 * enforceable, discrete input — the host guarantees the URL lands in the STORED body even if the
 * weak model omits it from its free-text description (the documented competitive-teardown failure
 * where price/expression tasks were cited but connectivity/software dropped the URL).
 *
 * Idempotent: if `sourceUrl` is blank, the description is returned unchanged; if the description
 * ALREADY contains that exact URL (the agent inlined it itself), no duplicate line is appended.
 */
export function appendSourceCitation(
  description: string | null | undefined,
  sourceUrl: string | null | undefined,
): string | null | undefined {
  const url = sourceUrl?.trim()
  if (!url) return description
  const body = description ?? ""
  // Don't double-cite: if the agent already put this URL anywhere in the body, leave it alone.
  if (body.includes(url)) return description
  const citation = `Source: ${url} (web-sourced — verify)`
  return body.length > 0 ? `${body}\n\n${citation}` : citation
}

export async function createTask(args: CreateTaskArgs): Promise<TaskDetail> {
  const { tx, orgId, actor, input } = args
  return tx.transaction(async (innerTx) => {
    await ensureProjectMutableForTasks(innerTx, orgId, input.projectId)
    const release = normalizeRelease(input.release) ?? null
    const statusId = await resolveStatusId(innerTx as RlsClient, orgId, input.projectId, input)
    assertTaskPriority(input.priority)
    const labelAssignments = await resolveLabelInput(innerTx as RlsClient, orgId, input.labels)

    const assigneeId = input.assigneeId
      ? await resolveAssignee(
          innerTx as RlsClient,
          orgId,
          { assigneeId: input.assigneeId },
          { allowInactive: input.allowInactiveAssignee === true },
        )
      : null

    if (input.parentTaskId) {
      const parentRows = extractRows<{ id: string; project_id: string }>(
        await innerTx.execute(drizzleSql`
          SELECT id, project_id FROM ${projectsRel("tasks")}
          WHERE id = ${input.parentTaskId}::uuid AND org_id = ${orgId}::uuid LIMIT 1
        `),
      )
      const parent = parentRows[0]
      if (!parent) {
        throw new ProjectsServiceError(404, "parent_not_found", "parent task not found")
      }
      if (parent.project_id !== input.projectId) {
        throw new ProjectsServiceError(
          400,
          "cross_project_move",
          "parent task is in a different project",
        )
      }
      // Walk ancestors to compute parent depth; new child sits at depth + 1.
      const depthRows = extractRows<{ depth: number | null }>(
        await innerTx.execute(drizzleSql`
          WITH RECURSIVE ancestors AS (
            SELECT id, parent_task_id, 1 AS depth
            FROM ${projectsRel("tasks")}
            WHERE id = ${input.parentTaskId}::uuid AND org_id = ${orgId}::uuid
            UNION ALL
            SELECT t.id, t.parent_task_id, a.depth + 1
            FROM ${projectsRel("tasks")} t
            JOIN ancestors a ON t.id = a.parent_task_id
            WHERE t.org_id = ${orgId}::uuid
          )
          SELECT MAX(depth) AS depth FROM ancestors
        `),
      )
      const parentDepth = depthRows[0]?.depth ?? 1
      if (parentDepth + 1 > MAX_TASK_DEPTH) {
        throw new ProjectsServiceError(
          400,
          "task_depth_exceeded",
          `depth budget exceeded (max ${MAX_TASK_DEPTH})`,
        )
      }
    }

    // Validate the optional backdate BEFORE any insert so a bad value fails
    // the whole create cleanly (import semantics — see CreateTaskInput).
    let createdAtIso: string | null = null
    if (input.createdAt) {
      const parsed = new Date(input.createdAt)
      if (Number.isNaN(parsed.getTime())) {
        throw new ProjectsServiceError(
          400,
          "invalid_created_at",
          `createdAt is not a valid ISO-8601 timestamp: "${input.createdAt}"`,
        )
      }
      createdAtIso = parsed.toISOString()
    }
    let completedAtIso: string | null = null
    if (input.completedAt) {
      const parsed = new Date(input.completedAt)
      if (Number.isNaN(parsed.getTime())) {
        throw new ProjectsServiceError(
          400,
          "invalid_completed_at",
          `completedAt is not a valid ISO-8601 timestamp: "${input.completedAt}"`,
        )
      }
      // Only a terminal status carries a completion (see CreateTaskInput).
      if (await statusIsTerminal(innerTx, orgId, statusId)) {
        completedAtIso = parsed.toISOString()
      }
    }
    const createdBy = input.createdBy ?? actor.userId
    // An override must name a user of THIS org (any status: a leaver or an
    // import placeholder keeps exact authorship). The tasks.created_by FK
    // alone would accept a user of another org. Only an ACTIVE author is
    // enrolled as participant below: participants receive reply attention
    // rows and digest mail, which a deactivated account must never get.
    let enrolCreatedBy = false
    if (createdBy !== actor.userId) {
      const authorRows = extractRows<{ status: string }>(
        await innerTx.execute(drizzleSql`
          SELECT status FROM ${kernelRel("users")}
          WHERE id = ${createdBy}::uuid AND org_id = ${orgId}::uuid
          LIMIT 1
        `),
      )
      if (!authorRows[0]) {
        throw new ProjectsServiceError(404, "created_by_not_found", "createdBy user not found")
      }
      enrolCreatedBy = authorRows[0].status === "active"
    }

    const agentLabel = input.createdByAgentLabel?.trim() || null
    const taskId = randomUUID()
    const threadId = randomUUID()
    const handle = `proj-task-${taskId.slice(0, 12)}`
    // Hidden from the global thread list by default — the thread lives WITHIN
    // the task. Users can "promote" via PATCH /api/threads/:id with
    // hiddenFromList=false to surface it in their sidebar.
    await innerTx.execute(drizzleSql`
      INSERT INTO ${kernelRel("threads")}
        (id, org_id, handle, type, hidden_from_list, created_from, created_by)
      VALUES (
        ${threadId}::uuid,
        ${orgId}::uuid,
        ${handle},
        'thread',
        true,
        ${JSON.stringify({ app: "projects", entityType: "task", entityId: taskId })}::jsonb,
        ${createdBy}::uuid
      )
    `)
    await innerTx.execute(drizzleSql`
      INSERT INTO ${kernelRel("thread_participants")} (thread_id, user_id, org_id)
      VALUES (${threadId}::uuid, ${actor.userId}::uuid, ${orgId}::uuid)
      ON CONFLICT DO NOTHING
    `)
    // An imported ACTIVE author reads and comments on their own task like its
    // creator (a deactivated one stays author only — see above).
    if (enrolCreatedBy) {
      await innerTx.execute(drizzleSql`
        INSERT INTO ${kernelRel("thread_participants")} (thread_id, user_id, org_id)
        VALUES (${threadId}::uuid, ${createdBy}::uuid, ${orgId}::uuid)
        ON CONFLICT DO NOTHING
      `)
    }

    const position = await computePosition(innerTx, orgId, {
      projectId: input.projectId,
      statusId,
      parentTaskId: input.parentTaskId ?? null,
      beforeTaskId: input.beforeTaskId,
      afterTaskId: input.afterTaskId,
    })

    // Atomic per-project task-number allocation: a SECURITY DEFINER function
    // (not a raw UPDATE) against the project's counter, so concurrent
    // createTask calls on the same project never race onto the same number
    // (no global sequence — see apps/projects/service/task-key.ts for the
    // display format). The raw UPDATE would be gated by the projects_update
    // RLS policy (projects:projects:write), which a caller who only holds
    // projects:tasks:write (e.g. the member role) does not have; the function
    // narrows the privilege to just this counter column and checks
    // projects:tasks:write itself instead.
    const numberRows = extractRows<{ number: number | null }>(
      await innerTx.execute(drizzleSql`
        SELECT ${projectsRel("allocate_task_number")}(${input.projectId}::uuid) AS number
      `),
    )
    const taskNumber = numberRows[0]?.number
    if (taskNumber == null) {
      throw new ProjectsServiceError(404, "project_not_found", "project not found")
    }

    await innerTx.execute(drizzleSql`
      INSERT INTO ${projectsRel("tasks")}
        (id, org_id, project_id, parent_task_id, status_id, number, title, description,
         assignee_id, priority, due_date, start_date, position, blocked, thread_id, created_by,
         external_ref, release, created_at, completed_at, created_by_agent_label)
      VALUES (
        ${taskId}::uuid,
        ${orgId}::uuid,
        ${input.projectId}::uuid,
        ${input.parentTaskId ? drizzleSql`${input.parentTaskId}::uuid` : drizzleSql`NULL`},
        ${statusId}::uuid,
        ${taskNumber},
        ${input.title},
        ${input.description ?? null},
        ${assigneeId ? drizzleSql`${assigneeId}::uuid` : drizzleSql`NULL`},
        ${input.priority ?? "normal"},
        ${input.dueDate ?? null},
        ${input.startDate ?? null},
        ${position},
        ${input.blocked ?? false},
        ${threadId}::uuid,
        ${createdBy}::uuid,
        ${input.externalRef ?? null},
        ${release},
        ${createdAtIso ? drizzleSql`${createdAtIso}::timestamptz` : drizzleSql`now()`},
        ${completedAtIso ? drizzleSql`${completedAtIso}::timestamptz` : drizzleSql`NULL`},
        ${agentLabel}
      )
    `)

    await applyTaskLabels(innerTx as RlsClient, orgId, taskId, labelAssignments)

    // The event carries the full row as written (key, number, position,
    // resolved status) so a live client can render it without a refetch.
    const detail = await loadTaskDetail(innerTx as RlsClient, orgId, taskId)
    await innerTx.queueEvent({
      app: "projects",
      entity: "task",
      action: "created",
      entityId: taskId,
      data: detail,
      actorId: actor.userId,
      actorType: "user",
      orgId,
    })

    return detail
  })
}

export interface GetTaskArgs {
  tx: RlsClient
  orgId: string
  projectId?: string
  taskId: string
  /**
   * The user opening the task. When set, opening a task the caller can read
   * lazily enrolls them as a participant of the task's discussion thread, so
   * the kernel `threads_select` / `messages` RLS (participant-gated) lets them
   * read and comment. Task threads are created with only their creator as a
   * participant; without this, any org member who did not create the task hits
   * a 404 on `GET /threads/:threadId` and the task-detail tab error-boundaries.
   * Task visibility is the authority here (projects are org-visible via the
   * `projects:projects:read` scope, not per-project membership), so anyone who
   * can load the task is entitled to its thread.
   */
  viewerId?: string
  /**
   * Resolve a task that is in the BIN (soft-deleted, `archived_at` set).
   *
   * Default false: a deleted task must read as gone, exactly as `listTasks`
   * has always excluded it. Before this flag `getTask` had no archived filter
   * at all, so a binned task still resolved by direct id — its URL rendered a
   * live-looking detail pane you could go on editing, while the board that
   * deleted it showed nothing.
   *
   * Set it ONLY where the caller must reach a binned row on purpose: the
   * delete route's project-boundary check (so deleting twice stays idempotent)
   * and the restore route's (the task is binned by definition).
   */
  includeArchived?: boolean
}

export type TaskDetail = TaskSummary

async function loadTaskDetail(
  tx: RlsClient,
  orgId: string,
  taskId: string,
  projectId?: string,
  includeArchived = false,
): Promise<TaskDetail> {
  const [row] = await loadTaskDetails(tx, orgId, [taskId], { projectId, includeArchived })
  if (!row) throw new ProjectsServiceError(404, "not_found", "task not found")
  return row
}

export async function getTask(args: GetTaskArgs): Promise<TaskDetail> {
  const detail = await loadTaskDetail(
    args.tx,
    args.orgId,
    args.taskId,
    args.projectId,
    args.includeArchived,
  )
  // Read access to the task (proven by loadTaskDetail not throwing 404) entitles
  // the viewer to the task's discussion thread. Lazily enroll them so the
  // participant-gated kernel thread/message RLS lets them open and comment.
  if (args.viewerId && detail.threadId) {
    await ensureThreadParticipant(args.tx, args.orgId, detail.threadId, args.viewerId)
  }
  return detail
}

/**
 * Idempotently make `userId` a participant of `threadId`. Self-insert is
 * permitted by the kernel `tp_insert` RLS policy (`user_id = current_user_id`),
 * so this works even for a thread the caller could not previously see. Also
 * seeds `user_thread_state` so per-user thread flags (mute/archive/read) exist.
 */
async function ensureThreadParticipant(
  tx: RlsClient,
  orgId: string,
  threadId: string,
  userId: string,
): Promise<void> {
  // Read first, not `INSERT … RETURNING`: the participant-gated SELECT policy
  // cannot see a row the same statement inserts, so RETURNING is refused.
  const [already] = extractRows<{ one: number }>(
    await tx.execute(drizzleSql`
      SELECT 1 AS one FROM ${kernelRel("thread_participants")}
      WHERE thread_id = ${threadId}::uuid AND user_id = ${userId}::uuid
      LIMIT 1
    `),
  )
  await tx.execute(drizzleSql`
    INSERT INTO ${kernelRel("thread_participants")} (thread_id, user_id, org_id, role)
    VALUES (${threadId}::uuid, ${userId}::uuid, ${orgId}::uuid, 'member')
    ON CONFLICT DO NOTHING
  `)
  // A new membership is announced like any other join: the realtime layer
  // delivers a thread's messages only to sockets it knows are members, and it
  // learns that from this event. Without it the viewer's open socket stays
  // deaf to the discussion they just joined (a teammate's or an agent's reply
  // shows only after a reload).
  if (!already) {
    const [user] = extractRows<{ name: string | null }>(
      await tx.execute(drizzleSql`
        SELECT name FROM ${kernelRel("users")} WHERE id = ${userId}::uuid LIMIT 1
      `),
    )
    await tx.queueEvent({
      app: "kernel",
      entity: "participant",
      action: "add",
      entityId: threadId,
      orgId,
      actorId: userId,
      data: { threadId, userId, userName: user?.name ?? undefined },
    })
  }
  await tx.execute(drizzleSql`
    INSERT INTO ${kernelRel("user_thread_state")} (thread_id, user_id, org_id)
    VALUES (${threadId}::uuid, ${userId}::uuid, ${orgId}::uuid)
    ON CONFLICT DO NOTHING
  `)
}

export interface ListTasksFilters {
  statusId?: string
  assigneeId?: string
  /** `this_week` is a back-compat alias for `due_soon` (same bucket). */
  due?: "overdue" | "due_soon" | "later" | "none" | "this_week"
  priority?: "low" | "normal" | "high" | "urgent"
  parentTaskId?: string | "root"
  view?: "flat" | "tree"
  /**
   * The TRASH selector. Deleting a task soft-deletes it (`archived_at`), so the
   * rows still exist and are recoverable — but nothing could list them, which
   * made the bin write-only. `only` is the bin view, `include` shows both.
   * Defaults to `exclude`: the board must never surface deleted work.
   */
  archived?: "only" | "include" | "exclude"
  /** Effective release (own, else nearest ancestor), case-insensitive;
   *  RELEASE_NONE ("__none__") selects tasks with no effective release. */
  release?: string
  /**
   * Effective-label filter: group name/id to value name/id, or
   * "__none__" for no effective value; AND across groups; archived accepted.
   * An unknown group or value refuses with `label_not_found`.
   */
  labels?: LabelInput
}

export interface ListTasksArgs {
  tx: RlsClient
  orgId: string
  projectId: string
  filters?: ListTasksFilters
}

export async function listTasks(args: ListTasksArgs): Promise<{ items: TaskSummary[] }> {
  const filters = args.filters ?? {}
  const view = filters.view ?? "flat"

  const conditions: ReturnType<typeof drizzleSql>[] = [
    drizzleSql`t.org_id = ${args.orgId}::uuid`,
    drizzleSql`t.project_id = ${args.projectId}::uuid`,
  ]
  const archived = filters.archived ?? "exclude"
  if (archived === "exclude") conditions.push(drizzleSql`t.archived_at IS NULL`)
  else if (archived === "only") conditions.push(drizzleSql`t.archived_at IS NOT NULL`)
  if (filters.statusId) conditions.push(drizzleSql`t.status_id = ${filters.statusId}::uuid`)
  if (filters.assigneeId) conditions.push(drizzleSql`t.assignee_id = ${filters.assigneeId}::uuid`)
  if (filters.priority) conditions.push(drizzleSql`t.priority = ${filters.priority}`)
  if (filters.parentTaskId === "root") {
    conditions.push(drizzleSql`t.parent_task_id IS NULL`)
  } else if (filters.parentTaskId) {
    conditions.push(drizzleSql`t.parent_task_id = ${filters.parentTaskId}::uuid`)
  }
  if (filters.due) {
    const bucket = filters.due === "this_week" ? "due_soon" : filters.due
    conditions.push(drizzleSql`${dueBucketSql("t", "s")} = ${bucket}`)
  }
  const releaseCond = releaseFilterSql("t", args.orgId, filters.release)
  if (releaseCond) conditions.push(releaseCond)
  const labelCond = await labelFilterCondition(args.tx, args.orgId, "t", filters.labels)
  if (labelCond) conditions.push(labelCond)
  const whereSql = conditions.reduce<ReturnType<typeof drizzleSql>>(
    (acc, frag, idx) => (idx === 0 ? frag : drizzleSql`${acc} AND ${frag}`),
    drizzleSql``,
  )

  const rows = extractRows<TaskListDbRow>(
    await args.tx.execute(drizzleSql`
      WITH RECURSIVE depth_cte AS (
        SELECT id, parent_task_id, 1 AS depth
        FROM ${projectsRel("tasks")}
        WHERE org_id = ${args.orgId}::uuid
          AND project_id = ${args.projectId}::uuid
          AND parent_task_id IS NULL
        UNION ALL
        SELECT child.id, child.parent_task_id, parent.depth + 1
        FROM ${projectsRel("tasks")} child
        JOIN depth_cte parent ON child.parent_task_id = parent.id
        WHERE child.org_id = ${args.orgId}::uuid
          AND child.project_id = ${args.projectId}::uuid
      )
      SELECT
        t.id, t.org_id, t.project_id, t.parent_task_id, t.status_id, t.number, t.title,
        t.description, t.assignee_id, t.priority, t.due_date, t.start_date,
        t.position, t.blocked, t.completed_at, t.thread_id, t.created_by,
        t.created_at, t.updated_at, t.release, t.created_by_agent_label,
        u.id AS assignee_user_id, u.name AS assignee_name, u.avatar_url AS assignee_avatar_url,
        cu.name AS created_by_name,
        p.key AS project_key,
        COALESCE(d.depth, 1) AS depth,
        COALESCE((SELECT COUNT(*) FROM ${projectsRel("tasks")} c WHERE c.parent_task_id = t.id AND c.archived_at IS NULL), 0) AS child_count
      FROM ${projectsRel("tasks")} t
      LEFT JOIN ${kernelRel("users")} u ON u.id = t.assignee_id AND u.org_id = t.org_id
      -- The creator's name, joined the same way loadTaskDetails does, so a
      -- task tab opened from the list shows "Created by <name>".
      LEFT JOIN ${kernelRel("users")} cu ON cu.id = t.created_by AND cu.org_id = t.org_id
      LEFT JOIN ${projectsRel("project_statuses")} s ON s.id = t.status_id AND s.org_id = t.org_id
      LEFT JOIN ${projectsRel("projects")} p ON p.id = t.project_id AND p.org_id = t.org_id
      LEFT JOIN depth_cte d ON d.id = t.id
      WHERE ${whereSql}
      ORDER BY ${view === "tree" ? drizzleSql`COALESCE(d.depth, 1) ASC, t.position ASC` : drizzleSql`t.status_id, t.position ASC, t.created_at ASC`}
    `),
  )
  const items = rows.map(taskSummaryFromRow)
  // S17: one items query for the whole list plus the project's levels, no N+1.
  const levels = await readProjectLevels(args.tx, args.orgId, args.projectId)
  const itemsByTask = await readItems(
    args.tx,
    args.orgId,
    items.map((t) => t.id),
  )
  for (const task of items) {
    const taskItems = itemsByTask.get(task.id)
    task.checklist = taskItems && taskItems.length > 0 ? checklistStatus(levels, taskItems) : null
  }
  await attachTaskLabels(args.tx, args.orgId, items)
  if (view === "tree") {
    items.sort((a, b) => a.depth - b.depth || a.position - b.position)
  }
  return { items }
}

export interface UpdateTaskInput {
  title?: string
  description?: string | null
  statusId?: string
  /** Status column by (case-insensitive) label — agent-ergonomic alternative to statusId. */
  statusLabel?: string | null
  assigneeId?: string | null
  priority?: string
  dueDate?: string | null
  startDate?: string | null
  blocked?: boolean
  /** Free-text release: trimmed, empty or null clears it, 1..RELEASE_MAX chars. */
  release?: string | null
  /**
   * Own label values to set: key = group name or id, value = value
   * name or id, null clears the task's own value; groups left out are
   * untouched. Any refusal rejects the whole update. See `task-labels.ts`.
   */
  labels?: LabelInput
}

export interface UpdateTaskArgs {
  tx: RlsClient
  orgId: string
  actor: UserContext
  projectId?: string
  taskId: string
  input: UpdateTaskInput
}

export async function updateTask(args: UpdateTaskArgs): Promise<TaskDetail> {
  const { tx, orgId, actor, projectId, taskId, input } = args
  const { detail: updated, assigned } = await tx.transaction(async (innerTx) => {
    // The assignee this update set, if it set one: pending requests about the task follow it.
    let assigned: { personId: string | null } | null = null
    const projectClause = projectId ? drizzleSql`AND project_id = ${projectId}::uuid` : drizzleSql``
    const taskRows = extractRows<{
      project_id: string
      status_id: string
      completed_at: Date | string | null
    }>(
      await innerTx.execute(drizzleSql`
        SELECT project_id, status_id, completed_at
        FROM ${projectsRel("tasks")}
        WHERE id = ${taskId}::uuid AND org_id = ${orgId}::uuid ${projectClause} LIMIT 1
      `),
    )
    const existing = taskRows[0]
    if (!existing) throw new ProjectsServiceError(404, "not_found", "task not found")
    await ensureProjectMutableForTasks(innerTx, orgId, existing.project_id)
    const labelAssignments = await resolveLabelInput(innerTx as RlsClient, orgId, input.labels)

    const sets: ReturnType<typeof drizzleSql>[] = []
    if (input.title !== undefined) sets.push(drizzleSql`title = ${input.title}`)
    if (input.description !== undefined) sets.push(drizzleSql`description = ${input.description}`)
    if (
      input.statusId !== undefined ||
      (input.statusLabel !== undefined && input.statusLabel !== null)
    ) {
      const nextStatusId = await resolveStatusRef(
        innerTx as RlsClient,
        orgId,
        existing.project_id,
        input,
      )
      sets.push(drizzleSql`status_id = ${nextStatusId}::uuid`)
      const completedAt = await computeNextCompletedAt(innerTx, orgId, {
        previousStatusId: existing.status_id,
        nextStatusId,
        previousCompletedAt: existing.completed_at,
      })
      if (completedAt === null) sets.push(drizzleSql`completed_at = NULL`)
      else if (completedAt !== undefined) {
        const iso = completedAt instanceof Date ? completedAt.toISOString() : completedAt
        sets.push(drizzleSql`completed_at = ${iso}::timestamptz`)
      }
    }
    if (input.assigneeId !== undefined) {
      const assigneeId =
        input.assigneeId === null
          ? null
          : await resolveAssignee(innerTx as RlsClient, orgId, { assigneeId: input.assigneeId })
      sets.push(
        assigneeId === null
          ? drizzleSql`assignee_id = NULL`
          : drizzleSql`assignee_id = ${assigneeId}::uuid`,
      )
      assigned = { personId: assigneeId }
    }
    if (input.priority !== undefined) {
      assertTaskPriority(input.priority)
      sets.push(drizzleSql`priority = ${input.priority}`)
    }
    if (input.dueDate !== undefined) sets.push(drizzleSql`due_date = ${input.dueDate}`)
    if (input.startDate !== undefined) sets.push(drizzleSql`start_date = ${input.startDate}`)
    if (input.blocked !== undefined) sets.push(drizzleSql`blocked = ${input.blocked}`)
    const release = normalizeRelease(input.release)
    if (release !== undefined) sets.push(drizzleSql`release = ${release}`)
    sets.push(drizzleSql`updated_at = now()`)

    const setSql = sets.reduce<ReturnType<typeof drizzleSql> | null>(
      (acc, frag) => (acc === null ? frag : drizzleSql`${acc}, ${frag}`),
      null,
    )!
    await innerTx.execute(drizzleSql`
      UPDATE ${projectsRel("tasks")}
      SET ${setSql}
      WHERE id = ${taskId}::uuid AND org_id = ${orgId}::uuid ${projectClause}
    `)
    await applyTaskLabels(innerTx as RlsClient, orgId, taskId, labelAssignments)

    // The event carries the full row AFTER the write (a `statusLabel` input
    // yields the resolved `statusId`, the key, completedAt...), plus the names
    // of the fields the caller set, so a routine can still tell what changed.
    const detail = await loadTaskDetail(innerTx as RlsClient, orgId, taskId, projectId)
    await innerTx.queueEvent({
      app: "projects",
      entity: "task",
      action: "updated",
      entityId: taskId,
      data: {
        ...detail,
        changedFields: Object.keys(input).filter(
          (k) => input[k as keyof UpdateTaskInput] !== undefined,
        ),
      },
      actorId: actor.userId,
      actorType: "user",
      orgId,
    })

    return { detail, assigned }
  })
  if (assigned) {
    // Its own transaction, after the write: a failure is logged and the assignment stands.
    await updateItemRoutePerson({
      orgId,
      app: "projects",
      entityType: "task",
      entityId: taskId,
      personId: assigned.personId,
    })
  }
  return updated
}

// ---------------------------------------------------------------------------
// J1 — cross-project task-by-assignee + soft delete
// ---------------------------------------------------------------------------

export interface CrossProjectTask extends Task {
  projectName: string
  /** The project's short key (e.g. "ERB") — pairs with `number` to form `key`. */
  projectKey: string | null
  /** Display key, e.g. "ERB-12" — null only if the project key/number join failed. */
  key: string | null
  /** The label of the task's status column (e.g. "Open", "Done"), or null if the
   *  status row could not be joined. Lets the caller GROUP/REPORT by status. */
  statusLabel: string | null
  /** Whether the task's status column is terminal (done/cancelled). The
   *  discriminator a "reassign every OPEN task, leave DONE ones untouched" sweep
   *  needs — `tasks_byAssignee` returns ALL of an assignee's tasks, so without
   *  this flag (or the `terminal` filter) a caller cannot tell open from done. */
  statusTerminal: boolean
  /** The assignee's display NAME (joined from kernel.users), or null when the
   *  task is unassigned (or the user row is missing/anonymized). Lets a caller
   *  tally a per-PERSON workload from a single project read and NAME the
   *  most-loaded person — without a separate per-id user lookup. `assigneeId`
   *  alone is an opaque uuid; the name is what a human-facing readout needs. */
  assigneeName: string | null
  /** SERVER-computed overdue flag: TRUE iff the task has a non-null `due_date`
   *  strictly in the PAST (due_date < CURRENT_DATE) AND its status is NON-terminal
   *  (an unfinished task only — a done/cancelled task is never "overdue" however
   *  old its due date). This is the launch/board-digest discrimination computed in
   *  SQL so a routine tick RENDERS the overdue set instead of re-deriving
   *  `dueDate < today` from raw ISO strings in-context (the l710/l711 "compute the
   *  discrimination server-side" doctrine — a flash-lite tick reliably renders a
   *  boolean it cannot reliably compute from date math). `dueDate`/`statusTerminal`
   *  remain available for callers that want the raw inputs. */
  overdue: boolean
}

export interface ListTasksAcrossProjectsArgs {
  tx: RlsClient
  orgId: string
  assigneeId: string
  /** `this_week` is a back-compat alias for `due_soon` (same bucket). */
  due?: "overdue" | "due_soon" | "later" | "none" | "this_week"
  statusId?: string
  /** Filter by the task's status terminal/done state. `false` = only UNFINISHED
   *  (open) tasks — the "reassign a departing teammate's OPEN tasks" predicate;
   *  `true` = only finished. Omit for all (open + done). A task whose status row
   *  is missing counts as not-terminal. */
  terminal?: boolean
  /** Effective-release filter (see ListTasksFilters.release). */
  release?: string
}

/**
 * List one assignee's tasks across EVERY project the caller can see. This
 * deliberately drops the `project_id` predicate `listTasks` carries, so the
 * result is scoped entirely by the task RLS policy — a caller only sees tasks in
 * projects they can read. Joins the project name + the status label/terminal
 * flag so the caller can tell OPEN tasks from DONE ones (the discriminator a
 * bulk-reassign-the-open-ones sweep needs); pass `terminal:false` to get only
 * the open ones directly.
 */
export async function listTasksAcrossProjects(
  args: ListTasksAcrossProjectsArgs,
): Promise<{ items: CrossProjectTask[]; totalCount: number }> {
  const conds: ReturnType<typeof drizzleSql>[] = [
    drizzleSql`t.org_id = ${args.orgId}::uuid`,
    drizzleSql`t.assignee_id = ${args.assigneeId}::uuid`,
    drizzleSql`t.archived_at IS NULL`,
  ]
  if (args.statusId) conds.push(drizzleSql`t.status_id = ${args.statusId}::uuid`)
  // Terminal/done filter — joins project_statuses.terminal. `false` = unfinished
  // (the open-tasks sweep predicate); a NULL status (no column) counts as not-terminal.
  if (args.terminal === true) conds.push(drizzleSql`s.terminal IS TRUE`)
  else if (args.terminal === false) conds.push(drizzleSql`s.terminal IS NOT TRUE`)
  if (args.due) {
    const bucket = args.due === "this_week" ? "due_soon" : args.due
    conds.push(drizzleSql`${dueBucketSql("t", "s")} = ${bucket}`)
  }
  const releaseCond = releaseFilterSql("t", args.orgId, args.release)
  if (releaseCond) conds.push(releaseCond)
  const whereSql = conds.reduce<ReturnType<typeof drizzleSql>>(
    (acc, frag, idx) => (idx === 0 ? frag : drizzleSql`${acc} AND ${frag}`),
    drizzleSql``,
  )
  const rows = extractRows<
    DbTaskRow & {
      project_name: string
      project_key: string | null
      status_label: string | null
      status_terminal: boolean | null
      assignee_name: string | null
      overdue: boolean | null
    }
  >(
    await args.tx.execute(drizzleSql`
      SELECT
        t.id, t.org_id, t.project_id, t.parent_task_id, t.status_id, t.number, t.title,
        t.description, t.assignee_id, t.priority, t.due_date, t.start_date,
        t.position, t.blocked, t.completed_at, t.thread_id, t.created_by,
        t.created_at, t.updated_at, t.release,
        p.name AS project_name, p.key AS project_key,
        s.label AS status_label, s.terminal AS status_terminal,
        u.name AS assignee_name,
        (t.due_date IS NOT NULL AND t.due_date < CURRENT_DATE AND s.terminal IS NOT TRUE) AS overdue
      FROM ${projectsRel("tasks")} t
      JOIN ${projectsRel("projects")} p ON p.id = t.project_id AND p.org_id = t.org_id
      LEFT JOIN ${projectsRel("project_statuses")} s ON s.id = t.status_id AND s.org_id = t.org_id
      LEFT JOIN ${kernelRel("users")} u ON u.id = t.assignee_id AND u.org_id = t.org_id
      WHERE ${whereSql}
      ORDER BY t.due_date ASC NULLS LAST, t.created_at ASC
    `),
  )
  const items = rows.map((r) => ({
    ...taskFromRow(r),
    projectName: r.project_name,
    projectKey: r.project_key,
    key: r.project_key != null && r.number != null ? formatTaskKey(r.project_key, r.number) : null,
    statusLabel: r.status_label,
    statusTerminal: r.status_terminal ?? false,
    assigneeName: r.assignee_name,
    overdue: r.overdue ?? false,
  }))
  await attachTaskLabels(args.tx, args.orgId, items)
  // Unpaginated (no LIMIT) — the result IS the full matching set, so the sweep
  // count is exactly items.length. Returned as `totalCount` for the uniform
  // contacts/users/mail/tickets/projects convention so a sweep over "my overdue
  // tasks" reads a measured remaining count that drops as each is completed.
  return { items, totalCount: items.length }
}

export interface ProjectTask extends CrossProjectTask {
  statusLabel: string | null
  statusTerminal: boolean
}

export interface ListProjectTasksArgs {
  tx: RlsClient
  orgId: string
  projectId: string
  statusId?: string
  /** Filter by whether the task's status is terminal/done. `false` = only
   *  UNFINISHED tasks (the canonical "process every open task" sweep predicate);
   *  `true` = only finished. Omit for all. */
  terminal?: boolean
  /** `this_week` is a back-compat alias for `due_soon` (same bucket). */
  due?: "overdue" | "due_soon" | "later" | "none" | "this_week"
  limit?: number
  /** Effective-release filter (see ListTasksFilters.release). */
  release?: string
  /** Skip the page query and return ONLY `totalCount` — the cheap countdown
   *  read. (The count is ALWAYS returned; this only suppresses the rows.) */
  countOnly?: boolean
  /** Effective-label filter (see ListTasksFilters.labels). */
  labels?: LabelInput
  /** Completion window start, inclusive (ISO-8601, offsets honoured). */
  completedAfter?: string
  /** Completion window end, exclusive (ISO-8601, offsets honoured). */
  completedBefore?: string
}

/** The bridge forwards tool params as given, so the type is checked here too. */
function parseInstant(field: string, raw: unknown): string | null {
  if (raw === undefined || raw === null) return null
  const d = typeof raw === "string" ? new Date(raw) : null
  if (!d || Number.isNaN(d.getTime())) {
    throw new ProjectsServiceError(
      400,
      "invalid_params",
      `${field} must be an ISO-8601 date-time (got ${JSON.stringify(raw)})`,
    )
  }
  return d.toISOString()
}

/**
 * List the (non-archived) tasks in ONE project — the [[BL-151]] gap: digest /
 * backlog-rollup routines and the launch-from-template flow need to ENUMERATE a
 * project's tasks, which `search` (title-text only), `get` (by-id) and
 * `tasks_byAssignee` (per-person, cross-project) cannot do. Scoped by the task
 * RLS policy + the explicit project filter; joins the status label + terminal
 * flag (ordered by the project's status order, then board position) so the caller
 * can group by status — the common digest shape.
 */
export async function listProjectTasks(
  args: ListProjectTasksArgs,
): Promise<{ items: ProjectTask[]; totalCount: number }> {
  const conds: ReturnType<typeof drizzleSql>[] = [
    drizzleSql`t.org_id = ${args.orgId}::uuid`,
    drizzleSql`t.project_id = ${args.projectId}::uuid`,
    drizzleSql`t.archived_at IS NULL`,
  ]
  if (args.statusId) conds.push(drizzleSql`t.status_id = ${args.statusId}::uuid`)
  // Terminal/done filter — joins project_statuses.terminal. `false` = unfinished
  // (the sweep predicate); a NULL status (no column) counts as not-terminal.
  if (args.terminal === true) conds.push(drizzleSql`s.terminal IS TRUE`)
  else if (args.terminal === false) conds.push(drizzleSql`s.terminal IS NOT TRUE`)
  if (args.due) {
    const bucket = args.due === "this_week" ? "due_soon" : args.due
    conds.push(drizzleSql`${dueBucketSql("t", "s")} = ${bucket}`)
  }
  const releaseCond = releaseFilterSql("t", args.orgId, args.release)
  if (releaseCond) conds.push(releaseCond)
  const labelCond = await labelFilterCondition(args.tx, args.orgId, "t", args.labels)
  if (labelCond) conds.push(labelCond)
  const completedAfter = parseInstant("completedAfter", args.completedAfter)
  const completedBefore = parseInstant("completedBefore", args.completedBefore)
  if (completedAfter) conds.push(drizzleSql`t.completed_at >= ${completedAfter}::timestamptz`)
  if (completedBefore) conds.push(drizzleSql`t.completed_at < ${completedBefore}::timestamptz`)
  const whereSql = conds.reduce<ReturnType<typeof drizzleSql>>(
    (acc, frag, idx) => (idx === 0 ? frag : drizzleSql`${acc} AND ${frag}`),
    drizzleSql``,
  )

  // Exhaustive-sweep substrate: a server COUNT(*) over the SAME filter+join as
  // the page — ALWAYS returned (the contacts/users/mail `totalCount` convention),
  // independent of the page LIMIT so it reports the whole matching set.
  // `countOnly` skips the page fetch entirely (the cheap countdown read).
  const countRows = extractRows<{ total: number }>(
    await args.tx.execute(drizzleSql`
      SELECT COUNT(*)::int AS total
      FROM ${projectsRel("tasks")} t
      LEFT JOIN ${projectsRel("project_statuses")} s ON s.id = t.status_id AND s.org_id = t.org_id
      WHERE ${whereSql}
    `),
  )
  const totalCount = countRows[0]?.total ?? 0
  if (args.countOnly) return { items: [], totalCount }

  const limit = Math.min(Math.max(args.limit ?? 100, 1), 200)
  const rows = extractRows<
    DbTaskRow & {
      project_name: string
      project_key: string | null
      status_label: string | null
      status_terminal: boolean | null
      assignee_name: string | null
      overdue: boolean | null
    }
  >(
    await args.tx.execute(drizzleSql`
      SELECT
        t.id, t.org_id, t.project_id, t.parent_task_id, t.status_id, t.number, t.title,
        t.description, t.assignee_id, t.priority, t.due_date, t.start_date,
        t.position, t.blocked, t.completed_at, t.thread_id, t.created_by,
        t.created_at, t.updated_at, t.release,
        p.name AS project_name, p.key AS project_key,
        s.label AS status_label, s.terminal AS status_terminal,
        u.name AS assignee_name,
        (t.due_date IS NOT NULL AND t.due_date < CURRENT_DATE AND s.terminal IS NOT TRUE) AS overdue
      FROM ${projectsRel("tasks")} t
      JOIN ${projectsRel("projects")} p ON p.id = t.project_id AND p.org_id = t.org_id
      LEFT JOIN ${projectsRel("project_statuses")} s ON s.id = t.status_id AND s.org_id = t.org_id
      LEFT JOIN ${kernelRel("users")} u ON u.id = t.assignee_id AND u.org_id = t.org_id
      WHERE ${whereSql}
      ORDER BY s."order" ASC NULLS LAST, t.position ASC, t.created_at ASC
      LIMIT ${limit}
    `),
  )
  const items = rows.map((r) => ({
    ...taskFromRow(r),
    projectName: r.project_name,
    projectKey: r.project_key,
    key: r.project_key != null && r.number != null ? formatTaskKey(r.project_key, r.number) : null,
    statusLabel: r.status_label,
    statusTerminal: r.status_terminal ?? false,
    assigneeName: r.assignee_name,
    overdue: r.overdue ?? false,
  }))
  await attachTaskLabels(args.tx, args.orgId, items)
  return { items, totalCount }
}

export interface PortfolioRollupArgs {
  tx: RlsClient
  orgId: string
  /** Cap on the number of (most-recently-updated) active projects to roll up.
   *  Default 25, max 50 — keeps the single aggregate query bounded for a board
   *  digest without ever paging. */
  limit?: number
  /** Include archived projects too. Default false (active projects only). */
  includeArchived?: boolean
}

/** The single biggest at-risk task in one project — the most-overdue, then
 *  highest-priority, non-terminal task. `null` when the project has no
 *  at-risk (overdue or open high/urgent) task. */
export interface PortfolioAtRiskTask {
  id: string
  title: string
  /** Task priority (low/normal/high/urgent). */
  priority: string
  /** ISO date the task was due, or null if it has no due date. */
  dueDate: string | null
  /** Days overdue (>0) — 0 when not overdue (picked on priority alone). */
  daysOverdue: number
  /** Assignee display name, or null when unassigned. */
  assigneeName: string | null
  /** Current status label, or null when the task has no status. */
  statusLabel: string | null
}

/** One project's slice of the portfolio rollup — the per-project numbers a board
 *  update needs, computed authoritatively server-side (no in-context tally). */
export interface PortfolioProjectRollup {
  projectId: string
  projectName: string
  /** Total non-archived tasks in the project. */
  totalTasks: number
  /** Tasks in a terminal/done status. */
  doneTasks: number
  /** Non-terminal (unfinished) tasks. */
  remainingTasks: number
  /** Non-terminal tasks whose due date is before today. */
  overdueTasks: number
  /** Percentage of tasks done (0–100, rounded). 0 when the project has no tasks. */
  percentDone: number
  /** The single biggest at-risk task, or null when none is at risk. */
  biggestAtRisk: PortfolioAtRiskTask | null
}

export interface PortfolioRollupResult {
  projects: PortfolioProjectRollup[]
  /** Number of active (or, with includeArchived, all) projects rolled up. */
  projectCount: number
  /** True when more projects exist than `limit` covered — the caller should
   *  disclose that the rollup is a (most-recently-updated) subset. */
  truncated: boolean
  /** Total active (or all) projects in the org, so the caller can state
   *  "<projectCount> of <totalProjects>" when truncated. */
  totalProjects: number
}

/** Map priority label → numeric rank for "biggest at-risk" ordering (urgent > high > normal > low). */
const PRIORITY_RANK_SQL = drizzleSql`CASE t.priority
  WHEN 'urgent' THEN 4
  WHEN 'high' THEN 3
  WHEN 'normal' THEN 2
  WHEN 'low' THEN 1
  ELSE 0 END`

/**
 * BL-263 — the bounded projects PORTFOLIO ROLLUP. One/few-call aggregate over
 * the EXISTING task reads (no new subsystem): for each active project, the
 * authoritative per-project {total, done, remaining, overdue, %done, biggest
 * at-risk task}. Closes the `cross-project-portfolio-rollup` gap (a board
 * one-screen view) and also serves the `modular-expo-backlog-burndown-digest`
 * sibling, replacing the N-separate-listTasks-calls-tallied-in-context path.
 *
 * RLS-scoped via `tx` (the same task/project visibility as every other read).
 * Computes counts in ONE grouped query and the per-project biggest-at-risk via a
 * LATERAL pick — no per-project round-trip, no in-context tally. Bounded by
 * `limit` (default 25, max 50) over the most-recently-updated projects, with
 * `truncated`/`totalProjects` so the caller can honestly disclose any subset.
 */
export async function portfolioRollup(args: PortfolioRollupArgs): Promise<PortfolioRollupResult> {
  const limit = Math.max(1, Math.min(args.limit ?? 25, 50))
  const archivedClause = args.includeArchived ? drizzleSql`` : drizzleSql`AND p.archived_at IS NULL`

  // Total active (or all) projects in the org — drives truncation disclosure.
  const totalRows = extractRows<{ total: number }>(
    await args.tx.execute(drizzleSql`
      SELECT COUNT(*)::int AS total FROM ${projectsRel("projects")} p
      WHERE p.org_id = ${args.orgId}::uuid ${archivedClause}
    `),
  )
  const totalProjects = totalRows[0]?.total ?? 0

  // Per-project counts (one grouped pass over the candidate projects' tasks) +
  // the biggest at-risk task via a LATERAL that ranks each project's non-terminal
  // tasks by overdue-first, then priority, then most-overdue (oldest due date).
  const rows = extractRows<{
    project_id: string
    project_name: string
    total_tasks: number
    done_tasks: number
    overdue_tasks: number
    risk_task_id: string | null
    risk_title: string | null
    risk_priority: string | null
    risk_due_date: Date | string | null
    risk_days_overdue: number | null
    risk_assignee_name: string | null
    risk_status_label: string | null
  }>(
    await args.tx.execute(drizzleSql`
      WITH candidate_projects AS (
        SELECT p.id, p.name, p.updated_at
        FROM ${projectsRel("projects")} p
        WHERE p.org_id = ${args.orgId}::uuid ${archivedClause}
        ORDER BY p.updated_at DESC, p.id DESC
        LIMIT ${limit}
      ),
      project_tasks AS (
        SELECT
          t.id, t.project_id, t.title, t.priority, t.due_date, t.assignee_id,
          s.terminal AS status_terminal,
          s.label AS status_label,
          (s.terminal IS NOT TRUE
            AND t.due_date IS NOT NULL
            AND t.due_date < CURRENT_DATE) AS is_overdue
        FROM ${projectsRel("tasks")} t
        JOIN candidate_projects cp ON cp.id = t.project_id
        LEFT JOIN ${projectsRel("project_statuses")} s
          ON s.id = t.status_id AND s.org_id = ${args.orgId}::uuid
        WHERE t.org_id = ${args.orgId}::uuid AND t.archived_at IS NULL
      )
      SELECT
        cp.id AS project_id,
        cp.name AS project_name,
        COALESCE(agg.total_tasks, 0)::int AS total_tasks,
        COALESCE(agg.done_tasks, 0)::int AS done_tasks,
        COALESCE(agg.overdue_tasks, 0)::int AS overdue_tasks,
        risk.id AS risk_task_id,
        risk.title AS risk_title,
        risk.priority AS risk_priority,
        risk.due_date AS risk_due_date,
        risk.days_overdue AS risk_days_overdue,
        ru.name AS risk_assignee_name,
        risk.status_label AS risk_status_label
      FROM candidate_projects cp
      LEFT JOIN LATERAL (
        SELECT
          COUNT(*) AS total_tasks,
          COUNT(*) FILTER (WHERE pt.status_terminal IS TRUE) AS done_tasks,
          COUNT(*) FILTER (WHERE pt.is_overdue) AS overdue_tasks
        FROM project_tasks pt WHERE pt.project_id = cp.id
      ) agg ON TRUE
      LEFT JOIN LATERAL (
        SELECT
          t.id, t.title, t.priority, t.due_date, t.assignee_id,
          pt2.status_label,
          CASE WHEN pt2.is_overdue
            THEN (CURRENT_DATE - t.due_date)::int ELSE 0 END AS days_overdue
        FROM project_tasks pt2
        JOIN ${projectsRel("tasks")} t ON t.id = pt2.id
        WHERE pt2.project_id = cp.id
          AND pt2.status_terminal IS NOT TRUE
          AND (pt2.is_overdue OR t.priority IN ('high', 'urgent'))
        ORDER BY
          pt2.is_overdue DESC,
          ${PRIORITY_RANK_SQL} DESC,
          t.due_date ASC NULLS LAST,
          t.created_at ASC
        LIMIT 1
      ) risk ON TRUE
      LEFT JOIN ${kernelRel("users")} ru
        ON ru.id = risk.assignee_id AND ru.org_id = ${args.orgId}::uuid
      ORDER BY cp.updated_at DESC, cp.id DESC
    `),
  )

  const projects: PortfolioProjectRollup[] = rows.map((r) => {
    const total = r.total_tasks
    const done = r.done_tasks
    const remaining = total - done
    return {
      projectId: r.project_id,
      projectName: r.project_name,
      totalTasks: total,
      doneTasks: done,
      remainingTasks: remaining,
      overdueTasks: r.overdue_tasks,
      percentDone: total > 0 ? Math.round((done / total) * 100) : 0,
      biggestAtRisk: r.risk_task_id
        ? {
            id: r.risk_task_id,
            title: r.risk_title ?? "",
            priority: r.risk_priority ?? "normal",
            dueDate: toIso(r.risk_due_date),
            daysOverdue: r.risk_days_overdue ?? 0,
            assigneeName: r.risk_assignee_name,
            statusLabel: r.risk_status_label,
          }
        : null,
    }
  })

  return {
    projects,
    projectCount: projects.length,
    truncated: totalProjects > projects.length,
    totalProjects,
  }
}

export interface DeleteTaskArgs {
  tx: RlsClient
  orgId: string
  actor: UserContext
  taskId: string
  /** Optional event sink (defaults to the tx's transactional outbox). */
  queueEvent?: (event: { app: string; entity: string; action: string; entityId: string }) => void
}

/**
 * Soft-delete a task and its entire subtree (recursive CTE), setting
 * `archived_at = now()`. Idempotent: if the task is already archived (or does
 * not exist / is not visible), this is a no-op that emits nothing. Emits the
 * canonical `task:deleted` outbox event for the root on a real delete.
 */
export async function deleteTask(args: DeleteTaskArgs): Promise<void> {
  const { tx, orgId, taskId } = args
  // Only archive rows that are currently active; the RETURNING set tells us
  // whether anything was actually deleted (idempotency gate).
  const archived = extractRows<{ id: string }>(
    await tx.execute(drizzleSql`
      WITH RECURSIVE subtree AS (
        SELECT id FROM ${projectsRel("tasks")}
        WHERE id = ${taskId}::uuid AND org_id = ${orgId}::uuid AND archived_at IS NULL
        UNION ALL
        SELECT c.id FROM ${projectsRel("tasks")} c
        JOIN subtree s ON c.parent_task_id = s.id
        WHERE c.org_id = ${orgId}::uuid AND c.archived_at IS NULL
      )
      UPDATE ${projectsRel("tasks")} t
      SET archived_at = now(), updated_at = now()
      FROM subtree
      WHERE t.id = subtree.id AND t.org_id = ${orgId}::uuid
      RETURNING t.id
    `),
  )
  // Idempotent: the root wasn't active (already archived / not found) → nothing
  // changed, emit nothing.
  if (!archived.some((r) => r.id === taskId)) return
  const event = {
    app: "projects" as const,
    entity: "task" as const,
    action: "deleted" as const,
    entityId: taskId,
  }
  if (args.queueEvent) {
    args.queueEvent(event)
  } else {
    await tx.queueEvent({
      ...event,
      data: { id: taskId },
      actorId: args.actor.userId,
      actorType: "user",
      orgId,
    })
  }
}

export interface RestoreTaskArgs {
  tx: RlsClient
  orgId: string
  actor: UserContext
  taskId: string
  queueEvent?: (event: { app: string; entity: string; action: string; entityId: string }) => void
}

/**
 * Take a task back out of the bin: clear `archived_at` on it and everything
 * deleteTask archived beneath it. The mirror of {@link deleteTask}, and the
 * reason a delete can stay a soft delete rather than becoming permanent.
 *
 * The subtree walk follows CURRENTLY-ARCHIVED children, so a child archived on
 * its own BEFORE its parent was deleted comes back too — the bin restores what
 * the bin shows. Idempotent: restoring an already-active task (or one that is
 * not there) changes nothing and emits nothing.
 *
 * A task whose PROJECT is archived is restored all the same; it simply stays
 * out of sight until the project itself is restored. Refusing here would make
 * the row unrecoverable through any surface.
 */
export async function restoreTask(args: RestoreTaskArgs): Promise<void> {
  const { tx, orgId, taskId } = args
  const restored = extractRows<{ id: string }>(
    await tx.execute(drizzleSql`
      WITH RECURSIVE subtree AS (
        SELECT id FROM ${projectsRel("tasks")}
        WHERE id = ${taskId}::uuid AND org_id = ${orgId}::uuid AND archived_at IS NOT NULL
        UNION ALL
        SELECT c.id FROM ${projectsRel("tasks")} c
        JOIN subtree s ON c.parent_task_id = s.id
        WHERE c.org_id = ${orgId}::uuid AND c.archived_at IS NOT NULL
      )
      UPDATE ${projectsRel("tasks")} t
      SET archived_at = NULL, updated_at = now()
      FROM subtree
      WHERE t.id = subtree.id AND t.org_id = ${orgId}::uuid
      RETURNING t.id
    `),
  )
  if (!restored.some((r) => r.id === taskId)) return
  const event = {
    app: "projects" as const,
    entity: "task" as const,
    action: "restored" as const,
    entityId: taskId,
  }
  if (args.queueEvent) {
    args.queueEvent(event)
  } else {
    await tx.queueEvent({
      ...event,
      data: { id: taskId },
      actorId: args.actor.userId,
      actorType: "user",
      orgId,
    })
  }
}

// ---------------------------------------------------------------------------
// J2 — merge, template instantiation, dependencies
// ---------------------------------------------------------------------------

export interface MergeTasksArgs {
  tx: RlsClient
  orgId: string
  actor: UserContext
  sourceId: string
  targetId: string
}

/**
 * Merge `sourceId` into `targetId`: reassign the source's direct children to
 * the target, move any source-pointing dependencies to the target, then archive
 * the source. Modeled on contacts `mergeContacts` (reassign-then-archive).
 */
export async function mergeTasks(args: MergeTasksArgs): Promise<void> {
  const { tx, orgId, sourceId, targetId } = args
  if (sourceId === targetId) {
    throw new ProjectsServiceError(400, "invalid_merge", "cannot merge a task into itself")
  }
  const exists = extractRows<{ id: string }>(
    await tx.execute(drizzleSql`
      SELECT id FROM ${projectsRel("tasks")}
      WHERE id IN (${sourceId}::uuid, ${targetId}::uuid) AND org_id = ${orgId}::uuid AND archived_at IS NULL
    `),
  )
  if (exists.length < 2) {
    throw new ProjectsServiceError(404, "not_found", "source or target task not found")
  }
  // Append the source's checklist after the target's own (S11). First, so a
  // refusal (over the per-task limit) writes nothing.
  await appendChecklistOnMerge(tx, orgId, args.actor.userId, sourceId, targetId)
  // Reassign the source's direct children to the target.
  await tx.execute(drizzleSql`
    UPDATE ${projectsRel("tasks")}
    SET parent_task_id = ${targetId}::uuid, updated_at = now()
    WHERE parent_task_id = ${sourceId}::uuid AND org_id = ${orgId}::uuid
  `)
  // Repoint dependencies that referenced the source so the conversation/work
  // graph is not orphaned; drop any row that would self-reference the target.
  await tx.execute(drizzleSql`
    UPDATE ${projectsRel("task_dependencies")}
    SET task_id = ${targetId}::uuid
    WHERE task_id = ${sourceId}::uuid AND org_id = ${orgId}::uuid
      AND depends_on_task_id <> ${targetId}::uuid
  `)
  await tx.execute(drizzleSql`
    UPDATE ${projectsRel("task_dependencies")}
    SET depends_on_task_id = ${targetId}::uuid
    WHERE depends_on_task_id = ${sourceId}::uuid AND org_id = ${orgId}::uuid
      AND task_id <> ${targetId}::uuid
  `)
  await tx.execute(drizzleSql`
    DELETE FROM ${projectsRel("task_dependencies")}
    WHERE org_id = ${orgId}::uuid AND (task_id = ${sourceId}::uuid OR depends_on_task_id = ${sourceId}::uuid)
  `)
  // Archive the source.
  await tx.execute(drizzleSql`
    UPDATE ${projectsRel("tasks")}
    SET archived_at = now(), updated_at = now()
    WHERE id = ${sourceId}::uuid AND org_id = ${orgId}::uuid
  `)
  await tx.queueEvent({
    app: "projects",
    entity: "task",
    action: "deleted",
    entityId: sourceId,
    data: { id: sourceId, mergedInto: targetId },
    actorId: args.actor.userId,
    actorType: "user",
    orgId,
  })
}

interface TemplateNode {
  title: string
  description?: string | null
  children?: TemplateNode[]
}

export interface InstantiateTemplateArgs {
  tx: RlsClient
  orgId: string
  actor: UserContext
  templateId: string
  projectName: string
}

/**
 * Materialize a stored project template into a brand-new project. Recursively
 * calls `createTask`, which enforces `MAX_TASK_DEPTH` — so an over-deep
 * template fails through the same guard a manual deep-nest would hit.
 */
export async function instantiateTemplate(
  args: InstantiateTemplateArgs,
): Promise<{ projectId: string }> {
  const { tx, orgId, actor, templateId, projectName } = args
  const tplRows = extractRows<{ structure: unknown }>(
    await tx.execute(drizzleSql`
      SELECT structure FROM ${projectsRel("project_templates")}
      WHERE id = ${templateId}::uuid AND org_id = ${orgId}::uuid
      LIMIT 1
    `),
  )
  if (tplRows.length === 0) {
    throw new ProjectsServiceError(404, "template_not_found", "project template not found")
  }
  const raw = tplRows[0]!.structure
  const nodes: TemplateNode[] = Array.isArray(raw) ? (raw as TemplateNode[]) : []

  const { createProject } = await import("./create-project")
  const project = await createProject({ tx, orgId, actor, input: { name: projectName } })
  const statusId = project.statuses.find((s) => !s.terminal)?.id ?? project.statuses[0]?.id
  if (!statusId) throw new ProjectsServiceError(409, "no_statuses", "new project has no statuses")

  const createNode = async (node: TemplateNode, parentTaskId: string | null): Promise<void> => {
    const created = await createTask({
      tx,
      orgId,
      actor,
      input: {
        projectId: project.id,
        statusId,
        parentTaskId,
        title: node.title,
        description: node.description ?? null,
      },
    })
    for (const child of node.children ?? []) {
      await createNode(child, created.id)
    }
  }
  for (const node of nodes) await createNode(node, null)
  return { projectId: project.id }
}

export interface AddDependencyArgs {
  tx: RlsClient
  orgId: string
  actor: UserContext
  taskId: string
  dependsOnTaskId: string
  type?: "blocks" | "relates"
}

/**
 * Add a directed dependency `taskId → dependsOnTaskId`. Rejects a cycle via a
 * recursive-CTE reachability pre-check, then recomputes the dependent's stored
 * `blocked` flag (true while a 'blocks' dependency points at an open task).
 */
export async function addDependency(args: AddDependencyArgs): Promise<void> {
  const { tx, orgId, taskId, dependsOnTaskId } = args
  const type = args.type ?? "blocks"
  if (taskId === dependsOnTaskId) {
    throw new ProjectsServiceError(400, "invalid_dependency", "a task cannot depend on itself")
  }
  // Cycle pre-check: is taskId reachable FROM dependsOnTaskId already? If so the
  // new edge taskId → dependsOnTaskId would close a cycle.
  const cyclic = extractRows<{ ok: number }>(
    await tx.execute(drizzleSql`
      WITH RECURSIVE reach AS (
        SELECT depends_on_task_id AS t FROM ${projectsRel("task_dependencies")}
        WHERE task_id = ${dependsOnTaskId}::uuid AND org_id = ${orgId}::uuid
        UNION ALL
        SELECT d.depends_on_task_id FROM ${projectsRel("task_dependencies")} d
        JOIN reach r ON d.task_id = r.t
        WHERE d.org_id = ${orgId}::uuid
      )
      SELECT 1 AS ok FROM reach WHERE t = ${taskId}::uuid LIMIT 1
    `),
  )
  if (cyclic.length > 0) {
    throw new ProjectsServiceError(400, "dependency_cycle", "dependency cycle rejected (circular)")
  }
  await tx.execute(drizzleSql`
    INSERT INTO ${projectsRel("task_dependencies")} (org_id, task_id, depends_on_task_id, type)
    VALUES (${orgId}::uuid, ${taskId}::uuid, ${dependsOnTaskId}::uuid, ${type})
    ON CONFLICT (task_id, depends_on_task_id) DO UPDATE SET type = EXCLUDED.type
  `)
  // Recompute the dependent's stored blocked flag.
  await tx.execute(drizzleSql`
    UPDATE ${projectsRel("tasks")} dep
    SET blocked = EXISTS (
      SELECT 1 FROM ${projectsRel("task_dependencies")} td
      JOIN ${projectsRel("tasks")} blk ON blk.id = td.depends_on_task_id
      WHERE td.task_id = dep.id AND td.type = 'blocks' AND blk.completed_at IS NULL
    ), updated_at = now()
    WHERE dep.id = ${taskId}::uuid AND dep.org_id = ${orgId}::uuid
  `)
}
