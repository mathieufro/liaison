// SPDX-License-Identifier: FSL-1.1-ALv2
/**
 * Invoicing's rows for a company's or a contact's timeline (the `activity_read`
 * source the kernel calls): a document issued, an invoice paid, a credit note
 * issued, a recurring schedule that bills the person (at its creation, with its
 * cadence and amount, opening the schedule). Never a draft document. Read live,
 * so a deleted document is gone at once.
 *
 * Rows are ordered newest first by (time, `<prefix><id>`), and only rows
 * strictly older than the cursor come back. A document's issue date is a day,
 * so many share one time, and a payment can come long after its issue, so no
 * order of the documents bounds the rows: the read takes every document of
 * these people, a page of `page` at a time in a fixed order (the app database
 * answers equality and `in` only, at most 1 000 rows per call), and applies the
 * cursor to the rows. Nothing past a cap is ever dropped.
 */
import type { ReadsDb } from "./reads"

/** Documents per database call: the most the app database returns at once. */
export const ACTIVITY_READ_PAGE = 1000

interface Cursor {
  at: string
  id: string
}

interface Input {
  contactIds: string[]
  before: Cursor | null
  limit: number
  prefix: string
}

interface Row {
  id: string
  at: string
  title: string
  who: string | null
  contactId: string | null
  href: { app: string; entityType: string; entityId: string } | null
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

function readInput(raw: unknown): Input {
  const v = (raw ?? {}) as Record<string, unknown>
  const ids = Array.isArray(v.contactIds)
    ? v.contactIds.filter((x): x is string => typeof x === "string" && UUID.test(x)).slice(0, 50)
    : []
  const b = v.before as { at?: unknown; id?: unknown } | null | undefined
  return {
    contactIds: ids,
    before:
      b && typeof b.at === "string" && typeof b.id === "string"
        ? { at: new Date(b.at).toISOString(), id: b.id }
        : null,
    limit: Math.min(100, Math.max(1, Number(v.limit) || 30)),
    prefix: typeof v.prefix === "string" ? v.prefix : "",
  }
}

/** Newest first, then by id as code units: the kernel's own order. */
function compare(a: Cursor, b: Cursor): number {
  const ta = Date.parse(a.at)
  const tb = Date.parse(b.at)
  if (ta !== tb) return tb - ta
  return a.id < b.id ? 1 : a.id > b.id ? -1 : 0
}

function dayStart(value: string): Date {
  return new Date(`${value.slice(0, 10)}T00:00:00.000Z`)
}

function amount(minor: unknown, currency: unknown): string {
  const n = Number(minor)
  if (!Number.isFinite(n)) return ""
  return `, ${(n / 100).toFixed(2)} ${typeof currency === "string" ? currency : ""}`.trimEnd()
}

const CADENCE: Record<string, string> = { month: "monthly", quarter: "quarterly", year: "yearly" }

/** A schedule's lines summed before VAT: what each of its invoices bills. */
function scheduleAmount(raw: unknown): string {
  let lines: unknown = raw
  if (typeof raw === "string") {
    try {
      lines = JSON.parse(raw)
    } catch {
      return ""
    }
  }
  if (!Array.isArray(lines) || lines.length === 0) return ""
  let total = 0
  for (const l of lines as Array<Record<string, unknown>>) {
    const qty = Number(l?.qty ?? l?.quantity ?? 1)
    const unit = Number(l?.unit_price_minor)
    if (!Number.isFinite(qty) || !Number.isFinite(unit)) return ""
    total += qty * unit
  }
  return `, ${(total / 100).toFixed(2)} before VAT`
}

const LABEL: Record<string, string> = {
  invoice: "Invoice",
  quote: "Quote",
  proforma: "Proforma",
  purchase_order: "Purchase order",
  credit_note: "Credit note",
}

export async function activityRead(ctx: { db: ReadsDb }, raw: unknown, page = ACTIVITY_READ_PAGE) {
  const input = readInput(raw)
  if (input.contactIds.length === 0) return { rows: [] }
  const size = Math.min(ACTIVITY_READ_PAGE, Math.max(1, Math.floor(page)))
  const docs: Array<Record<string, unknown>> = []
  for (let offset = 0; ; offset += size) {
    const batch = (await ctx.db.findMany("documents", {
      where: { counterparty_contact_id: { in: input.contactIds } },
      orderBy: { issued_at: "desc", id: "desc" },
      limit: size,
      offset,
    })) as Array<Record<string, unknown>>
    docs.push(...batch)
    if (batch.length < size) break
  }
  const rows: Row[] = []
  const push = (row: Row) => {
    if (input.before && compare({ at: row.at, id: `${input.prefix}${row.id}` }, input.before) <= 0)
      return
    rows.push(row)
  }
  for (const d of docs) {
    const id = String(d.id)
    if (d.status === "draft" || typeof d.issued_at !== "string") continue
    const type = String(d.type ?? "invoice")
    const name = `${LABEL[type] ?? "Document"} ${d.number ?? ""}`.trim()
    const base = {
      who: typeof d.counterparty_name === "string" ? d.counterparty_name : null,
      contactId: typeof d.counterparty_contact_id === "string" ? d.counterparty_contact_id : null,
      href: { app: "invoicing", entityType: "document", entityId: id },
    }
    push({
      ...base,
      id: `${id}:issued`,
      at: dayStart(d.issued_at).toISOString(),
      title: `${name} ${type === "credit_note" ? "credited" : "issued"}${amount(d.grand_total_minor, d.currency)}`,
    })
    if (type === "invoice" && typeof d.paid_at === "string") {
      push({
        ...base,
        id: `${id}:paid`,
        at: new Date(d.paid_at).toISOString(),
        title: `${name} paid`,
      })
    }
  }
  for (let offset = 0; ; offset += size) {
    const batch = (await ctx.db.findMany("recurring_schedules", {
      where: { contact_id: { in: input.contactIds } },
      orderBy: { id: "asc" },
      limit: size,
      offset,
    })) as Array<Record<string, unknown>>
    for (const s of batch) {
      const id = String(s.id)
      const at = s.created_at instanceof Date ? s.created_at.toISOString() : s.created_at
      if (typeof at !== "string" || Number.isNaN(Date.parse(at))) continue
      const status = String(s.status ?? "active")
      push({
        id: `${id}:schedule`,
        at: new Date(at).toISOString(),
        title: `Recurring schedule, ${CADENCE[String(s.repeats)] ?? String(s.repeats ?? "")}${scheduleAmount(s.lines)}${status === "active" ? "" : ` (${status})`}`,
        who: null,
        contactId: typeof s.contact_id === "string" ? s.contact_id : null,
        href: { app: "invoicing", entityType: "schedule", entityId: id },
      })
    }
    if (batch.length < size) break
  }
  rows.sort((a, b) =>
    compare({ at: a.at, id: `${input.prefix}${a.id}` }, { at: b.at, id: `${input.prefix}${b.id}` }),
  )
  return { rows: rows.slice(0, input.limit) }
}
