// SPDX-License-Identifier: FSL-1.1-ALv2
import { fireEvent, render, screen, waitFor } from "@solidjs/testing-library"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { TimeboxChip } from "~/modules/projects/TimeboxChip"
import { TookField } from "~/modules/projects/TookField"

type Call = { tool: string; params: Record<string, unknown> }

/** An api whose run-tool answers come from `answer`; every call is recorded. */
function fakeApi(answer: (call: Call) => unknown) {
  const calls: Call[] = []
  const api = {
    post: vi.fn(
      async (_path: string, body: { toolName: string; params: Record<string, unknown> }) => {
        const call = { tool: body.toolName.replace("projects:", ""), params: body.params }
        calls.push(call)
        return answer(call)
      },
    ),
  }
  return { api: api as never, calls }
}

const mine = (over: Record<string, unknown> = {}) => ({
  id: "e1",
  date: "2026-11-10",
  minutes: 120,
  enteredVia: "field",
  ...over,
})

beforeEach(() => vi.clearAllMocks())

describe("TookField", () => {
  it("neither the chip nor the field opens a dialog", async () => {
    const { api } = fakeApi((c) =>
      c.tool === "task_time_get" ? { mine: [], totalMinutes: 0 } : { totalMinutes: 60 },
    )
    render(() => (
      <>
        <TimeboxChip
          api={api}
          taskId="t1"
          minutes={null}
          disabled={false}
          onSaved={() => {}}
          onOff={() => {}}
        />
        <TookField
          totalMinutes={0}
          api={api}
          taskId="t1"
          datedHours={false}
          editable
          onOff={() => {}}
        />
      </>
    ))
    const chip = await screen.findByTestId("task-timebox-chip")
    fireEvent.click(chip)
    const timebox = await screen.findByTestId("task-timebox-input")
    fireEvent.focus(timebox)
    fireEvent.input(timebox, { target: { value: "3 days" } })
    fireEvent.keyDown(timebox, { key: "Enter" })
    const took = screen.getByTestId("task-took-input")
    fireEvent.focus(took)
    fireEvent.input(took, { target: { value: "1 h" } })
    fireEvent.keyDown(took, { key: "Enter" })
    await waitFor(() => expect(document.querySelector('[role="dialog"]')).toBeNull())
    expect(document.querySelector("dialog")).toBeNull()
  })

  it("an unreadable entry keeps the text and saves nothing", async () => {
    const { api, calls } = fakeApi(() => ({ mine: [], totalMinutes: 0 }))
    render(() => (
      <TookField
        totalMinutes={0}
        api={api}
        taskId="t1"
        datedHours={false}
        editable
        onOff={() => {}}
      />
    ))
    const input = (await screen.findByTestId("task-took-input")) as HTMLInputElement
    fireEvent.input(input, { target: { value: "a while" } })
    fireEvent.keyDown(input, { key: "Enter" })
    expect(input.value).toBe("a while")
    expect((await screen.findByTestId("task-took-error")).textContent).toBe(
      "Could not read this. Try 2 h, 1h30, half a day or 2 days.",
    )
    expect(input.title).toContain("Could not read this")
    expect(calls.filter((c) => c.tool === "task_time_set")).toHaveLength(0)
  })

  it("Enter and leaving the field save what was typed", async () => {
    const { api, calls } = fakeApi((c) =>
      c.tool === "task_time_get" ? { mine: [], totalMinutes: 0 } : { totalMinutes: 90 },
    )
    render(() => (
      <TookField
        totalMinutes={0}
        api={api}
        taskId="t1"
        datedHours={false}
        editable
        onOff={() => {}}
      />
    ))
    const input = (await screen.findByTestId("task-took-input")) as HTMLInputElement
    // Empty, the field reads as an example, never as time already entered.
    expect(input.value).toBe("")
    expect(input.placeholder).toBe("e.g. 2 h")
    fireEvent.input(input, { target: { value: "1h30" } })
    fireEvent.keyDown(input, { key: "Enter" })
    await waitFor(() =>
      expect(calls.filter((c) => c.tool === "task_time_set")).toEqual([
        { tool: "task_time_set", params: { taskId: "t1", time: "1h30" } },
      ]),
    )
    await waitFor(() => expect(calls.filter((c) => c.tool === "task_time_get")).toHaveLength(2))
    fireEvent.input(input, { target: { value: "2 h" } })
    fireEvent.blur(input)
    await waitFor(() => expect(calls.filter((c) => c.tool === "task_time_set")).toHaveLength(2))
  })

  it("shows only the viewer's own entry and the total, and says when an entry came through the coding agent", async () => {
    const { api } = fakeApi(() => ({
      mine: [mine({ enteredVia: "mcp" })],
      totalMinutes: 300,
    }))
    render(() => (
      <TookField
        api={api}
        taskId="t1"
        datedHours={false}
        editable
        totalMinutes={300}
        onOff={() => {}}
      />
    ))
    const input = (await screen.findByTestId("task-took-input")) as HTMLInputElement
    await waitFor(() => expect(input.value).toBe("2 h"))
    expect(screen.getByTestId("task-took-total").textContent).toBe("5 h so far")
    expect(screen.getByTestId("task-took-mcp").textContent).toBe("said through the coding agent")
  })

  it("a dated project adds a day to each entry and writes it for that day", async () => {
    const { api, calls } = fakeApi((c) =>
      c.tool === "task_time_get" ? { mine: [mine()], totalMinutes: 120 } : { totalMinutes: 180 },
    )
    render(() => (
      <TookField totalMinutes={0} api={api} taskId="t1" datedHours editable onOff={() => {}} />
    ))
    const date = await screen.findByTestId("task-took-date")
    fireEvent.input(date, { target: { value: "2026-11-10" } })
    const input = screen.getByTestId("task-took-input") as HTMLInputElement
    await waitFor(() => expect(input.value).toBe("2 h"))
    fireEvent.input(input, { target: { value: "3 h" } })
    fireEvent.keyDown(input, { key: "Enter" })
    await waitFor(() =>
      expect(calls.find((c) => c.tool === "task_time_set")?.params).toEqual({
        taskId: "t1",
        time: "3 h",
        date: "2026-11-10",
      }),
    )
  })

  it("a project that stopped using time and budgets is reported once and nothing is written", async () => {
    const onOff = vi.fn()
    const { api, calls } = fakeApi((c) =>
      c.tool === "task_time_get" ? { mine: [], totalMinutes: 0 } : { code: "planning_off" },
    )
    render(() => (
      <TookField totalMinutes={0} api={api} taskId="t1" datedHours={false} editable onOff={onOff} />
    ))
    const input = await screen.findByTestId("task-took-input")
    fireEvent.input(input, { target: { value: "1 h" } })
    fireEvent.keyDown(input, { key: "Enter" })
    await waitFor(() => expect(onOff).toHaveBeenCalledTimes(1))
    expect(calls.filter((c) => c.tool === "task_time_set")).toHaveLength(1)
  })

  it("without the write scope the field only reads", async () => {
    const { api } = fakeApi(() => ({ mine: [mine()], totalMinutes: 120 }))
    render(() => (
      <TookField
        totalMinutes={0}
        api={api}
        taskId="t1"
        datedHours={false}
        editable={false}
        onOff={() => {}}
      />
    ))
    const value = await screen.findByTestId("task-took-value")
    await waitFor(() => expect(value.textContent).toBe("2 h"))
    expect(screen.queryByTestId("task-took-input")).toBeNull()
  })
})

describe("TimeboxChip", () => {
  it("saves the size as typed and shows the minutes the server stored", async () => {
    const onSaved = vi.fn()
    const { api, calls } = fakeApi(() => ({ timeboxMinutes: 1260 }))
    render(() => (
      <TimeboxChip
        api={api}
        taskId="t1"
        minutes={null}
        disabled={false}
        onSaved={onSaved}
        onOff={() => {}}
      />
    ))
    expect(screen.getByTestId("task-timebox-chip").textContent).toBe("No timebox")
    fireEvent.click(screen.getByTestId("task-timebox-chip"))
    const input = await screen.findByTestId("task-timebox-input")
    fireEvent.input(input, { target: { value: "3 days" } })
    fireEvent.keyDown(input, { key: "Enter" })
    await waitFor(() => expect(onSaved).toHaveBeenCalledWith(1260))
    expect(calls).toEqual([{ tool: "update", params: { taskId: "t1", timebox: "3 days" } }])
  })

  it("unreadable text stays in the field with the sentence and saves nothing", async () => {
    const { api, calls } = fakeApi(() => ({ timeboxMinutes: 60 }))
    render(() => (
      <TimeboxChip
        api={api}
        taskId="t1"
        minutes={null}
        disabled={false}
        onSaved={() => {}}
        onOff={() => {}}
      />
    ))
    fireEvent.click(screen.getByTestId("task-timebox-chip"))
    const input = (await screen.findByTestId("task-timebox-input")) as HTMLInputElement
    fireEvent.input(input, { target: { value: "soon" } })
    fireEvent.blur(input)
    expect(input.value).toBe("soon")
    expect(screen.getByTestId("task-timebox-error").textContent).toContain("Could not read this")
    expect(calls).toHaveLength(0)
  })

  it("a disabled chip does not open", () => {
    const { api } = fakeApi(() => ({}))
    render(() => (
      <TimeboxChip
        api={api}
        taskId="t1"
        minutes={420}
        disabled
        onSaved={() => {}}
        onOff={() => {}}
      />
    ))
    fireEvent.click(screen.getByTestId("task-timebox-chip"))
    expect(screen.queryByTestId("task-timebox-input")).toBeNull()
  })
})
