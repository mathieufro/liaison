// SPDX-License-Identifier: FSL-1.1-ALv2
import { cleanup, fireEvent, render, screen, waitFor } from "@solidjs/testing-library"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { registerTabType, resetRegistry } from "~/framework/app-registry"
import { ApiContext } from "~/modules/shell/ApiContext"
import { setShellTier } from "~/tests/helpers/shell-tier"
import { ProjectsSelectionTestAccess, selectedIds } from "./projects-selection-store"

const state = vi.hoisted(() => ({
  api: { get: vi.fn(), post: vi.fn() } as any,
  updateTabRoutePath: vi.fn(),
  refresh: vi.fn(),
  openTab: vi.fn(),
  handleTaskEvent: vi.fn(),
  archiveProject: vi.fn(async () => {}),
  restoreProject: vi.fn(async () => {}),
  updateProjectFields: vi.fn(async (..._args: unknown[]) => ({})),
  dueBuckets: [] as string[],
  query: "",
  release: null as string | null,
  taskLabels: {} as Record<string, string>,
  involvedWithinDays: null as number | null,
  replaceTask: (_row: unknown): void => {},
  clearAllFilters: vi.fn(() => {
    state.dueBuckets = []
    state.query = ""
  }),
  tabs: [{ id: "project:p1", type: "projects:project", entityId: "p1", routePath: "/projects/p1" }],
  project: {
    id: "p1",
    key: "ALP" as string | undefined,
    keyLocked: false as boolean | undefined,
    name: "Alpha",
    description: null,
    icon: null,
    color: null,
    ownerId: "u1",
    archivedAt: null as string | null,
    createdAt: "2026-05-01T00:00:00.000Z",
    updatedAt: "2026-05-01T00:00:00.000Z",
    statuses: [
      { id: "s1", projectId: "p1", label: "todo", color: null, order: 1, terminal: false },
      { id: "s2", projectId: "p1", label: "doing", color: null, order: 2, terminal: false },
    ],
  },
  tasks: [
    {
      id: "t1",
      number: 12,
      key: "ERB-12",
      projectId: "p1",
      parentTaskId: null,
      statusId: "s1",
      title: "First task",
      description: null,
      assigneeId: null,
      priority: "normal",
      dueDate: null as string | null,
      startDate: null,
      position: 1,
      blocked: false,
      completedAt: null,
      threadId: "thread-1",
      createdBy: "u1",
      createdAt: "2026-05-01T00:00:00.000Z",
      updatedAt: "2026-05-01T00:00:00.000Z",
    },
  ],
}))

vi.mock("~/modules/auth/auth-store", () => ({
  onAuthCleared: () => () => {},
  userFromToken: () => ({ userId: "u1" }),
  hasScope: () => true,
}))
vi.mock("~/modules/shell/tab-store", () => ({
  openTab: state.openTab,
  updateTabRoutePath: state.updateTabRoutePath,
  tabStore: {
    get tabs() {
      return state.tabs
    },
  },
}))
vi.mock("~/modules/shell/bulk/BulkActionToolbar", () => ({
  BulkActionToolbar: (props: { app: string; viewId: string }) => (
    <div data-testid={`bulk-toolbar-${props.app}-${props.viewId}`} />
  ),
}))
vi.mock("~/modules/projects/project-store", async () => {
  // Reactive like the real store: `replaceTask` swaps a row (the upsert a task
  // event does) and every reader of `tasksFor` re-runs.
  const { createSignal } = await import("solid-js")
  const [tasksVersion, bump] = createSignal(0)
  state.replaceTask = (row: unknown) => {
    const next = row as (typeof state.tasks)[number]
    state.tasks = state.tasks.map((t) => (t.id === next.id ? next : t))
    bump((n) => n + 1)
  }
  return {
    projectStore: {
      load: vi.fn(),
      refresh: state.refresh,
      project: () => state.project,
      tasksFor: () => {
        tasksVersion()
        return state.tasks
      },
      errorFor: () => null,
      handleTaskEvent: state.handleTaskEvent,
    },
  }
})
// one live label group, Nature {bug, evolution, maintenance}.
const NATURE_GROUP = vi.hoisted(() => ({
  id: "g-nature",
  name: "Nature",
  sortOrder: 0,
  archivedAt: null as string | null,
  values: ["bug", "evolution", "maintenance"].map((name, i) => ({
    id: `v-${name}`,
    groupId: "g-nature",
    name,
    sortOrder: i,
    archivedAt: null as string | null,
    archived: false,
  })),
}))
// Mutable: a test empties it for an org with no label group.
const LABEL_GROUPS = vi.hoisted(() => [NATURE_GROUP] as unknown[])
vi.mock("~/modules/projects/label-catalog-store", () => ({
  labelCatalog: {
    groups: LABEL_GROUPS,
    loaded: true,
    loading: false,
    failed: false,
    liveGroups: () => [NATURE_GROUP],
    groupOrder: () => [NATURE_GROUP.id],
    group: (id: string) => (id === NATURE_GROUP.id ? NATURE_GROUP : undefined),
    value: (groupId: string, valueId: string) =>
      groupId === NATURE_GROUP.id ? NATURE_GROUP.values.find((v) => v.id === valueId) : undefined,
    displayName: (e: { groupName: string; valueName: string; archived: boolean }) => ({
      groupName: e.groupName,
      valueName: e.valueName,
      archived: e.archived,
    }),
  },
  ensureLabelCatalog: vi.fn(async () => {}),
  loadLabelCatalog: vi.fn(async () => {}),
  handleLabelEvent: vi.fn(),
  resetLabelCatalogStore: vi.fn(),
}))
vi.mock("~/modules/projects/projects-filter-store", () => ({
  projectsFilterStore: {
    get query() {
      return state.query
    },
    statusLabels: [],
    get dueBuckets() {
      return state.dueBuckets
    },
    assignedToMe: false,
    get release() {
      return state.release
    },
    setRelease: (value: string | null) => {
      state.release = value
    },
    get taskLabels() {
      return state.taskLabels
    },
    setTaskLabel: (groupId: string, valueId: string | null) => {
      const next = { ...state.taskLabels }
      if (valueId === null) delete next[groupId]
      else next[groupId] = valueId
      state.taskLabels = next
    },
    clearTaskLabels: () => {
      state.taskLabels = {}
    },
    get involvedWithinDays() {
      return state.involvedWithinDays
    },
    get isActive() {
      return (
        state.involvedWithinDays !== null ||
        state.dueBuckets.length > 0 ||
        state.query.length > 0 ||
        Object.keys(state.taskLabels).length > 0
      )
    },
    clearAll: state.clearAllFilters,
  },
}))
vi.mock("~/modules/projects/project-archive", () => ({
  archiveProject: state.archiveProject,
  restoreProject: state.restoreProject,
}))
vi.mock("~/modules/projects/project-edit", () => ({
  updateProjectFields: state.updateProjectFields,
}))
vi.mock("~/modules/projects/ProjectKanbanView", () => ({ ProjectKanbanView: () => <div /> }))
vi.mock("~/modules/projects/NewTaskDialog", () => ({ NewTaskDialog: () => <div /> }))
vi.mock("~/modules/projects/StatusManager", () => ({ StatusManager: () => <div /> }))
vi.mock("~/modules/projects/StatusPillPopover", () => ({ StatusPillPopover: () => <button /> }))

import { ProjectWorkspace } from "./ProjectWorkspace"
import { forgetBudget } from "./time-budgets"

// Open the header's project menu the way a keyboard does (Kobalte's trigger
// opens on ArrowDown), and wait for the portalled menu.
async function openProjectMenu(): Promise<HTMLElement> {
  const trigger = screen.getByTestId("project-workspace.menu")
  trigger.focus()
  fireEvent.keyDown(trigger, { key: "ArrowDown" })
  return screen.findByTestId("project-workspace.menu-content")
}

function choose(item: HTMLElement): void {
  item.focus()
  fireEvent.keyDown(item, { key: "Enter" })
}

describe("ProjectWorkspace", () => {
  beforeEach(() => {
    ProjectsSelectionTestAccess.reset()
    vi.clearAllMocks()
    state.dueBuckets = []
    state.query = ""
    state.release = null
    state.taskLabels = {}
    state.involvedWithinDays = null
    state.api.get.mockReset()
    state.project.archivedAt = null
    state.project.keyLocked = false
    state.tasks = [
      {
        id: "t1",
        number: 12,
        key: "ERB-12",
        projectId: "p1",
        parentTaskId: null,
        statusId: "s1",
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
      },
    ]
  })

  describe("on a sales pipeline", () => {
    afterEach(() => {
      delete (state.project as { kind?: string }).kind
    })

    it("the header says how many deals are open and their sum per currency, and the action is New deal", async () => {
      ;(state.project as { kind?: string }).kind = "pipeline"
      state.api.get.mockImplementation(async (path: string) => {
        if (path === "/projects/p1/deals/board") {
          return {
            projectId: "p1",
            timeZone: "UTC",
            closedMonth: "2026-11",
            columns: [
              {
                statusId: "s1",
                label: "todo",
                dealOutcome: null,
                count: 2,
                sums: [{ currency: "EUR", sum_minor: 6_866_000 }],
                deals: [],
              },
              {
                statusId: "s2",
                label: "doing",
                dealOutcome: "won",
                count: 1,
                sums: [{ currency: "EUR", sum_minor: 588_000 }],
                deals: [],
              },
            ],
          }
        }
        return {}
      })
      render(() => (
        <ApiContext.Provider value={state.api}>
          <ProjectWorkspace entityId="p1" />
        </ApiContext.Provider>
      ))
      // Closed columns are not counted as open.
      expect((await screen.findByTestId("project-workspace.deal-subline")).textContent).toBe(
        "2 open deals, €68,660.00. Quiet deals come first in each column.",
      )
      expect(screen.getByTestId("project-workspace.new-task").textContent).toBe("New deal")
    })
  })

  describe("Edit project (inline, no modal)", () => {
    const renderWorkspace = () =>
      render(() => (
        <ApiContext.Provider value={state.api}>
          <ProjectWorkspace entityId="p1" />
        </ApiContext.Provider>
      ))

    it("edits name, key, icon, colour and description in the header and saves only what changed", async () => {
      renderWorkspace()
      await openProjectMenu()
      choose(screen.getByTestId("project-workspace.edit"))
      const form = await screen.findByTestId("project-edit")
      expect(document.querySelector('[role="dialog"]')).toBeNull()
      expect(form.closest('[data-testid="project-workspace.header"]')).not.toBeNull()

      fireEvent.input(screen.getByTestId("project-edit.name"), { target: { value: "Alpha 2" } })
      fireEvent.input(screen.getByTestId("project-edit.key"), { target: { value: "alq" } })
      fireEvent.input(screen.getByTestId("project-edit.description"), {
        target: { value: "What it is for" },
      })
      fireEvent.click(screen.getByTestId("project-edit.icon-Flag"))
      fireEvent.click(screen.getByTestId("project-edit.color-2"))
      fireEvent.click(screen.getByTestId("project-edit.save"))

      await vi.waitFor(() =>
        expect(state.updateProjectFields).toHaveBeenCalledWith(state.api, "p1", {
          name: "Alpha 2",
          key: "ALQ",
          description: "What it is for",
          icon: "Flag",
          color: "var(--avatar-2-bg)",
        }),
      )
      await vi.waitFor(() => expect(screen.queryByTestId("project-edit")).toBeNull())
    })

    it("the key is read-only once the project has tasks", async () => {
      state.project.keyLocked = true
      renderWorkspace()
      await openProjectMenu()
      choose(screen.getByTestId("project-workspace.edit"))
      const key = (await screen.findByTestId("project-edit.key")) as HTMLInputElement
      expect(key.disabled).toBe(true)
      expect(screen.getByTestId("project-edit.key-locked")).toBeTruthy()
      fireEvent.input(screen.getByTestId("project-edit.name"), { target: { value: "Beta" } })
      fireEvent.click(screen.getByTestId("project-edit.save"))
      await vi.waitFor(() =>
        expect(state.updateProjectFields).toHaveBeenCalledWith(state.api, "p1", { name: "Beta" }),
      )
    })

    it("an archived project cannot be edited", async () => {
      state.project.archivedAt = "2026-09-20T10:00:00.000Z"
      renderWorkspace()
      await openProjectMenu()
      expect(
        screen.getByTestId("project-workspace.edit").getAttribute("data-disabled"),
      ).not.toBeNull()
    })
  })

  it("archives the project from the header, behind a confirmation", async () => {
    render(() => (
      <ApiContext.Provider value={state.api}>
        <ProjectWorkspace entityId="p1" />
      </ApiContext.Provider>
    ))

    await openProjectMenu()
    expect(screen.queryByTestId("project-workspace.restore")).toBeNull()
    choose(screen.getByTestId("project-workspace.archive"))
    // Nothing is archived until the confirmation is accepted.
    expect(state.archiveProject).not.toHaveBeenCalled()
    const confirm = await screen.findByTestId("project-workspace.archive-confirm")
    expect(document.body.textContent).toContain("Alpha leaves the project list")
    fireEvent.click(confirm)
    await vi.waitFor(() => expect(state.archiveProject).toHaveBeenCalledWith(state.api, "p1"))
  })

  it("cancelling the archive confirmation archives nothing", async () => {
    render(() => (
      <ApiContext.Provider value={state.api}>
        <ProjectWorkspace entityId="p1" />
      </ApiContext.Provider>
    ))
    await openProjectMenu()
    choose(screen.getByTestId("project-workspace.archive"))
    fireEvent.click(await screen.findByTestId("project-workspace.archive-cancel"))
    await vi.waitFor(() =>
      expect(screen.queryByTestId("project-workspace.archive-confirm")).toBeNull(),
    )
    expect(state.archiveProject).not.toHaveBeenCalled()
  })

  it("an archived project shows Restore in place of Archive, and Restore restores it", async () => {
    state.project.archivedAt = "2026-09-20T10:00:00.000Z"
    render(() => (
      <ApiContext.Provider value={state.api}>
        <ProjectWorkspace entityId="p1" />
      </ApiContext.Provider>
    ))

    expect(screen.getByTestId("project-workspace.archived-banner")).toBeTruthy()
    await openProjectMenu()
    expect(screen.queryByTestId("project-workspace.archive")).toBeNull()
    expect(screen.getByTestId("project-workspace.restore").textContent).toBe("Restore project")
    choose(screen.getByTestId("project-workspace.restore"))
    await vi.waitFor(() => expect(state.restoreProject).toHaveBeenCalledWith(state.api, "p1"))
  })

  it("the archived banner carries its own Restore project button", async () => {
    state.project.archivedAt = "2026-09-20T10:00:00.000Z"
    render(() => (
      <ApiContext.Provider value={state.api}>
        <ProjectWorkspace entityId="p1" />
      </ApiContext.Provider>
    ))
    const button = screen.getByTestId("project-workspace.banner-restore")
    expect(button.textContent).toBe("Restore project")
    fireEvent.click(button)
    await vi.waitFor(() => expect(state.restoreProject).toHaveBeenCalledWith(state.api, "p1"))
  })

  it("Archive project sits in a labelled project menu, apart from the view controls", async () => {
    render(() => (
      <ApiContext.Provider value={state.api}>
        <ProjectWorkspace entityId="p1" />
      </ApiContext.Provider>
    ))

    // Not a bare header button next to Trash any more.
    expect(screen.queryByTestId("project-workspace.archive")).toBeNull()
    const trigger = screen.getByTestId("project-workspace.menu")
    expect(trigger.getAttribute("aria-label")).toBe("Project actions")
    // The menu comes after New task, at the end of the header.
    const newTask = screen.getByTestId("project-workspace.new-task")
    expect(newTask.compareDocumentPosition(trigger) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()

    const menu = await openProjectMenu()
    const item = screen.getByTestId("project-workspace.archive")
    expect(item.getAttribute("role")).toBe("menuitem")
    expect(item.textContent).toBe("Archive project")
    expect(menu.getAttribute("aria-label")).toBe("Project actions")
    // On desktop Statuses and Trash stay in the header, not in the menu.
    expect(screen.queryByTestId("project-workspace.menu-statuses")).toBeNull()
    expect(screen.getByTestId("project-workspace.open-trash")).toBeTruthy()
  })

  it("mounts project bulk toolbar and toggles row selection", () => {
    render(() => (
      <ApiContext.Provider value={state.api}>
        <ProjectWorkspace entityId="p1" />
      </ApiContext.Provider>
    ))

    expect(screen.getByTestId("bulk-toolbar-projects-project")).toBeTruthy()
    fireEvent.click(screen.getByTestId("project-list-view.select-t1"))
    expect(selectedIds()).toEqual(["t1"])
  })

  it("sorts the list by status order, then oldest edit first, and shows the last-edit date", () => {
    const mk = (id: string, statusId: string, updatedAt: string, position: number) => ({
      ...state.tasks[0],
      id,
      statusId,
      updatedAt,
      position,
      title: id,
    })
    state.tasks = [
      mk("a", "s2", "2026-05-03T00:00:00.000Z", 1),
      mk("b", "s1", "2026-05-02T00:00:00.000Z", 2),
      mk("c", "s1", "2026-05-01T00:00:00.000Z", 3),
    ]
    render(() => (
      <ApiContext.Provider value={state.api}>
        <ProjectWorkspace entityId="p1" />
      </ApiContext.Provider>
    ))

    const rows = screen.getAllByTestId("project-list-view.row")
    // Status s1 group first (board order), within it oldest edit first, s2 last.
    expect(rows.map((r) => r.getAttribute("data-task-id"))).toEqual(["c", "b", "a"])
    const dates = screen.getAllByTestId("project-list-view.updated-at")
    // The last-edit day in the reader's words, not raw ISO.
    expect(dates.map((d) => d.textContent)).toEqual(["May 1, 2026", "May 2, 2026", "May 3, 2026"])
  })

  it("renders the task key on each list row", () => {
    render(() => (
      <ApiContext.Provider value={state.api}>
        <ProjectWorkspace entityId="p1" />
      </ApiContext.Provider>
    ))

    const row = screen.getByTestId("project-list-view.row")
    expect(row.textContent).toContain("ERB-12")
  })

  it("inline create merges the created row (with its key) into the store at once", async () => {
    const row = { ...state.tasks[0]!, id: "t2", number: 13, key: "ERB-13", title: "Second" }
    state.api.post.mockResolvedValueOnce(row)
    render(() => (
      <ApiContext.Provider value={state.api}>
        <ProjectWorkspace entityId="p1" />
      </ApiContext.Provider>
    ))
    const input = screen.getByTestId("project-list-view.inline-create")
    fireEvent.input(input, { target: { value: "Second" } })
    fireEvent.keyDown(input, { key: "Enter" })
    await vi.waitFor(() =>
      expect(state.handleTaskEvent).toHaveBeenCalledWith("created", { ...row, projectId: "p1" }),
    )
    expect(state.api.post).toHaveBeenCalledWith("/projects/p1/tasks", { title: "Second" })
  })

  it("typing a task key in the search finds that task", () => {
    state.tasks = [
      { ...state.tasks[0], id: "a", key: "ERB-3", title: "Fix the sync gate" },
      { ...state.tasks[0], id: "b", key: "ERB-4", title: "Unrelated title" },
    ]
    state.query = "erb-3"

    render(() => (
      <ApiContext.Provider value={state.api}>
        <ProjectWorkspace entityId="p1" />
      </ApiContext.Provider>
    ))

    const rows = screen.getAllByTestId("project-list-view.row")
    expect(rows).toHaveLength(1)
    expect(rows[0].getAttribute("data-task-id")).toBe("a")
  })

  it("Recently involved keeps only the tasks the server lists, newest involvement first, with the reason", async () => {
    state.tasks = [
      { ...state.tasks[0], id: "a", title: "Commented long ago" },
      { ...state.tasks[0], id: "b", title: "Never touched" },
      { ...state.tasks[0], id: "c", title: "Created just now" },
    ]
    const inv = (kind: string, at: string) => ({
      kind,
      at,
      viaAgent: false,
      actorName: null,
      statusLabel: null,
      assigneeName: null,
      projectName: null,
      fields: [],
      summary: "",
    })
    state.api.get.mockImplementation(async (path: string) => {
      if (path.startsWith("/projects/involved?")) {
        return {
          items: [
            { id: "c", involvement: inv("created", new Date(Date.now() - 3600_000).toISOString()) },
            { id: "a", involvement: inv("commented", "2026-01-01T00:00:00.000Z") },
          ],
        }
      }
      return { items: [] }
    })
    state.involvedWithinDays = 14

    render(() => (
      <ApiContext.Provider value={state.api}>
        <ProjectWorkspace entityId="p1" />
      </ApiContext.Provider>
    ))

    await waitFor(() => expect(screen.getAllByTestId("project-list-view.row")).toHaveLength(2))
    const rows = screen.getAllByTestId("project-list-view.row")
    expect(rows.map((r) => r.getAttribute("data-task-id"))).toEqual(["c", "a"])
    const path = state.api.get.mock.calls
      .map((c: unknown[]) => c[0] as string)
      .find((p: string) => p.startsWith("/projects/involved?"))
    expect(path).toContain("projectId=p1")
    expect(path).toContain("days=14")
    expect(screen.getByTestId("project-list-view.involvement-c").textContent).toContain(
      "You created it",
    )
  })

  it("shows Showing N of M when a due filter hides rows", () => {
    const iso = (offsetDays: number) => {
      const d = new Date()
      d.setUTCDate(d.getUTCDate() + offsetDays)
      return d.toISOString().slice(0, 10)
    }
    state.tasks = [
      { ...state.tasks[0], id: "a", dueDate: iso(-1) }, // overdue
      { ...state.tasks[0], id: "b", dueDate: iso(30) }, // later
    ]
    state.dueBuckets = ["overdue"]

    render(() => (
      <ApiContext.Provider value={state.api}>
        <ProjectWorkspace entityId="p1" />
      </ApiContext.Provider>
    ))

    const showing = screen.getByTestId("project-workspace.showing-count")
    expect(showing.textContent).toBe("Showing 1 of 2")
    expect(screen.getAllByTestId("project-list-view.row")).toHaveLength(1)
  })

  it("shows a distinct zero-match state with a clear-filters action when a due filter hides every row", () => {
    state.tasks = [{ ...state.tasks[0], dueDate: null }]
    state.dueBuckets = ["overdue"]

    render(() => (
      <ApiContext.Provider value={state.api}>
        <ProjectWorkspace entityId="p1" />
      </ApiContext.Provider>
    ))

    expect(screen.getByTestId("project-list-view.no-matches")).toBeTruthy()
    fireEvent.click(screen.getByTestId("project-list-view.no-matches-clear"))
    expect(state.clearAllFilters).toHaveBeenCalled()
  })

  describe("at phone width (390px walk: title under the toggle, titles cut to 3 letters)", () => {
    afterEach(() => {
      cleanup()
      setShellTier("desktop")
      vi.unstubAllGlobals()
    })

    it("stacks the title above the toolbar instead of squeezing it beside it", () => {
      setShellTier("phone")
      render(() => (
        <ApiContext.Provider value={state.api}>
          <ProjectWorkspace entityId="p1" />
        </ApiContext.Provider>
      ))
      const header = screen.getByTestId("project-workspace.header")
      expect(header.getAttribute("data-stacked")).toBe("true")
      expect(header.className).toContain("flex-col")
    })

    it("keeps one toolbar row: view toggle, New task and the menu, with Statuses and Trash inside it", async () => {
      setShellTier("phone")
      render(() => (
        <ApiContext.Provider value={state.api}>
          <ProjectWorkspace entityId="p1" />
        </ApiContext.Provider>
      ))
      const toolbar = screen.getByTestId("project-workspace.toolbar")
      expect(toolbar.className).not.toContain("flex-wrap")
      expect(screen.getByTestId("project-view-list")).toBeTruthy()
      expect(screen.getByTestId("project-workspace.new-task")).toBeTruthy()
      expect(screen.queryByTestId("project-workspace.manage-statuses")).toBeNull()
      expect(screen.queryByTestId("project-workspace.open-trash")).toBeNull()
      expect(screen.queryByTestId("project-workspace.release-filter")).toBeNull()

      await openProjectMenu()
      expect(screen.getByTestId("project-workspace.menu-statuses").textContent).toBe("Statuses")
      expect(screen.getByTestId("project-workspace.menu-trash").textContent).toBe("Trash")
      expect(screen.getByTestId("project-workspace.archive").textContent).toBe("Archive project")
    })

    it("keeps the release filter reachable: Filter by release in the menu opens the release picker", async () => {
      setShellTier("phone")
      ;(state.tasks[0] as { release?: string }).release = "2.1.0"
      render(() => (
        <ApiContext.Provider value={state.api}>
          <ProjectWorkspace entityId="p1" />
        </ApiContext.Provider>
      ))
      await openProjectMenu()
      const entry = screen.getByTestId("project-workspace.menu-release")
      expect(entry.textContent).toBe("Filter by release")
      choose(entry)

      const options = await screen.findAllByTestId("release-filter.option")
      expect(options.map((o) => o.textContent)).toContain("2.1.01")
      expect(screen.getByRole("menu", { name: "Filter by release" })).toBeTruthy()
    })

    it("an active release filter stays on the phone row as a compact chip with a clear control", () => {
      setShellTier("phone")
      state.release = "2.1.0"
      render(() => (
        <ApiContext.Provider value={state.api}>
          <ProjectWorkspace entityId="p1" />
        </ApiContext.Provider>
      ))
      expect(screen.getByTestId("project-workspace.release-filter").textContent).toBe("2.1.0")
      fireEvent.click(screen.getByTestId("project-workspace.release-filter-clear"))
      expect(state.release).toBeNull()
    })

    it("keeps the label filter reachable: Filter by label in the menu opens the label picker", async () => {
      setShellTier("phone")
      render(() => (
        <ApiContext.Provider value={state.api}>
          <ProjectWorkspace entityId="p1" />
        </ApiContext.Provider>
      ))
      expect(screen.queryByTestId("project-workspace.label-filter")).toBeNull()
      await openProjectMenu()
      const entry = screen.getByTestId("project-workspace.menu-labels")
      expect(entry.textContent).toBe("Filter by label")
      choose(entry)
      const sections = await screen.findAllByTestId("label-filter.section")
      expect(sections.map((el) => el.getAttribute("data-group"))).toEqual(["g-nature"])
    })

    it("with no label group, the menu has no Filter by label entry", async () => {
      setShellTier("phone")
      const saved = LABEL_GROUPS.splice(0, LABEL_GROUPS.length)
      try {
        render(() => (
          <ApiContext.Provider value={state.api}>
            <ProjectWorkspace entityId="p1" />
          </ApiContext.Provider>
        ))
        await openProjectMenu()
        expect(screen.getByTestId("project-workspace.menu-release")).toBeTruthy()
        expect(screen.queryByTestId("project-workspace.menu-labels")).toBeNull()
      } finally {
        LABEL_GROUPS.push(...saved)
      }
    })

    it("an active label filter stays on the phone row with a clear control", () => {
      setShellTier("phone")
      state.taskLabels = { "g-nature": "v-bug" }
      render(() => (
        <ApiContext.Provider value={state.api}>
          <ProjectWorkspace entityId="p1" />
        </ApiContext.Provider>
      ))
      expect(screen.getByTestId("project-workspace.label-filter").textContent).toBe("Labels · 1")
      fireEvent.click(screen.getByTestId("project-workspace.label-filter-clear"))
      expect(state.taskLabels).toEqual({})
    })

    it("drops the drag handle and the last-edit stamp so the task title keeps the row", () => {
      setShellTier("phone")
      render(() => (
        <ApiContext.Provider value={state.api}>
          <ProjectWorkspace entityId="p1" />
        </ApiContext.Provider>
      ))
      expect(screen.queryByTestId("project-list-view.drag-handle")).toBeNull()
      expect(screen.queryByTestId("project-list-view.updated-at")).toBeNull()
      expect(screen.getByTestId("project-list-view.task-title").className).toContain("min-w-0")
    })

    it("keeps both on desktop", () => {
      setShellTier("desktop")
      render(() => (
        <ApiContext.Provider value={state.api}>
          <ProjectWorkspace entityId="p1" />
        </ApiContext.Provider>
      ))
      expect(screen.getByTestId("project-workspace.header").getAttribute("data-stacked")).toBe(
        "false",
      )
      expect(screen.getByTestId("project-list-view.drag-handle")).toBeTruthy()
      expect(screen.getByTestId("project-list-view.updated-at")).toBeTruthy()
    })
  })
})

describe("ProjectWorkspace label filter", () => {
  const natureEntry = (valueName: string, over: Record<string, unknown> = {}) => ({
    groupId: "g-nature",
    groupName: "Nature",
    groupArchived: false,
    valueId: `v-${valueName}`,
    valueName,
    archived: false,
    inherited: false,
    inheritedFromKey: null,
    ...over,
  })
  const base = () => ({
    number: 1,
    projectId: "p1",
    statusId: "s1",
    description: null,
    assigneeId: null,
    priority: "normal",
    dueDate: null as string | null,
    startDate: null,
    position: 1,
    blocked: false,
    completedAt: null,
    threadId: "thread-1",
    createdBy: "u1",
    createdAt: "2026-05-01T00:00:00.000Z",
    updatedAt: "2026-05-01T00:00:00.000Z",
  })
  const parent = (valueName: string, updatedAt = "2026-05-01T00:00:00.000Z") => ({
    ...base(),
    id: "P",
    key: "PRJ-1",
    parentTaskId: null,
    title: "Parent",
    labels: [natureEntry(valueName)],
    updatedAt,
  })
  const child = () => ({
    ...base(),
    id: "C",
    key: "PRJ-2",
    parentTaskId: "P",
    title: "Child",
    position: 2,
    // A stale server entry: the loaded parent decides.
    labels: [natureEntry("evolution", { inherited: true, inheritedFromKey: "PRJ-1" })],
  })

  beforeEach(() => {
    vi.clearAllMocks()
    state.dueBuckets = []
    state.query = ""
    state.release = null
    state.project.archivedAt = null
    state.taskLabels = {}
    state.tasks = [parent("bug"), child()] as unknown as typeof state.tasks
  })

  const renderWorkspace = () =>
    render(() => (
      <ApiContext.Provider value={state.api}>
        <ProjectWorkspace entityId="p1" />
      </ApiContext.Provider>
    ))
  // Sorted: the list orders by last edit, which the live test changes.
  const rowIds = () =>
    screen
      .queryAllByTestId("project-list-view.row")
      .map((r) => r.getAttribute("data-task-id"))
      .sort()

  it("matches on the effective label resolved on the client", () => {
    state.taskLabels = { "g-nature": "v-bug" }
    renderWorkspace()
    expect(screen.getByTestId("project-workspace.showing-count").textContent).toBe("Showing 2 of 2")
    expect(rowIds()).toEqual(["C", "P"])
    // No read for the filter: the only one is the project page's slot list.
    const reads = state.api.get.mock.calls.map(([path]: [string]) => path)
    expect(reads.filter((p: string) => !p.startsWith("/v1/slots/"))).toEqual([])
  })

  it("No label selects tasks with no effective value", () => {
    state.taskLabels = { "g-nature": "__none__" }
    renderWorkspace()
    expect(screen.getByTestId("project-list-view.no-matches")).toBeTruthy()
  })

  it("a parent's change re-filters parent and child without a refetch", async () => {
    state.taskLabels = { "g-nature": "v-bug" }
    renderWorkspace()
    expect(rowIds()).toEqual(["C", "P"])
    const calls = state.api.get.mock.calls.length

    state.replaceTask(parent("maintenance", "2026-05-02T00:00:00.000Z"))
    await waitFor(() => expect(rowIds()).toEqual([]))
    expect(screen.getByTestId("project-workspace.showing-count").textContent).toBe("Showing 0 of 2")

    state.replaceTask(parent("bug", "2026-05-03T00:00:00.000Z"))
    await waitFor(() => expect(rowIds()).toEqual(["C", "P"]))
    expect(screen.getByTestId("project-workspace.showing-count").textContent).toBe("Showing 2 of 2")
    expect(state.api.get.mock.calls.length).toBe(calls)
  })

  it("the desktop toolbar shows the Labels chip", () => {
    renderWorkspace()
    expect(screen.getByTestId("project-workspace.label-filter").textContent).toBe("Labels")
  })
})

describe("ProjectWorkspace copy link", () => {
  afterEach(() => cleanup())

  it("the project menu copies this server's address of the project", async () => {
    resetRegistry()
    registerTabType("projects:project", {
      component: () => null,
      sidebar: null,
      icon: () => null,
      urlPattern: "/projects/:entityId",
      defaultLabel: "x",
    })
    const writeText = vi.fn(async () => {})
    vi.stubGlobal("navigator", { clipboard: { writeText } })
    render(() => (
      <ApiContext.Provider value={state.api}>
        <ProjectWorkspace entityId="p1" />
      </ApiContext.Provider>
    ))
    await openProjectMenu()
    choose(screen.getByTestId("project-workspace.menu-copy-link"))
    await waitFor(() =>
      expect(writeText).toHaveBeenCalledWith(`${window.location.origin}/projects/p1`),
    )
  })
})

describe("ProjectWorkspace time and budgets", () => {
  const budget = {
    projectId: "p1",
    projectName: "Alpha",
    line: "10 h real of 20 h planned, 10 h left.",
    timebox: 1200,
    real: 600,
    left: 600,
    partial: false,
    coverage: { withEntries: 3, total: 3 },
    milestones: [],
    notInNumbers: [],
    datedHours: false,
  }
  const mount = () =>
    render(() => (
      <ApiContext.Provider value={state.api}>
        <ProjectWorkspace entityId="p1" />
      </ApiContext.Provider>
    ))

  beforeEach(() => {
    forgetBudget("p1")
    state.api.post.mockReset()
    state.api.post.mockResolvedValue(budget)
    setShellTier("desktop")
  })
  afterEach(() => {
    cleanup()
    delete (state.project as { timeBudgets?: boolean }).timeBudgets
  })

  it("a project that does not use time and budgets shows no line, no panel and asks for nothing", async () => {
    mount()
    await screen.findByTestId("project-workspace.title")
    expect(screen.queryByTestId("budget-line")).toBeNull()
    expect(screen.queryByTestId("budget-panel")).toBeNull()
    expect(state.api.post).not.toHaveBeenCalled()
  })

  it("a project that uses it shows its budget line and the panel", async () => {
    ;(state.project as { timeBudgets?: boolean }).timeBudgets = true
    mount()
    expect((await screen.findByTestId("budget-line.text")).textContent).toBe(budget.line)
    expect(screen.getByTestId("budget-panel")).toBeTruthy()
    expect(state.api.post).toHaveBeenCalledWith(
      "/apps/run-tool",
      { toolName: "projects:budget_get", params: { projectId: "p1" } },
      expect.anything(),
    )
  })

  it("on a phone the panel is a block under the line, not a rail", async () => {
    setShellTier("phone")
    ;(state.project as { timeBudgets?: boolean }).timeBudgets = true
    mount()
    await screen.findByTestId("budget-line.text")
    expect(screen.getByTestId("budget-panel").getAttribute("data-layout")).toBe("block")
  })

  it("the details button closes and reopens the panel", async () => {
    ;(state.project as { timeBudgets?: boolean }).timeBudgets = true
    mount()
    fireEvent.click(await screen.findByTestId("budget-line.toggle"))
    expect(screen.queryByTestId("budget-panel")).toBeNull()
    fireEvent.click(screen.getByTestId("budget-line.toggle"))
    expect(screen.getByTestId("budget-panel")).toBeTruthy()
  })

  it("a failed read keeps the board and says so on the line", async () => {
    ;(state.project as { timeBudgets?: boolean }).timeBudgets = true
    state.api.post.mockRejectedValue(new Error("network"))
    mount()
    expect((await screen.findByTestId("budget-line.error")).textContent).toContain(
      "The board below is not affected",
    )
    expect(screen.getByTestId("project-workspace.title")).toBeTruthy()
  })

  it("planning_off from the budget refetches the project", async () => {
    ;(state.project as { timeBudgets?: boolean }).timeBudgets = true
    state.api.post.mockResolvedValue({ code: "planning_off" })
    mount()
    await waitFor(() => expect(state.refresh).toHaveBeenCalledWith(state.api, "p1"))
  })
})
