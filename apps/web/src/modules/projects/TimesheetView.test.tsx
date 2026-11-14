// SPDX-License-Identifier: FSL-1.1-ALv2
import { fireEvent, render, screen, waitFor } from "@solidjs/testing-library"
import { beforeEach, describe, expect, it, vi } from "vitest"
import type { TimesheetData } from "~/modules/projects/TimesheetView"
import { TimesheetView } from "~/modules/projects/TimesheetView"

const tool = vi.hoisted(() => ({ calls: [] as Array<[string, Record<string, unknown>]> }))
const answers = vi.hoisted(() => ({ sheet: null as unknown, exports: [] as unknown[] }))
vi.mock("~/lib/run-tool", () => ({
  runTool: vi.fn(async (_api: unknown, name: string, params: Record<string, unknown>) => {
    tool.calls.push([name, params])
    if (name === "projects:timesheet_get") return answers.sheet
    return answers.exports.shift()
  }),
}))
vi.mock("~/modules/files/file-service", () => ({
  getDownloadUrl: vi.fn(async () => "about:blank"),
}))
vi.mock("~/modules/shell/ApiContext", () => ({ useApi: () => ({}) }))

const sheet = (over: Partial<TimesheetData> = {}): TimesheetData => ({
  projectId: "p1",
  projectName: "Maison Delorme",
  month: "2026-10",
  period: { from: "2026-10-01", to: "2026-10-31", label: "October 2026" },
  lines: [
    {
      entryId: "e1",
      date: "2026-10-01",
      person: "Ana",
      taskKey: "MD-1",
      task: "Brief",
      minutes: 180,
      hours: "3h",
    },
    {
      entryId: "e2",
      date: "2026-10-02",
      person: "Leo",
      taskKey: "MD-2",
      task: "Layouts",
      minutes: 240,
      hours: "4h",
    },
  ],
  totalMinutes: 420,
  total: "7h",
  coverage: { withEntries: 2, total: 2 },
  partial: false,
  coverageLine: "Real time entered on 2 of 2 tasks of October 2026.",
  note: "Not a legal working-time record, and it reminds nobody of anything.",
  ...over,
})

beforeEach(() => {
  tool.calls = []
  answers.sheet = sheet()
  answers.exports = []
  vi.spyOn(window, "open").mockImplementation(() => null)
})

describe("TimesheetView", () => {
  it("shows the lines, their total and the coverage line, read only, with the exports at the top", async () => {
    render(() => <TimesheetView entityId="p1" />)
    await waitFor(() => expect(screen.getAllByTestId("timesheet-view.line")).toHaveLength(2))
    expect(screen.getByTestId("timesheet-view.total").textContent).toContain("7h")
    expect(screen.getByTestId("timesheet-view.coverage").textContent).toBe(
      "Real time entered on 2 of 2 tasks of October 2026.",
    )
    expect(screen.getByTestId("timesheet-view.not").textContent).toBe(
      "Not a legal working-time record, and it reminds nobody of anything.",
    )
    const view = screen.getByTestId("timesheet-view")
    expect(view.querySelector("input, textarea, select, [contenteditable]")).toBeNull()
    const actions = screen.getByTestId("timesheet-view.actions")
    expect(actions.contains(screen.getByTestId("timesheet-view.export-pdf"))).toBe(true)
    expect(
      actions.compareDocumentPosition(screen.getByTestId("timesheet-view.lines")) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy()
  })

  it("a partial sheet asks once before it exports", async () => {
    answers.sheet = sheet({ partial: true, coverage: { withEntries: 1, total: 2 } })
    answers.exports = [{ needsConfirm: true }, { fileId: "f1", filename: "sheet.csv" }]
    render(() => <TimesheetView entityId="p1" />)
    await waitFor(() => screen.getByTestId("timesheet-view.export-csv"))
    fireEvent.click(screen.getByTestId("timesheet-view.export-csv"))
    await waitFor(() => screen.getByTestId("timesheet-view.confirm"))
    fireEvent.click(screen.getByTestId("timesheet-view.confirm-export"))
    await waitFor(() => screen.getByTestId("timesheet-view.saved"))
    const exports = tool.calls.filter(([n]) => n === "projects:timesheet_export")
    expect(exports.map(([, p]) => p.acceptPartial ?? false)).toEqual([false, true])
    expect(screen.queryByTestId("timesheet-view.confirm")).toBeNull()
  })

  it("someone who may not see the sheet reads that it is not theirs to see", async () => {
    answers.sheet = { error: { code: "not_allowed" } }
    render(() => <TimesheetView entityId="p1" />)
    await waitFor(() => screen.getByTestId("timesheet-view.no-access"))
    expect(screen.queryByTestId("timesheet-view.line")).toBeNull()
  })

  it("a project with dated hours off says how the sheet is turned on, not who may read it", async () => {
    answers.sheet = { error: { code: "dated_hours_off" } }
    render(() => <TimesheetView entityId="p1" />)
    const text = (await screen.findByTestId("timesheet-view.no-access")).textContent ?? ""
    expect(text).toContain("Dated hours are off on this project")
    expect(text).toContain("budget panel")
    expect(text).not.toContain("Only the project's lead and finance")
  })

  it("no cell is editable and lines add up to the total", async () => {
    render(() => <TimesheetView entityId="p1" />)
    await waitFor(() => expect(screen.getAllByTestId("timesheet-view.line")).toHaveLength(2))
    const view = screen.getByTestId("timesheet-view")
    expect(view.querySelector("input, textarea, select, [contenteditable]")).toBeNull()
    const sum = (answers.sheet as TimesheetData).lines.reduce((n, l) => n + l.minutes, 0)
    expect(sum).toBe((answers.sheet as TimesheetData).totalMinutes)
    expect(screen.getByTestId("timesheet-view.total").textContent).toContain("7h")
  })

  it("a viewer without access sees the no-access state", async () => {
    answers.sheet = { error: { code: "not_allowed" } }
    render(() => <TimesheetView entityId="p1" />)
    expect((await screen.findByTestId("timesheet-view.no-access")).textContent).toContain(
      "Only the project's lead and finance",
    )
    expect(screen.queryByTestId("timesheet-view.actions")).toBeNull()
  })
})
