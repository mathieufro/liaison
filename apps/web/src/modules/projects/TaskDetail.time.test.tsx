// SPDX-License-Identifier: FSL-1.1-ALv2
// The task page's Timebox chip and Took field exist only on a project using time and budgets.
import { cleanup, render, screen, waitFor } from "@solidjs/testing-library"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { resetChecklistStore } from "~/modules/projects/checklist-store"
import { type ProjectDetail, projectStore } from "~/modules/projects/project-store"
import { TaskDetail } from "~/modules/projects/TaskDetail"
import { forgetBudget } from "~/modules/projects/time-budgets"
import { ApiContext } from "~/modules/shell/ApiContext"

vi.mock("~/modules/projects/TaskDiscussion", () => ({
  default: () => <div data-testid="mock-task-discussion" />,
}))
vi.mock("~/modules/shell/tab-store", () => ({
  openTab: vi.fn(),
  closeTab: vi.fn(),
  makeTabId: (type: string, entityId: string) => `${type}:${entityId}`,
}))
vi.mock("~/modules/shell/toast-store", () => ({ addToast: vi.fn() }))
vi.mock("~/modules/projects/label-catalog-store", () => ({
  labelCatalog: { groups: [], loaded: true, loading: false, failed: false, liveGroups: () => [] },
  ensureLabelCatalog: vi.fn(async () => {}),
}))
vi.mock("~/modules/auth/auth-store", async (importOriginal) => ({
  ...(await importOriginal<typeof import("~/modules/auth/auth-store")>()),
  hasScope: () => true,
}))

const project = (over: Partial<ProjectDetail> = {}): ProjectDetail => ({
  id: "p1",
  name: "Maison Delorme",
  description: null,
  icon: null,
  color: null,
  ownerId: "u1",
  archivedAt: null,
  createdAt: "2026-05-06T09:00:00Z",
  updatedAt: "2026-05-06T09:00:00Z",
  statuses: [{ id: "s1", projectId: "p1", label: "Todo", color: null, order: 0, terminal: false }],
  ...over,
})

const task = {
  id: "t1",
  projectId: "p1",
  title: "Draft the quote",
  description: null,
  statusId: "s1",
  threadId: "thread-1",
  parentTaskId: null,
  assigneeId: null,
  assignee: null,
  priority: "normal",
  dueDate: null,
  startDate: null,
  blocked: false,
  createdBy: "u1",
  createdAt: "2026-05-06T09:00:00Z",
  updatedAt: "2026-05-06T09:00:00Z",
  childCount: 0,
}

const budget = {
  projectId: "p1",
  projectName: "Maison Delorme",
  line: "x",
  real: 0,
  partial: false,
  coverage: { withEntries: 0, total: 0 },
  milestones: [],
  notInNumbers: [],
  datedHours: false,
}

function apiFor(read: Record<string, unknown> = task) {
  const calls: string[] = []
  const api = {
    post: vi.fn(async (path: string, body: { toolName?: string; params?: unknown }) => {
      if (path === "/apps/tools/projects:get") return read
      const tool = body.toolName?.replace("projects:", "") ?? ""
      calls.push(tool)
      // The viewer's own entries only: the task's total comes with the task.
      if (tool === "task_time_get") return { mine: [], totalMinutes: 0 }
      if (tool === "update") return { ...task, timeboxMinutes: 1, realTotalMinutes: 1 }
      if (tool === "budget_get") return budget
      return {}
    }),
    get: vi.fn().mockResolvedValue({ id: "thread-1", hiddenFromList: true }),
    patch: vi.fn(),
    delete: vi.fn(),
    getEnvelope: vi.fn(),
  }
  return { api: api as never, calls }
}

const mount = (api: never) =>
  render(() => (
    <ApiContext.Provider value={api}>
      <TaskDetail entityId="t1" />
    </ApiContext.Provider>
  ))

beforeEach(() => {
  resetChecklistStore()
  projectStore._resetForTest()
  forgetBudget("p1")
})
afterEach(cleanup)

describe("TaskDetail time and budgets", () => {
  it("a task of a project that does not use it shows no timebox, no Took and reads no time", async () => {
    projectStore._setForTest({ projectId: "p1", current: project(), tasks: [] })
    const { api, calls } = apiFor()
    mount(api)
    await screen.findByTestId("task-detail.meta-row")
    expect(screen.queryByTestId("task-timebox-chip")).toBeNull()
    expect(screen.queryByTestId("task-took")).toBeNull()
    expect(calls).toEqual([])
  })

  it("a task of a project that uses it shows the chip and the total the task itself carries, with no write", async () => {
    projectStore._setForTest({
      projectId: "p1",
      current: project({ timeBudgets: true }),
      tasks: [],
    })
    const { api, calls } = apiFor({ ...task, timeboxMinutes: 600, realTotalMinutes: 90 })
    mount(api)
    await waitFor(() =>
      expect(screen.getByTestId("task-timebox-chip").textContent).toBe("Timebox 10 h"),
    )
    expect(screen.getByTestId("task-took")).toBeTruthy()
    await waitFor(() =>
      expect(screen.getByTestId("task-took-total").textContent).toBe("1 h 30 so far"),
    )
    expect(calls).not.toContain("update")
  })

  it("the chip and the field sit in the meta row", async () => {
    projectStore._setForTest({
      projectId: "p1",
      current: project({ timeBudgets: true }),
      tasks: [],
    })
    const { api } = apiFor({ ...task, timeboxMinutes: 600, realTotalMinutes: 90 })
    mount(api)
    const row = await screen.findByTestId("task-detail.meta-row")
    await waitFor(() => expect(row.contains(screen.getByTestId("task-timebox-chip"))).toBe(true))
    expect(row.contains(screen.getByTestId("task-took"))).toBe(true)
  })
})
