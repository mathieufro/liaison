// SPDX-License-Identifier: FSL-1.1-ALv2
// "Recently involved": the tasks a person touched in the last N days, newest
// involvement first, each with the reason it is on the list.
//
// Read from activity that already exists, nothing new is tracked (no read
// receipts, no per-user activity table):
// - a comment they wrote on the task's discussion thread (kernel.messages);
// - a mention of them there (kernel.attention_events, kind `mention`, keyed on
//   the thread);
// - a change they made: status, assignee, any field, a move
//   (kernel.audit_log rows the projects task events produce, actor = them);
// - a task they created (tasks.created_by);
// - a task assigned to them: by someone else in the window (audit row whose
//   post-change assignee is them), or currently theirs with activity in the
//   window (tasks.updated_at).
//
// One statement. Each source is read through its own index on the person
// (messages author, attention user, audit actor, tasks created_by and
// assignee), then joined to the tasks under the CALLER's RLS: a task they can
// no longer see, a binned task or one in an archived project never appears,
// whatever the activity rows say. The window is capped at 90 days, the
// audit-log retention floor.
import { sql as drizzleSql, type SQL } from "drizzle-orm"
import { kernelRel, projectsRel } from "~/apps/projects/schema-refs"
import { extractRows, type RlsClient, type RlsTx } from "~/db"
import { releaseFilterSql } from "./release-filter"
import { ProjectsServiceError } from "./statuses"
import { formatTaskKey } from "./task-key"
import { labelFilterCondition } from "./task-labels"
import { attachTaskTimeKeys } from "./task-time-keys"

export const INVOLVED_DEFAULT_DAYS = 14
export const INVOLVED_MAX_DAYS = 90
export const INVOLVED_DEFAULT_LIMIT = 50
export const INVOLVED_MAX_LIMIT = 200

/** Why a task is on the list. The most recent involvement wins. */
export type InvolvementKind =
  /** They wrote on the task's discussion. */
  | "commented"
  /** Someone mentioned them on the task's discussion. */
  | "mentioned"
  /** They changed its status (moved it to a column). */
  | "status_changed"
  /** They assigned it to themselves. */
  | "assigned_self"
  /** They assigned it to someone else. */
  | "assigned_other"
  /** They removed its assignee. */
  | "unassigned"
  /** They moved it to another project. */
  | "moved_project"
  /** They changed another field (title, description, dates, labels...). */
  | "edited"
  /** Someone else assigned it to them. */
  | "assigned_by"
  /** They created it. */
  | "created"
  /** It is theirs and changed in the window. */
  | "assignee"

export const INVOLVEMENT_KINDS: readonly InvolvementKind[] = [
  "commented",
  "mentioned",
  "status_changed",
  "assigned_self",
  "assigned_other",
  "unassigned",
  "moved_project",
  "edited",
  "assigned_by",
  "created",
  "assignee",
]

export interface Involvement {
  kind: InvolvementKind
  /** ISO time of the involvement. */
  at: string
  /** True when their agent acted for them (an agent comment, change or creation). */
  viaAgent: boolean
  /** Who mentioned or assigned them (mentioned, assigned_by). */
  actorName: string | null
  /** The column it went to (status_changed). */
  statusLabel: string | null
  /** The person it went to (assigned_other). */
  assigneeName: string | null
  /** The project it went to (moved_project). */
  projectName: string | null
  /** The fields changed (edited). */
  fields: string[]
  /** The reason in plain English, for agents ("you moved it to Done"). */
  summary: string
}

export interface InvolvedTask {
  id: string
  key: string | null
  title: string
  projectId: string
  projectName: string
  projectKey: string | null
  statusId: string
  statusLabel: string | null
  statusTerminal: boolean
  assigneeId: string | null
  assigneeName: string | null
  priority: string
  dueDate: string | null
  release: string | null
  threadId: string
  updatedAt: string
  involvement: Involvement
  /** Every kind of involvement in the window, most recent first. */
  involvementKinds: InvolvementKind[]
  /** Time keys, only on a task of a project using time and budgets (task-time-keys.ts). */
  timeboxMinutes?: number | null
  realTotalMinutes?: number
  isMilestone?: boolean
}

export interface ListRecentlyInvolvedArgs {
  tx: RlsClient | RlsTx
  orgId: string
  userId: string
  /** 1..90, default 14. */
  days?: number
  projectId?: string
  /** Title substring or display-key prefix. */
  query?: string
  release?: string
  /** Effective-label filter, as `tasks_byProject` takes it. */
  labels?: Record<string, string>
  /** 1..200, default 50. */
  limit?: number
}

/** Clamp a requested window to 1..90 days; anything not a positive number is the default. */
export function normalizeInvolvedDays(raw: unknown): number {
  const n = typeof raw === "string" ? Number(raw) : raw
  if (typeof n !== "number" || !Number.isFinite(n) || n <= 0) return INVOLVED_DEFAULT_DAYS
  return Math.min(INVOLVED_MAX_DAYS, Math.max(1, Math.round(n)))
}

const UUID_PATTERN = "^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$"

/** `expr::uuid` when it is a uuid, else NULL (a text column never throws a cast). */
function guardedUuid(expr: SQL): SQL {
  return drizzleSql`(CASE WHEN ${expr} ~ ${UUID_PATTERN} THEN (${expr})::uuid END)`
}

/** Fields of a task update that say nothing about what changed. */
const NON_FIELDS = new Set(["taskId", "statusLabel", "projectId"])

interface InvolvedRow {
  task_id: string
  at: Date | string
  kind: string
  via_agent: boolean
  detail: {
    action?: string
    changedFields?: unknown
    statusId?: string | null
    assigneeId?: string | null
    projectId?: string | null
    fromProjectId?: string | null
  } | null
  kinds: string[]
  actor_name: string | null
  event_status_label: string | null
  event_assignee_name: string | null
  event_project_name: string | null
  title: string
  number: number | null
  project_id: string
  project_name: string
  project_key: string | null
  status_id: string
  status_label: string | null
  status_terminal: boolean | null
  assignee_id: string | null
  assignee_name: string | null
  priority: string
  due_date: Date | string | null
  release: string | null
  thread_id: string
  updated_at: Date | string
  total_count: string | number
}

function iso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString()
}

function isoDay(value: Date | string | null): string | null {
  if (value === null) return null
  if (value instanceof Date) return value.toISOString().slice(0, 10)
  return value.slice(0, 10)
}

/** The fields an `edited` change named, without the ones that say nothing. */
function editedFields(detail: InvolvedRow["detail"]): string[] {
  const changed = detail?.changedFields
  if (!Array.isArray(changed)) return []
  return changed.filter((f): f is string => typeof f === "string" && !NON_FIELDS.has(f))
}

function summarize(inv: Omit<Involvement, "summary">): string {
  const agent = inv.viaAgent ? "your agent" : "you"
  switch (inv.kind) {
    case "commented":
      return `${agent} commented`
    case "mentioned":
      return inv.actorName ? `${inv.actorName} mentioned you` : "you were mentioned"
    case "status_changed":
      return inv.statusLabel ? `${agent} moved it to ${inv.statusLabel}` : `${agent} moved it`
    case "assigned_self":
      return `${agent} assigned it to you`
    case "assigned_other":
      return `${agent} assigned it to ${inv.assigneeName ?? "someone else"}`
    case "unassigned":
      return `${agent} unassigned it`
    case "moved_project":
      return inv.projectName
        ? `${agent} moved it to project ${inv.projectName}`
        : `${agent} moved it to another project`
    case "edited":
      return inv.fields.length > 0
        ? `${agent} changed ${inv.fields.join(", ")}`
        : `${agent} edited it`
    case "assigned_by":
      return inv.actorName ? `${inv.actorName} assigned it to you` : "it was assigned to you"
    case "created":
      return `${agent} created it`
    case "assignee":
      return "assigned to you, updated"
  }
}

/**
 * The tasks `userId` was involved in within the last `days` days, newest
 * involvement first. Runs in the caller's RLS transaction: the final join to
 * the tasks is what decides visibility.
 */
export async function listRecentlyInvolvedTasks(
  args: ListRecentlyInvolvedArgs,
): Promise<{ items: InvolvedTask[]; totalCount: number; days: number }> {
  const { tx, orgId, userId } = args
  const days = normalizeInvolvedDays(args.days)
  const rawLimit = args.limit ?? INVOLVED_DEFAULT_LIMIT
  const limit = Math.min(INVOLVED_MAX_LIMIT, Math.max(1, Math.floor(rawLimit) || 1))
  if (args.projectId !== undefined && !new RegExp(UUID_PATTERN).test(args.projectId)) {
    throw new ProjectsServiceError(400, "invalid_params", "projectId must be a uuid")
  }

  const projectWhere = args.projectId
    ? drizzleSql`AND t.project_id = ${args.projectId}::uuid`
    : drizzleSql``

  const filters: SQL[] = []
  const q = args.query?.trim()
  if (q) {
    const pattern = `%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`
    filters.push(
      drizzleSql`(t.title ILIKE ${pattern} OR (p.key IS NOT NULL AND upper(p.key || '-' || t.number::text) LIKE upper(${q.replace(/[\\%_]/g, (c) => `\\${c}`)}) || '%'))`,
    )
  }
  const releaseCond = releaseFilterSql("t", orgId, args.release)
  if (releaseCond) filters.push(releaseCond)
  const labelCond = await labelFilterCondition(tx, orgId, "t", args.labels)
  if (labelCond) filters.push(labelCond)
  const extraWhere = filters.length
    ? drizzleSql.join(
        filters.map((f) => drizzleSql`AND ${f}`),
        drizzleSql` `,
      )
    : drizzleSql``

  const me = drizzleSql`${userId}::uuid`
  const org = drizzleSql`${orgId}::uuid`
  const auditDetail = drizzleSql`jsonb_build_object(
    'action', al.action,
    'changedFields', al.changes->'changedFields',
    'statusId', al.changes->>'statusId',
    'assigneeId', al.changes->>'assigneeId',
    'projectId', al.changes->>'projectId',
    'fromProjectId', al.changes->>'fromProjectId'
  )`

  const rows = extractRows<InvolvedRow>(
    await tx.execute(drizzleSql`
      WITH win AS (SELECT now() - make_interval(days => ${days}::int) AS since),
      -- Activity on discussion threads, read from the person's own rows.
      thread_activity AS MATERIALIZED (
        -- Comments they wrote (their agent's included).
        SELECT m.thread_id, m.created_at AS at, 'commented'::text AS kind,
               NULL::uuid AS actor_id, (m.author_type <> 'user') AS via_agent, 1 AS prio
        FROM ${kernelRel("messages")} m
        WHERE m.org_id = ${org} AND m.author_id = ${me}
          AND m.created_at >= (SELECT since FROM win) AND m.deleted_at IS NULL
        UNION ALL
        -- Mentions of them (the attention row is keyed on the thread).
        SELECT ${guardedUuid(drizzleSql`ae.entity_id`)}, ae.occurred_at, 'mentioned', ae.actor_id,
               false, 2
        FROM ${kernelRel("attention_events")} ae
        WHERE ae.user_id = ${me} AND ae.org_id = ${org}
          AND ae.occurred_at >= (SELECT since FROM win)
          AND ae.app = 'kernel' AND ae.entity_type = 'thread' AND ae.kind = 'mention'
      ),
      -- Which of those threads are task discussions (one index probe each).
      thread_tasks AS MATERIALIZED (
        SELECT t.id, t.thread_id
        FROM ${projectsRel("tasks")} t
        WHERE t.org_id = ${org}
          AND t.thread_id IN (SELECT DISTINCT thread_id FROM thread_activity WHERE thread_id IS NOT NULL)
      ),
      cand AS (
        SELECT tt.id AS task_id, ta.at, ta.kind, ta.actor_id, NULL::jsonb AS detail,
               ta.via_agent, ta.prio
        FROM thread_activity ta
        JOIN thread_tasks tt ON tt.thread_id = ta.thread_id
        UNION ALL
        -- Changes they made (status, assignee, fields, moves). Creation is
        -- read from the task itself below.
        SELECT ${guardedUuid(drizzleSql`al.entity_id`)}, al.timestamp,
               CASE
                 WHEN al.action = 'task.moved'
                   AND al.changes->>'fromProjectId' IS NOT NULL
                   AND al.changes->>'fromProjectId' IS DISTINCT FROM al.changes->>'projectId'
                   THEN 'moved_project'
                 WHEN al.action = 'task.moved' THEN 'status_changed'
                 WHEN al.changes->'changedFields' ?| array['statusId', 'statusLabel']
                   THEN 'status_changed'
                 WHEN al.changes->'changedFields' ? 'assigneeId' THEN
                   CASE
                     WHEN al.changes->>'assigneeId' IS NULL THEN 'unassigned'
                     WHEN al.changes->>'assigneeId' = ${userId} THEN 'assigned_self'
                     ELSE 'assigned_other'
                   END
                 ELSE 'edited'
               END,
               NULL::uuid, ${auditDetail},
               (al.agent_id IS NOT NULL), 0
        FROM ${kernelRel("audit_log")} al
        WHERE al.org_id = ${org} AND al.actor_id = ${me}
          AND al.timestamp >= (SELECT since FROM win)
          AND al.app = 'projects' AND al.entity_type = 'task'
          AND al.action IN ('task.updated', 'task.moved')
        UNION ALL
        -- Someone else assigned them a task that is still theirs: the latest
        -- such change per task, probed by the task (audit entity index).
        SELECT t.id, ab.timestamp, 'assigned_by', ab.actor_id, NULL::jsonb, ab.via_agent, 0
        FROM ${projectsRel("tasks")} t
        CROSS JOIN LATERAL (
          SELECT al.timestamp, al.actor_id, (al.agent_id IS NOT NULL) AS via_agent
          FROM ${kernelRel("audit_log")} al
          WHERE al.org_id = t.org_id AND al.entity_type = 'task' AND al.entity_id = t.id::text
            AND al.timestamp >= (SELECT since FROM win)
            AND al.app = 'projects' AND al.actor_id IS DISTINCT FROM ${me}
            AND al.changes->>'assigneeId' = ${userId}
            AND (al.action = 'task.created' OR al.changes->'changedFields' ? 'assigneeId')
          ORDER BY al.timestamp DESC
          LIMIT 1
        ) ab
        WHERE t.org_id = ${org} AND t.assignee_id = ${me} AND t.archived_at IS NULL
          AND t.updated_at >= (SELECT since FROM win)
        UNION ALL
        -- Tasks they created.
        SELECT t.id, t.created_at, 'created', NULL::uuid, NULL::jsonb,
               (t.created_by_agent_label IS NOT NULL), 0
        FROM ${projectsRel("tasks")} t
        WHERE t.org_id = ${org} AND t.created_by = ${me}
          AND t.created_at >= (SELECT since FROM win)
        UNION ALL
        -- Theirs, and something changed on it in the window. Lowest priority:
        -- a more specific reason at the same moment wins.
        SELECT t.id, t.updated_at, 'assignee', NULL::uuid, NULL::jsonb, false, 9
        FROM ${projectsRel("tasks")} t
        WHERE t.org_id = ${org} AND t.assignee_id = ${me}
          AND t.updated_at >= (SELECT since FROM win)
      ),
      latest AS (
        SELECT DISTINCT ON (task_id) task_id, at, kind, actor_id, detail, via_agent
        FROM cand
        ORDER BY task_id, at DESC, prio ASC
      ),
      kinds AS (
        SELECT task_id, array_agg(kind ORDER BY at DESC) AS kinds
        FROM cand
        GROUP BY task_id
      ),
      -- The page first (visibility, filters, order, limit), then the names
      -- for its rows only: one key lookup each, never a scan per candidate.
      page AS MATERIALIZED (
        SELECT
          l.task_id, l.at, l.kind, l.via_agent, l.actor_id, l.detail, k.kinds,
          t.org_id, t.title, t.number, t.project_id, p.name AS project_name, p.key AS project_key,
          t.status_id, t.assignee_id, t.priority, t.due_date, t.release,
          t.thread_id, t.updated_at,
          count(*) OVER () AS total_count
        FROM latest l
        JOIN kinds k ON k.task_id = l.task_id
        JOIN ${projectsRel("tasks")} t ON t.id = l.task_id AND t.org_id = ${org}
        JOIN ${projectsRel("projects")} p ON p.id = t.project_id AND p.org_id = t.org_id
        WHERE t.archived_at IS NULL AND p.archived_at IS NULL
          ${projectWhere}
          ${extraWhere}
        ORDER BY l.at DESC, t.id
        LIMIT ${limit}
      )
      SELECT
        pg.*,
        s.label AS status_label, s.terminal AS status_terminal,
        (SELECT u.name FROM ${kernelRel("users")} u
          WHERE u.id = pg.assignee_id AND u.org_id = pg.org_id) AS assignee_name,
        (SELECT u.name FROM ${kernelRel("users")} u
          WHERE u.id = pg.actor_id AND u.org_id = pg.org_id) AS actor_name,
        (SELECT es.label FROM ${projectsRel("project_statuses")} es
          WHERE es.id = ${guardedUuid(drizzleSql`(pg.detail->>'statusId')`)}
            AND es.org_id = pg.org_id) AS event_status_label,
        (SELECT u.name FROM ${kernelRel("users")} u
          WHERE u.id = ${guardedUuid(drizzleSql`(pg.detail->>'assigneeId')`)}
            AND u.org_id = pg.org_id) AS event_assignee_name,
        (SELECT ep.name FROM ${projectsRel("projects")} ep
          WHERE ep.id = ${guardedUuid(drizzleSql`(pg.detail->>'projectId')`)}
            AND ep.org_id = pg.org_id) AS event_project_name
      FROM page pg
      LEFT JOIN ${projectsRel("project_statuses")} s
        ON s.id = pg.status_id AND s.org_id = pg.org_id
      ORDER BY pg.at DESC, pg.task_id
    `),
  )

  const items = rows.map((r): InvolvedTask => {
    const kind = r.kind as InvolvementKind
    const base: Omit<Involvement, "summary"> = {
      kind,
      at: iso(r.at),
      viaAgent: r.via_agent === true,
      actorName: kind === "mentioned" || kind === "assigned_by" ? r.actor_name : null,
      statusLabel: kind === "status_changed" ? (r.event_status_label ?? r.status_label) : null,
      assigneeName: kind === "assigned_other" ? r.event_assignee_name : null,
      projectName: kind === "moved_project" ? (r.event_project_name ?? r.project_name) : null,
      fields: kind === "edited" ? editedFields(r.detail) : [],
    }
    // Most recent first, without repeats.
    const kinds: InvolvementKind[] = []
    for (const k of r.kinds as InvolvementKind[]) if (!kinds.includes(k)) kinds.push(k)
    return {
      id: r.task_id,
      key:
        r.project_key != null && r.number != null ? formatTaskKey(r.project_key, r.number) : null,
      title: r.title,
      projectId: r.project_id,
      projectName: r.project_name,
      projectKey: r.project_key,
      statusId: r.status_id,
      statusLabel: r.status_label,
      statusTerminal: r.status_terminal ?? false,
      assigneeId: r.assignee_id,
      assigneeName: r.assignee_name,
      priority: r.priority,
      dueDate: isoDay(r.due_date),
      release: r.release,
      threadId: r.thread_id,
      updatedAt: iso(r.updated_at),
      involvement: { ...base, summary: summarize(base) },
      involvementKinds: kinds,
    }
  })
  await attachTaskTimeKeys(args.tx, args.orgId, items)
  const first = rows[0]
  return { items, totalCount: first ? Number(first.total_count) : 0, days }
}
