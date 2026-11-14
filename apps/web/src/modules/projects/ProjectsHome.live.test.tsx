// SPDX-License-Identifier: FSL-1.1-ALv2
// The cross-project task list (Projects home with filters, and the sidebar
// chip counts that read the same store) follows task changes made elsewhere.
import { render, waitFor } from "@solidjs/testing-library"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { EntityChangesTestAccess, notifyEntityChange } from "~/framework/entity-changes"
import { crossProjectTasksStore } from "~/modules/projects/cross-project-tasks-store"
import { ProjectsHome } from "~/modules/projects/ProjectsHome"
import { projectsFilterStore } from "~/modules/projects/projects-filter-store"
import { projectsStore } from "~/modules/projects/projects-store"
import { ApiContext } from "~/modules/shell/ApiContext"
import { attentionStore } from "~/modules/shell/attention-store"

vi.mock("~/modules/shell/tab-store", () => ({
  openTab: vi.fn(),
  tabStore: { tabs: [{ id: "home", type: "projects:home" }], activeTabId: "home" },
}))
vi.mock("~/modules/shell/saved-views/SavedViewsList", () => ({
  SavedViewsList: () => <div />,
}))

const task = (id: string) => ({
  id,
  key: id.toUpperCase(),
  title: `Task ${id}`,
  statusId: "s1",
  assigneeId: null,
  dueDate: null,
})

beforeEach(() => {
  EntityChangesTestAccess.reset()
  projectsFilterStore.clearAll()
  attentionStore._setForTest({ items: [], errors: [], loading: false, lastFetchedAt: null })
  projectsStore._setForTest({
    items: [
      {
        id: "p1",
        name: "Alpha",
        description: null,
        icon: null,
        color: null,
        ownerId: "u1",
        taskCount: 1,
        archivedAt: null,
        updatedAt: "2026-10-15T00:00:00Z",
      },
    ],
    loading: false,
    loaded: true,
    error: null,
    archived: [],
    archivedLoaded: true,
  })
})
afterEach(() => EntityChangesTestAccess.reset())

describe("ProjectsHome live cross-project tasks", () => {
  it("a task created elsewhere appears in the filtered list without a reload", async () => {
    let tasks = [task("t1")]
    const get = vi.fn(async (path: string) => {
      if (path === "/projects/p1") {
        return { id: "p1", statuses: [{ id: "s1", label: "backlog", terminal: false }] }
      }
      return { items: tasks }
    })
    const api = { get, post: vi.fn(), patch: vi.fn(), delete: vi.fn() }
    projectsFilterStore.setQuery(" ")
    const { findByTestId, queryByTestId } = render(() => (
      // biome-ignore lint/suspicious/noExplicitAny: minimal ApiClient stub
      <ApiContext.Provider value={api as any}>
        <ProjectsHome entityId="projects-home" />
      </ApiContext.Provider>
    ))
    await findByTestId("projects-home.cross-project-row-t1")
    expect(queryByTestId("projects-home.cross-project-row-t2")).toBeNull()

    tasks = [task("t1"), task("t2")]
    notifyEntityChange({
      key: "projects:task",
      app: "projects",
      entity: "task",
      action: "created",
      data: { id: "t2", projectId: "p1" },
    })
    await findByTestId("projects-home.cross-project-row-t2", {}, { timeout: 5000 })
    await waitFor(() => expect(crossProjectTasksStore.items()).toHaveLength(2))
  })

  it("an edit to a field the flat list does not show does not refetch; one it shows does", async () => {
    let tasks = [task("t1")]
    const get = vi.fn(async (path: string) => {
      if (path === "/projects/p1") {
        return { id: "p1", statuses: [{ id: "s1", label: "backlog", terminal: false }] }
      }
      return { items: tasks }
    })
    const api = { get, post: vi.fn(), patch: vi.fn(), delete: vi.fn() }
    projectsFilterStore.setQuery(" ")
    const { findByTestId } = render(() => (
      // biome-ignore lint/suspicious/noExplicitAny: minimal ApiClient stub
      <ApiContext.Provider value={api as any}>
        <ProjectsHome entityId="projects-home" />
      </ApiContext.Provider>
    ))
    await findByTestId("projects-home.cross-project-row-t1")
    const listCalls = () => get.mock.calls.filter((c) => String(c[0]).includes("/tasks")).length
    const before = listCalls()
    const updated = (changedFields: string[]) =>
      notifyEntityChange({
        key: "projects:task",
        app: "projects",
        entity: "task",
        action: "updated",
        data: { id: "t1", projectId: "p1", changedFields },
      })
    updated(["description"])
    updated(["priority", "startDate"])
    // A task field value (`fields.<key>`): the cross-project list does not show fields.
    updated(["fields.serial"])
    notifyEntityChange({
      key: "projects:task",
      app: "projects",
      entity: "task",
      action: "commented",
      data: { id: "t1", projectId: "p1" },
    })
    await new Promise((r) => setTimeout(r, 2000))
    expect(listCalls()).toBe(before)

    tasks = [{ ...task("t1"), title: "Renamed" }]
    updated(["title"])
    await waitFor(() => expect(listCalls()).toBe(before + 1), { timeout: 5000 })
  }, 15000)

  it("a label edit refetches the filtered list", async () => {
    const get = vi.fn(async (path: string) => {
      if (path === "/projects/p1") {
        return { id: "p1", statuses: [{ id: "s1", label: "backlog", terminal: false }] }
      }
      return { items: [task("t1")] }
    })
    const api = { get, post: vi.fn(), patch: vi.fn(), delete: vi.fn() }
    projectsFilterStore.setQuery(" ")
    const { findByTestId } = render(() => (
      // biome-ignore lint/suspicious/noExplicitAny: minimal ApiClient stub
      <ApiContext.Provider value={api as any}>
        <ProjectsHome entityId="projects-home" />
      </ApiContext.Provider>
    ))
    await findByTestId("projects-home.cross-project-row-t1")
    const listCalls = () => get.mock.calls.filter((c) => String(c[0]).includes("/tasks")).length
    const before = listCalls()
    notifyEntityChange({
      key: "projects:task",
      app: "projects",
      entity: "task",
      action: "updated",
      data: { id: "t1", projectId: "p1", changedFields: ["labels"] },
    })
    await waitFor(() => expect(listCalls()).toBe(before + 1), { timeout: 5000 })
  }, 15000)
})

describe("ProjectsHome cross-project rows and time and budgets", () => {
  it("a row shows Planned only when its task carries a timebox", async () => {
    const get = vi.fn(async (path: string) => {
      if (path === "/projects/p1") {
        return { id: "p1", statuses: [{ id: "s1", label: "backlog", terminal: false }] }
      }
      return { items: [{ ...task("t1"), timeboxMinutes: 960 }, task("t2")] }
    })
    const api = { get, post: vi.fn(), patch: vi.fn(), delete: vi.fn() }
    projectsFilterStore.setQuery(" ")
    const { findByTestId, queryByTestId } = render(() => (
      // biome-ignore lint/suspicious/noExplicitAny: minimal ApiClient stub
      <ApiContext.Provider value={api as any}>
        <ProjectsHome entityId="projects-home" />
      </ApiContext.Provider>
    ))
    const planned = await findByTestId("projects-home.row-planned-t1")
    expect(planned.textContent).toBe("Planned 16 h")
    await findByTestId("projects-home.cross-project-row-t2")
    expect(queryByTestId("projects-home.row-planned-t2")).toBeNull()
  })
})
