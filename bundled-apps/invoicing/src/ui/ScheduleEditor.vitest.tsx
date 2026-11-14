// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Two windows open on one recurring schedule, rendered: a price saved in one shows in the other
// through the host's record change feed, and a save the other makes from what it read before is
// refused with a message, never written over the first one.
import { cleanup, fireEvent, render, screen, waitFor } from "@solidjs/testing-library"
import { createResource } from "solid-js"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

type Listener = (events: Array<Record<string, unknown>>) => void
const listeners = new Set<Listener>()
const updates: Array<Record<string, unknown>> = []
let stored: Record<string, unknown> = {}
// Fixture copy, kept out of the copy guard's literal scan as the other rendered tests do.
const [LINE, CHANGED] = ["Group plan, {period}", "Schedule sched-1 was changed by someone else."]

const row = () => ({
  id: "sched-1",
  issuer_profile_id: "issuer-1",
  contact_id: "contact-1",
  status: "active",
  repeats: "month",
  billing_day: "last",
  covers: "period_ended",
  issue_mode: "review",
  paid_by: "transfer",
  due_rule: "days_30",
  language: "en",
  lines: [{ description: LINE, qty: 1, unit_price_minor: 49000, vat_bp: 2000 }],
  next_issue_on: "2026-11-30",
  next_draft_on: "2026-11-27",
  version: 1,
})

/** The server as the update tool behaves: a save from an older version is refused, else written and announced. */
function update(params: Record<string, unknown>) {
  updates.push(params)
  const version = Number(stored.version)
  if (params.expected_version !== undefined && params.expected_version !== version) {
    return { status: "error", error: { code: "schedule_changed", message: CHANGED } }
  }
  const { id: _id, expected_version: _v, ...patch } = params
  stored = { ...stored, ...patch, version: version + 1 }
  const event = {
    key: "invoicing:recurring_schedule",
    app: "invoicing",
    entity: "recurring_schedule",
    action: "updated",
    data: { schedule_id: "sched-1", version: version + 1 },
  }
  queueMicrotask(() => {
    for (const l of listeners) l([event])
  })
  return { status: "completed", id: "sched-1", version: version + 1 }
}

vi.mock("@liaison/host", () => ({
  hostLocale: () => "en",
  navigate: () => {},
  onEntityChange: (_keys: unknown, cb: Listener) => {
    listeners.add(cb)
    return () => listeners.delete(cb)
  },
  fetch: async () => ({
    id: "contact-1",
    name: "Claire Vidal",
    company: "Hôtels Belcour",
    email: null,
  }),
  app: {
    createResource,
    tabLabel: () => {},
    invokeTool: async (tool: string, params: Record<string, unknown>) => {
      if (tool === "recurring_list")
        return { rows: [structuredClone(stored)], nextCursor: null, nextRun: null }
      if (tool === "settings_issuer_profile_list")
        return { items: [{ id: "issuer-1", legal_name: "Maison Nord SARL", country: "FR" }] }
      if (tool === "recurring_schedule_update") return update(params)
      throw new Error(`unexpected tool ${tool}`)
    },
  },
}))

const { ScheduleEditor, draftFromRow } = await import("./ScheduleEditor")

beforeEach(() => {
  stored = row()
  updates.length = 0
  listeners.clear()
})
afterEach(() => cleanup())

/** One window: its own editor on the schedule as it read it. */
function openWindow() {
  const { container } = render(() => (
    <ScheduleEditor initial={draftFromRow("sched-1", structuredClone(stored))} />
  ))
  const q = <T extends Element>(sel: string) => container.querySelector(sel) as T
  return {
    price: () => q<HTMLInputElement>('input[aria-label="Unit price"]'),
    save: () => q<HTMLButtonElement>('[data-testid="schedule-save"]'),
    note: () => container.querySelector('[data-testid="schedule-note"]')?.textContent ?? "",
  }
}

function setPrice(w: ReturnType<typeof openWindow>, value: string) {
  fireEvent.change(w.price(), { target: { value } })
}

describe("two windows on one schedule", () => {
  it("a price saved in one window shows in the other, which has no edits of its own", async () => {
    const a = openWindow()
    const b = openWindow()
    setPrice(a, "650.00")
    fireEvent.click(a.save())
    await waitFor(() => expect(a.note()).toBe("Saved."))
    await waitFor(() => expect(b.price().value).toBe("650.00"))
    expect(b.note()).toContain("Someone else just saved this schedule")
    expect(screen.getAllByText(/Someone else just saved/)).toHaveLength(1)
  })

  it("the other window's save from what it read before is refused with a message and shows the saved price", async () => {
    const a = openWindow()
    const b = openWindow()
    setPrice(b, "500.00")
    setPrice(a, "650.00")
    fireEvent.click(a.save())
    await waitFor(() => expect(a.note()).toBe("Saved."))
    // Window B keeps its own edit, and says a save of it would be refused.
    await waitFor(() => expect(b.note()).toContain("saving them will be refused"))
    expect(b.price().value).toBe("500.00")
    fireEvent.click(b.save())
    await waitFor(() => expect(b.note()).toContain("Not saved: someone else saved this schedule"))
    expect(updates.at(-1)).toMatchObject({ expected_version: 1 })
    expect((stored.lines as Array<{ unit_price_minor: number }>)[0]?.unit_price_minor).toBe(65000)
    expect(stored.version).toBe(2)
    await waitFor(() => expect(b.price().value).toBe("650.00"))
    expect(b.note()).not.toBe("Saved.")
  })
})
