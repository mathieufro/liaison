// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The month-end run's one approval: a card with one row per draft, what approving it records, and
// how it is undone. Approving takes no number: numbers are taken by the issue job on the issue day
// (`issue-job.ts`), one draft at a time.
//
// The card's payload names each row by its item, its draft and a hash of the draft's billing
// content, so a draft changed after the card was drawn changes the card (and a stale approve is
// refused by the kernel), and a draft changed after approval is caught again at issue.
import { mintRunSendGrants } from "../einvoicing/run-send"
import type { EinvCtx } from "../einvoicing/transmit"
import type { ErrorEnvelope, MutationsCtx } from "../mutations/shared"
import { runCardLines } from "../summarizers"
import { linesSignature, type PreviousInvoice } from "./flags"
import { currentItemHash, itemContentHash } from "./item-hash"
import { addDays, weekdayOf } from "./schedule"

export { currentItemHash, itemContentHash }

export const RUN_ISSUE_TOOL = "invoicing:recurring_run_issue"

export type Row = Record<string, unknown>

export interface RunApprovals {
  restagePayload?(
    approvalId: string,
    fields: Record<string, unknown>,
    note?: string,
  ): Promise<unknown>
  statusOf?(approvalRequestId: string): Promise<unknown>
}

/** The kernel ctx a run handler or job receives. */
export type RunCtx = MutationsCtx & {
  approvals?: RunApprovals
  requestApproval: (
    input: Parameters<MutationsCtx["requestApproval"]>[0] & { expiry_hours?: number },
  ) => ReturnType<MutationsCtx["requestApproval"]>
}

export interface CardItem {
  item_id: string
  document_id: string
  content_hash: string
  total_minor: string
  /** For the card's lines only, so a rebuilt summary still names who is billed. */
  customer?: string
  currency?: string
}

const fail = (code: string, message: string): ErrorEnvelope => ({
  status: "error",
  error: { code, message },
})

/** A day column read back as `YYYY-MM-DD`, whether the store hands text or a Date. */
export function dayOf(value: unknown): string | null {
  if (value === null || value === undefined || value === "") return null
  if (value instanceof Date) return value.toISOString().slice(0, 10)
  return String(value).slice(0, 10)
}

export function jsonOf<T>(value: unknown, fallback: T): T {
  if (value === null || value === undefined) return fallback
  if (typeof value === "string") {
    try {
      return JSON.parse(value) as T
    } catch {
      return fallback
    }
  }
  return value as T
}

export async function findOneWhere(
  ctx: Pick<RunCtx, "db">,
  entity: string,
  where: Row,
): Promise<Row | null> {
  const rows = (await ctx.db.findMany(entity, { where, limit: 1 })) as Row[]
  return rows[0] ?? null
}

export async function runItems(ctx: Pick<RunCtx, "db">, runId: string): Promise<Row[]> {
  const rows = (await ctx.db.findMany("recurring_run_items", {
    where: { run_id: runId },
    orderBy: { position: "asc" },
    limit: 500,
  })) as Row[]
  return rows
}

export async function draftLines(ctx: Pick<RunCtx, "db">, documentId: string): Promise<Row[]> {
  return (await ctx.db.findMany("document_lines", {
    where: { document_id: documentId },
    orderBy: { position: "asc" },
    limit: 500,
  })) as Row[]
}

/**
 * The schedule's last issued invoice, for a row's flags. `exceptDocumentId` is the row's own draft:
 * once that one is issued it is the schedule's last, and a row never compares with itself.
 */
export async function previousInvoice(
  ctx: Pick<RunCtx, "db">,
  lastDocumentId: unknown,
  exceptDocumentId?: string,
): Promise<PreviousInvoice | null> {
  if (typeof lastDocumentId !== "string" || !lastDocumentId || lastDocumentId === exceptDocumentId)
    return null
  const doc = (await ctx.db.findOne("documents", lastDocumentId)) as Row | null
  if (!doc) return null
  const lines = await draftLines(ctx, String(doc.id))
  const prevItem = await findOneWhere(ctx, "recurring_run_items", { document_id: String(doc.id) })
  return {
    period_key: prevItem ? String(prevItem.period_key) : null,
    net_minor: draftTotals(lines).net,
    lines_signature: linesSignature(lines),
    payment_status: (doc.payment_status as string | null) ?? null,
    currency: (doc.currency as string | null) ?? null,
  }
}

/** Net (before tax) and total (with each line's rate) of a draft's lines, in minor units. */
export function draftTotals(lines: Row[]): { net: bigint; vat: bigint; total: bigint } {
  let net = 0n
  let vat = 0n
  for (const l of lines) {
    const sub = BigInt(String(l.subtotal_minor ?? "0"))
    const bp =
      l.tax_rate_bp === null || l.tax_rate_bp === undefined ? 0n : BigInt(Number(l.tax_rate_bp))
    net += sub
    // Half away from zero, as the money helpers round.
    const raw = sub * bp
    vat += raw >= 0n ? (raw + 5000n) / 10000n : -((-raw + 5000n) / 10000n)
  }
  return { net, vat, total: net + vat }
}

/** A run whose card was approved: what changes after it waits for a second card of its own. */
export function runDecided(run: Row | null | undefined): boolean {
  return run?.status === "approved" || run?.status === "issuing" || run?.status === "partial"
}

/**
 * The rows of a run a card shows, in order: before the decision, every ready row (a row that needs
 * a fix, is left out or issued stays off the card and out of "Approve N"); after it, the rows
 * waiting for a new approval.
 */
export async function cardItems(
  ctx: Pick<RunCtx, "db">,
  runId: string,
): Promise<{ items: CardItem[]; lines: string[]; total: bigint; needsFix: number }> {
  const items: CardItem[] = []
  const lines: string[] = []
  let total = 0n
  let needsFix = 0
  const run = (await ctx.db.findOne("recurring_runs", runId)) as Row | null
  const decided = runDecided(run)
  const issuer = run
    ? ((await ctx.db.findOne("issuer_profiles", String(run.issuer_profile_id))) as Row | null)
    : null
  for (const item of await runItems(ctx, runId)) {
    if (item.state === "needs_fix") needsFix += 1
    const onCard = decided
      ? item.state === "waiting_reapproval"
      : item.state === "ready" || item.state === "waiting_reapproval"
    if (!onCard) continue
    const draft = (await ctx.db.findOne("documents", String(item.document_id))) as Row | null
    if (!draft) continue
    const dl = await draftLines(ctx, String(draft.id))
    const t = draftTotals(dl)
    total += t.total
    items.push({
      item_id: String(item.id),
      document_id: String(draft.id),
      content_hash: itemContentHash(item, draft, dl, issuer),
      total_minor: t.total.toString(),
      customer: String(draft.counterparty_name ?? "Customer"),
      currency: String(draft.currency ?? "EUR"),
    })
    const cur = String(draft.currency ?? "EUR")
    const note = item.note ? ` · ${String(item.note)}` : ""
    lines.push(
      `${String(draft.counterparty_name ?? "Customer")}: ${minor(t.net, cur)} excl., ${minor(t.vat, cur)} VAT, ${minor(t.total, cur)} incl.${note}`.slice(
        0,
        200,
      ),
    )
  }
  return { items, lines, total, needsFix }
}

function minor(v: bigint, currency: string): string {
  const neg = v < 0n
  const a = neg ? -v : v
  return `${neg ? "-" : ""}${a / 100n}.${String(a % 100n).padStart(2, "0")} ${currency}`
}

/** Whole hours from now until the end of the run's last issue day in the issuer's zone, 1 to 720. */
export function hoursUntilEndOf(today: string, hour: number, lastDay: string): number {
  let days = 0
  for (let d = today; d < lastDay && days < 40; d = addDays(d, 1)) days += 1
  const hours = days * 24 + (24 - hour)
  return Math.min(720, Math.max(1, hours))
}

async function issuerOf(ctx: Pick<RunCtx, "db">, id: string): Promise<Row | null> {
  return (await ctx.db.findOne("issuer_profiles", id)) as Row | null
}

/**
 * Stage the run's card, or rewrite the one already waiting. One card per run: the run row is
 * claimed before the request, so two jobs running at once stage one.
 */
/** Resolve the "held by the day limit" notice of a money job, once it runs again. */
export async function endHold(ctx: RunCtx, job: string): Promise<void> {
  if (ctx.emit)
    await ctx.emit({
      entity: "recurring_run",
      action: "held",
      entityId: job,
      data: { job, resolved: true },
    })
}

/**
 * Who a run's card is for (manifest `approvalRoute`): the account manager of its rows (the person
 * who set up each schedule) when they are all the same person, else nobody, and the card reaches
 * the usual deciders. A run spans companies, so it names none.
 */
export async function approvalRouteRead(
  ctx: RunCtx,
  input: { entityType: string; entityId: string },
): Promise<{ personId: string | null; companyId: null }> {
  if (input.entityType !== "recurring_run") return { personId: null, companyId: null }
  const managers = new Set<string>()
  for (const item of await runItems(ctx, input.entityId)) {
    const schedule = item.schedule_id
      ? ((await ctx.db.findOne("recurring_schedules", String(item.schedule_id))) as Row | null)
      : null
    managers.add(String(schedule?.created_by ?? ""))
  }
  const [only] = managers
  return { personId: managers.size === 1 && only ? only : null, companyId: null }
}

export async function stageRunCard(
  ctx: RunCtx,
  runId: string,
): Promise<{ approval_id: string | null; staged: boolean; owed?: boolean }> {
  const run = (await ctx.db.findOne("recurring_runs", runId)) as Row | null
  if (!run) return { approval_id: null, staged: false }
  const { items, needsFix } = await cardItems(ctx, runId)
  const existing =
    typeof run.approval_request_id === "string" && run.approval_request_id !== "staging"
      ? run.approval_request_id
      : null
  // The card still waiting follows its rows, even down to none left to approve.
  if (existing && ctx.approvals?.restagePayload) {
    const period = String(run.period_label ?? dayOf(run.issue_on) ?? "")
    const res = (await ctx.approvals.restagePayload(
      existing,
      { items, period },
      "The month-end run's rows changed.",
    )) as { ok?: boolean } | null
    if (res?.ok) return { approval_id: existing, staged: false }
  }
  if (items.length === 0) return { approval_id: null, staged: false }
  if (run.approval_request_id === "staging") return { approval_id: null, staged: false }
  const again = runDecided(run)
  // The bridge takes no `where.id` on a bulk write: the run's unique issuer and issue day name it.
  const claim = await ctx.db.updateMany("recurring_runs", {
    where: {
      issuer_profile_id: run.issuer_profile_id,
      issue_on: dayOf(run.issue_on),
      approval_request_id: existing ?? null,
    },
    data: { approval_request_id: "staging" },
  })
  if (claim.count !== 1) return { approval_id: null, staged: false }
  const issuer = await issuerOf(ctx, String(run.issuer_profile_id))
  const issueOn = dayOf(run.issue_on) as string
  const lastDay = dayOf(run.latest_issue_on) as string
  const now = await ctx.time.civil({ timezone: String(issuer?.timezone || "UTC") })
  try {
    const approval = await ctx.requestApproval({
      tool_name: RUN_ISSUE_TOOL,
      summary: `${again ? "Approve again: issue" : "Issue"} ${items.length} invoice${items.length === 1 ? "" : "s"} for ${String(run.period_label ?? issueOn)} on ${issueOn}`,
      summary_detail: {
        subtitle:
          `Numbers are taken on ${issueOn} from 08:00, never at approval. Last day: ${lastDay}.` +
          (again
            ? " These rows changed after the run was approved; the others issue as approved."
            : "") +
          (needsFix > 0
            ? ` ${needsFix} row${needsFix === 1 ? " needs" : "s need"} a fix: it stays a draft, uses no number and comes back to you once fixed.`
            : ""),
        // Who is billed and the total; the panel under the card lists each row with its amounts.
        lines: runCardLines(items),
        // The run is the record the card is about: the kernel asks `approval_route_read` who it is for.
        links: [
          {
            label: `Month-end run ${String(run.period_label ?? issueOn)}`,
            app: "invoicing",
            entityType: "recurring_run",
            entityId: runId,
          },
        ],
      },
      current_payload: { run_id: runId, items, period: String(run.period_label ?? issueOn) },
      editable_fields: [],
      expiry_hours: hoursUntilEndOf(now.date, now.hour, lastDay),
    })
    if (!approval.approval_id) {
      // A person's own click cannot ask for a decision: the kernel takes it as theirs. The card is
      // owed instead, and the run's job stages it on its next tick, as nobody's click.
      await ctx.db.update("recurring_runs", runId, { approval_request_id: existing ?? null })
      return { approval_id: null, staged: false, owed: true }
    }
    await ctx.db.update("recurring_runs", runId, { approval_request_id: approval.approval_id })
    return { approval_id: approval.approval_id, staged: true }
  } catch (err) {
    await ctx.db.update("recurring_runs", runId, { approval_request_id: existing ?? null })
    throw err
  }
}

/**
 * Why a run cannot be approved because none of its rows is ready, or null. Approving it would
 * issue nothing, so it is refused with the rows that need a fix and why.
 */
function nothingReadyRefusal(runId: string, items: Row[]): ErrorEnvelope | null {
  if (items.some((i) => i.state === "ready" || i.state === "waiting_reapproval")) return null
  const fixes = items.filter((i) => i.state === "needs_fix")
  const why = [...new Set(fixes.map((i) => String(i.note ?? "").trim()).filter(Boolean))].slice(
    0,
    3,
  )
  return fail(
    "nothing_ready",
    `Run ${runId} has no row ready to issue, so it was not approved and nothing changed.` +
      (fixes.length > 0
        ? ` ${fixes.length} row${fixes.length === 1 ? " needs" : "s need"} a fix first${why.length > 0 ? ` (${why.join("; ")})` : ""}: change ${fixes.length === 1 ? "it" : "them"} with drafts_update, then approve.`
        : " Every row is taken out or already issued."),
  )
}

/** What approving the card records: each row's hash and the approver. No number is taken. */
export async function recurringRunIssue(
  ctx: RunCtx,
  input: { run_id: string; items?: CardItem[] },
): Promise<
  | {
      status: "completed"
      run_id: string
      approved: number
      changed: string[]
      issueOn: string
      message: string
    }
  | ErrorEnvelope
> {
  const run = (await ctx.db.findOne("recurring_runs", input.run_id)) as Row | null
  if (!run)
    return fail(
      "run_not_found",
      `No month-end run ${input.run_id}. Read it with recurring_run_get.`,
    )
  const reask = runDecided(run)
  const all = await runItems(ctx, input.run_id)
  if (
    reask
      ? !all.some((i) => i.state === "waiting_reapproval")
      : run.status !== "drafted" && run.status !== "rejected"
  ) {
    return fail(
      "run_not_drafted",
      `Run ${input.run_id} is ${String(run.status)}, so there is nothing to approve. Read it with recurring_run_get.`,
    )
  }
  if (!reask) {
    const refused = nothingReadyRefusal(input.run_id, all)
    if (refused) return refused
  }
  const decider = ctx.approval?.approvalDeciderId ?? (await ctx.getUserId())
  const wanted = new Map((input.items ?? []).map((i) => [i.item_id, i.content_hash]))
  const issuer = (await ctx.db.findOne(
    "issuer_profiles",
    String(run.issuer_profile_id),
  )) as Row | null
  let approved = 0
  const approvedIds: string[] = []
  const changed: string[] = []
  const patched: string[] = []
  for (const item of all) {
    // Only rows a card can show are approved: a row that needs a fix stays a draft.
    if (
      reask
        ? item.state !== "waiting_reapproval"
        : item.state !== "ready" && item.state !== "waiting_reapproval"
    )
      continue
    const draft = (await ctx.db.findOne("documents", String(item.document_id))) as Row | null
    if (!draft) continue
    const lines = await draftLines(ctx, String(draft.id))
    const hash = itemContentHash(item, draft, lines, issuer)
    const shown = wanted.get(String(item.id))
    if (shown !== undefined && shown !== hash) {
      await ctx.db.update("recurring_run_items", String(item.id), {
        state: "waiting_reapproval",
        approved_hash: null,
      })
      changed.push(String(draft.id))
      continue
    }
    if (shown === undefined && wanted.size > 0) continue
    // "From now on" reaches its schedule only now, with a person's approval, once.
    const written = await writeSchedulePatch(ctx, item)
    if (written) patched.push(written)
    const now = written
      ? (((await ctx.db.findOne("recurring_run_items", String(item.id))) as Row | null) ?? item)
      : item
    await ctx.db.update("recurring_run_items", String(item.id), {
      state: "approved",
      approved_hash: itemContentHash(now, draft, lines, issuer),
    })
    approvedIds.push(String(item.id))
    approved += 1
  }
  // The person's approval carries the rows' e-invoice sends: one grant per approved row.
  if (approvedIds.length > 0) await mintRunSendGrants(ctx as unknown as EinvCtx, approvedIds)
  const issueOn = dayOf(run.issue_on) as string
  await ctx.db.update(
    "recurring_runs",
    input.run_id,
    reask
      ? { status: run.status === "partial" ? "issuing" : run.status }
      : { status: "approved", approved_by: decider, approved_at: new Date().toISOString() },
  )
  // The run is decided: its "waits for approval" and "is late" alerts end for everyone they reached.
  if (!reask && ctx.emit) {
    for (const action of ["due", "late"] as const) {
      await ctx.emit({
        entity: "recurring_run",
        action,
        entityId: input.run_id,
        data: { run_id: input.run_id, resolved: true },
      })
    }
  }
  return {
    status: "completed",
    run_id: input.run_id,
    approved,
    changed,
    issueOn,
    message:
      `Approved ${approved} invoice${approved === 1 ? "" : "s"} of run ${input.run_id}. No number is taken now: they issue on ${issueOn} from 08:00.` +
      (changed.length > 0
        ? ` ${changed.length} draft${changed.length === 1 ? "" : "s"} changed since the card was drawn and wait for a new approval: ${changed.join(", ")}.`
        : "") +
      (patched.length > 0
        ? ` ${patched.length} schedule${patched.length === 1 ? "" : "s"} now bill${patched.length === 1 ? "s" : ""} the new terms from the next period: ${patched.join(", ")}.`
        : ""),
  }
}

/**
 * Write a row's "from now on" patch to its schedule, raising the schedule's version. Returns the
 * schedule id, or null when there is nothing to write or it was written at an earlier approval.
 */
async function writeSchedulePatch(ctx: RunCtx, item: Row): Promise<string | null> {
  const patch = jsonOf<Row | null>(item.schedule_patch, null)
  if (!patch || patch.written === true || !item.schedule_id) return null
  const schedule = (await ctx.db.findOne(
    "recurring_schedules",
    String(item.schedule_id),
  )) as Row | null
  if (!schedule) return null
  const data: Row = { version: Number(schedule.version ?? 1) + 1 }
  for (const key of ["lines", "contact_id", "due_rule", "due_days", "notes"])
    if (key in patch) data[key] = patch[key]
  await ctx.db.update("recurring_schedules", String(item.schedule_id), data)
  await ctx.db.update("recurring_run_items", String(item.id), {
    schedule_patch: { ...patch, written: true, written_version: data.version },
  })
  return String(item.schedule_id)
}

/** Undo an approval before the first number: the run goes back to drafted and a new card is staged. */
/** Why a run's approval cannot be undone now, or null: checked at staging and again when it runs. */
async function unapproveRefusal(ctx: RunCtx, runId: string): Promise<ErrorEnvelope | null> {
  const run = (await ctx.db.findOne("recurring_runs", runId)) as Row | null
  if (!run)
    return fail("run_not_found", `No month-end run ${runId}. Read it with recurring_run_get.`)
  const issued = (await runItems(ctx, runId))
    .filter((i) => i.state === "issued")
    .map((i) => String(i.issued_number ?? i.document_id))
  if (issued.length > 0) {
    return fail(
      "run_already_issuing",
      `Run ${runId} has already issued ${issued.join(", ")}, so its approval cannot be undone. Change what is left through its drafts, or credit an issued invoice with credit_note_create_and_issue.`,
    )
  }
  if (run.status !== "approved") {
    return fail(
      "run_not_approved",
      `Run ${runId} is ${String(run.status)}, not approved, so there is nothing to undo.`,
    )
  }
  return null
}

/** Stage-time check of `recurring_run_unapprove`: the same refusals, before anyone is asked. */
export async function recurringRunUnapprovePreflight(
  ctx: RunCtx,
  input: { run_id: string },
): Promise<{ ok: true } | { error: { code: string; message: string } }> {
  const refused = await unapproveRefusal(ctx, input.run_id)
  return refused ? { error: refused.error } : { ok: true }
}

export async function recurringRunUnapprove(
  ctx: RunCtx,
  input: { run_id: string },
): Promise<
  | { status: "completed"; run_id: string; approval_id: string | null; message: string }
  | ErrorEnvelope
> {
  const refused = await unapproveRefusal(ctx, input.run_id)
  if (refused) return refused
  const items = await runItems(ctx, input.run_id)
  for (const item of items) {
    if (item.state === "approved" || item.state === "waiting_reapproval") {
      await ctx.db.update("recurring_run_items", String(item.id), {
        state: "ready",
        approved_hash: null,
        send_grant: null,
      })
    }
  }
  // Every edit stays, and a patch already written to its schedule stays written. A re-ask still
  // waiting becomes the run's card again (restaged with every row); a decided one gives way to a new card.
  await ctx.db.update("recurring_runs", input.run_id, {
    status: "drafted",
    approved_by: null,
    approved_at: null,
  })
  const card = await stageRunCard(ctx, input.run_id)
  return {
    status: "completed",
    run_id: input.run_id,
    approval_id: card.approval_id,
    message: card.owed
      ? `Run ${input.run_id} is back to drafted with every edit kept; no number was taken. Its card is staged again within 5 minutes.`
      : `Run ${input.run_id} is back to drafted with every edit kept; no number was taken. A new card${card.approval_id ? ` (${card.approval_id})` : ""} asks for its approval.`,
  }
}

/** The next weekday on or after a date: a reject restages on the issue day or the next working day. */
export function workingDayFrom(date: string): string {
  let d = date
  while (weekdayOf(d) > 5) d = addDays(d, 1)
  return d
}

/**
 * A draft that belongs to a month-end run issues from that run's card only. Returns the refusal
 * naming the run, or null for any other draft.
 */
export async function runItemDraftRefusal(
  ctx: Pick<RunCtx, "db">,
  draft: { id?: unknown; external_refs?: unknown } | null | undefined,
  tool: string,
): Promise<ErrorEnvelope | null> {
  const refs = jsonOf<Record<string, unknown>>(draft?.external_refs, {})
  const itemId = refs.recurring_run_item_id
  if (typeof itemId !== "string" || itemId === "") return null
  const item = (await ctx.db.findOne("recurring_run_items", itemId)) as Row | null
  const run = item
    ? ((await ctx.db.findOne("recurring_runs", String(item.run_id))) as Row | null)
    : null
  const runName = run
    ? `the month-end run of ${dayOf(run.issue_on)} (run ${String(run.id)})`
    : "a month-end run"
  return fail(
    "run_item_draft",
    `Draft ${String(draft?.id ?? "")} belongs to ${runName}, so ${tool} does not act on it: it issues from that run's card. ` +
      "Read the run with recurring_run_get; change the draft with drafts_update.",
  )
}

/** Stage-time check of `recurring_run_issue`: the run exists and still waits for its approval. */
export async function recurringRunIssuePreflight(
  ctx: RunCtx,
  input: { run_id: string },
): Promise<{ ok: true } | { error: { code: string; message: string } }> {
  const run = (await ctx.db.findOne("recurring_runs", input.run_id)) as Row | null
  if (!run)
    return {
      error: {
        code: "run_not_found",
        message: `No month-end run ${input.run_id}. Read it with recurring_run_get.`,
      },
    }
  const items = await runItems(ctx, input.run_id)
  const reask = runDecided(run) && items.some((i) => i.state === "waiting_reapproval")
  if (!reask && run.status !== "drafted" && run.status !== "rejected") {
    return {
      error: {
        code: "run_not_drafted",
        message: `Run ${input.run_id} is ${String(run.status)}, so there is nothing to approve.`,
      },
    }
  }
  const refused = reask ? null : nothingReadyRefusal(input.run_id, items)
  return refused ? { error: refused.error } : { ok: true }
}
