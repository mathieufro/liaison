// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Taking a row out of a month-end run, through `drafts_discard`. A row from a schedule asks how far:
// this month only (the row is left out and its draft kept, so it can be put back), or the end of the
// schedule (its last billed month is set at once, since that only stops billing). An added row just
// goes. Ending a schedule says what it does not stop, and writes nothing anywhere but here.
import { deleteDraftRow } from "../mutations/db-helpers"
import {
  afterRunWrite,
  type EditCtx,
  issuedRefusal,
  logRunEdit,
  parkForPerson,
  type RunDraft,
  refuse,
  stageRunCardAfterRemoval,
} from "./restage"
import type { Row } from "./run-card"
import { dayOf, jsonOf } from "./run-card"

export const LAST_INVOICE = "Last invoice"
/** The note on a row left out because its schedule was paused while the run was open. */
export const SCHEDULE_PAUSED = "Schedule paused"

export interface DiscardResult {
  ok: true
  itemState: string | null
  notes: string[]
  run?: {
    run_id: string
    approve_count: number
    approve_total_minor: string
    approval_id: string | null
  }
}

export type DiscardParked = {
  status: "pending_approval"
  approval_id: string | null
  message: string
}

/** What ending a schedule leaves running, told before and after, never acted on. */
export async function endingNotes(ctx: EditCtx, rd: RunDraft): Promise<string[]> {
  const notes: string[] = []
  const s = rd.schedule
  if (!s) return notes
  if (s.paid_by === "card_link") {
    notes.push(
      `The card payment link keeps working until it is turned off in Stripe${s.card_link_url ? `: ${String(s.card_link_url)}` : ""}. Ending the schedule does not turn it off.`,
    )
  }
  const contactId = typeof s.contact_id === "string" ? s.contact_id : null
  if (contactId && ctx.executeTool) {
    try {
      const env = await ctx.executeTool("stripe:billing_status_for_counterparty", {
        contactId,
        ...(typeof s.company_id === "string" ? { companyId: s.company_id } : {}),
      })
      const res =
        env.status === "completed"
          ? (env.result as {
              live?: boolean
              subscriptions?: Array<{ id: string; plan?: string }>
            } | null)
          : null
      if (res?.live) {
        const subs = (res.subscriptions ?? []).map((x) => x.id).join(", ")
        notes.push(
          `Ending this does not stop their live Stripe subscription${subs ? ` ${subs}` : ""}: open their subscription in Stripe to stop it.`,
        )
      }
    } catch {
      // Stripe not installed or not answering: there is nothing to say about it.
    }
  }
  if (typeof s.last_document_id === "string" && s.last_document_id) {
    const last = (await ctx.db.findOne("documents", s.last_document_id)) as Row | null
    if (last && last.status !== "draft" && last.number) {
      notes.push(
        `The earlier invoice ${String(last.number)} stays as issued; credit it with credit_note_create_and_issue if it should not stand.`,
      )
    }
  }
  notes.push("Nothing else changes: no agreement, subscription or payment link is touched.")
  return notes
}

export async function discardRunDraft(
  ctx: EditCtx,
  rd: RunDraft,
  input: { draft_id: string; applies?: string; ends_on?: string },
): Promise<DiscardResult | DiscardParked> {
  if (rd.item.state === "issued" || rd.draft.status !== "draft") issuedRefusal(rd)
  const itemId = String(rd.item.id)
  const draftId = String(rd.draft.id)
  if (rd.item.source === "added") {
    const parked = await parkForPerson(
      ctx,
      "invoicing:drafts_discard",
      `Take the added row ${String(rd.draft.counterparty_name ?? draftId)} out of the month-end run`,
      input,
    )
    if (parked) return parked
    // An added row never asks: the row and its draft go, and no number was taken.
    await ctx.db.delete("recurring_run_items", itemId)
    await deleteDraftRow(ctx.db, draftId)
    const run = await stageRunCardAfterRemoval(ctx, String(rd.run.id))
    return {
      ok: true,
      itemState: null,
      notes: [`The added row and its draft ${draftId} are gone; no number was used.`],
      run,
    }
  }
  if (input.applies !== "this_month" && input.applies !== "end_schedule") {
    refuse(
      "applies_required",
      `Draft ${draftId} is a scheduled row of a month-end run, so taking it out needs how far; nothing was changed. Ask: this month only, or end the schedule? Then pass applies this_month or end_schedule (with ends_on, the last month billed).`,
    )
  }
  if (input.applies === "end_schedule") {
    const endsOn = dayOf(input.ends_on)
    if (!endsOn || !/^\d{4}-\d{2}-\d{2}$/.test(endsOn)) {
      refuse(
        "ends_on_required",
        `Ending the schedule of draft ${draftId} needs the last month billed (ends_on, a date); nothing was changed. Ask which month is the last one billed.`,
      )
    }
  }
  const what =
    input.applies === "end_schedule"
      ? `End the schedule of ${String(rd.draft.counterparty_name ?? draftId)} after ${dayOf(input.ends_on)}`
      : `Take ${String(rd.draft.counterparty_name ?? draftId)} out of this month's run`
  const parked = await parkForPerson(ctx, "invoicing:drafts_discard", what, input)
  if (parked) return parked
  if (input.applies === "this_month") {
    await ctx.db.update("recurring_run_items", itemId, {
      state: "left_out",
      approved_hash: null,
      send_grant: null,
    })
    await logRunEdit(ctx, draftId, {
      kind: "take_out",
      fields: [{ field: "state", from: rd.item.state, to: "left_out" }],
      applies: "this_month",
    })
    const r = await afterRunWrite(ctx, itemId)
    return {
      ok: true,
      itemState: "left_out",
      notes: [
        `Taken out of this month's run; the draft ${draftId} is kept, so it can be put back (drafts_update with put_back). The schedule's next month is unchanged.`,
      ],
      run: {
        run_id: r.run_id,
        approve_count: r.approve_count,
        approve_total_minor: r.approve_total_minor,
        approval_id: r.approval_id,
      },
    }
  }
  // End the schedule at once: it only stops billing. The previous end goes on the row and the log,
  // so putting the row back restores it.
  const endsOn = dayOf(input.ends_on) as string
  const s = rd.schedule
  if (!s) refuse("no_schedule", `Draft ${draftId} has no schedule to end; nothing was changed.`)
  const before = dayOf(s.ends_on)
  await ctx.db.update("recurring_schedules", String(s.id), { ends_on: endsOn })
  const beforePeriod = endsOn < String(dayOf(rd.item.period_start))
  await ctx.db.update("recurring_run_items", itemId, {
    ends_on_before: before,
    ...(beforePeriod ? { state: "left_out", approved_hash: null, send_grant: null } : {}),
  })
  await logRunEdit(ctx, draftId, {
    kind: "end_schedule",
    fields: [{ field: "schedule.ends_on", from: before, to: endsOn }],
    applies: "end_schedule",
  })
  const notes = await endingNotes(ctx, rd)
  const r = await afterRunWrite(ctx, itemId, beforePeriod ? {} : { noteAdd: [LAST_INVOICE] })
  const lead = beforePeriod
    ? `The schedule ends on ${endsOn}, before this period, so this row is left out and uses no number.`
    : `The schedule ends on ${endsOn}; this row stays as its last invoice.`
  return {
    ok: true,
    itemState: r.item_state,
    notes: [lead, ...notes],
    run: {
      run_id: r.run_id,
      approve_count: r.approve_count,
      approve_total_minor: r.approve_total_minor,
      approval_id: r.approval_id,
    },
  }
}

/** Put a left-out row back, restoring the schedule's end a "end the schedule" set. */
export async function putBack(
  ctx: EditCtx,
  rd: RunDraft,
): Promise<{ restoredEndsOn: string | null | undefined }> {
  const log = jsonOf<Row[]>(rd.draft.lifecycle_log, [])
  const ended = [...log].reverse().find((e) => e.event === "run_edit" && e.kind === "end_schedule")
  let restoredEndsOn: string | null | undefined
  if (ended && rd.schedule) {
    const change = (
      ended.fields as Array<{ field: string; from: unknown; to: unknown }> | undefined
    )?.find((f) => f.field === "schedule.ends_on")
    if (change && dayOf(rd.schedule.ends_on) === dayOf(change.to)) {
      restoredEndsOn = dayOf(change.from)
      await ctx.db.update("recurring_schedules", String(rd.schedule.id), {
        ends_on: restoredEndsOn,
      })
    }
  }
  await ctx.db.update("recurring_run_items", String(rd.item.id), { ends_on_before: null })
  return { restoredEndsOn }
}
