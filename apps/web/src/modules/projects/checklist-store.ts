// SPDX-License-Identifier: FSL-1.1-ALv2
// Per-task checklist state: levels, items and the status summary, keyed by
// task id. Writes go through the projects REST API and are echoed into the
// store as soon as the server confirms them (the WS event rides the outbox
// worker and can lag), like StatusPillPopover. Every change recomputes the
// task's summary and pushes it into project-store so board counters follow.
import { createStore, produce, reconcile } from "solid-js/store"
import type { ApiClient } from "~/lib/api-client"
import { onSessionTeardown } from "~/lib/session-lifecycle"
import {
  type ChecklistItem,
  type ChecklistItemPatch,
  type ChecklistStatus,
  type ChecklistView,
  computeChecklistStatus,
  type ValidationEntry,
  type ValidationLevel,
  type ValidationLevelInput,
} from "~/modules/projects/checklist-types"
import {
  projectApi,
  projectStore,
  handleProjectEvent as projectStoreHandleProject,
  setTaskChecklist,
} from "~/modules/projects/project-store"

interface TaskChecklistState {
  projectId: string
  levels: ValidationLevel[]
  items: ChecklistItem[]
  status: ChecklistStatus
  loading: boolean
  error: string | null
}

const [state, setState] = createStore<{ byTaskId: Record<string, TaskChecklistState> }>({
  byTaskId: {},
})

let _api: ApiClient | null = null

const base = (projectId: string, taskId: string) =>
  `/projects/${projectId}/tasks/${taskId}/checklist`

const byPosition = (a: ChecklistItem, b: ChecklistItem) =>
  a.position - b.position || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)

/** Recompute the summary of a loaded task and mirror it into project-store. */
function recompute(taskId: string): void {
  const entry = state.byTaskId[taskId]
  if (!entry) return
  const status = computeChecklistStatus(entry.levels, entry.items)
  setState("byTaskId", taskId, "status", status)
  setTaskChecklist(taskId, status)
}

function applyView(projectId: string, taskId: string, view: ChecklistView): void {
  const levels = Array.isArray(view?.levels) ? view.levels : []
  const items = Array.isArray(view?.items) ? [...view.items].sort(byPosition) : []
  const status = view?.status ?? computeChecklistStatus(levels, items)
  // Merge rows and levels by id so a refetch keeps their identity: a row's chips are keyed by
  // level object, so a replaced level would remount its chip and close an open popover.
  setState("byTaskId", taskId, { projectId, status, loading: false, error: null })
  setState("byTaskId", taskId, "levels", reconcile(levels, { key: "id", merge: true }))
  setState("byTaskId", taskId, "items", reconcile(items, { key: "id", merge: true }))
  setTaskChecklist(taskId, status)
}

/**
 * Upsert items the server returned, then recompute. Existing items are merged
 * in place: replacing the object would remount its row in <For> and close any
 * open chip popover, Fail note or inline edit on it.
 */
function upsertItems(taskId: string, incoming: Partial<ChecklistItem>[]): void {
  if (!state.byTaskId[taskId]) return
  setState(
    "byTaskId",
    taskId,
    "items",
    produce((items) => {
      for (const next of incoming) {
        if (!next?.id) continue
        const idx = items.findIndex((i) => i.id === next.id)
        if (idx >= 0) Object.assign(items[idx]!, next)
        else
          items.push({
            taskId,
            position: 0,
            title: "",
            details: null,
            checked: false,
            validations: {},
            createdBy: "",
            createdAt: "",
            updatedAt: "",
            ...next,
          } as ChecklistItem)
      }
      items.sort(byPosition)
    }),
  )
  recompute(taskId)
}

function removeLocal(taskId: string, itemId: string): void {
  const entry = state.byTaskId[taskId]
  if (!entry) return
  setState(
    "byTaskId",
    taskId,
    "items",
    entry.items.filter((i) => i.id !== itemId),
  )
  recompute(taskId)
}

export async function loadChecklist(
  api: ApiClient,
  projectId: string,
  taskId: string,
): Promise<void> {
  _api = api
  if (!state.byTaskId[taskId]) {
    setState("byTaskId", taskId, {
      projectId,
      levels: [],
      items: [],
      status: computeChecklistStatus([], []),
      loading: true,
      error: null,
    })
  } else {
    setState("byTaskId", taskId, { loading: true, error: null })
  }
  try {
    const view = await api.get<ChecklistView>(base(projectId, taskId))
    applyView(projectId, taskId, view)
  } catch (err) {
    setState("byTaskId", taskId, { loading: false, error: (err as Error).message })
  }
}

export async function addItems(
  api: ApiClient,
  projectId: string,
  taskId: string,
  items: { title: string; details?: string | null }[],
): Promise<ChecklistItem[]> {
  _api = api
  const res = await api.post<{ items: ChecklistItem[] }>(base(projectId, taskId), { items })
  const created = Array.isArray(res?.items) ? res.items : []
  upsertItems(taskId, created)
  return created
}

export async function updateItem(
  api: ApiClient,
  projectId: string,
  taskId: string,
  itemId: string,
  patch: ChecklistItemPatch,
): Promise<ChecklistItem> {
  _api = api
  const item = await api.patch<ChecklistItem>(`${base(projectId, taskId)}/${itemId}`, patch)
  if (item?.id) upsertItems(taskId, [item])
  return item
}

export async function removeItem(
  api: ApiClient,
  projectId: string,
  taskId: string,
  itemId: string,
): Promise<void> {
  _api = api
  await api.delete(`${base(projectId, taskId)}/${itemId}`)
  removeLocal(taskId, itemId)
}

/** Record states (one entry or a batch); echoes the items the server returns. */
export async function setValidations(
  api: ApiClient,
  projectId: string,
  taskId: string,
  entries: ValidationEntry[],
): Promise<ChecklistItem[]> {
  _api = api
  const res = await api.post<{ items: ChecklistItem[] }>(`${base(projectId, taskId)}/validations`, {
    validations: entries,
  })
  const items = Array.isArray(res?.items) ? res.items : []
  upsertItems(taskId, items)
  return items
}

/** Replace the project's level list; echoes the saved list everywhere. */
export async function setLevels(
  api: ApiClient,
  projectId: string,
  levels: ValidationLevelInput[],
): Promise<ValidationLevel[]> {
  _api = api
  const res = await api.put<{ levels: ValidationLevel[] }>(
    `/projects/${projectId}/validation-levels`,
    { levels },
  )
  const saved = Array.isArray(res?.levels) ? res.levels : []
  projectStoreHandleProject("updated", { id: projectId, validationLevels: saved })
  applyLevels(projectId, saved)
  return saved
}

// --- Realtime ---

const REFRESH_DELAY_MS = 150
const pendingRefresh = new Map<string, ReturnType<typeof setTimeout>>()

/** Coalesced refetch of one task's checklist (a batch of 50 events = one GET). */
function scheduleRefresh(taskId: string): void {
  if (pendingRefresh.has(taskId)) return
  pendingRefresh.set(
    taskId,
    setTimeout(() => {
      pendingRefresh.delete(taskId)
      const api = _api ?? projectApi()
      const projectId = state.byTaskId[taskId]?.projectId ?? projectStore.projectIdForTask(taskId)
      if (api && projectId) void loadChecklist(api, projectId, taskId)
    }, REFRESH_DELAY_MS),
  )
}

/**
 * Levels changed on a project: loaded checklists drop the removed levels'
 * states and recompute; board tasks known only by their summary refetch.
 */
export function applyLevels(projectId: string, levels: ValidationLevel[]): void {
  const ids = new Set(levels.map((l) => l.id))
  const loaded = new Set<string>()
  for (const [taskId, entry] of Object.entries(state.byTaskId)) {
    if (entry.projectId !== projectId) continue
    loaded.add(taskId)
    setState(
      "byTaskId",
      taskId,
      produce((e) => {
        e.levels = levels
        for (const item of e.items) {
          for (const key of Object.keys(item.validations ?? {})) {
            if (!ids.has(key)) delete item.validations[key]
          }
        }
      }),
    )
    recompute(taskId)
  }
  for (const task of projectStore.tasksFor(projectId)) {
    if (!loaded.has(task.id) && (task.checklist?.total ?? 0) > 0) scheduleRefresh(task.id)
  }
}

/**
 * WS `task_checklist_item` event ({ ...item, taskId }). A loaded checklist is
 * patched in place; a task known only on the board refetches its checklist so
 * its counters follow. Events for tasks this client never loaded are ignored.
 */
export function handleChecklistItemEvent(
  action: string,
  data: { id?: string; taskId?: string } & Partial<ChecklistItem>,
): void {
  const taskId = data?.taskId
  if (!taskId || !data.id) return
  if (state.byTaskId[taskId]) {
    if (action === "deleted" || action === "delete") removeLocal(taskId, data.id)
    else upsertItems(taskId, [data])
    return
  }
  if (projectStore.projectIdForTask(taskId)) scheduleRefresh(taskId)
}

export const checklistStore = {
  get(taskId: string): TaskChecklistState | null {
    return state.byTaskId[taskId] ?? null
  },
  items(taskId: string): ChecklistItem[] {
    return state.byTaskId[taskId]?.items ?? []
  },
  levels(taskId: string): ValidationLevel[] {
    return state.byTaskId[taskId]?.levels ?? []
  },
  status(taskId: string): ChecklistStatus | null {
    return state.byTaskId[taskId]?.status ?? null
  },
  load: loadChecklist,
  addItems,
  updateItem,
  removeItem,
  setValidations,
  setLevels,
  applyLevels,
  handleChecklistItemEvent,
}

export function resetChecklistStore(): void {
  for (const t of pendingRefresh.values()) clearTimeout(t)
  pendingRefresh.clear()
  _api = null
  setState({ byTaskId: {} })
}
onSessionTeardown(resetChecklistStore)
