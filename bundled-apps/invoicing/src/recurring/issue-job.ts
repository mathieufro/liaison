// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The issue job of a month-end run, and the one-item issue it calls.
//
// From 08:00 in the issuer's time zone on the run's issue day, and until its last issue day, the
// job issues the approved items in order, each through `recurring_item_issue`, its own tool call
// whose writes land in one commit: a failed item writes nothing (its number is never taken) and
// the others keep theirs. A run past its last issue day issues nothing: it is late, and a person
// decides.
//
// The issued document is a new row (issuing a draft writes a document and deletes the draft), so
// the item follows it. In the one commit that numbers the invoice, the draft's `external_ref`
// (unique) moves to the issued document with its change log, the draft goes, the item turns
// issued and points at the document, and its schedule names it. A second call for the same item
// fails on that unique key, so a period is billed once whoever calls.
import { prepareItemSend } from "../einvoicing/run-send"
import type { EinvCtx } from "../einvoicing/transmit"
import type { IssueBatchOp } from "../issue"
import { BILLED_BY_STRIPE } from "../issuer-guard"
import { issueRunDraft } from "../mutations/invoice-issue"
import type { ErrorEnvelope } from "../mutations/shared"
import { rowIssuerHold } from "./item-state"
import {
  currentItemHash,
  dayOf,
  endHold,
  jsonOf,
  type Row,
  type RunCtx,
  runItems,
  stageRunCard,
  workingDayFrom,
} from "./run-card"

/** The end state of a run whose approval left no invoice to issue: never "issued" with none issued. */
export const NOTHING_TO_ISSUE = "nothing_to_issue"

/** Items a tick starts at most. */
export const ITEMS_PER_TICK = 25
/** The item tool's own timeout (manifest `recurring_item_issue.timeoutMs`). */
export const ITEM_TIMEOUT_MS = 20_000
/** The job's timeout (manifest `recurring-issue.timeoutMs`): 25 items at their full timeout fit. */
export const ISSUE_JOB_TIMEOUT_MS = 600_000
/** The hour, in the issuer's zone, from which a run's issue day issues. */
export const ISSUE_HOUR = 8

const fail = (code: string, message: string): ErrorEnvelope => ({
  status: "error",
  error: { code, message },
})

/** Issue one approved item of a run: every check first, then one commit (see the file header). */
export async function recurringItemIssue(
  ctx: RunCtx,
  input: { item_id: string },
): Promise<
  | { status: "completed"; item_id: string; document_id: string; number: string; message: string }
  | ErrorEnvelope
> {
  const before = (await ctx.db.findOne("recurring_run_items", input.item_id)) as Row | null
  if (!before) return fail("item_not_found", `No month-end run item ${input.item_id}.`)
  // Numbers are taken only inside the run's issue window: from 08:00 on its issue day, until its
  // last issue day. Checked before the claim, so a refused call changes nothing.
  const runBefore = (await ctx.db.findOne("recurring_runs", String(before.run_id))) as Row | null
  const window = runBefore ? await windowOf(ctx, runBefore) : null
  if (!runBefore || !window || window.early || window.late) {
    const when = runBefore
      ? `its issue window runs from ${String(ISSUE_HOUR).padStart(2, "0")}:00 on ${dayOf(runBefore.issue_on)} to ${dayOf(runBefore.latest_issue_on)}`
      : "its run is gone"
    return fail(
      "outside_issue_window",
      `Item ${input.item_id} was not issued and no number was used: ${when}${window ? `, and it is ${window.today} ${String(window.hour).padStart(2, "0")}h in the issuer's time zone` : ""}.`,
    )
  }
  // One customer, one issuer: a row whose customer now pays a live Stripe subscription (a schedule
  // made before Stripe was connected), or that Stripe cannot be asked about, is not issued. Checked
  // before the claim, so no number is taken; the row stays a draft and says why.
  if (before.state === "approved") {
    const draftBefore = (await ctx.db.findOne(
      "documents",
      String(before.document_id),
    )) as Row | null
    const schedule = before.schedule_id
      ? ((await ctx.db.findOne("recurring_schedules", String(before.schedule_id))) as Row | null)
      : null
    const hold =
      draftBefore && draftBefore.status === "draft"
        ? await rowIssuerHold(ctx, draftBefore, schedule)
        : null
    if (hold) {
      const code =
        hold === BILLED_BY_STRIPE
          ? "subscription_stream_conflict"
          : "subscription_check_unavailable"
      const message =
        code === "subscription_stream_conflict"
          ? `Item ${input.item_id} was not issued and no number was used: its customer pays a live Stripe subscription, which already invoices them. It stays a draft; take it out of the run, or say on its schedule what else it bills.`
          : `Item ${input.item_id} was not issued and no number was used: Stripe is connected but could not say whether its customer pays a subscription. It stays a draft, and the run names it until it is issued again.`
      if (code === "subscription_stream_conflict") {
        await ctx.db.update("recurring_run_items", input.item_id, {
          state: "needs_fix",
          approved_hash: null,
          note: BILLED_BY_STRIPE,
          failure: { code, message },
        })
      }
      return fail(code, message)
    }
  }
  const item = before
  if (item.state !== "approved") {
    return fail(
      item.state === "issued" ? "already_issued" : "item_not_approved",
      item.state === "issued"
        ? `Item ${input.item_id} is already issued as ${String(item.issued_number ?? item.document_id)}; nothing was issued again.`
        : `Item ${input.item_id} is ${String(item.state)}, not approved, so nothing was issued and no number was used.`,
    )
  }
  const run = (await ctx.db.findOne("recurring_runs", String(item.run_id))) as Row | null
  if (!run || (run.status !== "issuing" && run.status !== "approved")) {
    return fail(
      "run_not_issuing",
      `The run of item ${input.item_id} is not issuing; nothing was issued and no number was used.`,
    )
  }
  const draftId = String(item.document_id)
  const draft = (await ctx.db.findOne("documents", draftId)) as Row | null
  if (!draft || draft.status !== "draft") {
    return fail(
      "draft_missing",
      `Draft ${draftId} of item ${input.item_id} is gone; nothing was issued and no number was used.`,
    )
  }
  // The backstop: a draft, or its issuer's legal or bank details, changed since its approval: it
  // stays a draft and asks again.
  const hash = await currentItemHash(ctx, { ...item, state: "approved" }, draft)
  if (hash !== item.approved_hash) {
    await ctx.db.update("recurring_run_items", input.item_id, {
      state: "waiting_reapproval",
      approved_hash: null,
    })
    return fail(
      "changed_since_approval",
      `Draft ${draftId} changed after its approval, so it was not issued and no number was used. It waits for a new approval.`,
    )
  }
  const externalRef = String(draft.external_ref ?? "")
  if (!externalRef) {
    return fail(
      "draft_without_key",
      `Draft ${draftId} of item ${input.item_id} has no period key; nothing was issued and no number was used.`,
    )
  }
  const carried = jsonOf<Array<Record<string, unknown>>>(draft.lifecycle_log, [])
  // A row a person approved carries its send grant: its e-invoice is prepared under it below. A
  // run that issued by itself had no person: its e-invoices wait for the daily send card.
  const held = typeof item.send_grant === "string" && item.send_grant !== ""
  const send = held ? ("held" as const) : run.auto === true ? ("batch" as const) : undefined
  // The item and its schedule follow the invoice in the same commit (the claim is that commit).
  const followers: IssueBatchOp[] = [
    {
      update: "recurring_run_items",
      id: input.item_id,
      data: {
        state: "issued",
        document_id: { $ref: "document" },
        issued_number: { $seq: "formatted" },
        failure: null,
      },
    },
    ...(item.schedule_id
      ? [
          {
            update: "recurring_schedules",
            id: String(item.schedule_id),
            data: { last_document_id: { $ref: "document" } },
          },
        ]
      : []),
  ]
  let issued: Awaited<ReturnType<typeof issueRunDraft>>
  try {
    issued = await issueRunDraft(ctx, {
      draft_id: draftId,
      external_ref: externalRef,
      lifecycle_log: carried,
      ...(send ? { einvoice_send: send } : {}),
      commit_with: followers,
    })
  } catch (err) {
    // A second call for the same item lost the race (the period key is unique, the draft is
    // gone): the first one issued it, and this one wrote nothing.
    const now = (await ctx.db.findOne("recurring_run_items", input.item_id)) as Row | null
    if (now?.state !== "issued") throw err
    return fail(
      "already_issued",
      `Item ${input.item_id} is already issued as ${String(now.issued_number ?? now.document_id)}; nothing was issued again.`,
    )
  }
  if (issued.status !== "completed") {
    if (issued.status === "error") return issued
    return fail(
      "not_issued",
      `Item ${input.item_id} was not issued: the issue asked for an approval.`,
    )
  }
  if (held) await prepareItemSend(ctx as unknown as EinvCtx, input.item_id)
  return {
    status: "completed",
    item_id: input.item_id,
    document_id: issued.document_id,
    number: issued.number,
    message: `Issued ${issued.number} (document ${issued.document_id}) from draft ${draftId}.`,
  }
}

interface RunWindow {
  /** Before 08:00 on the issue day. */
  early: boolean
  /** After the last issue day. */
  late: boolean
  today: string
  hour: number
}

async function windowOf(ctx: RunCtx, run: Row): Promise<RunWindow | null> {
  const issuer = (await ctx.db.findOne(
    "issuer_profiles",
    String(run.issuer_profile_id),
  )) as Row | null
  if (!issuer) return null
  const now = await ctx.time.civil({ timezone: String(issuer.timezone || "UTC") })
  const issueOn = dayOf(run.issue_on) as string
  const lastDay = dayOf(run.latest_issue_on) as string
  return {
    early: now.date < issueOn || (now.date === issueOn && now.hour < ISSUE_HOUR),
    late: now.date > lastDay,
    today: now.date,
    hour: now.hour,
  }
}

async function issueRun(
  ctx: RunCtx,
  run: Row,
  started: number,
): Promise<{ issued: number; failed: number; more: boolean }> {
  const runId = String(run.id)
  if (run.status === "approved") {
    await ctx.db.updateMany("recurring_runs", {
      where: {
        issuer_profile_id: run.issuer_profile_id,
        issue_on: dayOf(run.issue_on),
        status: "approved",
      },
      data: { status: "issuing" },
    })
  }
  let issued = 0
  let failed = 0
  let started_items = 0
  let reask = false
  const pending = (await runItems(ctx, runId)).filter((i) => i.state === "approved")
  for (const item of pending) {
    if (started_items >= ITEMS_PER_TICK) break
    // Start an item only while its full timeout still fits in the job's.
    if (Date.now() - started + ITEM_TIMEOUT_MS > ISSUE_JOB_TIMEOUT_MS - 5_000) break
    started_items += 1
    const env = await ctx.executeTool("invoicing:recurring_item_issue", {
      item_id: String(item.id),
    })
    const result =
      env.status === "completed"
        ? (env.result as { status?: string; error?: { code: string; message: string } })
        : null
    if (result?.status === "completed") {
      issued += 1
      continue
    }
    const error =
      env.status === "error"
        ? env.error
        : (result?.error ?? { code: "not_issued", message: "the item was not issued" })
    if (error.code === "already_issued") continue
    // Changed since its approval: not a failure, the row waits for the new card staged below.
    if (error.code === "changed_since_approval") {
      reask = true
      continue
    }
    failed += 1
    const now = (await ctx.db.findOne("recurring_run_items", String(item.id))) as Row | null
    if (now?.state === "approved") {
      await ctx.db.update("recurring_run_items", String(item.id), {
        state: "failed",
        failure: { code: error.code, message: error.message },
      })
    }
    if (ctx.emit) {
      await ctx.emit({
        entity: "recurring_run",
        action: "partial",
        entityId: runId,
        data: {
          run_id: runId,
          item_id: String(item.id),
          document_id: String(item.document_id),
          code: error.code,
          reason: error.message,
          resolved: false,
        },
      })
    }
  }
  // One new card asks for every row that changed since the approval; the others issue on time.
  if (reask) await stageRunCard(ctx, runId)
  const items = await runItems(ctx, runId)
  const left = items.filter((i) => i.state === "approved").length
  const stuck = items.filter((i) => i.state === "failed" || i.state === "waiting_reapproval").length
  const numbered = items.filter((i) => i.state === "issued").length
  // A run reads "issued" only when it issued at least one invoice. With none issued and rows still
  // waiting it keeps issuing; with nothing left at all it closes as nothing to issue.
  if (left === 0 && (numbered > 0 || stuck === 0)) {
    const status = numbered === 0 ? NOTHING_TO_ISSUE : stuck > 0 ? "partial" : "issued"
    await ctx.db.update("recurring_runs", runId, { status })
    if (status === "issued" && ctx.emit) {
      await ctx.emit({
        entity: "recurring_run",
        action: "issued",
        entityId: runId,
        data: { run_id: runId, issue_on: dayOf(run.issue_on), resolved: true },
      })
    }
  }
  return { issued, failed, more: left > 0 }
}

/** The run of a rejected card asks again on the issue day from 08:00, or the next working day. */
async function restageRejected(ctx: RunCtx, run: Row, w: RunWindow): Promise<boolean> {
  const issueOn = dayOf(run.issue_on) as string
  const askOn = workingDayFrom(issueOn)
  if (w.today < askOn || (w.today === askOn && w.hour < ISSUE_HOUR)) return false
  const claim = await ctx.db.updateMany("recurring_runs", {
    where: {
      issuer_profile_id: run.issuer_profile_id,
      issue_on: dayOf(run.issue_on),
      status: "rejected",
    },
    data: { status: "drafted", approval_request_id: null },
  })
  if (claim.count !== 1) return false
  await stageRunCard(ctx, String(run.id))
  return true
}

/**
 * Stage the cards runs owe: a run waiting for its first card, or a decided run with rows waiting
 * for a new approval whose card a person's own edit could not stage. Idempotent: a card still
 * waiting is rewritten, never doubled.
 */
async function stageOwedCards(ctx: RunCtx): Promise<number> {
  const runs = (await ctx.db.findMany("recurring_runs", {
    where: { status: { in: ["drafted", "approved", "issuing", "partial"] } },
    orderBy: { issue_on: "asc" },
    limit: 50,
  })) as Row[]
  let staged = 0
  for (const run of runs) {
    const items = await runItems(ctx, String(run.id))
    // A card still waiting is rewritten only when its rows changed, so asking again is free.
    const owed =
      run.status === "drafted"
        ? items.some((i) => i.state === "ready")
        : items.some((i) => i.state === "waiting_reapproval")
    if (!owed) continue
    if ((await stageRunCard(ctx, String(run.id))).staged) staged += 1
  }
  return staged
}

export async function recurringIssueJob(
  ctx: RunCtx,
): Promise<{ status: "ok"; issued: number; failed: number; message: string }> {
  const started = Date.now()
  await stageOwedCards(ctx)
  const runs = (await ctx.db.findMany("recurring_runs", {
    where: { status: { in: ["approved", "issuing", "rejected"] } },
    orderBy: { issue_on: "asc" },
    limit: 50,
  })) as Row[]
  let issued = 0
  let failed = 0
  // Running again ends any hold the day limit put on this job (the kernel's held notice).
  if (runs.length > 0) await endHold(ctx, "recurring-issue")
  for (const run of runs) {
    const w = await windowOf(ctx, run)
    if (!w) continue
    if (w.late) continue // the legal-date job marks it late; nothing issues after the last day
    if (run.status === "rejected") {
      await restageRejected(ctx, run, w)
      continue
    }
    if (w.early) continue
    const r = await issueRun(ctx, run, started)
    issued += r.issued
    failed += r.failed
    if (r.more) break // the next tick resumes where this one stopped
  }
  return {
    status: "ok",
    issued,
    failed,
    message:
      issued + failed === 0
        ? "Nothing to issue now."
        : `Issued ${issued} invoice${issued === 1 ? "" : "s"}; ${failed} stayed drafts.`,
  }
}
