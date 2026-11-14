// SPDX-License-Identifier: FSL-1.1-ALv2
import { fireEvent, render, screen, waitFor } from "@solidjs/testing-library"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { BudgetLine } from "~/modules/projects/BudgetLine"
import { BudgetPanel } from "~/modules/projects/BudgetPanel"
import type { BudgetData, BudgetState } from "~/modules/projects/time-budgets"

const scopes = vi.hoisted(() => ({ granted: new Set<string>() }))
vi.mock("~/modules/auth/auth-store", async (importOriginal) => ({
  ...(await importOriginal<typeof import("~/modules/auth/auth-store")>()),
  hasScope: (s: string) => scopes.granted.has(s),
}))

const dockMock = vi.hoisted(() => ({ prefill: vi.fn(async (_text: string) => "dm-1") }))
vi.mock("~/modules/shell/dock-prefill", () => ({ dock: dockMock }))

const data = (over: Partial<BudgetData> = {}): BudgetData => ({
  projectId: "p1",
  projectName: "Maison Delorme",
  line: "346 h real against a 420 h timebox, 74 h left. Partial: real time entered on 41 of 46 tasks.",
  timebox: 25200,
  real: 20760,
  left: 4440,
  partial: true,
  coverage: { withEntries: 41, total: 46 },
  money: { price: 64000, currency: "EUR" },
  milestones: [
    { id: "m1", name: "Design", state: "done", plannedMinutes: 3120, realMinutes: 3000 },
  ],
  notInNumbers: [{ text: "2 h entered on archived tasks is not counted." }],
  datedHours: false,
  ...over,
})

const ready = (d: BudgetData): BudgetState => ({ status: "ready", data: d })

const panel = (state: BudgetState | undefined, extra: { api?: never } = {}) =>
  render(() => (
    <BudgetPanel
      api={(extra.api ?? ({ post: vi.fn(async () => ({})) } as never)) as never}
      projectId="p1"
      state={state}
      rail
      archived={false}
      onClose={() => {}}
      onPlanChanged={() => {}}
      onOff={() => {}}
    />
  ))

beforeEach(() => {
  scopes.granted = new Set(["projects:projects:write"])
})

const openTab = vi.hoisted(() => vi.fn())
vi.mock("~/modules/shell/tab-store", () => ({ openTab }))

describe("BudgetPanel", () => {
  it("opens the dated hours only with dated hours on and the sheet scope", () => {
    scopes.granted = new Set(["projects:projects:write", "projects:dated_sheet:read"])
    const off = panel(ready(data({ datedHours: false })))
    expect(screen.queryByTestId("budget-panel.open-sheet")).toBeNull()
    off.unmount()
    panel(ready(data({ datedHours: true })))
    fireEvent.click(screen.getByTestId("budget-panel.open-sheet"))
    expect(openTab).toHaveBeenCalledWith(
      expect.objectContaining({ type: "projects:timesheet", entityId: "p1" }),
    )
  })

  it("without money scope the panel shows hours only", () => {
    const { money: _price, ...hoursOnly } = data()
    panel(ready({ ...hoursOnly, state: "hours-only" }))
    expect(screen.getByTestId("budget-panel.hours-only")).toBeTruthy()
    expect(screen.queryByTestId("budget-panel.price")).toBeNull()
    expect(screen.getByTestId("budget-panel.real").textContent).toContain("346 h")
    expect(document.body.textContent).not.toMatch(/€|64/)
  })

  it("a holder of the money scope reads the price", () => {
    panel(ready(data()))
    expect(screen.getByTestId("budget-panel.price").textContent).toContain("64")
    expect(screen.queryByTestId("budget-panel.hours-only")).toBeNull()
  })

  it("a project billed by the day reads its rate, not that no price is set", () => {
    panel(ready(data({ money: { rate: 930, per: "day", currency: "EUR" } })))
    const rate = screen.getByTestId("budget-panel.rate").textContent ?? ""
    expect(rate).toContain("930")
    expect(rate).toContain("a day")
    expect(screen.queryByTestId("budget-panel.price")).toBeNull()
    expect(document.body.textContent).not.toContain("No price is set")
  })

  it("a partial figure always sits beside the coverage line", () => {
    panel(ready(data()))
    expect(screen.getByTestId("budget-panel.real").textContent).toContain("partial")
    expect(screen.getByTestId("budget-panel.left").textContent).toContain("partial")
    expect(screen.getByTestId("budget-panel.coverage").textContent).toBe(
      "Real time entered on 41 of 46 tasks.",
    )
  })

  it("a complete figure carries no partial word and no coverage line", () => {
    panel(ready(data({ partial: false, coverage: { withEntries: 46, total: 46 } })))
    expect(screen.getByTestId("budget-panel.real").textContent).not.toContain("partial")
    expect(screen.queryByTestId("budget-panel.coverage")).toBeNull()
  })

  it("going over reads as a plain number, not an alarm, and no person is named", () => {
    panel(ready(data({ real: 30000, left: -4800 })))
    const left = screen.getByTestId("budget-panel.left")
    expect(left.textContent).toContain("Over")
    expect(left.textContent).toContain("80 h")
    expect(left.className).not.toMatch(/warning|danger|red/)
    expect(screen.getByTestId("budget-panel.not-in").textContent).toContain("archived")
  })

  it("with no timebox it says there is nothing to compare", () => {
    const { timebox: _t, left: _l, ...rest } = data({ partial: false })
    panel(ready(rest))
    expect(screen.getByTestId("budget-panel.no-timebox")).toBeTruthy()
    expect(screen.queryByTestId("budget-panel.planned")).toBeNull()
  })

  it("the dated hours switch saves the plan and asks for the budget to be read again", async () => {
    const post = vi.fn(async () => ({ message: "saved" }))
    const onPlanChanged = vi.fn()
    render(() => (
      <BudgetPanel
        api={{ post } as never}
        projectId="p1"
        state={ready(data())}
        rail={false}
        archived={false}
        onClose={() => {}}
        onPlanChanged={onPlanChanged}
        onOff={() => {}}
      />
    ))
    fireEvent.click(screen.getByTestId("budget-panel.dated-switch"))
    await waitFor(() => expect(onPlanChanged).toHaveBeenCalled())
    expect(post).toHaveBeenCalledWith(
      "/apps/run-tool",
      {
        toolName: "projects:time_plan_set",
        params: { projectId: "p1", datedHours: true },
      },
      expect.anything(),
    )
  })

  it("the dated hours switch is read-only without the project write scope", () => {
    scopes.granted = new Set()
    panel(ready(data()))
    expect((screen.getByTestId("budget-panel.dated-switch") as HTMLInputElement).disabled).toBe(
      true,
    )
  })

  it("the rail keeps the dock clearance at its bottom", () => {
    panel(ready(data()))
    expect(screen.getByTestId("budget-panel").style.paddingBottom).toContain("--shell-dock-strip")
  })

  it("states: loading and error say so, and the error leaves the board alone", () => {
    const first = panel(undefined)
    expect(screen.getByTestId("budget-panel.loading")).toBeTruthy()
    first.unmount()
    panel({ status: "error" })
    expect(screen.getByTestId("budget-panel.load-error").textContent).toBe(
      "Could not work out this project's numbers. The board below is not affected.",
    )
  })
})

describe("BudgetLine", () => {
  const line = (state: BudgetState | undefined, onRetry = () => {}) =>
    render(() => (
      <BudgetLine state={state} panelOpen={false} onTogglePanel={() => {}} onRetry={onRetry} />
    ))

  it("is one plain line in the server's words, partial figure and coverage together", () => {
    line(ready(data()))
    expect(screen.getByTestId("budget-line.text").textContent).toContain(
      "Partial: real time entered on 41 of 46 tasks",
    )
  })

  it("an error keeps its sentence and offers a retry", () => {
    const retry = vi.fn()
    line({ status: "error" }, retry)
    expect(screen.getByTestId("budget-line.error").textContent).toContain("Could not work out")
    fireEvent.click(screen.getByTestId("budget-line.retry"))
    expect(retry).toHaveBeenCalled()
  })

  it("the ask box fills the chat's composer with the question and sends nothing", async () => {
    dockMock.prefill.mockClear()
    const post = vi.fn(async () => ({}))
    panel(ready(data()), { api: { post } as never })
    fireEvent.click(screen.getByTestId("budget-ask.suggest-0"))
    expect(dockMock.prefill).toHaveBeenCalledWith("Maison Delorme: Does the rest still fit?")
    const input = screen.getByTestId("budget-ask.input") as HTMLInputElement
    fireEvent.input(input, { target: { value: "  Is design over?  " } })
    fireEvent.click(screen.getByTestId("budget-ask.submit"))
    await waitFor(() =>
      expect(dockMock.prefill).toHaveBeenLastCalledWith("Maison Delorme: Is design over?"),
    )
    await waitFor(() => expect(input.value).toBe(""))
    expect(post).not.toHaveBeenCalled()
  })
})
