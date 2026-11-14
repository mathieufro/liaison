// SPDX-License-Identifier: FSL-1.1-ALv2
// The task row shape (`Task`, `TaskSummary`) and its loader. Lives apart from
// tasks.ts so the other task writers (move-task.ts, statuses.ts) can load the
// written rows for their events without an import cycle through tasks.ts.
import { sql as drizzleSql } from "drizzle-orm"
import { kernelRel, projectsRel } from "~/apps/projects/schema-refs"
import { extractRows, type RlsClient, type RlsTx } from "~/db"
import type { ChecklistStatus } from "./checklist-status"
import { HIDDEN_LINK_LABEL, parseStoredFields, readerScopes, visibleTaskFields } from "./fields"
import { formatTaskKey } from "./task-key"
import { loadTaskLabels, type TaskLabel } from "./task-labels"

export interface AssigneeRef {
  id: string
  name: string
  avatarUrl: string | null
}

export interface Task {
  id: string
  orgId: string
  projectId: string
  parentTaskId: string | null
  statusId: string
  /** Per-project sequential number (see task-key.ts); undefined where the
   *  loading query does not select it (not every task read joins it yet). */
  number?: number
  title: string
  description: string | null
  assigneeId: string | null
  priority: string
  dueDate: string | null
  startDate: string | null
  position: number
  blocked: boolean
  completedAt: string | null
  /** The task's OWN release (free text); inheritance applies only to filtering. */
  release: string | null
  threadId: string
  createdBy: string
  /** The creator's display name, resolved server-side like the assignee's;
   *  null where the loading query does not join it. */
  createdByName: string | null
  /** The agent that created the task ("Routine <name>", a named agent, or
   *  "<person>'s agent"); null when a person did. Shown instead of the name. */
  createdByAgentLabel: string | null
  createdAt: string
  updatedAt: string
  /** Effective label per group (own or inherited). Every read site
   *  fills it from one batched query; `taskFromRow` starts it empty. */
  labels: TaskLabel[]
  /** Time keys, only on a task of a project using time and budgets (task-time-keys.ts). */
  timeboxMinutes?: number | null
  realTotalMinutes?: number
  isMilestone?: boolean
  /** The task's values of the project's active fields, in definition order (fields.ts). */
  fields: Record<string, unknown>
  /** When the task entered its current status (time in status); null where not selected. */
  statusEnteredAt: string | null
}

export interface DbTaskRow {
  id: string
  org_id: string
  project_id: string
  parent_task_id: string | null
  status_id: string
  number?: number
  title: string
  description: string | null
  assignee_id: string | null
  priority: string
  due_date: Date | string | null
  start_date: Date | string | null
  position: number
  blocked: boolean
  completed_at: Date | string | null
  release?: string | null
  thread_id: string
  created_by: string
  created_by_name?: string | null
  created_by_agent_label?: string | null
  created_at: Date | string
  updated_at: Date | string
  fields?: unknown
  status_entered_at?: Date | string | null
  /** The project's field definitions (projects.task_fields), joined by the reads that map fields. */
  task_fields?: unknown
}

export interface TaskSummary extends Task {
  assignee: AssigneeRef | null
  depth: number
  childCount: number
  /** Display key, e.g. "ERB-12" — null when the row's query did not join the
   *  project's key (or the project has none, which should not happen post-0043). */
  key: string | null
  /** S5 summary for the Kanban counters (S17). Filled by `listTasks` only:
   *  null when the task has no checklist items (no checklist, no counter). */
  checklist?: ChecklistStatus | null
}

export interface TaskListDbRow extends DbTaskRow {
  assignee_user_id: string | null
  assignee_name: string | null
  assignee_avatar_url: string | null
  depth: number
  child_count: number | string
  /** Joined from app_projects.projects.key — present only on queries that join it. */
  project_key?: string | null
}

export function toIso(value: Date | string | null): string | null {
  if (value === null) return null
  if (value instanceof Date) return value.toISOString()
  return value
}

function toIsoNonNull(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : value
}

export function taskFromRow(r: DbTaskRow): Task {
  return {
    id: r.id,
    orgId: r.org_id,
    projectId: r.project_id,
    parentTaskId: r.parent_task_id,
    statusId: r.status_id,
    number: r.number,
    title: r.title,
    description: r.description,
    assigneeId: r.assignee_id,
    priority: r.priority,
    dueDate: toIso(r.due_date),
    startDate: toIso(r.start_date),
    position: r.position,
    blocked: r.blocked,
    completedAt: toIso(r.completed_at),
    release: r.release ?? null,
    threadId: r.thread_id,
    createdBy: r.created_by,
    createdByName: r.created_by_name ?? null,
    createdByAgentLabel: r.created_by_agent_label ?? null,
    createdAt: toIsoNonNull(r.created_at),
    updatedAt: toIsoNonNull(r.updated_at),
    labels: [],
    fields: visibleTaskFields(parseStoredFields(r.task_fields), r.fields, null),
    statusEnteredAt: toIso(r.status_entered_at ?? null),
  }
}

/**
 * Hides, in place, the label of every link value whose app the reader may not open (the
 * dashboard tables' rule). Only link values are objects, so nothing else is touched; the reader's
 * scopes are read once, and only when a link value is present.
 */
export async function maskLinkFields(
  tx: RlsClient | RlsTx,
  items: ReadonlyArray<{ fields: Record<string, unknown> }>,
): Promise<void> {
  const hasLink = items.some((t) =>
    Object.values(t.fields).some((v) => typeof v === "object" && v !== null && !Array.isArray(v)),
  )
  if (!hasLink) return
  const scopes = await readerScopes(tx)
  const sees = (app: string) =>
    app === "kernel" || scopes.some((s) => s === "*" || s === app || s.startsWith(`${app}:`))
  for (const t of items) {
    for (const [k, v] of Object.entries(t.fields)) {
      if (typeof v !== "object" || v === null || Array.isArray(v)) continue
      const app = (v as { app?: unknown }).app
      if (typeof app === "string" && !sees(app)) {
        t.fields[k] = { ...(v as Record<string, unknown>), label: HIDDEN_LINK_LABEL }
      }
    }
  }
}

export function taskSummaryFromRow(r: TaskListDbRow): TaskSummary {
  const base = taskFromRow(r)
  const assignee: AssigneeRef | null =
    r.assignee_user_id && r.assignee_name
      ? { id: r.assignee_user_id, name: r.assignee_name, avatarUrl: r.assignee_avatar_url }
      : null
  const key =
    r.project_key != null && r.number != null ? formatTaskKey(r.project_key, r.number) : null
  return {
    ...base,
    assignee,
    depth: r.depth,
    childCount: typeof r.child_count === "string" ? Number(r.child_count) : r.child_count,
    key,
  }
}

export interface LoadTaskDetailsOptions {
  /** Restrict to tasks of this project (a REST path boundary). */
  projectId?: string
  /** Also resolve binned (soft-deleted) tasks. */
  includeArchived?: boolean
}

/**
 * Load the detail row (the shape `getTask` returns) of every task in `taskIds`
 * in ONE query: depth per task via one recursive walk keyed by the task it
 * started from. Rows the caller cannot see, or that the options exclude, are
 * simply absent. Order follows `taskIds`.
 */
export async function loadTaskDetails(
  tx: RlsClient | RlsTx,
  orgId: string,
  taskIds: readonly string[],
  opts: LoadTaskDetailsOptions = {},
): Promise<TaskSummary[]> {
  if (taskIds.length === 0) return []
  const ids = drizzleSql.join(
    taskIds.map((id) => drizzleSql`${id}::uuid`),
    drizzleSql`, `,
  )
  const projectClause = opts.projectId
    ? drizzleSql`AND t.project_id = ${opts.projectId}::uuid`
    : drizzleSql``
  const archivedClause = opts.includeArchived ? drizzleSql`` : drizzleSql`AND t.archived_at IS NULL`
  const rows = extractRows<TaskListDbRow>(
    await tx.execute(drizzleSql`
      WITH RECURSIVE depth_cte AS (
        SELECT id AS root_id, id, parent_task_id, 1 AS depth
        FROM ${projectsRel("tasks")}
        WHERE id IN (${ids}) AND org_id = ${orgId}::uuid
        UNION ALL
        SELECT d.root_id, p.id, p.parent_task_id, d.depth + 1
        FROM ${projectsRel("tasks")} p
        JOIN depth_cte d ON d.parent_task_id = p.id
        WHERE p.org_id = ${orgId}::uuid
      )
      SELECT
        t.id, t.org_id, t.project_id, t.parent_task_id, t.status_id, t.number, t.title,
        t.description, t.assignee_id, t.priority, t.due_date, t.start_date,
        t.position, t.blocked, t.completed_at, t.thread_id, t.created_by,
        t.created_at, t.updated_at, t.release, t.created_by_agent_label,
        t.fields, t.status_entered_at, pr.task_fields,
        u.id AS assignee_user_id, u.name AS assignee_name, u.avatar_url AS assignee_avatar_url,
        cu.name AS created_by_name,
        pr.key AS project_key,
        (SELECT MAX(dc.depth) FROM depth_cte dc WHERE dc.root_id = t.id) AS depth,
        COALESCE((SELECT COUNT(*) FROM ${projectsRel("tasks")} c WHERE c.parent_task_id = t.id AND c.archived_at IS NULL), 0) AS child_count
      FROM ${projectsRel("tasks")} t
      LEFT JOIN ${kernelRel("users")} u ON u.id = t.assignee_id AND u.org_id = t.org_id
      LEFT JOIN ${kernelRel("users")} cu ON cu.id = t.created_by AND cu.org_id = t.org_id
      LEFT JOIN ${projectsRel("projects")} pr ON pr.id = t.project_id AND pr.org_id = t.org_id
      WHERE t.id IN (${ids}) AND t.org_id = ${orgId}::uuid ${projectClause} ${archivedClause}
    `),
  )
  const byId = new Map(rows.map((r) => [r.id, taskSummaryFromRow(r)]))
  const labels = await loadTaskLabels(tx, orgId, [...byId.keys()])
  for (const [id, row] of byId) row.labels = labels.get(id) ?? []
  await maskLinkFields(tx, [...byId.values()])
  const out: TaskSummary[] = []
  for (const id of taskIds) {
    const row = byId.get(id)
    if (row) out.push(row)
  }
  return out
}
