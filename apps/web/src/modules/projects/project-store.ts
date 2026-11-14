// SPDX-License-Identifier: FSL-1.1-ALv2
import { createStore } from "solid-js/store"
import { subscribeResync } from "~/framework/resync"
import type { ApiClient } from "~/lib/api-client"
import { onSessionTeardown } from "~/lib/session-lifecycle"
import type { TableColumn } from "~/modules/dashboards/dashboards-client"
import type { ChecklistStatus, ValidationLevel } from "~/modules/projects/checklist-types"
import type { TaskLabel } from "~/modules/projects/task-labels"

export interface ProjectStatus {
  id: string
  projectId: string
  label: string
  color: string | null
  order: number
  terminal: boolean
}

export interface Task {
  id: string
  number: number
  key?: string
  projectId: string
  parentTaskId: string | null
  statusId: string
  title: string
  description: string | null
  assigneeId: string | null
  priority: string
  dueDate: string | null
  startDate: string | null
  position: number
  blocked: boolean
  completedAt: string | null
  /** The task's own release (free text); filters use the effective release. */
  release?: string | null
  /** Checklist summary (task detail, realtime echo); absent when unknown. */
  checklist?: ChecklistStatus | null
  /** Effective labels as the server computed them (own and inherited); absent on optimistic rows. */
  labels?: TaskLabel[]
  /**
   * Time keys: the server sends them only on a task of a project using time and budgets.
   * `realTotalMinutes` is the task's total, with no one's part named.
   */
  timeboxMinutes?: number | null
  realTotalMinutes?: number
  isMilestone?: boolean
  /** Values of the project's task fields, {fieldKey: value}; absent on optimistic rows. */
  fields?: Record<string, unknown>
  /** When the task entered its current status. */
  statusEnteredAt?: string | null
  threadId: string
  createdBy: string
  createdAt: string
  updatedAt: string
}

export interface ProjectDetail {
  id: string
  key?: string
  name: string
  description: string | null
  icon: string | null
  color: string | null
  /** Sidebar group heading; null or absent = ungrouped. */
  group?: string | null
  ownerId: string
  archivedAt: string | null
  createdAt: string
  updatedAt: string
  statuses: ProjectStatus[]
  /** Ordered validation levels; empty or absent = plain checklist mode. */
  validationLevels?: ValidationLevel[]
  /** Kanban cards show the checklist counters; absent reads as on. */
  checklistOnCards?: boolean
  /** The key no longer changes: the project holds a task (server rule). */
  keyLocked?: boolean
  /** A sales pipeline: its board shows deals. Absent on an ordinary project. */
  kind?: "pipeline"
  /** The project's client company; absent when none is set. */
  companyId?: string | null
  /**
   * Time and budgets on this project. The server sends the key only while the org uses it (or
   * the call just set it), so an absent key reads as off.
   */
  timeBudgets?: boolean
  /** When and by whom the switch was last turned; present once it was ever turned. */
  timeBudgetsChangedAt?: string
  timeBudgetsChangedBy?: { id: string; name: string }
  /** The project's task fields (dashboard column shape), in order; absent or empty = none. */
  fields?: TableColumn[]
}

type ProjectState = {
  current: ProjectDetail | null
  tasks: Task[]
  loading: boolean
  error: string | null
}

type ProjectsState = {
  byProjectId: Record<string, ProjectState>
  lastProjectId: string | null
  /** Task id to project id, from task reads (see noteTaskProject). */
  taskProjectIds: Record<string, string>
}

const emptyProjectState = (): ProjectState => ({
  current: null,
  tasks: [],
  loading: false,
  error: null,
})

const [state, setState] = createStore<ProjectsState>({
  byProjectId: {},
  lastProjectId: null,
  taskProjectIds: {},
})

function ensureEntry(projectId: string): void {
  if (!state.byProjectId[projectId]) {
    setState("byProjectId", projectId, emptyProjectState())
  }
}

function entryFor(projectId: string | null | undefined): ProjectState | null {
  if (!projectId) return null
  return state.byProjectId[projectId] ?? null
}

// Last API client seen — captured so the resync subscription can refetch the
// loaded project detail without holding a reactive reference (mirrors
// projects-store.ts).
let _projectApi: ApiClient | null = null

export async function loadProject(api: ApiClient, projectId: string): Promise<void> {
  setState("lastProjectId", projectId)
  return refetchProject(api, projectId)
}

/** Fetch project detail + tasks WITHOUT touching lastProjectId (used by the
 *  resync subscription, which refetches every loaded project in place). */
async function refetchProject(api: ApiClient, projectId: string): Promise<void> {
  _projectApi = api
  ensureEntry(projectId)
  setState("byProjectId", projectId, { loading: true, error: null })
  try {
    const project = await api.get<ProjectDetail>(`/projects/${projectId}`)
    setState("byProjectId", projectId, { current: project, loading: false })
    const tasks = await api.get<{ items: Task[] }>(`/projects/${projectId}/tasks`)
    const items = (tasks as unknown as { items?: Task[] }).items
    const rows = Array.isArray(items) ? items : (tasks as unknown as Task[])
    // A list row without a checklist summary keeps the one already known
    // (from the detail or a realtime echo) instead of dropping the counters.
    const known = new Map(
      (state.byProjectId[projectId]?.tasks ?? []).map((t) => [t.id, t.checklist]),
    )
    setState(
      "byProjectId",
      projectId,
      "tasks",
      Array.isArray(rows)
        ? rows.map((t) =>
            t.checklist === undefined && known.get(t.id) != null
              ? { ...t, checklist: known.get(t.id) }
              : t,
          )
        : rows,
    )
  } catch (err) {
    setState("byProjectId", projectId, { loading: false, error: (err as Error).message })
  }
}

// --- Resync subscription ---
// On a resync bump (WS `sync` frame or reconnect transition), refetch tasks +
// statuses for every project detail currently loaded. Kanban tabs are
// keep-alive mounted, so events dropped while disconnected would otherwise
// leave them stale forever (the projects LIST resubscribes in
// projects-store.ts; the per-project detail store did not). Idempotent.
let _projectResyncSubscribed = false

export function subscribeProjectResync(): void {
  if (_projectResyncSubscribed) return
  _projectResyncSubscribed = true
  subscribeResync(() => {
    const api = _projectApi
    if (!api) return
    for (const projectId of Object.keys(state.byProjectId)) {
      if (state.byProjectId[projectId]?.current) void refetchProject(api, projectId)
    }
  })
}

export function handleProjectEvent(
  action: string,
  data: { id: string } & Partial<ProjectDetail>,
): void {
  if (!data?.id) return
  const cur = state.byProjectId[data.id]?.current
  if (cur && cur.id === data.id) {
    if (action === "archive" || action === "archived") {
      setState("byProjectId", data.id, "current", { ...cur, archivedAt: new Date().toISOString() })
    } else if (action === "restore" || action === "restored") {
      setState("byProjectId", data.id, "current", { ...cur, archivedAt: null })
    } else if (action === "update" || action === "updated") {
      setState("byProjectId", data.id, "current", { ...cur, ...data })
    }
  }
}

/** Stable order of a project's task array: position, then creation time.
 *  Views sort for themselves; this keeps the stored list deterministic after
 *  a merge or an insert. */
function compareStoredTasks(a: Task, b: Task): number {
  return (
    (a.position ?? 0) - (b.position ?? 0) || (a.createdAt ?? "").localeCompare(b.createdAt ?? "")
  )
}

/** True when `incoming` is older than the row already held: a stale echo
 *  (e.g. the WS event of an earlier write arriving after a later POST/PATCH
 *  response) must never revert the row. Rows without `updatedAt` merge. */
function isStale(incoming: Partial<Task>, stored: Task): boolean {
  return (
    typeof incoming.updatedAt === "string" &&
    typeof stored.updatedAt === "string" &&
    incoming.updatedAt < stored.updatedAt
  )
}

/** A payload complete enough to render as a row (server events and API
 *  responses carry the full task; a bare `{id, statusId}` patch does not). */
function isRenderableRow(data: Partial<Task>): boolean {
  return typeof data.title === "string" && typeof data.statusId === "string"
}

function setProjectTasks(projectId: string, tasks: Task[]): void {
  setState("byProjectId", projectId, "tasks", [...tasks].sort(compareStoredTasks))
}

export function handleTaskEvent(
  action: string,
  data: { id: string; projectId?: string; fromProjectId?: string } & Partial<Task>,
): void {
  if (!data?.id) return

  // Where the task is held now (if loaded anywhere).
  const heldIn = Object.keys(state.byProjectId).find((id) =>
    state.byProjectId[id]?.tasks.some((t) => t.id === data.id),
  )

  // Resolve the target project. For update/delete the held project stands in
  // when the event omits projectId. For create we must rely on the explicit
  // projectId or, as a fallback, the currently active project.
  let projectId: string | undefined = data.projectId ?? heldIn

  if (!projectId && (action === "create" || action === "created") && state.lastProjectId) {
    // Some backends omit projectId on the echo. Fall back to the last active
    // project — if the event belongs to a different project it will be
    // discarded anyway when the task list is next fully fetched.
    projectId = state.lastProjectId
  }

  if (action === "delete" || action === "deleted") {
    const owner = heldIn ?? projectId
    const entry = owner ? state.byProjectId[owner] : undefined
    if (owner && entry?.tasks.some((t) => t.id === data.id)) {
      setState(
        "byProjectId",
        owner,
        "tasks",
        entry.tasks.filter((t) => t.id !== data.id),
      )
    }
    return
  }

  // A cross-project move leaves its source project: only an explicit
  // `fromProjectId` different from the target removes it there (a same-project
  // move never drops the row).
  const isMove = action === "move" || action === "moved"
  if (isMove && data.fromProjectId && projectId && data.fromProjectId !== projectId) {
    const source = state.byProjectId[data.fromProjectId]
    if (source?.tasks.some((t) => t.id === data.id)) {
      setState(
        "byProjectId",
        data.fromProjectId,
        "tasks",
        source.tasks.filter((t) => t.id !== data.id),
      )
    }
  }

  if (!projectId) return
  const entry = state.byProjectId[projectId]
  if (!entry) return
  const idx = entry.tasks.findIndex((t) => t.id === data.id)
  if (idx >= 0) {
    const stored = entry.tasks[idx]!
    if (isStale(data, stored)) return
    const { fromProjectId: _from, ...row } = data
    const next = [...entry.tasks]
    next[idx] = { ...stored, ...row } as Task
    setProjectTasks(projectId, next)
    return
  }
  const inserts = action === "create" || action === "created" || (isMove && isRenderableRow(data))
  if (inserts) {
    const { fromProjectId: _from, ...row } = data
    setProjectTasks(projectId, [...entry.tasks, row as Task])
  }
}

export function handleProjectStatusEvent(
  action: string,
  data: { id: string; projectId?: string } & Partial<ProjectStatus>,
): void {
  const projectId = data.projectId
  if (!projectId) return
  const cur = state.byProjectId[projectId]?.current
  if (!cur) return
  const idx = cur.statuses.findIndex((s) => s.id === data.id)
  if (action === "delete" || action === "deleted") {
    if (idx >= 0) {
      setState("byProjectId", projectId, "current", {
        ...cur,
        statuses: cur.statuses.filter((s) => s.id !== data.id),
      })
    }
    return
  }
  if (idx >= 0) {
    const next = [...cur.statuses]
    next[idx] = { ...next[idx]!, ...data } as ProjectStatus
    setState("byProjectId", projectId, "current", {
      ...cur,
      statuses: next.sort((a, b) => a.order - b.order),
    })
  } else if ((action === "create" || action === "created") && data.id) {
    setState("byProjectId", projectId, "current", {
      ...cur,
      statuses: [...cur.statuses, data as ProjectStatus].sort((a, b) => a.order - b.order),
    })
  }
}

/** Set the checklist summary of a loaded task (no-op when the task is not loaded). */
export function setTaskChecklist(taskId: string, status: ChecklistStatus | null): void {
  for (const projectId of Object.keys(state.byProjectId)) {
    const idx = state.byProjectId[projectId]?.tasks.findIndex((t) => t.id === taskId) ?? -1
    if (idx >= 0) setState("byProjectId", projectId, "tasks", idx, "checklist", status)
  }
}

/** Last API client used to load a project (lets realtime handlers refetch). */
export function projectApi(): ApiClient | null {
  return _projectApi
}

export const projectStore = {
  get current() {
    return entryFor(state.lastProjectId)?.current ?? null
  },
  get tasks() {
    return entryFor(state.lastProjectId)?.tasks ?? []
  },
  get loading() {
    return entryFor(state.lastProjectId)?.loading ?? false
  },
  get error() {
    return entryFor(state.lastProjectId)?.error ?? null
  },
  project(projectId: string) {
    return entryFor(projectId)?.current ?? null
  },
  tasksFor(projectId: string) {
    return entryFor(projectId)?.tasks ?? []
  },
  loadingFor(projectId: string) {
    return entryFor(projectId)?.loading ?? false
  },
  errorFor(projectId: string) {
    return entryFor(projectId)?.error ?? null
  },
  projectIdForTask(taskId: string) {
    return (
      Object.keys(state.byProjectId).find((id) =>
        state.byProjectId[id]?.tasks.some((t) => t.id === taskId),
      ) ??
      state.taskProjectIds[taskId] ??
      null
    )
  },
  /** Remember a task's project from its own read (the task page), so the
   *  sidebar knows it even when the project's task list holds no such row. */
  noteTaskProject(taskId: string, projectId: string) {
    if (state.taskProjectIds[taskId] !== projectId) setState("taskProjectIds", taskId, projectId)
  },
  task(taskId: string) {
    for (const entry of Object.values(state.byProjectId)) {
      const task = entry.tasks.find((t) => t.id === taskId)
      if (task) return task
    }
    return null
  },
  load: loadProject,
  /** Read the project and its tasks again in place (after the server said time and budgets are off). */
  refresh: refetchProject,
  /** Reflect an archive / restore the server confirmed on the open project. */
  setArchivedAt(projectId: string, archivedAt: string | null) {
    if (state.byProjectId[projectId]?.current) {
      setState("byProjectId", projectId, "current", "archivedAt", archivedAt)
    }
  },
  handleProjectEvent,
  handleTaskEvent,
  handleProjectStatusEvent,
  _setForTest(s: Partial<ProjectState> & { projectId?: string }) {
    const projectId = s.projectId ?? s.current?.id ?? state.lastProjectId ?? "test-project"
    ensureEntry(projectId)
    setState("lastProjectId", projectId)
    setState("byProjectId", projectId, {
      current: s.current ?? state.byProjectId[projectId]?.current ?? null,
      tasks: s.tasks ?? state.byProjectId[projectId]?.tasks ?? [],
      loading: s.loading ?? state.byProjectId[projectId]?.loading ?? false,
      error: s.error ?? state.byProjectId[projectId]?.error ?? null,
    })
  },
  _resetForTest() {
    setState({ byProjectId: {}, lastProjectId: null, taskProjectIds: {} })
  },
}

/** Reset on logout so a new session cannot see the previous user's project detail. */
export function resetProjectStore(): void {
  setState({ byProjectId: {}, lastProjectId: null, taskProjectIds: {} })
}
onSessionTeardown(resetProjectStore)
