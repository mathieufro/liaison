// SPDX-License-Identifier: FSL-1.1-ALv2
// Time and budgets on the web: the tool calls behind the task's Timebox chip and Took field, the
// project's budget line and panel, and the switch's plan. Each call runs as the viewer through
// the one run-tool route; a project that does not use time and budgets answers `planning_off`,
// which callers turn into "refetch the project and hide the time fields".
import { formatDuration } from "@liaison/shared"
import { createStore, produce } from "solid-js/store"
import type { ApiClient } from "~/lib/api-client"
import { ApiError } from "~/lib/api-error"
import { runTool } from "~/lib/run-tool"
import { onSessionTeardown } from "~/lib/session-lifecycle"
import type { ProjectDetail } from "~/modules/projects/project-store"

/** Whether the project uses time and budgets: the only gate of every time field on screen. */
export function timeOn(
  project: Pick<ProjectDetail, "timeBudgets" | "kind"> | null | undefined,
): boolean {
  return project?.timeBudgets === true && project.kind !== "pipeline"
}

export type TimeOutcome<T> =
  | { kind: "ok"; data: T }
  | { kind: "off" }
  | { kind: "error"; code: string; message: string }

const OFF_CODES = new Set(["planning_off", "feature_off"])

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v)
}

async function call<T>(
  api: ApiClient,
  tool: string,
  params: Record<string, unknown>,
): Promise<TimeOutcome<T>> {
  try {
    const data = await runTool<unknown>(api, `projects:${tool}`, params, {
      suppressGlobalError: true,
    })
    if (isRecord(data)) {
      const err = isRecord(data.error) ? data.error : data
      const code = typeof err.code === "string" ? err.code : null
      if (code && OFF_CODES.has(code)) return { kind: "off" }
      if (isRecord(data.error) && code) {
        const message = typeof err.message === "string" ? err.message : code
        return { kind: "error", code, message }
      }
    }
    return { kind: "ok", data: data as T }
  } catch (err) {
    if (err instanceof ApiError) {
      if (err.code && OFF_CODES.has(err.code)) return { kind: "off" }
      return { kind: "error", code: err.code ?? "error", message: err.message }
    }
    return {
      kind: "error",
      code: "error",
      message: err instanceof Error ? err.message : String(err),
    }
  }
}

// ─── A task: timebox and Took ─────────────────────────────────────────────────

export interface TookEntry {
  id: string
  date: string
  minutes: number
  enteredVia: "field" | "agent" | "mcp"
  changedBy?: string
}

export interface TaskTime {
  /** The viewer's own entries: never anyone else's. */
  mine: TookEntry[]
  totalMinutes: number
}

export const readTaskTime = (api: ApiClient, taskId: string) =>
  call<TaskTime>(api, "task_time_get", { taskId })

/** Save the timebox as typed ("3 days", "20 h"); null clears it. */
export async function saveTimebox(
  api: ApiClient,
  taskId: string,
  timebox: string | null,
): Promise<TimeOutcome<{ timeboxMinutes: number | null }>> {
  const out = await call<{ timeboxMinutes?: number | null }>(api, "update", { taskId, timebox })
  return out.kind === "ok"
    ? { kind: "ok", data: { timeboxMinutes: out.data.timeboxMinutes ?? null } }
    : out
}

/** Save the viewer's own Took as typed; null clears it. `date` only on a project with dated hours. */
export const saveTook = (api: ApiClient, taskId: string, time: string | null, date?: string) =>
  call<{ totalMinutes: number }>(api, "task_time_set", {
    taskId,
    time,
    ...(date ? { date } : {}),
  })

// ─── A project: budget and plan ───────────────────────────────────────────────

export interface BudgetData {
  projectId: string
  projectName: string
  line: string
  timebox?: number
  real: number
  left?: number
  partial: boolean
  coverage: { withEntries: number; total: number }
  /** A fixed price, or the rate of a project billed by the day or by the hour. */
  money?:
    | { price: number; currency: string | null }
    | { rate: number; per: "day" | "hour"; currency: string | null }
  state?: "hours-only"
  milestones: Array<{
    id: string
    name: string
    state: "todo" | "started" | "done"
    plannedMinutes?: number
    realMinutes: number
  }>
  notInNumbers: Array<{ text: string }>
  datedHours: boolean
}

export const readBudget = (api: ApiClient, projectId: string) =>
  call<BudgetData>(api, "budget_get", { projectId })

export interface TimePlanPatch {
  basis?: "none" | "hourly" | "daily" | "fixed" | "retainer"
  billerId?: string | null
  datedHours?: boolean
}

/** The plan as its edit form reads it back; the money keys only reach a holder of the money scope. */
export interface TimePlanRead {
  projectId: string
  basis: "none" | "hourly" | "daily" | "fixed" | "retainer"
  billerId: string | null
  billerName: string | null
  datedHours: boolean
  rate?: number | null
  fixedPrice?: number | null
  currency?: string | null
}

/** Read a project's plan back (REST, under the same money-scope rule as the budget). */
export async function readPlan(
  api: ApiClient,
  projectId: string,
): Promise<TimeOutcome<TimePlanRead>> {
  try {
    const data = await api.get<TimePlanRead>(`/projects/${projectId}/time-plan`, {
      suppressGlobalError: true,
    })
    return { kind: "ok", data }
  } catch (err) {
    if (err instanceof ApiError) {
      if (err.code && OFF_CODES.has(err.code)) return { kind: "off" }
      return { kind: "error", code: err.code ?? "error", message: err.message }
    }
    return {
      kind: "error",
      code: "error",
      message: err instanceof Error ? err.message : String(err),
    }
  }
}

export const savePlan = (api: ApiClient, projectId: string, patch: TimePlanPatch) =>
  call<{ message?: string }>(api, "time_plan_set", { projectId, ...patch })

export const saveRate = (api: ApiClient, projectId: string, rate: number | null) =>
  call<{ message?: string }>(api, "billing_terms_set", { projectId, rate })

// ─── The budget of each open project ──────────────────────────────────────────

export type BudgetState =
  | { status: "loading" }
  | { status: "error" }
  | { status: "ready"; data: BudgetData }

const [budgets, setBudgets] = createStore<Record<string, BudgetState>>({})
const inFlight = new Map<string, number>()

export const budgetFor = (projectId: string): BudgetState | undefined => budgets[projectId]

/** Read (or read again) a project's budget. A `planning_off` answer drops it. */
export async function loadBudget(
  api: ApiClient,
  projectId: string,
  opts: { onOff?: () => void } = {},
): Promise<void> {
  const ticket = (inFlight.get(projectId) ?? 0) + 1
  inFlight.set(projectId, ticket)
  if (!budgets[projectId] || budgets[projectId]?.status === "error") {
    setBudgets(projectId, { status: "loading" })
  }
  const out = await readBudget(api, projectId)
  if (inFlight.get(projectId) !== ticket) return
  if (out.kind === "ok") setBudgets(projectId, { status: "ready", data: out.data })
  else if (out.kind === "off") {
    setBudgets(
      produce((b) => {
        delete b[projectId]
      }),
    )
    opts.onOff?.()
  } else setBudgets(projectId, { status: "error" })
}

/** Drop what is held for one project (its switch changed), so the next view reads it fresh. */
export function forgetBudget(projectId: string): void {
  inFlight.delete(projectId)
  setBudgets(
    produce((b) => {
      delete b[projectId]
    }),
  )
}

export function resetBudgets(): void {
  inFlight.clear()
  setBudgets(
    produce((b) => {
      for (const id of Object.keys(b)) delete b[id]
    }),
  )
}
onSessionTeardown(resetBudgets)

/** Minutes as a person reads them in hours: "2 h", "1 h 30", "45 m". */
export const formatMinutes = (minutes: number): string => formatDuration(minutes, "h")
