// SPDX-License-Identifier: FSL-1.1-ALv2
import type { AttentionItem } from "@liaison/shared"
import { sql as drizzleSql } from "drizzle-orm"
import { projectsRel } from "~/apps/projects/schema-refs"
import { dueBucketSql } from "~/apps/projects/service/due-status"
import { monthCloseItems } from "~/apps/projects/service/home-lines"
import { extractRows, type PrivilegedDb, type RlsClient, type RlsTx } from "~/db"

type SqlClient = RlsClient | RlsTx | PrivilegedDb

interface TaskAttentionRow {
  id: string
  assignee_id: string
  title: string
  project_id: string
  project_name: string
  updated_at: Date | string
  due_date: Date | string | null
  blocked: boolean
  days_over: number | null
  days_remaining: number | null
}

function toIso(value: Date | string | null | undefined): string {
  if (!value) return new Date().toISOString()
  return value instanceof Date ? value.toISOString() : value
}

export async function computeAttentionItems(
  tx: SqlClient,
  orgId: string,
  callerUserId: string,
  /** People away today who name the caller next in line: their tasks come too, tagged. */
  forUserIds: readonly string[] = [],
  /** Test seam for the month-close day; the feed passes nothing. */
  now?: Date,
): Promise<AttentionItem[]> {
  const items: AttentionItem[] = []
  const people = [callerUserId, ...forUserIds.filter((id) => id !== callerUserId)]
  const assignees = drizzleSql`t.assignee_id IN (${drizzleSql.join(
    people.map((id) => drizzleSql`${id}::uuid`),
    drizzleSql`, `,
  )})`
  const forUser = (r: TaskAttentionRow) =>
    r.assignee_id !== callerUserId ? { forUserId: r.assignee_id } : {}
  // A deleted task (in the bin) or a task of an archived project asks nothing
  // of anyone: neither can be worked on, so neither raises a row.
  const live = drizzleSql`t.archived_at IS NULL AND p.archived_at IS NULL`

  // Overdue: assigned to caller, non-terminal, not blocked, due_date < today.
  const overdue = await tx.execute(drizzleSql`
    SELECT t.id, t.title, t.project_id, p.name AS project_name, t.assignee_id::text AS assignee_id,
           t.updated_at, t.due_date, t.blocked,
           (CURRENT_DATE - t.due_date) AS days_over,
           NULL::int AS days_remaining
    FROM ${projectsRel("tasks")} t
    JOIN ${projectsRel("project_statuses")} s ON s.id = t.status_id
    JOIN ${projectsRel("projects")} p ON p.id = t.project_id
    WHERE t.org_id = ${orgId}::uuid
      AND ${assignees}
      AND ${live}
      AND NOT t.blocked
      AND ${dueBucketSql("t", "s")} = 'overdue'
    LIMIT 200
  `)
  for (const r of extractRows<TaskAttentionRow>(overdue)) {
    const daysOver = r.days_over ?? 0
    const urgency = Math.min(60 + daysOver * 4, 100)
    items.push({
      id: `projects:task_overdue:${r.id}`,
      app: "projects",
      entity: "task",
      entityId: r.id,
      kind: "task_overdue",
      summary: r.title,
      urgency,
      occurredAt: toIso(r.updated_at),
      action: { type: "open_entity", tabType: "projects:task", entityId: r.id },
      metadata: {
        projectId: r.project_id,
        projectName: r.project_name,
        daysOver,
        dueDate: toIso(r.due_date),
        ...forUser(r),
      },
    })
  }

  // Due this week: due_date in [today, today + 7d], non-terminal, not blocked.
  const dueSoon = await tx.execute(drizzleSql`
    SELECT t.id, t.title, t.project_id, p.name AS project_name, t.assignee_id::text AS assignee_id,
           t.updated_at, t.due_date, t.blocked,
           NULL::int AS days_over,
           (t.due_date - CURRENT_DATE) AS days_remaining
    FROM ${projectsRel("tasks")} t
    JOIN ${projectsRel("project_statuses")} s ON s.id = t.status_id
    JOIN ${projectsRel("projects")} p ON p.id = t.project_id
    WHERE t.org_id = ${orgId}::uuid
      AND ${assignees}
      AND ${live}
      AND NOT t.blocked
      AND ${dueBucketSql("t", "s")} = 'due_soon'
    LIMIT 200
  `)
  for (const r of extractRows<TaskAttentionRow>(dueSoon)) {
    const daysRemaining = r.days_remaining ?? 7
    const urgency = Math.max(30, Math.min(65, 30 + (7 - daysRemaining) * 5))
    items.push({
      id: `projects:task_due_this_week:${r.id}`,
      app: "projects",
      entity: "task",
      entityId: r.id,
      kind: "task_due_this_week",
      summary: r.title,
      urgency,
      occurredAt: toIso(r.updated_at),
      action: { type: "open_entity", tabType: "projects:task", entityId: r.id },
      metadata: {
        projectId: r.project_id,
        projectName: r.project_name,
        daysRemaining,
        dueDate: toIso(r.due_date),
        ...forUser(r),
      },
    })
  }

  // Blocked: t.blocked = true, non-terminal, assigned to caller.
  const blocked = await tx.execute(drizzleSql`
    SELECT t.id, t.title, t.project_id, p.name AS project_name, t.assignee_id::text AS assignee_id,
           t.updated_at, t.due_date, t.blocked,
           NULL::int AS days_over,
           NULL::int AS days_remaining
    FROM ${projectsRel("tasks")} t
    JOIN ${projectsRel("project_statuses")} s ON s.id = t.status_id
    JOIN ${projectsRel("projects")} p ON p.id = t.project_id
    WHERE t.org_id = ${orgId}::uuid
      AND ${assignees}
      AND ${live}
      AND NOT s.terminal
      AND t.blocked = true
    LIMIT 200
  `)
  for (const r of extractRows<TaskAttentionRow>(blocked)) {
    items.push({
      id: `projects:task_blocked:${r.id}`,
      app: "projects",
      entity: "task",
      entityId: r.id,
      kind: "task_blocked",
      summary: r.title,
      urgency: 50,
      occurredAt: toIso(r.updated_at),
      action: { type: "open_entity", tabType: "projects:task", entityId: r.id },
      metadata: { projectId: r.project_id, projectName: r.project_name, ...forUser(r) },
    })
  }

  // The month-close line, on its one day of the month, to the biller.
  items.push(...(await monthCloseItems(tx, orgId, callerUserId, forUserIds, now)))

  return items
}
