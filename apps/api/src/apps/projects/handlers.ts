// SPDX-License-Identifier: FSL-1.1-ALv2
// Projects handlers: a core app's server module (modules/apps/core/registry.ts).
// Every handler the manifest names is a named export `(params, ctx, ...extra)`,
// imported and called in the API process with a typed host ctx
// (modules/apps/core/ctx.ts): the run's bridge methods, called directly. Each
// handler dispatches to a `projects_*` host method (modules/apps/sandbox/bridge/projects.ts).

import { csvCell } from "@liaison/shared"
import type { CoreCtx } from "~/modules/apps/core/ctx"
import { mixedCurrencies } from "./service/currency"
import { composeMargin, type InvoicedRead, type MarginCost } from "./service/margin"

export interface ProjectsMethods {
  projects_activityRead(paramsJson: string): Promise<string>
  projects_search: (paramsJson: string) => Promise<string>
  projects_get: (paramsJson: string) => Promise<string>
  projects_createProject: (paramsJson: string) => Promise<string>
  projects_createTask: (paramsJson: string) => Promise<string>
  projects_updateTask: (paramsJson: string) => Promise<string>
  projects_moveTask: (paramsJson: string) => Promise<string>
  projects_addStatus: (paramsJson: string) => Promise<string>
  projects_updateStatus: (paramsJson: string) => Promise<string>
  projects_updateProject: (paramsJson: string) => Promise<string>
  projects_deleteStatus: (paramsJson: string) => Promise<string>
  projects_tasksByAssignee: (paramsJson: string) => Promise<string>
  projects_tasksByProject: (paramsJson: string) => Promise<string>
  projects_portfolioRollup: (paramsJson: string) => Promise<string>
  projects_dealsPipelineCreate: (paramsJson: string) => Promise<string>
  projects_dealsUpdate: (paramsJson: string) => Promise<string>
  projects_dealsSearch: (paramsJson: string) => Promise<string>
  projects_dealsRollup: (paramsJson: string) => Promise<string>
  projects_dealsFollowupCandidates: (paramsJson: string) => Promise<string>
  projects_dealSendState: (paramsJson: string) => Promise<string>
  projects_companyProjects: (paramsJson: string) => Promise<string>
  projects_tasksAggregate: (paramsJson: string) => Promise<string>
  projects_deleteTask: (paramsJson: string) => Promise<string>
  projects_addComment: (paramsJson: string) => Promise<string>
  projects_listComments: (paramsJson: string) => Promise<string>
  projects_mergeTasks: (paramsJson: string) => Promise<string>
  projects_instantiateTemplate: (paramsJson: string) => Promise<string>
  projects_setFields: (paramsJson: string) => Promise<string>
  projects_saveTemplate: (paramsJson: string) => Promise<string>
  projects_listTemplates: (paramsJson: string) => Promise<string>
  projects_addDependency: (paramsJson: string) => Promise<string>
  projects_attentionItems: (paramsJson: string) => Promise<string>
  projects_taskTimeSet: (paramsJson: string) => Promise<string>
  projects_taskTimeGet: (paramsJson: string) => Promise<string>
  projects_taskTimeCorrect: (paramsJson: string) => Promise<string>
  projects_timePlanSet: (paramsJson: string) => Promise<string>
  projects_billingTermsSet: (paramsJson: string) => Promise<string>
  projects_periodTimeboxSet: (paramsJson: string) => Promise<string>
  projects_budgetGet: (paramsJson: string) => Promise<string>
  projects_marginCost: (paramsJson: string) => Promise<string>
  projects_costRatesList: (paramsJson: string) => Promise<string>
  projects_costRateSet: (paramsJson: string) => Promise<string>
  /** A declared cross-app call (manifest `cross_app_calls`), answered in the K4 envelope. */
  executeTool: (toolName: string, paramsJson: string) => Promise<string>
  projects_capacityGet: (paramsJson: string) => Promise<string>
  projects_capacityMove: (paramsJson: string) => Promise<string>
  projects_timesheetGet: (paramsJson: string) => Promise<string>
  projects_timesheetExport: (paramsJson: string) => Promise<string>
  projects_daysOffSet: (paramsJson: string) => Promise<string>
  projects_daysOffList: (paramsJson: string) => Promise<string>
  projects_daysOffRemove: (paramsJson: string) => Promise<string>
  projects_timeSettingsGet: (paramsJson: string) => Promise<string>
  projects_timeSettingsSet: (paramsJson: string) => Promise<string>
  projects_reconcileFacts: (paramsJson: string) => Promise<string>
  projects_reconcilePropose: (paramsJson: string) => Promise<string>
  projects_reconcileLineUpdate: (paramsJson: string) => Promise<string>
  projects_reconcileGet: (paramsJson: string) => Promise<string>
  db_findMany: (entity: string, optsJson: string) => Promise<string>
  kernel_findOne?: (entity: string, id: string) => Promise<string>
  projects_resolveAssignee?: (paramsJson: string) => Promise<string>
  projects_checklistGet: (paramsJson: string) => Promise<string>
  projects_checklistAddItems: (paramsJson: string) => Promise<string>
  projects_checklistUpdateItem: (paramsJson: string) => Promise<string>
  projects_checklistSetValidation: (paramsJson: string) => Promise<string>
  projects_checklistRemoveItem: (paramsJson: string) => Promise<string>
  projects_labelsList: (paramsJson: string) => Promise<string>
  projects_labelsTree: (paramsJson: string) => Promise<string>
  projects_labelsCreate: (paramsJson: string) => Promise<string>
  projects_labelsUpdate: (paramsJson: string) => Promise<string>
  projects_labelsArchive: (paramsJson: string) => Promise<string>
  projects_labelsReorder: (paramsJson: string) => Promise<string>
  config_get: (key: string) => Promise<unknown>
}

type ProjectsCtx = CoreCtx<ProjectsMethods>

// Webhook verify runs BEFORE a full RPC bridge exists (webhooks/routes.ts
// builds a lighter-weight bridge just for verification), so its bridge shape
// only carries the crypto/config primitives — no projects_* methods.
interface CiWebhookVerifyBridge {
  config_get: (key: string) => Promise<unknown>
  crypto_hmacSha256Base64: (secret: string, body: string) => Promise<string>
  crypto_timingSafeEqual: (a: string, b: string) => Promise<boolean>
}

const PROJECTS_EXPORT_COLUMNS: Array<[string, string]> = [
  ["id", "id"],
  ["title", "title"],
  ["projectId", "project_id"],
  ["statusId", "status_id"],
  ["priority", "priority"],
  ["assigneeId", "assignee_id"],
  ["dueDate", "due_date"],
  ["createdAt", "created_at"],
]

export async function search(
  params: Record<string, unknown> | undefined,
  ctx: ProjectsCtx,
): Promise<unknown> {
  return JSON.parse(await ctx.projects_search(JSON.stringify(params ?? {})))
}

export async function get(
  params: Record<string, unknown> | undefined,
  ctx: ProjectsCtx,
): Promise<unknown> {
  return JSON.parse(await ctx.projects_get(JSON.stringify(params ?? {})))
}

/**
 * Who a pending approval about a task is for: the task's assignee. A deal's task also names the
 * deal's company, whose account manager comes next when the owner cannot decide.
 */
export async function approvalRouteRead(
  params: Record<string, unknown> | undefined,
  ctx: ProjectsCtx,
): Promise<unknown> {
  if (params?.entityType !== "task" || typeof params.entityId !== "string")
    return { personId: null, companyId: null }
  const data = JSON.parse(await ctx.projects_get(JSON.stringify({ taskId: params.entityId })))
  const assignee = data?.task?.assigneeId ?? data?.assigneeId
  let companyId: string | null = null
  try {
    const deals = JSON.parse(
      await ctx.projects_dealsSearch(JSON.stringify({ taskId: params.entityId, limit: 1 })),
    )
    const found = deals?.items?.[0]?.deal?.companyId
    companyId = typeof found === "string" ? found : null
  } catch {
    // Not a deal the asker can see: no company, the assignee alone.
  }
  return { personId: typeof assignee === "string" ? assignee : null, companyId }
}

// task label taxonomy: pass-throughs to the projects_labels* bridge methods.
export async function labelsList(
  params: Record<string, unknown> | undefined,
  ctx: ProjectsCtx,
): Promise<unknown> {
  return JSON.parse(await ctx.projects_labelsList(JSON.stringify(params ?? {})))
}

export async function labelsTree(
  params: Record<string, unknown> | undefined,
  ctx: ProjectsCtx,
): Promise<unknown> {
  return JSON.parse(await ctx.projects_labelsTree(JSON.stringify(params ?? {})))
}

export async function labelsCreate(
  params: Record<string, unknown> | undefined,
  ctx: ProjectsCtx,
): Promise<unknown> {
  return JSON.parse(await ctx.projects_labelsCreate(JSON.stringify(params ?? {})))
}

export async function labelsUpdate(
  params: Record<string, unknown> | undefined,
  ctx: ProjectsCtx,
): Promise<unknown> {
  return JSON.parse(await ctx.projects_labelsUpdate(JSON.stringify(params ?? {})))
}

export async function labelsArchive(
  params: Record<string, unknown> | undefined,
  ctx: ProjectsCtx,
): Promise<unknown> {
  return JSON.parse(await ctx.projects_labelsArchive(JSON.stringify(params ?? {})))
}

export async function labelsReorder(
  params: Record<string, unknown> | undefined,
  ctx: ProjectsCtx,
): Promise<unknown> {
  return JSON.parse(await ctx.projects_labelsReorder(JSON.stringify(params ?? {})))
}

export async function createProject(
  params: Record<string, unknown> | undefined,
  ctx: ProjectsCtx,
): Promise<unknown> {
  return JSON.parse(await ctx.projects_createProject(JSON.stringify(params ?? {})))
}

export async function createTask(
  params: Record<string, unknown> | undefined,
  ctx: ProjectsCtx,
): Promise<unknown> {
  return JSON.parse(await ctx.projects_createTask(JSON.stringify(params ?? {})))
}

export async function updateTask(
  params: Record<string, unknown> | undefined,
  ctx: ProjectsCtx,
): Promise<unknown> {
  return JSON.parse(await ctx.projects_updateTask(JSON.stringify(params ?? {})))
}

export async function moveTask(
  params: Record<string, unknown> | undefined,
  ctx: ProjectsCtx,
): Promise<unknown> {
  return JSON.parse(await ctx.projects_moveTask(JSON.stringify(params ?? {})))
}

export async function addStatus(
  params: Record<string, unknown> | undefined,
  ctx: ProjectsCtx,
): Promise<unknown> {
  return JSON.parse(await ctx.projects_addStatus(JSON.stringify(params ?? {})))
}

export async function updateProject(
  params: Record<string, unknown> | undefined,
  ctx: ProjectsCtx,
): Promise<unknown> {
  return JSON.parse(await ctx.projects_updateProject(JSON.stringify(params ?? {})))
}

export async function updateStatus(
  params: Record<string, unknown> | undefined,
  ctx: ProjectsCtx,
): Promise<unknown> {
  return JSON.parse(await ctx.projects_updateStatus(JSON.stringify(params ?? {})))
}

export async function deleteStatus(
  params: Record<string, unknown> | undefined,
  ctx: ProjectsCtx,
): Promise<unknown> {
  return JSON.parse(await ctx.projects_deleteStatus(JSON.stringify(params ?? {})))
}

// --- Stage-time preflights for the GATED tools --------------------------
//
// WHY: a gated call must NOT be parked for a human when the data it needs is
// missing or ambiguous. Without these, the gated tools (`delete`, `merge`,
// `status_delete`, `checklist_remove_item`; `create`, `update`, `status_add`
// and `status_update` were gated too until 2026-09-28 and now run directly,
// refusing through the same service resolvers) validated their inputs only
// inside the post-approval handler: the approver clicked approve and got back "no project with that
// name" or "status has tasks", an error only the AGENT could have fixed, from
// a card it could no longer edit. The manifest `preflight` slot runs these
// BEFORE the approval request is created (execute-tool's gated-preflight
// hook), so the refusal lands in the agent's own loop and nothing is queued.
//
// Contract: READ-ONLY, side-effect free, and FAIL OPEN. They refuse only on a
// condition they actually OBSERVED; anything they cannot determine (a bridge
// read that throws, a truncated project page, a missing read scope) returns
// ok and leaves the decision to the handler. Every handler-side guard stays
// exactly where it was: a preflight is an early refusal, never a replacement
// (the row it reads can still change between staging and approval).
//
// The checks read through the projects bridge's read methods, as the handlers
// do, rather than calling the host resolvers (service/resolve.ts,
// service/statuses.ts, service/tasks.ts). They are deliberately narrow and one
// copy each, reused by every tool below.

interface ProjectsPreflightRefusal {
  error: { code: string; message: string; retryable: boolean }
}

type ProjectsPreflightResult = { ok: true } | ProjectsPreflightRefusal

const PROJECTS_PREFLIGHT_OK: ProjectsPreflightResult = { ok: true }

function projectsPreflightRefuse(code: string, message: string): ProjectsPreflightRefusal {
  return { error: { code, message, retryable: false } }
}

const PROJECTS_PREFLIGHT_UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

function projectsPreflightIsUuid(value: string): boolean {
  return PROJECTS_PREFLIGHT_UUID_RE.test(value)
}

function projectsPreflightString(value: unknown): string {
  return typeof value === "string" ? value.trim() : ""
}

interface PreflightProjectStatus {
  id: string
  label: string
  terminal?: boolean
}

interface PreflightProjectDetail {
  id?: string
  statuses?: PreflightProjectStatus[]
}

type PreflightProjectResolution =
  | { kind: "resolved"; projectId: string; detail: PreflightProjectDetail | null }
  | { kind: "refuse"; refusal: ProjectsPreflightRefusal }
  | { kind: "unknown" }

/** Read a project's detail (id, statuses). null when the read could not answer. */
async function preflightLoadProjectDetail(
  ctx: ProjectsCtx,
  projectId: string,
): Promise<PreflightProjectDetail | null | "missing"> {
  let raw: string
  try {
    raw = await ctx.projects_get(JSON.stringify({ projectId }))
  } catch (err) {
    // Only loadProjectDetail's own `project_not_found` is proof the project is
    // not there. Any other read failure (a blip, a timeout) must NOT refuse a
    // call the handler would have accepted, so it reads as "cannot tell".
    const message = String((err as { message?: unknown })?.message ?? err).toLowerCase()
    return message.includes("project_not_found") ? "missing" : null
  }
  try {
    const parsed = JSON.parse(raw) as PreflightProjectDetail & { error?: unknown }
    if (parsed?.error) return null
    return parsed
  } catch {
    return null
  }
}

/**
 * Mirror of `resolveProjectId` (service/resolve.ts) over the read bridge: a
 * UUID is taken as-is (but must exist), otherwise the ref is matched against
 * the org's ACTIVE projects by id prefix then by exact name, and an absent ref
 * falls back to the single active project.
 */
async function preflightResolveProject(
  params: Record<string, unknown>,
  ctx: ProjectsCtx,
): Promise<PreflightProjectResolution> {
  const rawId = projectsPreflightString(params.projectId)
  const rawName = projectsPreflightString(params.projectName)

  if (rawId && projectsPreflightIsUuid(rawId)) {
    const detail = await preflightLoadProjectDetail(ctx, rawId)
    if (detail === "missing") {
      return {
        kind: "refuse",
        refusal: projectsPreflightRefuse("not_found", "project not found"),
      }
    }
    if (detail === null) return { kind: "unknown" }
    return { kind: "resolved", projectId: rawId, detail }
  }

  const pageLimit = 100
  let active: Array<{ id: string; name: string }>
  try {
    const found = JSON.parse(await ctx.projects_search(JSON.stringify({ limit: pageLimit }))) as {
      items?: Array<{ type?: string; id?: string; name?: string }>
    }
    if (!Array.isArray(found?.items)) return { kind: "unknown" }
    active = found.items
      .filter((i) => i.type === "project" && typeof i.id === "string")
      .map((i) => ({ id: String(i.id), name: String(i.name ?? "") }))
  } catch {
    return { kind: "unknown" }
  }
  // A full page may be only part of the board: never refuse on a partial view.
  const truncated = active.length >= pageLimit

  const resolveTo = async (projectId: string): Promise<PreflightProjectResolution> => {
    const detail = await preflightLoadProjectDetail(ctx, projectId)
    if (detail === "missing" || detail === null) return { kind: "unknown" }
    return { kind: "resolved", projectId, detail }
  }

  if (!rawId && !rawName) {
    if (active.length > 1) {
      return {
        kind: "refuse",
        refusal: projectsPreflightRefuse("project_ambiguous", "multiple active projects"),
      }
    }
    if (truncated) return { kind: "unknown" }
    if (active.length === 0) {
      return {
        kind: "refuse",
        refusal: projectsPreflightRefuse("project_required", "no active projects"),
      }
    }
    return resolveTo(active[0]!.id)
  }

  if (rawId && !rawName && /^[0-9a-f]{6,}[0-9a-f-]*$/i.test(rawId)) {
    const prefix = rawId.toLowerCase()
    const byPrefix = active.filter((p) => p.id.toLowerCase().startsWith(prefix))
    if (byPrefix.length > 1) {
      return {
        kind: "refuse",
        refusal: projectsPreflightRefuse(
          "project_ambiguous",
          "multiple projects match that id prefix",
        ),
      }
    }
    if (byPrefix.length === 1 && !truncated) return resolveTo(byPrefix[0]!.id)
    // No prefix hit: fall through to the name branch, as the host resolver does.
  }

  const wanted = (rawName || rawId).toLowerCase()
  const byName = active.filter((p) => p.name.toLowerCase() === wanted)
  if (byName.length > 1) {
    return {
      kind: "refuse",
      refusal: projectsPreflightRefuse("project_ambiguous", "multiple projects match"),
    }
  }
  if (truncated) return { kind: "unknown" }
  if (byName.length === 0) {
    return {
      kind: "refuse",
      refusal: projectsPreflightRefuse("project_required", "no project with that name"),
    }
  }
  return resolveTo(byName[0]!.id)
}

/** Mirror of `resolveStatusRef` (service/resolve.ts) over a loaded status list. */
function preflightResolveStatus(
  statuses: PreflightProjectStatus[],
  input: Record<string, unknown>,
): { kind: "resolved"; statusId: string } | { kind: "refuse"; refusal: ProjectsPreflightRefusal } {
  const byId = projectsPreflightString(input.statusId)
  const label = (
    byId && !projectsPreflightIsUuid(byId) ? byId : projectsPreflightString(input.statusLabel)
  ).trim()
  if (byId && projectsPreflightIsUuid(byId)) {
    const hit = statuses.find((s) => s.id === byId)
    if (!hit) {
      return {
        kind: "refuse",
        refusal: projectsPreflightRefuse("status_not_found", "status not in project"),
      }
    }
    return { kind: "resolved", statusId: hit.id }
  }
  if (!label) {
    return {
      kind: "refuse",
      refusal: projectsPreflightRefuse("status_required", "statusId or statusLabel required"),
    }
  }
  const matches = statuses.filter((s) => String(s.label).toLowerCase() === label.toLowerCase())
  if (matches.length > 1) {
    return {
      kind: "refuse",
      refusal: projectsPreflightRefuse("status_ambiguous", "multiple statuses match that label"),
    }
  }
  if (matches.length === 0) {
    return {
      kind: "refuse",
      refusal: projectsPreflightRefuse(
        "status_not_found",
        `no status labelled ${JSON.stringify(label)} in this project`,
      ),
    }
  }
  return { kind: "resolved", statusId: matches[0]!.id }
}

const PROJECTS_PREFLIGHT_TASK_MISS = ["no task with key", "task not found", "must be a uuid"]

type PreflightTaskResolution =
  | { kind: "resolved"; taskId: string }
  | { kind: "refuse"; refusal: ProjectsPreflightRefusal }
  | { kind: "unknown" }

/**
 * Resolve a task ref (UUID or display key like ERB-12) through the read path,
 * i.e. the same `resolveTaskRef` + `getTask` the write bridge runs first. Only
 * a recognised "there is no such task" failure refuses; every other read error
 * is left to the handler.
 */
async function preflightResolveTask(
  ref: string,
  ctx: ProjectsCtx,
): Promise<PreflightTaskResolution> {
  if (!ref) return { kind: "unknown" }
  let raw: string
  try {
    raw = await ctx.projects_get(JSON.stringify({ taskId: ref }))
  } catch (err) {
    const message = String((err as { message?: unknown })?.message ?? err).toLowerCase()
    if (PROJECTS_PREFLIGHT_TASK_MISS.some((m) => message.includes(m))) {
      return {
        kind: "refuse",
        refusal: projectsPreflightRefuse("not_found", `no task with key ${JSON.stringify(ref)}`),
      }
    }
    return { kind: "unknown" }
  }
  try {
    const parsed = JSON.parse(raw) as { id?: string; error?: unknown }
    if (!parsed || parsed.error || typeof parsed.id !== "string") return { kind: "unknown" }
    return { kind: "resolved", taskId: parsed.id }
  } catch {
    return { kind: "unknown" }
  }
}

/** `status_delete`: refuse before the gate when the column still holds tasks
 *  (they must be moved out first) or when it is the board's last column. */
export async function deleteStatusPreflight(
  params: Record<string, unknown> | undefined,
  ctx: ProjectsCtx,
): Promise<ProjectsPreflightResult> {
  const p = params ?? {}
  const project = await preflightResolveProject(p, ctx)
  if (project.kind === "refuse") return project.refusal
  if (project.kind !== "resolved") return PROJECTS_PREFLIGHT_OK
  const statuses = project.detail?.statuses
  if (!Array.isArray(statuses)) return PROJECTS_PREFLIGHT_OK
  const status = preflightResolveStatus(statuses, p)
  if (status.kind === "refuse") return status.refusal
  if (statuses.length <= 1) {
    return projectsPreflightRefuse("last_status", "project must keep at least one status")
  }
  try {
    const counted = JSON.parse(
      await ctx.projects_tasksByProject(
        JSON.stringify({
          projectId: project.projectId,
          statusId: status.statusId,
          countOnly: true,
        }),
      ),
    ) as { totalCount?: number; error?: unknown }
    if (!counted?.error && typeof counted?.totalCount === "number") {
      // The count is of LIVE tasks only, so zero here is not proof the column
      // is empty (archived rows still block the delete): the handler keeps its
      // own status_in_use guard, this one just refuses the obvious case early.
      if (counted.totalCount > 0) {
        return projectsPreflightRefuse("status_in_use", "Status has tasks")
      }
    }
  } catch {
    // Unreadable: leave the in-use check to the handler.
  }
  return PROJECTS_PREFLIGHT_OK
}

/** `checklist_remove_item`: no point asking a human to approve removing an
 *  item that is not there. Reads the item's checklist through the task it
 *  names when given; fails open otherwise. */
export async function checklistRemoveItemPreflight(
  params: Record<string, unknown> | undefined,
  ctx: ProjectsCtx,
): Promise<ProjectsPreflightResult> {
  const p = params ?? {}
  const itemId = projectsPreflightString(p.itemId)
  if (!itemId) return projectsPreflightRefuse("invalid_params", "itemId required")
  if (!projectsPreflightIsUuid(itemId)) {
    return projectsPreflightRefuse("not_found", "checklist item not found")
  }
  const taskRef = projectsPreflightString(p.taskId)
  if (!taskRef) return PROJECTS_PREFLIGHT_OK
  try {
    const view = JSON.parse(
      await ctx.projects_checklistGet(JSON.stringify({ taskId: taskRef })),
    ) as { items?: Array<{ id?: string }>; error?: { code?: string } }
    if (view?.error?.code === "not_found") {
      return projectsPreflightRefuse("not_found", `no task with key ${JSON.stringify(taskRef)}`)
    }
    if (!Array.isArray(view?.items)) return PROJECTS_PREFLIGHT_OK
    if (!view.items.some((i) => i.id === itemId)) {
      return projectsPreflightRefuse("not_found", "checklist item not found on that task")
    }
  } catch {
    // Unreadable: leave it to the handler.
  }
  return PROJECTS_PREFLIGHT_OK
}

/** `delete`: same, no point asking a human to approve deleting nothing. */
export async function deleteTaskPreflight(
  params: Record<string, unknown> | undefined,
  ctx: ProjectsCtx,
): Promise<ProjectsPreflightResult> {
  const p = params ?? {}
  const task = await preflightResolveTask(projectsPreflightString(p.taskId), ctx)
  if (task.kind === "refuse") return task.refusal
  return PROJECTS_PREFLIGHT_OK
}

/** `merge`: both sides must exist, and a task cannot be merged into itself
 *  (the same task reached by id and by display key is still itself). */
export async function mergeTasksPreflight(
  params: Record<string, unknown> | undefined,
  ctx: ProjectsCtx,
): Promise<ProjectsPreflightResult> {
  const p = params ?? {}
  const sourceRef = projectsPreflightString(p.sourceId)
  const targetRef = projectsPreflightString(p.targetId)
  if (sourceRef && sourceRef === targetRef) {
    return projectsPreflightRefuse("invalid_merge", "cannot merge a task into itself")
  }
  const source = await preflightResolveTask(sourceRef, ctx)
  if (source.kind === "refuse") return source.refusal
  const target = await preflightResolveTask(targetRef, ctx)
  if (target.kind === "refuse") return target.refusal
  if (source.kind === "resolved" && target.kind === "resolved" && source.taskId === target.taskId) {
    return projectsPreflightRefuse("invalid_merge", "cannot merge a task into itself")
  }
  return PROJECTS_PREFLIGHT_OK
}

// --- Checklist tools (spec S13) ------------------------------------------
// The bridge derives the actor kind from the dispatch origin and answers a
// service refusal as a typed `{ error: { code, message, status } }` envelope.

export async function checklistGet(
  params: Record<string, unknown> | undefined,
  ctx: ProjectsCtx,
): Promise<unknown> {
  return JSON.parse(await ctx.projects_checklistGet(JSON.stringify(params ?? {})))
}

export async function checklistAddItems(
  params: Record<string, unknown> | undefined,
  ctx: ProjectsCtx,
): Promise<unknown> {
  return JSON.parse(await ctx.projects_checklistAddItems(JSON.stringify(params ?? {})))
}

export async function checklistUpdateItem(
  params: Record<string, unknown> | undefined,
  ctx: ProjectsCtx,
): Promise<unknown> {
  return JSON.parse(await ctx.projects_checklistUpdateItem(JSON.stringify(params ?? {})))
}

export async function checklistSetValidation(
  params: Record<string, unknown> | undefined,
  ctx: ProjectsCtx,
): Promise<unknown> {
  return JSON.parse(await ctx.projects_checklistSetValidation(JSON.stringify(params ?? {})))
}

export async function checklistRemoveItem(
  params: Record<string, unknown> | undefined,
  ctx: ProjectsCtx,
): Promise<unknown> {
  return JSON.parse(await ctx.projects_checklistRemoveItem(JSON.stringify(params ?? {})))
}

export async function computeAttentionItems(
  params: Record<string, unknown> | undefined,
  ctx: ProjectsCtx,
): Promise<unknown> {
  // Home passes on the people the caller stands in for; the bridge checks them again.
  const forUserIds = Array.isArray(params?.forUserIds) ? params.forUserIds : []
  return JSON.parse(await ctx.projects_attentionItems(JSON.stringify({ forUserIds })))
}

// tasks_byAssignee — cross-project task list for one assignee (J1).
export async function tasksByAssignee(
  params: Record<string, unknown> | undefined,
  ctx: ProjectsCtx,
): Promise<unknown> {
  return JSON.parse(await ctx.projects_tasksByAssignee(JSON.stringify(params ?? {})))
}

// tasks_byProject — enumerate the tasks in ONE project (BL-151).
export async function tasksByProject(
  params: Record<string, unknown> | undefined,
  ctx: ProjectsCtx,
): Promise<unknown> {
  return JSON.parse(await ctx.projects_tasksByProject(JSON.stringify(params ?? {})))
}

// portfolio_rollup — bounded cross-project board rollup (BL-263): per active
// project, {done, remaining, overdue, %done, biggest-at-risk} in ONE call.
export async function portfolioRollup(
  params: Record<string, unknown> | undefined,
  ctx: ProjectsCtx,
): Promise<unknown> {
  return JSON.parse(await ctx.projects_portfolioRollup(JSON.stringify(params ?? {})))
}

// Deals: a pipeline's top-level tasks with their company, contact and amount.
export async function dealsPipelineCreate(
  params: Record<string, unknown> | undefined,
  ctx: ProjectsCtx,
): Promise<unknown> {
  return JSON.parse(await ctx.projects_dealsPipelineCreate(JSON.stringify(params ?? {})))
}

export async function dealsUpdate(
  params: Record<string, unknown> | undefined,
  ctx: ProjectsCtx,
): Promise<unknown> {
  return JSON.parse(await ctx.projects_dealsUpdate(JSON.stringify(params ?? {})))
}

export async function dealsSearch(
  params: Record<string, unknown> | undefined,
  ctx: ProjectsCtx,
): Promise<unknown> {
  return JSON.parse(await ctx.projects_dealsSearch(JSON.stringify(params ?? {})))
}

export async function dealsRollup(
  params: Record<string, unknown> | undefined,
  ctx: ProjectsCtx,
): Promise<unknown> {
  return JSON.parse(await ctx.projects_dealsRollup(JSON.stringify(params ?? {})))
}

export async function dealsFollowupCandidates(
  params: Record<string, unknown> | undefined,
  ctx: ProjectsCtx,
): Promise<unknown> {
  return JSON.parse(await ctx.projects_dealsFollowupCandidates(JSON.stringify(params ?? {})))
}

export async function dealSendState(
  params: Record<string, unknown> | undefined,
  ctx: ProjectsCtx,
): Promise<unknown> {
  return JSON.parse(await ctx.projects_dealSendState(JSON.stringify(params ?? {})))
}

// company_context — the agent's few lines about the company in view (a company
// tab or its discussion): its open deals by stage, amounts only under deal
// access (the deal read leaves them out otherwise).
const COMPANY_CONTEXT_KINDS = new Set(["kernel:company", "contacts:company-detail"])
const COMPANY_CONTEXT_STAGE_LINES = 4

interface CompanyContextDeal {
  task?: { key?: string; stage?: string | null }
  values?: { amountMinor?: number | null; currency?: string | null; amountPeriod?: string }
}

function formatMinor(minor: number): string {
  return minor % 100 === 0 ? String(minor / 100) : (minor / 100).toFixed(2)
}

export async function companyContext(
  params: Record<string, unknown> | undefined,
  ctx: ProjectsCtx,
): Promise<unknown> {
  const subject = (params?.subject ?? {}) as {
    app?: string
    entityType?: string
    entityId?: string
  }
  const companyId = String(subject.entityId ?? "")
  if (
    !COMPANY_CONTEXT_KINDS.has(`${subject.app}:${subject.entityType}`) ||
    !projectsPreflightIsUuid(companyId)
  ) {
    return { lines: [] }
  }
  const read = JSON.parse(
    await ctx.projects_dealsSearch(JSON.stringify({ companyId, outcome: "open", limit: 100 })),
  ) as { items?: CompanyContextDeal[] }
  const deals = Array.isArray(read?.items) ? read.items : []
  if (deals.length === 0) return { lines: [] }
  const withAmounts = deals.some((d) => d.values)
  const stages = new Map<string, CompanyContextDeal[]>()
  for (const d of deals) {
    const stage = d.task?.stage ?? "No stage"
    stages.set(stage, [...(stages.get(stage) ?? []), d])
  }
  const stageLine = (stage: string, list: CompanyContextDeal[]): string => {
    const keys = list.map((d) => d.task?.key).filter((k): k is string => !!k)
    const shown = keys.slice(0, 3).join(", ") + (keys.length > 3 ? ` +${keys.length - 3}` : "")
    const sums = new Map<string, number>()
    for (const d of list) {
      const v = d.values
      if (!v?.currency || typeof v.amountMinor !== "number") continue
      const unit = `${v.currency}${v.amountPeriod && v.amountPeriod !== "once" ? `/${v.amountPeriod}` : ""}`
      sums.set(unit, (sums.get(unit) ?? 0) + v.amountMinor)
    }
    const money = [...sums.entries()]
      .map(([unit, minor]) => {
        const [currency, period] = unit.split("/")
        return `${currency} ${formatMinor(minor)}${period ? `/${period}` : ""}`
      })
      .join(", ")
    return `${stage}: ${shown}${money ? `, ${money}` : ""}`
  }
  const ordered = [...stages.entries()].sort((a, b) => b[1].length - a[1].length)
  const lines = [
    `${deals.length} open deal${deals.length === 1 ? "" : "s"}${withAmounts ? "" : ", amounts need deal access"}.`,
    ...ordered.slice(0, COMPANY_CONTEXT_STAGE_LINES).map(([stage, list]) => stageLine(stage, list)),
  ]
  const rest = ordered.slice(COMPANY_CONTEXT_STAGE_LINES)
  if (rest.length > 0) {
    const n = rest.reduce((sum, [, list]) => sum + list.length, 0)
    lines.push(`${n} more in ${rest.length} other stage${rest.length === 1 ? "" : "s"}.`)
  }
  return { lines, source: { label: "Deals" } }
}

// company_work — the Work section of a company's page: the work projects whose
// client is the company and their open tasks. Deals are not work: the page's
// Deals section shows them, so pipelines and their deals stay out of this read.
interface CompanyWorkProject {
  id: string
  name: string
  key: string | null
  openTasks: number
  tasks: Array<{ id: string; key: string | null; title: string; status: string | null }>
}

export async function companyWork(
  params: Record<string, unknown> | undefined,
  ctx: ProjectsCtx,
): Promise<unknown> {
  const companyId = String(params?.companyId ?? "")
  if (!projectsPreflightIsUuid(companyId)) {
    return { projects: [], message: "companyId is not a company id. Nothing was read." }
  }
  const listed = JSON.parse(await ctx.projects_companyProjects(JSON.stringify({ companyId }))) as {
    items?: CompanyWorkProject[]
  }
  const projects = Array.isArray(listed?.items) ? listed.items : []
  const open = projects.reduce((sum, p) => sum + (p.openTasks ?? 0), 0)
  return {
    projects,
    message: `${projects.length} project${projects.length === 1 ? "" : "s"} with ${open} open task${open === 1 ? "" : "s"} for this company.`,
  }
}

// A dashboard table backed by a project's tasks (manifest entities.task.tableBacking).
export { taskTableBacking } from "~/apps/projects/service/table-backing"

// tasks_aggregate — tasks grouped by status / assignee / priority / due / age in status / SLA
// state / a field, counted or summed (a manager's dashboard chart).
export async function tasksAggregate(
  params: Record<string, unknown> | undefined,
  ctx: ProjectsCtx,
): Promise<unknown> {
  return JSON.parse(await ctx.projects_tasksAggregate(JSON.stringify(params ?? {})))
}

// comment / comments — the task's own discussion thread. There was no comment
// verb on a task at all, and its thread was unreachable: kernel threads are
// participant-gated, so the threadId in a task listing answered "not a
// participant". Both bridge methods resolve the task with viewerId, which
// enrols the caller exactly as opening the task in the web detail pane does.
export async function addComment(
  params: Record<string, unknown> | undefined,
  ctx: ProjectsCtx,
): Promise<unknown> {
  return JSON.parse(await ctx.projects_addComment(JSON.stringify(params ?? {})))
}

export async function listComments(
  params: Record<string, unknown> | undefined,
  ctx: ProjectsCtx,
): Promise<unknown> {
  return JSON.parse(await ctx.projects_listComments(JSON.stringify(params ?? {})))
}

// delete — gated soft-delete of a task + subtree (J1).
export async function deleteTask(
  params: Record<string, unknown> | undefined,
  ctx: ProjectsCtx,
): Promise<unknown> {
  return JSON.parse(await ctx.projects_deleteTask(JSON.stringify(params ?? {})))
}

// merge — gated merge of one task into another (J2).
export async function mergeTasks(
  params: Record<string, unknown> | undefined,
  ctx: ProjectsCtx,
): Promise<unknown> {
  return JSON.parse(await ctx.projects_mergeTasks(JSON.stringify(params ?? {})))
}

// instantiate_template — materialize a project from a template (J2).
export async function instantiateTemplate(
  params: Record<string, unknown> | undefined,
  ctx: ProjectsCtx,
): Promise<unknown> {
  return JSON.parse(await ctx.projects_instantiateTemplate(JSON.stringify(params ?? {})))
}

// add_dependency — add a (cycle-checked) task dependency (J2).
export async function addDependency(
  params: Record<string, unknown> | undefined,
  ctx: ProjectsCtx,
): Promise<unknown> {
  return JSON.parse(await ctx.projects_addDependency(JSON.stringify(params ?? {})))
}

// Per-app data export (Phase 13, E1/E3). Reads tasks under the caller's RLS
// via ctx.db_findMany, so the export never escalates.
export async function exportProjects(params: unknown, ctx: ProjectsCtx): Promise<unknown> {
  const p = (params ?? {}) as Record<string, unknown>
  const format = p.format ?? "json"
  const dateRange = p.dateRange as { from?: string; to?: string } | undefined
  const rows: Array<Record<string, unknown>> = []
  for (let offset = 0; ; offset += 1000) {
    const page: Array<Record<string, unknown>> = JSON.parse(
      await ctx.db_findMany(
        "tasks",
        JSON.stringify({ orderBy: { createdAt: "asc" }, limit: 1000, offset }),
      ),
    )
    rows.push(...page)
    if (page.length < 1000) break
  }
  const fromT = dateRange?.from ? Date.parse(dateRange.from) : Number.NEGATIVE_INFINITY
  const toT = dateRange?.to ? Date.parse(dateRange.to) : Number.POSITIVE_INFINITY
  const ranged =
    dateRange?.from || dateRange?.to
      ? rows.filter((r) => {
          const t = Date.parse(String(r.created_at ?? ""))
          return t >= fromT && t <= toT
        })
      : rows
  const projected = ranged.map((row) => {
    const out: Record<string, string> = {}
    for (const [outKey, dbKey] of PROJECTS_EXPORT_COLUMNS) {
      const v = row[dbKey]
      out[outKey] = v === null || v === undefined ? "" : String(v)
    }
    return out
  })
  if (format === "csv") {
    const header = PROJECTS_EXPORT_COLUMNS.map(([k]) => k).join(",")
    const body = projected
      .map((r) => PROJECTS_EXPORT_COLUMNS.map(([k]) => csvCell(r[k])).join(","))
      .join("\n")
    return body ? `${header}\n${body}\n` : `${header}\n`
  }
  return projected
}

// --- U4.12: CI→projects webhook (spec 3.4bis #3) ------------------------
//
// The first deployment to use this runs TeamCity as its CI system (no
// .gitlab-ci.yml in any of its repositories; the GitLab API confirms it: some
// projects' pipeline history shows entries with source:"external" (GitLab's
// field for a 3rd-party CI publishing status back), others show none at all
// for years). TeamCity has no native "send a signed JSON webhook" primitive,
// so the wire contract here is a small, provider-agnostic release-status
// envelope (mirroring monitoring's alert envelope) that ANY CI notifier can
// target — a TeamCity build-status notification script/plugin, or a relay
// off GitLab's own pipeline webhook, maps its payload onto these fields.
//
// Dedup identity: externalRef (e.g. "teamcity:<buildTypeId>:<buildNumber>"
// or a GitLab pipeline id). createTask does NOT dedup on externalRef
// automatically (same contract as tickets) — this handler pre-SELECTs via
// db_findMany before deciding create vs update.
const CI_STATUSES = ["pending", "running", "success", "failed", "canceled"] as const
type CiStatus = (typeof CI_STATUSES)[number]

interface CiStatusEnvelope {
  project: string
  externalRef: string
  status: CiStatus
  title?: string
  url?: string | null
  branch?: string | null
  ts: string | number
}

export function parseCiStatusEnvelope(payload: unknown): CiStatusEnvelope | { error: string } {
  if (!payload || typeof payload !== "object") return { error: "payload must be an object" }
  const p = payload as Record<string, unknown>
  if (typeof p.project !== "string" || p.project.length === 0) {
    return { error: "project: required non-empty string" }
  }
  if (typeof p.externalRef !== "string" || p.externalRef.length === 0) {
    return { error: "externalRef: required non-empty string" }
  }
  if (typeof p.status !== "string" || !CI_STATUSES.includes(p.status as CiStatus)) {
    return { error: `status: must be one of ${CI_STATUSES.join(", ")}` }
  }
  if (typeof p.ts !== "string" && typeof p.ts !== "number") {
    return { error: "ts: required (ISO-8601 string or epoch ms)" }
  }
  const tsMs = new Date(p.ts as string | number).getTime()
  if (Number.isNaN(tsMs)) return { error: "ts: not a parseable timestamp" }
  return {
    project: p.project,
    externalRef: p.externalRef,
    status: p.status as CiStatus,
    title: typeof p.title === "string" ? p.title : undefined,
    url: typeof p.url === "string" ? p.url : null,
    branch: typeof p.branch === "string" ? p.branch : null,
    ts: p.ts as string | number,
  }
}

export function ciTaskTitle(env: CiStatusEnvelope): string {
  const base = env.title ?? `${env.project} release`
  return `[CI] ${base} — ${env.status}`
}

export function ciTaskDescription(env: CiStatusEnvelope): string {
  const lines = [
    `CI release status for **${env.project}**`,
    `Status: ${env.status}`,
    env.branch ? `Branch: ${env.branch}` : null,
    env.url ? `Link: ${env.url}` : null,
    `Reported: ${new Date(env.ts).toISOString()}`,
    `Ref: ${env.externalRef}`,
  ].filter((l): l is string => l !== null)
  return lines.join("\n")
}

/**
 * `ci-status` webhook handler — a CI system (TeamCity notifier / GitLab
 * pipeline-hook relay) reports build/release status for one project. Creates
 * (or, on a later delivery for the same externalRef, updates) ONE task per
 * release/pipeline-run under a "Releases" project — never duplicated, so a
 * pending→running→success/failed sequence for the same build converges on a
 * single row instead of flooding the board.
 */
export async function ciStatusWebhookHandler(
  payload: unknown,
  ctx: ProjectsCtx,
): Promise<{ status: number; body?: string }> {
  const parsed = parseCiStatusEnvelope(payload)
  if ("error" in parsed) {
    return { status: 400, body: `invalid ci-status envelope: ${parsed.error}` }
  }
  const env = parsed

  try {
    // Ensure the "Releases" project exists (search-then-create, same
    // read-then-write idempotency shape the M2 provisioners use).
    const found = JSON.parse(await ctx.projects_search(JSON.stringify({ query: "Releases" })))
    const existingProject = Array.isArray(found?.items)
      ? found.items.find(
          (p: { type?: string; name?: string }) => p.type === "project" && p.name === "Releases",
        )
      : undefined
    let projectId: string
    if (existingProject) {
      projectId = existingProject.id
    } else {
      const created = JSON.parse(
        await ctx.projects_createProject(
          JSON.stringify({
            name: "Releases",
            description:
              "CI/CD release status, one task per release — reported by the CI system's ci-status webhook (U4.12).",
          }),
        ),
      )
      projectId = created.id
    }

    // Pre-SELECT by externalRef (createTask does not dedup on it).
    const existingRows = JSON.parse(
      await ctx.db_findMany(
        "tasks",
        JSON.stringify({ where: { externalRef: env.externalRef }, limit: 1 }),
      ),
    ) as Array<{ id: string }>
    const existingTask = existingRows[0]

    // The task writes answer a refusal as a typed `{ error }` envelope rather
    // than a throw; it is still a failed delivery, not an "ok".
    const throwOnRefusal = (raw: string): void => {
      const out = JSON.parse(raw) as { error?: { code?: string; message?: string } } | null
      if (out?.error) throw new Error(`${out.error.code}: ${out.error.message}`)
    }
    if (existingTask) {
      throwOnRefusal(
        await ctx.projects_updateTask(
          JSON.stringify({
            taskId: existingTask.id,
            title: ciTaskTitle(env),
            description: ciTaskDescription(env),
          }),
        ),
      )
      return { status: 200, body: "ok" }
    }

    throwOnRefusal(
      await ctx.projects_createTask(
        JSON.stringify({
          projectId,
          title: ciTaskTitle(env),
          description: ciTaskDescription(env),
          externalRef: env.externalRef,
        }),
      ),
    )
    return { status: 200, body: "ok" }
  } catch (err) {
    // Transient (DB blip etc.) — 503 so the kernel releases the replay claim
    // and the CI side's retry re-delivers (same contract as monitoring's alert webhook).
    return { status: 503, body: `ci-status processing failed: ${String(err)}` }
  }
}

const CI_SIGNATURE_HEADER = "x-projects-ci-signature"
const CI_WEBHOOK_SECRET_KEY = "ciWebhookSecret"
const CI_FRESHNESS_TTL_CONFIG_KEY = "ciWebhookTtlSeconds"
const CI_DEFAULT_FRESHNESS_TTL_SECONDS = 600

function extractSignedTsMs(body: string): number | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(body)
  } catch {
    return null
  }
  if (!parsed || typeof parsed !== "object") return null
  const ts = (parsed as Record<string, unknown>).ts
  if (typeof ts !== "string" && typeof ts !== "number") return null
  const ms = new Date(ts).getTime()
  return Number.isNaN(ms) ? null : ms
}

/**
 * HMAC-SHA256 verifier for the `ci-status` webhook — same construction as
 * monitoring's `monitoringWebhookVerifier` (kernel-minted secret, signed raw
 * body, replay window bound to the signed `ts`).
 */
export async function ciStatusWebhookVerifier(
  params: {
    headers: Record<string, string>
    body: string
    method: string
    query: Record<string, string>
  },
  bridge: CiWebhookVerifyBridge,
  nowMs: number = Date.now(),
): Promise<{ ok: boolean; replayKey?: string; replayTtlSeconds?: number; reason?: string }> {
  const headers: Record<string, string> = {}
  for (const [k, v] of Object.entries(params.headers)) headers[k.toLowerCase()] = v

  const secret = (await bridge.config_get(CI_WEBHOOK_SECRET_KEY)) as string | null
  if (!secret) return { ok: false, reason: "missing_secret" }

  const sig = headers[CI_SIGNATURE_HEADER]
  if (!sig || typeof sig !== "string") return { ok: false, reason: "missing_signature" }

  const expected = await bridge.crypto_hmacSha256Base64(secret, params.body)
  const valid = await bridge.crypto_timingSafeEqual(sig, expected)
  if (!valid) return { ok: false, reason: "signature_mismatch" }

  const tsMs = extractSignedTsMs(params.body)
  if (tsMs === null) return { ok: false, reason: "missing_ts" }
  const rawTtl = await bridge.config_get(CI_FRESHNESS_TTL_CONFIG_KEY)
  const n = typeof rawTtl === "string" ? Number(rawTtl) : rawTtl
  const ttlSeconds =
    typeof n === "number" && Number.isFinite(n) && n > 0 ? n : CI_DEFAULT_FRESHNESS_TTL_SECONDS
  const ttlMs = ttlSeconds * 1000
  if (nowMs - tsMs > ttlMs) return { ok: false, reason: "stale_ts" }
  if (tsMs - nowMs > ttlMs) return { ok: false, reason: "future_ts" }

  // The delivery-id header is unsigned; key replay on the signed body instead.
  const deliveryId = await bridge.crypto_hmacSha256Base64("projects-ci-delivery", params.body)
  return { ok: true, replayKey: deliveryId, replayTtlSeconds: 7 * 24 * 60 * 60 }
}

/** Operator setup read (admin-scoped, not agent-visible): reports whether the
 * ci-source connection minted its webhook secret, and returns it. */
export async function webhookInfoHandler(
  _params: Record<string, unknown> | undefined,
  ctx: ProjectsCtx,
): Promise<unknown> {
  const secret = (await ctx.config_get(CI_WEBHOOK_SECRET_KEY)) as string | null
  return {
    configured: Boolean(secret),
    secret: secret ?? null,
    signatureHeader: CI_SIGNATURE_HEADER,
    algorithm: "HMAC-SHA256, base64-encoded digest of the raw request body",
  }
}

/** Timeline rows for the kernel's activity read (activitySources), host-side. */
export async function activityRead(params: unknown, ctx: ProjectsCtx): Promise<unknown> {
  return JSON.parse(await ctx.projects_activityRead(JSON.stringify(params ?? {})))
}

// Time and budgets: Took, the plan, billing terms and period timeboxes.
export async function taskTimeSet(params: unknown, ctx: ProjectsCtx): Promise<unknown> {
  return JSON.parse(await ctx.projects_taskTimeSet(JSON.stringify(params ?? {})))
}

export async function taskTimeGet(params: unknown, ctx: ProjectsCtx): Promise<unknown> {
  return JSON.parse(await ctx.projects_taskTimeGet(JSON.stringify(params ?? {})))
}

export async function taskTimeCorrect(params: unknown, ctx: ProjectsCtx): Promise<unknown> {
  return JSON.parse(await ctx.projects_taskTimeCorrect(JSON.stringify(params ?? {})))
}

export async function timePlanSet(params: unknown, ctx: ProjectsCtx): Promise<unknown> {
  return JSON.parse(await ctx.projects_timePlanSet(JSON.stringify(params ?? {})))
}

export async function billingTermsSet(params: unknown, ctx: ProjectsCtx): Promise<unknown> {
  return JSON.parse(await ctx.projects_billingTermsSet(JSON.stringify(params ?? {})))
}

export async function periodTimeboxSet(params: unknown, ctx: ProjectsCtx): Promise<unknown> {
  return JSON.parse(await ctx.projects_periodTimeboxSet(JSON.stringify(params ?? {})))
}

export async function budgetGet(params: unknown, ctx: ProjectsCtx): Promise<unknown> {
  const out = JSON.parse(await ctx.projects_budgetGet(JSON.stringify(params ?? {}))) as {
    projectId?: string
    money?: { price: number; currency: string | null }
    totals?: Array<{ k: string; text: string }>
  }
  // The money half: a holder of the money scope also reads what is invoiced and what is left.
  if (out?.money && out.projectId) {
    const read = await readProjectInvoiced(ctx, out.projectId)
    const price = out.money.currency?.trim() || null
    if (read.ok && read.documents > 0 && !price) {
      // A price with no currency cannot be set against invoices that have one.
      ;(out.money as Record<string, unknown>).invoicedUnavailable = {
        code: "currency_missing",
        message:
          "This project's price has no currency, so what is invoiced and left to invoice are not shown.",
        next: "Set the price again with its currency in billing_terms_set.",
        retryable: false,
      }
    } else if (read.ok && read.documents > 0 && price && read.currency && price !== read.currency) {
      // The price and the invoices are in two currencies: no subtraction means anything.
      ;(out.money as Record<string, unknown>).invoicedUnavailable = mixedCurrencies(
        [price, read.currency],
        "This project's price and its invoices",
      ).error
    } else if (read.ok && read.documents === 0) {
      ;(out.money as Record<string, unknown>).invoicedUnavailable =
        "No issued invoice is linked to this project, so what is invoiced and left to invoice are not shown."
    } else if (read.ok) {
      const invoiced = read.invoicedMinor / 100
      const left = Math.round((out.money.price - invoiced) * 100) / 100
      out.money = { ...out.money, invoiced, leftToInvoice: left } as typeof out.money
      const fmt = (v: number) => formatMoney(v, out.money?.currency ?? read.currency)
      out.totals?.push(
        { k: "Invoiced", text: fmt(invoiced) },
        { k: "Left to invoice", text: fmt(left) },
      )
    } else {
      ;(out.money as Record<string, unknown>).invoicedUnavailable = read.refusal
        ? read.refusal
        : read.off
          ? "Invoicing is not on in this workspace, so what is invoiced is not shown."
          : "I cannot read invoices right now, so what is invoiced is not shown."
    }
  }
  return out
}

function formatMoney(amount: number, currency: string | null): string {
  try {
    return new Intl.NumberFormat("en-GB", {
      style: "currency",
      currency: currency ?? "EUR",
    }).format(amount)
  } catch {
    return `${amount} ${currency ?? ""}`.trim()
  }
}

/** Error codes that mean the invoicing app is not there to ask, rather than failing. */
const INVOICING_ABSENT = new Set([
  "tool_not_found",
  "unknown_tool",
  "app_disabled",
  "app_not_enabled",
  "not_found",
])

/**
 * A project's invoiced amount, from invoicing's internal `project_invoiced_get` through the
 * declared cross-app call. Any failure is reported as such, never as zero.
 */
async function readProjectInvoiced(
  ctx: ProjectsCtx,
  projectId: string,
  range?: { from: string; to: string },
): Promise<InvoicedRead> {
  let env: {
    status?: string
    result?: unknown
    data?: unknown
    error?: { code?: string } | string
    blocked?: unknown
  }
  try {
    env = JSON.parse(
      await ctx.executeTool(
        "invoicing:project_invoiced_get",
        JSON.stringify({ projectId, ...(range ? { from: range.from, to: range.to } : {}) }),
      ),
    )
  } catch {
    return { ok: false, off: false }
  }
  const body = (env.status === "completed" ? env.result : env.data) as
    | { invoicedExcl?: unknown; currency?: unknown; documents?: unknown[]; error?: unknown }
    | undefined
  if (body && typeof body.invoicedExcl === "number" && !body.error) {
    return {
      ok: true,
      invoicedMinor: body.invoicedExcl,
      currency: typeof body.currency === "string" ? body.currency : null,
      documents: Array.isArray(body.documents) ? body.documents.length : 0,
    }
  }
  const code = typeof env.error === "object" && env.error ? env.error.code : undefined
  // Invoicing refused for good (two currencies, too many documents): its own words, not
  // "cannot read", which says to retry.
  const own = body?.error as
    | { code?: unknown; message?: unknown; next?: unknown; retryable?: unknown }
    | undefined
  if (
    own &&
    own.retryable === false &&
    typeof own.code === "string" &&
    typeof own.message === "string"
  ) {
    return {
      ok: false,
      off: false,
      refusal: {
        code: own.code,
        message: own.message,
        ...(typeof own.next === "string" ? { next: own.next } : {}),
      },
    }
  }
  return { ok: false, off: typeof code === "string" && INVOICING_ABSENT.has(code) }
}

// Margin and cost rates: finance only, chat only, one figure per project.
export async function marginGet(params: unknown, ctx: ProjectsCtx): Promise<unknown> {
  const cost = JSON.parse(await ctx.projects_marginCost(JSON.stringify(params ?? {}))) as
    | MarginCost
    | { error: unknown }
  if ("error" in cost) return cost
  const read = await readProjectInvoiced(
    ctx,
    cost.projectId,
    cost.period ? { from: cost.period.from, to: cost.period.to } : undefined,
  )
  return composeMargin(cost, read)
}

export async function costRatesList(params: unknown, ctx: ProjectsCtx): Promise<unknown> {
  return JSON.parse(await ctx.projects_costRatesList(JSON.stringify(params ?? {})))
}

export async function costRateSet(params: unknown, ctx: ProjectsCtx): Promise<unknown> {
  return JSON.parse(await ctx.projects_costRateSet(JSON.stringify(params ?? {})))
}

// The dated sheet of one project and month, and its export.
export async function timesheetGet(params: unknown, ctx: ProjectsCtx): Promise<unknown> {
  return JSON.parse(await ctx.projects_timesheetGet(JSON.stringify(params ?? {})))
}

export async function timesheetExport(params: unknown, ctx: ProjectsCtx): Promise<unknown> {
  return JSON.parse(await ctx.projects_timesheetExport(JSON.stringify(params ?? {})))
}

// Capacity, company days off and time settings.
export async function capacityGet(params: unknown, ctx: ProjectsCtx): Promise<unknown> {
  return JSON.parse(await ctx.projects_capacityGet(JSON.stringify(params ?? {})))
}

export async function daysOffSet(params: unknown, ctx: ProjectsCtx): Promise<unknown> {
  return JSON.parse(await ctx.projects_daysOffSet(JSON.stringify(params ?? {})))
}

export async function daysOffList(params: unknown, ctx: ProjectsCtx): Promise<unknown> {
  return JSON.parse(await ctx.projects_daysOffList(JSON.stringify(params ?? {})))
}

export async function capacityMove(params: unknown, ctx: ProjectsCtx): Promise<unknown> {
  return JSON.parse(await ctx.projects_capacityMove(JSON.stringify(params ?? {})))
}

export async function daysOffRemove(params: unknown, ctx: ProjectsCtx): Promise<unknown> {
  return JSON.parse(await ctx.projects_daysOffRemove(JSON.stringify(params ?? {})))
}

export async function timeSettingsGet(params: unknown, ctx: ProjectsCtx): Promise<unknown> {
  return JSON.parse(await ctx.projects_timeSettingsGet(JSON.stringify(params ?? {})))
}

export async function timeSettingsSet(params: unknown, ctx: ProjectsCtx): Promise<unknown> {
  return JSON.parse(await ctx.projects_timeSettingsSet(JSON.stringify(params ?? {})))
}

// Reconcile: the period's facts, then the proposal the agent groups from its traces.
export async function reconcileFacts(params: unknown, ctx: ProjectsCtx): Promise<unknown> {
  return JSON.parse(await ctx.projects_reconcileFacts(JSON.stringify(params ?? {})))
}

export async function reconcilePropose(params: unknown, ctx: ProjectsCtx): Promise<unknown> {
  return JSON.parse(await ctx.projects_reconcilePropose(JSON.stringify(params ?? {})))
}

export async function reconcileLineUpdate(params: unknown, ctx: ProjectsCtx): Promise<unknown> {
  return JSON.parse(await ctx.projects_reconcileLineUpdate(JSON.stringify(params ?? {})))
}

export async function reconcileGet(params: unknown, ctx: ProjectsCtx): Promise<unknown> {
  return JSON.parse(await ctx.projects_reconcileGet(JSON.stringify(params ?? {})))
}

// Task field definitions and project templates: pass-throughs to their bridge methods.
export async function setFields(
  params: Record<string, unknown> | undefined,
  ctx: ProjectsCtx,
): Promise<unknown> {
  return JSON.parse(await ctx.projects_setFields(JSON.stringify(params ?? {})))
}

export async function saveTemplate(
  params: Record<string, unknown> | undefined,
  ctx: ProjectsCtx,
): Promise<unknown> {
  return JSON.parse(await ctx.projects_saveTemplate(JSON.stringify(params ?? {})))
}

export async function listTemplates(
  params: Record<string, unknown> | undefined,
  ctx: ProjectsCtx,
): Promise<unknown> {
  return JSON.parse(await ctx.projects_listTemplates(JSON.stringify(params ?? {})))
}

// The routine flow record readers (entities.task.routineFlow), server code the kernel calls in process.
export { routineFlowLeastLoaded, routineFlowReadRecords } from "./routine-flow-record"
