// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The month-end run's card against the in-memory store: one approval with a row per draft, what a
// change does to its hash, undo and reject, the last-day urgency, and issuing by itself under the
// approval threshold. Numbers and the issue transaction are proven on Postgres in the api suite.
import { describe, expect, test } from "bun:test"
import { harness, previousDoc, schedule } from "../__fixtures__/recurring-draft"
import { summarizeRecurringRunIssue } from "../summarizers"
import { recurringDraftJob } from "./draft-job"
import { recurringIssueJob } from "./issue-job"
import { recurringLegalDateJob, urgencyOf } from "./legal-date-job"
import { afterRunWrite, type EditCtx } from "./restage"
import {
  cardItems,
  recurringRunIssue,
  recurringRunIssuePreflight,
  recurringRunUnapprove,
} from "./run-card"
import { recurringRunGet } from "./run-get"

const SCHED_ONE = "33333333-3333-4333-8333-333333333331"
const SCHED_TWO = "33333333-3333-4333-8333-333333333332"

async function drafted(today = "2026-11-27", extra: Parameters<typeof harness>[1] = {}) {
  const prev = previousDoc("44444444-4444-4444-8444-444444444441", true)
  const h = harness(today, {
    schedules: [
      schedule(SCHED_ONE, { last_document_id: prev.id }),
      schedule(SCHED_TWO, { last_document_id: prev.id, created_by: "user-am-2" }),
    ],
    docs: [prev],
    ...extra,
  })
  await recurringDraftJob(h.ctx)
  const [run] = h.db.__all("recurring_runs")
  return { h, runId: String(run?.id) }
}

describe("the month-end run card", () => {
  test("the card is one approval with one row per draft and its account manager, and a changed row changes the card's hash", async () => {
    const { h, runId } = await drafted()
    expect(h.approvals).toHaveLength(1)
    const card = h.approvals[0] as {
      tool_name: string
      current_payload: {
        run_id: string
        items: Array<{ content_hash: string; document_id: string; total_minor: string }>
      }
      summary_detail: { lines: string[] }
      expiry_hours: number
    }
    expect(card.tool_name).toBe("invoicing:recurring_run_issue")
    expect(card.current_payload.items).toHaveLength(2)
    expect(card.current_payload.items[0]?.total_minor).toBe("180000")
    // Who is billed, then the total: the panel under the card lists each row's amounts.
    expect(card.summary_detail.lines).toHaveLength(2)
    expect(card.summary_detail.lines[1]).toBe("Total: 3 600.00 EUR incl. VAT")
    // Drawn on 27 Nov at 09:00 in Paris, valid to the end of 30 Nov.
    expect(card.expiry_hours).toBe(3 * 24 + 15)
    const got = await recurringRunGet(h.ctx, { run_id: runId })
    if (got.status !== "completed") throw new Error("run not read")
    expect(got.rows.map((r) => r.account_manager)).toEqual(["user-am", "user-am-2"])
    expect(got.rows.every((r) => r.draft_id !== null)).toBe(true)
    // The read points at the waiting card: a person decides it there, never a tool call.
    expect(got.message).toContain(
      `Its card (approval ${String(got.run.approval_request_id)}) waits for a person`,
    )
    const before = (await cardItems(h.ctx, runId)).items[0]?.content_hash
    const firstDraft = card.current_payload.items[0]?.document_id as string
    const line = h.db.__all("document_lines").find((l) => l.document_id === firstDraft)
    await h.db.update("document_lines", String(line?.id), {
      unit_price_minor: "160000",
      subtotal_minor: "160000",
    })
    const after = (await cardItems(h.ctx, runId)).items[0]?.content_hash
    expect(after).not.toBe(before)
  })

  test("the card's summary rebuilt from its payload still names the period, each customer and the total", async () => {
    const { h } = await drafted()
    const card = h.approvals[0] as { current_payload: Record<string, unknown> }
    const summary = await summarizeRecurringRunIssue(card.current_payload)
    expect(summary.title).toContain("Issue 2 invoices for ")
    expect(summary.title).not.toContain("a month-end run")
    const staged = (h.approvals[0] as { summary_detail: { lines: string[] } }).summary_detail.lines
    expect(summary.lines).toEqual(staged)
    expect(summary.lines[0]?.split(", ")).toHaveLength(2)
  })

  test("a row carries the address an agent found for it, and only a row that has one", async () => {
    const { h, runId } = await drafted()
    const [first] = h.db.__all("recurring_run_items")
    const found = {
      counterparty_address: "12 quai des Chartrons, 33000 Bordeaux",
      found_by_agent: "agent-1",
      at: "2026-11-27",
    }
    await h.db.update("recurring_run_items", String(first?.id), { fix_suggestion: found })
    const got = await recurringRunGet(h.ctx, { run_id: runId })
    if (got.status !== "completed") throw new Error("run not read")
    expect(got.rows[0]?.fix_suggestion).toEqual(found)
    // A row with nothing found says nothing about it.
    expect("fix_suggestion" in (got.rows[1] ?? {})).toBe(false)
  })

  test("a run with no card says nothing about one", async () => {
    const { h, runId } = await drafted()
    await h.db.update("recurring_runs", runId, { approval_request_id: null })
    const got = await recurringRunGet(h.ctx, { run_id: runId })
    if (got.status !== "completed") throw new Error("run not read")
    expect(got.message).not.toContain("Its card")
  })

  test("approval records each item's hash and the approver and takes no number", async () => {
    const { h, runId } = await drafted()
    const payload = (h.approvals[0] as { current_payload: { run_id: string; items: never[] } })
      .current_payload
    h.ctx.approval = {
      approvalRequestId: "approval-1",
      approvalDeciderId: "user-boss",
      toolName: "invoicing:recurring_run_issue",
    }
    const res = await recurringRunIssue(h.ctx, payload)
    expect(res).toMatchObject({ status: "completed", approved: 2 })
    expect(h.db.__all("recurring_runs")[0]).toMatchObject({
      status: "approved",
      approved_by: "user-boss",
    })
    expect(
      h.db
        .__all("recurring_run_items")
        .every((i) => typeof i.approved_hash === "string" && i.state === "approved"),
    ).toBe(true)
    expect(
      h.db
        .__all("documents")
        .filter((d) => d.status === "draft")
        .every((d) => d.number === null),
    ).toBe(true)
    expect(runId).toBeTruthy()
  })

  test("approving the run ends its waits-for-approval and late alerts", async () => {
    const { h } = await drafted()
    const emitted: Array<{ entity: string; action: string; data?: Record<string, unknown> }> = []
    h.ctx.emit = async (e) => {
      emitted.push(e as never)
    }
    const payload = (h.approvals[0] as { current_payload: { run_id: string; items: never[] } })
      .current_payload
    await recurringRunIssue(h.ctx, payload)
    const ends = emitted
      .filter((e) => e.entity === "recurring_run" && e.data?.resolved === true)
      .map((e) => e.action)
    expect(ends.sort()).toEqual(["due", "late"])
  })

  test("undo before the first number returns the run to drafted; after it, it is refused naming what issued", async () => {
    const { h, runId } = await drafted()
    const payload = (h.approvals[0] as { current_payload: { run_id: string; items: never[] } })
      .current_payload
    await recurringRunIssue(h.ctx, payload)
    h.decided.add("approval-1")
    const undone = await recurringRunUnapprove(h.ctx, { run_id: runId })
    expect(undone).toMatchObject({ status: "completed", approval_id: "approval-2" })
    expect(h.db.__all("recurring_runs")[0]).toMatchObject({ status: "drafted" })
    expect(h.db.__all("recurring_runs")[0]?.approved_by ?? null).toBeNull()
    expect(
      h.db
        .__all("recurring_run_items")
        .every((i) => i.state === "ready" && i.approved_hash === null),
    ).toBe(true)
    await recurringRunIssue(h.ctx, (h.approvals[1] as { current_payload: never }).current_payload)
    const [first] = h.db.__all("recurring_run_items")
    await h.db.update("recurring_run_items", String(first?.id), {
      state: "issued",
      issued_number: "F-2026-0041",
    })
    const refused = await recurringRunUnapprove(h.ctx, { run_id: runId })
    expect(refused).toMatchObject({ status: "error", error: { code: "run_already_issuing" } })
    expect(JSON.stringify(refused)).toContain("F-2026-0041")
  })

  test("a reject keeps drafts and a new card is staged on the issue day", async () => {
    const { h, runId } = await drafted()
    h.ctx.approvals = { ...h.ctx.approvals, statusOf: async () => ({ status: "denied" }) }
    await recurringLegalDateJob(h.ctx)
    expect(h.db.__all("recurring_runs")[0]).toMatchObject({ status: "rejected" })
    expect(
      h.db.__all("documents").filter((d) => d.status === "draft" && d.number === null),
    ).toHaveLength(2)
    // The day before the issue day: nothing is staged.
    const dayBefore = harness("2026-11-29")
    Object.assign(h.ctx, { time: dayBefore.ctx.time })
    await recurringIssueJob(h.ctx)
    expect(h.approvals).toHaveLength(1)
    // The issue day (a Monday), 09:00 in Paris: a new card.
    const onDay = harness("2026-11-30")
    Object.assign(h.ctx, { time: onDay.ctx.time })
    await recurringIssueJob(h.ctx)
    expect(h.approvals).toHaveLength(2)
    expect(h.db.__all("recurring_runs")[0]).toMatchObject({
      id: runId,
      status: "drafted",
      approval_request_id: "approval-2",
    })
  })

  test("three days before the last day urgency rises, on the day the card ends today, after it the run is late and nothing issues", async () => {
    expect(urgencyOf("2026-11-26", "2026-11-30")).toBe("normal")
    expect(urgencyOf("2026-11-27", "2026-11-30")).toBe("rising")
    expect(urgencyOf("2026-11-29", "2026-11-30")).toBe("rising")
    expect(urgencyOf("2026-11-30", "2026-11-30")).toBe("ends_today")
    expect(urgencyOf("2026-12-01", "2026-11-30")).toBe("late")
    const { h } = await drafted()
    const events: Array<{ action: string; data: { urgency: string; when: string } }> = []
    h.ctx.emit = async (e) => {
      events.push(e as never)
    }
    for (const [day, urgency] of [
      ["2026-11-30", "ends_today"],
      ["2026-12-01", "late"],
    ] as const) {
      Object.assign(h.ctx, { time: harness(day).ctx.time })
      await recurringLegalDateJob(h.ctx)
      expect(events.at(-1)?.data.urgency).toBe(urgency)
    }
    expect(events.find((e) => e.data.urgency === "ends_today")?.data.when).toBe("Ends today")
    expect(h.db.__all("recurring_runs")[0]).toMatchObject({ status: "late" })
    // Approved late, the issue job still issues nothing after the last day.
    let issueCalls = 0
    h.ctx.executeTool = async () => {
      issueCalls += 1
      return { status: "error", error: { code: "x", message: "x" } }
    }
    await h.db.update("recurring_runs", String(h.db.__all("recurring_runs")[0]?.id), {
      status: "approved",
    })
    await recurringIssueJob(h.ctx)
    expect(issueCalls).toBe(0)
  })

  test("approving a run with no row ready is refused with the reason, and nothing changes", async () => {
    const { h, runId } = await drafted("2026-11-27", {
      kernel: { "kernel:contacts_addresses_list": () => ({ addresses: [] }) },
    })
    expect(h.db.__all("recurring_run_items").map((i) => i.state)).toEqual([
      "needs_fix",
      "needs_fix",
    ])
    const res = await recurringRunIssue(h.ctx, { run_id: runId })
    expect(res).toMatchObject({ status: "error", error: { code: "nothing_ready" } })
    expect((res as { error: { message: string } }).error.message).toContain("No billing address")
    expect(await recurringRunIssuePreflight(h.ctx, { run_id: runId })).toMatchObject({
      error: { code: "nothing_ready" },
    })
    expect(h.db.__all("recurring_runs")[0]).toMatchObject({ status: "drafted" })
    expect(h.db.__all("recurring_runs")[0]?.approved_by ?? null).toBeNull()
    expect(h.db.__all("recurring_run_items").map((i) => i.state)).toEqual([
      "needs_fix",
      "needs_fix",
    ])
  })

  test("an approved run left with no invoice to issue closes as nothing to issue, never as issued", async () => {
    const { h, runId } = await drafted()
    await recurringRunIssue(h.ctx, { run_id: runId })
    // Both rows are taken out after the approval: nothing is left to number.
    for (const item of h.db.__all("recurring_run_items"))
      await h.db.update("recurring_run_items", String(item.id), {
        state: "left_out",
        approved_hash: null,
      })
    const events: Array<{ action: string }> = []
    h.ctx.emit = async (e) => {
      events.push(e as never)
    }
    Object.assign(h.ctx, { time: harness("2026-11-30").ctx.time })
    const res = await recurringIssueJob(h.ctx)
    expect(res.issued).toBe(0)
    expect(h.db.__all("recurring_runs")[0]).toMatchObject({ id: runId, status: "nothing_to_issue" })
    expect(events.some((e) => e.action === "issued")).toBe(false)
  })

  test("issue by itself under, at and over the threshold: no card, no card, card", async () => {
    // One schedule of 1,500.00 + 20% VAT = 1,800.00 incl., set to issue by itself.
    for (const [threshold, card] of [
      [180001, false],
      [180000, false],
      [179999, true],
    ] as const) {
      const prev = previousDoc("44444444-4444-4444-8444-444444444441", true)
      const h = harness("2026-11-27", {
        schedules: [
          schedule(SCHED_ONE, {
            issue_mode: "auto",
            auto_enabled_by: "user-boss",
            last_document_id: prev.id,
          }),
        ],
        docs: [prev],
        threshold,
      })
      await recurringDraftJob(h.ctx)
      expect(h.approvals.length > 0).toBe(card)
      const [run] = h.db.__all("recurring_runs")
      expect(run).toMatchObject(
        card ? { status: "drafted" } : { status: "approved", auto: true, approved_by: "user-boss" },
      )
    }
  })

  test("an edit restages the card's payload, and the card rebuilt from it reads the same total as the new rows", async () => {
    const { h, runId } = await drafted()
    const item = h.db.__all("recurring_run_items")[0]
    const line = h.db.__all("document_lines").find((l) => l.document_id === item?.document_id)
    await h.db.update("document_lines", String(line?.id), {
      unit_price_minor: "200000",
      subtotal_minor: "200000",
    })
    await afterRunWrite(h.ctx as unknown as EditCtx, String(item?.id))
    const summary = await summarizeRecurringRunIssue(h.restaged.at(-1) as Record<string, unknown>)
    const { items } = await cardItems(h.ctx, runId)
    const total = items.reduce((sum, i) => sum + BigInt(String(i.total_minor)), 0n)
    expect(total > 360000n).toBe(true)
    const grouped = `${String(total / 100n).replace(/\B(?=(\d{3})+(?!\d))/g, " ")}.${String(total % 100n).padStart(2, "0")}`
    expect(summary?.lines?.at(-1)).toBe(`Total: ${grouped} EUR incl. VAT`)
  })
})
