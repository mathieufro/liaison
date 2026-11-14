// SPDX-License-Identifier: FSL-1.1-ALv2
import { fireEvent, render, waitFor } from "@solidjs/testing-library"
import { createSignal } from "solid-js"
import { afterEach, describe, expect, it, vi } from "vitest"
import { ApiError } from "~/lib/api-error"
import { formatDay } from "~/lib/relative-time"
import { I18nProvider } from "~/modules/i18n/i18n-context"
import type { BoardColumn, BoardDeal, CurrencySum, DealBoard } from "~/modules/projects/deal-api"
import { dndState } from "~/modules/projects/dnd-state"
import { ProjectKanbanView } from "~/modules/projects/ProjectKanbanView"
import { type ProjectStatus, projectStore, type Task } from "~/modules/projects/project-store"
import type { TaskLabel } from "~/modules/projects/task-labels"
import { resetToastStore, toasts } from "~/modules/shell/toast-store"

// catalog order Nature, Domain, Team (pinned store shape of task 10).
const labelOrder = vi.hoisted(() => ["g-nature", "g-domain", "g-team"])
// Value id → archived, as the catalog knows it (empty: the catalog knows no value).
const catalogArchived = vi.hoisted(() => new Map<string, boolean>())
const catalogState = vi.hoisted(() => ({ loaded: true, failed: false }))
vi.mock("~/modules/projects/label-catalog-store", () => ({
  labelCatalog: {
    groups: [],
    get loaded() {
      return catalogState.loaded
    },
    loading: false,
    get failed() {
      return catalogState.failed
    },
    liveGroups: () => [],
    groupOrder: () => labelOrder,
    group: () => undefined,
    value: () => undefined,
    displayName: (e: {
      groupName: string
      valueName: string
      valueId: string
      archived: boolean
    }) => ({
      groupName: e.groupName,
      valueName: e.valueName,
      archived: catalogArchived.get(e.valueId) ?? e.archived,
    }),
  },
  ensureLabelCatalog: vi.fn(async () => {}),
  loadLabelCatalog: vi.fn(async () => {}),
  handleLabelEvent: vi.fn(),
  resetLabelCatalogStore: vi.fn(),
}))

function makeStatus(i: number): ProjectStatus {
  return {
    id: `s${i}`,
    projectId: "p1",
    label: `S${i}`,
    color: null,
    order: i,
    terminal: false,
  }
}

describe("ProjectKanbanView", () => {
  it("projects.kanban.auto-degrade", () => {
    // Phase 8 review contract: keep PM-tool-width columns and allow
    // horizontal scroll. Only degrade when fewer than two columns fit.
    const tenStatuses = Array.from({ length: 10 }, (_, i) => makeStatus(i))
    const { getByTestId } = render(() => (
      <ProjectKanbanView statuses={tenStatuses} workspaceWidth={480} />
    ))
    expect(getByTestId("status-grouped-vertical")).toBeTruthy()
  })

  it("projects.kanban.default-five-statuses-render-with-horizontal-scroll", () => {
    const fiveStatuses = Array.from({ length: 5 }, (_, i) => makeStatus(i))
    const { getByTestId } = render(() => (
      <ProjectKanbanView statuses={fiveStatuses} workspaceWidth={732} />
    ))
    const board = getByTestId("project-kanban-board")
    expect(board).toBeTruthy()
    expect(board.className).toContain("overflow-x-auto")
  })

  it("renders the kanban board when there is enough room for all columns", () => {
    const fourStatuses = Array.from({ length: 4 }, (_, i) => makeStatus(i))
    const { getByTestId, queryByTestId } = render(() => (
      <ProjectKanbanView statuses={fourStatuses} workspaceWidth={1200} />
    ))
    expect(getByTestId("project-kanban-board")).toBeTruthy()
    expect(queryByTestId("status-grouped-vertical")).toBeNull()
  })

  it("renders the task key on each card", () => {
    const fourStatuses = Array.from({ length: 4 }, (_, i) => makeStatus(i))
    const task: Task = {
      id: "t1",
      number: 12,
      key: "ERB-12",
      projectId: "p1",
      parentTaskId: null,
      statusId: "s0",
      title: "First task",
      description: null,
      assigneeId: null,
      priority: "normal",
      dueDate: null,
      startDate: null,
      position: 1,
      blocked: false,
      completedAt: null,
      threadId: "thread-1",
      createdBy: "u1",
      createdAt: "2026-05-01T00:00:00.000Z",
      updatedAt: "2026-05-01T00:00:00.000Z",
    }
    const { getByTestId } = render(() => (
      <ProjectKanbanView statuses={fourStatuses} tasks={[task]} workspaceWidth={1200} />
    ))
    expect(getByTestId("project-kanban-card").textContent).toContain("ERB-12")
  })

  it("column headers render pretty status labels", () => {
    const statuses: ProjectStatus[] = [
      { id: "s0", projectId: "p1", label: "backlog", color: null, order: 0, terminal: false },
      { id: "s1", projectId: "p1", label: "in_progress", color: null, order: 1, terminal: false },
      { id: "s2", projectId: "p1", label: "done", color: null, order: 2, terminal: true },
      { id: "s3", projectId: "p1", label: "cancelled", color: null, order: 3, terminal: true },
    ]
    const { getAllByTestId } = render(() => (
      <ProjectKanbanView statuses={statuses} workspaceWidth={1200} />
    ))
    const headers = getAllByTestId("project-kanban-column-header")
    expect(headers.map((h) => h.textContent)).toEqual([
      "Backlog",
      "In progress",
      "Done",
      "Cancelled",
    ])
    expect(headers.some((h) => h.textContent === "IN_PROGRESS")).toBe(false)
  })

  it("renders the due date chip on cards", () => {
    const fourStatuses = Array.from({ length: 4 }, (_, i) => makeStatus(i))
    const overdue = new Date()
    overdue.setUTCDate(overdue.getUTCDate() - 1)
    const task: Task = {
      id: "t1",
      number: 12,
      key: "ERB-12",
      projectId: "p1",
      parentTaskId: null,
      statusId: "s0",
      title: "First task",
      description: null,
      assigneeId: null,
      priority: "normal",
      dueDate: overdue.toISOString().slice(0, 10),
      startDate: null,
      position: 1,
      blocked: false,
      completedAt: null,
      threadId: "thread-1",
      createdBy: "u1",
      createdAt: "2026-05-01T00:00:00.000Z",
      updatedAt: "2026-05-01T00:00:00.000Z",
    }
    const { getByTestId } = render(() => (
      <ProjectKanbanView statuses={fourStatuses} tasks={[task]} workspaceWidth={1200} />
    ))
    const chip = getByTestId("project-kanban-card.due-date")
    // A day in the reader's words ("Jul 5"), never the raw "07-05" slice.
    const day = overdue.toISOString().slice(0, 10)
    expect(chip.textContent).toBe(formatDay(day, "en"))
    expect(chip.textContent).not.toMatch(/^\d{2}-\d{2}$/)
    expect(chip.className).toContain("text-danger")
  })

  it("a French board names due days in French", () => {
    const task = {
      id: "t2",
      number: 13,
      key: "ERB-13",
      projectId: "p1",
      parentTaskId: null,
      statusId: "s0",
      title: "Deadline",
      description: null,
      assigneeId: null,
      priority: "normal",
      dueDate: "2026-09-30",
      startDate: null,
      position: 1,
      blocked: false,
      completedAt: null,
      threadId: "thread-2",
      createdBy: "u1",
      createdAt: "2026-05-01T00:00:00.000Z",
      updatedAt: "2026-05-01T00:00:00.000Z",
    } as Task
    const statuses = Array.from({ length: 4 }, (_, i) => makeStatus(i))
    const { getByTestId } = render(() => (
      <I18nProvider initialLocale="fr">
        <ProjectKanbanView statuses={statuses} tasks={[task]} workspaceWidth={1200} />
      </I18nProvider>
    ))
    const chip = getByTestId("project-kanban-card.due-date")
    expect(chip.textContent).toBe("30 sept.")
    expect(chip.getAttribute("title")).toBe("Échéance : 30 septembre 2026")
  })

  it("projects.kanban.a-column-is-renamed-from-its-own-header", async () => {
    // The Statuses dialog could already rename, but nobody found it: "there is
    // no way to rename the category". The header's pencil (or a double-click)
    // sends the same PATCH the dialog does.
    const patch = vi.fn().mockResolvedValue(undefined)
    const api = { patch, post: vi.fn(), get: vi.fn(), delete: vi.fn(), getEnvelope: vi.fn() } as any
    const statuses = Array.from({ length: 3 }, (_, i) => makeStatus(i))
    const { getAllByTestId, getByTestId, queryByTestId } = render(() => (
      <ProjectKanbanView statuses={statuses} workspaceWidth={1200} projectId="p1" api={api} />
    ))
    fireEvent.click(getAllByTestId("project-kanban-column-rename")[1]!)
    const input = getByTestId("project-kanban-column-rename-input") as HTMLInputElement
    expect(input.value).toBe("S1")
    fireEvent.input(input, { target: { value: "In discussion" } })
    fireEvent.keyDown(input, { key: "Enter" })
    await waitFor(() =>
      expect(patch).toHaveBeenCalledWith("/projects/p1/statuses/s1", { label: "In discussion" }),
    )
    await waitFor(() => expect(queryByTestId("project-kanban-column-rename-input")).toBeNull())

    // Escape abandons the edit without a request.
    fireEvent.dblClick(getAllByTestId("project-kanban-column-header")[0]!.parentElement!)
    const again = getByTestId("project-kanban-column-rename-input") as HTMLInputElement
    fireEvent.input(again, { target: { value: "nope" } })
    fireEvent.keyDown(again, { key: "Escape" })
    expect(queryByTestId("project-kanban-column-rename-input")).toBeNull()
    expect(patch).toHaveBeenCalledTimes(1)
  })

  it("projects.kanban.rename-is-hidden-on-an-archived-board", () => {
    const api = { patch: vi.fn() } as any
    const statuses = Array.from({ length: 3 }, (_, i) => makeStatus(i))
    const { queryAllByTestId } = render(() => (
      <ProjectKanbanView
        statuses={statuses}
        workspaceWidth={1200}
        projectId="p1"
        api={api}
        disabled
      />
    ))
    expect(queryAllByTestId("project-kanban-column-rename")).toHaveLength(0)
  })

  describe("checklist", () => {
    const boardStatuses: ProjectStatus[] = [
      { id: "s0", projectId: "p1", label: "in_progress", color: null, order: 0, terminal: false },
      { id: "s1", projectId: "p1", label: "done", color: null, order: 1, terminal: true },
    ]

    function makeTask(over: Partial<Task> = {}): Task {
      return {
        id: "t1",
        number: 12,
        key: "ROAD-12",
        projectId: "p1",
        parentTaskId: null,
        statusId: "s0",
        title: "Arpeggiator",
        description: null,
        assigneeId: null,
        priority: "normal",
        dueDate: null,
        startDate: null,
        position: 1,
        blocked: false,
        completedAt: null,
        threadId: "thread-1",
        createdBy: "u1",
        createdAt: "2026-05-01T00:00:00.000Z",
        updatedAt: "2026-05-01T00:00:00.000Z",
        ...over,
      }
    }

    function makeApi(post: ReturnType<typeof vi.fn>) {
      return { post, patch: vi.fn(), get: vi.fn(), delete: vi.fn(), getEnvelope: vi.fn() } as any
    }

    function dropOnColumn(column: HTMLElement, taskId: string, fromStatusId: string) {
      const payload = JSON.stringify({ taskId, fromStatusId })
      fireEvent.drop(column, {
        dataTransfer: {
          getData: (type: string) => (type === "application/x-liaison-task" ? payload : ""),
        },
      })
    }

    function columnOf(container: HTMLElement, statusId: string): HTMLElement {
      return container.querySelector(
        `[data-testid="project-kanban-column"][data-status-id="${statusId}"]`,
      ) as HTMLElement
    }

    afterEach(() => {
      resetToastStore()
      projectStore._resetForTest()
    })

    it("projects.checklist.card.release-chip-and-counters-after-the-title", () => {
      const task = makeTask({
        release: "2.1.0",
        checklist: {
          total: 4,
          complete: 2,
          failing: 1,
          blocking: [],
          perLevel: [
            { levelId: "a", name: "AI", applicable: 4, success: 4, fail: 0 },
            { levelId: "d", name: "Dev", applicable: 4, success: 2, fail: 1 },
          ],
        },
      })
      const { getByTestId } = render(() => (
        <ProjectKanbanView statuses={boardStatuses} tasks={[task]} workspaceWidth={1200} />
      ))
      const chip = getByTestId("project-kanban-card.release")
      expect(chip.textContent).toBe("2.1.0")
      expect(chip.className).toContain("font-mono")
      expect(getByTestId("checklist-counters").textContent).toBe("AI 4/4 · Dev 2/4")
    })

    it("projects.checklist.card.no-release-no-checklist-shows-neither", () => {
      const { queryByTestId } = render(() => (
        <ProjectKanbanView statuses={boardStatuses} tasks={[makeTask()]} workspaceWidth={1200} />
      ))
      expect(queryByTestId("project-kanban-card.release")).toBeNull()
      expect(queryByTestId("checklist-counters")).toBeNull()
    })

    const checklistOf = (): NonNullable<Task["checklist"]> => ({
      total: 3,
      complete: 1,
      failing: 0,
      blocking: [
        { itemId: "i2", title: "Two", levels: [] },
        { itemId: "i3", title: "Three", levels: [] },
      ],
      perLevel: [],
    })

    function seedProject(checklistOnCards?: boolean) {
      projectStore._setForTest({
        projectId: "p1",
        current: {
          id: "p1",
          name: "Roadmap",
          description: null,
          icon: null,
          color: null,
          ownerId: "u1",
          archivedAt: null,
          createdAt: "",
          updatedAt: "",
          statuses: boardStatuses,
          ...(checklistOnCards === undefined ? {} : { checklistOnCards }),
        },
      })
    }

    it("projects.checklist.move.incomplete-checklist-drops-on-done-with-no-toast", async () => {
      seedProject()
      const [tasks, setTasks] = createSignal<Task[]>([makeTask({ checklist: checklistOf() })])
      // The server accepts the move; the board follows its task event.
      const post = vi.fn().mockImplementation(async (_path: string, body: { statusId: string }) => {
        setTasks((list) => list.map((t) => ({ ...t, statusId: body.statusId })))
        return {}
      })
      const { container } = render(() => (
        <ProjectKanbanView
          statuses={boardStatuses}
          tasks={tasks()}
          workspaceWidth={1200}
          projectId="p1"
          api={makeApi(post)}
        />
      ))
      dropOnColumn(columnOf(container, "s1"), "t1", "s0")
      await waitFor(() =>
        expect(columnOf(container, "s1").querySelector('[data-task-id="t1"]')).not.toBeNull(),
      )
      expect(post).toHaveBeenCalledWith("/projects/p1/tasks/t1/move", { statusId: "s1" })
      expect(toasts()).toHaveLength(0)
      const card = columnOf(container, "s1").querySelector('[data-task-id="t1"]') as HTMLElement
      expect(card.querySelector('[data-testid="checklist-counters"]')?.textContent).toBe("1/3")
    })

    it("projects.checklist.move.any-failure-shows-the-generic-toast-without-action", async () => {
      const post = vi
        .fn()
        .mockRejectedValue(new ApiError("x", 409, "checklist_incomplete", undefined, {}))
      const { container } = render(() => (
        <ProjectKanbanView
          statuses={boardStatuses}
          tasks={[makeTask()]}
          workspaceWidth={1200}
          projectId="p1"
          api={makeApi(post)}
        />
      ))
      dropOnColumn(columnOf(container, "s1"), "t1", "s0")
      await waitFor(() => expect(toasts()).toHaveLength(1))
      expect(toasts()[0]!.message).toBe("Could not move the task.")
      expect(toasts()[0]!.action).toBeUndefined()
      expect(columnOf(container, "s0").querySelector('[data-task-id="t1"]')).not.toBeNull()
    })

    it("projects.checklist.card.option-off-hides-counters-and-keeps-the-release-chip", () => {
      seedProject(false)
      const { getByTestId, queryByTestId } = render(() => (
        <ProjectKanbanView
          statuses={boardStatuses}
          tasks={[makeTask({ release: "2.1.0", checklist: checklistOf() })]}
          workspaceWidth={1200}
          projectId="p1"
        />
      ))
      expect(getByTestId("project-kanban-card.release").textContent).toBe("2.1.0")
      expect(queryByTestId("checklist-counters")).toBeNull()
    })

    it("projects.checklist.card.option-follows-the-project-live", async () => {
      seedProject(true)
      const { queryByTestId } = render(() => (
        <ProjectKanbanView
          statuses={boardStatuses}
          tasks={[makeTask({ checklist: checklistOf() })]}
          workspaceWidth={1200}
          projectId="p1"
        />
      ))
      expect(queryByTestId("checklist-counters")?.textContent).toBe("1/3")
      projectStore.handleProjectEvent("updated", { id: "p1", checklistOnCards: false })
      await waitFor(() => expect(queryByTestId("checklist-counters")).toBeNull())
    })
  })
})

describe("ProjectKanbanView label chips", () => {
  const statuses: ProjectStatus[] = [
    { id: "s0", projectId: "p1", label: "todo", color: null, order: 0, terminal: false },
  ]
  const GROUP_NAMES: Record<string, string> = {
    "g-nature": "Nature",
    "g-domain": "Domain",
    "g-team": "Team",
  }

  function label(groupId: string, valueName: string, over: Partial<TaskLabel> = {}): TaskLabel {
    return {
      groupId,
      groupName: GROUP_NAMES[groupId] ?? groupId,
      groupArchived: false,
      valueId: `v-${valueName}`,
      valueName,
      archived: false,
      inherited: false,
      inheritedFromKey: null,
      ...over,
    }
  }

  function card(over: Partial<Task>): Task {
    return {
      id: "t1",
      number: 1,
      key: "PRJ-1",
      projectId: "p1",
      parentTaskId: null,
      statusId: "s0",
      title: "Card",
      description: null,
      assigneeId: null,
      priority: "normal",
      dueDate: null,
      startDate: null,
      position: 1,
      blocked: false,
      completedAt: null,
      threadId: "thread-1",
      createdBy: "u1",
      createdAt: "2026-05-01T00:00:00.000Z",
      updatedAt: "2026-05-01T00:00:00.000Z",
      ...over,
    }
  }

  afterEach(() => {
    projectStore._resetForTest()
    catalogArchived.clear()
    catalogState.loaded = true
    catalogState.failed = false
  })

  it("the (archived) mark on a card follows the catalog, not the task payload", () => {
    catalogArchived.set("v-bug", true)
    catalogArchived.set("v-evolution", false)
    const { getAllByTestId } = render(() => (
      <I18nProvider initialLocale="en">
        <ProjectKanbanView
          statuses={statuses}
          tasks={[
            card({
              labels: [
                label("g-nature", "bug"),
                label("g-domain", "evolution", { archived: true }),
              ],
            }),
          ]}
          workspaceWidth={1200}
        />
      </I18nProvider>
    ))
    const chips = getAllByTestId("project-kanban-card.label")
    expect(chips.map((c) => c.textContent)).toEqual(["bug (archived)", "evolution"])
    expect(chips.map((c) => c.getAttribute("data-archived"))).toEqual(["true", "false"])
  })

  it("a failed catalog load still shows the chips from the task payload", () => {
    catalogState.loaded = false
    catalogState.failed = true
    const { getAllByTestId } = render(() => (
      <I18nProvider initialLocale="en">
        <ProjectKanbanView
          statuses={statuses}
          tasks={[card({ labels: [label("g-nature", "bug"), label("g-domain", "security")] })]}
          workspaceWidth={1200}
        />
      </I18nProvider>
    ))
    expect(getAllByTestId("project-kanban-card.label").map((c) => c.textContent)).toEqual([
      "bug",
      "security",
    ])
  })

  it("shows the first two effective labels in catalog order, then +n", () => {
    const task = card({
      labels: [label("g-team", "core"), label("g-nature", "bug"), label("g-domain", "security")],
    })
    const { getAllByTestId, getByTestId } = render(() => (
      <I18nProvider initialLocale="en">
        <ProjectKanbanView statuses={statuses} tasks={[task]} workspaceWidth={1200} />
      </I18nProvider>
    ))
    expect(getAllByTestId("project-kanban-card.label").map((c) => c.textContent)).toEqual([
      "bug",
      "security",
    ])
    expect(getAllByTestId("project-kanban-card.label")[0]?.getAttribute("title")).toBe(
      "Nature: bug",
    )
    const more = getByTestId("project-kanban-card.labels-more")
    expect(more.textContent).toBe("+1")
    expect(more.getAttribute("title")).toContain("Team")
  })

  it("a card without labels shows no chip", () => {
    const { queryAllByTestId, queryByTestId } = render(() => (
      <I18nProvider initialLocale="en">
        <ProjectKanbanView
          statuses={statuses}
          tasks={[card({ labels: [] })]}
          workspaceWidth={1200}
        />
      </I18nProvider>
    ))
    expect(queryAllByTestId("project-kanban-card.label")).toHaveLength(0)
    expect(queryByTestId("project-kanban-card.labels-more")).toBeNull()
  })

  it("a parent's update changes its child's chip without a refetch", async () => {
    const parent = card({ id: "P", key: "PRJ-1", labels: [label("g-nature", "bug")] })
    const child = card({
      id: "C",
      key: "PRJ-2",
      parentTaskId: "P",
      position: 2,
      labels: [label("g-nature", "evolution", { inherited: true, inheritedFromKey: "PRJ-1" })],
    })
    projectStore._setForTest({ projectId: "p1", tasks: [parent, child] })
    const api = { get: vi.fn(), post: vi.fn(), patch: vi.fn() } as any
    const { getAllByTestId } = render(() => (
      <I18nProvider initialLocale="en">
        <ProjectKanbanView
          statuses={statuses}
          tasks={projectStore.tasksFor("p1")}
          projectId="p1"
          api={api}
          workspaceWidth={1200}
        />
      </I18nProvider>
    ))
    const childChip = () =>
      getAllByTestId("project-kanban-card")
        .find((c) => c.textContent?.includes("PRJ-2"))
        ?.querySelector("[data-testid='project-kanban-card.label']")
    expect(childChip()?.textContent).toBe("bug")
    expect(childChip()?.getAttribute("data-inherited")).toBe("true")

    projectStore.handleTaskEvent("updated", {
      ...parent,
      labels: [label("g-nature", "maintenance")],
      updatedAt: "2026-05-02T00:00:00.000Z",
    })
    await waitFor(() => expect(childChip()?.textContent).toBe("maintenance"))
    expect(api.get).not.toHaveBeenCalled()
  })
})

describe("ProjectKanbanView on a sales pipeline", () => {
  const stages: ProjectStatus[] = [
    { id: "lead", projectId: "p1", label: "Lead", color: null, order: 0, terminal: false },
    { id: "proposal", projectId: "p1", label: "Proposal", color: null, order: 1, terminal: false },
    { id: "won", projectId: "p1", label: "Won", color: null, order: 2, terminal: true },
    { id: "lost", projectId: "p1", label: "Lost", color: null, order: 3, terminal: true },
  ]

  function deal(over: Partial<BoardDeal> & { taskId: string }): BoardDeal {
    return {
      key: `SALES-${over.taskId}`,
      title: `Deal ${over.taskId}`,
      assigneeId: null,
      companyId: "c1",
      companyName: "Maison Arlon",
      contactId: null,
      nextStep: null,
      closedAt: null,
      quietDays: null,
      ...over,
    }
  }

  function board(withAccess: boolean, openDeals: BoardDeal[] = []): DealBoard {
    const column = (
      statusId: string,
      label: string,
      dealOutcome: "won" | "lost" | null,
      deals: BoardDeal[],
      sums: CurrencySum[],
    ): BoardColumn => ({
      statusId,
      label,
      dealOutcome,
      count: deals.length,
      deals,
      ...(withAccess ? { sums } : {}),
    })
    return {
      projectId: "p1",
      timeZone: "Europe/Paris",
      closedMonth: "2026-11",
      columns: [
        column("lead", "Lead", null, openDeals, [
          { currency: "EUR", sum_minor: 1_230_000 },
          { currency: "USD", sum_minor: 200_000 },
        ]),
        column("proposal", "Proposal", null, [], []),
        column("won", "Won", "won", [], []),
        column("lost", "Lost", "lost", [], []),
      ],
    }
  }

  function makeApi(post: ReturnType<typeof vi.fn>) {
    return { post, patch: vi.fn(), get: vi.fn(), delete: vi.fn(), getEnvelope: vi.fn() } as any
  }

  function columnOf(container: HTMLElement, statusId: string): HTMLElement {
    return container.querySelector(
      `[data-testid="project-kanban-column"][data-status-id="${statusId}"]`,
    ) as HTMLElement
  }

  function dropOnColumn(column: HTMLElement, taskId: string, fromStatusId: string) {
    const payload = JSON.stringify({ taskId, fromStatusId })
    fireEvent.drop(column, {
      dataTransfer: {
        getData: (type: string) => (type === "application/x-liaison-task" ? payload : ""),
      },
    })
  }

  afterEach(() => {
    resetToastStore()
  })

  it("a column shows one sum per currency and none without deal access", () => {
    const withAccess = board(true, [
      deal({
        taskId: "1",
        amount: { amountMinor: 1_230_000, currency: "EUR", amountPeriod: "year" },
      }),
    ])
    const first = render(() => (
      <ProjectKanbanView
        statuses={stages}
        workspaceWidth={1400}
        projectId="p1"
        api={makeApi(vi.fn())}
        pipeline={{ board: withAccess, onChanged: vi.fn() }}
      />
    ))
    const sum = columnOf(first.container, "lead").querySelector('[data-testid="deal-column.sum"]')
    // Two currencies: two sums, never one added total.
    expect(sum?.textContent).toContain("12,300")
    expect(sum?.textContent).toContain("2,000")
    expect(sum?.textContent).toContain("·")
    expect(
      columnOf(first.container, "proposal").querySelector('[data-testid="deal-column.sum"]'),
    ).toBeNull()
    expect(
      columnOf(first.container, "won").querySelector('[data-testid="project-kanban-column-header"]')
        ?.textContent,
    ).toBe("Won this month")
    first.unmount()

    const without = board(false, [deal({ taskId: "1" })])
    const second = render(() => (
      <ProjectKanbanView
        statuses={stages}
        workspaceWidth={1400}
        projectId="p1"
        api={makeApi(vi.fn())}
        pipeline={{ board: without, onChanged: vi.fn() }}
      />
    ))
    expect(second.container.querySelector('[data-testid="deal-column.sum"]')).toBeNull()
    expect(second.getByTestId("deal-card.amount").textContent).toBe("Needs deal access")
  })

  it("open columns keep the board's order, quietest first and no quiet line when quiet is unknown", () => {
    const b = board(true, [
      deal({ taskId: "9", quietDays: 9, nextStep: "send pricing", assigneeId: "u1" }),
      deal({ taskId: "3", quietDays: 3 }),
      deal({ taskId: "0", quietDays: null }),
    ])
    const { container } = render(() => (
      <ProjectKanbanView
        statuses={stages}
        workspaceWidth={1400}
        projectId="p1"
        api={makeApi(vi.fn())}
        pipeline={{
          board: b,
          memberName: (id) => (id === "u1" ? "Tom Reyes" : null),
          onChanged: vi.fn(),
        }}
      />
    ))
    const cards = [
      ...columnOf(container, "lead").querySelectorAll('[data-testid="project-kanban-card"]'),
    ] as HTMLElement[]
    expect(cards.map((c) => c.dataset.taskId)).toEqual(["9", "3", "0"])
    expect(cards[0]!.querySelector('[data-testid="deal-card.quiet"]')?.textContent).toBe(
      "Quiet for 9 days",
    )
    expect(cards[0]!.querySelector('[data-testid="deal-card.owner"]')?.textContent).toBe("TR")
    expect(cards[0]!.querySelector('[data-testid="deal-card.next-step"]')?.textContent).toBe(
      "Next: send pricing",
    )
    expect(cards[0]!.querySelector('[data-testid="deal-card.amount"]')?.textContent).toBe(
      "No amount",
    )
    // Unknown quiet: no line at all, never "Quiet for 0 days".
    expect(cards[2]!.querySelector('[data-testid="deal-card.quiet"]')).toBeNull()
  })

  it("a move to Lost shows the note with an optional reason and Undo, and the reason is saved on blur", async () => {
    // The server's side: where the deal sits; the board is read again after a move.
    let at = "lead"
    const post = vi.fn(async (url: string, body: { statusId?: string }) => {
      if (url.endsWith("/move") && body.statusId) at = body.statusId
      return {}
    })
    const [current, setCurrent] = createSignal(board(true, [deal({ taskId: "14" })]))
    const onChanged = vi.fn(async () => {
      const b = board(true, [])
      b.columns.find((c) => c.statusId === at)!.deals.push(deal({ taskId: "14" }))
      setCurrent(b)
    })
    const { container, getByTestId, queryByTestId } = render(() => (
      <ProjectKanbanView
        statuses={stages}
        workspaceWidth={1400}
        projectId="p1"
        api={makeApi(post)}
        pipeline={{ board: current(), onChanged }}
      />
    ))
    dropOnColumn(columnOf(container, "lost"), "14", "lead")
    await waitFor(() => expect(getByTestId("deal-move-note")).toBeTruthy())
    expect(post).toHaveBeenCalledWith("/projects/p1/tasks/14/move", { statusId: "lost" })
    expect(onChanged).toHaveBeenCalledTimes(1)
    expect(getByTestId("deal-move-note.text").textContent).toBe(
      "SALES-14 moved to Lost this month.",
    )

    // Leaving the empty reason saves nothing: the reason is optional.
    const reason = getByTestId("deal-move-note.reason") as HTMLInputElement
    fireEvent.blur(reason)
    expect(post).toHaveBeenCalledTimes(1)

    fireEvent.input(reason, { target: { value: "  Went with a cheaper rota tool  " } })
    fireEvent.blur(reason)
    await waitFor(() =>
      expect(post).toHaveBeenCalledWith("/apps/run-tool", {
        toolName: "projects:deals_update",
        params: { taskId: "14", outcome: "lost", reason: "Went with a cheaper rota tool" },
      }),
    )
    // The same text again is not saved twice.
    fireEvent.blur(reason)
    expect(post).toHaveBeenCalledTimes(2)

    fireEvent.click(getByTestId("deal-move-note.undo"))
    await waitFor(() =>
      expect(post).toHaveBeenLastCalledWith("/projects/p1/tasks/14/move", { statusId: "lead" }),
    )
    expect(queryByTestId("deal-move-note")).toBeNull()
    await waitFor(() =>
      expect(columnOf(container, "lead").querySelector('[data-task-id="14"]')).not.toBeNull(),
    )
  })

  it("a move to an open stage shows Undo and no reason field", async () => {
    const post = vi.fn(async () => ({}))
    const { container, getByTestId, queryByTestId } = render(() => (
      <ProjectKanbanView
        statuses={stages}
        workspaceWidth={1400}
        projectId="p1"
        api={makeApi(post)}
        pipeline={{ board: board(true, [deal({ taskId: "14" })]), onChanged: vi.fn() }}
      />
    ))
    dropOnColumn(columnOf(container, "proposal"), "14", "lead")
    await waitFor(() => expect(getByTestId("deal-move-note.undo")).toBeTruthy())
    expect(queryByTestId("deal-move-note.reason")).toBeNull()
  })

  it("a failed move puts the card back and says no deal was moved", async () => {
    let fail: (err: unknown) => void = () => {}
    const post = vi.fn(
      () =>
        new Promise((_resolve, reject) => {
          fail = reject
        }),
    )
    const { container, queryByTestId } = render(() => (
      <ProjectKanbanView
        statuses={stages}
        workspaceWidth={1400}
        projectId="p1"
        api={makeApi(post)}
        pipeline={{ board: board(true, [deal({ taskId: "14" })]), onChanged: vi.fn() }}
      />
    ))
    dropOnColumn(columnOf(container, "proposal"), "14", "lead")
    // Shown in its new column at once, before the server answers.
    await waitFor(() =>
      expect(columnOf(container, "proposal").querySelector('[data-task-id="14"]')).not.toBeNull(),
    )
    fail(new ApiError("x", 503, "unavailable", undefined, {}))
    await waitFor(() => expect(toasts()).toHaveLength(1))
    expect(toasts()[0]!.message).toBe("Projects did not answer. No deal was moved.")
    expect(columnOf(container, "lead").querySelector('[data-task-id="14"]')).not.toBeNull()
    expect(columnOf(container, "proposal").querySelector('[data-task-id="14"]')).toBeNull()
    expect(queryByTestId("deal-move-note")).toBeNull()
  })
})
