// SPDX-License-Identifier: FSL-1.1-ALv2
/**
 * Import kinds of the projects app (modules/imports): `projects.task` and
 * `projects.project`.
 *
 * `projects.task`, per record inside its savepoint of the run's privileged
 * batch transaction:
 *   1. MANDATORY dedup precheck on `external_ref` (`<source>:<key>`, or the
 *      bare key of a row an earlier CLI run imported): `createTask` does NOT
 *      dedup and the partial unique `uniq_app_projects_tasks_external_ref`
 *      makes a duplicate throw. Present → skipped.
 *   2. Project ensured BY NAME (exact match; absent → `createProject`, which
 *      seeds the default statuses), status ensured BY LABEL (case-insensitive;
 *      absent → `addStatus`; `statusTerminal` applies only on creation).
 *   3. `parentExternalRef` resolves against ALREADY-imported tasks (an earlier
 *      record or run): order parents before children. Unresolvable → the
 *      record fails loudly.
 *   4. People: reporter, assignee and comment authors resolve by
 *      case-insensitive email to org users; with placeholders an unknown email
 *      becomes a DEACTIVATED user (exact attribution, no login), reused across
 *      records and runs. A real account always wins over an `@import.invalid`
 *      placeholder; names are never matched.
 *   5. Comments whose author resolves become real messages of the task's
 *      thread (direct INSERT, no live event: history must not fan out), the
 *      rest are folded into the description. The record's ACTIVE people are
 *      enrolled on the thread and marked read; the import actor keeps the seat
 *      `createTask` gives it only when it is the creator or one of them.
 *      Messages are indexed for search after the batch commits.
 *
 * A task record may carry its checklist (inserted with the task) and its
 * dependencies (`dependsOn`): linked with the task when the target is already
 * imported, else by `afterKind` once the kind's last batch is in; a target
 * that never arrives is reported (`dependenciesUnresolved`), never fails the
 * record. A target is a task of the run, or one the importing person can
 * read. Linking later recomputes the waiting task's `blocked` flag, an update
 * of a task the run created in an earlier batch: `afterKind` reports it
 * (`touched`, tasks are the kind's `rollupTables`) so undo still removes it.
 *
 * `projects.project` creates a project by name (an existing name is skipped,
 * never updated) with its statuses. `projects.template` (end of this file)
 * stores a task tree as a project template.
 *
 * Every row a record creates is returned for the undo ledger, in creation
 * order: placeholder users, an ensured project with its statuses, an ensured
 * status, the task's thread, its participants, the task, its messages, its
 * checklist items, its dependencies.
 */
import { randomUUID } from "node:crypto"
import { sql as drizzleSql } from "drizzle-orm"
import { z } from "zod"
import { kernelRel, projectsRel } from "~/apps/projects/schema-refs"
import { addItems, updateItem } from "~/apps/projects/service/checklist"
import {
  CHECKLIST_ITEMS_PER_ADD_MAX,
  CHECKLIST_ITEMS_PER_TASK_MAX,
} from "~/apps/projects/service/checklist-status"
import { createProject } from "~/apps/projects/service/create-project"
import { MAX_TASK_DEPTH } from "~/apps/projects/service/move-task"
import { addStatus, ProjectsServiceError } from "~/apps/projects/service/statuses"
import { addDependency, createTask } from "~/apps/projects/service/tasks"
import { extractRows, type PrivilegedDb } from "~/db"
import type { UserContext } from "~/db/rls"
import { copyObject, sanitizeFilename } from "~/infra/storage/object-storage"
import { rootLogger } from "~/lib/logger"
import { isBlockedFileType } from "~/modules/files/attach"
import { buildStorageKey, loadOrgSettings, wouldExceedOrgQuota } from "~/modules/files/service"
import { importServiceClient } from "~/modules/imports/service-client"
import {
  dedupMatchSql,
  type HostImportContext,
  type HostImportHandler,
  type ImportRecordResult,
  type ImportRowRef,
} from "~/modules/imports/types"
import { indexMessagesBulk } from "~/modules/search/message-indexer"

const log = rootLogger.child({ module: "projects-import-kind" })

/** A historical comment: a thread message when its author resolves, else
 *  folded into the task description. */
const commentSchema = z.object({
  authorName: z.string().optional().nullable(),
  authorEmail: z.string().optional().nullable(),
  body: z.string().min(1),
  createdAt: z.string().optional().nullable(),
})

/** A file attached to the task in the source: an uploaded (or staged) file, by id. */
const attachmentSchema = z.object({
  filename: z.string().min(1),
  mimeType: z.string().min(1).optional(),
  fileId: z.string().uuid(),
  createdAt: z.string().optional().nullable(),
  authorEmail: z.string().optional().nullable(),
  authorName: z.string().optional().nullable(),
})
type TaskImportAttachment = z.infer<typeof attachmentSchema>

/** The canonical task record (the manifest's JSON Schema mirrors it for API runs). */
export const taskImportRecordSchema = z.object({
  externalRef: z.string().min(1),
  project: z.object({ name: z.string().min(1) }),
  title: z.string().min(1),
  description: z.string().optional().nullable(),
  status: z.string().optional().nullable(),
  statusTerminal: z.boolean().optional(),
  assigneeEmail: z.string().optional().nullable(),
  assigneeName: z.string().optional().nullable(),
  reporterEmail: z.string().optional().nullable(),
  reporterName: z.string().optional().nullable(),
  priority: z.enum(["low", "normal", "high", "urgent"]).optional(),
  dueDate: z.string().optional().nullable(),
  startDate: z.string().optional().nullable(),
  blocked: z.boolean().optional(),
  createdAt: z.string().optional().nullable(),
  completedAt: z.string().optional().nullable(),
  parentExternalRef: z.string().optional().nullable(),
  comments: z.array(commentSchema).optional(),
  checklist: z
    .array(
      z.object({
        title: z.string().min(1),
        details: z.string().optional().nullable(),
        checked: z.boolean().optional(),
      }),
    )
    .max(CHECKLIST_ITEMS_PER_TASK_MAX)
    .optional(),
  dependsOn: z
    .array(
      z.object({ externalRef: z.string().min(1), type: z.enum(["blocks", "relates"]).optional() }),
    )
    .max(100)
    .optional(),
  attachments: z.array(attachmentSchema).max(100).optional(),
})

export type TaskImportComment = z.infer<typeof commentSchema>
export type TaskImportRecord = z.infer<typeof taskImportRecordSchema>

/** The canonical project record. */
export const projectImportRecordSchema = z.object({
  name: z.string().min(1),
  description: z.string().optional().nullable(),
  statuses: z
    .array(z.object({ label: z.string().min(1), terminal: z.boolean().optional() }))
    .optional(),
})

/** Trimmed + lowercased; empty → null. The one email key used everywhere. */
export function normalizeEmail(email: string | null | undefined): string | null {
  const e = email?.trim().toLowerCase()
  return e ? e : null
}

interface ResolvedUser {
  id: string
  /** Only an active user becomes a thread participant. */
  active: boolean
  placeholderCreated: boolean
}

interface KnownUser {
  id: string
  active: boolean
}

/**
 * Resolve one person (reporter, assignee, comment author) to an org user by
 * case-insensitive email. Without `placeholders` only ACTIVE users match and an
 * unknown email → null. With `placeholders` a user of ANY status matches and an
 * unknown email creates a DEACTIVATED user, stored lowercased so the next
 * lookup finds it. Runs inside the record's transaction.
 */
export async function resolveUser(
  tx: PrivilegedDb,
  orgId: string,
  email: string | null | undefined,
  name: string | null | undefined,
  opts: { placeholders: boolean },
): Promise<ResolvedUser | null> {
  const e = normalizeEmail(email)
  // A placeholder address is nobody's real email: never resolve or create one.
  if (!e || e.endsWith("@import.invalid")) return null
  const rows = extractRows<{ id: string; status: string }>(
    await tx.execute(drizzleSql`
      SELECT id, status FROM ${kernelRel("users")}
      WHERE org_id = ${orgId}::uuid AND lower(email) = ${e}
        AND email NOT LIKE '%@import.invalid'
        ${opts.placeholders ? drizzleSql`` : drizzleSql`AND status = 'active'`}
      ORDER BY (status = 'active') DESC,
        (password_hash IS NOT NULL OR invited_by IS NOT NULL) DESC,
        created_at ASC, id ASC
      LIMIT 1
    `),
  )
  if (rows[0]) {
    return { id: rows[0].id, active: rows[0].status === "active", placeholderCreated: false }
  }
  if (!opts.placeholders) return null
  const id = randomUUID()
  const label = name?.trim() || e.split("@")[0] || e
  await tx.execute(drizzleSql`
    INSERT INTO ${kernelRel("users")} (id, org_id, email, name, status)
    VALUES (${id}::uuid, ${orgId}::uuid, ${e}, ${label}, 'deactivated')
  `)
  return { id, active: false, placeholderCreated: true }
}

/** Fold historical comments into the description. Deterministic: input
 *  order, verbatim bodies. */
export function foldCommentsIntoDescription(
  description: string | null | undefined,
  comments: TaskImportComment[] | undefined,
): string | null {
  const body = description ?? null
  if (!comments || comments.length === 0) return body
  const rendered = comments.map((c) => {
    const author = c.authorName?.trim() || c.authorEmail?.trim() || "Unknown author"
    const when = c.createdAt ? ` — ${c.createdAt}` : ""
    return `**${author}**${when}:\n${c.body}`
  })
  const block = `## Imported comments\n\n${rendered.join("\n\n")}`
  return body && body.trim().length > 0 ? `${body}\n\n---\n\n${block}` : block
}

/** The first unparsable date of a record's comments, as a report message. */
export function invalidCommentDate(comments: TaskImportComment[] | undefined): string | null {
  for (const [i, c] of (comments ?? []).entries()) {
    if (c.createdAt && Number.isNaN(new Date(c.createdAt).getTime())) {
      return `comments[${i}].createdAt is not a valid ISO-8601 timestamp: "${c.createdAt}"`
    }
  }
  return null
}

/** An imported task's id by its source key (prefixed, or the bare legacy key). */
export async function findTaskIdByExternalRef(
  tx: PrivilegedDb,
  orgId: string,
  sourceLabel: string,
  key: string,
): Promise<string | null> {
  const rows = extractRows<{ id: string }>(
    await tx.execute(drizzleSql`
      SELECT id FROM ${projectsRel("tasks")}
      WHERE org_id = ${orgId}::uuid
        AND ${dedupMatchSql(drizzleSql`external_ref`, sourceLabel, key)}
      LIMIT 1
    `),
  )
  return rows[0]?.id ?? null
}

export async function projectIdByName(
  tx: PrivilegedDb,
  orgId: string,
  name: string,
): Promise<string | null> {
  const rows = extractRows<{ id: string }>(
    await tx.execute(drizzleSql`
      SELECT id FROM ${projectsRel("projects")}
      WHERE org_id = ${orgId}::uuid AND name = ${name}
      LIMIT 1
    `),
  )
  return rows[0]?.id ?? null
}

export async function statusIdsOf(
  tx: PrivilegedDb,
  orgId: string,
  projectId: string,
): Promise<string[]> {
  return extractRows<{ id: string }>(
    await tx.execute(drizzleSql`
      SELECT id FROM ${projectsRel("project_statuses")}
      WHERE org_id = ${orgId}::uuid AND project_id = ${projectId}::uuid
      ORDER BY "order", id
    `),
  ).map((r) => r.id)
}

/** Ensure a status label exists on the project; `terminal` applies only on creation. */
async function ensureStatus(
  tx: PrivilegedDb,
  orgId: string,
  actor: UserContext,
  projectId: string,
  label: string,
  terminal: boolean,
): Promise<{ statusId: string; created: boolean }> {
  const rows = extractRows<{ id: string }>(
    await tx.execute(drizzleSql`
      SELECT id FROM ${projectsRel("project_statuses")}
      WHERE org_id = ${orgId}::uuid AND project_id = ${projectId}::uuid
        AND lower(label) = ${label.toLowerCase()}
      LIMIT 1
    `),
  )
  if (rows[0]) return { statusId: rows[0].id, created: false }
  const status = await addStatus({
    tx: importServiceClient(tx),
    orgId,
    projectId,
    actor,
    input: { label, terminal },
  })
  return { statusId: status.id, created: true }
}

/** The transaction's now(), in epoch ms. */
async function transactionNowMs(tx: PrivilegedDb): Promise<number> {
  const [row] = extractRows<{ now: string | Date }>(
    await tx.execute(drizzleSql`SELECT now() AS now`),
  )
  return new Date(row!.now).getTime()
}

/** The privileged operator actor the projects services attribute rows to. */
export function serviceActor(ctx: HostImportContext): UserContext {
  return {
    actorType: "user",
    userId: ctx.actorUserId,
    orgId: ctx.orgId,
    scopes: ["*"],
    dimensionGrants: {},
  }
}

/** Per-record report of `projects.task` (the CLI maps it to its own report). */
export interface TaskRecordReport {
  projectCreated: boolean
  statusCreated: boolean
  assigneeUnresolved: string | null
  reporterUnresolved: string | null
  placeholdersCreated: string[]
  messageIds: string[]
  commentsImported: number
  commentsFolded: number
  checklistItems: number
  /** Attachments stored as task files. */
  attachmentsStored: number
  /** Dependencies linked with the task (their targets were already imported). */
  dependenciesLinked: number
  /** Dependencies a target or a cycle refused (`ref: reason`). */
  dependenciesRefused: number
}

/** A dependency whose target was not imported yet when its task was: linked
 *  by `afterKind` once the kind's last batch is in. */
interface DeferredDependency {
  taskId: string
  externalRef: string
  type: "blocks" | "relates"
}

interface TaskCache {
  projects: Map<string, string>
  statuses: Map<string, string>
  users: Map<string, KnownUser>
  deferredDependencies: DeferredDependency[]
}

function taskCache(ctx: HostImportContext): TaskCache {
  const existing = ctx.cache.get("task-cache")
  if (existing) return existing as TaskCache
  const fresh: TaskCache = {
    projects: new Map(),
    statuses: new Map(),
    users: new Map(),
    deferredDependencies: [],
  }
  ctx.cache.set("task-cache", fresh)
  return fresh
}

/**
 * A dependency's target by its source key: a task THIS run created (its
 * ledger), else a task the importing person can read (their RLS). Never
 * another task of the org: a link would change who sees what (a task's
 * `blocked` flag reports its target's open state).
 */
async function dependencyTargetId(
  tx: PrivilegedDb,
  ctx: HostImportContext,
  ref: string,
): Promise<string | null> {
  const own = extractRows<{ id: string }>(
    await tx.execute(drizzleSql`
      SELECT t.id FROM ${projectsRel("tasks")} t
      JOIN ${kernelRel("import_ledger")} l
        ON l.row_id = t.id AND l.table_name = 'app_projects.tasks'
       AND l.run_id = ${ctx.runId}::uuid AND l.org_id = ${ctx.orgId}::uuid
      WHERE t.org_id = ${ctx.orgId}::uuid
        AND ${dedupMatchSql(drizzleSql`t.external_ref`, ctx.sourceLabel, ref)}
      LIMIT 1
    `),
  )[0]
  if (own) return own.id
  return ctx.withActorRls(async (rls) => {
    const seen = extractRows<{ id: string }>(
      await rls.execute(drizzleSql`
        SELECT id FROM ${projectsRel("tasks")}
        WHERE org_id = ${ctx.orgId}::uuid
          AND ${dedupMatchSql(drizzleSql`external_ref`, ctx.sourceLabel, ref)}
        LIMIT 1
      `),
    )[0]
    return seen?.id ?? null
  })
}

/**
 * Link `taskId → dependsOnTaskId` through the projects service (its cycle
 * check and blocked-flag recompute), in its own savepoint so a refused link
 * fails alone. Returns the dependency row for the ledger, or the refusal.
 */
async function linkDependency(
  tx: PrivilegedDb,
  ctx: HostImportContext,
  taskId: string,
  dependsOnTaskId: string,
  type: "blocks" | "relates",
): Promise<{ row: ImportRowRef } | { refused: string }> {
  try {
    return await tx.transaction(async (sp) => {
      await addDependency({
        tx: importServiceClient(sp),
        orgId: ctx.orgId,
        actor: serviceActor(ctx),
        taskId,
        dependsOnTaskId,
        type,
      })
      const [dep] = extractRows<{ id: string }>(
        await sp.execute(drizzleSql`
          SELECT id FROM ${projectsRel("task_dependencies")}
          WHERE org_id = ${ctx.orgId}::uuid AND task_id = ${taskId}::uuid
            AND depends_on_task_id = ${dependsOnTaskId}::uuid
        `),
      )
      return { row: { table: "app_projects.task_dependencies", id: dep!.id } }
    })
  } catch (err) {
    return { refused: formatTaskImportError(err) }
  }
}

/** A task's checklist, appended through the checklist service (its limits). */
async function importChecklist(
  tx: PrivilegedDb,
  ctx: HostImportContext,
  taskId: string,
  items: NonNullable<TaskImportRecord["checklist"]>,
): Promise<ImportRowRef[]> {
  const rows: ImportRowRef[] = []
  const client = importServiceClient(tx)
  for (let i = 0; i < items.length; i += CHECKLIST_ITEMS_PER_ADD_MAX) {
    const chunk = items.slice(i, i + CHECKLIST_ITEMS_PER_ADD_MAX)
    const created = await addItems({
      tx: client,
      orgId: ctx.orgId,
      userId: ctx.actorUserId,
      actorKind: "human",
      taskId,
      items: chunk.map((it) => ({ title: it.title, details: it.details ?? null })),
    })
    for (const [j, item] of created.entries()) {
      rows.push({ table: "app_projects.task_checklist_items", id: item.id })
      if (chunk[j]?.checked === true) {
        await updateItem({
          tx: client,
          orgId: ctx.orgId,
          userId: ctx.actorUserId,
          actorKind: "human",
          itemId: item.id,
          taskId,
          patch: { checked: true },
        })
      }
    }
  }
  return rows
}

/**
 * The refusals a task record meets before anything is written: a bad comment
 * date, a parent that is not imported, an attachment of a refused type or with
 * a bad date. The run (importTask) and the preview (checkTask) both ask here,
 * so a preview refuses what the run would. `earlier`: the source keys of the
 * records a preview already passed (they are not written, so a child names its
 * parent through this set rather than the database).
 */
async function taskRecordRefusal(
  tx: PrivilegedDb,
  ctx: HostImportContext,
  record: TaskImportRecord,
  earlier?: ReadonlySet<string>,
): Promise<string | null> {
  const badCommentDate = invalidCommentDate(record.comments)
  if (badCommentDate) return badCommentDate
  if (record.parentExternalRef && !earlier?.has(record.parentExternalRef)) {
    const parent = await findTaskIdByExternalRef(
      tx,
      ctx.orgId,
      ctx.sourceLabel,
      record.parentExternalRef,
    )
    if (!parent) {
      return (
        `parentExternalRef "${record.parentExternalRef}" does not resolve to an imported task ` +
        `— order parents before children (or import the parent first)`
      )
    }
  }
  for (const att of record.attachments ?? []) {
    if (isBlockedFileType(att.filename, att.mimeType ?? "application/octet-stream")) {
      return `attachment "${att.filename}": this file type is not accepted`
    }
    if (att.createdAt && Number.isNaN(new Date(att.createdAt).getTime())) {
      return `attachment "${att.filename}": createdAt is not a date: "${att.createdAt}"`
    }
  }
  return null
}

/**
 * A preview's check of one task record: what the run would do, nothing
 * written. Parsed as the run parses it, skipped when imported before, refused
 * for what taskRecordRefusal refuses.
 */
async function checkTask(
  tx: PrivilegedDb,
  ctx: HostImportContext,
  raw: Record<string, unknown>,
): Promise<"created" | "skipped"> {
  const record = taskImportRecordSchema.parse(raw)
  const existing = await findTaskIdByExternalRef(tx, ctx.orgId, ctx.sourceLabel, record.externalRef)
  if (existing) return "skipped"
  const seen = previewSeen(ctx)
  const refusal = await taskRecordRefusal(tx, ctx, record, seen)
  if (refusal) throw new Error(refusal)
  seen.add(record.externalRef)
  return "created"
}

/** The source keys a preview passed so far (the run's cache, per kind). */
function previewSeen(ctx: HostImportContext): Set<string> {
  const existing = ctx.cache.get("preview-seen")
  if (existing instanceof Set) return existing as Set<string>
  const fresh = new Set<string>()
  ctx.cache.set("preview-seen", fresh)
  return fresh
}

async function importTask(
  tx: PrivilegedDb,
  ctx: HostImportContext,
  raw: Record<string, unknown>,
  dedupValue: string,
) {
  const record = taskImportRecordSchema.parse(raw)
  const { orgId } = ctx
  const actor = serviceActor(ctx)
  const cache = taskCache(ctx)
  const existing = await findTaskIdByExternalRef(tx, orgId, ctx.sourceLabel, record.externalRef)
  if (existing) return { status: "skipped" as const, rows: [] }
  // The checks a preview runs too, before anything is written.
  const refusal = await taskRecordRefusal(tx, ctx, record)
  if (refusal) throw new Error(refusal)

  const rows: ImportRowRef[] = []
  const pendingCache: Array<() => void> = []

  // People first (placeholders are the oldest rows of the record).
  const placeholdersCreated: string[] = []
  const resolvedUsers = new Map<string, KnownUser>()
  const activeIds = new Set<string>()
  const person = async (
    email: string | null | undefined,
    name: string | null | undefined,
  ): Promise<string | null> => {
    const e = normalizeEmail(email)
    if (!e) return null
    let known = resolvedUsers.get(e) ?? cache.users.get(e) ?? null
    if (!known) {
      const found = await resolveUser(tx, orgId, e, name, { placeholders: ctx.placeholders })
      if (!found) return null
      if (found.placeholderCreated) {
        placeholdersCreated.push(e)
        rows.push({ table: "kernel.users", id: found.id })
      }
      known = { id: found.id, active: found.active }
    }
    resolvedUsers.set(e, known)
    if (known.active) activeIds.add(known.id)
    return known.id
  }

  // Project: cached id (committed by an earlier record) or ensured now.
  let projectId = cache.projects.get(record.project.name) ?? null
  let projectCreated = false
  if (!projectId) {
    projectId = await projectIdByName(tx, orgId, record.project.name)
    if (!projectId) {
      const detail = await createProject({
        tx: importServiceClient(tx),
        orgId,
        actor,
        input: { name: record.project.name },
      })
      projectId = detail.id
      projectCreated = true
      rows.push({ table: "app_projects.projects", id: projectId })
      for (const id of await statusIdsOf(tx, orgId, projectId)) {
        rows.push({ table: "app_projects.project_statuses", id })
      }
    }
  }
  const ensuredProjectId = projectId
  pendingCache.push(() => cache.projects.set(record.project.name, ensuredProjectId))

  // Status: cached or ensured. No status → createTask picks the default.
  let statusId: string | null = null
  let statusCreated = false
  if (record.status) {
    const statusKey = `${projectId}:${record.status.toLowerCase()}`
    statusId = cache.statuses.get(statusKey) ?? null
    if (!statusId) {
      const ensured = await ensureStatus(
        tx,
        orgId,
        actor,
        projectId,
        record.status,
        record.statusTerminal ?? false,
      )
      statusId = ensured.statusId
      statusCreated = ensured.created
      if (ensured.created) rows.push({ table: "app_projects.project_statuses", id: statusId })
    }
    const ensuredStatusId = statusId
    pendingCache.push(() => cache.statuses.set(statusKey, ensuredStatusId))
  }

  // Subtask parent: must already be imported (earlier record or previous run).
  let parentTaskId: string | null = null
  if (record.parentExternalRef) {
    // Resolved: taskRecordRefusal refused a parent that is not imported.
    parentTaskId = await findTaskIdByExternalRef(
      tx,
      orgId,
      ctx.sourceLabel,
      record.parentExternalRef,
    )
  }

  // Reporter: unknown → the actor stays creator + a loud report line.
  const reporterId = await person(record.reporterEmail, record.reporterName)
  const reporterUnresolved =
    !reporterId && normalizeEmail(record.reporterEmail) ? (record.reporterEmail ?? null) : null

  // Assignee: unknown email → unassigned + a loud report line (never fails).
  let assigneeId: string | null = null
  let assigneeUnresolved: string | null = null
  if (record.assigneeEmail) {
    assigneeId = await person(record.assigneeEmail, record.assigneeName)
    if (!assigneeId) assigneeUnresolved = record.assigneeEmail
  }

  // Comments: resolve every author BEFORE createTask (folded ones are part of
  // the description). A bad date fails the record.
  const toPost: Array<{ index: number; authorId: string; comment: TaskImportComment }> = []
  const toFold: TaskImportComment[] = []
  for (const [index, comment] of (record.comments ?? []).entries()) {
    const authorId = await person(comment.authorEmail, comment.authorName)
    if (authorId) toPost.push({ index, authorId, comment })
    else toFold.push(comment)
  }

  // Attachment authors, resolved before the task like comment authors (an
  // unknown one: the reporter, else the actor).
  const attachmentAuthors: string[] = []
  for (const att of record.attachments ?? []) {
    attachmentAuthors.push(
      (await person(att.authorEmail, att.authorName)) ?? reporterId ?? actor.userId,
    )
  }

  const task = await createTask({
    tx: importServiceClient(tx),
    orgId,
    actor,
    input: {
      projectId,
      ...(statusId ? { statusId } : {}),
      parentTaskId,
      title: record.title,
      description: foldCommentsIntoDescription(record.description, toFold),
      assigneeId,
      ...(record.priority ? { priority: record.priority } : {}),
      dueDate: record.dueDate ?? null,
      startDate: record.startDate ?? null,
      blocked: record.blocked ?? false,
      createdAt: record.createdAt ?? null,
      completedAt: record.completedAt ?? null,
      ...(reporterId ? { createdBy: reporterId } : {}),
      // Placeholders and departed users are deactivated by design.
      allowInactiveAssignee: ctx.placeholders,
      externalRef: dedupValue,
    },
  })

  // Historical messages: direct INSERT, no event. An undated comment falls
  // back to the record's creation PLUS its input index in ms, so undated
  // comments never tie and read back in input order. Without a creation date
  // they end at the database's now(), never after: a message newer than the
  // transaction moves its thread's updated_at (trigger) past the ledger time
  // and undo would read the run's own thread as changed.
  const fallbackBase = record.createdAt
    ? Date.parse(record.createdAt)
    : (await transactionNowMs(tx)) - (record.comments?.length ?? 0)
  const messageRows = toPost.map(({ index, authorId, comment }) => ({
    id: randomUUID(),
    author_id: authorId,
    content: comment.body,
    metadata: {
      import: { source: "projects-import", externalRef: record.externalRef, commentIndex: index },
    },
    created_at: comment.createdAt
      ? new Date(comment.createdAt).toISOString()
      : new Date(fallbackBase + index).toISOString(),
  }))
  const messageIds = messageRows.map((m) => m.id)
  let newest: { id: string; at: string } | null = null
  for (const m of messageRows) {
    if (!newest || m.created_at >= newest.at) newest = { id: m.id, at: m.created_at }
  }
  if (messageRows.length > 0) {
    await tx.execute(drizzleSql`
      INSERT INTO ${kernelRel("messages")}
        (id, thread_id, org_id, author_id, author_type, content, metadata, required_scopes,
         edited_at, created_at)
      SELECT r.id, ${task.threadId}::uuid, ${orgId}::uuid, r.author_id, 'user',
             r.content, r.metadata, '{}'::text[], NULL, r.created_at
      FROM jsonb_to_recordset(${JSON.stringify(messageRows)}::jsonb)
        AS r(id uuid, author_id uuid, content text, metadata jsonb, created_at timestamptz)
    `)
  }

  // Participants + read state for the record's ACTIVE people; nobody else
  // holds a seat (see the module header).
  {
    const people = new Set<string>()
    if (!reporterId) people.add(actor.userId)
    for (const id of [reporterId, assigneeId, ...toPost.map((p) => p.authorId)]) {
      if (id && activeIds.has(id)) people.add(id)
    }
    if (!people.has(actor.userId)) {
      // createTask seats its actor, as for every live create.
      await tx.execute(drizzleSql`
        DELETE FROM ${kernelRel("thread_participants")}
        WHERE thread_id = ${task.threadId}::uuid AND user_id = ${actor.userId}::uuid
          AND org_id = ${orgId}::uuid
      `)
    }
    const peopleJson = JSON.stringify([...people])
    await tx.execute(drizzleSql`
      INSERT INTO ${kernelRel("thread_participants")} (thread_id, user_id, org_id, role)
      SELECT ${task.threadId}::uuid, u::uuid, ${orgId}::uuid, 'member'
      FROM jsonb_array_elements_text(${peopleJson}::jsonb) AS u
      ON CONFLICT (thread_id, user_id) WHERE user_id IS NOT NULL DO NOTHING
    `)
    await tx.execute(drizzleSql`
      INSERT INTO ${kernelRel("user_thread_state")}
        (user_id, thread_id, org_id, last_read_message_id, last_read_at)
      SELECT u::uuid, ${task.threadId}::uuid, ${orgId}::uuid,
             ${newest ? drizzleSql`${newest.id}::uuid` : drizzleSql`NULL`}, now()
      FROM jsonb_array_elements_text(${peopleJson}::jsonb) AS u
      ON CONFLICT (user_id, thread_id) DO UPDATE SET
        last_read_message_id = COALESCE(EXCLUDED.last_read_message_id, ${kernelRel("user_thread_state")}.last_read_message_id),
        last_read_at = now()
    `)
  }

  // Ledger: the thread, its participants, the task, its messages.
  rows.push({ table: "kernel.threads", id: task.threadId })
  for (const p of extractRows<{ id: string }>(
    await tx.execute(drizzleSql`
      SELECT id FROM ${kernelRel("thread_participants")}
      WHERE thread_id = ${task.threadId}::uuid AND org_id = ${orgId}::uuid
      ORDER BY created_at, id
    `),
  )) {
    rows.push({ table: "kernel.thread_participants", id: p.id })
  }
  rows.push({ table: "app_projects.tasks", id: task.id })
  for (const id of messageIds) rows.push({ table: "kernel.messages", id })

  // Checklist items, with the task.
  if (record.checklist?.length) {
    rows.push(...(await importChecklist(tx, ctx, task.id, record.checklist)))
  }

  // Attachments: task files, as the upload path stores them, backdated.
  for (const [ordinal, att] of (record.attachments ?? []).entries()) {
    rows.push(
      await storeTaskAttachment(tx, ctx, task.id, att, attachmentAuthors[ordinal]!, ordinal),
    )
  }

  // Dependencies: linked now when the target is already imported, else
  // deferred to `afterKind` (the target may come in a later batch).
  let dependenciesLinked = 0
  let dependenciesRefused = 0
  for (const dep of record.dependsOn ?? []) {
    const type = dep.type ?? "blocks"
    const targetId = await dependencyTargetId(tx, ctx, dep.externalRef)
    if (!targetId) {
      const deferred: DeferredDependency = { taskId: task.id, externalRef: dep.externalRef, type }
      pendingCache.push(() => cache.deferredDependencies.push(deferred))
      continue
    }
    const linked = await linkDependency(tx, ctx, task.id, targetId, type)
    if ("row" in linked) {
      rows.push(linked.row)
      dependenciesLinked++
    } else {
      dependenciesRefused++
    }
  }

  // The run cache learns ids only once the record's savepoint released.
  for (const fill of pendingCache) fill()
  for (const [email, user] of resolvedUsers) cache.users.set(email, user)

  const report: TaskRecordReport = {
    projectCreated,
    statusCreated,
    assigneeUnresolved,
    reporterUnresolved,
    placeholdersCreated,
    messageIds,
    commentsImported: messageIds.length,
    commentsFolded: toFold.length,
    checklistItems: record.checklist?.length ?? 0,
    attachmentsStored: record.attachments?.length ?? 0,
    dependenciesLinked,
    dependenciesRefused,
  }
  return { status: "created" as const, rows, report: { ...report } }
}

/**
 * The dependencies whose targets were not imported yet when their task was:
 * linked now that the kind's last batch is in. A target that never arrived
 * (or a link the service refuses, a cycle) is counted, never fails a record.
 */
async function linkDeferredDependencies(tx: PrivilegedDb, ctx: HostImportContext) {
  const cache = taskCache(ctx)
  const rows: ImportRowRef[] = []
  const touched: ImportRowRef[] = []
  let linked = 0
  let unresolved = 0
  let refused = 0
  for (const dep of cache.deferredDependencies.splice(0)) {
    const targetId = await dependencyTargetId(tx, ctx, dep.externalRef)
    if (!targetId) {
      unresolved++
      continue
    }
    const result = await linkDependency(tx, ctx, dep.taskId, targetId, dep.type)
    if ("row" in result) {
      rows.push(result.row)
      // Linking recomputes the waiting task's `blocked`: the run's own update.
      touched.push({ table: "app_projects.tasks", id: dep.taskId })
      linked++
    } else {
      refused++
    }
  }
  return {
    rows,
    touched,
    report: {
      ...(linked > 0 ? { dependenciesLinked: linked } : {}),
      ...(unresolved > 0 ? { dependenciesUnresolved: unresolved } : {}),
      ...(refused > 0 ? { dependenciesRefused: refused } : {}),
    },
  }
}

/**
 * Store one attachment as a file of the task (app `projects`, entity `task`,
 * the fileParent the manifest declares): the source file's bytes copied to the
 * task's own key, the row backdated to the attachment's date and uploaded by
 * its author, with the upload path's `file:create` event (thumbnails; nobody
 * notified). The source is resolved under the person's RLS (or is a file the
 * run's transform staged).
 */
async function storeTaskAttachment(
  tx: PrivilegedDb,
  ctx: HostImportContext,
  taskId: string,
  att: TaskImportAttachment,
  authorId: string,
  ordinal: number,
): Promise<ImportRowRef> {
  const mimeType = att.mimeType ?? "application/octet-stream"
  if (isBlockedFileType(att.filename, mimeType)) {
    throw new Error(`attachment "${att.filename}": this file type is not accepted`)
  }
  const src = await ctx.resolveFile(att.fileId).catch(() => {
    throw new Error(`attachment "${att.filename}": file ${att.fileId} not found`)
  })
  const settings = await loadOrgSettings(tx, ctx.orgId)
  if (await wouldExceedOrgQuota(tx, ctx.orgId, settings, src.sizeBytes)) {
    throw new Error(`attachment "${att.filename}": it would exceed the org storage quota`)
  }
  const createdAt = att.createdAt ? new Date(att.createdAt) : null
  if (createdAt && Number.isNaN(createdAt.getTime())) {
    throw new Error(`attachment "${att.filename}": createdAt is not a date: "${att.createdAt}"`)
  }
  const id = randomUUID()
  const filename = sanitizeFilename(att.filename)
  const storageKey = buildStorageKey({
    orgId: ctx.orgId,
    app: "projects",
    entityType: "task",
    entityId: taskId,
    filename,
    objectId: id,
  })
  await copyObject({ sourceKey: src.storageKey, destKey: storageKey })
  await tx.execute(drizzleSql`
    INSERT INTO ${kernelRel("files")}
      (id, org_id, app, entity_type, entity_id, filename, mime_type, size_bytes,
       storage_key, uploaded_by, disposition, ordinal, created_at)
    VALUES (${id}::uuid, ${ctx.orgId}::uuid, 'projects', 'task', ${taskId},
            ${filename}, ${mimeType}, ${src.sizeBytes}, ${storageKey},
            ${authorId}::uuid, 'attachment', ${ordinal},
            ${createdAt ? drizzleSql`${createdAt.toISOString()}::timestamptz` : drizzleSql`now()`})
  `)
  await tx.queueEvent({
    app: "kernel",
    entity: "file",
    action: "create",
    entityId: id,
    orgId: ctx.orgId,
    actorId: authorId,
    actorType: "user",
    data: {
      id,
      app: "projects",
      entityType: "task",
      entityId: taskId,
      filename,
      mimeType,
      sizeBytes: src.sizeBytes,
      storageKey,
      parentSharedSurface: false,
      parentParticipantIds: [],
      parentLabel: null,
    },
  })
  return { table: "kernel.files", id }
}

/** The error text of a failed task record (service errors carry their code). */
export function formatTaskImportError(err: unknown): string {
  return err instanceof ProjectsServiceError
    ? `${err.code}: ${err.message}`
    : err instanceof Error
      ? err.message
      : String(err)
}

export const taskImportHandler: HostImportHandler = {
  importRecord: importTask,
  checkRecord: checkTask,
  formatError: formatTaskImportError,
  afterKind: linkDeferredDependencies,
  /**
   * Index the batch's imported messages for search, in bulk, after commit
   * (the indexer re-reads the committed rows). Best-effort: failures are
   * counted, never fail a record. A client that indexes once per run (the
   * CLI) sets `options.deferIndexing`.
   */
  async afterCommit(ctx: HostImportContext, results: ImportRecordResult[]) {
    if (ctx.options.deferIndexing === true) return undefined
    const ids: string[] = []
    for (const r of results) {
      const m = r.report?.messageIds
      if (r.status === "created" && Array.isArray(m)) {
        for (const id of m) if (typeof id === "string") ids.push(id)
      }
    }
    if (ids.length === 0) return undefined
    try {
      const { failures } = await indexMessagesBulk(ctx.orgId, ids)
      return failures.length > 0 ? { indexFailures: failures.length } : undefined
    } catch (err) {
      log.warn({ err, orgId: ctx.orgId }, "imported messages could not be indexed")
      return { indexFailures: ids.length }
    }
  },
}

async function importProject(
  tx: PrivilegedDb,
  ctx: HostImportContext,
  raw: Record<string, unknown>,
) {
  const record = projectImportRecordSchema.parse(raw)
  const { orgId } = ctx
  // Projects carry no external ref: an existing name is skipped, never updated.
  if (await projectIdByName(tx, orgId, record.name)) return { status: "skipped" as const, rows: [] }
  const detail = await createProject({
    tx: importServiceClient(tx),
    orgId,
    actor: serviceActor(ctx),
    input: {
      name: record.name,
      ...(record.description ? { description: record.description } : {}),
    },
  })
  const rows: ImportRowRef[] = [{ table: "app_projects.projects", id: detail.id }]
  for (const id of await statusIdsOf(tx, orgId, detail.id)) {
    rows.push({ table: "app_projects.project_statuses", id })
  }
  for (const s of record.statuses ?? []) {
    const ensured = await ensureStatus(
      tx,
      orgId,
      serviceActor(ctx),
      detail.id,
      s.label,
      s.terminal ?? false,
    )
    if (ensured.created) rows.push({ table: "app_projects.project_statuses", id: ensured.statusId })
  }
  return { status: "created" as const, rows }
}

export const projectImportHandler: HostImportHandler = {
  importRecord: importProject,
  formatError: formatTaskImportError,
}

// ---------------------------------------------------------------------------
// projects.template: a task tree stored as a project template, materialized
// later by `instantiateTemplate` (service/tasks.ts).
// ---------------------------------------------------------------------------

/** Nodes a template may hold in all (a template is a skeleton, not a backlog). */
export const TEMPLATE_MAX_NODES = 1000

interface TemplateNodeInput {
  title: string
  description?: string | null
  children?: TemplateNodeInput[]
}

const templateNodeSchema: z.ZodType<TemplateNodeInput> = z.lazy(() =>
  z.object({
    title: z.string().trim().min(1).max(500),
    description: z.string().max(100_000).optional().nullable(),
    children: z.array(templateNodeSchema).optional(),
  }),
)

/** The canonical template record. */
export const templateImportRecordSchema = z.object({
  name: z.string().trim().min(1).max(200),
  structure: z.array(templateNodeSchema).min(1),
})

/** Depth and size of a template tree (a root node is depth 1). */
function templateShape(nodes: TemplateNodeInput[]): { depth: number; count: number } {
  let depth = 0
  let count = 0
  const walk = (list: TemplateNodeInput[], level: number) => {
    for (const n of list) {
      count++
      depth = Math.max(depth, level)
      if (n.children?.length) walk(n.children, level + 1)
    }
  }
  walk(nodes, 1)
  return { depth, count }
}

/** One template; an existing name in the org is skipped untouched. */
async function importTemplate(
  tx: PrivilegedDb,
  ctx: HostImportContext,
  raw: Record<string, unknown>,
) {
  const record = templateImportRecordSchema.parse(raw)
  const { depth, count } = templateShape(record.structure)
  if (depth > MAX_TASK_DEPTH) {
    // instantiateTemplate would hit createTask's depth guard half way through.
    throw new ProjectsServiceError(
      400,
      "template_too_deep",
      `a template nests at most ${MAX_TASK_DEPTH} levels (this one ${depth})`,
    )
  }
  if (count > TEMPLATE_MAX_NODES) {
    throw new ProjectsServiceError(
      400,
      "template_too_large",
      `a template holds at most ${TEMPLATE_MAX_NODES} tasks (this one ${count})`,
    )
  }
  // No unique index on the name: the per-(org, kind) import lock serializes runs.
  const existing = extractRows<{ id: string }>(
    await tx.execute(drizzleSql`
      SELECT id FROM ${projectsRel("project_templates")}
      WHERE org_id = ${ctx.orgId}::uuid AND name = ${record.name}
      LIMIT 1
    `),
  )
  if (existing.length > 0) return { status: "skipped" as const, rows: [] }
  const [row] = extractRows<{ id: string }>(
    await tx.execute(drizzleSql`
      INSERT INTO ${projectsRel("project_templates")} (org_id, name, structure, created_by)
      VALUES (
        ${ctx.orgId}::uuid, ${record.name}, ${JSON.stringify(record.structure)}::jsonb,
        ${ctx.actorUserId}::uuid
      )
      RETURNING id
    `),
  )
  return {
    status: "created" as const,
    rows: [{ table: "app_projects.project_templates", id: row!.id }],
  }
}

export const templateImportHandler: HostImportHandler = {
  importRecord: (tx, ctx, record) => importTemplate(tx, ctx, record),
  formatError: formatTaskImportError,
}
