// SPDX-License-Identifier: FSL-1.1-ALv2
// Projects sandbox handlers — each handler dispatches to a Node-side bridge
// method exposed via projects_*. Real services land in T17–T22.
// biome-ignore-all lint/correctness/noUnusedVariables: handlers resolved by manifest export name

// Type-only import forces TypeScript to treat this file as a module (so its
// top-level function names don't collide with another app's handlers in the
// shared global type scope). Bun's transpiler strips the import at bundle
// time, so the QuickJS runtime still sees pure script-mode source where the
// function declarations auto-promote to global as expected.
import type {} from "node:buffer"

interface ProjectsSandboxCtx {
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
  projects_deleteTask: (paramsJson: string) => Promise<string>
  projects_addComment: (paramsJson: string) => Promise<string>
  projects_listComments: (paramsJson: string) => Promise<string>
  projects_mergeTasks: (paramsJson: string) => Promise<string>
  projects_instantiateTemplate: (paramsJson: string) => Promise<string>
  projects_addDependency: (paramsJson: string) => Promise<string>
  projects_attentionItems: (paramsJson: string) => Promise<string>
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
  actor?: unknown
}

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

async function search(
  params: Record<string, unknown> | undefined,
  ctx: ProjectsSandboxCtx,
): Promise<unknown> {
  return JSON.parse(await ctx.projects_search(JSON.stringify(params ?? {})))
}

async function get(
  params: Record<string, unknown> | undefined,
  ctx: ProjectsSandboxCtx,
): Promise<unknown> {
  return JSON.parse(await ctx.projects_get(JSON.stringify(params ?? {})))
}

/** Who a pending approval about a task is for: the task's assignee. */
async function approvalRouteRead(
  params: Record<string, unknown> | undefined,
  ctx: ProjectsSandboxCtx,
): Promise<unknown> {
  if (params?.entityType !== "task" || typeof params.entityId !== "string")
    return { personId: null }
  const data = JSON.parse(await ctx.projects_get(JSON.stringify({ taskId: params.entityId })))
  const assignee = data?.task?.assigneeId ?? data?.assigneeId
  return { personId: typeof assignee === "string" ? assignee : null }
}

// task label taxonomy: pass-throughs to the projects_labels* bridge methods.
async function labelsList(
  params: Record<string, unknown> | undefined,
  ctx: ProjectsSandboxCtx,
): Promise<unknown> {
  return JSON.parse(await ctx.projects_labelsList(JSON.stringify(params ?? {})))
}

async function labelsTree(
  params: Record<string, unknown> | undefined,
  ctx: ProjectsSandboxCtx,
): Promise<unknown> {
  return JSON.parse(await ctx.projects_labelsTree(JSON.stringify(params ?? {})))
}

async function labelsCreate(
  params: Record<string, unknown> | undefined,
  ctx: ProjectsSandboxCtx,
): Promise<unknown> {
  return JSON.parse(await ctx.projects_labelsCreate(JSON.stringify(params ?? {})))
}

async function labelsUpdate(
  params: Record<string, unknown> | undefined,
  ctx: ProjectsSandboxCtx,
): Promise<unknown> {
  return JSON.parse(await ctx.projects_labelsUpdate(JSON.stringify(params ?? {})))
}

async function labelsArchive(
  params: Record<string, unknown> | undefined,
  ctx: ProjectsSandboxCtx,
): Promise<unknown> {
  return JSON.parse(await ctx.projects_labelsArchive(JSON.stringify(params ?? {})))
}

async function labelsReorder(
  params: Record<string, unknown> | undefined,
  ctx: ProjectsSandboxCtx,
): Promise<unknown> {
  return JSON.parse(await ctx.projects_labelsReorder(JSON.stringify(params ?? {})))
}

async function createProject(
  params: Record<string, unknown> | undefined,
  ctx: ProjectsSandboxCtx,
): Promise<unknown> {
  return JSON.parse(await ctx.projects_createProject(JSON.stringify(params ?? {})))
}

async function createTask(
  params: Record<string, unknown> | undefined,
  ctx: ProjectsSandboxCtx,
): Promise<unknown> {
  return JSON.parse(await ctx.projects_createTask(JSON.stringify(params ?? {})))
}

async function updateTask(
  params: Record<string, unknown> | undefined,
  ctx: ProjectsSandboxCtx,
): Promise<unknown> {
  return JSON.parse(await ctx.projects_updateTask(JSON.stringify(params ?? {})))
}

async function moveTask(
  params: Record<string, unknown> | undefined,
  ctx: ProjectsSandboxCtx,
): Promise<unknown> {
  return JSON.parse(await ctx.projects_moveTask(JSON.stringify(params ?? {})))
}

async function addStatus(
  params: Record<string, unknown> | undefined,
  ctx: ProjectsSandboxCtx,
): Promise<unknown> {
  return JSON.parse(await ctx.projects_addStatus(JSON.stringify(params ?? {})))
}

async function updateProject(
  params: Record<string, unknown> | undefined,
  ctx: ProjectsSandboxCtx,
): Promise<unknown> {
  return JSON.parse(await ctx.projects_updateProject(JSON.stringify(params ?? {})))
}

async function updateStatus(
  params: Record<string, unknown> | undefined,
  ctx: ProjectsSandboxCtx,
): Promise<unknown> {
  return JSON.parse(await ctx.projects_updateStatus(JSON.stringify(params ?? {})))
}

async function deleteStatus(
  params: Record<string, unknown> | undefined,
  ctx: ProjectsSandboxCtx,
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
// The checks are mirrored here rather than shared with the host resolvers
// (service/resolve.ts, service/statuses.ts, service/tasks.ts) because this
// bundle is evaluated in the sandbox and can only reach the host through the
// read methods of the projects bridge. The mirrors are deliberately narrow
// and one copy each, reused by every tool below.

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
  ctx: ProjectsSandboxCtx,
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
  ctx: ProjectsSandboxCtx,
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
  ctx: ProjectsSandboxCtx,
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
async function deleteStatusPreflight(
  params: Record<string, unknown> | undefined,
  ctx: ProjectsSandboxCtx,
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
async function checklistRemoveItemPreflight(
  params: Record<string, unknown> | undefined,
  ctx: ProjectsSandboxCtx,
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
async function deleteTaskPreflight(
  params: Record<string, unknown> | undefined,
  ctx: ProjectsSandboxCtx,
): Promise<ProjectsPreflightResult> {
  const p = params ?? {}
  const task = await preflightResolveTask(projectsPreflightString(p.taskId), ctx)
  if (task.kind === "refuse") return task.refusal
  return PROJECTS_PREFLIGHT_OK
}

/** `merge`: both sides must exist, and a task cannot be merged into itself
 *  (the same task reached by id and by display key is still itself). */
async function mergeTasksPreflight(
  params: Record<string, unknown> | undefined,
  ctx: ProjectsSandboxCtx,
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

async function checklistGet(
  params: Record<string, unknown> | undefined,
  ctx: ProjectsSandboxCtx,
): Promise<unknown> {
  return JSON.parse(await ctx.projects_checklistGet(JSON.stringify(params ?? {})))
}

async function checklistAddItems(
  params: Record<string, unknown> | undefined,
  ctx: ProjectsSandboxCtx,
): Promise<unknown> {
  return JSON.parse(await ctx.projects_checklistAddItems(JSON.stringify(params ?? {})))
}

async function checklistUpdateItem(
  params: Record<string, unknown> | undefined,
  ctx: ProjectsSandboxCtx,
): Promise<unknown> {
  return JSON.parse(await ctx.projects_checklistUpdateItem(JSON.stringify(params ?? {})))
}

async function checklistSetValidation(
  params: Record<string, unknown> | undefined,
  ctx: ProjectsSandboxCtx,
): Promise<unknown> {
  return JSON.parse(await ctx.projects_checklistSetValidation(JSON.stringify(params ?? {})))
}

async function checklistRemoveItem(
  params: Record<string, unknown> | undefined,
  ctx: ProjectsSandboxCtx,
): Promise<unknown> {
  return JSON.parse(await ctx.projects_checklistRemoveItem(JSON.stringify(params ?? {})))
}

async function computeAttentionItems(
  params: Record<string, unknown> | undefined,
  ctx: ProjectsSandboxCtx,
): Promise<unknown> {
  // Home passes on the people the caller stands in for; the bridge checks them again.
  const forUserIds = Array.isArray(params?.forUserIds) ? params.forUserIds : []
  return JSON.parse(
    await ctx.projects_attentionItems(JSON.stringify({ actor: ctx.actor ?? null, forUserIds })),
  )
}

// tasks_byAssignee — cross-project task list for one assignee (J1).
async function tasksByAssignee(
  params: Record<string, unknown> | undefined,
  ctx: ProjectsSandboxCtx,
): Promise<unknown> {
  return JSON.parse(await ctx.projects_tasksByAssignee(JSON.stringify(params ?? {})))
}

// tasks_byProject — enumerate the tasks in ONE project (BL-151).
async function tasksByProject(
  params: Record<string, unknown> | undefined,
  ctx: ProjectsSandboxCtx,
): Promise<unknown> {
  return JSON.parse(await ctx.projects_tasksByProject(JSON.stringify(params ?? {})))
}

// portfolio_rollup — bounded cross-project board rollup (BL-263): per active
// project, {done, remaining, overdue, %done, biggest-at-risk} in ONE call.
async function portfolioRollup(
  params: Record<string, unknown> | undefined,
  ctx: ProjectsSandboxCtx,
): Promise<unknown> {
  return JSON.parse(await ctx.projects_portfolioRollup(JSON.stringify(params ?? {})))
}

// comment / comments — the task's own discussion thread. There was no comment
// verb on a task at all, and its thread was unreachable: kernel threads are
// participant-gated, so the threadId in a task listing answered "not a
// participant". Both bridge methods resolve the task with viewerId, which
// enrols the caller exactly as opening the task in the web detail pane does.
async function addComment(
  params: Record<string, unknown> | undefined,
  ctx: ProjectsSandboxCtx,
): Promise<unknown> {
  return JSON.parse(await ctx.projects_addComment(JSON.stringify(params ?? {})))
}

async function listComments(
  params: Record<string, unknown> | undefined,
  ctx: ProjectsSandboxCtx,
): Promise<unknown> {
  return JSON.parse(await ctx.projects_listComments(JSON.stringify(params ?? {})))
}

// delete — gated soft-delete of a task + subtree (J1).
async function deleteTask(
  params: Record<string, unknown> | undefined,
  ctx: ProjectsSandboxCtx,
): Promise<unknown> {
  return JSON.parse(await ctx.projects_deleteTask(JSON.stringify(params ?? {})))
}

// merge — gated merge of one task into another (J2).
async function mergeTasks(
  params: Record<string, unknown> | undefined,
  ctx: ProjectsSandboxCtx,
): Promise<unknown> {
  return JSON.parse(await ctx.projects_mergeTasks(JSON.stringify(params ?? {})))
}

// instantiate_template — materialize a project from a template (J2).
async function instantiateTemplate(
  params: Record<string, unknown> | undefined,
  ctx: ProjectsSandboxCtx,
): Promise<unknown> {
  return JSON.parse(await ctx.projects_instantiateTemplate(JSON.stringify(params ?? {})))
}

// add_dependency — add a (cycle-checked) task dependency (J2).
async function addDependency(
  params: Record<string, unknown> | undefined,
  ctx: ProjectsSandboxCtx,
): Promise<unknown> {
  return JSON.parse(await ctx.projects_addDependency(JSON.stringify(params ?? {})))
}

// Per-app data export (Phase 13, E1/E3). Reads tasks under the caller's RLS
// via ctx.db_findMany, so the export never escalates.
function projectsCsvCell(value: unknown): string {
  let s = value === null || value === undefined ? "" : String(value)
  // Spreadsheet formula injection: a leading = + - @ tab or CR makes the cell a formula, so prefix a
  // single quote (plain numbers like "-5000" stay numeric). Verbatim copy of @liaison/shared csvCell.
  if (/^[=+\-@\t\r]/.test(s) && !/^-?\d+(\.\d+)?$/.test(s)) s = `'${s}`
  if (s.includes('"') || s.includes(",") || s.includes("\n") || s.includes("\r")) {
    return `"${s.replace(/"/g, '""')}"`
  }
  return s
}

async function exportProjects(params: unknown, ctx: ProjectsSandboxCtx): Promise<unknown> {
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
      .map((r) => PROJECTS_EXPORT_COLUMNS.map(([k]) => projectsCsvCell(r[k])).join(","))
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

function parseCiStatusEnvelope(payload: unknown): CiStatusEnvelope | { error: string } {
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

/** Terminal statuses stop being "in flight" — used to pick the target project_status label. */
function statusLabel(status: CiStatus): string {
  if (status === "success") return "done"
  if (status === "failed") return "cancelled" // no "failed" default status; cancelled is the closest terminal-non-done label
  if (status === "canceled") return "cancelled"
  if (status === "running") return "in_progress"
  return "todo"
}

function ciTaskTitle(env: CiStatusEnvelope): string {
  const base = env.title ?? `${env.project} release`
  return `[CI] ${base} — ${env.status}`
}

function ciTaskDescription(env: CiStatusEnvelope): string {
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
async function ciStatusWebhookHandler(
  payload: unknown,
  ctx: ProjectsSandboxCtx,
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
async function ciStatusWebhookVerifier(
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
async function webhookInfoHandler(
  _params: Record<string, unknown> | undefined,
  ctx: ProjectsSandboxCtx,
): Promise<unknown> {
  const secret = (await ctx.config_get(CI_WEBHOOK_SECRET_KEY)) as string | null
  return {
    configured: Boolean(secret),
    secret: secret ?? null,
    signatureHeader: CI_SIGNATURE_HEADER,
    algorithm: "HMAC-SHA256, base64-encoded digest of the raw request body",
  }
}

// Handlers are resolved by name at sandbox runtime (no module exports needed).
// QuickJS evaluates the bundle in script mode, so top-level `export {…}` is
// rejected by the parser and breaks the whole bundle. Named function
// declarations at top level auto-promote to the global scope, so the manifest
// resolver can find them without explicit `globalThis.X = …` binding.
void [
  search,
  get,
  approvalRouteRead,
  createProject,
  createTask,
  updateTask,
  moveTask,
  tasksByAssignee,
  tasksByProject,
  portfolioRollup,
  deleteTask,
  addComment,
  listComments,
  mergeTasks,
  instantiateTemplate,
  addDependency,
  ciStatusWebhookHandler,
  ciStatusWebhookVerifier,
  webhookInfoHandler,
  computeAttentionItems,
  exportProjects,
  deleteStatusPreflight,
  deleteTaskPreflight,
  mergeTasksPreflight,
  checklistGet,
  checklistAddItems,
  checklistUpdateItem,
  checklistSetValidation,
  checklistRemoveItem,
  checklistRemoveItemPreflight,
]
