// SPDX-License-Identifier: FSL-1.1-ALv2
/**
 * Tickets' rows for a company's or a contact's timeline (`tickets:activity_read`):
 * a ticket opened, a note on it, and its closing, read under the caller's row
 * security.
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

const tableRef = (schema: string, name: string) =>
  drizzleSql.raw(`${quoteIdent(schemaRef(schema))}.${quoteIdent(name)}`)
const AT = drizzleSql.raw("s.at")
const NID = drizzleSql.raw("s.nid")

export async function ticketActivityRows(
  db: RlsClient,
  orgId: string,
  raw: unknown,
): Promise<ActivitySourceAnswer> {
  const input = parseSourceInput(raw)
  if (input.contactIds.length === 0) return { rows: [] }
  const ids = `{${input.contactIds.join(",")}}`
  const rows = extractRows<{
    nid: string
    at: string | Date
    kind: string
    handle: string | null
    subject: string | null
    ticket_id: string
    contact_id: string | null
    who: string | null
  }>(
    await db.execute(drizzleSql`
      WITH t AS MATERIALIZED (
        SELECT t.id, t.handle, t.subject, t.status, t.contact_id, t.created_at, t.updated_at, ct.name AS who
          FROM ${tableRef("app_tickets", "tickets")} t
          LEFT JOIN ${tableRef("kernel", "contacts")} ct ON ct.id = t.contact_id AND ct.org_id = t.org_id
         WHERE t.org_id = ${orgId}::uuid AND t.contact_id = ANY(${ids}::uuid[])
      )
      SELECT * FROM (
        SELECT t.id::text || ':opened' AS nid, date_trunc('milliseconds', t.created_at) AS at,
               'opened' AS kind, t.handle, t.subject, t.id::text AS ticket_id,
               t.contact_id::text AS contact_id, t.who
          FROM t
        UNION ALL
        SELECT t.id::text || ':closed', date_trunc('milliseconds', t.updated_at),
               'closed', t.handle, t.subject, t.id::text, t.contact_id::text, t.who
          FROM t WHERE t.status = 'closed'
        UNION ALL
        SELECT m.id::text, date_trunc('milliseconds', m.created_at),
               'note', t.handle, t.subject, t.id::text, t.contact_id::text, m.author_label
          FROM ${tableRef("app_tickets", "messages")} m
          JOIN t ON t.id = m.ticket_id
         WHERE m.org_id = ${orgId}::uuid AND m.kind = 'note'
      ) s
      WHERE ${olderThanCursor(AT, NID, input)}
      ${newestFirst(AT, NID, input)}`),
  )
  return {
    rows: rows.map((r) => {
      const name = [r.handle, r.subject].filter(Boolean).join(" ") || "Ticket"
      const title =
        r.kind === "opened"
          ? `${name} opened`
          : r.kind === "closed"
            ? `${name} closed`
            : `Note on ${name}`
      return {
        id: r.nid,
        at: new Date(r.at).toISOString(),
        title,
        who: r.who,
        contactId: r.contact_id,
        href: { app: "tickets", entityType: "ticket", entityId: r.ticket_id },
      }
    }),
  }
}
