// SPDX-License-Identifier: FSL-1.1-ALv2
//
// PROSPECTS NOBODY HAS HEARD FROM IN THREE YEARS.
//
// Contacts written to under professional interest are kept only while they may
// still want to hear from the organization. Once a day, every org gets ONE
// persisted Home row per person who can act on it (holders of both
// `kernel:users:admin` and `kernel:contacts:write`), listing the contacts
// recorded under `professional_interest` with no mail or ticket from them and no
// deal about them (as its contact or through their company) for three years,
// counted from the contact's creation at the earliest. Opens never count: none
// are recorded.
//
// It is a stored row, so Not now applies, and it is kept up to date: the list
// and the count are the current ones, and the row goes when nobody is left on
// it. A row someone has read comes back only when the list changes. Nothing is
// deleted here: a person decides what to keep.

import { sql as drizzleSql } from "drizzle-orm"
import { extractRows, type PrivilegedDb } from "~/db"
import { withPrivilegedDb, withSystemDb } from "~/db/privileged"
import { schemaRef } from "~/db/schema-ref"
import { appsLogger as log } from "~/lib/logger"
import { quoteIdent } from "~/lib/sql-utils"
import {
  SKIPPED_MOVING,
  sweepSkippingMoving,
  writeUnlessMoving,
} from "~/modules/org/transfer-state/skip-moving"
import { eligibleApprovers } from "~/modules/permissions/eligible-approvers"

const K = drizzleSql.raw(schemaRef("kernel"))

export const PROSPECT_RETENTION_KIND = "kernel:contacts.prospect_retention"
export const PROSPECT_RETENTION_ENTITY = "organization"
/** Who gets the row: they can see the people and remove them. */
export const PROSPECT_RETENTION_AUDIENCE_SCOPES = [
  "kernel:users:admin",
  "kernel:contacts:write",
] as const
/** Silent for this long, counted back from the run. */
export const PROSPECT_SILENCE_YEARS = 3
/** Contacts the row's metadata lists; the count is always the full one. */
const LISTED = 200

function tableOf(schema: string, name: string) {
  return drizzleSql.raw(`${quoteIdent(schemaRef(schema))}.${quoteIdent(name)}`)
}

async function present(tx: PrivilegedDb, schema: string, name: string): Promise<boolean> {
  const [row] = extractRows<{ present: boolean }>(
    await tx.execute(
      drizzleSql`SELECT to_regclass(${`${schemaRef(schema)}.${name}`}) IS NOT NULL AS present`,
    ),
  )
  return row?.present === true
}

/** The moment three years before `now`, by the calendar. */
export function silenceCutoff(now: Date): Date {
  const cutoff = new Date(now)
  cutoff.setUTCFullYear(cutoff.getUTCFullYear() - PROSPECT_SILENCE_YEARS)
  return cutoff
}

export interface SilentProspect {
  id: string
  name: string
}

/** The org's professional-interest contacts silent since `silenceCutoff(now)`, by name. */
export async function silentProspects(
  tx: PrivilegedDb,
  orgId: string,
  now: Date = new Date(),
): Promise<SilentProspect[]> {
  const cutoff = silenceCutoff(now).toISOString()
  const [mail, tickets, deals] = await Promise.all([
    present(tx, "app_mail", "messages"),
    present(tx, "app_tickets", "tickets"),
    present(tx, "app_projects", "deals"),
  ])
  const noMail = mail
    ? drizzleSql`
        AND NOT EXISTS (
          SELECT 1 FROM ${tableOf("app_mail", "conversations")} cv
            JOIN ${tableOf("app_mail", "messages")} m ON m.conversation_id = cv.id AND m.org_id = cv.org_id
           WHERE cv.org_id = c.org_id AND cv.contact_id = c.id AND m.direction = 'inbound'
             AND m.sent_at >= ${cutoff}::timestamptz)
        AND NOT EXISTS (
          SELECT 1 FROM ${tableOf("app_mail", "messages")} m
           WHERE m.org_id = c.org_id AND m.direction = 'inbound'
             AND lower(m.from_address ->> 'email') = lower(c.email)
             AND m.sent_at >= ${cutoff}::timestamptz)`
    : drizzleSql``
  const noTicket = tickets
    ? drizzleSql`
        AND NOT EXISTS (
          SELECT 1 FROM ${tableOf("app_tickets", "tickets")} t
           WHERE t.org_id = c.org_id AND t.contact_id = c.id AND t.created_at >= ${cutoff}::timestamptz)`
    : drizzleSql``
  const noDeal = deals
    ? drizzleSql`
        AND NOT EXISTS (
          SELECT 1 FROM ${tableOf("app_projects", "deals")} d
           WHERE d.org_id = c.org_id
             AND (d.contact_id = c.id OR (c.company_id IS NOT NULL AND d.company_id = c.company_id))
             AND GREATEST(d.created_at, d.updated_at, COALESCE(d.closed_at, d.created_at)) >= ${cutoff}::timestamptz)`
    : drizzleSql``
  return extractRows<SilentProspect>(
    await tx.execute(drizzleSql`
      SELECT c.id::text AS id, COALESCE(NULLIF(c.name, ''), c.email, c.id::text) AS name
        FROM ${K}.contacts c
       WHERE c.org_id = ${orgId}::uuid AND c.lawful_basis = 'professional_interest'
         AND c.created_at < ${cutoff}::timestamptz
         ${noMail} ${noTicket} ${noDeal}
       ORDER BY lower(COALESCE(c.name, '')), c.id`),
  )
}

function summaryOf(count: number): string {
  return count === 1
    ? `1 prospect has not written and had no deal for ${PROSPECT_SILENCE_YEARS} years: check whether to keep their details`
    : `${count} prospects have not written and had no deal for ${PROSPECT_SILENCE_YEARS} years: check whether to keep their details`
}

function sameList(a: unknown, b: string[]): boolean {
  if (!Array.isArray(a) || a.length !== b.length) return false
  const left = [...a].map(String).sort()
  const right = [...b].sort()
  return left.every((v, i) => v === right[i])
}

/**
 * Bring the org's retention rows up to date, in the caller's transaction: the
 * current list for each person who can act on it, or no unread row when nobody
 * is silent. Returns how many prospects are listed.
 */
export async function refreshProspectRetention(
  tx: PrivilegedDb,
  orgId: string,
  now: Date = new Date(),
): Promise<number> {
  const silent = await silentProspects(tx, orgId, now)
  if (silent.length === 0) {
    await tx.execute(drizzleSql`
      DELETE FROM ${K}.attention_events
       WHERE org_id = ${orgId}::uuid AND app = 'kernel' AND entity_type = ${PROSPECT_RETENTION_ENTITY}
         AND entity_id = ${orgId} AND kind = ${PROSPECT_RETENTION_KIND} AND read_at IS NULL`)
    return 0
  }
  const [admins, writers] = await Promise.all(
    PROSPECT_RETENTION_AUDIENCE_SCOPES.map((scope) => eligibleApprovers(tx, orgId, scope)),
  )
  const writerSet = new Set(writers)
  const audience = (admins ?? []).filter((id) => writerSet.has(id))
  const ids = silent.map((p) => p.id)
  const metadata = JSON.stringify({
    count: silent.length,
    contactIds: ids.slice(0, LISTED),
    names: silent.slice(0, 5).map((p) => p.name),
    since: silenceCutoff(now).toISOString(),
  })
  const summary = summaryOf(silent.length)
  // A row someone read stays read until the list it showed changes.
  const read = extractRows<{ user_id: string; metadata: { contactIds?: unknown } | null }>(
    await tx.execute(drizzleSql`
      SELECT DISTINCT ON (user_id) user_id::text AS user_id, metadata FROM ${K}.attention_events
       WHERE org_id = ${orgId}::uuid AND app = 'kernel' AND entity_type = ${PROSPECT_RETENTION_ENTITY}
         AND entity_id = ${orgId} AND kind = ${PROSPECT_RETENTION_KIND} AND read_at IS NOT NULL
       ORDER BY user_id, read_at DESC`),
  )
  const seen = new Map(read.map((r) => [r.user_id, r.metadata?.contactIds]))
  for (const userId of audience) {
    if (seen.has(userId) && sameList(seen.get(userId), ids.slice(0, LISTED))) continue
    await tx.execute(drizzleSql`
      INSERT INTO ${K}.attention_events
        (org_id, user_id, app, entity_type, entity_id, kind, urgency, summary, actor_id,
         actor_type, metadata, occurred_at, is_urgent, digest_state, digest_eligible_at, email_only)
      VALUES (${orgId}::uuid, ${userId}::uuid, 'kernel', ${PROSPECT_RETENTION_ENTITY}, ${orgId},
              ${PROSPECT_RETENTION_KIND}, 20, ${summary}, NULL, 'system', ${metadata}::jsonb,
              now(), false, 'not_eligible', now(), false)
      ON CONFLICT (user_id, app, entity_type, entity_id, kind)
        WHERE read_at IS NULL AND email_only = false
        DO UPDATE SET summary = EXCLUDED.summary, metadata = EXCLUDED.metadata`)
  }
  return silent.length
}

/**
 * The daily sweep: every org with a professional-interest contact or a row to
 * clear, each in its own write, leaving orgs being moved alone. Returns how many
 * orgs were brought up to date.
 */
export async function runProspectRetention(now: Date = new Date()): Promise<number> {
  const orgs = await sweepSkippingMoving((notMoving) =>
    withSystemDb("prospect-retention-orgs", async (tx) =>
      extractRows<{ org_id: string }>(
        await tx.execute(drizzleSql`
          SELECT DISTINCT org_id::text AS org_id FROM ${K}.contacts
           WHERE lawful_basis = 'professional_interest' AND ${notMoving(drizzleSql.raw("org_id"))}
          UNION
          SELECT DISTINCT org_id::text FROM ${K}.attention_events
           WHERE kind = ${PROSPECT_RETENTION_KIND} AND read_at IS NULL
             AND ${notMoving(drizzleSql.raw("org_id"))}`),
      ),
    ),
  )
  let done = 0
  for (const { org_id: orgId } of orgs) {
    try {
      const out = await writeUnlessMoving(orgId, () =>
        withPrivilegedDb(orgId, "prospect-retention", (tx) =>
          refreshProspectRetention(tx, orgId, now),
        ),
      )
      if (out !== SKIPPED_MOVING) done += 1
    } catch (err) {
      log.warn({ err, orgId }, "prospect retention: could not bring the org's row up to date")
    }
  }
  return done
}
