// SPDX-License-Identifier: FSL-1.1-ALv2
import { fireEvent, render, screen, waitFor } from "@solidjs/testing-library"
import { beforeEach, describe, expect, it, vi } from "vitest"
import {
  registerContribution,
  registerTabType,
  resetRegistry,
  unregisterContributions,
} from "~/framework/app-registry"
import type { ApiClient } from "~/lib/api-client"
import { ApiError } from "~/lib/api-error"
import { installAudioContext, installMic, removeMic } from "~/modules/assist/dictation-fakes"
import { editorOf } from "~/modules/editor/test-helpers"
import { resetChecklistStore } from "~/modules/projects/checklist-store"
import { type ProjectDetail, projectStore } from "~/modules/projects/project-store"
import { TaskDetail } from "~/modules/projects/TaskDetail"
import { ApiContext } from "~/modules/shell/ApiContext"
import { closeTab } from "~/modules/shell/tab-store"
import { addToast } from "~/modules/shell/toast-store"

vi.mock("~/modules/projects/TaskDiscussion", () => ({
  default: (props: { threadId: string }) => (
    <div data-testid="mock-task-discussion">{props.threadId}</div>
  ),
}))

vi.mock("~/modules/shell/tab-store", () => ({
  openTab: vi.fn(),
  closeTab: vi.fn(),
  makeTabId: (type: string, entityId: string) => `${type}:${entityId}`,
}))

const uploads = vi.hoisted(() => [] as string[])
vi.mock("~/modules/files/file-service", async (importOriginal) => ({
  ...(await importOriginal<typeof import("~/modules/files/file-service")>()),
  uploadFile: async (
    _api: unknown,
    file: File,
    parent: { entityType: string; entityId: string },
  ) => {
    uploads.push(`${file.name}@${parent.entityType}:${parent.entityId}`)
    return { id: "f1", filename: file.name, sizeBytes: 1, mimeType: file.type, thumbnailKey: null }
  },
}))

vi.mock("~/modules/shell/toast-store", () => ({
  addToast: vi.fn(),
}))

// one live label group, Nature {bug, evolution}, in the pinned catalog shape.
const labelGroups = vi.hoisted(() => [
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
      {
        id: "v-evo",
        groupId: "g-nature",
        name: "evolution",
        sortOrder: 1,
        archivedAt: null as string | null,
        archived: false,
      },
    ],
  },
])
vi.mock("~/modules/projects/label-catalog-store", () => ({
  labelCatalog: {
    get groups() {
      return labelGroups
    },
    loaded: true,
    loading: false,
    failed: false,
    liveGroups: () => labelGroups,
    groupOrder: () => labelGroups.map((g) => g.id),
    group: (id: string) => labelGroups.find((g) => g.id === id),
    value: (groupId: string, valueId: string) =>
      labelGroups.find((g) => g.id === groupId)?.values.find((v) => v.id === valueId),
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

const project = (): ProjectDetail => ({
  id: "p1",
  name: "Bug Tracker",
  description: null,
  icon: null,
  color: null,
  ownerId: "u1",
  archivedAt: null,
  createdAt: "2026-05-06T00:00:00Z",
  updatedAt: "2026-05-06T00:00:00Z",
  statuses: [{ id: "s1", projectId: "p1", label: "Todo", color: null, order: 0, terminal: false }],
})

const task = () => ({
  id: "t1",
  projectId: "p1",
  title: "Fix billing import",
  description: "Reconcile invoices",
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
  createdAt: "2026-05-06T00:00:00Z",
  updatedAt: "2026-05-06T00:00:00Z",
  childCount: 0,
})

beforeEach(() => {
  resetChecklistStore()
  projectStore._resetForTest()
  projectStore._setForTest({ projectId: "p1", current: project(), tasks: [] })
  vi.clearAllMocks()
})

describe("TaskDetail", () => {
  it("shows the tabs and actions other apps add to the task, each with the task id", async () => {
    for (const [slot, id] of [
      ["project:task:tabs", "fixture-tab"],
      ["project:task:actions", "fixture-action"],
    ] as const) {
      registerContribution(slot, {
        appId: "fixture-app",
        id,
        label: id,
        component: (props) => <span data-testid={id}>{props.entityId}</span>,
      })
    }
    const api = {
      post: vi.fn().mockResolvedValue(task()),
      get: vi.fn(async (path: string) => {
        if (path === "/v1/slots/project:task:tabs") {
          return { panels: [{ id: "fixture-tab", app: "fixture-app", label: "Tab" }] }
        }
        if (path === "/v1/slots/project:task:actions") {
          return { panels: [{ id: "fixture-action", app: "fixture-app", label: "Act" }] }
        }
        return { id: "thread-1", hiddenFromList: true }
      }),
      patch: vi.fn(),
      delete: vi.fn(),
      getEnvelope: vi.fn(),
    } as any
    try {
      render(() => (
        <ApiContext.Provider value={api}>
          <TaskDetail entityId="t1" />
        </ApiContext.Provider>
      ))
      expect((await screen.findByTestId("fixture-tab")).textContent).toBe("t1")
      const action = await screen.findByTestId("fixture-action")
      expect(action.textContent).toBe("t1")
      expect(screen.getByTestId("task-detail.meta-row").contains(action)).toBe(true)
    } finally {
      unregisterContributions("fixture-app")
    }
  })

  describe("author line", () => {
    const apiFor = (row: Record<string, unknown>) =>
      ({
        post: vi.fn().mockResolvedValue(row),
        get: vi.fn().mockResolvedValue({ id: "thread-1", hiddenFromList: true }),
        patch: vi.fn(),
        delete: vi.fn(),
        getEnvelope: vi.fn(),
      }) as any

    it("names the person who created the task, with the date", async () => {
      const api = apiFor({ ...task(), createdByName: "Ada Fabrikam", createdByAgentLabel: null })
      const { getByTestId } = render(() => (
        <ApiContext.Provider value={api}>
          <TaskDetail entityId="t1" />
        </ApiContext.Provider>
      ))
      await waitFor(() => expect(getByTestId("task-detail.created-by")).toBeTruthy())
      const line = getByTestId("task-detail.created-by")
      expect(line.textContent).toContain("Created by Ada Fabrikam")
      expect(line.textContent).toContain("2026")
      expect(line.getAttribute("data-agent")).toBeNull()
    })

    it("names the agent when an agent created it", async () => {
      const api = apiFor({
        ...task(),
        createdByName: "Ada Fabrikam",
        createdByAgentLabel: "Routine Weekly triage",
      })
      const { getByTestId } = render(() => (
        <ApiContext.Provider value={api}>
          <TaskDetail entityId="t1" />
        </ApiContext.Provider>
      ))
      await waitFor(() => expect(getByTestId("task-detail.created-by")).toBeTruthy())
      const line = getByTestId("task-detail.created-by")
      expect(line.textContent).toContain("Created by Routine Weekly triage")
      expect(line.textContent).not.toContain("Ada Fabrikam")
      expect(line.getAttribute("data-agent")).toBe("true")
    })
  })

  it("a task the reader may not see (a notification's, a link's) shows Task not found", async () => {
    const api = {
      post: vi.fn().mockRejectedValue(new ApiError("Task not found", 404, "not_found")),
      get: vi.fn(),
      patch: vi.fn(),
      delete: vi.fn(),
      getEnvelope: vi.fn(),
    } as any
    const { getByTestId, queryByTestId } = render(() => (
      <ApiContext.Provider value={api}>
        <TaskDetail entityId="t-hidden" />
      </ApiContext.Provider>
    ))
    await waitFor(() => expect(getByTestId("task-detail.not-found")).toBeTruthy())
    expect(getByTestId("task-detail.not-found").textContent).toBe("Task not found")
    expect(queryByTestId("task-detail.loading")).toBeNull()
  })

  it("projects.task-detail.two-pane-layout", async () => {
    const api = {
      post: vi.fn().mockResolvedValue(task()),
      get: vi.fn().mockResolvedValue({ id: "thread-1", hiddenFromList: true }),
      patch: vi.fn(),
      delete: vi.fn(),
      getEnvelope: vi.fn(),
    } as any

    const { getByTestId } = render(() => (
      <ApiContext.Provider value={api}>
        <TaskDetail entityId="t1" />
      </ApiContext.Provider>
    ))

    await waitFor(() => expect(getByTestId("task-detail.layout")).toBeTruthy())
    expect(getByTestId("task-detail.layout").className).toContain(
      "grid-cols-[minmax(480px,1fr)_380px]",
    )
    expect(getByTestId("task-detail.content-pane").className).toContain("min-w-[480px]")
    expect(getByTestId("task-detail.thread-pane").className).toContain("w-[380px]")
    // The rail is a chat column: no scroll of its own (its comments scroll
    // above the box), and its bottom keeps the box clear of the dock's bar.
    const pane = getByTestId("task-detail.thread-pane")
    expect(pane.className).toContain("@[860px]:overflow-hidden")
    expect(pane.style.getPropertyValue("padding-bottom")).toContain("var(--shell-dock-strip")
    // Only the bar: an open dock window does not lift the comment box up the rail.
    expect(pane.className).not.toContain("pb-dock-window-clearance")
    expect(
      getByTestId("task-detail.thread-pane").querySelector("[data-testid='task-detail.thread']"),
    ).toBeTruthy()
    expect(
      getByTestId("task-detail.content-pane").querySelector(
        "[data-testid='task-detail.discussion']",
      ),
    ).toBeNull()
  })

  it("the empty due date control reads Add due date", async () => {
    const api = {
      post: vi.fn().mockResolvedValue(task()),
      get: vi.fn().mockResolvedValue({ id: "thread-1", hiddenFromList: true }),
      patch: vi.fn(),
      delete: vi.fn(),
      getEnvelope: vi.fn(),
    } as any

    const { getByTestId, getByText, queryByText } = render(() => (
      <ApiContext.Provider value={api}>
        <TaskDetail entityId="t1" />
      </ApiContext.Provider>
    ))

    await waitFor(() => expect(getByTestId("task-detail.layout")).toBeTruthy())
    expect(getByText("Add due date")).toBeTruthy()
    expect(queryByText("Add date")).toBeNull()
  })

  it("a seeded status reads as words and the due date as a formatted day, not the stored tokens", async () => {
    projectStore._setForTest({
      projectId: "p1",
      current: {
        ...project(),
        statuses: [
          {
            id: "s1",
            projectId: "p1",
            label: "in_progress",
            color: null,
            order: 0,
            terminal: false,
          },
        ],
      },
      tasks: [],
    })
    const api = {
      post: vi.fn().mockResolvedValue({ ...task(), dueDate: "2026-11-11" }),
      get: vi.fn().mockResolvedValue({ id: "thread-1", hiddenFromList: true }),
      patch: vi.fn(),
      delete: vi.fn(),
      getEnvelope: vi.fn(),
    } as any
    const { getByTestId } = render(() => (
      <ApiContext.Provider value={api}>
        <TaskDetail entityId="t1" />
      </ApiContext.Provider>
    ))
    await waitFor(() => expect(getByTestId("task-detail.due-date")).toBeTruthy())
    expect(getByTestId("task-detail.status").textContent).toContain("In progress")
    expect(getByTestId("task-detail.status").textContent).not.toContain("in_progress")
    expect(getByTestId("task-detail.due-date").textContent).toContain("Nov 11, 2026")
    expect(getByTestId("task-detail.due-date").textContent).not.toContain("2026-11-11")
  })

  it("deletes a task after confirmation and closes its tab", async () => {
    // There was NO delete affordance in the projects UI at all: deleting a task
    // was reachable only through the agent's gated tool.
    const del = vi.fn().mockResolvedValue({ deleted: true })
    const api = {
      post: vi.fn().mockResolvedValue(task()),
      get: vi.fn().mockResolvedValue({ id: "thread-1", hiddenFromList: true }),
      patch: vi.fn(),
      delete: del,
      getEnvelope: vi.fn(),
    } as any

    const { getByTestId, queryByTestId } = render(() => (
      <ApiContext.Provider value={api}>
        <TaskDetail entityId="t1" />
      </ApiContext.Provider>
    ))

    await waitFor(() => expect(getByTestId("task-detail.layout")).toBeTruthy())

    // First click only arms the confirmation — it must not delete outright.
    fireEvent.click(getByTestId("task-detail.delete"))
    expect(del).not.toHaveBeenCalled()
    expect(getByTestId("task-detail.delete-confirm")).toBeTruthy()

    fireEvent.click(getByTestId("task-detail.delete-confirm"))
    await waitFor(() => expect(del).toHaveBeenCalledWith("/projects/p1/tasks/t1"))
    await waitFor(() => expect(closeTab).toHaveBeenCalledWith("projects:task:t1"))

    // Cancelling disarms it.
    expect(queryByTestId("task-detail.delete-confirm")).toBeNull()
  })

  it("cancelling the delete confirmation deletes nothing", async () => {
    const del = vi.fn()
    const api = {
      post: vi.fn().mockResolvedValue(task()),
      get: vi.fn().mockResolvedValue({ id: "thread-1", hiddenFromList: true }),
      patch: vi.fn(),
      delete: del,
      getEnvelope: vi.fn(),
    } as any

    const { getByTestId, queryByTestId } = render(() => (
      <ApiContext.Provider value={api}>
        <TaskDetail entityId="t1" />
      </ApiContext.Provider>
    ))

    await waitFor(() => expect(getByTestId("task-detail.layout")).toBeTruthy())
    fireEvent.click(getByTestId("task-detail.delete"))
    fireEvent.click(getByTestId("task-detail.delete-cancel"))
    await waitFor(() => expect(queryByTestId("task-detail.delete-confirm")).toBeNull())
    expect(del).not.toHaveBeenCalled()
  })

  it("surfaces a failed edit instead of silently reverting it", async () => {
    // patch() used to end in `catch { void refetch() }`: a rejected edit snapped
    // the field back with NOTHING said, which reads as "I can't edit this".
    const api = {
      post: vi.fn().mockResolvedValue(task()),
      get: vi.fn().mockResolvedValue({ id: "thread-1", hiddenFromList: true }),
      patch: vi.fn().mockRejectedValue(new Error("403 Forbidden")),
      delete: vi.fn(),
      getEnvelope: vi.fn(),
    } as any

    const { getByTestId } = render(() => (
      <ApiContext.Provider value={api}>
        <TaskDetail entityId="t1" />
      </ApiContext.Provider>
    ))

    await waitFor(() => expect(getByTestId("task-detail.layout")).toBeTruthy())

    // Drive a real edit through the inline title editor.
    const title = getByTestId("task-detail.title")
    fireEvent.click(title)
    const input = getByTestId("task-detail.title-input") as HTMLInputElement
    // Enter delegates to blur(); fire blur directly so the save path runs in jsdom.
    input.value = "renamed"
    fireEvent.blur(input)

    await waitFor(() => expect(api.patch).toHaveBeenCalled())
    await waitFor(() =>
      expect(addToast).toHaveBeenCalledWith(expect.objectContaining({ type: "error" })),
    )
  })

  it("edits the description as rich text, saving markdown only when it changed", async () => {
    // "* un" is a bullet the editor would write as "- un": leaving the field
    // untouched must not rewrite it.
    const stored = "Rapprocher les **factures** de ++juin++\n\n* un\n* deux"
    const api = {
      post: vi.fn().mockResolvedValue({ ...task(), description: stored }),
      get: vi.fn().mockResolvedValue({ id: "thread-1", hiddenFromList: true }),
      patch: vi.fn().mockResolvedValue({}),
      delete: vi.fn(),
      getEnvelope: vi.fn(),
    } as any
    render(() => (
      <ApiContext.Provider value={api}>
        <TaskDetail entityId="t1" />
      </ApiContext.Provider>
    ))
    const rendered = await screen.findByTestId("task-detail.description-rendered")
    expect(rendered.querySelector("u")?.textContent).toBe("juin")

    fireEvent.click(screen.getByTestId("task-detail.description"))
    let field = await screen.findByTestId("task-detail.description-input")
    expect(field.querySelector("strong")?.textContent).toBe("factures")
    expect(field.textContent).not.toContain("**")
    fireEvent.focusOut(field)
    await screen.findByTestId("task-detail.description-rendered")
    expect(api.patch).not.toHaveBeenCalled()

    fireEvent.click(screen.getByTestId("task-detail.description"))
    field = await screen.findByTestId("task-detail.description-input")
    editorOf(field).commands.insertContentAt(1, "À ")
    fireEvent.focusOut(field)
    await waitFor(() =>
      expect(api.patch).toHaveBeenCalledWith("/projects/p1/tasks/t1", {
        // Only the first line was edited: the list keeps its `*`.
        description: "À Rapprocher les **factures** de ++juin++\n\n* un\n* deux",
      }),
    )
  })

  it("the description stays open while dictation records: a blur does not close it", async () => {
    installMic()
    installAudioContext()
    try {
      const api = {
        post: vi
          .fn()
          .mockImplementation(async (path: string) =>
            path.startsWith("/assist/transcribe")
              ? { raw: "dicté", cleaned: "Dicté.", model: "m", cleanModel: "c", durationSeconds: 1 }
              : { ...task(), description: null },
          ),
        get: vi
          .fn()
          .mockImplementation(async (path: string) =>
            path === "/assist/capabilities"
              ? { dictation: true, autoClean: true }
              : { id: "thread-1", hiddenFromList: true },
          ),
        patch: vi.fn().mockResolvedValue({}),
        delete: vi.fn(),
        getEnvelope: vi.fn(),
      } as any
      render(() => (
        <ApiContext.Provider value={api}>
          <TaskDetail entityId="t1" />
        </ApiContext.Provider>
      ))
      fireEvent.click(await screen.findByTestId("task-detail.description"))
      const field = await screen.findByTestId("task-detail.description-input")
      fireEvent.click(await screen.findByTestId("voice-dictation-button"))
      await screen.findByTestId("voice-dictation-stop")
      fireEvent.focusOut(field)
      // Still editing: the field and the recording are both there.
      expect(screen.getByTestId("task-detail.description-input")).toBe(field)
      expect(screen.getByTestId("voice-dictation-recorder").getAttribute("data-state")).toBe(
        "recording",
      )
      fireEvent.click(screen.getByTestId("voice-dictation-stop"))
      await waitFor(() => expect(editorOf(field).getText()).toContain("Dicté."))
      fireEvent.focusOut(field)
      await waitFor(() =>
        expect(api.patch).toHaveBeenCalledWith("/projects/p1/tasks/t1", {
          description: "Dicté.",
        }),
      )
    } finally {
      removeMic()
    }
  })

  it("attaches an image pasted into the description to the task, leaving the text alone", async () => {
    const api = {
      post: vi.fn().mockResolvedValue(task()),
      get: vi.fn().mockResolvedValue({ id: "thread-1", hiddenFromList: true }),
      patch: vi.fn().mockResolvedValue({}),
      delete: vi.fn(),
      getEnvelope: vi.fn(),
    } as any
    render(() => (
      <ApiContext.Provider value={api}>
        <TaskDetail entityId="t1" />
      </ApiContext.Provider>
    ))
    fireEvent.click(await screen.findByTestId("task-detail.description"))
    const field = await screen.findByTestId("task-detail.description-input")
    const shot = new File(["png"], "shot.png", { type: "image/png" })
    fireEvent.paste(field, {
      clipboardData: {
        items: [{ kind: "file", type: "image/png", getAsFile: () => shot }],
        types: ["Files"],
        getData: () => "",
      },
    })
    await waitFor(() => expect(uploads).toEqual(["shot.png@task:t1"]))
    expect(field.textContent).toBe("Reconcile invoices")
    fireEvent.focusOut(field)
    expect(api.patch).not.toHaveBeenCalled()
  })

  describe("checklist and release", () => {
    const releaseApi = (patch = vi.fn()) =>
      ({
        post: vi.fn().mockResolvedValue({ ...task(), release: "2.1.0" }),
        get: vi.fn().mockImplementation(async (url: string) => {
          if (url === "/projects/releases")
            return [
              { value: "2.1.0", count: 4 },
              { value: "2.2.0", count: 1 },
            ]
          if (url.endsWith("/checklist")) return { levels: [], items: [] }
          return { id: "thread-1", hiddenFromList: true }
        }),
        patch,
        delete: vi.fn(),
        getEnvelope: vi.fn(),
      }) as any

    const mountDetail = (api: any) =>
      render(() => (
        <ApiContext.Provider value={api}>
          <TaskDetail entityId="t1" />
        </ApiContext.Provider>
      ))

    it("places the checklist between the description and the subtasks", async () => {
      const api = releaseApi()
      const { getByTestId } = mountDetail(api)
      await waitFor(() => expect(getByTestId("task-detail.checklist")).toBeTruthy())
      const section = getByTestId("task-detail.checklist")
      expect(section.id).toBe("task-checklist")
      const description = getByTestId("task-detail.description-section")
      expect(
        description.compareDocumentPosition(section) & Node.DOCUMENT_POSITION_FOLLOWING,
      ).toBeTruthy()
      await waitFor(() => expect(api.get).toHaveBeenCalledWith("/projects/p1/tasks/t1/checklist"))
    })

    it("release chip suggests known releases and saves a picked one", async () => {
      const patch = vi.fn().mockResolvedValue({ ...task(), release: "2.2.0" })
      const api = releaseApi(patch)
      const { getByTestId } = mountDetail(api)
      await waitFor(() => expect(getByTestId("task-detail.release").textContent).toContain("2.1.0"))

      fireEvent.click(getByTestId("task-detail.release"))
      const input = getByTestId("task-detail.release-input") as HTMLInputElement
      await waitFor(() => expect(api.get).toHaveBeenCalledWith("/projects/releases"))
      input.focus()
      input.value = "2."
      fireEvent.input(input)
      const listbox = await screen.findByRole("listbox")
      await waitFor(() =>
        expect([...listbox.querySelectorAll("[role='option']")].map((o) => o.textContent)).toEqual([
          "2.1.0",
          "2.2.0",
        ]),
      )
      fireEvent.keyDown(input, { key: "ArrowDown" })
      fireEvent.keyDown(input, { key: "ArrowDown" })
      await waitFor(() => expect(input.getAttribute("aria-activedescendant")).toBeTruthy())
      fireEvent.keyDown(input, { key: "Enter" })
      await waitFor(() =>
        expect(patch).toHaveBeenCalledWith("/projects/p1/tasks/t1", { release: "2.2.0" }),
      )
    })

    it("release chip accepts free text that is not a suggestion", async () => {
      const patch = vi.fn().mockResolvedValue({ ...task(), release: "3.0.0-rc1" })
      const api = releaseApi(patch)
      const { getByTestId } = mountDetail(api)
      await waitFor(() => expect(getByTestId("task-detail.release")).toBeTruthy())
      fireEvent.click(getByTestId("task-detail.release"))
      const input = getByTestId("task-detail.release-input") as HTMLInputElement
      input.value = " 3.0.0-rc1 "
      fireEvent.input(input)
      fireEvent.keyDown(input, { key: "Enter" })
      await waitFor(() =>
        expect(patch).toHaveBeenCalledWith("/projects/p1/tasks/t1", { release: "3.0.0-rc1" }),
      )
    })
  })
})

describe("TaskDetail status follows the store (LIF-25)", () => {
  const twoStatuses = (): ProjectDetail => ({
    ...project(),
    statuses: [
      { id: "s1", projectId: "p1", label: "Todo", color: null, order: 0, terminal: false },
      { id: "s2", projectId: "p1", label: "Done", color: null, order: 1, terminal: true },
    ],
  })
  const storeRow = () => ({
    ...task(),
    number: 3,
    key: "BUG-3",
    position: 1000,
    completedAt: null,
  })
  const apiFor = (patch = vi.fn()) =>
    ({
      post: vi.fn().mockResolvedValue(task()),
      get: vi.fn().mockResolvedValue({ id: "thread-1", hiddenFromList: true }),
      patch,
      delete: vi.fn(),
      getEnvelope: vi.fn(),
    }) as any
  const pillText = () =>
    screen
      .getByTestId("task-detail.status")
      .querySelector("[data-testid='status-pill-popover.trigger']")?.textContent

  it("the pill shows the new status after the user's own click", async () => {
    // The project's task list is not loaded yet (store has no row): the pill
    // must still follow the server's answer.
    projectStore._setForTest({ projectId: "p1", current: twoStatuses(), tasks: [] })
    const patch = vi.fn().mockResolvedValue({
      ...storeRow(),
      statusId: "s2",
      updatedAt: "2026-05-07T00:00:00Z",
    })
    render(() => (
      <ApiContext.Provider value={apiFor(patch)}>
        <TaskDetail entityId="t1" />
      </ApiContext.Provider>
    ))
    await waitFor(() => expect(pillText()).toContain("Todo"))
    fireEvent.click(
      screen
        .getByTestId("task-detail.status")
        .querySelector("[data-testid='status-pill-popover.trigger']")!,
    )
    const done = (await screen.findAllByTestId("status-pill-popover.item")).find(
      (el) => el.getAttribute("data-status-id") === "s2",
    )!
    fireEvent.click(done)
    await waitFor(() => expect(pillText()).toContain("Done"))
    expect(patch).toHaveBeenCalledWith("/projects/p1/tasks/t1", { statusId: "s2" })
  })

  it("the pill follows a task event from elsewhere (another tab, an agent)", async () => {
    projectStore._setForTest({ projectId: "p1", current: twoStatuses(), tasks: [storeRow()] })
    render(() => (
      <ApiContext.Provider value={apiFor()}>
        <TaskDetail entityId="t1" />
      </ApiContext.Provider>
    ))
    await waitFor(() => expect(pillText()).toContain("Todo"))
    projectStore.handleTaskEvent("updated", {
      ...storeRow(),
      statusId: "s2",
      title: "Fix billing import (agent)",
      updatedAt: "2026-05-07T00:00:00Z",
    })
    await waitFor(() => expect(pillText()).toContain("Done"))
    // A stale echo of the earlier state does not flip it back.
    projectStore.handleTaskEvent("updated", { ...storeRow(), updatedAt: "2026-05-06T00:00:00Z" })
    expect(pillText()).toContain("Done")
  })
})

describe("TaskDetail assignee chip (assign to anyone, not only me)", () => {
  type Member = {
    id: string
    name: string
    email: string
    away?: { until: string | null } | null
  }

  function apiWithMembers(members: Member[] | Error, patch = vi.fn()) {
    const memberCalls: string[] = []
    const getEnvelope = vi.fn(async (path: string) => {
      if (path.startsWith("/mentions/members")) {
        memberCalls.push(path)
        if (members instanceof Error) throw members
        return { data: members, meta: { total: members.length } }
      }
      return { data: [] }
    })
    const api = {
      post: vi.fn().mockResolvedValue(task()),
      get: vi.fn().mockResolvedValue({ id: "thread-1", hiddenFromList: true }),
      patch,
      delete: vi.fn(),
      getEnvelope,
    } as any
    return { api, memberCalls, getEnvelope }
  }

  async function openAssigneeMenu() {
    const chip = await screen.findByTestId("task-detail.assignee")
    const trigger = chip.closest("button")!
    trigger.focus()
    fireEvent.keyDown(trigger, { key: "ArrowDown" })
  }

  it("lists teammates and assigns the task to the one picked", async () => {
    const patch = vi.fn().mockResolvedValue({ assigneeId: "u-morgan" })
    const { api, memberCalls } = apiWithMembers(
      [
        { id: "u-morgan", name: "Morgan Lee", email: "morgan@x.test" },
        { id: "u-alice", name: "Alice Chen", email: "alice@x.test" },
      ],
      patch,
    )
    render(() => (
      <ApiContext.Provider value={api}>
        <TaskDetail entityId="t1" />
      </ApiContext.Provider>
    ))
    await openAssigneeMenu()
    await waitFor(() => expect(screen.getAllByTestId("task-detail.assign-member").length).toBe(2))
    expect(memberCalls[0]).toContain("/mentions/members?")
    const morgan = screen
      .getAllByTestId("task-detail.assign-member")
      .find((el) => el.textContent?.includes("Morgan Lee"))!
    fireEvent.keyDown(morgan.closest("[role=menuitem]")!, { key: "Enter" })
    await waitFor(() =>
      expect(patch).toHaveBeenCalledWith("/projects/p1/tasks/t1", { assigneeId: "u-morgan" }),
    )
  })

  it("shows away until a date beside a teammate who is away; the list is unchanged", async () => {
    const { api } = apiWithMembers([
      { id: "u-morgan", name: "Morgan Lee", email: "morgan@x.test", away: { until: "2099-12-20" } },
      { id: "u-alice", name: "Alice Chen", email: "alice@x.test", away: null },
    ])
    render(() => (
      <ApiContext.Provider value={api}>
        <TaskDetail entityId="t1" />
      </ApiContext.Provider>
    ))
    await openAssigneeMenu()
    await waitFor(() => expect(screen.getAllByTestId("task-detail.assign-member").length).toBe(2))
    expect(screen.getByTestId("task-detail.assign-away-u-morgan").textContent).toMatch(
      /away until (20 Dec|Dec 20)/,
    )
    expect(screen.queryByTestId("task-detail.assign-away-u-alice")).toBeNull()
  })

  it("shows an error with a retry when teammates cannot be loaded", async () => {
    const { api } = apiWithMembers(new Error("boom"))
    render(() => (
      <ApiContext.Provider value={api}>
        <TaskDetail entityId="t1" />
      </ApiContext.Provider>
    ))
    await openAssigneeMenu()
    await waitFor(() => expect(screen.getByTestId("task-detail.assignee-error")).toBeTruthy())
    expect(screen.queryAllByTestId("task-detail.assign-member")).toHaveLength(0)
    api.getEnvelope.mockImplementation(async () => ({
      data: [{ id: "u-sam", name: "Sam Roy", email: "sam@x.test" }],
      meta: { total: 1 },
    }))
    fireEvent.click(screen.getByTestId("task-detail.assignee-retry"))
    await waitFor(() => expect(screen.getAllByTestId("task-detail.assign-member").length).toBe(1))
    expect(screen.queryByTestId("task-detail.assignee-error")).toBeNull()
  })

  it("searches teammates by name", async () => {
    const { api, getEnvelope } = apiWithMembers([
      { id: "u-morgan", name: "Morgan Lee", email: "morgan@x.test" },
    ])
    render(() => (
      <ApiContext.Provider value={api}>
        <TaskDetail entityId="t1" />
      </ApiContext.Provider>
    ))
    await openAssigneeMenu()
    fireEvent.input(await screen.findByTestId("task-detail.assignee-search"), {
      target: { value: "sam" },
    })
    await waitFor(() => expect(getEnvelope.mock.calls.at(-1)?.[0]).toContain("q=sam"))
  })
})

describe("labels", () => {
  const ownBug = {
    groupId: "g-nature",
    groupName: "Nature",
    groupArchived: false,
    valueId: "v-bug",
    valueName: "bug",
    archived: false,
    inherited: false,
    inheritedFromKey: null,
  }

  function labelApi(patchResult: unknown) {
    return {
      post: vi.fn().mockResolvedValue({ ...task(), labels: [] }),
      get: vi.fn().mockResolvedValue({ id: "thread-1", hiddenFromList: true }),
      patch: vi.fn().mockResolvedValue(patchResult),
      delete: vi.fn(),
      getEnvelope: vi.fn(),
    } as any
  }

  async function pickBug(api: any) {
    render(() => (
      <ApiContext.Provider value={api}>
        <TaskDetail entityId="t1" />
      </ApiContext.Provider>
    ))
    const chip = await screen.findByTestId("task-detail.label-g-nature")
    const trigger = chip.closest("button") as HTMLElement
    trigger.focus()
    fireEvent.keyDown(trigger, { key: "ArrowDown" })
    const options = await screen.findAllByTestId("task-detail.label-option")
    fireEvent.keyDown(options[0] as HTMLElement, { key: "Enter" })
  }

  it("the label chip follows the release chip in the meta row", async () => {
    const api = labelApi({})
    render(() => (
      <ApiContext.Provider value={api}>
        <TaskDetail entityId="t1" />
      </ApiContext.Provider>
    ))
    const chip = await screen.findByTestId("task-detail.label-g-nature")
    expect(chip.textContent).toBe("Nature: not set")
    const release = screen.getByTestId("task-detail.release")
    expect(release.compareDocumentPosition(chip) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  })

  it("with no label group, the meta row has no label chip and no extra separator", async () => {
    const saved = labelGroups.splice(0, labelGroups.length)
    try {
      render(() => (
        <ApiContext.Provider value={labelApi({})}>
          <TaskDetail entityId="t1" />
        </ApiContext.Provider>
      ))
      const release = await screen.findByTestId("task-detail.release")
      const blocked = screen.getByTestId("task-detail.blocked-toggle")
      let row: HTMLElement | null = release.parentElement
      while (row && !row.contains(blocked)) row = row.parentElement
      expect(row).not.toBeNull()
      const isSeparator = (el: Element) =>
        el.tagName === "SPAN" &&
        el.getAttribute("aria-hidden") === "true" &&
        el.textContent?.trim() === "·"
      const children = [...(row as HTMLElement).children]
      for (let i = 1; i < children.length; i++) {
        expect(isSeparator(children[i - 1] as Element) && isSeparator(children[i] as Element)).toBe(
          false,
        )
      }
      expect(screen.queryByTestId("task-detail.label-g-nature")).toBeNull()
    } finally {
      labelGroups.push(...saved)
    }
  })

  it("picking a value patches the task with the label map", async () => {
    const api = labelApi({})
    await pickBug(api)
    await waitFor(() =>
      expect(api.patch).toHaveBeenCalledWith("/projects/p1/tasks/t1", {
        labels: { "g-nature": "v-bug" },
      }),
    )
  })

  for (const [name, result] of [
    ["an empty answer", {}],
    ["no answer", undefined],
  ] as const) {
    it(`${name} never pushes the raw label map into the stores`, async () => {
      projectStore._setForTest({
        projectId: "p1",
        current: project(),
        tasks: [{ ...task(), number: 1, position: 0, completedAt: null, labels: [ownBug] }],
      })
      const api = labelApi(result)
      await pickBug(api)
      await waitFor(() => expect(api.patch).toHaveBeenCalled())
      await waitFor(() => expect(api.post.mock.calls.length).toBeGreaterThan(1))
      expect(projectStore.task("t1")?.labels).toEqual([ownBug])
    })
  }
})

describe("TaskDetail copy link", () => {
  it("copies this server's address of the task", async () => {
    resetRegistry()
    registerTabType("projects:task", {
      component: () => null,
      sidebar: null,
      icon: () => null,
      urlPattern: "/projects/tasks/:entityId",
      defaultLabel: "x",
    })
    const writeText = vi.fn(async () => {})
    vi.stubGlobal("navigator", { clipboard: { writeText } })
    const api = {
      post: vi.fn().mockResolvedValue(task()),
      get: vi.fn().mockResolvedValue({ id: "thread-1", hiddenFromList: true }),
      patch: vi.fn(),
      delete: vi.fn(),
      getEnvelope: vi.fn(),
    } as any
    render(() => (
      <ApiContext.Provider value={api}>
        <TaskDetail entityId="t1" />
      </ApiContext.Provider>
    ))
    await waitFor(() => expect(screen.getByTestId("task-detail.layout")).toBeTruthy())
    fireEvent.click(screen.getByTestId("task-detail.copy-link"))
    await waitFor(() =>
      expect(writeText).toHaveBeenCalledWith(`${window.location.origin}/projects/tasks/t1`),
    )
    await waitFor(() =>
      expect(addToast).toHaveBeenCalledWith(expect.objectContaining({ message: "Link copied" })),
    )
  })

  describe("fields and status history", () => {
    const withFields = (): ProjectDetail => ({
      ...project(),
      fields: [
        { key: "serial", label: "Serial", type: "text", required: true },
        { key: "kind", label: "Kind", type: "choice", choices: ["A", "B"] },
      ],
    })
    const apiWith = (row: Record<string, unknown>) =>
      ({
        post: vi.fn().mockResolvedValue(row),
        get: vi.fn().mockResolvedValue({ id: "thread-1", hiddenFromList: true }),
        patch: vi.fn().mockResolvedValue({ ...row, fields: { serial: "S-1", kind: "B" } }),
        delete: vi.fn(),
        getEnvelope: vi.fn().mockResolvedValue({ data: [] }),
      }) as unknown as ApiClient & { patch: ReturnType<typeof vi.fn> }

    it("no field declared: no Fields section", async () => {
      const api = apiWith(task())
      render(() => (
        <ApiContext.Provider value={api}>
          <TaskDetail entityId="t1" />
        </ApiContext.Provider>
      ))
      await waitFor(() => expect(screen.getByTestId("task-detail.layout")).toBeTruthy())
      expect(screen.queryByTestId("task-fields")).toBeNull()
    })

    it("shows the project's fields and saves an edit through the task PATCH `fields`", async () => {
      projectStore._setForTest({ projectId: "p1", current: withFields(), tasks: [] })
      const api = apiWith({ ...task(), fields: { serial: "S-1", kind: "A" } })
      render(() => (
        <ApiContext.Provider value={api}>
          <TaskDetail entityId="t1" />
        </ApiContext.Provider>
      ))
      await waitFor(() => expect(screen.getByTestId("task-fields")).toBeTruthy())
      expect(screen.getByTestId("task-fields.value-serial").textContent).toBe("S-1")
      fireEvent.click(screen.getByTestId("task-fields.value-kind"))
      fireEvent.click(screen.getByTestId("task-fields.editor-kind-choice-1"))
      await waitFor(() =>
        expect(api.patch).toHaveBeenCalledWith("/projects/p1/tasks/t1", { fields: { kind: "B" } }),
      )
      await waitFor(() =>
        expect(screen.getByTestId("task-fields.value-kind").textContent).toBe("B"),
      )
    })

    it("says how long the task is in its status, and lists its status changes on demand", async () => {
      const api = apiWith({
        ...task(),
        statusEnteredAt: new Date(Date.now() - 3 * 86_400_000).toISOString(),
        transitions: [
          {
            id: "x2",
            fromStatusId: "s0",
            fromStatusLabel: "Backlog",
            toStatusId: "s1",
            toStatusLabel: "Todo",
            actorType: "user",
            actorId: "u1",
            actorName: "Ada Fabrikam",
            agentId: null,
            routineId: null,
            at: new Date(Date.now() - 3 * 86_400_000).toISOString(),
          },
          {
            id: "x1",
            fromStatusId: null,
            fromStatusLabel: null,
            toStatusId: "s0",
            toStatusLabel: "Backlog",
            actorType: "routine",
            actorId: null,
            actorName: null,
            agentId: null,
            routineId: "r1",
            at: new Date(Date.now() - 5 * 86_400_000).toISOString(),
          },
        ],
      })
      render(() => (
        <ApiContext.Provider value={api}>
          <TaskDetail entityId="t1" />
        </ApiContext.Provider>
      ))
      await waitFor(() => expect(screen.getByTestId("task-detail.status-since")).toBeTruthy())
      expect(screen.getByTestId("task-detail.status-since").textContent).toMatch(/^for 3/)
      expect(screen.queryByTestId("task-status-history.item")).toBeNull()
      fireEvent.click(screen.getByTestId("task-status-history.toggle"))
      const items = screen.getAllByTestId("task-status-history.item")
      expect(items).toHaveLength(2)
      expect(items[0]!.textContent).toContain("Backlog → Todo")
      expect(items[0]!.textContent).toContain("Ada Fabrikam")
      expect(items[1]!.textContent).toContain("Created in Backlog")
      expect(items[1]!.textContent).toContain("a routine")
    })
  })
})

describe("TaskDetail on a sales pipeline", () => {
  it("the task page renders when the deal read fails", async () => {
    projectStore._setForTest({
      projectId: "p1",
      current: { ...project(), kind: "pipeline" },
      tasks: [],
    })
    const api = {
      post: vi.fn(async (path: string, body?: { toolName?: string }) => {
        if (path === "/apps/run-tool" && body?.toolName === "projects:deals_search") {
          throw new Error("deals are down")
        }
        return task()
      }),
      get: vi.fn().mockResolvedValue({ id: "thread-1", hiddenFromList: true }),
      patch: vi.fn(),
      delete: vi.fn(),
      getEnvelope: vi.fn(),
    } as any
    const { findByTestId, getByTestId } = render(() => (
      <ApiContext.Provider value={api}>
        <TaskDetail entityId="t1" />
      </ApiContext.Provider>
    ))
    expect((await findByTestId("deal-panel.error")).textContent).toBe(
      "Could not read the deal. The task below is not affected.",
    )
    expect(getByTestId("task-detail.description-section")).toBeTruthy()
    expect(getByTestId("task-detail.meta-row")).toBeTruthy()
  })

  it("a subtask of a pipeline shows no deal panel", async () => {
    projectStore._setForTest({
      projectId: "p1",
      current: { ...project(), kind: "pipeline" },
      tasks: [],
    })
    const api = {
      post: vi.fn(async () => ({ ...task(), parentTaskId: "t0" })),
      get: vi.fn().mockResolvedValue({ id: "thread-1", hiddenFromList: true }),
      patch: vi.fn(),
      delete: vi.fn(),
      getEnvelope: vi.fn(),
    } as any
    const { findByTestId, queryByTestId } = render(() => (
      <ApiContext.Provider value={api}>
        <TaskDetail entityId="t1" />
      </ApiContext.Provider>
    ))
    await findByTestId("task-detail.description-section")
    expect(queryByTestId("deal-panel")).toBeNull()
    expect(queryByTestId("deal-panel.loading")).toBeNull()
    expect(api.post).not.toHaveBeenCalledWith("/apps/run-tool", expect.anything())
  })
})
