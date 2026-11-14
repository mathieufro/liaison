// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The daily legal-date job of month-end runs. A run issues no later than its last issue day (the
// billing month's last day, in the issuer's time zone), so an undecided run is pushed up as that
// day nears: three days before, its line rises to the top; on the day, the card says it ends
// today; the day after, the run is late, the line stays, and nothing issues by itself. A rejected
// card also lands here: its drafts stay drafts until the issue job asks again.
import { dayOf, endHold, type Row, type RunCtx } from "./run-card"
import { addDays } from "./schedule"

export type Urgency = "normal" | "rising" | "ends_today" | "late"

/** How pressing an undecided run is on `today`, both sides of its last issue day. */
export function urgencyOf(today: string, lastDay: string): Urgency {
  if (today > lastDay) return "late"
  if (today === lastDay) return "ends_today"
  if (today >= addDays(lastDay, -3)) return "rising"
  return "normal"
}

const OPEN = ["drafted", "rejected", "approved", "issuing", "late"]

async function approvalStatus(ctx: RunCtx, approvalId: string): Promise<string | null> {
  if (!ctx.approvals?.statusOf) return null
  let raw: unknown = await ctx.approvals.statusOf(approvalId)
  if (typeof raw === "string") {
    try {
      raw = JSON.parse(raw)
    } catch {
      raw = null
    }
  }
  const st = (raw ?? {}) as { status?: string | null; expired?: boolean }
  if (st.status === "pending" && st.expired) return "expired"
  return st.status ?? null
}

export async function recurringLegalDateJob(
  ctx: RunCtx,
): Promise<{ status: "ok"; runs: Array<{ run_id: string; urgency: Urgency }> }> {
  const runs = (await ctx.db.findMany("recurring_runs", {
    where: { status: { in: OPEN } },
    orderBy: { issue_on: "asc" },
    limit: 200,
  })) as Row[]
  const out: Array<{ run_id: string; urgency: Urgency }> = []
  if (runs.length > 0) await endHold(ctx, "recurring-legal-date")
  for (const run of runs) {
    const runId = String(run.id)
    const issuer = (await ctx.db.findOne(
      "issuer_profiles",
      String(run.issuer_profile_id),
    )) as Row | null
    if (!issuer) continue
    const now = await ctx.time.civil({ timezone: String(issuer.timezone || "UTC") })
    let status = String(run.status)
    // A card denied or expired leaves the drafts as they are; the issue job stages a new one.
    if (
      status === "drafted" &&
      typeof run.approval_request_id === "string" &&
      run.approval_request_id !== "staging"
    ) {
      const decided = await approvalStatus(ctx, run.approval_request_id)
      if (decided === "denied" || decided === "expired" || decided === "cancelled") {
        await ctx.db.update("recurring_runs", runId, { status: "rejected" })
        status = "rejected"
      }
    }
    if (status === "approved" || status === "issuing") {
      // Approved runs issue by themselves; only a run past its last day still owes something.
      if (now.date <= (dayOf(run.latest_issue_on) as string)) continue
    }
    const urgency = urgencyOf(now.date, dayOf(run.latest_issue_on) as string)
    if (urgency === "late" && status !== "late")
      await ctx.db.update("recurring_runs", runId, { status: "late" })
    if (urgency === "normal") continue
    out.push({ run_id: runId, urgency })
    if (ctx.emit) {
      await ctx.emit({
        entity: "recurring_run",
        action: urgency === "late" ? "late" : "due",
        entityId: runId,
        data: {
          run_id: runId,
          urgency,
          issue_on: dayOf(run.issue_on),
          latest_issue_on: dayOf(run.latest_issue_on),
          period: run.period_label,
          when:
            urgency === "ends_today"
              ? "Ends today"
              : urgency === "late"
                ? "Late"
                : `Ends ${dayOf(run.latest_issue_on)}`,
          resolved: false,
        },
      })
    }
  }
  return { status: "ok", runs: out }
}
