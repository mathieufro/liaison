// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The hourly draft job of recurring invoicing. On each schedule's draft day (the issuer's civil
// date), it makes one unnumbered draft for the period from the schedule alone: its lines, prices,
// rates and terms, with `{period}` filled. No model is asked anything. Each draft joins the run of
// its issuer and issue day, as one item, and the run gets one card.
//
// The draft and its lines are written by one call of `recurring_draft_write`, a tool only the
// app's own jobs reach, in one commit: a job that dies between the document and its lines leaves
// neither. A
// draft found already written (a run that stopped before this rule, or a person's edit) is checked
// line by line against its schedule, and a draft that differs needs a fix before it can be ready.
//
// Every step is keyed so a second run of the job, or one running at the same time, adds nothing:
// the draft by `external_ref = recurring:<schedule>:<period_key>` (unique), the run by issuer and
// issue day (unique), the item by schedule and period (unique), the card by a claim on the run.
import { civilDateOf } from "../issue-date"
import { lineSubtotal } from "../money"
import type { ErrorEnvelope } from "../mutations/shared"
import { recipientOf } from "../recipient"
import { type CurrentDraft, linesSignature, periodLabel, runItemFlags } from "./flags"
import { rowIssuerHold, runItemState } from "./item-state"
import {
  currentItemHash,
  dayOf,
  draftLines,
  draftTotals,
  endHold,
  findOneWhere,
  jsonOf,
  previousInvoice,
  type Row,
  type RunCtx,
  runItems,
  stageRunCard,
} from "./run-card"
import {
  addDays,
  datesFrom,
  daysInMonth,
  latestIssueOn,
  periodKey,
  periodStart,
  type Repeats,
} from "./schedule"
import { draftCandidates, type ScheduleLineInput, type ScheduleRow } from "./tools"

export interface DraftJobResult {
  status: "ok"
  drafted: number
  runs: string[]
  message: string
}

function periodEnd(repeats: Repeats, start: string): string {
  const [y, m] = start.split("-").map(Number) as [number, number]
  const endMonth = repeats === "year" ? 12 : repeats === "quarter" ? m + 2 : m
  return `${String(y).padStart(4, "0")}-${String(endMonth).padStart(2, "0")}-${String(daysInMonth(y, endMonth)).padStart(2, "0")}`
}

function dueOn(s: ScheduleRow, issueOn: string): string {
  if (s.due_rule === "on_issue") return issueOn
  if (s.due_rule === "days_n" && typeof s.due_days === "number") return addDays(issueOn, s.due_days)
  return addDays(issueOn, 30)
}

function isUniqueViolation(err: unknown): boolean {
  const text = `${(err as { code?: unknown })?.code ?? ""} ${(err as { message?: unknown })?.message ?? String(err)}`
  return /23505|unique|duplicate key/i.test(text)
}

/** Insert, or find what a concurrent run inserted first under the same unique key. */
async function insertOnce(
  ctx: RunCtx,
  entity: string,
  where: Row,
  data: Row,
): Promise<{ row: Row; created: boolean }> {
  const found = await findOneWhere(ctx, entity, where)
  if (found) return { row: found, created: false }
  try {
    const inserted = (await ctx.db.insert(entity, data)) as Row
    return { row: { ...data, ...inserted }, created: true }
  } catch (err) {
    if (!isUniqueViolation(err)) throw err
    const again = await findOneWhere(ctx, entity, where)
    if (!again) throw err
    return { row: again, created: false }
  }
}

/**
 * Who the customer is on the draft: the schedule's customer as its records read on the draft day
 * (its company, else its contact), never an earlier draft or invoice, so an address added since
 * the last month reaches this month's draft. A schedule whose person was deleted has no contact:
 * it never reads details by an empty contact.
 */
async function counterpartySnapshot(ctx: RunCtx, s: ScheduleRow): Promise<Row> {
  return {
    ...(await recipientOf(ctx, {
      contactId: s.contact_id ?? null,
      companyId: s.company_id ?? null,
    })),
  }
}

function draftLineRows(lines: ScheduleLineInput[], label: string): Row[] {
  return lines.map((l, i) => {
    const price = BigInt(Number(l.unit_price_minor))
    const quantity = String(l.qty)
    const subtotal = lineSubtotal({ quantity, unit_price_minor: price })
    return {
      position: i + 1,
      description: String(l.description).split("{period}").join(label),
      quantity,
      unit_price_minor: price.toString(),
      discount_minor: "0",
      line_kind: l.line_kind ?? "service",
      tax_rate_bp: l.vat_bp,
      subtotal_minor: subtotal.toString(),
      tax_minor: "0",
      total_minor: subtotal.toString(),
      product_source: null,
      external_id: null,
    }
  })
}

export interface DraftWriteInput {
  document: Row
  lines: Row[]
}

const fail = (code: string, message: string): ErrorEnvelope => ({
  status: "error",
  error: { code, message },
})

/**
 * Write one run draft and its lines in one commit (`ctx.db.batch`), so a failure on any line
 * leaves no draft. A draft already written under the same key is returned as it is, with nothing
 * added.
 */
export async function recurringDraftWrite(
  ctx: RunCtx,
  input: DraftWriteInput,
): Promise<
  { status: "completed"; document_id: string; created: boolean; message: string } | ErrorEnvelope
> {
  const ref = typeof input.document?.external_ref === "string" ? input.document.external_ref : ""
  if (!ref.startsWith("recurring:")) {
    return fail(
      "not_a_run_draft",
      "The draft has no recurring key (external_ref recurring:<schedule>:<period>), so nothing was written.",
    )
  }
  const data: Row = {
    ...input.document,
    type: "invoice",
    status: "draft",
    number: null,
    number_int: null,
    year_of_issue: null,
    issued_at: null,
  }
  const existing = await findOneWhere(ctx, "documents", { external_ref: ref })
  const already = (row: Row) =>
    ({
      status: "completed",
      document_id: String(row.id),
      created: false,
      message: `Draft ${String(row.id)} for ${ref} already existed; nothing was written.`,
    }) as const
  if (existing) return already(existing)
  let id: string
  try {
    const committed = await ctx.db.batch({
      ops: [
        { insert: "documents", as: "draft", data },
        ...input.lines.map((line) => ({
          insert: "document_lines",
          data: { ...line, document_id: { $ref: "draft" } },
        })),
      ],
    })
    id = String(committed.rows.draft?.id)
  } catch (err) {
    // Another run wrote the same period's draft first: the key is unique, so return that one.
    if (!isUniqueViolation(err)) throw err
    const again = await findOneWhere(ctx, "documents", { external_ref: ref })
    if (!again) throw err
    return already(again)
  }
  return {
    status: "completed",
    document_id: id,
    created: true,
    message: `Wrote draft ${id} for ${ref} with ${input.lines.length} line(s).`,
  }
}

/** Write the draft through the atomic tool. Null when it was not written (the next tick tries again). */
async function writeDraft(
  ctx: RunCtx,
  input: DraftWriteInput,
): Promise<{ id: string; created: boolean } | null> {
  if (!ctx.executeTool) return null
  const env = await ctx.executeTool(
    "invoicing:recurring_draft_write",
    input as unknown as Record<string, unknown>,
  )
  const res =
    env.status === "completed"
      ? (env.result as { status?: string; document_id?: string; created?: boolean } | null)
      : null
  if (res?.status !== "completed" || typeof res.document_id !== "string") return null
  return { id: res.document_id, created: res.created === true }
}

/** Whether a draft's lines are the schedule's lines, one by one. */
function sameLines(found: Row[], expected: Row[]): boolean {
  if (found.length !== expected.length) return false
  const sorted = [...found].sort((a, b) => Number(a.position) - Number(b.position))
  return expected.every((e, i) => {
    const f = sorted[i] as Row
    return (
      Number(f.position) === Number(e.position) &&
      String(f.description) === String(e.description) &&
      Number(f.quantity) === Number(e.quantity) &&
      String(f.unit_price_minor) === String(e.unit_price_minor) &&
      Number(f.tax_rate_bp) === Number(e.tax_rate_bp) &&
      String(f.line_kind ?? "service") === String(e.line_kind)
    )
  })
}

/** Draft one schedule's period. Returns the run it joined, or null when it was already drafted. */
async function draftSchedule(
  ctx: RunCtx,
  s: ScheduleRow,
): Promise<{ runId: string; drafted: boolean } | null> {
  const issueOn = s.next_issue_on as string
  const key = periodKey(s.repeats, issueOn)
  const start = periodStart(s.repeats, issueOn)
  const end = periodEnd(s.repeats, start)
  const label = periodLabel(key)
  const externalRef = `recurring:${s.id}:${key}`
  const issuer = (await ctx.db.findOne("issuer_profiles", s.issuer_profile_id)) as Row | null
  if (!issuer) return null

  const run = await insertOnce(
    ctx,
    "recurring_runs",
    { issuer_profile_id: s.issuer_profile_id, issue_on: issueOn },
    {
      issuer_profile_id: s.issuer_profile_id,
      issue_on: issueOn,
      latest_issue_on: latestIssueOn(issueOn),
      status: "drafted",
      period_label: label,
      approval_request_id: null,
    },
  )
  const runId = String(run.row.id)

  const counterparty = await counterpartySnapshot(ctx, s)
  const docRow: Row = {
    type: "invoice",
    status: "draft",
    counterparty_contact_id: s.contact_id,
    ...counterparty,
    issuer_profile_id: s.issuer_profile_id,
    currency: String(issuer.default_currency ?? "EUR"),
    incoterm: "DAP",
    due_at: dueOn(s, issueOn),
    external_ref: externalRef,
    external_refs: {
      recurring_schedule_id: s.id,
      period_key: key,
      period_start: start,
      period_end: end,
    },
    notes: s.notes ?? null,
    lifecycle_log: [
      {
        event: "drafted",
        actor: "recurring",
        ts: new Date().toISOString(),
        schedule_id: s.id,
        schedule_version: s.version,
        period_key: key,
      },
    ],
    subtotal_minor: "0",
    tax_total_minor: "0",
    grand_total_minor: "0",
    payment_status: "unpaid",
    number: null,
    number_int: null,
    year_of_issue: null,
    issued_at: null,
    operation_category: "services",
  }
  const expected = draftLineRows(s.lines, label)
  const written = await writeDraft(ctx, { document: docRow, lines: expected })
  if (!written) return null
  const draftId = written.id
  const draftRow = written.created
    ? null
    : ((await ctx.db.findOne("documents", draftId)) as Row | null)

  const lines = await draftLines(ctx, draftId)
  const differs = !written.created && !sameLines(lines, expected)
  const totals = draftTotals(lines)
  const current: CurrentDraft = { net_minor: totals.net, lines_signature: linesSignature(lines) }
  const flags = runItemFlags(await previousInvoice(ctx, s.last_document_id ?? null), current)
  // One rule for whether a row is ready (customer, address, total), the same the edits apply.
  const rowState = runItemState(
    draftRow ?? docRow,
    lines,
    await rowIssuerHold(ctx, draftRow ?? docRow, s as unknown as Row),
  )
  const missing = rowState.state === "needs_fix"
  const position = (await runItems(ctx, runId)).length + 1
  const item = await insertOnce(
    ctx,
    "recurring_run_items",
    { schedule_id: s.id, period_key: key },
    {
      run_id: runId,
      source: "schedule",
      schedule_id: s.id,
      schedule_version: s.version,
      period_key: key,
      period_start: start,
      period_end: end,
      document_id: draftId,
      position,
      state: missing || differs ? "needs_fix" : "ready",
      note: [
        ...flags,
        ...(rowState.state === "needs_fix" ? [rowState.reason] : []),
        ...(differs ? ["Lines differ from the schedule"] : []),
      ].join(" · "),
    },
  )
  const refs = jsonOf<Row>(draftRow?.external_refs ?? docRow.external_refs, {})
  if (refs.recurring_run_item_id !== item.row.id) {
    await ctx.db.update("documents", draftId, {
      external_refs: {
        ...refs,
        recurring_run_item_id: String(item.row.id),
        recurring_run_id: runId,
      },
    })
  }
  // The schedule moves to its next period only from the period just drafted, so a second run of
  // the job finds it already moved and moves nothing.
  const next = datesFrom(s, addDays(issueOn, 1))
  const fresh = (await ctx.db.findOne("recurring_schedules", s.id)) as Row | null
  if (fresh && dayOf(fresh.next_issue_on) === issueOn)
    await ctx.db.update("recurring_schedules", s.id, { ...next })
  return { runId, drafted: item.created }
}

/** Auto-issue a run when every row comes from a schedule set to issue by itself and none is over the threshold. */
async function approveByItself(ctx: RunCtx, runId: string): Promise<boolean> {
  const run = (await ctx.db.findOne("recurring_runs", runId)) as Row | null
  if (!run || run.status !== "drafted" || run.approval_request_id) return false
  const issuer = (await ctx.db.findOne(
    "issuer_profiles",
    String(run.issuer_profile_id),
  )) as Row | null
  const threshold = issuer?.invoice_approval_threshold_minor
  const limit = threshold === null || threshold === undefined ? null : BigInt(String(threshold))
  const items = (await runItems(ctx, runId)).filter(
    (i) => i.state !== "left_out" && i.state !== "issued",
  )
  if (items.length === 0) return false
  let enabledBy: string | null = null
  const hashes: Array<[string, string]> = []
  for (const item of items) {
    if (item.state !== "ready") return false
    const s = (await ctx.db.findOne("recurring_schedules", String(item.schedule_id))) as Row | null
    if (!s || s.issue_mode !== "auto") return false
    enabledBy = (s.auto_enabled_by as string | null) ?? enabledBy
    const draft = (await ctx.db.findOne("documents", String(item.document_id))) as Row | null
    if (!draft) return false
    const lines = await draftLines(ctx, String(draft.id))
    if (limit !== null && draftTotals(lines).total > limit) return false
    hashes.push([String(item.id), await currentItemHash(ctx, item, draft)])
  }
  const claim = await ctx.db.updateMany("recurring_runs", {
    where: {
      issuer_profile_id: run.issuer_profile_id,
      issue_on: dayOf(run.issue_on),
      status: "drafted",
      approval_request_id: null,
    },
    data: {
      status: "approved",
      auto: true,
      approved_by: enabledBy,
      approved_at: new Date().toISOString(),
    },
  })
  if (claim.count !== 1) return false
  for (const [id, hash] of hashes)
    await ctx.db.update("recurring_run_items", id, { state: "approved", approved_hash: hash })
  return true
}

export async function recurringDraftJob(ctx: RunCtx): Promise<DraftJobResult> {
  const issuers = (await ctx.db.findMany("issuer_profiles", { limit: 200 })) as Row[]
  const runs = new Set<string>()
  let drafted = 0
  for (const issuer of issuers) {
    const today = await civilDateOf(ctx, issuer as { timezone?: string | null })
    if (!today.ok) continue
    const due = (await draftCandidates(ctx, today.date)).filter(
      (s) => s.issuer_profile_id === issuer.id,
    )
    for (const s of due) {
      const res = await draftSchedule(ctx, s)
      if (!res) continue
      runs.add(res.runId)
      if (res.drafted) drafted += 1
    }
  }
  if (drafted > 0) await endHold(ctx, "recurring-draft")
  for (const runId of runs) {
    if (await approveByItself(ctx, runId)) continue
    const run = (await ctx.db.findOne("recurring_runs", runId)) as Row | null
    if (!run || run.status !== "drafted") continue
    await stageRunCard(ctx, runId)
    if (ctx.emit) {
      await ctx.emit({
        entity: "recurring_run",
        action: "drafted",
        entityId: runId,
        data: { run_id: runId, issue_on: dayOf(run.issue_on), period: run.period_label },
      })
    }
  }
  return {
    status: "ok",
    drafted,
    runs: [...runs],
    message:
      drafted === 0
        ? "No schedule was due for a draft."
        : `Drafted ${drafted} invoice${drafted === 1 ? "" : "s"} in ${runs.size} run${runs.size === 1 ? "" : "s"}.`,
  }
}
