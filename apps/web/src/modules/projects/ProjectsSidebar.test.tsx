// SPDX-License-Identifier: FSL-1.1-ALv2
import { cleanup, fireEvent, render, screen } from "@solidjs/testing-library"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { dueBucket } from "~/modules/projects/due-status"

const state = vi.hoisted(() => ({
  api: {} as any,
  projects: [{ id: "p1", name: "Alpha", archivedAt: null, taskCount: 2 }] as Array<{
    id: string
    key?: string
    group?: string | null
    name: string
    archivedAt: string | null
    taskCount: number
  }>,
  archived: [] as Array<{
    id: string
    key?: string
    name: string
    archivedAt: string | null
    taskCount: number
  }>,
  taskProjectId: null as string | null,
  archivedLoaded: false,
  loaded: true,
  loadProjects: vi.fn(),
  loadArchived: vi.fn(async () => {}),
  featureOff: true,
  canCapacity: true,
  activeTabId: "home",
  tabs: [{ id: "home", type: "projects:home" }] as Array<{
    id: string
    type: string
    entityId?: string
  }>,
  openTab: vi.fn(),
  activeProject: null as null | {
    id: string
    statuses: Array<{ id: string; label: string; terminal: boolean; order: number }>
  },
  activeProjectTasks: [] as Array<{ id: string; statusId: string; dueDate: string | null }>,
}))

vi.mock("~/modules/shell/ApiContext", () => ({ useApi: () => state.api }))
vi.mock("~/modules/auth/auth-store", async (importOriginal) => ({
  ...(await importOriginal<typeof import("~/modules/auth/auth-store")>()),
  userFromToken: () => ({ orgId: "org-1", userId: "user-1" }),
  hasScope: (s: string) => (s === "projects:capacity:read" ? state.canCapacity : true),
}))
vi.mock("~/framework/org-features", () => ({ isFeatureOff: () => state.featureOff }))
vi.mock("~/modules/shell/saved-views/SavedViewsList", () => ({
  SavedViewsList: (props: { app: string; viewId: string }) => (
    <div data-testid={`saved-views-${props.app}-${props.viewId}`} />
  ),
}))
vi.mock("~/modules/shell/tab-store", () => ({
  openTab: state.openTab,
  tabStore: {
    get tabs() {
      return state.tabs
    },
    get activeTabId() {
      return state.activeTabId
    },
  },
}))
vi.mock("~/modules/projects/projects-store", () => ({
  projectsStore: {
    get items() {
      return state.projects
    },
    get loaded() {
      return state.loaded
    },
    get archivedItems() {
      return state.archived
    },
    get archivedLoaded() {
      return state.archivedLoaded
    },
    load: state.loadProjects,
    loadArchived: state.loadArchived,
  },
}))
vi.mock("~/modules/projects/project-store", () => ({
  projectStore: {
    project: () => state.activeProject,
    projectIdForTask: () => state.taskProjectId,
    tasksFor: () => state.activeProjectTasks,
  },
}))
vi.mock("~/modules/projects/projects-filter-store", () => ({
  projectsFilterStore: {
    query: "",
    assignedToMe: false,
    statusLabels: [],
    dueBuckets: [],
    involvedWithinDays: null,
    isActive: false,
    setQuery: vi.fn(),
    toggleAssignedToMe: vi.fn(),
    toggleInvolved: vi.fn(),
    toggleStatusLabel: vi.fn(),
    toggleDueBucket: vi.fn(),
    clearAll: vi.fn(),
  },
}))

import { projectsFilterStore } from "~/modules/projects/projects-filter-store"
import { ProjectsSidebar } from "./ProjectsSidebar"

describe("ProjectsSidebar", () => {
  beforeEach(() => {
    state.activeTabId = "home"
    state.tabs = [{ id: "home", type: "projects:home" }]
    state.loadProjects.mockReset()
    state.loadArchived.mockClear()
    state.projects = [{ id: "p1", name: "Alpha", archivedAt: null, taskCount: 2 }]
    state.archived = []
    state.archivedLoaded = false
    state.activeProject = null
    state.activeProjectTasks = []
    state.taskProjectId = null
    state.openTab.mockClear()
  })

  it("shows the Capacity row only once a project uses time and budgets, to someone who may read it", () => {
    state.featureOff = true
    const off = render(() => <ProjectsSidebar />)
    expect(screen.queryByTestId("side-capacity")).toBeNull()
    off.unmount()
    state.featureOff = false
    state.canCapacity = false
    const noScope = render(() => <ProjectsSidebar />)
    expect(screen.queryByTestId("side-capacity")).toBeNull()
    noScope.unmount()
    state.canCapacity = true
    render(() => <ProjectsSidebar />)
    fireEvent.click(screen.getByTestId("side-capacity"))
    expect(state.openTab).toHaveBeenCalledWith(
      expect.objectContaining({ type: "projects:capacity" }),
    )
  })

  it("offers a Recently involved chip that toggles the filter", () => {
    render(() => <ProjectsSidebar />)
    const chip = screen.getByTestId("projects-sidebar.filter-recently-involved")
    expect(chip.textContent).toContain("Recently involved")
    expect(chip.getAttribute("data-active")).toBeNull()
    fireEvent.click(chip)
    expect(projectsFilterStore.toggleInvolved).toHaveBeenCalledTimes(1)
  })

  it("mounts project home saved views when no project tab is active", () => {
    render(() => <ProjectsSidebar />)
    expect(screen.getByTestId("saved-views-projects-home")).toBeTruthy()
  })

  it("mounts project detail saved views when a project tab is active", () => {
    state.activeTabId = "project:p1"
    state.tabs = [{ id: "project:p1", type: "projects:project", entityId: "p1" }]

    render(() => <ProjectsSidebar />)
    expect(screen.getByTestId("saved-views-projects-project")).toBeTruthy()
  })

  it("due filter chip counts equal the rows those chips leave visible", () => {
    state.activeTabId = "project:p1"
    state.tabs = [{ id: "project:p1", type: "projects:project", entityId: "p1" }]
    const iso = (offsetDays: number) => {
      const d = new Date()
      d.setUTCDate(d.getUTCDate() + offsetDays)
      return d.toISOString().slice(0, 10)
    }
    state.activeProject = {
      id: "p1",
      statuses: [
        { id: "s1", label: "todo", terminal: false, order: 1 },
        { id: "s2", label: "done", terminal: true, order: 2 },
      ],
    }
    state.activeProjectTasks = [
      { id: "t-overdue", statusId: "s1", dueDate: iso(-1) },
      { id: "t-soon", statusId: "s1", dueDate: iso(3) },
      { id: "t-later", statusId: "s1", dueDate: iso(30) },
      { id: "t-none", statusId: "s1", dueDate: null },
      // Terminal task, overdue date, must be excluded from every bucket count.
      { id: "t-done", statusId: "s2", dueDate: iso(-5) },
    ]

    render(() => <ProjectsSidebar />)

    // "The rows those chips leave visible" — an independent recomputation
    // over the exact same task list, using the shared classifier, so this
    // proves parity rather than re-asserting the sidebar's own logic.
    const today = new Date().toISOString().slice(0, 10)
    const visibleFor = (bucket: string) =>
      state.activeProjectTasks.filter((t) => {
        const terminal = state.activeProject!.statuses.find((s) => s.id === t.statusId)!.terminal
        return dueBucket(t.dueDate, terminal, today) === bucket
      }).length

    for (const bucket of ["overdue", "due_soon", "later", "none"]) {
      expect(screen.getByTestId(`projects-sidebar.filter-due-${bucket}`).textContent).toContain(
        String(visibleFor(bucket)),
      )
    }
  })

  it("filters and saved views share one scroll region, the project list gets the rest in its own", () => {
    render(() => <ProjectsSidebar />)
    // Before the fix the filters and saved views were rigid siblings of the
    // list (flex items keep min-height:auto), so only the list could shrink:
    // every status, due bucket and saved view came out of the project list.
    const controls = screen.getByTestId("projects-sidebar.controls")
    expect(controls.contains(screen.getByTestId("projects-sidebar.filter-assigned-to-me"))).toBe(
      true,
    )
    expect(controls.contains(screen.getByTestId("saved-views-projects-home"))).toBe(true)
    for (const cls of ["min-h-0", "overflow-y-auto"]) {
      expect(controls.classList.contains(cls)).toBe(true)
    }
    // Unmeasured (no ResizeObserver here) the cap is half the body.
    expect(controls.style.maxHeight).toBe("50%")
    const projects = screen.getByTestId("projects-sidebar.projects")
    expect(projects.contains(controls)).toBe(false)
    // Both share the body, so the controls' 50% cap is half of the body.
    const body = screen.getByTestId("projects-sidebar.body")
    expect(controls.parentElement).toBe(body)
    expect(projects.parentElement).toBe(body)
    expect(body.classList.contains("flex-1")).toBe(true)
    for (const cls of ["flex-1", "min-h-0"]) {
      expect(projects.classList.contains(cls)).toBe(true)
    }
    // The list scrolls inside its own region, not with the controls.
    const scroller = screen.getByTestId("projects-sidebar.list").closest(".overflow-y-auto")!
    expect(projects.contains(scroller)).toBe(true)
    expect(scroller.classList.contains("overflow-y-auto")).toBe(true)
  })

  it("archived projects stay out of the list; the Archived fold fetches and lists them on demand", () => {
    state.projects = [
      { id: "p1", name: "Alpha", archivedAt: null, taskCount: 2 },
      { id: "p2", name: "Beta", archivedAt: "2026-09-20T00:00:00.000Z", taskCount: 1 },
    ]
    state.archived = [
      { id: "p2", name: "Beta", archivedAt: "2026-09-20T00:00:00.000Z", taskCount: 1 },
      { id: "p3", name: "Gamma", archivedAt: "2026-09-01T00:00:00.000Z", taskCount: 0 },
    ]
    render(() => <ProjectsSidebar />)

    expect(screen.getByTestId("projects-sidebar.row-p1")).toBeTruthy()
    expect(screen.queryByTestId("projects-sidebar.row-p2")).toBeNull()
    expect(screen.queryByTestId("projects-sidebar.archived-list")).toBeNull()

    const toggle = screen.getByTestId("projects-sidebar.archived-toggle")
    expect(toggle.getAttribute("aria-expanded")).toBe("false")
    fireEvent.click(toggle)
    expect(state.loadArchived).toHaveBeenCalledWith(state.api)
    expect(toggle.getAttribute("aria-expanded")).toBe("true")

    fireEvent.click(screen.getByTestId("projects-sidebar.archived-row-p3"))
    expect(state.openTab).toHaveBeenCalledWith({
      type: "projects:project",
      entityId: "p3",
      label: "Gamma",
    })
    expect(screen.getByTestId("projects-sidebar.archived-row-p2")).toBeTruthy()
  })

  describe("search and filters from a task tab (the list was hidden behind it)", () => {
    const onTaskTab = () => {
      state.activeTabId = "task:t1"
      state.tabs = [{ id: "task:t1", type: "projects:task", entityId: "t1" }]
    }

    it("typing in the search brings the task's project list forward, as a regular tab", () => {
      onTaskTab()
      state.taskProjectId = "p1"
      render(() => <ProjectsSidebar />)
      fireEvent.input(screen.getByTestId("projects-sidebar.search"), { target: { value: "cal" } })
      expect(state.openTab).toHaveBeenCalledWith({
        type: "projects:project",
        entityId: "p1",
        label: "Alpha",
        preview: false,
      })
    })

    it("a filter chip does the same", () => {
      onTaskTab()
      state.taskProjectId = "p1"
      render(() => <ProjectsSidebar />)
      fireEvent.click(screen.getByTestId("projects-sidebar.filter-assigned-to-me"))
      expect(state.openTab).toHaveBeenCalledWith(
        expect.objectContaining({ type: "projects:project", entityId: "p1", preview: false }),
      )
      state.openTab.mockClear()
      fireEvent.click(screen.getByTestId("projects-sidebar.filter-due-overdue"))
      expect(state.openTab).toHaveBeenCalledWith(
        expect.objectContaining({ type: "projects:project", entityId: "p1" }),
      )
    })

    it("an unknown project falls back to the projects home list", () => {
      onTaskTab()
      render(() => <ProjectsSidebar />)
      fireEvent.input(screen.getByTestId("projects-sidebar.search"), { target: { value: "x" } })
      expect(state.openTab).toHaveBeenCalledWith(
        expect.objectContaining({ type: "projects:home", preview: false }),
      )
    })

    it("on a list tab the search opens nothing", () => {
      render(() => <ProjectsSidebar />)
      fireEvent.input(screen.getByTestId("projects-sidebar.search"), { target: { value: "x" } })
      expect(state.openTab).not.toHaveBeenCalled()
    })
  })

  it("shows each project's key before its name, active and archived", () => {
    state.projects = [{ id: "p1", key: "ALP", name: "Alpha", archivedAt: null, taskCount: 2 }]
    state.archived = [
      { id: "p3", key: "GAM", name: "Gamma", archivedAt: "2026-09-01T00:00:00.000Z", taskCount: 0 },
    ]
    render(() => <ProjectsSidebar />)
    expect(screen.getByTestId("projects-sidebar.row-key-p1").textContent).toBe("ALP")
    fireEvent.click(screen.getByTestId("projects-sidebar.archived-toggle"))
    expect(screen.getByTestId("projects-sidebar.archived-row-key-p3").textContent).toBe("GAM")
  })

  describe("project groups", () => {
    const FOLDS_KEY = "liaison:projects:folded-groups:org-1:user-1"
    const grouped = () => {
      state.projects = [
        { id: "p1", name: "Zulu", group: null, archivedAt: null, taskCount: 1 },
        { id: "p2", name: "Delta", group: "Product", archivedAt: null, taskCount: 1 },
        { id: "p3", name: "Bravo", group: "Product", archivedAt: null, taskCount: 1 },
        { id: "p4", name: "Echo", group: "Legal", archivedAt: null, taskCount: 1 },
        { id: "p5", name: "Alpha", archivedAt: null, taskCount: 1 },
        {
          id: "p6",
          name: "Old",
          group: "Archive me",
          archivedAt: "2026-09-01T00:00:00.000Z",
          taskCount: 0,
        },
      ]
    }
    const rowOrder = () =>
      Array.from(screen.getByTestId("projects-sidebar.list").querySelectorAll("[data-testid]"))
        .map((el) => el.getAttribute("data-testid") ?? "")
        .filter((id) => /^projects-sidebar\.(row-p\d|group-toggle-)/.test(id))

    beforeEach(() => {
      localStorage.clear()
    })
    afterEach(() => {
      vi.restoreAllMocks()
      localStorage.clear()
    })

    it("lists ungrouped projects first without a heading, then each group alphabetically", () => {
      grouped()
      render(() => <ProjectsSidebar />)
      expect(rowOrder()).toEqual([
        "projects-sidebar.row-p5",
        "projects-sidebar.row-p1",
        "projects-sidebar.group-toggle-Legal",
        "projects-sidebar.row-p4",
        "projects-sidebar.group-toggle-Product",
        "projects-sidebar.row-p3",
        "projects-sidebar.row-p2",
      ])
      // Archived projects never form a group in the active list.
      expect(screen.queryByTestId("projects-sidebar.group-toggle-Archive me")).toBeNull()
      expect(screen.getByTestId("projects-sidebar.group-toggle-Product").textContent).toContain("2")
    })

    it("without any group the list stays flat (no heading)", () => {
      render(() => <ProjectsSidebar />)
      expect(screen.getByTestId("projects-sidebar.row-p1")).toBeTruthy()
      expect(
        screen
          .getByTestId("projects-sidebar.list")
          .querySelector('[data-testid^="projects-sidebar.group-toggle-"]'),
      ).toBeNull()
    })

    it("a group folds and unfolds, and the fold is remembered on this device", () => {
      grouped()
      render(() => <ProjectsSidebar />)
      const toggle = screen.getByTestId("projects-sidebar.group-toggle-Product")
      expect(toggle.getAttribute("aria-expanded")).toBe("true")
      fireEvent.click(toggle)
      expect(toggle.getAttribute("aria-expanded")).toBe("false")
      expect(screen.queryByTestId("projects-sidebar.row-p2")).toBeNull()
      expect(screen.queryByTestId("projects-sidebar.row-p3")).toBeNull()
      expect(screen.getByTestId("projects-sidebar.row-p4")).toBeTruthy()
      expect(JSON.parse(localStorage.getItem(FOLDS_KEY) ?? "[]")).toEqual(["Product"])

      cleanup()
      render(() => <ProjectsSidebar />)
      expect(
        screen.getByTestId("projects-sidebar.group-toggle-Product").getAttribute("aria-expanded"),
      ).toBe("false")
      expect(screen.queryByTestId("projects-sidebar.row-p2")).toBeNull()
      fireEvent.click(screen.getByTestId("projects-sidebar.group-toggle-Product"))
      expect(screen.getByTestId("projects-sidebar.row-p2")).toBeTruthy()
      expect(JSON.parse(localStorage.getItem(FOLDS_KEY) ?? "[]")).toEqual([])
    })

    it("a storage that throws still renders and folds for the session", () => {
      grouped()
      vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
        throw new Error("denied")
      })
      vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
        throw new Error("denied")
      })
      render(() => <ProjectsSidebar />)
      const toggle = screen.getByTestId("projects-sidebar.group-toggle-Legal")
      expect(toggle.getAttribute("aria-expanded")).toBe("true")
      fireEvent.click(toggle)
      expect(toggle.getAttribute("aria-expanded")).toBe("false")
      expect(screen.queryByTestId("projects-sidebar.row-p4")).toBeNull()
    })

    it("a stored fold that is not a list of names is ignored", () => {
      grouped()
      localStorage.setItem(FOLDS_KEY, '{"Product":true}')
      render(() => <ProjectsSidebar />)
      expect(screen.getByTestId("projects-sidebar.row-p2")).toBeTruthy()
    })
  })
})
