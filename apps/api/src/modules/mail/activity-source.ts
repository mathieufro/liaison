// SPDX-License-Identifier: FSL-1.1-ALv2
/**
 * Mail's rows for a company's or a contact's timeline (`mail:activity_read`):
 * one per message with one of the people, newest first, read under the
 * caller's row security, so a colleague's private mailbox gives no row. A
 * message whose content is sealed reads "Message": its date and direction only.
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

export async function mailActivityRows(
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
    direction: string
    subject: string | null
    sealed: boolean
    contact_id: string | null
    conversation_id: string
    who: string | null
  }>(
    await db.execute(drizzleSql`
      SELECT * FROM (
        SELECT m.id::text AS nid,
               date_trunc('milliseconds', COALESCE(m.sent_at, m.synced_at)) AS at,
               m.direction, m.subject,
               (m.subject IS NULL AND m.subject_ciphertext IS NOT NULL) AS sealed,
               cv.contact_id::text AS contact_id, m.conversation_id::text AS conversation_id,
               ct.name AS who
          FROM ${tableRef("app_mail", "messages")} m
          JOIN ${tableRef("app_mail", "conversations")} cv ON cv.id = m.conversation_id AND cv.org_id = m.org_id
          LEFT JOIN ${tableRef("kernel", "contacts")} ct ON ct.id = cv.contact_id AND ct.org_id = cv.org_id
         WHERE m.org_id = ${orgId}::uuid AND cv.contact_id = ANY(${ids}::uuid[])
           AND COALESCE(m.sent_at, m.synced_at) IS NOT NULL
      ) s
      WHERE ${olderThanCursor(AT, NID, input)}
      ${newestFirst(AT, NID, input)}`),
  )
  return {
    rows: rows.map((r) => {
      const subject = r.sealed ? null : r.subject?.trim() || null
      const title = r.sealed
        ? "Message"
        : r.direction === "outbound"
          ? `${subject ?? "(no subject)"} sent to ${r.who ?? "them"}`
          : (subject ?? "(no subject)")
      return {
        id: r.nid,
        at: new Date(r.at).toISOString(),
        title,
        who: r.who,
        contactId: r.contact_id,
        href: { app: "mail", entityType: "conversation", entityId: r.conversation_id },
      }
    }),
  }
}
