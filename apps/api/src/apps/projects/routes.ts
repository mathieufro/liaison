// SPDX-License-Identifier: FSL-1.1-ALv2
import { sql as drizzleSql } from "drizzle-orm"
import { Hono } from "hono"
import { createMiddleware } from "hono/factory"
import { z } from "zod"
import type { AppEnv } from "~/app"
import { projectsRel } from "~/apps/projects/schema-refs"
import {
  addItems,
  getChecklistStatus,
  listChecklist,
  removeItem,
  setValidationLevels,
  setValidations,
  updateItem,
} from "~/apps/projects/service/checklist"
import { CHECKLIST_ITEMS_PER_TASK_MAX, LEVELS_MAX } from "~/apps/projects/service/checklist-status"
import {
  createProject,
  listProjects,
  loadProjectDetail,
} from "~/apps/projects/service/create-project"
import { dealBoard } from "~/apps/projects/service/deals"
import { activeFields, readProjectFields, setFields } from "~/apps/projects/service/fields"
import { moveTask } from "~/apps/projects/service/move-task"
import {
  listRecentlyInvolvedTasks,
  normalizeInvolvedDays,
} from "~/apps/projects/service/recently-involved"
import { listReleases } from "~/apps/projects/service/release-filter"
import { resolveTaskRef, TASK_PRIORITIES } from "~/apps/projects/service/resolve"
import {
  addStatus,
  deleteStatus,
  migrateStatusTasks,
  reorderStatuses,
  updateStatus,
} from "~/apps/projects/service/statuses"
import {
  createTask,
  deleteTask,
  getTask,
  listTasks,
  restoreTask,
  updateTask,
} from "~/apps/projects/service/tasks"
import { awaitTimeFeatureSync, scheduleTimeBudgetsSync } from "~/apps/projects/service/time-feature"
import { getTimePlan } from "~/apps/projects/service/time-plan"
import { listTaskTransitions } from "~/apps/projects/service/transitions"
import { updateProject } from "~/apps/projects/service/update-project"
import { extractRows } from "~/db"
import { extractRlsContext, withRequestRls } from "~/lib/request-rls"
import { success } from "~/lib/response"
import { UUID_RE } from "~/lib/uuid"
import { zValidator } from "~/lib/validate"
import { requireScope } from "~/middleware/require-scope"

const scopeProjectsRead = requireScope("projects:projects:read")
const scopeProjectsWrite = requireScope("projects:projects:write")
const scopeTasksRead = requireScope("projects:tasks:read")
const scopeTasksWrite = requireScope("projects:tasks:write")

class ProjectsHttpError extends Error {
  status: number
  code: string
  details?: unknown
  constructor(status: number, code: string, message: string, details?: unknown) {
    super(message)
    this.status = status
    this.code = code
    if (details !== undefined) this.details = details
  }
}

const addStatusBodySchema = z.object({
  label: z.string().min(1),
  color: z.string().nullable().optional(),
  terminal: z.boolean().optional(),
  afterStatusId: z.string().uuid().optional(),
})

const updateStatusBodySchema = z.object({
  label: z.string().min(1).optional(),
  color: z.string().nullable().optional(),
  terminal: z.boolean().optional(),
})

const reorderStatusesBodySchema = z.object({
  orderedStatusIds: z.array(z.string().uuid()).max(1000),
})

const migrateStatusBodySchema = z.object({
  targetStatusId: z.string().uuid(),
})

// The project's full list of task fields (replace-all; the service checks each definition, and the
// values tasks hold, with the same errors as the fields_set tool).
const putFieldsBodySchema = z.object({
  fields: z.array(z.unknown()).max(200),
  renames: z.record(z.string(), z.record(z.string(), z.string())).nullable().optional(),
})

const createTaskBodySchema = z.object({
  statusId: z.string().uuid().optional(),
  parentTaskId: z.string().uuid().nullable().optional(),
  title: z.string().min(1),
  description: z.string().nullable().optional(),
  assigneeId: z.string().uuid().nullable().optional(),
  priority: z.enum(TASK_PRIORITIES).optional(),
  dueDate: z.string().nullable().optional(),
  startDate: z.string().nullable().optional(),
  blocked: z.boolean().optional(),
  // Trimmed and length-checked in the service (400 naming the field).
  release: z.string().nullable().optional(),
  beforeTaskId: z.string().uuid().nullable().optional(),
  afterTaskId: z.string().uuid().nullable().optional(),
  // Own label values: group name/id to value name/id, null clears.
  // Resolved in the service (label_not_found / label_archived list the valid values).
  labels: z.record(z.string(), z.string().nullable()).optional(),
  // Values of the project's task fields; checked in the service (422 naming the field).
  fields: z.record(z.string(), z.unknown()).nullable().optional(),
})

const updateTaskBodySchema = z.object({
  title: z.string().min(1).optional(),
  description: z.string().nullable().optional(),
  statusId: z.string().uuid().optional(),
  assigneeId: z.string().uuid().nullable().optional(),
  priority: z.enum(TASK_PRIORITIES).optional(),
  dueDate: z.string().nullable().optional(),
  startDate: z.string().nullable().optional(),
  blocked: z.boolean().optional(),
  release: z.string().nullable().optional(),
  labels: z.record(z.string(), z.string().nullable()).optional(),
  // Field values to set; null empties one, keys left out are untouched.
  fields: z.record(z.string(), z.unknown()).nullable().optional(),
})

/**
 * The list route's `labels` query param: a JSON object of label group
 * (name or id) to value (name or id, or "__none__"). Anything else is a 400;
 * an unknown group or value is the service's 404 `label_not_found`.
 */
function parseLabelsQuery(raw: string | undefined): Record<string, string> | undefined {
  if (raw === undefined || raw === "") return undefined
  const refuse = () =>
    new ProjectsHttpError(400, "invalid_params", "labels must be a JSON object of group to value")
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    throw refuse()
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) throw refuse()
  for (const v of Object.values(parsed)) if (typeof v !== "string") throw refuse()
  return parsed as Record<string, string>
}

const listTasksQuerySchema = z.object({
  statusId: z.string().uuid().optional(),
  assigneeId: z.string().uuid().optional(),
  due: z.enum(["overdue", "due_soon", "later", "none", "this_week"]).optional(),
  priority: z.enum(TASK_PRIORITIES).optional(),
  parentTaskId: z.union([z.string().uuid(), z.literal("root")]).optional(),
  view: z.enum(["flat", "tree"]).optional(),
  // The bin. `only` lists deleted tasks (the trash view); default excludes them.
  archived: z.enum(["only", "include", "exclude"]).optional(),
  // Effective release (own, else nearest ancestor), case-insensitive;
  // "__none__" selects tasks with no effective release.
  release: z.string().optional(),
})

const moveTaskBodySchema = z.object({
  parentTaskId: z.string().uuid().nullable().optional(),
  statusId: z.string().uuid().optional(),
  beforeTaskId: z.string().uuid().nullable().optional(),
  afterTaskId: z.string().uuid().nullable().optional(),
})

// Checklist bodies: shapes only; the per-task limits and the fail-note rule are
// the service's, so REST and the agent tools refuse with the same codes.
const addChecklistItemsBodySchema = z.object({
  items: z
    .array(
      z.object({
        title: z.string(),
        details: z.string().nullable().optional(),
      }),
    )
    // The per-add limit is the service's (its own error code); this cap only
    // bounds what a body can make zod walk.
    .max(CHECKLIST_ITEMS_PER_TASK_MAX),
})

const updateChecklistItemBodySchema = z.object({
  title: z.string().optional(),
  details: z.string().nullable().optional(),
  checked: z.boolean().optional(),
  beforeItemId: z.string().uuid().nullable().optional(),
  afterItemId: z.string().uuid().nullable().optional(),
})

const validationEntrySchema = z.object({
  itemId: z.string().uuid(),
  level: z.string().optional(),
  state: z.enum(["not_done", "fail", "success", "na"]).optional(),
  checked: z.boolean().optional(),
  note: z.string().nullable().optional(),
  source: z.string().nullable().optional(),
})

const setValidationsBodySchema = z.union([
  z.object({
    validations: z.array(validationEntrySchema).max(CHECKLIST_ITEMS_PER_TASK_MAX * LEVELS_MAX),
  }),
  validationEntrySchema,
])

const validationLevelsBodySchema = z.object({
  levels: z
    .array(
      z.object({
        id: z.string().nullable().optional(),
        // Unknown keys (a legacy `agentAccess`) are stripped.
        name: z.string(),
      }),
    )
    // LEVELS_MAX is enforced by the service with its own error code.
    .max(100),
})

const createProjectSchema = z.object({
  name: z.string().min(1, "name required"),
  description: z.string().optional(),
  icon: z.string().optional(),
  color: z.string().optional(),
  // Optional explicit project key (e.g. "ERB"); auto-derived from the name when
  // omitted. Format re-validated (and uppercased) in create-project.ts.
  key: z.string().min(1).optional(),
  // Optional sidebar group heading (trimmed, max 60, code invalid_group).
  group: z.string().nullable().optional(),
  // Optional initial columns in board order; omitted = the five defaults.
  // Semantics (dedupe, terminal fallback) live in create-project.ts.
  statuses: z
    .array(
      z.object({
        label: z.string().min(1),
        color: z.string().nullable().optional(),
        terminal: z.boolean().optional(),
      }),
    )
    .max(20)
    .optional(),
  // Show the checklist summary on Kanban cards; default true.
  checklistOnCards: z.boolean().optional(),
  // Time and budgets on the new project; off by default.
  timeBudgets: z.boolean().optional(),
})

const patchProjectSchema = z.object({
  name: z.string().min(1).optional(),
  description: z.string().nullable().optional(),
  icon: z.string().nullable().optional(),
  color: z.string().nullable().optional(),
  key: z.string().min(1).optional(),
  // Sidebar group heading: trimmed, "" or null clears it, at most 60 chars
  // (checked in update-project.ts, code invalid_group).
  group: z.string().nullable().optional(),
  checklistOnCards: z.boolean().optional(),
  // The project's client: a company the caller can read, or null to clear.
  companyId: z.string().uuid().nullable().optional(),
  // Time and budgets on this project (work projects only); the org's tools follow.
  timeBudgets: z.boolean().optional(),
})

// Every `:projectId` / `:taskId` / `:statusId` below is interpolated with a
// `::uuid` cast. A non-UUID value (e.g. GET /api/projects/tasks — a stale tab
// URL falling through to the `/:projectId` pattern) must 404 like an unknown
// row, not surface as a Postgres cast error 500.
// `:taskId` also accepts a display key like "ERB-12" (resolved via
// resolveTaskRef in the handler) — everything else still needs a real uuid.
const TASK_KEY_RE = /^[A-Za-z][A-Za-z0-9]{1,9}-\d+$/

// Literal top-level GET routes registered before `/:projectId` (the middleware
// still sees them as a `projectId` param).
const LITERAL_GET_ROUTES = new Set(["releases", "involved"])

/** Resolve a task id or key and 404 unless it is a live task of `projectId`. */
async function checklistTaskId(
  tx: Parameters<typeof getTask>[0]["tx"],
  orgId: string,
  projectId: string,
  rawTaskId: string,
): Promise<string> {
  const taskId = await resolveTaskRef(tx, orgId, rawTaskId)
  await getTask({ tx, orgId, projectId, taskId })
  return taskId
}

const requireUuidParams = createMiddleware<AppEnv>(async (c, next) => {
  const params = c.req.param() as Record<string, string>
  for (const [name, value] of Object.entries(params)) {
    if (name.endsWith("Id") && !UUID_RE.test(value)) {
      if (
        name === "projectId" &&
        LITERAL_GET_ROUTES.has(value) &&
        c.req.method === "GET" &&
        c.req.path.replace(/\/$/, "").endsWith(`/projects/${value}`)
      ) {
        continue
      }
      if (name === "taskId" && TASK_KEY_RE.test(value)) continue
      throw new ProjectsHttpError(404, "not_found", `${name} is not a valid id`)
    }
  }
  await next()
})

export const projectsRoutes = new Hono<AppEnv>()
  .use("/:projectId", requireUuidParams)
  .use("/:projectId/*", requireUuidParams)
  .get("/", scopeProjectsRead, async (c) => {
    const orgId = c.get("orgId")
    const archivedRaw = c.req.query("archived")
    const archived =
      archivedRaw === "only" || archivedRaw === "include" || archivedRaw === "exclude"
        ? archivedRaw
        : "exclude"
    const q = c.req.query("q") ?? undefined
    const cursor = c.req.query("cursor") ?? undefined
    const limitRaw = c.req.query("limit")
    const limit = limitRaw ? Math.max(1, Math.min(100, Number.parseInt(limitRaw, 10) || 25)) : 25
    try {
      const result = await withRequestRls(c, (tx) =>
        listProjects({ tx, orgId, archived, q, cursor, limit }),
      )
      return success(c, result)
    } catch (err) {
      if ((err as Error).message === "invalid_cursor") {
        throw new ProjectsHttpError(400, "invalid_cursor", "cursor is invalid")
      }
      throw err
    }
  })
  // Release suggestions and filter menu: distinct own release values in the
  // org with the count of tasks whose effective release equals each.
  .get("/releases", scopeTasksRead, async (c) => {
    const orgId = c.get("orgId")
    const result = await withRequestRls(c, (tx) => listReleases({ tx, orgId }))
    return success(c, result)
  })
  // "Recently involved": the caller's tasks they commented on, were mentioned
  // in, changed, created or were assigned in the last `days` days (default
  // 14, max 90), newest involvement first, under the caller's RLS.
  .get("/involved", scopeTasksRead, async (c) => {
    const orgId = c.get("orgId")
    const userId = c.get("userId")
    const projectId = c.req.query("projectId") || undefined
    if (projectId !== undefined && !UUID_RE.test(projectId)) {
      throw new ProjectsHttpError(400, "invalid_params", "projectId must be a uuid")
    }
    const limitRaw = c.req.query("limit")
    const result = await withRequestRls(c, (tx) =>
      listRecentlyInvolvedTasks({
        tx,
        orgId,
        userId,
        days: normalizeInvolvedDays(c.req.query("days")),
        projectId,
        query: c.req.query("q") || undefined,
        release: c.req.query("release") || undefined,
        labels: parseLabelsQuery(c.req.query("labels")),
        limit: limitRaw ? Number.parseInt(limitRaw, 10) || undefined : undefined,
      }),
    )
    return success(c, result)
  })
  .post("/", scopeProjectsWrite, zValidator("json", createProjectSchema), async (c) => {
    const { timeBudgets, ...input } = c.req.valid("json")
    const orgId = c.get("orgId")
    const userId = c.get("userId")
    try {
      const actor = {
        actorType: "user",
        userId,
        orgId,
        scopes: c.get("scopes"),
        dimensionGrants: c.get("dimensionGrants"),
      } as never
      const result = await withRequestRls(c, async (tx) => {
        const created = await createProject({ tx, orgId, actor, input })
        if (timeBudgets === undefined) return created
        return updateProject({ tx, orgId, projectId: created.id, actor, patch: { timeBudgets } })
      })
      if (timeBudgets !== undefined) await awaitTimeFeatureSync(orgId)
      return success(c, result)
    } catch (err) {
      const message = String((err as Error)?.message ?? err)
      if (message.startsWith("invalid_project_key:")) {
        throw new ProjectsHttpError(400, "invalid_project_key", message)
      }
      if (message.startsWith("invalid_group:")) {
        throw new ProjectsHttpError(400, "invalid_group", message)
      }
      if (message.startsWith("invalid_statuses:")) {
        throw new ProjectsHttpError(400, "invalid_statuses", message)
      }
      if (message.startsWith("project_key_taken:")) {
        throw new ProjectsHttpError(409, "project_key_taken", message)
      }
      throw err
    }
  })
  .get("/:projectId", scopeProjectsRead, async (c) => {
    const projectId = c.req.param("projectId")
    const orgId = c.get("orgId")
    try {
      const result = await withRequestRls(c, (tx) => loadProjectDetail(tx, orgId, projectId))
      return success(c, result)
    } catch (err) {
      if ((err as Error).message === "project_not_found") {
        throw new ProjectsHttpError(404, "not_found", "project not found")
      }
      throw err
    }
  })
  // The project's time and budgets plan, read back for its edit form. The money keys only reach
  // a holder of the money scope; a project that does not use it answers planning_off.
  .get("/:projectId/time-plan", scopeProjectsRead, async (c) => {
    const projectId = c.req.param("projectId")
    const orgId = c.get("orgId")
    const scopes = [...(c.get("scopes") ?? [])]
    const result = await withRequestRls(c, (tx) => getTimePlan({ tx, orgId, scopes, projectId }))
    return success(c, result)
  })
  // A pipeline's board: stages with their deals, each stage's sum per currency
  // for a reader with deal access, and quiet for a reader who can read mail.
  .get("/:projectId/deals/board", scopeProjectsRead, async (c) => {
    const projectId = c.req.param("projectId")
    const orgId = c.get("orgId")
    const scopes = [...(c.get("scopes") ?? [])]
    const result = await withRequestRls(c, (tx) => dealBoard(tx, orgId, scopes, projectId))
    return success(c, result)
  })
  .patch("/:projectId", scopeProjectsWrite, zValidator("json", patchProjectSchema), async (c) => {
    const projectId = c.req.param("projectId")
    const orgId = c.get("orgId")
    const patch = c.req.valid("json")
    const actor = extractRlsContext(c)
    const result = await withRequestRls(c, (tx) =>
      updateProject({ tx, orgId, projectId, actor, patch }),
    )
    // The org's tools follow the projects once this commit is read (time-feature.ts).
    if (patch.timeBudgets !== undefined) await awaitTimeFeatureSync(orgId)
    return success(c, result)
  })
  .post("/:projectId/archive", scopeProjectsWrite, async (c) => {
    const projectId = c.req.param("projectId")
    const orgId = c.get("orgId")
    const result = await withRequestRls(c, async (tx) => {
      const rows = extractRows<{ id: string }>(
        await tx.execute(drizzleSql`
          SELECT id FROM ${projectsRel("projects")}
          WHERE id = ${projectId}::uuid AND org_id = ${orgId}::uuid
          LIMIT 1
        `),
      )
      if (rows.length === 0) {
        throw new ProjectsHttpError(404, "not_found", "project not found")
      }
      await tx.execute(drizzleSql`
        UPDATE ${projectsRel("projects")}
        SET archived_at = now(), updated_at = now()
        WHERE id = ${projectId}::uuid AND org_id = ${orgId}::uuid
      `)
      await tx.queueEvent({
        app: "projects",
        entity: "project",
        action: "archived",
        entityId: projectId,
        data: { id: projectId },
        actorId: c.get("userId"),
        actorType: "user",
        orgId,
      })
      // An archived project no longer counts for the org's time tools (time-feature.ts).
      scheduleTimeBudgetsSync(orgId, c.get("userId"))
      return loadProjectDetail(tx, orgId, projectId)
    })
    await awaitTimeFeatureSync(orgId)
    return success(c, result)
  })
  .post("/:projectId/restore", scopeProjectsWrite, async (c) => {
    const projectId = c.req.param("projectId")
    const orgId = c.get("orgId")
    const result = await withRequestRls(c, async (tx) => {
      const rows = extractRows<{ id: string }>(
        await tx.execute(drizzleSql`
          SELECT id FROM ${projectsRel("projects")}
          WHERE id = ${projectId}::uuid AND org_id = ${orgId}::uuid
          LIMIT 1
        `),
      )
      if (rows.length === 0) {
        throw new ProjectsHttpError(404, "not_found", "project not found")
      }
      await tx.execute(drizzleSql`
        UPDATE ${projectsRel("projects")}
        SET archived_at = NULL, updated_at = now()
        WHERE id = ${projectId}::uuid AND org_id = ${orgId}::uuid
      `)
      await tx.queueEvent({
        app: "projects",
        entity: "project",
        action: "restored",
        entityId: projectId,
        data: { id: projectId },
        actorId: c.get("userId"),
        actorType: "user",
        orgId,
      })
      // An archived project no longer counts for the org's time tools (time-feature.ts).
      scheduleTimeBudgetsSync(orgId, c.get("userId"))
      return loadProjectDetail(tx, orgId, projectId)
    })
    await awaitTimeFeatureSync(orgId)
    return success(c, result)
  })
  .post(
    "/:projectId/statuses",
    scopeProjectsWrite,
    zValidator("json", addStatusBodySchema),
    async (c) => {
      const projectId = c.req.param("projectId")
      const orgId = c.get("orgId")
      const input = c.req.valid("json")
      const actor = extractRlsContext(c)
      const result = await withRequestRls(c, (tx) =>
        addStatus({ tx, orgId, projectId, actor, input }),
      )
      return success(c, result)
    },
  )
  .patch(
    "/:projectId/statuses/:statusId",
    scopeProjectsWrite,
    zValidator("json", updateStatusBodySchema),
    async (c) => {
      const projectId = c.req.param("projectId")
      const statusId = c.req.param("statusId")
      const orgId = c.get("orgId")
      const patch = c.req.valid("json")
      const actor = extractRlsContext(c)
      const result = await withRequestRls(c, (tx) =>
        updateStatus({ tx, orgId, projectId, statusId, actor, patch }),
      )
      return success(c, result)
    },
  )
  .post(
    "/:projectId/statuses/reorder",
    scopeProjectsWrite,
    zValidator("json", reorderStatusesBodySchema),
    async (c) => {
      const projectId = c.req.param("projectId")
      const orgId = c.get("orgId")
      const { orderedStatusIds } = c.req.valid("json")
      const actor = extractRlsContext(c)
      const result = await withRequestRls(c, (tx) =>
        reorderStatuses({ tx, orgId, projectId, actor, orderedStatusIds }),
      )
      return success(c, result)
    },
  )
  .post(
    "/:projectId/statuses/:statusId/migrate",
    scopeProjectsWrite,
    zValidator("json", migrateStatusBodySchema),
    async (c) => {
      const projectId = c.req.param("projectId")
      const sourceStatusId = c.req.param("statusId")
      const orgId = c.get("orgId")
      const { targetStatusId } = c.req.valid("json")
      const actor = extractRlsContext(c)
      const result = await withRequestRls(c, (tx) =>
        migrateStatusTasks({ tx, orgId, projectId, sourceStatusId, targetStatusId, actor }),
      )
      return success(c, { movedCount: result.movedCount })
    },
  )
  .get("/:projectId/fields", scopeProjectsRead, async (c) => {
    const projectId = c.req.param("projectId")
    const orgId = c.get("orgId")
    const fields = await withRequestRls(c, async (tx) =>
      activeFields(await readProjectFields(tx, orgId, projectId)),
    )
    return success(c, { projectId, fields })
  })
  .put(
    "/:projectId/fields",
    scopeProjectsWrite,
    zValidator("json", putFieldsBodySchema),
    async (c) => {
      const projectId = c.req.param("projectId")
      const orgId = c.get("orgId")
      const { fields, renames } = c.req.valid("json")
      const actor = extractRlsContext(c)
      const result = await withRequestRls(c, (tx) =>
        setFields({ tx, orgId, actor, projectId, fields, renames: renames ?? null }),
      )
      return success(c, { projectId, fields: result })
    },
  )
  .delete("/:projectId/statuses/:statusId", scopeProjectsWrite, async (c) => {
    const projectId = c.req.param("projectId")
    const statusId = c.req.param("statusId")
    const orgId = c.get("orgId")
    const actor = extractRlsContext(c)
    const result = await withRequestRls(c, (tx) =>
      deleteStatus({ tx, orgId, projectId, statusId, actor }),
    )
    return success(c, result)
  })
  .get("/:projectId/tasks", scopeTasksRead, async (c) => {
    const projectId = c.req.param("projectId")
    const orgId = c.get("orgId")
    const filters = listTasksQuerySchema.safeParse({
      statusId: c.req.query("statusId"),
      assigneeId: c.req.query("assigneeId"),
      due: c.req.query("due"),
      priority: c.req.query("priority"),
      parentTaskId: c.req.query("parentTaskId"),
      view: c.req.query("view"),
      archived: c.req.query("archived"),
      release: c.req.query("release"),
    })
    if (!filters.success) {
      throw new ProjectsHttpError(
        400,
        "invalid_query",
        "invalid query params",
        filters.error.flatten(),
      )
    }
    const labels = parseLabelsQuery(c.req.query("labels"))
    const result = await withRequestRls(c, (tx) =>
      listTasks({
        tx,
        orgId,
        projectId,
        filters: labels ? { ...filters.data, labels } : filters.data,
      }),
    )
    return success(c, result)
  })
  .post(
    "/:projectId/tasks",
    scopeTasksWrite,
    zValidator("json", createTaskBodySchema),
    async (c) => {
      const projectId = c.req.param("projectId")
      const orgId = c.get("orgId")
      const input = c.req.valid("json")
      const actor = extractRlsContext(c)
      const result = await withRequestRls(c, (tx) =>
        createTask({
          tx,
          orgId,
          actor,
          // A person's create: the project's required fields apply.
          input: { projectId, ...input, requireFields: true },
        }),
      )
      return success(c, result)
    },
  )
  .get("/:projectId/tasks/:taskId", scopeTasksRead, async (c) => {
    const projectId = c.req.param("projectId")
    const rawTaskId = c.req.param("taskId")
    const orgId = c.get("orgId")
    const viewerId = c.get("userId")
    const result = await withRequestRls(c, async (tx) => {
      const taskId = await resolveTaskRef(tx, orgId, rawTaskId)
      const task = await getTask({ tx, orgId, projectId, taskId, viewerId })
      const checklist = await getChecklistStatus({ tx, orgId, taskId })
      const transitions = await listTaskTransitions(tx, orgId, taskId)
      return { ...task, checklist, transitions }
    })
    return success(c, result)
  })
  .patch(
    "/:projectId/tasks/:taskId",
    scopeTasksWrite,
    zValidator("json", updateTaskBodySchema),
    async (c) => {
      const projectId = c.req.param("projectId")
      const rawTaskId = c.req.param("taskId")
      const orgId = c.get("orgId")
      const input = c.req.valid("json")
      const actor = extractRlsContext(c)
      const result = await withRequestRls(c, async (tx) => {
        const taskId = await resolveTaskRef(tx, orgId, rawTaskId)
        return updateTask({ tx, orgId, actor, projectId, taskId, input })
      })
      return success(c, result)
    },
  )
  // Soft-delete a task and its subtree. The service has existed since the
  // gated agent `delete` tool shipped, but it was reachable ONLY through the
  // sandbox bridge, so the web UI had no way to delete a task at all. The
  // agent's tool stays gated (an autonomous delete wants a human); a person
  // clicking delete in their own UI is that human, exactly as the status
  // delete route and DeleteStatusDialog already work.
  .delete("/:projectId/tasks/:taskId", scopeTasksWrite, async (c) => {
    const projectId = c.req.param("projectId")
    const rawTaskId = c.req.param("taskId")
    const orgId = c.get("orgId")
    const actor = extractRlsContext(c)
    await withRequestRls(c, async (tx) => {
      const taskId = await resolveTaskRef(tx, orgId, rawTaskId)
      // Scope the delete to the project in the path: a task id from another
      // project must not be deletable through this project's URL.
      // includeArchived: the row may already be in the bin, and deleting twice
      // must stay idempotent rather than becoming a 404.
      await getTask({ tx, orgId, projectId, taskId, includeArchived: true })
      await deleteTask({ tx, orgId, actor, taskId })
    })
    return success(c, { deleted: true })
  })
  // Take a task back out of the bin. Without this a soft delete is a one-way
  // door in every surface, which is the whole difference between a bin and a
  // permanent delete.
  .post("/:projectId/tasks/:taskId/restore", scopeTasksWrite, async (c) => {
    const projectId = c.req.param("projectId")
    const rawTaskId = c.req.param("taskId")
    const orgId = c.get("orgId")
    const actor = extractRlsContext(c)
    const result = await withRequestRls(c, async (tx) => {
      const taskId = await resolveTaskRef(tx, orgId, rawTaskId)
      // includeArchived: the task being restored is binned by definition, so
      // the boundary check has to be able to see it.
      await getTask({ tx, orgId, projectId, taskId, includeArchived: true })
      await restoreTask({ tx, orgId, actor, taskId })
      // Read back WITHOUT the flag: it is live again, and if it somehow is not
      // this must not report a success it did not achieve.
      return getTask({ tx, orgId, projectId, taskId })
    })
    return success(c, result)
  })
  .post(
    "/:projectId/tasks/:taskId/move",
    scopeTasksWrite,
    zValidator("json", moveTaskBodySchema),
    async (c) => {
      const projectId = c.req.param("projectId")
      const rawTaskId = c.req.param("taskId")
      const orgId = c.get("orgId")
      const body = c.req.valid("json")
      const actor = extractRlsContext(c)
      const result = await withRequestRls(c, async (tx) => {
        const taskId = await resolveTaskRef(tx, orgId, rawTaskId)
        await moveTask({
          tx,
          orgId,
          actor,
          projectId,
          taskId,
          parentTaskId: body.parentTaskId,
          statusId: body.statusId,
          beforeTaskId: body.beforeTaskId,
          afterTaskId: body.afterTaskId,
        })
        return getTask({ tx, orgId, projectId, taskId })
      })
      return success(c, result)
    },
  )
  // Checklist. Every REST caller is a person: actor kind "human".
  .get("/:projectId/tasks/:taskId/checklist", scopeTasksRead, async (c) => {
    const projectId = c.req.param("projectId")
    const rawTaskId = c.req.param("taskId")
    const orgId = c.get("orgId")
    const result = await withRequestRls(c, async (tx) => {
      const taskId = await checklistTaskId(tx, orgId, projectId, rawTaskId)
      return listChecklist({ tx, orgId, taskId })
    })
    return success(c, result)
  })
  .post(
    "/:projectId/tasks/:taskId/checklist",
    scopeTasksWrite,
    zValidator("json", addChecklistItemsBodySchema),
    async (c) => {
      const projectId = c.req.param("projectId")
      const rawTaskId = c.req.param("taskId")
      const orgId = c.get("orgId")
      const userId = c.get("userId")
      const { items } = c.req.valid("json")
      const result = await withRequestRls(c, async (tx) => {
        const taskId = await checklistTaskId(tx, orgId, projectId, rawTaskId)
        const created = await addItems({ tx, orgId, userId, actorKind: "human", taskId, items })
        return { items: created }
      })
      return success(c, result)
    },
  )
  .post(
    "/:projectId/tasks/:taskId/checklist/validations",
    scopeTasksWrite,
    zValidator("json", setValidationsBodySchema),
    async (c) => {
      const projectId = c.req.param("projectId")
      const rawTaskId = c.req.param("taskId")
      const orgId = c.get("orgId")
      const userId = c.get("userId")
      const body = c.req.valid("json")
      const entries = "validations" in body ? body.validations : [body]
      const result = await withRequestRls(c, async (tx) => {
        const taskId = await checklistTaskId(tx, orgId, projectId, rawTaskId)
        const items = await setValidations({
          tx,
          orgId,
          userId,
          actorKind: "human",
          taskId,
          entries,
          // A person's own note, like a message typed in the thread UI.
          commentRequiredScopes: [],
        })
        return { items }
      })
      return success(c, result)
    },
  )
  .patch(
    "/:projectId/tasks/:taskId/checklist/:itemId",
    scopeTasksWrite,
    zValidator("json", updateChecklistItemBodySchema),
    async (c) => {
      const projectId = c.req.param("projectId")
      const rawTaskId = c.req.param("taskId")
      const itemId = c.req.param("itemId")
      const orgId = c.get("orgId")
      const userId = c.get("userId")
      const patch = c.req.valid("json")
      const result = await withRequestRls(c, async (tx) => {
        const taskId = await checklistTaskId(tx, orgId, projectId, rawTaskId)
        return updateItem({ tx, orgId, userId, actorKind: "human", taskId, itemId, patch })
      })
      return success(c, result)
    },
  )
  .delete("/:projectId/tasks/:taskId/checklist/:itemId", scopeTasksWrite, async (c) => {
    const projectId = c.req.param("projectId")
    const rawTaskId = c.req.param("taskId")
    const itemId = c.req.param("itemId")
    const orgId = c.get("orgId")
    const userId = c.get("userId")
    const result = await withRequestRls(c, async (tx) => {
      const taskId = await checklistTaskId(tx, orgId, projectId, rawTaskId)
      return removeItem({ tx, orgId, userId, actorKind: "human", taskId, itemId })
    })
    return success(c, { deleted: true, ...result })
  })
  .put(
    "/:projectId/validation-levels",
    scopeProjectsWrite,
    zValidator("json", validationLevelsBodySchema),
    async (c) => {
      const projectId = c.req.param("projectId")
      const orgId = c.get("orgId")
      const userId = c.get("userId")
      const { levels } = c.req.valid("json")
      const result = await withRequestRls(c, async (tx) => {
        const saved = await setValidationLevels({ tx, orgId, userId, projectId, levels })
        return { levels: saved }
      })
      return success(c, result)
    },
  )
