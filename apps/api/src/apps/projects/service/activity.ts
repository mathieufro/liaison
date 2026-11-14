// SPDX-License-Identifier: FSL-1.1-ALv2
/**
 * Projects' rows for a company's or a contact's timeline (`projects:activity_read`),
 * under the caller's row security: a deal opened and closed, a deal's subtasks,
 * and the tasks of the company's own projects. Projects keeps no history of a
 * task's moves between stages, so a stage move gives no row of its own.
 */
import { sql as drizzleSql } from "drizzle-orm"
import { extractRows, type RlsClient } from "~/db"
import { schemaRef } from "~/db/schema-ref"
import { quoteIdent } from "~/lib/sql-utils"
import {
  type ActivitySourceAnswer,
  newestFirst,
  olderThanCursor,
  parseSourceInput,
} from "~/modules/contacts/activity"

const tableRef = (name: string) =>
  drizzleSql.raw(`${quoteIdent(schemaRef("app_projects"))}.${quoteIdent(name)}`)
const AT = drizzleSql.raw("s.at")
const NID = drizzleSql.raw("s.nid")

export async function projectActivityRows(
  db: RlsClient,
  orgId: string,
  raw: unknown,
): Promise<ActivitySourceAnswer> {
  const input = parseSourceInput(raw)
  if (input.dealIds.length === 0 && !input.companyId) return { rows: [] }
  const deals = `{${input.dealIds.join(",")}}`
  const company = input.companyId
  const rows = extractRows<{
    nid: string
    at: string | Date
    kind: string
    key: string | null
    number: number | null
    title: string
    outcome: string | null
    task_id: string
    contact_id: string | null
  }>(
    await db.execute(drizzleSql`
      SELECT * FROM (
        SELECT t.id::text || ':opened' AS nid, date_trunc('milliseconds', t.created_at) AS at,
               'opened' AS kind, p.key, t.number, t.title, NULL::text AS outcome,
               t.id::text AS task_id, d.contact_id::text AS contact_id
          FROM ${tableRef("deals")} d
          JOIN ${tableRef("tasks")} t ON t.id = d.task_id AND t.org_id = d.org_id
          JOIN ${tableRef("projects")} p ON p.id = t.project_id
         WHERE d.org_id = ${orgId}::uuid AND d.task_id = ANY(${deals}::uuid[]) AND t.archived_at IS NULL
        UNION ALL
        SELECT t.id::text || ':closed', date_trunc('milliseconds', d.closed_at), 'closed', p.key,
               t.number, t.title, d.outcome, t.id::text, d.contact_id::text
          FROM ${tableRef("deals")} d
          JOIN ${tableRef("tasks")} t ON t.id = d.task_id AND t.org_id = d.org_id
          JOIN ${tableRef("projects")} p ON p.id = t.project_id
         WHERE d.org_id = ${orgId}::uuid AND d.task_id = ANY(${deals}::uuid[]) AND d.closed_at IS NOT NULL
           AND t.archived_at IS NULL
        UNION ALL
        SELECT s.id::text, date_trunc('milliseconds', s.created_at), 'subtask', p.key, s.number,
               s.title, NULL, s.id::text, NULL
          FROM ${tableRef("tasks")} s
          JOIN ${tableRef("projects")} p ON p.id = s.project_id
         WHERE s.org_id = ${orgId}::uuid AND s.parent_task_id = ANY(${deals}::uuid[]) AND s.archived_at IS NULL
        UNION ALL
        SELECT t.id::text, date_trunc('milliseconds', t.created_at), 'task', p.key, t.number,
               t.title, NULL, t.id::text, NULL
          FROM ${tableRef("tasks")} t
          JOIN ${tableRef("projects")} p ON p.id = t.project_id
         WHERE t.org_id = ${orgId}::uuid AND ${company}::uuid IS NOT NULL
           AND p.company_id = ${company}::uuid AND t.archived_at IS NULL
           AND NOT (t.id = ANY(${deals}::uuid[]))
      ) s
      WHERE ${olderThanCursor(AT, NID, input)}
      ${newestFirst(AT, NID, input)}`),
  )
  return {
    rows: rows.map((r) => {
      const ref = r.key && r.number != null ? `${r.key}-${r.number}` : r.title
      const title =
        r.kind === "opened"
          ? `${ref} ${r.title} opened`
          : r.kind === "closed"
            ? `${ref} ${r.outcome === "won" ? "won" : r.outcome === "lost" ? "lost" : "closed"}`
            : r.kind === "subtask"
              ? `${ref} ${r.title} added`
              : `${ref} ${r.title} created`
      return {
        id: r.nid,
        at: new Date(r.at).toISOString(),
        title,
        who: null,
        contactId: r.contact_id,
        href: { app: "projects", entityType: "task", entityId: r.task_id },
      }
    }),
  }
}
