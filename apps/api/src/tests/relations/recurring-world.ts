// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The invoicing half of the money world (payments-world.ts builds the case): an issuer profile, an
// issued invoice whose party is a person (with the person's name copied onto it), a monthly
// schedule billing a company and that person, and a month-end run whose item names the schedule
// and the draft it made. Rows are written as the invoicing app's own jobs write them; each link
// is read back as the workspace reads it, under the reader's row security.

import { randomUUID } from "node:crypto"
import { sql as drizzleSql } from "drizzle-orm"
import { extractRows } from "~/db"
import { sql } from "~/db/connection"
import type { UserContext } from "~/db/rls"
import { withRlsContext } from "~/db/rls"
import { schemaRef } from "~/db/schema-ref"
import { insertSql, type RowValue } from "~/seed/factories/org/test-rows"
import type { Sight } from "./classes"

/** `<app schema as the run names it>.<table>`. */
export const inv = (table: string) => `${schemaRef("app_invoicing")}.${table}`

export async function insertRow(table: string, row: Record<string, RowValue>): Promise<void> {
  await sql.unsafe(insertSql(table, row))
}

export interface InvoicingRows {
  issuerId: string
  documentId: string
  documentName: string
  scheduleId: string
  runId: string
  runItemId: string
  draftId: string
}

/** The visible state a read shows once the link no longer points anywhere. */
export const UNLINKED = "unlinked"

export async function writeInvoicing(p: {
  orgId: string
  adminId: string
  tag: string
  companyId: string
  contactId: string
  contactName: string
  /** The schedule bills the company too (else the person alone). */
  scheduleBillsCompany: boolean
  /** The person the schedule bills; the invoices' person when absent. */
  scheduleContactId?: string
}): Promise<InvoicingRows> {
  const issuerId = randomUUID()
  await insertRow(inv("issuer_profiles"), {
    id: issuerId,
    org_id: p.orgId,
    legal_name: `Maison Issuer ${p.tag}`,
    country: "FR",
    default_currency: "EUR",
  })
  const documentId = randomUUID()
  await insertRow(inv("documents"), {
    id: documentId,
    org_id: p.orgId,
    type: "invoice",
    status: "issued",
    issuer_profile_id: issuerId,
    currency: "EUR",
    number: `INV-${p.tag}-1`,
    counterparty_contact_id: p.contactId,
    counterparty_name: p.contactName,
    issued_at: new Date().toISOString(),
    grand_total_minor: 120000,
  })
  const scheduleId = randomUUID()
  await insertRow(inv("recurring_schedules"), {
    id: scheduleId,
    org_id: p.orgId,
    issuer_profile_id: issuerId,
    company_id: p.scheduleBillsCompany ? p.companyId : null,
    contact_id: p.scheduleContactId ?? p.contactId,
    repeats: "month",
    billing_day: "1",
    created_by: p.adminId,
  })
  const draftId = randomUUID()
  await insertRow(inv("documents"), {
    id: draftId,
    org_id: p.orgId,
    type: "invoice",
    status: "draft",
    issuer_profile_id: issuerId,
    currency: "EUR",
    counterparty_contact_id: p.contactId,
    counterparty_name: p.contactName,
  })
  const runId = randomUUID()
  await insertRow(inv("recurring_runs"), {
    id: runId,
    org_id: p.orgId,
    issuer_profile_id: issuerId,
    issue_on: "2026-12-01",
    latest_issue_on: "2026-12-05",
    period_label: "November 2026",
  })
  const runItemId = randomUUID()
  await insertRow(inv("recurring_run_items"), {
    id: runItemId,
    org_id: p.orgId,
    run_id: runId,
    schedule_id: scheduleId,
    schedule_version: 1,
    period_key: "2026-11",
    period_start: "2026-11-01",
    period_end: "2026-11-30",
    document_id: draftId,
    position: 1,
  })
  return {
    issuerId,
    documentId,
    documentName: p.contactName,
    scheduleId,
    runId,
    runItemId,
    draftId,
  }
}

/** One row of an app table as `ctx` reads it under its row security, or null. */
export async function rowAs(
  ctx: UserContext,
  table: string,
  where: { column: string; value: string },
  columns: readonly string[],
): Promise<Record<string, string | null> | null> {
  return withRlsContext(ctx, async (tx) => {
    const cols = columns.map((c) => `${c}::text AS ${c}`).join(", ")
    const [row] = extractRows<Record<string, string | null>>(
      await tx.execute(
        drizzleSql`SELECT ${drizzleSql.raw(cols)} FROM ${drizzleSql.raw(table)} WHERE ${drizzleSql.raw(where.column)}::text = ${where.value}`,
      ),
    )
    return row ?? null
  })
}

/** A sight of a row that points at `column`: no row is no sight, a cleared column is unlinked. */
export function sightOfRow(
  row: Record<string, string | null> | null,
  column: string,
  label?: string,
): Sight {
  if (!row) return { visible: false }
  const points = row[column] ?? null
  return {
    visible: true,
    points,
    label: label ? (row[label] ?? null) : null,
    state: points ? null : UNLINKED,
  }
}

/** Rows of an app table naming `id` in `column`, read past row security (the effect checks). */
export async function countRows(table: string, column: string, id: string): Promise<number> {
  const [row] = (await sql.unsafe(
    `SELECT count(*)::int AS n FROM ${table} WHERE ${column}::text = $1`,
    [id],
  )) as Array<{ n: number }>
  return row?.n ?? 0
}

/** One column of one row, read past row security. */
export async function columnValue(
  table: string,
  id: { column: string; value: string },
  column: string,
): Promise<string | null | undefined> {
  const [row] = (await sql.unsafe(
    `SELECT ${column}::text AS v FROM ${table} WHERE ${id.column}::text = $1`,
    [id.value],
  )) as Array<{ v: string | null }>
  return row ? row.v : undefined
}
