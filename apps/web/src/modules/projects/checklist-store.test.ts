// SPDX-License-Identifier: FSL-1.1-ALv2
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { checklistStore, resetChecklistStore } from "~/modules/projects/checklist-store"
import {
  type ChecklistItem,
  computeChecklistStatus,
  type ValidationLevel,
} from "~/modules/projects/checklist-types"
import { projectStore, type Task } from "~/modules/projects/project-store"

const AI: ValidationLevel = { id: "lvl-ai", name: "AI" }
const DEV: ValidationLevel = { id: "lvl-dev", name: "Dev" }

const rec = (state: "success" | "fail" | "na" | "not_done") => ({
  state,
  by: "u1",
  via: "human" as const,
  source: null,
  at: "2026-09-25T00:00:00Z",
})

const item = (id: string, position: number, extra: Partial<ChecklistItem> = {}) =>
  ({
    id,
    taskId: "t1",
    position,
    title: id,
    details: null,
    checked: false,
    validations: {},
    createdBy: "u1",
    createdAt: "2026-09-25T00:00:00Z",
    updatedAt: "2026-09-25T00:00:00Z",
    ...extra,
  }) as ChecklistItem

const task = (id: string): Task =>
  ({
    id,
    number: 1,
    projectId: "p1",
    parentTaskId: null,
    statusId: "s1",
    title: id,
    description: null,
    assigneeId: null,
    priority: "normal",
    dueDate: null,
    startDate: null,
    position: 1000,
    blocked: false,
    completedAt: null,
    threadId: `${id}-thread`,
    createdBy: "u1",
    createdAt: "2026-05-06T00:00:00Z",
    updatedAt: "2026-05-06T00:00:00Z",
  }) as Task

function view(items: ChecklistItem[], levels = [AI, DEV]) {
  return { levels, items, status: computeChecklistStatus(levels, items) }
}

describe("checklist store", () => {
  beforeEach(() => {
    projectStore._resetForTest()
    resetChecklistStore()
    projectStore._setForTest({ projectId: "p1", tasks: [task("t1")] })
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it("loads a task checklist and mirrors its summary onto the board task", async () => {
    const get = vi.fn(async () =>
      view([item("i1", 1, { validations: { "lvl-ai": rec("success") } })]),
    )
    await checklistStore.load({ get } as any, "p1", "t1")
    expect(get).toHaveBeenCalledWith("/projects/p1/tasks/t1/checklist")
    expect(checklistStore.items("t1").map((i) => i.id)).toEqual(["i1"])
    expect(projectStore.task("t1")?.checklist?.perLevel[0]).toMatchObject({
      name: "AI",
      applicable: 1,
      success: 1,
    })
  })

  it("echoes a successful set-validation into the items and the counters", async () => {
    const api = {
      get: vi.fn(async () => view([item("i1", 1), item("i2", 2)])),
      post: vi.fn(async () => ({
        items: [item("i1", 1, { validations: { "lvl-dev": rec("fail") } })],
      })),
    }
    await checklistStore.load(api as any, "p1", "t1")
    await checklistStore.setValidations(api as any, "p1", "t1", [
      { itemId: "i1", level: "lvl-dev", state: "fail", note: "crashes on boot" },
    ])
    expect(api.post).toHaveBeenCalledWith("/projects/p1/tasks/t1/checklist/validations", {
      validations: [{ itemId: "i1", level: "lvl-dev", state: "fail", note: "crashes on boot" }],
    })
    expect(checklistStore.items("t1")[0]?.validations["lvl-dev"]?.state).toBe("fail")
    const summary = projectStore.task("t1")?.checklist
    expect(summary?.failing).toBe(1)
    expect(summary?.perLevel.find((l) => l.name === "Dev")?.fail).toBe(1)
  })

  it("leaves the store untouched when the write is refused", async () => {
    const api = {
      get: vi.fn(async () => view([item("i1", 1)])),
      post: vi.fn(async () => {
        throw new Error("checklist_fail_note_required")
      }),
    }
    await checklistStore.load(api as any, "p1", "t1")
    await expect(
      checklistStore.setValidations(api as any, "p1", "t1", [
        { itemId: "i1", level: "lvl-dev", state: "fail" },
      ]),
    ).rejects.toThrow()
    expect(checklistStore.items("t1")[0]?.validations).toEqual({})
    expect(projectStore.task("t1")?.checklist?.failing).toBe(0)
  })

  it("add, update and remove echo in position order", async () => {
    const api = {
      get: vi.fn(async () => view([item("i1", 1)], [])),
      post: vi.fn(async () => ({ items: [item("i0", 0.5), item("i2", 2)] })),
      patch: vi.fn(async () => item("i2", 2, { checked: true, title: "renamed" })),
      delete: vi.fn(async () => ({ deleted: true })),
    }
    await checklistStore.load(api as any, "p1", "t1")
    await checklistStore.addItems(api as any, "p1", "t1", [{ title: "i0" }, { title: "i2" }])
    expect(checklistStore.items("t1").map((i) => i.id)).toEqual(["i0", "i1", "i2"])
    await checklistStore.updateItem(api as any, "p1", "t1", "i2", { checked: true })
    expect(projectStore.task("t1")?.checklist).toMatchObject({ total: 3, complete: 1 })
    await checklistStore.removeItem(api as any, "p1", "t1", "i0")
    expect(api.delete).toHaveBeenCalledWith("/projects/p1/tasks/t1/checklist/i0")
    expect(projectStore.task("t1")?.checklist).toMatchObject({ total: 2, complete: 1 })
  })

  it("a refetch keeps each level's and each item's identity, so an open chip popover survives", async () => {
    // Fresh objects per read, as off the wire: the store merges into what it holds.
    const get = vi.fn(async () => view([item("i1", 1)], [{ ...AI }, { ...DEV }]))
    await checklistStore.load({ get } as any, "p1", "t1")
    const [firstLevel] = checklistStore.levels("t1")
    const [firstItem] = checklistStore.items("t1")
    // The same task read again (an event's coalesced refetch, a second view mounting).
    await checklistStore.load({ get } as any, "p1", "t1")
    expect(checklistStore.levels("t1")[0]).toBe(firstLevel)
    expect(checklistStore.items("t1")[0]).toBe(firstItem)
    // A renamed level is patched in place; a removed one leaves.
    get.mockImplementationOnce(async () => view([item("i1", 1)], [{ ...AI, name: "AI review" }]))
    await checklistStore.load({ get } as any, "p1", "t1")
    expect(checklistStore.levels("t1")).toHaveLength(1)
    expect(checklistStore.levels("t1")[0]).toBe(firstLevel)
    expect(checklistStore.levels("t1")[0]?.name).toBe("AI review")
  })

  it("setLevels echoes the saved list and drops a removed level's states", async () => {
    const api = {
      get: vi.fn(async () =>
        view([
          item("i1", 1, { validations: { "lvl-ai": rec("success"), "lvl-dev": rec("fail") } }),
        ]),
      ),
      put: vi.fn(async () => ({ levels: [AI] })),
    }
    projectStore._setForTest({
      projectId: "p1",
      current: {
        id: "p1",
        name: "p1",
        description: null,
        icon: null,
        color: null,
        ownerId: "u1",
        archivedAt: null,
        createdAt: "",
        updatedAt: "",
        statuses: [],
        validationLevels: [AI, DEV],
      },
    })
    await checklistStore.load(api as any, "p1", "t1")
    await checklistStore.setLevels(api as any, "p1", [{ id: AI.id, name: "AI" }])
    expect(api.put).toHaveBeenCalledWith("/projects/p1/validation-levels", {
      levels: [{ id: AI.id, name: "AI" }],
    })
    expect(projectStore.project("p1")?.validationLevels).toEqual([AI])
    expect(Object.keys(checklistStore.items("t1")[0]!.validations)).toEqual(["lvl-ai"])
    expect(projectStore.task("t1")?.checklist).toMatchObject({ complete: 1, failing: 0 })
  })
})

describe("computeChecklistStatus", () => {
  it("plain mode counts checked items and names the unchecked as blocking", () => {
    const s = computeChecklistStatus([], [item("a", 1, { checked: true }), item("b", 2)])
    expect(s).toMatchObject({ total: 2, complete: 1, failing: 0, perLevel: [] })
    expect(s.blocking).toEqual([{ itemId: "b", title: "b", levels: [] }])
  })

  it("level mode: N/A leaves the denominator, a missing key reads not done", () => {
    const s = computeChecklistStatus(
      [AI, DEV],
      [
        item("a", 1, { validations: { "lvl-ai": rec("success"), "lvl-dev": rec("na") } }),
        item("b", 2, { validations: { "lvl-ai": rec("fail") } }),
      ],
    )
    expect(s.perLevel).toEqual([
      { levelId: "lvl-ai", name: "AI", applicable: 2, success: 1, fail: 1 },
      { levelId: "lvl-dev", name: "Dev", applicable: 1, success: 0, fail: 0 },
    ])
    expect(s).toMatchObject({ total: 2, complete: 1, failing: 1 })
    expect(s.blocking).toEqual([{ itemId: "b", title: "b", levels: ["AI", "Dev"] }])
  })
})
