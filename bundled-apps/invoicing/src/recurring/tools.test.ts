// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The four schedule tools against the in-memory store: what a save refuses, who turns automatic
// issuing on, what a pause writes, and that nothing is drafted for a paused or ended schedule.
// The gate itself (who parks, who runs) is proven on the real kernel in the api integration suite.
import { describe, expect, test } from "bun:test"
import type { CivilTime } from "../issue-date"
import { createMockDb, type MockDb } from "../test-db"
import { cardItems } from "./run-card"
import { weekdayOf } from "./schedule"
import {
  checkScheduleUpdate,
  draftCandidates,
  type RecurringCtx,
  recurringList,
  recurringScheduleCreate,
  recurringSchedulePause,
  recurringScheduleUpdate,
  type ScheduleCreateInput,
} from "./tools"

const ISSUER = "issuer-1"
const PERSON = "user-person"
const DECIDER = "user-decider"

function civilOf(date: string, zone: string): CivilTime {
  const [y, m, d] = date.split("-").map(Number) as [number, number, number]
  return { date, year: y, month: m, day: d, hour: 8, minute: 0, weekday: weekdayOf(date), zone }
}

function makeCtx(
  today: string,
  opts?: {
    approvalDecider?: string
    issuerZone?: string
    extra?: Array<Record<string, unknown>>
    seed?: Record<string, Array<Record<string, unknown>>>
  },
) {
  const db = createMockDb({
    seed: {
      issuer_profiles: [
        {
          id: ISSUER,
          legal_name: "Maison Nord SARL",
          country: "FR",
          default_currency: "EUR",
          default_language: "fr",
          timezone: opts?.issuerZone ?? "Europe/Paris",
        },
      ],
      ...(opts?.extra ? { recurring_schedules: opts.extra } : {}),
      ...(opts?.seed ?? {}),
    },
  })
  const writes: string[] = []
  const wrapped: MockDb = Object.assign(Object.create(db), {
    insert: (e: string, d: Record<string, unknown>) => (
      writes.push(`insert ${e}`), db.insert(e, d)
    ),
    update: (e: string, id: string, d: Record<string, unknown>) => (
      writes.push(`update ${e}`), db.update(e, id, d)
    ),
  })
  const ctx: RecurringCtx = {
    getUserId: async () => PERSON,
    db: wrapped as never,
    time: {
      async civil({ timezone }) {
        return civilOf(today, timezone)
      },
    },
    approval: opts?.approvalDecider
      ? {
          approvalRequestId: "req-1",
          approvalDeciderId: opts.approvalDecider,
          toolName: "invoicing:recurring_schedule_update",
        }
      : null,
  }
  return { ctx, db, writes }
}

const lines = [{ description: "Retainer {period}", qty: 1, unit_price_minor: 150000, vat_bp: 2000 }]
const input = {
  issuer_profile_id: ISSUER,
  contact_id: "contact-1",
  repeats: "month" as const,
  billing_day: "last",
  lines,
}

describe("saving a schedule", () => {
  test("a valid schedule starts active with its next dates from today in the issuer's time zone, and says so", async () => {
    const { ctx, db } = makeCtx("2026-11-10")
    const res = await recurringScheduleCreate(ctx, input)
    expect(res).toMatchObject({
      status: "completed",
      nextIssueOn: "2026-11-30",
      nextDraftOn: "2026-11-27",
    })
    const rows = db.__all("recurring_schedules")
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      status: "active",
      issue_mode: "review",
      version: 1,
      created_by: PERSON,
      next_issue_on: "2026-11-30",
      next_draft_on: "2026-11-27",
      language: "fr",
    })
    expect(rows[0]?.auto_enabled_by ?? null).toBeNull()
  })

  test("a schedule saved after the last day of the month starts with next month", async () => {
    // Both sides of the day: the 30th still bills in November, the 1st of December does not.
    expect(await recurringScheduleCreate(makeCtx("2026-11-30").ctx, input)).toMatchObject({
      nextIssueOn: "2026-11-30",
    })
    expect(await recurringScheduleCreate(makeCtx("2026-12-01").ctx, input)).toMatchObject({
      nextIssueOn: "2026-12-31",
    })
  })

  test("save refuses a missing customer, date or line, names each one and writes nothing", async () => {
    const cases: Array<[ScheduleCreateInput, string]> = [
      [{ ...input, contact_id: "" }, "contact_id"],
      [{ ...input, billing_day: "" }, "billing_day"],
      [{ ...input, lines: [] }, "lines"],
    ]
    for (const [bad, field] of cases) {
      const { ctx, writes } = makeCtx("2026-11-10")
      const res = await recurringScheduleCreate(ctx, bad)
      expect(res).toMatchObject({ status: "error", error: { code: "invalid_schedule" } })
      expect((res as { error: { message: string } }).error.message).toContain(field)
      expect(writes).toEqual([])
    }
  })

  test("save refuses an issuer that does not exist and names it", async () => {
    const { ctx, writes } = makeCtx("2026-11-10")
    const res = await recurringScheduleCreate(ctx, { ...input, issuer_profile_id: "nope" })
    expect(res).toMatchObject({ status: "error", error: { code: "issuer_not_found" } })
    expect(writes).toEqual([])
  })

  test("an unknown issuer time zone refuses with the typed refusal and writes nothing", async () => {
    const { ctx, writes } = makeCtx("2026-11-10", { issuerZone: "Mars/Olympus" })
    ctx.time = {
      async civil({ timezone }) {
        if (timezone === "Mars/Olympus")
          throw Object.assign(new Error("unknown zone"), { code: "invalid_timezone" })
        return civilOf("2026-11-10", timezone)
      },
    }
    const res = await recurringScheduleCreate(ctx, input)
    expect(res).toMatchObject({ status: "error", error: { code: "issuer_timezone_invalid" } })
    expect(writes).toEqual([])
  })

  // Mutation caught: letting create accept issue_mode auto.
  test("a new schedule cannot issue by itself: create refuses automatic issuing and says to use an update", async () => {
    const { ctx, db, writes } = makeCtx("2026-11-10")
    const res = await recurringScheduleCreate(ctx, { ...input, issue_mode: "auto" })
    expect(res).toMatchObject({ status: "error", error: { code: "auto_needs_update" } })
    expect(writes).toEqual([])
    expect(db.__all("recurring_schedules")).toHaveLength(0)
  })
})

describe("issue by itself", () => {
  const seeded = (extra: Record<string, unknown> = {}) => ({
    id: "sched-1",
    issuer_profile_id: ISSUER,
    contact_id: "contact-1",
    status: "active",
    repeats: "month",
    billing_day: "last",
    covers: "period_ended",
    issue_mode: "review",
    paid_by: "transfer",
    due_rule: "days_30",
    language: "fr",
    lines,
    next_issue_on: "2026-11-30",
    next_draft_on: "2026-11-27",
    version: 1,
    created_by: PERSON,
    ...extra,
  })

  test("it is off by default and an update turns it on recording who decided and when, raising the version", async () => {
    const { ctx, db } = makeCtx("2026-11-10", { approvalDecider: DECIDER, extra: [seeded()] })
    expect(db.__all("recurring_schedules")[0]?.issue_mode).toBe("review")
    const res = await recurringScheduleUpdate(ctx, { id: "sched-1", issue_mode: "auto" })
    expect(res).toMatchObject({ status: "completed", id: "sched-1", version: 2, issueMode: "auto" })
    expect(db.__all("recurring_schedules")[0]).toMatchObject({
      issue_mode: "auto",
      auto_enabled_by: DECIDER,
      auto_enabled_at: "2026-11-10",
      version: 2,
    })
  })

  test("a person's own click records that person, and turning it off clears who enabled it", async () => {
    const { ctx, db } = makeCtx("2026-11-10", { extra: [seeded()] })
    await recurringScheduleUpdate(ctx, { id: "sched-1", issue_mode: "auto" })
    expect(db.__all("recurring_schedules")[0]?.auto_enabled_by).toBe(PERSON)
    await recurringScheduleUpdate(ctx, { id: "sched-1", issue_mode: "review" })
    const row = db.__all("recurring_schedules")[0]
    expect(row?.issue_mode).toBe("review")
    expect(row?.auto_enabled_by ?? null).toBeNull()
    expect(row?.version).toBe(3)
  })

  test("an update names a missing schedule, refuses a change that leaves it incomplete, and writes nothing", async () => {
    const { ctx, writes } = makeCtx("2026-11-10", { extra: [seeded()] })
    expect(await recurringScheduleUpdate(ctx, { id: "missing", notes: "x" })).toMatchObject({
      status: "error",
      error: { code: "schedule_not_found" },
    })
    expect(await recurringScheduleUpdate(ctx, { id: "sched-1", lines: [] })).toMatchObject({
      status: "error",
      error: { code: "invalid_schedule" },
    })
    expect(writes).toEqual([])
  })

  test("a save made from a version someone else has since changed is refused, names both versions, and writes nothing", async () => {
    const { ctx, db, writes } = makeCtx("2026-11-10", { extra: [seeded()] })
    const first = await recurringScheduleUpdate(ctx, {
      id: "sched-1",
      expected_version: 1,
      lines: [{ ...(lines[0] as (typeof lines)[number]), unit_price_minor: 65000 }],
    })
    expect(first).toMatchObject({ status: "completed", version: 2 })
    writes.length = 0
    // A second window still holds version 1 and saves its own price.
    const stale = await recurringScheduleUpdate(ctx, {
      id: "sched-1",
      expected_version: 1,
      lines: [{ ...(lines[0] as (typeof lines)[number]), unit_price_minor: 50000 }],
    })
    expect(stale).toMatchObject({ status: "error", error: { code: "schedule_changed" } })
    const message = (stale as { error: { message: string } }).error.message
    expect(message).toContain("version 2")
    expect(message).toContain("version 1")
    expect(message).toContain("Nothing was saved")
    expect(writes).toEqual([])
    expect(db.__all("recurring_schedules")[0]).toMatchObject({ version: 2 })
    expect(
      (db.__all("recurring_schedules")[0]!.lines as Array<{ unit_price_minor: number }>)[0]
        ?.unit_price_minor,
    ).toBe(65000)
    // The stage-time check refuses it as well, so no approval is ever asked for a stale change.
    expect(
      await checkScheduleUpdate(
        ctx,
        { id: "sched-1", expected_version: 1, notes: "x" },
        "preflight",
      ),
    ).toMatchObject({
      error: { code: "schedule_changed" },
    })
  })

  test("a saved change is announced, so every open window of the schedule reads it again", async () => {
    const { ctx } = makeCtx("2026-11-10", { extra: [seeded()] })
    const emitted: Array<Record<string, unknown>> = []
    const withEmit = {
      ...ctx,
      emit: async (e: Record<string, unknown>) => void emitted.push(e),
    } as RecurringCtx
    await recurringScheduleUpdate(withEmit, {
      id: "sched-1",
      expected_version: 1,
      notes: "Paid by transfer",
    })
    expect(emitted).toEqual([
      {
        entity: "recurring_schedule",
        action: "updated",
        entityId: "sched-1",
        data: { schedule_id: "sched-1", version: 2 },
      },
    ])
  })

  test("an update of the billing day moves the next dates from today", async () => {
    const { ctx, db } = makeCtx("2026-11-10", { extra: [seeded()] })
    await recurringScheduleUpdate(ctx, { id: "sched-1", billing_day: "15" })
    expect(db.__all("recurring_schedules")[0]).toMatchObject({
      next_issue_on: "2026-11-15",
      next_draft_on: "2026-11-12",
    })
  })
})

describe("pausing", () => {
  const active = (extra: Record<string, unknown> = {}) => ({
    id: "sched-1",
    issuer_profile_id: ISSUER,
    contact_id: "contact-1",
    status: "active",
    repeats: "month",
    billing_day: "last",
    covers: "period_ended",
    issue_mode: "review",
    lines,
    next_issue_on: "2026-12-31",
    next_draft_on: "2026-12-28",
    version: 1,
    ...extra,
  })

  test("a pause stops the next draft, and the schedule is not due while it lasts", async () => {
    const { ctx } = makeCtx("2026-12-20", { extra: [active()] })
    expect(await recurringSchedulePause(ctx, { id: "sched-1", until: "2027-01-10" })).toMatchObject(
      {
        status: "completed",
        id: "sched-1",
        scheduleStatus: "paused",
        until: "2027-01-10",
      },
    )
    expect(await draftCandidates(ctx, "2026-12-28")).toEqual([])
    expect(await draftCandidates(ctx, "2026-12-31")).toEqual([])
  })

  // Mutation caught: resuming with the dates the schedule had before the pause.
  test("until resumes it with no back-billing: the days inside the pause are never drafted", async () => {
    const { ctx, db } = makeCtx("2026-12-20", { extra: [active()] })
    await recurringSchedulePause(ctx, { id: "sched-1", until: "2027-01-10" })
    expect(await draftCandidates(ctx, "2027-01-11")).toEqual([])
    expect(db.__all("recurring_schedules")[0]).toMatchObject({
      status: "active",
      paused_until: null,
      next_issue_on: "2027-01-31",
      next_draft_on: "2027-01-28",
    })
    expect((await draftCandidates(ctx, "2027-01-28")).map((s) => s.id)).toEqual(["sched-1"])
  })

  test("a pause without a date lasts until an update makes the schedule active again", async () => {
    const { ctx, db } = makeCtx("2026-12-20", { extra: [active()] })
    await recurringSchedulePause(ctx, { id: "sched-1" })
    expect(await draftCandidates(ctx, "2027-06-30")).toEqual([])
    await recurringScheduleUpdate(ctx, { id: "sched-1", status: "active" })
    expect(db.__all("recurring_schedules")[0]).toMatchObject({
      status: "active",
      next_issue_on: "2026-12-31",
    })
  })

  // A pause during an open month-end run: the schedule's row must not stay ready, or approving
  // the run would still issue that customer's invoice.
  test("a pause takes the schedule's row out of an open month-end run, saying why, and leaves issued rows alone", async () => {
    const draft = (id: string, status = "draft") => ({
      id,
      type: "invoice",
      status,
      counterparty_name: "Studio Sud",
      currency: "EUR",
    })
    const item = (
      id: string,
      runId: string,
      documentId: string,
      state: string,
      extra: Record<string, unknown> = {},
    ) => ({
      id,
      run_id: runId,
      source: "schedule",
      schedule_id: "sched-1",
      schedule_version: 1,
      period_key: id,
      period_start: "2026-12-01",
      period_end: "2026-12-31",
      document_id: documentId,
      position: 0,
      state,
      ...extra,
    })
    const { ctx, db } = makeCtx("2026-12-30", {
      extra: [active()],
      seed: {
        recurring_runs: [
          {
            id: "run-nov",
            issuer_profile_id: ISSUER,
            issue_on: "2026-11-30",
            status: "issued",
            period_label: "November 2026",
          },
          {
            id: "run-dec",
            issuer_profile_id: ISSUER,
            issue_on: "2026-12-31",
            status: "drafted",
            period_label: "December 2026",
          },
        ],
        recurring_run_items: [
          item("item-nov", "run-nov", "doc-nov", "issued", { issued_number: "F-2026-0101" }),
          item("item-dec", "run-dec", "doc-dec", "ready", { note: "Ask for the PO number" }),
        ],
        documents: [draft("doc-nov", "issued"), draft("doc-dec")],
        document_lines: [
          {
            id: "line-dec",
            document_id: "doc-dec",
            position: 0,
            description: "Retainer",
            qty: 1,
            unit_price_minor: 150000,
            vat_bp: 2000,
          },
        ],
      },
    })
    const res = await recurringSchedulePause(ctx, { id: "sched-1" })
    expect(res).toMatchObject({ status: "completed", scheduleStatus: "paused" })
    const byId = new Map(db.__all("recurring_run_items").map((r) => [r.id, r]))
    expect(byId.get("item-dec")).toMatchObject({ state: "left_out", approved_hash: null })
    expect(String(byId.get("item-dec")?.note)).toContain("Schedule paused")
    expect(String(byId.get("item-dec")?.note)).toContain("Ask for the PO number")
    expect(byId.get("item-nov")).toMatchObject({ state: "issued", issued_number: "F-2026-0101" })
    await expect(cardItems(ctx, "run-dec")).resolves.toMatchObject({ items: [] })
    expect(res.status === "completed" ? res.message : "").toContain("left out")
  })

  test("a pause also takes out a row already approved but not yet issued", async () => {
    const { ctx, db } = makeCtx("2026-12-30", {
      extra: [active()],
      seed: {
        recurring_runs: [
          {
            id: "run-dec",
            issuer_profile_id: ISSUER,
            issue_on: "2026-12-31",
            status: "approved",
            period_label: "December 2026",
          },
        ],
        recurring_run_items: [
          {
            id: "item-dec",
            run_id: "run-dec",
            source: "schedule",
            schedule_id: "sched-1",
            period_key: "2026-12",
            period_start: "2026-12-01",
            period_end: "2026-12-31",
            document_id: "doc-dec",
            position: 0,
            state: "approved",
            approved_hash: "h1",
            send_grant: "g1",
          },
        ],
        documents: [
          { id: "doc-dec", type: "invoice", status: "draft", counterparty_name: "Studio Sud" },
        ],
      },
    })
    await recurringSchedulePause(ctx, { id: "sched-1", until: "2027-02-01" })
    expect(db.__all("recurring_run_items")[0]).toMatchObject({
      state: "left_out",
      approved_hash: null,
      send_grant: null,
      note: "Schedule paused",
    })
  })

  test("a paused schedule checked before the pause writes nothing to its run", async () => {
    const { ctx, writes } = makeCtx("2026-12-30", {
      extra: [active()],
      seed: {
        recurring_runs: [
          {
            id: "run-dec",
            issuer_profile_id: ISSUER,
            issue_on: "2026-12-31",
            status: "drafted",
            period_label: "December 2026",
          },
        ],
        recurring_run_items: [
          {
            id: "item-dec",
            run_id: "run-dec",
            source: "schedule",
            schedule_id: "sched-1",
            period_key: "2026-12",
            period_start: "2026-12-01",
            period_end: "2026-12-31",
            document_id: "doc-dec",
            position: 0,
            state: "ready",
          },
        ],
        documents: [
          { id: "doc-dec", type: "invoice", status: "draft", counterparty_name: "Studio Sud" },
        ],
      },
    })
    await recurringSchedulePause(ctx, { id: "sched-1" }, true)
    expect(writes).toEqual([])
  })

  test("pausing a paused schedule writes nothing and says it was already paused", async () => {
    const { ctx, writes } = makeCtx("2026-12-20", {
      extra: [active({ status: "paused", paused_until: "2027-01-10" })],
    })
    const res = await recurringSchedulePause(ctx, { id: "sched-1", until: "2027-02-01" })
    expect(res).toMatchObject({ status: "completed", scheduleStatus: "paused", unchanged: true })
    expect(writes).toEqual([])
  })

  test("an ended schedule drafts nothing and cannot be paused", async () => {
    const { ctx, writes } = makeCtx("2026-12-28", { extra: [active({ status: "ended" })] })
    expect(await draftCandidates(ctx, "2026-12-28")).toEqual([])
    expect(await recurringSchedulePause(ctx, { id: "sched-1" })).toMatchObject({
      status: "error",
      error: { code: "schedule_ended" },
    })
    expect(writes).toEqual([])
  })

  test("a pause date in the past is refused and a missing schedule is named", async () => {
    const { ctx, writes } = makeCtx("2026-12-20", { extra: [active()] })
    expect(await recurringSchedulePause(ctx, { id: "sched-1", until: "2026-12-19" })).toMatchObject(
      {
        status: "error",
        error: { code: "invalid_until" },
      },
    )
    expect(await recurringSchedulePause(ctx, { id: "missing" })).toMatchObject({
      status: "error",
      error: { code: "schedule_not_found" },
    })
    expect(writes).toEqual([])
  })
})

describe("listing", () => {
  test("it lists schedules with their next run, filtered by status, and pages", async () => {
    const row = (id: string, status: string, next: string | null) => ({
      id,
      issuer_profile_id: ISSUER,
      contact_id: "c",
      status,
      repeats: "month",
      billing_day: "last",
      issue_mode: "review",
      lines,
      next_issue_on: next,
      next_draft_on: next,
      version: 1,
      notes: "Ask for the PO number",
    })
    const { ctx } = makeCtx("2026-11-10", {
      extra: [
        row("a", "active", "2026-11-30"),
        row("b", "paused", "2026-12-31"),
        row("c", "active", "2026-12-31"),
      ],
    })
    const all = await recurringList(ctx, {})
    expect(all.rows.map((r) => r.id).sort()).toEqual(["a", "b", "c"])
    expect(all.rows.every((r) => !("notes" in r))).toBe(true)
    const active = await recurringList(ctx, { status: "active" })
    expect(active.rows.map((r) => r.id).sort()).toEqual(["a", "c"])
    expect(active.nextRun).toBe("2026-11-30")
    const first = await recurringList(ctx, { limit: 2 })
    expect(first.rows).toHaveLength(2)
    expect(first.nextCursor).not.toBeNull()
    const second = await recurringList(ctx, { limit: 2, cursor: first.nextCursor ?? undefined })
    expect(second.rows).toHaveLength(1)
    expect(second.nextCursor).toBeNull()
  })
})

describe("a price read back as text", () => {
  test("a line price written as a string of digits is saved as a whole number", async () => {
    const { ctx, db } = makeCtx("2026-11-10")
    const priced = [
      {
        description: "Retainer",
        qty: 1,
        unit_price_minor: "150000" as unknown as number,
        vat_bp: 2000,
      },
    ]
    const res = await recurringScheduleCreate(ctx, { ...input, lines: priced })
    expect(res).toMatchObject({ status: "completed" })
    expect(
      (db.__all("recurring_schedules")[0]!.lines as Array<{ unit_price_minor: unknown }>)[0]
        ?.unit_price_minor,
    ).toBe(150000)
  })
})
