// SPDX-License-Identifier: FSL-1.1-ALv2
import type { AttentionItem } from "@liaison/shared"
import { fireEvent, render, screen, waitFor } from "@solidjs/testing-library"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { editorOf, typeInto } from "~/modules/editor/test-helpers"
import { ensureLabelCatalog } from "~/modules/projects/label-catalog-store"
import { ProjectsHome } from "~/modules/projects/ProjectsHome"
import { ProjectsSidebar } from "~/modules/projects/ProjectsSidebar"
import {
  projectsFilterStore,
  registerTaskLabelSanitizer,
} from "~/modules/projects/projects-filter-store"
import { type Project, projectsStore } from "~/modules/projects/projects-store"
import { sanitizeLabelFilter } from "~/modules/projects/task-labels"
import { ApiContext } from "~/modules/shell/ApiContext"
import { attentionStore } from "~/modules/shell/attention-store"

vi.mock("~/modules/shell/tab-store", () => ({
  openTab: vi.fn(),
  tabStore: {
    tabs: [{ id: "home", type: "projects:home" }] as Array<{
      id: string
      type: string
      entityId?: string
    }>,
    activeTabId: "home" as string | null,
  },
}))
vi.mock("~/modules/shell/saved-views/SavedViewsList", () => ({
  SavedViewsList: (props: { app: string; viewId: string }) => (
    <div data-testid={`saved-views-${props.app}-${props.viewId}`} />
  ),
}))

// the label catalog, mutable per test (pinned store shape of task 10).
const catalog = vi.hoisted(() => ({
  loaded: true,
  failed: false,
  groups: [
    {
      id: "g-nature",
      name: "Nature",
      sortOrder: 0,
      archivedAt: null as string | null,
      values: [
        {
          id: "v-bug",
          groupId: "g-nature",
          name: "bug",
          sortOrder: 0,
          archivedAt: null as string | null,
          archived: false,
        },
      ],
    },
  ],
}))
vi.mock("~/modules/projects/label-catalog-store", () => ({
  labelCatalog: {
    get groups() {
      return catalog.groups
    },
    get loaded() {
      return catalog.loaded
    },
    loading: false,
    get failed() {
      return catalog.failed
    },
    liveGroups: () => catalog.groups,
    groupOrder: () => catalog.groups.map((g) => g.id),
    group: (id: string) => catalog.groups.find((g) => g.id === id),
    value: () => undefined,
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

function makeApi(overrides: Partial<Record<"get" | "post", ReturnType<typeof vi.fn>>> = {}) {
  return {
    get: overrides.get ?? vi.fn().mockResolvedValue({ items: [] }),
    post: overrides.post ?? vi.fn(),
    patch: vi.fn(),
    delete: vi.fn(),
    getEnvelope: vi.fn(),
  } as any
}

function makeProject(overrides: Partial<Project>): Project {
  return {
    id: overrides.id ?? "p1",
    name: overrides.name ?? "Project",
    description: overrides.description ?? null,
    icon: overrides.icon ?? "FolderKanban",
    color: overrides.color ?? "var(--avatar-0-bg)",
    ownerId: overrides.ownerId ?? "u1",
    owner: overrides.owner ?? {
      id: overrides.ownerId ?? "u1",
      name: "Marie Curie",
      avatarUrl: null,
    },
    taskCount: overrides.taskCount ?? 0,
    archivedAt: overrides.archivedAt ?? null,
    updatedAt: overrides.updatedAt ?? "2026-05-06T12:00:00.000Z",
  }
}

function makeAttention(projectId: string, id: string): AttentionItem {
  return {
    id,
    app: "projects",
    entity: "task",
    entityId: id,
    kind: "task_overdue",
    summary: "Overdue task",
    urgency: 80,
    occurredAt: "2026-05-06T12:00:00.000Z",
    action: { type: "open_entity", tabType: "projects:task", entityId: id },
    metadata: { projectId },
  }
}

function renderHome(api = makeApi()) {
  return render(() => (
    <ApiContext.Provider value={api}>
      <ProjectsHome entityId="projects-home" />
    </ApiContext.Provider>
  ))
}

beforeEach(() => {
  catalog.loaded = true
  catalog.failed = false
  projectsFilterStore.clearAll()
  projectsStore._setForTest({
    items: [],
    loading: false,
    loaded: true,
    error: null,
    archived: [],
    archivedLoaded: false,
  })
  attentionStore._setForTest({ items: [], errors: [], loading: false, lastFetchedAt: null })
  vi.clearAllMocks()
})

describe("ProjectsHome", () => {
  it("projects.home.default-list-shows-owner-task-and-attention-counts", () => {
    projectsStore._setForTest({
      items: [
        makeProject({
          id: "p-old",
          name: "Old Project",
          ownerId: "u2",
          owner: { id: "u2", name: "Ada Lovelace", avatarUrl: null },
          taskCount: 2,
          updatedAt: "2026-05-05T12:00:00.000Z",
        }),
        makeProject({
          id: "p-new",
          name: "New Project",
          taskCount: 7,
          updatedAt: "2026-05-06T12:00:00.000Z",
        }),
        makeProject({ id: "p-archived", name: "Archived", archivedAt: "2026-05-06T13:00:00.000Z" }),
      ],
    })
    attentionStore._setForTest({
      items: [
        makeAttention("p-new", "a1"),
        makeAttention("p-new", "a2"),
        makeAttention("p-old", "a3"),
      ],
    })

    const { container, getByTestId, getByText, queryByTestId } = renderHome()

    const rows = Array.from(container.querySelectorAll("button[data-testid^='projects-home-row-']"))
    expect(rows.map((row) => row.getAttribute("data-testid"))).toEqual([
      "projects-home-row-p-new",
      "projects-home-row-p-old",
    ])
    expect(getByTestId("projects-home-row-p-new-attention").textContent).toBe("2")
    expect(getByTestId("projects-home-row-p-old-attention").textContent).toBe("1")
    expect(getByTestId("projects-home-row-p-new-task-count").textContent).toBe("7 tasks")
    expect(getByText("MC")).toBeInTheDocument()
    expect(queryByTestId("projects-home-row-p-archived")).toBeNull()
  })

  it("renders every project through ResponsiveList as a desktop row plus a phone card", () => {
    projectsStore._setForTest({
      items: [makeProject({ id: "p-new", name: "New Project", taskCount: 7 })],
    })
    const { getByTestId } = renderHome()
    const row = getByTestId("projects-home-row-p-new").closest("[data-responsive=row]")
    expect(row).toBeTruthy()
    expect(row?.className).toContain("md:table-row")
    const card = getByTestId("projects-home-card-p-new")
    expect(card.closest("[data-responsive=card]")?.className).toContain("md:hidden")
    // The project name anchors the card.
    expect(getByTestId("projects-home-card-name-p-new").textContent).toContain("New Project")
  })

  // Walk D68 at 390: a guided tour opens the project its run created by its
  // id; the phone card carried none, so the tour never opened it.
  it("the phone card, like the row, says which project it opens", () => {
    projectsStore._setForTest({ items: [makeProject({ id: "p-new", name: "New Project" })] })
    const { getByTestId } = renderHome()
    expect(getByTestId("projects-home-row-p-new").getAttribute("data-project-id")).toBe("p-new")
    expect(getByTestId("projects-home-card-p-new").getAttribute("data-project-id")).toBe("p-new")
  })

  it("a project without an icon shows the project glyph, not an empty box that reads as a checkbox", () => {
    projectsStore._setForTest({
      items: [
        { ...makeProject({ id: "p-none", name: "Created by the agent" }), icon: null },
        makeProject({ id: "p-legacy", name: "Picked the square", icon: "Square" }),
        makeProject({ id: "p-star", name: "Starred", icon: "Star" }),
      ],
    })

    const { container, getByTestId } = renderHome()

    for (const id of ["p-none", "p-legacy"]) {
      const svg = getByTestId(`projects-home-row-${id}-icon`).querySelector("svg")
      expect(svg?.getAttribute("class")).toContain("lucide-folder-kanban")
    }
    expect(
      getByTestId("projects-home-row-p-star-icon").querySelector("svg")?.getAttribute("class"),
    ).toContain("lucide-star")
    expect(container.querySelector("svg.lucide-square")).toBeNull()
    expect(container.querySelector("input[type=checkbox], [role=checkbox]")).toBeNull()
  })

  it("the new project icon picker does not offer the checkbox-like square", () => {
    renderHome()
    fireEvent.click(screen.getByTestId("projects-home.new-project"))
    expect(screen.getByTestId("projects-home.new-project-icon-FolderKanban")).toBeInTheDocument()
    expect(screen.queryByTestId("projects-home.new-project-icon-Square")).toBeNull()
  })

  it("the header counts the archived projects the sidebar fold fetched, not only this session's", () => {
    projectsStore._setForTest({
      items: [makeProject({ id: "p-live", name: "Live" })],
      archived: [
        makeProject({ id: "p-a1", name: "Old one", archivedAt: "2026-09-01T00:00:00.000Z" }),
        makeProject({ id: "p-a2", name: "Older", archivedAt: "2026-08-01T00:00:00.000Z" }),
      ],
      archivedLoaded: true,
    })

    const { getByTestId, queryByTestId } = renderHome()

    expect(getByTestId("projects-home.archived-count").textContent?.trim()).toBe("2")
    expect(queryByTestId("projects-home-row-p-a1")).toBeNull()
    expect(getByTestId("projects-home-row-p-live")).toBeInTheDocument()
  })

  it("on a fresh load the home fetches the archived fold and counts it", async () => {
    projectsStore._setForTest({ items: [makeProject({ id: "p-live", name: "Live" })] })
    const get = vi.fn(async (url: string) =>
      url.includes("archived=only")
        ? {
            items: [
              makeProject({ id: "p-a1", name: "Gone", archivedAt: "2026-09-01T00:00:00.000Z" }),
            ],
          }
        : { items: [] },
    )

    const { findByTestId } = renderHome(makeApi({ get }))

    expect((await findByTestId("projects-home.archived-count")).textContent?.trim()).toBe("1")
    expect(get).toHaveBeenCalledWith(expect.stringContaining("archived=only"))
  })

  it("a single task card reads 1 task", () => {
    projectsStore._setForTest({
      items: [makeProject({ id: "p-solo", name: "Support Shipments", taskCount: 1 })],
    })

    const { getByTestId } = renderHome()

    expect(getByTestId("projects-home-row-p-solo-task-count").textContent).toBe("1 task")
  })

  it("typing a task key in the cross-project search finds that task", async () => {
    projectsStore._setForTest({
      items: [makeProject({ id: "p1", name: "Tessera bugs", taskCount: 2 })],
    })
    const get = vi.fn(async (path: string) => {
      if (path === "/projects/p1") {
        return { id: "p1", statuses: [{ id: "s1", label: "backlog", terminal: false }] }
      }
      return {
        items: [
          {
            id: "t-match",
            key: "ERB-3",
            title: "Fix the sync gate",
            statusId: "s1",
            assigneeId: null,
            dueDate: null,
          },
          {
            id: "t-other",
            key: "ERB-4",
            title: "Unrelated",
            statusId: "s1",
            assigneeId: null,
            dueDate: null,
          },
        ],
      }
    })
    const api = makeApi({ get })
    projectsFilterStore.setQuery("erb-3")

    const { findByTestId, queryByTestId } = renderHome(api)

    await waitFor(() => expect(get).toHaveBeenCalled())
    await findByTestId("projects-home.cross-project-row-t-match")
    expect(queryByTestId("projects-home.cross-project-row-t-other")).toBeNull()
  })

  it("cross-project rows render pretty status labels", async () => {
    projectsStore._setForTest({
      items: [makeProject({ id: "p1", name: "Tessera bugs", taskCount: 1 })],
    })
    const get = vi.fn(async (path: string) => {
      if (path === "/projects/p1") {
        return { id: "p1", statuses: [{ id: "s1", label: "in_progress", terminal: false }] }
      }
      return {
        items: [
          {
            id: "t1",
            key: "ERB-1",
            title: "First",
            statusId: "s1",
            assigneeId: null,
            dueDate: null,
          },
        ],
      }
    })
    const api = makeApi({ get })
    projectsFilterStore.setQuery(" ")

    const { findByTestId } = renderHome(api)

    const row = await findByTestId("projects-home.cross-project-row-t1")
    expect(row.textContent).toContain("In progress")
    expect(row.textContent).not.toContain("IN_PROGRESS")
    expect(row.textContent).not.toContain("in_progress")
  })

  it("Recently involved lists the server's involved tasks newest first, each with its reason", async () => {
    projectsStore._setForTest({
      items: [makeProject({ id: "p1", name: "Board", taskCount: 2 })],
    })
    const recent = new Date(Date.now() - 2 * 3600_000).toISOString()
    const older = new Date(Date.now() - 3 * 86400_000).toISOString()
    const involvement = (kind: string, at: string, extra: Record<string, unknown> = {}) => ({
      kind,
      at,
      viaAgent: false,
      actorName: null,
      statusLabel: null,
      assigneeName: null,
      projectName: null,
      fields: [],
      summary: "",
      ...extra,
    })
    const get = vi.fn(async (path: string) => {
      if (path.startsWith("/projects/involved?")) {
        return {
          items: [
            {
              id: "t-new",
              key: "BRD-2",
              title: "Moved one",
              projectId: "p1",
              projectName: "Board",
              statusId: "s2",
              statusLabel: "Done",
              statusTerminal: true,
              assigneeId: null,
              dueDate: null,
              involvement: involvement("status_changed", recent, { statusLabel: "Done" }),
            },
            {
              id: "t-old",
              key: "BRD-1",
              title: "Mentioned one",
              projectId: "p1",
              projectName: "Board",
              statusId: "s1",
              statusLabel: "Todo",
              statusTerminal: false,
              assigneeId: null,
              dueDate: null,
              involvement: involvement("mentioned", older, { actorName: "Riley" }),
            },
          ],
        }
      }
      throw new Error(`unexpected ${path}`)
    })
    projectsFilterStore.toggleInvolved()

    const { findByTestId } = renderHome(makeApi({ get }))

    await findByTestId("projects-home.cross-project-row-t-new")
    const called = get.mock.calls.map((c) => c[0] as string)
    expect(called.some((p) => p.startsWith("/projects/involved?") && p.includes("days=14"))).toBe(
      true,
    )
    // One request across projects, not one pair per project.
    expect(called.some((p) => p.startsWith("/projects/p1"))).toBe(false)
    const rows = screen.getAllByTestId(/^projects-home\.cross-project-row-/)
    expect(rows.map((r) => r.getAttribute("data-testid"))).toEqual([
      "projects-home.cross-project-row-t-new",
      "projects-home.cross-project-row-t-old",
    ])
    expect(screen.getByTestId("projects-home.involvement-t-new").textContent).toContain(
      "You moved it to Done",
    )
    expect(screen.getByTestId("projects-home.involvement-t-old").textContent).toContain(
      "Riley mentioned you",
    )
  })

  it("home filter chips carry counts matching visible rows", async () => {
    projectsStore._setForTest({
      items: [makeProject({ id: "p1", name: "Tessera bugs", taskCount: 2 })],
    })
    const get = vi.fn(async (path: string) => {
      if (path === "/projects/p1") {
        return {
          id: "p1",
          statuses: [
            { id: "s1", label: "backlog", terminal: false },
            { id: "s2", label: "done", terminal: true },
          ],
        }
      }
      return {
        items: [
          {
            id: "t1",
            key: "ERB-1",
            title: "First",
            statusId: "s1",
            assigneeId: null,
            dueDate: null,
          },
          {
            id: "t2",
            key: "ERB-2",
            title: "Second",
            statusId: "s1",
            assigneeId: null,
            dueDate: null,
          },
          {
            id: "t3",
            key: "ERB-3",
            title: "Third",
            statusId: "s2",
            assigneeId: null,
            dueDate: null,
          },
        ],
      }
    })
    const api = makeApi({ get })
    // A whitespace-only query activates cross-project filtering (isActive)
    // while matching every row (taskMatchesQuery trims before comparing) —
    // deterministic without depending on any task's title text.
    projectsFilterStore.setQuery(" ")

    render(() => (
      <ApiContext.Provider value={api}>
        <ProjectsSidebar />
        <ProjectsHome entityId="projects-home" />
      </ApiContext.Provider>
    ))

    await waitFor(() => expect(get).toHaveBeenCalled())
    await waitFor(() =>
      expect(screen.getAllByTestId(/^projects-home\.cross-project-row-/)).toHaveLength(3),
    )

    const backlogChip = screen.getByTestId("projects-sidebar.filter-status-backlog")
    expect(backlogChip.textContent).toContain("2")
    const doneChip = screen.getByTestId("projects-sidebar.filter-status-done")
    expect(doneChip.textContent).toContain("1")
  })

  it("home due chips show no count when no filter is active", async () => {
    projectsStore._setForTest({
      items: [makeProject({ id: "p1", name: "Tessera bugs", taskCount: 2 })],
    })
    const get = vi.fn(async (path: string) => {
      if (path === "/projects/p1") {
        return {
          id: "p1",
          statuses: [
            { id: "s1", label: "backlog", terminal: false },
            { id: "s2", label: "done", terminal: true },
          ],
        }
      }
      return {
        items: [
          {
            id: "t1",
            key: "ERB-1",
            title: "First",
            statusId: "s1",
            assigneeId: null,
            dueDate: null,
          },
        ],
      }
    })
    const api = makeApi({ get })
    // No filter active (query cleared in beforeEach) -- there is no
    // cross-project task endpoint, so the sidebar has not fetched any rows
    // to count from, and the chips must abstain rather than show a number
    // that could disagree with the list once a filter is chosen.

    render(() => (
      <ApiContext.Provider value={api}>
        <ProjectsSidebar />
        <ProjectsHome entityId="projects-home" />
      </ApiContext.Provider>
    ))

    const overdueChip = screen.getByTestId("projects-sidebar.filter-due-overdue")
    const dueSoonChip = screen.getByTestId("projects-sidebar.filter-due-due_soon")
    const laterChip = screen.getByTestId("projects-sidebar.filter-due-later")
    const noneChip = screen.getByTestId("projects-sidebar.filter-due-none")
    for (const chip of [overdueChip, dueSoonChip, laterChip, noneChip]) {
      expect(chip.textContent).not.toMatch(/\d/)
    }
  })

  it("projects.home.create-project-posts-description-icon-and-color", async () => {
    const post = vi.fn().mockResolvedValue({ id: "created", name: "Roadmap" })
    const api = makeApi({ post })
    renderHome(api)

    fireEvent.click(screen.getByTestId("projects-home.new-project"))
    fireEvent.input(screen.getByTestId("projects-home.new-project-name"), {
      target: { value: "Roadmap" },
    })
    const description = await screen.findByTestId("projects-home.new-project-description")
    typeInto(editorOf(description), "**Quarterly** work")
    fireEvent.click(screen.getByTestId("projects-home.new-project-icon-Ticket"))
    fireEvent.click(screen.getByTestId("projects-home.new-project-color-3"))
    fireEvent.click(screen.getByTestId("projects-home.new-project-confirm"))

    await waitFor(() =>
      expect(post).toHaveBeenCalledWith("/projects", {
        name: "Roadmap",
        description: "**Quarterly** work",
        icon: "Ticket",
        color: "var(--avatar-3-bg)",
      }),
    )
  })

  it("projects.home.create-project-posts-the-columns-the-user-typed", async () => {
    // A roadmap asked for as "Idea, In discussion, …, Done" is created with
    // those columns — not with the defaults and a rename chore afterwards.
    const post = vi.fn().mockResolvedValue({ id: "created", name: "Roadmap" })
    const api = makeApi({ post })
    renderHome(api)

    fireEvent.click(screen.getByTestId("projects-home.new-project"))
    fireEvent.input(screen.getByTestId("projects-home.new-project-name"), {
      target: { value: "Roadmap" },
    })
    fireEvent.input(screen.getByTestId("projects-home.new-project-columns"), {
      target: { value: " Idea, In discussion ,Candidate,, Done " },
    })
    fireEvent.click(screen.getByTestId("projects-home.new-project-confirm"))

    await waitFor(() =>
      expect(post).toHaveBeenCalledWith(
        "/projects",
        expect.objectContaining({
          name: "Roadmap",
          statuses: [
            { label: "Idea" },
            { label: "In discussion" },
            { label: "Candidate" },
            { label: "Done" },
          ],
        }),
      ),
    )
  })
})

describe("ProjectsHome label filter", () => {
  function setup() {
    projectsStore._setForTest({
      items: [
        makeProject({ id: "p1", name: "One", taskCount: 1 }),
        makeProject({ id: "p2", name: "Two", taskCount: 1 }),
      ],
    })
    const get = vi.fn(async (path: string) => {
      if (!path.includes("/tasks")) {
        return { id: path.split("/")[2], statuses: [{ id: "s1", label: "todo", terminal: false }] }
      }
      return { items: [] }
    })
    renderHome(makeApi({ get }))
    const taskCalls = () =>
      get.mock.calls.map((c) => String(c[0])).filter((path) => path.includes("/tasks"))
    return { get, taskCalls }
  }

  it("every per-project task fetch carries the label filter, with the release", async () => {
    projectsFilterStore.setRelease("2.1.0")
    projectsFilterStore.setTaskLabel("g-nature", "v-bug")
    const { taskCalls } = setup()
    const encoded = encodeURIComponent(JSON.stringify({ "g-nature": "v-bug" }))
    await waitFor(() => expect(taskCalls().length).toBeGreaterThanOrEqual(2))
    for (const id of ["p1", "p2"]) {
      expect(taskCalls()).toContain(`/projects/${id}/tasks?release=2.1.0&labels=${encoded}`)
    }
  })

  it("changing the label filter fetches again", async () => {
    projectsFilterStore.setTaskLabel("g-nature", "v-bug")
    const { taskCalls } = setup()
    await waitFor(() => expect(taskCalls().length).toBe(2))
    projectsFilterStore.setTaskLabel("g-nature", "__none__")
    const encoded = encodeURIComponent(JSON.stringify({ "g-nature": "__none__" }))
    await waitFor(() => expect(taskCalls()).toContain(`/projects/p1/tasks?labels=${encoded}`))
  })

  it("without a catalog the raw filter is sent as is", async () => {
    catalog.loaded = false
    catalog.failed = true
    projectsFilterStore.setTaskLabel("g-gone", "v-x")
    const { taskCalls } = setup()
    const encoded = encodeURIComponent(JSON.stringify({ "g-gone": "v-x" }))
    await waitFor(() => expect(taskCalls()).toContain(`/projects/p1/tasks?labels=${encoded}`))
  })

  it("keys the catalog does not know are dropped: a filter left empty fetches nothing", async () => {
    // What the real catalog store registers on the filter store.
    registerTaskLabelSanitizer((raw) =>
      catalog.loaded ? sanitizeLabelFilter(raw, catalog.groups) : raw,
    )
    try {
      projectsFilterStore.setTaskLabel("g-gone", "v-x")
      expect(projectsFilterStore.isActive).toBe(false)
      const { taskCalls } = setup()
      await new Promise((r) => setTimeout(r, 20))
      expect(taskCalls()).toEqual([])

      // With a real filter beside it, only the known key goes out.
      projectsFilterStore.setTaskLabel("g-nature", "v-bug")
      const encoded = encodeURIComponent(JSON.stringify({ "g-nature": "v-bug" }))
      await waitFor(() => expect(taskCalls()).toContain(`/projects/p1/tasks?labels=${encoded}`))
    } finally {
      registerTaskLabelSanitizer(null)
    }
  })

  it("loads the label catalog only when a label filter is set", async () => {
    projectsFilterStore.setRelease("2.1.0")
    const { taskCalls } = setup()
    await waitFor(() => expect(taskCalls().length).toBe(2))
    expect(ensureLabelCatalog).not.toHaveBeenCalled()
    projectsFilterStore.setTaskLabel("g-nature", "v-bug")
    await waitFor(() => expect(ensureLabelCatalog).toHaveBeenCalled())
  })

  it("a project answering label_not_found is skipped; the others still list their rows", async () => {
    projectsStore._setForTest({
      items: [
        makeProject({ id: "p1", name: "One", taskCount: 1 }),
        makeProject({ id: "p2", name: "Two", taskCount: 1 }),
      ],
    })
    const get = vi.fn(async (path: string) => {
      if (!path.includes("/tasks")) {
        return { id: path.split("/")[2], statuses: [{ id: "s1", label: "todo", terminal: false }] }
      }
      if (path.startsWith("/projects/p1/")) {
        throw Object.assign(new Error("Label group not found"), { code: "label_not_found" })
      }
      return {
        items: [
          {
            id: "t2",
            key: "TWO-1",
            title: "Second project task",
            statusId: "s1",
            assigneeId: null,
            dueDate: null,
          },
        ],
      }
    })
    projectsFilterStore.setTaskLabel("g-nature", "v-bug")
    renderHome(makeApi({ get }))
    expect(await screen.findByText("Second project task")).toBeTruthy()
  })
  it("projects.home.new-project-has-one-time-switch-off-by-default-and-posts-it-only-when-on", async () => {
    const post = vi.fn().mockResolvedValue({ id: "created", name: "Roadmap" })
    renderHome(makeApi({ post }))

    fireEvent.click(screen.getByTestId("projects-home.new-project"))
    fireEvent.input(screen.getByTestId("projects-home.new-project-name"), {
      target: { value: "Roadmap" },
    })
    const sw = screen.getByTestId(
      "projects-home.new-project.time-budgets-switch",
    ) as HTMLInputElement
    expect(sw.checked).toBe(false)
    fireEvent.click(screen.getByTestId("projects-home.new-project-confirm"))
    await waitFor(() => expect(post).toHaveBeenCalledTimes(1))
    expect(post.mock.calls[0]?.[1]).not.toHaveProperty("timeBudgets")
  })

  it("projects.home.new-project-time-switch-on-posts-time-budgets-true", async () => {
    const post = vi.fn().mockResolvedValue({ id: "created", name: "Roadmap" })
    renderHome(makeApi({ post }))

    fireEvent.click(screen.getByTestId("projects-home.new-project"))
    fireEvent.input(screen.getByTestId("projects-home.new-project-name"), {
      target: { value: "Roadmap" },
    })
    fireEvent.click(screen.getByTestId("projects-home.new-project.time-budgets-switch"))
    fireEvent.click(screen.getByTestId("projects-home.new-project-confirm"))
    await waitFor(() =>
      expect(post).toHaveBeenCalledWith(
        "/projects",
        expect.objectContaining({ timeBudgets: true }),
      ),
    )
  })
})
