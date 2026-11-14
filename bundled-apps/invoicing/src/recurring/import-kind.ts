// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Import kind `invoicing.recurring-schedule` (manifest `import.kinds.recurring-schedule`):
// schedules from another tool. A record becomes a DRAFT schedule: it bills nothing until a person
// starts it, and it issues for review, never by itself. Dedup is the record's `externalRef`
// (`<source>:<key>`); an existing schedule is never touched.
import type { DbClient } from "@liaison/app-sdk"
import type { ImportBatch, ImportResult } from "../import-kind"
import { checkScheduleInput, type ScheduleLineInput } from "./tools"

type Row = Record<string, unknown>

interface Ctx {
  db: Pick<DbClient, "findMany" | "insert">
}

function str(v: unknown): string | null {
  return typeof v === "string" && v.trim() ? v.trim() : null
}

async function issuerFor(ctx: Ctx, record: Row): Promise<{ id: string; language: string | null }> {
  const named = str(record.issuerProfileId)
  if (named) {
    const found = (await ctx.db.findMany("issuer_profiles", {
      where: { id: named },
      limit: 1,
    })) as Row[]
    if (found.length === 0) throw new Error(`issuer_not_found: no issuer profile ${named}`)
    return { id: named, language: str(found[0]?.default_language) }
  }
  const all = (await ctx.db.findMany("issuer_profiles", {
    where: { archived_at: null },
    limit: 2,
  })) as Row[]
  if (all.length === 0)
    throw new Error("issuer_missing: the org has no issuer profile yet; create one first")
  if (all.length > 1)
    throw new Error(
      "issuer_ambiguous: the org has several issuer profiles; name one with issuerProfileId",
    )
  return { id: String(all[0]?.id), language: str(all[0]?.default_language) }
}

function toLines(raw: unknown): ScheduleLineInput[] {
  if (!Array.isArray(raw)) return []
  return (raw as Row[]).map((l) => ({
    description: String(l.description ?? ""),
    qty: typeof l.quantity === "number" ? l.quantity : Number(l.quantity ?? 1),
    unit_price_minor:
      typeof l.unitPriceMinor === "number" ? l.unitPriceMinor : Number(l.unitPriceMinor),
    vat_bp: typeof l.taxRateBp === "number" ? l.taxRateBp : 0,
    line_kind: (l.lineKind as ScheduleLineInput["line_kind"]) ?? "service",
  }))
}

/** Checks one record (throws its refusal) and returns the row it would write, or null to skip. */
async function prepare(ctx: Ctx, record: Row, dedupValue: string): Promise<Row | null> {
  const existing = (await ctx.db.findMany("recurring_schedules", {
    where: { external_ref: dedupValue },
    limit: 1,
  })) as Row[]
  if (existing.length > 0) return null
  const fields = {
    contact_id: String(record.contactId ?? ""),
    repeats: record.repeats as "month" | "quarter" | "year",
    billing_day: String(record.billingDay ?? ""),
    ends_on: str(record.endsOn),
    due_rule: record.dueRule as "days_30" | "on_issue" | "days_n" | undefined,
    due_days: typeof record.dueDays === "number" ? record.dueDays : null,
    lines: toLines(record.lines),
    issue_mode: record.issueMode as "review" | "auto" | undefined,
  }
  const refused = checkScheduleInput(fields)
  if (refused) throw new Error(`${refused.error.code}: ${refused.error.message}`)
  const issuer = await issuerFor(ctx, record)
  return {
    issuer_profile_id: issuer.id,
    company_id: str(record.companyId),
    contact_id: fields.contact_id,
    status: "draft",
    repeats: fields.repeats,
    billing_day: fields.billing_day,
    ends_on: fields.ends_on,
    covers: record.covers === "period_ahead" ? "period_ahead" : "period_ended",
    issue_mode: "review",
    paid_by: record.paidBy === "card_link" ? "card_link" : "transfer",
    due_rule: fields.due_rule ?? "days_30",
    due_days: fields.due_days,
    language: str(record.language) ?? issuer.language ?? "en",
    lines: fields.lines,
    notes: str(record.notes),
    external_ref: dedupValue,
    next_issue_on: null,
    next_draft_on: null,
    version: 1,
    created_by: "import",
  }
}

export async function importSchedules(batch: ImportBatch, ctx: Ctx): Promise<ImportResult[]> {
  const out: ImportResult[] = []
  for (const { record, dedupValue } of batch.records) {
    try {
      const row = await prepare(ctx, record, dedupValue)
      if (!row) {
        out.push({ status: "skipped", rows: [] })
        continue
      }
      const created = (await ctx.db.insert("recurring_schedules", row)) as { id: string }
      out.push({
        status: "created",
        rows: [{ table: "app_invoicing.recurring-schedules", id: created.id }],
      })
    } catch (err) {
      out.push({
        status: "failed",
        rows: [],
        error: err instanceof Error ? err.message : String(err),
      })
    }
  }
  return out
}

export async function checkSchedules(
  batch: ImportBatch,
  ctx: Ctx,
): Promise<Array<{ status: "created" | "skipped" | "failed"; error?: string }>> {
  const out: Array<{ status: "created" | "skipped" | "failed"; error?: string }> = []
  for (const { record, dedupValue } of batch.records) {
    try {
      out.push({ status: (await prepare(ctx, record, dedupValue)) ? "created" : "skipped" })
    } catch (err) {
      out.push({ status: "failed", error: err instanceof Error ? err.message : String(err) })
    }
  }
  return out
}
