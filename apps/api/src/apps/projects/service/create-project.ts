// SPDX-License-Identifier: FSL-1.1-ALv2
import { randomUUID } from "node:crypto"
import { sql as drizzleSql } from "drizzle-orm"
import { z } from "zod"
import { kernelRel, projectsRel } from "~/apps/projects/schema-refs"
import { extractRows, type RlsClient } from "~/db"
import type { UserContext } from "~/db/rls"
import { describeDbError } from "~/lib/transient-db-error"
import { type Column, columnsSchema } from "~/modules/dashboards/tables/columns"
import { parseStoredLevels, type ValidationLevel } from "./checklist-status"
import { PIPELINE_CLOSING_STAGES, PIPELINE_OPEN_STAGES } from "./deals"
import { activeFields, parseStoredFields } from "./fields"
import { orgUsesTimeBudgets } from "./planning"
import { ProjectsServiceError } from "./statuses"
import {
  deriveProjectKey,
  formatTaskKey,
  nextKeyCollisionCandidate,
  parseTaskKey,
} from "./task-key"
import { attachTaskLabels, type TaskLabel } from "./task-labels"

/** True iff `err`'s postgres cause chain is a unique-violation (23505) on the
 *  given constraint (matched by name in the deepest cause's message, since
 *  postgres.js does not expose `constraint_name` as a top-level field on the
 *  wrapper — see describeDbError). */
function isUniqueViolationOnConstraint(err: unknown, constraintName: string): boolean {
  const { code, message } = describeDbError(err)
  return code === "23505" && !!message?.includes(constraintName)
}

export interface ProjectStatusRow {
  id: string
  projectId: string
  label: string
  color: string | null
  order: number
  terminal: boolean
}

export interface ProjectRow {
  id: string
  orgId: string
  name: string
  description: string | null
  color: string | null
  icon: string | null
  /** Short uppercase Jira-style key, e.g. "ERB" (see task-key.ts). */
  key: string
  /** Sidebar group heading (trimmed free text); null = ungrouped. */
  group: string | null
  ownerId: string
  archivedAt: string | null
  createdAt: string
  updatedAt: string
}

export interface ProjectDetail extends ProjectRow {
  /** Present on a pipeline only, so a work project reads as it always did. */
  kind?: "pipeline"
  /** The project's client company, present only when one is set. */
  companyId?: string
  /** Time and budgets on this project: present only while the org uses it (or the call set it). */
  timeBudgets?: boolean
  /** When and by whom it was last turned, present with `timeBudgets` once it was ever turned. */
  timeBudgetsChangedAt?: string
  timeBudgetsChangedBy?: { id: string; name: string }
  statuses: ProjectStatusRow[]
  /** S2 levels in order; [] is plain mode (a checkbox per item). */
  validationLevels: ValidationLevel[]
  /** D16: show the checklist summary (per-level counters) on Kanban cards. */
  checklistOnCards: boolean
  /** The project's active task field definitions, in order (fields.ts). */
  fields: Column[]
  taskCount: number
  /** The key no longer changes: the project holds a task (live or in the
   *  trash), and every task key and link is built on it (update-project.ts). */
  keyLocked: boolean
  owner: {
    id: string
    name: string
    avatarUrl: string | null
  }
}

// [label, order, terminal, color]. Colors are hex strings (same format as
// user-picked status/project colors); without them every default status
// renders the grey UI fallback. Keep the label->color mapping in sync with
// migration 0025_project_status_default_colors.sql (backfill of pre-color rows).
export const DEFAULT_STATUS_SEEDS: ReadonlyArray<readonly [string, number, boolean, string]> = [
  ["backlog", 0, false, "#6b7280"],
  ["todo", 1, false, "#3b82f6"],
  ["in_progress", 2, false, "#f59e0b"],
  ["done", 3, true, "#22c55e"],
  ["cancelled", 4, true, "#ef4444"],
]

interface DbRowProject {
  id: string
  org_id: string
  name: string
  description: string | null
  color: string | null
  icon: string | null
  key: string
  group: string | null
  owner_id: string
  archived_at: Date | string | null
  created_at: Date | string
  updated_at: Date | string
}

interface DbRowStatus {
  id: string
  project_id: string
  label: string
  color: string | null
  order: number
  terminal: boolean
}

function toIso(value: Date | string | null): string | null {
  if (value === null) return null
  if (value instanceof Date) return value.toISOString()
  return value
}

function toIsoNonNull(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : value
}

function projectFromRow(r: DbRowProject): ProjectRow {
  return {
    id: r.id,
    orgId: r.org_id,
    name: r.name,
    description: r.description,
    color: r.color,
    icon: r.icon,
    key: r.key,
    group: r.group ?? null,
    ownerId: r.owner_id,
    archivedAt: toIso(r.archived_at),
    createdAt: toIsoNonNull(r.created_at),
    updatedAt: toIsoNonNull(r.updated_at),
  }
}

function statusFromRow(r: DbRowStatus): ProjectStatusRow {
  return {
    id: r.id,
    projectId: r.project_id,
    label: r.label,
    color: r.color,
    order: r.order,
    terminal: r.terminal,
  }
}

export interface OwnerRef {
  id: string
  name: string
  avatarUrl: string | null
}

export interface ProjectSummary extends ProjectRow {
  taskCount: number
  owner: OwnerRef
}

export interface ListProjectsArgs {
  tx: RlsClient
  orgId: string
  archived?: "include" | "only" | "exclude"
  q?: string
  cursor?: string
  limit?: number
  /** Also compute `total`: a server count of ALL projects matching the filter
   *  (archived + q), independent of the page/cursor. Off by default so existing
   *  UI callers pay no extra query. */
  includeTotal?: boolean
}

export interface ListProjectsResult {
  items: ProjectSummary[]
  nextCursor: string | null
  /** Present only when `includeTotal` was requested. */
  total?: number
}

interface CursorState {
  updatedAt: string
  id: string
}

function decodeCursor(cursor: string): CursorState | null {
  try {
    const json = Buffer.from(cursor, "base64url").toString("utf8")
    const parsed = JSON.parse(json) as Partial<CursorState>
    if (typeof parsed.updatedAt === "string" && typeof parsed.id === "string") {
      return { updatedAt: parsed.updatedAt, id: parsed.id }
    }
  } catch {
    /* fall through */
  }
  return null
}

function encodeCursor(state: CursorState): string {
  return Buffer.from(JSON.stringify(state), "utf8").toString("base64url")
}

export async function listProjects(args: ListProjectsArgs): Promise<ListProjectsResult> {
  const archived = args.archived ?? "exclude"
  const archivedClause =
    archived === "only"
      ? drizzleSql`AND p.archived_at IS NOT NULL`
      : archived === "include"
        ? drizzleSql``
        : drizzleSql`AND p.archived_at IS NULL`

  const q = (args.q ?? "").trim()
  const searchClause = q ? drizzleSql`AND p.name ILIKE ${`%${q}%`}` : drizzleSql``

  const limit = Math.max(1, Math.min(args.limit ?? 25, 100))
  let cursorClause = drizzleSql``
  if (args.cursor) {
    const decoded = decodeCursor(args.cursor)
    if (!decoded) throw new Error("invalid_cursor")
    cursorClause = drizzleSql`
      AND (p.updated_at, p.id) < (${decoded.updatedAt}::timestamptz, ${decoded.id}::uuid)
    `
  }

  const rows = extractRows<
    DbRowProject & {
      task_count: number | string
      owner_name: string | null
      owner_avatar_url: string | null
    }
  >(
    await args.tx.execute(drizzleSql`
      SELECT p.id, p.org_id, p.name, p.description, p.color, p.icon, p.key, p."group", p.owner_id, p.archived_at,
             p.created_at, p.updated_at,
             COALESCE((SELECT COUNT(*) FROM ${projectsRel("tasks")} t WHERE t.project_id = p.id AND t.archived_at IS NULL), 0) AS task_count,
             u.name AS owner_name,
             u.avatar_url AS owner_avatar_url
      FROM ${projectsRel("projects")} p
      LEFT JOIN ${kernelRel("users")} u ON u.id = p.owner_id AND u.org_id = p.org_id
      WHERE p.org_id = ${args.orgId}::uuid ${archivedClause} ${searchClause} ${cursorClause}
      ORDER BY p.updated_at DESC, p.id DESC
      LIMIT ${limit + 1}
    `),
  )

  const sliced = rows.slice(0, limit)
  const items = sliced.map((r) => ({
    ...projectFromRow(r),
    taskCount: typeof r.task_count === "string" ? Number(r.task_count) : r.task_count,
    owner: {
      id: r.owner_id,
      name: r.owner_name ?? "",
      avatarUrl: r.owner_avatar_url ?? null,
    },
  }))
  const nextCursor =
    rows.length > limit && sliced.length > 0
      ? encodeCursor({
          updatedAt: toIsoNonNull(sliced[sliced.length - 1]!.updated_at),
          id: sliced[sliced.length - 1]!.id,
        })
      : null

  // Sweep substrate: a server COUNT over the SAME archived+q filter (NOT the
  // cursor), so a routine reads a measured total independent of paging.
  let total: number | undefined
  if (args.includeTotal) {
    const countRows = extractRows<{ total: number }>(
      await args.tx.execute(drizzleSql`
        SELECT COUNT(*)::int AS total FROM ${projectsRel("projects")} p
        WHERE p.org_id = ${args.orgId}::uuid ${archivedClause} ${searchClause}
      `),
    )
    total = countRows[0]?.total ?? 0
  }
  return { items, nextCursor, ...(total !== undefined ? { total } : {}) }
}

export interface TaskSearchHit {
  type: "task"
  id: string
  title: string
  projectId: string
  projectName: string
  statusId: string | null
  statusLabel: string | null
  statusTerminal: boolean | null
  /** Display key, e.g. "ERB-12". */
  key: string | null
  /** Per-project sequential task number (pairs with the project's `key` to form `key` above). */
  number: number
  /** Effective labels (own or inherited) of the task. */
  labels: TaskLabel[]
  /** Present (true) only on a deleted task, which a search returns only when asked to. */
  archived?: true
}

type TaskSearchDbRow = {
  id: string
  title: string
  project_id: string
  project_name: string
  status_id: string | null
  status_label: string | null
  status_terminal: boolean | null
  project_key: string
  number: number
  archived: boolean
}

function taskSearchHitFromRow(r: TaskSearchDbRow): TaskSearchHit {
  return {
    type: "task",
    id: r.id,
    title: r.title,
    projectId: r.project_id,
    projectName: r.project_name,
    statusId: r.status_id,
    statusLabel: r.status_label,
    statusTerminal: r.status_terminal,
    key: formatTaskKey(r.project_key, r.number),
    number: r.number,
    labels: [],
    ...(r.archived ? { archived: true as const } : {}),
  }
}

/**
 * Match TASKS by title OR display key (RLS-scoped via `tx`) for the projects:search tool — the tool
 * description promises "project/task titles" but listProjects matches project names only, so a task
 * was unfindable by name (BL-108). Returns the task id + its project + current status so the agent
 * can then move it (e.g. to the terminal/Done status).
 *
 * A query that parses as an exact task key (e.g. "ERB-12") is resolved directly and returned FIRST
 * (deduped against the title/key-prefix matches below), so a key lookup never gets buried under
 * unrelated title matches.
 */
export async function searchTasksByTitle(
  tx: RlsClient,
  orgId: string,
  q: string,
  limit: number,
  /** Deleted (archived) tasks: left out by default, like archived projects. */
  archived: "include" | "only" | "exclude" = "exclude",
): Promise<TaskSearchHit[]> {
  const cappedLimit = Math.max(1, Math.min(limit, 100))
  const baseColumns = drizzleSql`
    t.id, t.title, t.project_id, p.name AS project_name,
    t.status_id, ps.label AS status_label, ps.terminal AS status_terminal,
    p.key AS project_key, t.number, (t.archived_at IS NOT NULL) AS archived
  `
  const archivedFilter =
    archived === "include"
      ? drizzleSql``
      : archived === "only"
        ? drizzleSql` AND t.archived_at IS NOT NULL`
        : drizzleSql` AND t.archived_at IS NULL`

  const hits: TaskSearchHit[] = []
  const seen = new Set<string>()

  const parsedKey = parseTaskKey(q)
  if (parsedKey) {
    const exactRows = extractRows<TaskSearchDbRow>(
      await tx.execute(drizzleSql`
        SELECT ${baseColumns}
        FROM ${projectsRel("tasks")} t
        JOIN ${projectsRel("projects")} p ON p.id = t.project_id AND p.org_id = t.org_id
        LEFT JOIN ${projectsRel("project_statuses")} ps ON ps.id = t.status_id AND ps.org_id = t.org_id
        WHERE t.org_id = ${orgId}::uuid AND p.key = ${parsedKey.key} AND t.number = ${parsedKey.number}${archivedFilter}
        LIMIT 1
      `),
    )
    for (const r of exactRows) {
      hits.push(taskSearchHitFromRow(r))
      seen.add(r.id)
    }
  }

  const rows = extractRows<TaskSearchDbRow>(
    await tx.execute(drizzleSql`
      SELECT ${baseColumns}
      FROM ${projectsRel("tasks")} t
      JOIN ${projectsRel("projects")} p ON p.id = t.project_id AND p.org_id = t.org_id
      LEFT JOIN ${projectsRel("project_statuses")} ps ON ps.id = t.status_id AND ps.org_id = t.org_id
      WHERE t.org_id = ${orgId}::uuid
        AND (t.title ILIKE ${`%${q}%`} OR (p.key || '-' || t.number::text) ILIKE ${`${q}%`})${archivedFilter}
      ORDER BY t.updated_at DESC, t.id DESC
      LIMIT ${cappedLimit}
    `),
  )
  for (const r of rows) {
    if (seen.has(r.id)) continue
    hits.push(taskSearchHitFromRow(r))
    seen.add(r.id)
  }
  return attachTaskLabels(tx, orgId, hits.slice(0, cappedLimit))
}

/**
 * Loads a single project plus its ordered statuses. Throws when the project is
 * not visible (RLS filtered) or not present in the org.
 */
export async function loadProjectDetail(
  tx: RlsClient,
  orgId: string,
  projectId: string,
  opts: { withTimeBudgets?: boolean } = {},
): Promise<ProjectDetail> {
  const projectRows = extractRows<
    DbRowProject & {
      task_count: number | string
      has_tasks: boolean
      validation_levels: unknown
      task_fields: unknown
      checklist_on_cards: boolean | null
      owner_name: string | null
      owner_avatar_url: string | null
      kind: "work" | "pipeline"
      company_id: string | null
      time_budgets_on: boolean
      time_budgets_changed_at: Date | string | null
      time_budgets_changed_by: string | null
      changer_name: string | null
    }
  >(
    await tx.execute(drizzleSql`
      SELECT p.id, p.org_id, p.name, p.description, p.color, p.icon, p.key, p."group", p.owner_id,
             p.archived_at, p.created_at, p.updated_at, p.validation_levels,
             p.checklist_on_cards, p.kind, p.company_id::text AS company_id,
             p.time_budgets_on, p.time_budgets_changed_at, p.time_budgets_changed_by::text AS time_budgets_changed_by,
             cu.name AS changer_name, p.task_fields,
             COALESCE((SELECT COUNT(*) FROM ${projectsRel("tasks")} t WHERE t.project_id = p.id AND t.archived_at IS NULL), 0) AS task_count,
             EXISTS (SELECT 1 FROM ${projectsRel("tasks")} t2 WHERE t2.project_id = p.id) AS has_tasks,
             u.name AS owner_name,
             u.avatar_url AS owner_avatar_url
      FROM ${projectsRel("projects")} p
      LEFT JOIN ${kernelRel("users")} u ON u.id = p.owner_id AND u.org_id = p.org_id
      LEFT JOIN ${kernelRel("users")} cu ON cu.id = p.time_budgets_changed_by AND cu.org_id = p.org_id
      WHERE p.id = ${projectId}::uuid AND p.org_id = ${orgId}::uuid
      LIMIT 1
    `),
  )
  if (projectRows.length === 0) {
    throw new Error("project_not_found")
  }
  const statusRows = extractRows<DbRowStatus>(
    await tx.execute(drizzleSql`
      SELECT id, project_id, label, color, "order", terminal
      FROM ${projectsRel("project_statuses")}
      WHERE project_id = ${projectId}::uuid AND org_id = ${orgId}::uuid
      ORDER BY "order" ASC
    `),
  )
  const r = projectRows[0]!
  return {
    ...projectFromRow(r),
    ...(r.kind === "pipeline" ? { kind: "pipeline" as const } : {}),
    ...(r.company_id ? { companyId: r.company_id } : {}),
    ...(opts.withTimeBudgets || orgUsesTimeBudgets(orgId) ? timeBudgetsKeys(r) : {}),
    taskCount: typeof r.task_count === "string" ? Number(r.task_count) : r.task_count,
    keyLocked: r.has_tasks === true,
    owner: {
      id: r.owner_id,
      name: r.owner_name ?? "",
      avatarUrl: r.owner_avatar_url ?? null,
    },
    statuses: statusRows.map(statusFromRow),
    validationLevels: parseStoredLevels(r.validation_levels),
    checklistOnCards: r.checklist_on_cards ?? true,
    fields: activeFields(parseStoredFields(r.task_fields)),
  }
}

/** The switch's keys on a project payload: only when the org uses it, or the call set it. */
function timeBudgetsKeys(r: {
  time_budgets_on: boolean
  time_budgets_changed_at: Date | string | null
  time_budgets_changed_by: string | null
  changer_name: string | null
}): Pick<ProjectDetail, "timeBudgets" | "timeBudgetsChangedAt" | "timeBudgetsChangedBy"> {
  const at = r.time_budgets_changed_at
  return {
    timeBudgets: r.time_budgets_on === true,
    ...(at ? { timeBudgetsChangedAt: at instanceof Date ? at.toISOString() : String(at) } : {}),
    ...(r.time_budgets_changed_by
      ? { timeBudgetsChangedBy: { id: r.time_budgets_changed_by, name: r.changer_name ?? "" } }
      : {}),
  }
}

/** One column of a board as requested at creation time. */
export interface ProjectStatusSeed {
  label: string
  color?: string | null
  /** Counts as done. When no seed sets it, the LAST column is made terminal so
   *  the board always has a done column (done-vs-remaining counts depend on it). */
  terminal?: boolean
}

export interface CreateProjectInput {
  name: string
  description?: string
  icon?: string
  color?: string
  /** Optional explicit project key (e.g. "ERB"). Validated against the same
   *  format the DB CHECK enforces, uppercased. Omit to auto-derive from the
   *  name (see task-key.ts `deriveProjectKey`). */
  key?: string
  /** Optional sidebar group heading; trimmed, empty = none (normalizeProjectGroup). */
  group?: string | null
  /** Optional initial columns, in board order. Omit (or pass empty) for the
   *  five defaults. A roadmap asked for as "idea / in discussion / candidate /
   *  todo / in progress / done" is created with exactly those columns instead
   *  of defaults-then-rename. */
  statuses?: ProjectStatusSeed[]
  /** D16: show the checklist summary on Kanban cards. Default true. */
  checklistOnCards?: boolean
  /** Task field definitions (the dashboard column shape, fields.ts); checked before any write. */
  fields?: unknown
}

/** A create's field definitions, checked (422 `invalid_fields`); none = []. */
export function normalizeFieldDefs(raw: unknown): Column[] {
  if (raw === undefined || raw === null) return []
  const parsed = columnsSchema.safeParse(raw)
  if (!parsed.success) {
    const issue = parsed.error.issues[0]
    const path = issue?.path.length ? ` (${issue.path.join(".")})` : ""
    throw new ProjectsServiceError(
      422,
      "invalid_fields",
      `${issue?.message ?? "invalid field list"}${path}`,
    )
  }
  return parsed.data
}

export const MAX_PROJECT_GROUP_LENGTH = 60

/** A project's group as stored: trimmed, empty or blank = null (ungrouped).
 *  Throws `invalid_group: …` when longer than MAX_PROJECT_GROUP_LENGTH. The
 *  one check of the rule (migration 0250 adds the column only).
 *  `undefined` passes through (no change). */
export function normalizeProjectGroup(raw: string | null | undefined): string | null | undefined {
  if (raw === undefined) return undefined
  if (raw === null) return null
  const trimmed = raw.trim()
  if (!trimmed) return null
  if (trimmed.length > MAX_PROJECT_GROUP_LENGTH) {
    throw new Error(
      `invalid_group: a group is at most ${MAX_PROJECT_GROUP_LENGTH} characters (got ${trimmed.length})`,
    )
  }
  return trimmed
}

export const MAX_STATUS_SEEDS = 20
export const MAX_STATUS_LABEL_LENGTH = 60

/** Validate the caller's initial columns and shape them like DEFAULT_STATUS_SEEDS.
 *  Throws `invalid_statuses: …` (mapped to 400 by the route / a tool error by
 *  the bridge) on an empty label, a duplicate (case-insensitive), or too many. */
export function normalizeStatusSeeds(
  seeds: ProjectStatusSeed[] | undefined,
): ReadonlyArray<readonly [string, number, boolean, string | null]> {
  if (!seeds || seeds.length === 0) return DEFAULT_STATUS_SEEDS
  if (seeds.length > MAX_STATUS_SEEDS) {
    throw new Error(`invalid_statuses: at most ${MAX_STATUS_SEEDS} columns (got ${seeds.length})`)
  }
  const seen = new Set<string>()
  const cleaned = seeds.map((seed, index) => {
    const label = (seed.label ?? "").trim()
    if (!label) throw new Error(`invalid_statuses: column ${index + 1} has an empty label`)
    if (label.length > MAX_STATUS_LABEL_LENGTH) {
      throw new Error(
        `invalid_statuses: column ${JSON.stringify(label)} is longer than ${MAX_STATUS_LABEL_LENGTH} chars`,
      )
    }
    const key = label.toLowerCase()
    if (seen.has(key))
      throw new Error(`invalid_statuses: duplicate column ${JSON.stringify(label)}`)
    seen.add(key)
    return { label, color: seed.color ?? null, terminal: seed.terminal === true }
  })
  if (!cleaned.some((s) => s.terminal)) cleaned[cleaned.length - 1]!.terminal = true
  return cleaned.map((s, order) => [s.label, order, s.terminal, s.color] as const)
}

/** At most this many tasks ride in one `createProject` call (`tasks`). */
export const MAX_INITIAL_TASKS = 20

/**
 * One task created with its project: the task-create tool's own title,
 * description and assignee fields (the manifest declares them identically),
 * nothing else. Status, dates and order are set afterwards with `update`.
 */
const initialTaskSchema = z
  .object({
    title: z.string().trim().min(1, "a task needs a title"),
    description: z.string().optional(),
    assigneeId: z.string().nullable().optional(),
    assigneeName: z.string().nullable().optional(),
  })
  .strict()

export type InitialTaskInput = z.infer<typeof initialTaskSchema>

/**
 * Validate the tasks a project is created with. Throws `invalid_tasks: …` on a
 * non-list, more than MAX_INITIAL_TASKS, an empty title or a field the
 * task-create tool would not take here.
 */
export function normalizeInitialTasks(raw: unknown): InitialTaskInput[] {
  if (raw === undefined || raw === null) return []
  if (!Array.isArray(raw)) throw new Error("invalid_tasks: tasks must be a list of tasks")
  if (raw.length > MAX_INITIAL_TASKS) {
    throw new Error(`invalid_tasks: at most ${MAX_INITIAL_TASKS} tasks (got ${raw.length})`)
  }
  return raw.map((task, index) => {
    const parsed = initialTaskSchema.safeParse(task)
    if (!parsed.success) {
      const issue = parsed.error.issues[0]
      const where = issue?.path.length ? ` (${issue.path.join(".")})` : ""
      throw new Error(`invalid_tasks: task ${index + 1}${where}: ${issue?.message ?? "invalid"}`)
    }
    return parsed.data
  })
}

export interface CreateProjectArgs {
  tx: RlsClient
  orgId: string
  actor: UserContext
  input: CreateProjectInput
}

const PROJECT_KEY_RE = /^[A-Z][A-Z0-9]{1,9}$/

/** Validate + uppercase an explicit project key, throwing a clear error otherwise. */
export function normalizeExplicitProjectKey(key: string): string {
  const upper = key.trim().toUpperCase()
  if (!PROJECT_KEY_RE.test(upper)) {
    throw new Error(
      `invalid_project_key: key must match ${PROJECT_KEY_RE} (2-10 chars, uppercase letters/digits, starting with a letter) — got ${JSON.stringify(key)}`,
    )
  }
  return upper
}

/** Insert a project row, retrying with a collision-safe suffix if the (org_id, key)
 *  unique index is violated (mirrors migration 0043's backfill collision handling). */
async function insertProjectWithKey(
  tx: RlsClient,
  args: {
    projectId: string
    orgId: string
    input: CreateProjectInput & { fieldDefs?: Column[] }
    ownerId: string
    kind?: "work" | "pipeline"
  },
): Promise<string> {
  const baseKey = args.input.key
    ? normalizeExplicitProjectKey(args.input.key)
    : deriveProjectKey(args.input.name)
  let candidate = baseKey
  const maxAttempts = 29 // base attempt + the full 28-char suffix range
  for (let attempt = 0; attempt <= maxAttempts; attempt++) {
    try {
      // Each attempt runs in its own SAVEPOINT (a nested tx.transaction()): a
      // unique-violation aborts only this savepoint, not the whole outer
      // transaction, so the next candidate can still be tried.
      await tx.transaction(async (savepointTx) => {
        await savepointTx.execute(drizzleSql`
          INSERT INTO ${projectsRel("projects")}
            (id, org_id, name, description, icon, color, key, "group", owner_id, checklist_on_cards, kind,
             task_fields)
          VALUES (
            ${args.projectId}::uuid,
            ${args.orgId}::uuid,
            ${args.input.name},
            ${args.input.description ?? null},
            ${args.input.icon ?? null},
            ${args.input.color ?? null},
            ${candidate},
            ${args.input.group ?? null},
            ${args.ownerId}::uuid,
            ${args.input.checklistOnCards ?? true},
            ${args.kind ?? "work"},
            ${JSON.stringify(args.input.fieldDefs ?? [])}::jsonb
          )
        `)
      })
      return candidate
    } catch (err) {
      const isUniqueViolation = isUniqueViolationOnConstraint(err, "app_projects_org_key_uidx")
      if (!isUniqueViolation) throw err
      if (args.input.key) {
        // An explicit key collided — surface a clear error rather than silently
        // mutating the caller's requested key.
        throw new Error(`project_key_taken: key ${JSON.stringify(baseKey)} is already in use`)
      }
      const next = nextKeyCollisionCandidate(baseKey, attempt)
      if (!next) throw err
      candidate = next
    }
  }
  throw new Error(`project_key_collision_exhausted: could not allocate a unique key for ${baseKey}`)
}

export async function createProject(args: CreateProjectArgs): Promise<ProjectDetail> {
  return insertProject(args, "work", (input) =>
    normalizeStatusSeeds(input.statuses).map(([label, order, terminal, color]) => ({
      label,
      order,
      terminal,
      color,
      dealOutcome: null,
    })),
  )
}

export interface CreatePipelineInput {
  name: string
  description?: string
  key?: string
  group?: string | null
  /** The open stages, in board order. Omit for Lead, Qualified, Demo,
   *  Proposal. Won and Lost always follow and close a deal. */
  stages?: string[]
}

export interface CreatePipelineArgs {
  tx: RlsClient
  orgId: string
  actor: UserContext
  input: CreatePipelineInput
}

/**
 * A sales pipeline: a project whose root tasks are deals. Its stages are the
 * open ones (by default Lead, Qualified, Demo, Proposal), then Won and Lost,
 * both terminal, which set a deal's outcome. The key is derived from the name
 * unless one is given.
 */
export async function createPipeline(args: CreatePipelineArgs): Promise<ProjectDetail> {
  const { stages, ...rest } = args.input
  const open: Array<{ label: string; color: string | null }> =
    stages && stages.length > 0
      ? normalizeStatusSeeds(stages.map((label) => ({ label }))).map(([label]) => ({
          label,
          color: null,
        }))
      : PIPELINE_OPEN_STAGES.map(([label, color]) => ({ label, color }))
  const taken = new Set(open.map((s) => s.label.toLowerCase()))
  for (const [label] of PIPELINE_CLOSING_STAGES) {
    if (taken.has(label.toLowerCase())) {
      throw new Error(
        `invalid_statuses: ${JSON.stringify(label)} is added by the pipeline itself; list only the open stages`,
      )
    }
  }
  if (open.length + PIPELINE_CLOSING_STAGES.length > MAX_STATUS_SEEDS) {
    throw new Error(
      `invalid_statuses: at most ${MAX_STATUS_SEEDS - PIPELINE_CLOSING_STAGES.length} open stages`,
    )
  }
  const seeds: StatusInsert[] = [
    ...open.map((s, order) => ({ ...s, order, terminal: false, dealOutcome: null })),
    ...PIPELINE_CLOSING_STAGES.map(([label, color, outcome], i) => ({
      label,
      color,
      order: open.length + i,
      terminal: true,
      dealOutcome: outcome,
    })),
  ]
  return insertProject({ ...args, input: rest }, "pipeline", () => seeds)
}

interface StatusInsert {
  label: string
  order: number
  terminal: boolean
  color: string | null
  dealOutcome: "won" | "lost" | null
}

async function insertProject(
  args: CreateProjectArgs,
  kind: "work" | "pipeline",
  statusSeeds: (input: CreateProjectInput) => StatusInsert[],
): Promise<ProjectDetail> {
  return args.tx.transaction(async (tx) => {
    const projectId = randomUUID()
    // Checked before anything is written: a too-long group creates nothing.
    const group = normalizeProjectGroup(args.input.group) ?? null
    const fieldDefs = normalizeFieldDefs(args.input.fields)
    await insertProjectWithKey(tx as RlsClient, {
      projectId,
      orgId: args.orgId,
      input: { ...args.input, group, fieldDefs },
      ownerId: args.actor.userId,
      kind,
    })
    // Inside the same transaction: an invalid column list rolls the project
    // row back too, so a rejected create never leaves an empty board behind.
    const seeds = statusSeeds(args.input)
    for (const { label, order, terminal, color, dealOutcome } of seeds) {
      const sId = randomUUID()
      await tx.execute(drizzleSql`
        INSERT INTO ${projectsRel("project_statuses")}
          (id, org_id, project_id, label, color, "order", terminal, deal_outcome)
        VALUES (
          ${sId}::uuid,
          ${args.orgId}::uuid,
          ${projectId}::uuid,
          ${label},
          ${color},
          ${order},
          ${terminal},
          ${dealOutcome}
        )
      `)
    }
    await tx.queueEvent({
      app: "projects",
      entity: "project",
      action: "created",
      entityId: projectId,
      data: { id: projectId, name: args.input.name, ...(kind === "pipeline" ? { kind } : {}) },
      actorId: args.actor.userId,
      actorType: args.actor.actorType,
      orgId: args.orgId,
    })
    return loadProjectDetail(tx as RlsClient, args.orgId, projectId)
  })
}
