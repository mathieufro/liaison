// SPDX-License-Identifier: FSL-1.1-ALv2
//
// What happens after a month-end row's draft is written, by anyone, through the draft tools: who
// changed what goes on the draft's change log, the row's state is worked out again, and the run's
// card follows. Before the decision the waiting card is rewritten in place (its hash changes, so a
// stale approve is refused). After it, a row that was approved, or one that becomes ready (fixed,
// added, put back), waits for a new approval, and every such row joins one second card.
import type { ErrorEnvelope } from "../mutations/shared"
import { isComparisonFlag, linesSignature, runItemFlags } from "./flags"
import { NEGATIVE_TOTAL, rowIssuerHold, runItemState, STATE_REASONS } from "./item-state"
import {
  cardItems,
  dayOf,
  draftLines,
  draftTotals,
  findOneWhere,
  jsonOf,
  previousInvoice,
  type Row,
  type RunCtx,
  runDecided,
  stageRunCard,
} from "./run-card"

export interface TurnFacts {
  agentId: string | null
  hasPerson: boolean
}

/** The kernel ctx a run edit receives: a run handler's, plus the turn it runs in. */
export type EditCtx = RunCtx & { turn?: { get(): Promise<TurnFacts> } }

/** A draft that is a row of a month-end run, with its row, run and schedule. */
export interface RunDraft {
  draft: Row
  item: Row
  run: Row
  schedule: Row | null
}

export type Applies = "this_month" | "from_now_on" | "end_schedule"

export interface FieldChange {
  field: string
  from: unknown
  to: unknown
}

/** What a run edit answers, beside the draft: the row, the run's totals, and what to tell. */
export interface RunRowResult {
  item_id: string
  run_id: string
  item_state: string
  row_total_minor: string
  currency: string
  approve_count: number
  approve_total_minor: string
  approval_id: string | null
  updated_at: string | null
  notes: string[]
}

export const fail = (code: string, message: string): ErrorEnvelope => ({
  status: "error",
  error: { code, message },
})

/** Thrown the way the draft tools refuse: `code: message`. */
export function refuse(code: string, message: string): never {
  throw new Error(`${code}: ${message}`)
}

export async function turnOf(ctx: EditCtx): Promise<TurnFacts> {
  try {
    // The sandbox hands the bridge's answer through as its JSON text.
    const raw: unknown = ctx.turn ? await ctx.turn.get() : null
    const t = (typeof raw === "string" ? JSON.parse(raw) : raw) as Partial<TurnFacts> | null
    return { agentId: t?.agentId ?? null, hasPerson: t?.hasPerson === true }
  } catch {
    return { agentId: null, hasPerson: false }
  }
}

/**
 * A turn with an agent and no person behind it (a routine tick, a background turn): its draft
 * writes on a run wait for a person. A person's own click carries no agent; a job calls no tool.
 */
export function noPersonBehind(turn: TurnFacts): boolean {
  return turn.agentId !== null && !turn.hasPerson
}

/** The run a draft belongs to, or null for any other draft. Reads an issued document too. */
export async function runDraftOf(
  ctx: Pick<RunCtx, "db">,
  documentId: string | undefined | null,
): Promise<RunDraft | null> {
  if (!documentId) return null
  const draft = (await ctx.db.findOne("documents", documentId)) as Row | null
  if (!draft) return null
  const refs = jsonOf<Row>(draft.external_refs, {})
  const itemId = refs.recurring_run_item_id
  // A row's draft is the row's whether or not the draft carries its back reference (an imported
  // or hand-made run holds only the row's document_id): without it, a change would skip every
  // run check and land as a plain draft's.
  const item =
    (typeof itemId === "string" && itemId !== ""
      ? ((await ctx.db.findOne("recurring_run_items", itemId)) as Row | null)
      : null) ?? (await findOneWhere(ctx, "recurring_run_items", { document_id: String(draft.id) }))
  if (!item) return null
  const run = (await ctx.db.findOne("recurring_runs", String(item.run_id))) as Row | null
  if (!run) return null
  const schedule = item.schedule_id
    ? ((await ctx.db.findOne("recurring_schedules", String(item.schedule_id))) as Row | null)
    : null
  return { draft, item, run, schedule }
}

/** The refusal for a row already issued: its number, and the credit note as the way back. */
export function issuedRefusal(rd: RunDraft): never {
  const number = String(rd.item.issued_number ?? rd.draft.number ?? rd.item.document_id)
  refuse(
    "already_issued",
    `This row of the month-end run is already issued as ${number}, so nothing was changed. Credit it with credit_note_create_and_issue.`,
  )
}

export function updatedAtOf(doc: Row): string | null {
  const v = doc.updatedAt ?? doc.updated_at
  if (v === null || v === undefined || v === "") return null
  return v instanceof Date ? v.toISOString() : String(v)
}

/** A timestamp as microseconds since the epoch: Postgres keeps six digits, a Date only three. */
function micros(text: string): number | null {
  const m = /^(.*?\d{2}:\d{2}:\d{2})(?:\.(\d+))?(.*)$/.exec(text.trim())
  if (!m) return null
  let zone = (m[3] ?? "").trim()
  if (/^[+-]\d{2}$/.test(zone)) zone = `${zone}:00`
  const base = Date.parse(`${(m[1] as string).replace(" ", "T")}${zone || "Z"}`)
  if (!Number.isFinite(base)) return null
  return base * 1000 + Number(((m[2] ?? "") + "000000").slice(0, 6))
}

function sameInstant(a: string | null, b: string): boolean {
  if (a === null) return false
  const x = micros(a)
  const y = micros(b)
  return x !== null && y !== null ? x === y : a === b
}

/** Who made the draft's latest change, in words. */
function lastChangeOf(draft: Row): string {
  const log = jsonOf<Row[]>(draft.lifecycle_log, [])
  const last = [...log].reverse().find((e) => e.event === "run_edit")
  if (!last) return "by the month-end run"
  const who = last.agent_id
    ? `by agent ${String(last.agent_id)} for user ${String(last.actor_user_id)}`
    : `by user ${String(last.actor_user_id)}`
  return `${who} at ${String(last.at)}`
}

/**
 * Two writers: a run draft write names the draft's `updated_at` as it was read. A different one
 * means someone changed it since, and nothing is written.
 */
export async function checkUnchangedSince(
  ctx: Pick<RunCtx, "db">,
  rd: RunDraft,
  given: string | undefined,
): Promise<void> {
  const current = updatedAtOf(rd.draft)
  if (typeof given !== "string" || given.trim() === "") {
    refuse(
      "if_unchanged_since_required",
      `Draft ${String(rd.draft.id)} is a row of a month-end run, so a change names the version it was read at; nothing was changed. Pass if_unchanged_since "${current ?? ""}" (its updated_at) to change it as it stands now.`,
    )
  }
  if (sameInstant(current, given)) return
  const lines = await draftLines(ctx, String(rd.draft.id))
  const t = draftTotals(lines)
  refuse(
    "draft_changed",
    `Draft ${String(rd.draft.id)} changed since you read it (${lastChangeOf(rd.draft)}), so nothing was changed. It now bills ${String(rd.draft.counterparty_name ?? "its customer")} ${t.total.toString()} minor units incl. tax, updated_at "${current ?? ""}". Read it again and pass that updated_at to write over it.`,
  )
}

/** Append one entry to the draft's change log: who (a person, or a person's agent), what, how far. */
export async function logRunEdit(
  ctx: EditCtx,
  draftId: string,
  entry: { kind: string; fields: FieldChange[]; applies: Applies | null },
): Promise<void> {
  const doc = (await ctx.db.findOne("documents", draftId)) as Row | null
  if (!doc) return
  const turn = await turnOf(ctx)
  const log = jsonOf<Row[]>(doc.lifecycle_log, [])
  log.push({
    event: "run_edit",
    kind: entry.kind,
    at: new Date().toISOString(),
    actor_user_id: await ctx.getUserId(),
    agent_id: turn.agentId,
    routine_id: null,
    has_person: turn.agentId === null ? true : turn.hasPerson,
    approval_id: ctx.approval?.approvalRequestId ?? null,
    fields: entry.fields,
    applies: entry.applies,
  })
  await ctx.db.update("documents", draftId, { lifecycle_log: log })
}

const HEADER_FIELDS = [
  "counterparty_contact_id",
  "counterparty_name",
  "counterparty_address",
  "counterparty_country",
  "counterparty_vat_id",
  "counterparty_email",
  "billing_line1",
  "billing_postcode",
  "billing_city",
  "billing_country_code",
  "currency",
  "due_at",
  "notes",
  "po_number",
]

function linesSummary(lines: Row[]): string {
  const t = draftTotals(lines)
  return `${lines.length} line${lines.length === 1 ? "" : "s"}, ${t.net.toString()} net`
}

/** What changed between two reads of a draft, field by field (the lines as one field). */
export function draftDiff(
  before: Row,
  beforeLines: Row[],
  after: Row,
  afterLines: Row[],
): FieldChange[] {
  const out: FieldChange[] = []
  for (const f of HEADER_FIELDS) {
    const a = f === "due_at" ? dayOf(before[f]) : (before[f] ?? null)
    const b = f === "due_at" ? dayOf(after[f]) : (after[f] ?? null)
    if (JSON.stringify(a) !== JSON.stringify(b)) out.push({ field: f, from: a, to: b })
  }
  const sig = (ls: Row[]) =>
    JSON.stringify(
      ls.map((l) => [
        l.description,
        String(l.quantity),
        String(l.unit_price_minor),
        l.tax_rate_bp ?? null,
      ]),
    )
  if (sig(beforeLines) !== sig(afterLines))
    out.push({ field: "lines", from: linesSummary(beforeLines), to: linesSummary(afterLines) })
  return out
}

function withoutReasons(note: unknown): string[] {
  return (typeof note === "string" && note ? note.split(" · ") : []).filter(
    (n) => !STATE_REASONS.includes(n),
  )
}

/**
 * Work the row out again after a write, and make the card follow. `putBack` takes a left-out row
 * back into the run. Returns what the tool answers about the row and the run.
 */
export async function afterRunWrite(
  ctx: EditCtx,
  itemId: string,
  opts: {
    putBack?: boolean
    extraNotes?: string[]
    noteAdd?: string[]
    noteRemove?: string[]
  } = {},
): Promise<RunRowResult> {
  const item = (await ctx.db.findOne("recurring_run_items", itemId)) as Row
  const run = (await ctx.db.findOne("recurring_runs", String(item.run_id))) as Row
  const draft = (await ctx.db.findOne("documents", String(item.document_id))) as Row
  const lines = await draftLines(ctx, String(draft.id))
  const notes: string[] = [...(opts.extraNotes ?? [])]
  let note = withoutReasons(item.note).filter((n) => !(opts.noteRemove ?? []).includes(n))
  for (const n of opts.noteAdd ?? []) if (!note.includes(n)) note.push(n)
  let state = String(item.state)
  const data: Row = {}
  if (state !== "left_out" || opts.putBack) {
    const wasApproved = state === "approved"
    const schedule = item.schedule_id
      ? ((await ctx.db.findOne("recurring_schedules", String(item.schedule_id))) as Row | null)
      : null
    // The comparison with the schedule's last invoice follows the edit: an amount typed far from
    // what it billed last time asks for a look before the card is approved.
    const prev = schedule
      ? await previousInvoice(ctx, schedule.last_document_id, String(draft.id))
      : null
    if (prev) {
      const fresh = runItemFlags(prev, {
        net_minor: draftTotals(lines).net,
        lines_signature: linesSignature(lines),
      })
      note = [...fresh, ...note.filter((n) => !isComparisonFlag(n))]
    }
    const now = runItemState(draft, lines, await rowIssuerHold(ctx, draft, schedule))
    if (now.state === "needs_fix") {
      state = "needs_fix"
      note = [...note, now.reason]
      notes.push(
        now.reason === NEGATIVE_TOTAL
          ? "This row bills less than nothing, so it stays a draft: credit the customer with credit_note_create_and_issue, which takes its own number outside the run."
          : `This row needs a fix (${now.reason}): it stays a draft, uses no number and comes back to you once fixed.`,
      )
    } else if (wasApproved || state === "waiting_reapproval" || runDecided(run)) {
      // After the decision a row that can issue waits for a new approval (it never issues unseen).
      state = "waiting_reapproval"
      notes.push(
        "The run was already approved, so this row waits for a new approval; the other rows issue as approved.",
      )
    } else {
      state = "ready"
    }
    if (wasApproved || state !== "approved") {
      data.approved_hash = null
      data.send_grant = null
    }
  }
  data.state = state
  data.note = note.join(" · ") || null
  await ctx.db.update("recurring_run_items", itemId, data)
  // The run's card: rewritten in place while it waits, or one new card after the decision. A
  // rejected run asks again on its issue day by itself.
  let approvalId: string | null =
    typeof run.approval_request_id === "string" ? run.approval_request_id : null
  if (
    run.status !== "rejected" &&
    run.status !== "issued" &&
    run.status !== "late" &&
    run.status !== "nothing_to_issue"
  ) {
    const card = await stageRunCard(ctx, String(run.id))
    const fresh = (await ctx.db.findOne("recurring_runs", String(run.id))) as Row | null
    approvalId =
      card.approval_id ??
      (typeof fresh?.approval_request_id === "string" ? fresh.approval_request_id : null)
    if (card.owed) {
      approvalId = null
      notes.push(
        "A new card for the rows waiting is staged within 5 minutes; your edit does not approve them.",
      )
    }
  }
  const { items, total } = await cardItems(ctx, String(run.id))
  const after = (await ctx.db.findOne("documents", String(draft.id))) as Row
  return {
    item_id: itemId,
    run_id: String(run.id),
    item_state: state,
    row_total_minor: draftTotals(lines).total.toString(),
    currency: String(draft.currency ?? "EUR"),
    approve_count: items.length,
    approve_total_minor: total.toString(),
    approval_id: approvalId,
    updated_at: updatedAtOf(after),
    notes,
  }
}

/**
 * Park a run edit made with no person behind the turn: nothing is written until a person approves
 * it, and the approved call runs again with that decision.
 */
export async function parkForPerson(
  ctx: EditCtx,
  toolName: string,
  what: string,
  payload: unknown,
): Promise<{ status: "pending_approval"; approval_id: string | null; message: string } | null> {
  if (ctx.approval) return null
  if (!noPersonBehind(await turnOf(ctx))) return null
  const approval = await ctx.requestApproval({
    tool_name: toolName,
    summary: what.slice(0, 200),
    summary_detail: {
      subtitle: "Asked with no person behind the turn, so a person decides it",
      lines: ["Nothing on the month-end run changes until it is approved."],
    },
    current_payload: payload,
  })
  return {
    status: "pending_approval",
    approval_id: approval.approval_id ?? null,
    message: `Nothing was changed: ${what} waits for a person's approval (${approval.approval_id ?? "pending"}).`,
  }
}

/** After a row is removed from a run: the card follows, and the run's totals are told. */
export async function stageRunCardAfterRemoval(
  ctx: EditCtx,
  runId: string,
): Promise<{
  run_id: string
  approve_count: number
  approve_total_minor: string
  approval_id: string | null
}> {
  const run = (await ctx.db.findOne("recurring_runs", runId)) as Row | null
  let approvalId: string | null =
    typeof run?.approval_request_id === "string" ? run.approval_request_id : null
  if (
    run &&
    run.status !== "rejected" &&
    run.status !== "issued" &&
    run.status !== "late" &&
    run.status !== "nothing_to_issue"
  ) {
    const card = await stageRunCard(ctx, runId)
    approvalId = card.owed ? null : (card.approval_id ?? approvalId)
  }
  const { items, total } = await cardItems(ctx, runId)
  return {
    run_id: runId,
    approve_count: items.length,
    approve_total_minor: total.toString(),
    approval_id: approvalId,
  }
}
