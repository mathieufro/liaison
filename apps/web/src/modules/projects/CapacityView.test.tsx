// SPDX-License-Identifier: FSL-1.1-ALv2
import { fireEvent, render, screen, waitFor } from "@solidjs/testing-library"
import { beforeEach, describe, expect, it, vi } from "vitest"

const answers = vi.hoisted(() => ({
  capacity: null as unknown,
  fail: false,
  candidates: [] as Array<{ userId: string; name: string }>,
  calls: [] as Array<{ tool: string; params: Record<string, unknown> }>,
}))
vi.mock("~/lib/run-tool", () => ({
  runTool: vi.fn(async (_api: unknown, tool: string, params: Record<string, unknown>) => {
    answers.calls.push({ tool, params })
    if (answers.fail) throw new Error("down")
    if (tool === "projects:capacity_move") {
      const back = params.toUserId === "Nadia"
      return {
        moved: true,
        task: { id: "t-Nadia", key: "MD-4", title: "Import retries" },
        from: back ? { userId: "Mathis", name: "Mathis" } : { userId: "Nadia", name: "Nadia" },
        to: back ? { userId: "Nadia", name: "Nadia" } : { userId: "Mathis", name: "Mathis" },
        told: back ? ["Nadia", "Mathis"] : ["Mathis", "Nadia"],
      }
    }
    if (params.taskId) return { ...(answers.capacity as object), candidates: answers.candidates }
    return answers.capacity
  }),
}))
vi.mock("~/modules/shell/toast-store", () => ({ addToast: vi.fn() }))
vi.mock("~/modules/shell/ApiContext", () => ({ useApi: () => ({}) }))
const prefill = vi.hoisted(() => vi.fn(async () => "t1"))
vi.mock("~/modules/shell/dock-prefill", () => ({ dock: { prefill } }))

import { CapacityView } from "~/modules/projects/CapacityView"

const person = (name: string, planned: number, available: number, note: string | null = null) => ({
  userId: name,
  name,
  plannedMinutes: planned,
  availableMinutes: available,
  note,
  tasks: [{ id: `t-${name}`, key: "MD-4", title: "Import retries", minutes: planned }],
})

beforeEach(() => {
  answers.fail = false
  answers.calls = []
  answers.candidates = [
    { userId: "Mathis", name: "Mathis" },
    { userId: "Nadia", name: "Nadia" },
  ]
  prefill.mockClear()
  answers.capacity = {
    week: "2026-W47",
    title: "Capacity, week 47",
    plannedMinutes: 900,
    availableMinutes: 1260,
    overLine: "1 person has more than fits",
    people: [
      person("Bastien", 1680, 1680),
      person("Mathis", 900, 2100),
      person("Nadia", 2640, 2100, "9 h more than fits"),
    ],
    left: [],
  }
})

describe("CapacityView", () => {
  it("people show in name order with no sort control", async () => {
    render(() => <CapacityView />)
    await waitFor(() => expect(screen.getAllByTestId("capacity-view.person")).toHaveLength(3))
    const names = screen
      .getAllByTestId("capacity-view.person")
      .map((li) => li.textContent?.match(/Bastien|Mathis|Nadia/)?.[0])
    expect(names).toEqual(["Bastien", "Mathis", "Nadia"])
    const view = screen.getByTestId("capacity-view")
    expect(view.querySelector("select, [role=combobox], [aria-sort], th")).toBeNull()
    expect(view.textContent).not.toMatch(/%/)
  })

  it("a person's day off shows only as a smaller number", async () => {
    answers.capacity = {
      ...(answers.capacity as object),
      people: [person("Ana", 0, 2100), person("Leo", 0, 1680)],
    }
    render(() => <CapacityView />)
    await waitFor(() => expect(screen.getAllByTestId("capacity-view.figures")).toHaveLength(2))
    const [ana, leo] = screen.getAllByTestId("capacity-view.figures").map((e) => e.textContent)
    expect(ana).toContain("of 35 h")
    expect(leo).toContain("of 28 h")
    expect(screen.queryByTestId("capacity-view.note")).toBeNull()
    expect(screen.getByTestId("capacity-view.people").textContent?.toLowerCase()).not.toMatch(
      /leave|absent|off|away/,
    )
  })

  it("a row opens onto its tasks and Who can take this? asks the agent without sending", async () => {
    render(() => <CapacityView />)
    const toggles = await screen.findAllByTestId("capacity-view.person-toggle")
    expect(screen.queryByTestId("capacity-view.tasks")).toBeNull()
    fireEvent.click(toggles[2] as HTMLElement)
    expect(screen.getAllByTestId("capacity-view.task")).toHaveLength(1)
    fireEvent.click(screen.getByTestId("capacity-view.who-can-take"))
    expect(prefill).toHaveBeenCalledWith("Who can take MD-4, Import retries?", expect.anything())
  })

  it("with nothing planned it says what capacity adds up", async () => {
    answers.capacity = { ...(answers.capacity as object), people: [], overLine: null }
    render(() => <CapacityView />)
    expect((await screen.findByTestId("capacity-view.no-timeboxes")).textContent).toContain(
      "No planned time on assigned work yet",
    )
  })

  it("a failed read says nothing was moved and offers a retry", async () => {
    answers.fail = true
    render(() => <CapacityView />)
    expect((await screen.findByTestId("capacity-view.error")).textContent).toContain(
      "No task was moved",
    )
    expect(screen.getByTestId("capacity-view.retry")).toBeTruthy()
  })

  it("the footnote says days off reduce what fits and the board carries no urgency colour", async () => {
    render(() => <CapacityView />)
    expect((await screen.findByTestId("capacity-view.footnote-days")).textContent).toBe(
      "Days off reduce what fits.",
    )
    expect(screen.getByTestId("capacity-view").innerHTML).not.toMatch(/text-(error|danger|warning)/)
  })

  it("opens on this week and reaches next week, with nothing to sort", async () => {
    render(() => <CapacityView />)
    fireEvent.click(await screen.findByTestId("capacity-view.next-week"))
    await waitFor(() =>
      expect(answers.calls.map((c) => c.params)).toEqual([{}, { week: "2026-W48" }]),
    )
    fireEvent.click(screen.getByTestId("capacity-view.this-week"))
    await waitFor(() => expect(answers.calls.at(-1)?.params).toEqual({}))
    expect(screen.getByTestId("capacity-view").innerHTML).not.toMatch(/sort/i)
  })

  it("Who can take this? offers Move to each person with the time, and the move tells both", async () => {
    render(() => <CapacityView />)
    const toggles = await screen.findAllByTestId("capacity-view.person-toggle")
    fireEvent.click(toggles[2] as HTMLElement)
    fireEvent.click(screen.getByTestId("capacity-view.who-can-take"))
    // The holder is never offered their own task; nobody is shown with a figure.
    const offers = await screen.findAllByTestId("capacity-view.move")
    expect(offers.map((b) => b.textContent)).toEqual(["Move to Mathis"])
    expect(screen.getByTestId("capacity-view.candidates").textContent).not.toMatch(/\d/)
    expect(answers.calls.at(-1)).toEqual({
      tool: "projects:capacity_get",
      params: { taskId: "t-Nadia", week: "2026-W47" },
    })
    fireEvent.click(offers[0] as HTMLElement)
    const line = await screen.findByTestId("capacity-view.moved")
    expect(answers.calls.find((c) => c.tool === "projects:capacity_move")?.params).toEqual({
      taskId: "t-Nadia",
      toUserId: "Mathis",
    })
    expect(line.textContent).toContain("MD-4 is now with Mathis. Mathis and Nadia were both told.")
    expect(line.textContent?.toLowerCase()).not.toContain("approv")
    // The line sits above the people, at the top of the board.
    const people = screen.getByTestId("capacity-view.people")
    expect(line.compareDocumentPosition(people) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    // Undo is the same move back.
    fireEvent.click(screen.getByTestId("capacity-view.undo"))
    await waitFor(() => expect(screen.queryByTestId("capacity-view.moved")).toBeNull())
    expect(
      answers.calls.filter((c) => c.tool === "projects:capacity_move").map((c) => c.params),
    ).toEqual([
      { taskId: "t-Nadia", toUserId: "Mathis" },
      { taskId: "t-Nadia", toUserId: "Nadia" },
    ])
  })

  it("when nobody has the time it says so and offers no move", async () => {
    answers.candidates = [{ userId: "Nadia", name: "Nadia" }]
    render(() => <CapacityView />)
    const toggles = await screen.findAllByTestId("capacity-view.person-toggle")
    fireEvent.click(toggles[2] as HTMLElement)
    fireEvent.click(screen.getByTestId("capacity-view.who-can-take"))
    expect((await screen.findByTestId("capacity-view.none-fits")).textContent).toContain(
      "Nobody has that much free planned time",
    )
    expect(screen.queryByTestId("capacity-view.move")).toBeNull()
  })
})
