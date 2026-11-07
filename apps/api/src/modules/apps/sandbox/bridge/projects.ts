// SPDX-License-Identifier: FSL-1.1-ALv2

import { sql as drizzleSql } from "drizzle-orm"
import { extractRows, type RlsClient } from "~/db"
import { schemaRef } from "~/db/schema-ref"
import type { BridgeContext } from "~/modules/apps/sandbox/bridge/context"
import { envelopeError } from "~/modules/apps/sandbox/bridge/shared"

/**
 * U4.12 (CI→projects webhook): `createTask`/`updateTask`/`createProject` take
 * an `actor: UserContext` with a REAL `userId` (it lands in the `created_by`
 * uuid column, cast `::uuid` — a non-uuid value throws at the SQL layer).
 * Every existing caller of the `projects_*` bridge methods reaches them via a
 * genuine user/agent turn, so `inheritedActor` is already a `UserContext` and
 * this path never ran. The webhook route (modules/webhooks/routes.ts) is the
 * first caller that invokes the sandbox with a SYSTEM actor and the literal
 * `userId: "system"` — passing that straight through would throw on every
 * `ci-status` delivery. Resolve the org's oldest ACTIVE user instead (the
 * same "admin fallback until personas are active" convention the ops
 * provisioners already use for RJ/DSP2/compliance tasks).
 */
async function resolveWebhookFallbackUserId(txDb: RlsClient, orgId: string): Promise<string> {
  const rows = extractRows<{ id: string }>(
    await txDb.execute(
      drizzleSql`SELECT id FROM ${drizzleSql.raw(schemaRef("kernel"))}.users
        WHERE org_id = ${orgId}::uuid AND status = 'active'
        ORDER BY created_at ASC LIMIT 1`,
    ),
  )
  const fallback = rows[0]?.id
  if (!fallback) {
    throw new Error(`resolveWebhookFallbackUserId: no active user found for org ${orgId}`)
  }
  return fallback
}

/** The projects app surface. */
export function createProjectsMethods(ctx: BridgeContext): Record<string, any> {
  const {
    appName,
    approvalContext,
    bridgeActingAgentId,
    bridgeRoutineId,
    bridgeOptions,
    callerScopes,
    inheritedActor,
    knowledgeWriteRequiredScopes,
    orgId,
    txDb,
    userId,
  } = ctx
  // Actor kind for the checklist (validation `via`, fail-note author, adding
  // items to a terminal task, checklistWarning): only a direct human UI
  // dispatch is a human. in-app-agent, mcp, system and a missing origin are
  // agents. An approved call keeps its originating surface, so it stays an agent.
  const actorKind: "human" | "agent" = bridgeOptions?.origin === "human-ui" ? "human" : "agent"
  /**
   * The agent whose turn made this call, or null when no agent acted (a human
   * in the app UI, a job, a webhook, a world injector). A comment it posts is
   * the AGENT's, attributed and never impersonated as the person; the RLS
   * actor stays the person, so nothing it can reach widens.
   */
  const commentingAgentId: string | null = actorKind === "agent" ? bridgeActingAgentId : null
  /**
   * Who created a task when an agent did, as the task header shows it: the
   * routine whose tick acted ("Routine <name>"), else a named agent's display
   * name, else "<person>'s agent" (attributed, never the person alone). Null
   * when a person acted in the app. Resolved once per bridge.
   */
  let agentCreatorLabelMemo: Promise<string | null> | undefined
  const agentCreatorLabel = (): Promise<string | null> => {
    agentCreatorLabelMemo ??= (async () => {
      if (actorKind !== "agent") return null
      const routineId = bridgeRoutineId ?? approvalContext?.originRoutineId
      if (routineId) {
        const { routineAuthorLabel } = await import("~/modules/agent/routines/routine-report")
        const label = await routineAuthorLabel(orgId, routineId)
        if (label) return label
      }
      if (bridgeActingAgentId) {
        const [agent] = extractRows<{ kind: string; display_name: string | null }>(
          await txDb.execute(
            drizzleSql`SELECT kind, display_name FROM ${drizzleSql.raw(schemaRef("kernel"))}.agents
              WHERE id = ${bridgeActingAgentId}::uuid AND org_id = ${orgId}::uuid LIMIT 1`,
          ),
        )
        if (agent && agent.kind !== "personal" && agent.display_name) return agent.display_name
      }
      const personId = (await writeActor()).userId
      const [person] = extractRows<{ name: string | null }>(
        await txDb.execute(
          drizzleSql`SELECT name FROM ${drizzleSql.raw(schemaRef("kernel"))}.users
            WHERE id = ${personId}::uuid AND org_id = ${orgId}::uuid LIMIT 1`,
        ),
      )
      return `${person?.name ?? "User"}'s agent`
    })()
    return agentCreatorLabelMemo
  }
  /** Is the task in a terminal status right now? */
  const taskIsTerminal = async (taskId: string): Promise<boolean> => {
    const rows = extractRows<{ terminal: boolean | null }>(
      await txDb.execute(
        drizzleSql`SELECT s.terminal FROM ${drizzleSql.raw(schemaRef("app_projects"))}.tasks t
          LEFT JOIN ${drizzleSql.raw(schemaRef("app_projects"))}.project_statuses s ON s.id = t.status_id
          WHERE t.id = ${taskId}::uuid AND t.org_id = ${orgId}::uuid LIMIT 1`,
      ),
    )
    return rows[0]?.terminal === true
  }
  /**
   * The checklist never blocks a status change. When an agent's write
   * puts a task with an incomplete checklist into a terminal status (it was
   * not terminal before), the tool result carries `checklistWarning` so the
   * agent sees what is not proven. Humans get the plain result.
   */
  const withChecklistWarning = async (
    taskId: string,
    run: () => Promise<unknown>,
  ): Promise<string> => {
    if (actorKind !== "agent") return JSON.stringify(await run())
    const { checklistWarningForTerminal } = await import("~/apps/projects/service/checklist")
    const wasTerminal = await taskIsTerminal(taskId)
    const result = await run()
    const warning = wasTerminal
      ? null
      : await checklistWarningForTerminal(txDb as never, orgId, taskId)
    if (!warning || !result || typeof result !== "object") return JSON.stringify(result)
    return JSON.stringify({ ...(result as Record<string, unknown>), checklistWarning: warning })
  }
  const resolveTask = async (ref: string): Promise<string> => {
    const { resolveTaskRef } = await import("~/apps/projects/service/resolve")
    return resolveTaskRef(txDb as never, orgId, ref)
  }
  /**
   * Run a service read or a checklist call; a ProjectsServiceError answers a
   * typed envelope (code, message, details) instead of an opaque throw.
   */
  const typedCall = async (run: () => Promise<unknown>): Promise<string> => {
    const { ProjectsServiceError } = await import("~/apps/projects/service/statuses")
    try {
      return JSON.stringify(await run())
    } catch (err) {
      if (err instanceof ProjectsServiceError) {
        return JSON.stringify({
          error: {
            code: err.code,
            message: err.message,
            status: err.status,
            retryable: false,
            ...(err.details ? { details: err.details } : {}),
          },
        })
      }
      throw err
    }
  }
  /**
   * The direct (ungated) task and status writes: the run happens in its own
   * savepoint, and a ProjectsServiceError answers a typed envelope instead of
   * a throw. A throw crossing the sandbox boundary arrives as an opaque
   * `tool_error`, so the agent lost the code (project_ambiguous,
   * status_not_found, assignee_not_found, ...) that the stage-time preflights
   * used to give it while these tools were gated. The savepoint keeps a
   * refused call from leaving half its writes behind (update reparents, then
   * edits).
   */
  const typedServiceCall = async (run: () => Promise<string>): Promise<string> => {
    const { ProjectsServiceError } = await import("~/apps/projects/service/statuses")
    try {
      return await txDb.transaction(async () => run())
    } catch (err) {
      if (err instanceof ProjectsServiceError) {
        return JSON.stringify({
          error: {
            code: err.code,
            message: err.message,
            status: err.status,
            retryable: false,
            ...(err.details ? { details: err.details } : {}),
          },
        })
      }
      throw err
    }
  }
  /**
   * The user actor of a write: the inherited user, else the bridge user (the
   * webhook fallback user for a system run) with the caller's scopes.
   */
  const writeActor = async () =>
    inheritedActor.actorType === "user"
      ? inheritedActor
      : {
          actorType: "user" as const,
          userId: userId === "system" ? await resolveWebhookFallbackUserId(txDb, orgId) : userId,
          orgId,
          scopes: callerScopes ?? [],
          dimensionGrants: {},
        }
  /** A checklist write in its own savepoint, so a refusal rolls back every row it touched. */
  const checklistWrite = async (run: (stepTx: never) => Promise<unknown>): Promise<string> => {
    const { hasScope: checkScope } = await import("~/modules/permissions/permissions")
    if (!checkScope("projects:tasks:write", callerScopes ?? [])) {
      return envelopeError("forbidden", "Missing required scope: projects:tasks:write")
    }
    return typedCall(() => txDb.transaction(async (stepTx) => run(stepTx as never)))
  }
  return {
    // --- Projects tool bridges ---
    projects_search: async (paramsJson: string): Promise<string> => {
      if (appName !== "projects") {
        throw new Error("projects_search is only available to the projects app")
      }
      const params = JSON.parse(paramsJson || "{}") as {
        query?: string
        archived?: "include" | "only" | "exclude"
        limit?: number
        cursor?: string
        /** "Recently involved": only the caller's tasks touched in the last N days. */
        involvedWithinDays?: number
        projectId?: string
      }
      if (params.involvedWithinDays !== undefined && params.involvedWithinDays !== null) {
        const { hasScope: checkScope } = await import("~/modules/permissions/permissions")
        if (!checkScope("projects:tasks:read", callerScopes ?? [])) {
          return envelopeError("forbidden", "Missing required scope: projects:tasks:read")
        }
        const { listRecentlyInvolvedTasks } = await import(
          "~/apps/projects/service/recently-involved"
        )
        const { ProjectsServiceError } = await import("~/apps/projects/service/statuses")
        try {
          const result = await listRecentlyInvolvedTasks({
            tx: txDb as never,
            orgId,
            userId,
            days: params.involvedWithinDays,
            projectId: params.projectId,
            query: params.query,
            limit: params.limit,
          })
          return JSON.stringify({
            items: result.items.map((t) => ({ type: "task" as const, ...t })),
            nextCursor: null,
            totalCount: result.totalCount,
            involvedWithinDays: result.days,
          })
        } catch (err) {
          if (err instanceof ProjectsServiceError) return envelopeError(err.code, err.message)
          throw err
        }
      }
      const { searchProjectsForTool } = await import("~/apps/projects/service/resolve")
      try {
        const result = await searchProjectsForTool(txDb as never, orgId, params)
        return JSON.stringify(result)
      } catch (err) {
        if ((err as Error).message === "invalid_cursor") throw new Error("invalid_cursor")
        throw err
      }
    },
    projects_get: async (paramsJson: string): Promise<string> => {
      if (appName !== "projects") {
        throw new Error("projects_get is only available to the projects app")
      }
      const params = JSON.parse(paramsJson || "{}") as {
        projectId?: string
        taskId?: string
        // The agent tool declares a single `id` ("project or task id"); accept it and resolve
        // project-or-task here (BL-108: the tool/RPC param drift was 422ing every agent `get(id)`).
        id?: string
      }
      const { loadProjectDetail } = await import("~/apps/projects/service/create-project")
      const { getTask } = await import("~/apps/projects/service/tasks")
      const { getChecklistStatus } = await import("~/apps/projects/service/checklist")
      const { hasScope: checkScope } = await import("~/modules/permissions/permissions")
      const { resolveTaskRef } = await import("~/apps/projects/service/resolve")
      const { parseTaskKey } = await import("~/apps/projects/service/task-key")
      const getTaskById = async (taskIdOrKey: string): Promise<string> => {
        if (!checkScope("projects:tasks:read", callerScopes ?? [])) {
          return envelopeError("forbidden", "Missing required scope: projects:tasks:read")
        }
        const taskId = await resolveTaskRef(txDb as never, orgId, taskIdOrKey)
        const task = await getTask({ tx: txDb as never, orgId, taskId, viewerId: userId })
        // Checklist summary beside the task, the same shape the REST detail carries.
        const checklist = await getChecklistStatus({ tx: txDb as never, orgId, taskId })
        return JSON.stringify({ ...task, checklist })
      }
      // Explicit projectId / taskId take precedence (back-compat); else resolve the single `id`.
      if (params.taskId && !params.projectId) return getTaskById(params.taskId)
      if (params.projectId && !params.taskId) {
        return JSON.stringify(await loadProjectDetail(txDb as never, orgId, params.projectId))
      }
      const single = params.id ?? params.projectId ?? params.taskId
      if (!single || (params.projectId && params.taskId)) throw new Error("invalid_params")
      // A task-key-shaped single id ("ERB-12") is unambiguously a task — no
      // point trying it as a project uuid first.
      if (parseTaskKey(single)) return getTaskById(single)
      // Try as a project; fall back to a task (the agent has one opaque id and need not know which).
      try {
        return JSON.stringify(await loadProjectDetail(txDb as never, orgId, single))
      } catch (err) {
        if ((err as Error).message === "project_not_found") return getTaskById(single)
        throw err
      }
    },
    // --- Task discussion ------------------------------------------------
    //
    // A task owns a discussion thread (`tasks.thread_id`) that the web task
    // detail renders, but nothing exposed it to an agent: there was no comment
    // verb on a task at all, and the thread id handed out by tasks_byProject
    // was unusable on its own — kernel threads are participant-gated and the
    // caller was never a participant, so threads_read answered "not a
    // participant" for a thread the caller could plainly see referenced.
    //
    // Both methods resolve the task through getTask with `viewerId`, which is
    // the SAME lazy enrolment the web detail pane relies on: reading the task
    // you are entitled to read makes you a participant of its discussion. That
    // is what makes the thread reachable afterwards, by these tools and by
    // kernel threads_read alike.
    projects_addComment: async (paramsJson: string): Promise<string> => {
      if (appName !== "projects") {
        throw new Error("projects_addComment is only available to the projects app")
      }
      const params = JSON.parse(paramsJson || "{}") as { taskId?: string; body?: string }
      const body = typeof params.body === "string" ? params.body.trim() : ""
      if (!params.taskId || !body) throw new Error("invalid_params")
      const { hasScope: checkScope } = await import("~/modules/permissions/permissions")
      if (!checkScope("projects:tasks:write", callerScopes ?? [])) {
        return envelopeError("forbidden", "Missing required scope: projects:tasks:write")
      }
      const { resolveTaskRef } = await import("~/apps/projects/service/resolve")
      const { postTaskComment } = await import("~/apps/projects/service/task-comment")
      const taskId = await resolveTaskRef(txDb as never, orgId, params.taskId)
      // Resolves AND enrols (getTask with viewerId inside the helper). A binned
      // task throws 404 there, which is right: you do not comment on something
      // that has been deleted. The body may quote whatever the calling turn
      // read, so it is tagged with that turn's taint by the same ladder every
      // other sandboxed write uses: never posted untagged, and refused
      // outright when the taint is unknowable.
      const posted = await postTaskComment(txDb as never, {
        orgId,
        userId,
        taskId,
        body,
        requiredScopes: knowledgeWriteRequiredScopes("projects_addComment"),
        ...(commentingAgentId ? { authorType: "agent" as const, agentId: commentingAgentId } : {}),
      })
      return JSON.stringify(posted)
    },
    projects_listComments: async (paramsJson: string): Promise<string> => {
      if (appName !== "projects") {
        throw new Error("projects_listComments is only available to the projects app")
      }
      const params = JSON.parse(paramsJson || "{}") as { taskId?: string; limit?: number }
      if (!params.taskId) throw new Error("invalid_params")
      const { hasScope: checkScope } = await import("~/modules/permissions/permissions")
      if (!checkScope("projects:tasks:read", callerScopes ?? [])) {
        return envelopeError("forbidden", "Missing required scope: projects:tasks:read")
      }
      const { getTask } = await import("~/apps/projects/service/tasks")
      const { resolveTaskRef } = await import("~/apps/projects/service/resolve")
      const { listMessages } = await import("~/modules/threads/message")
      const taskId = await resolveTaskRef(txDb as never, orgId, params.taskId)
      const task = await getTask({ tx: txDb as never, orgId, taskId, viewerId: userId })
      if (!task.threadId) return JSON.stringify({ taskId, threadId: null, messages: [] })
      const limit = Math.min(Math.max(Number(params.limit) || 50, 1), 200)
      // listMessages answers an ENVELOPE ({ messages, ... }), and null when the
      // viewer is not authorised for the thread — which should not happen here
      // (getTask above enrolled them) but must not become `messages: null`.
      const page = (await listMessages(txDb as never, {
        orgId,
        userId,
        threadId: task.threadId,
        limit,
      })) as { messages?: unknown[] } | null
      return JSON.stringify({
        taskId,
        taskKey: task.key,
        threadId: task.threadId,
        messages: Array.isArray(page?.messages) ? page.messages : [],
      })
    },
    projects_createProject: async (paramsJson: string): Promise<string> => {
      if (appName !== "projects") {
        throw new Error("projects_createProject is only available to the projects app")
      }
      const params = JSON.parse(paramsJson || "{}") as {
        name: string
        description?: string
        icon?: string
        color?: string
        key?: string
        group?: string | null
        statuses?: Array<{ label: string; color?: string | null; terminal?: boolean }>
        validationLevels?: Array<{ name: string }> | null
        checklistOnCards?: boolean
        tasks?: unknown
      }
      const { createProject, normalizeInitialTasks } = await import(
        "~/apps/projects/service/create-project"
      )
      const { setValidationLevels } = await import("~/apps/projects/service/checklist")
      const actor = await writeActor()
      const { validationLevels, tasks: rawTasks, ...input } = params
      const levels = Array.isArray(validationLevels) ? validationLevels : []
      // Checked before anything is written: a bad list creates no project.
      const initialTasks = normalizeInitialTasks(rawTasks)
      // One savepoint: an invalid level list, or a task that cannot be created
      // (an unknown assignee), leaves no half-configured project behind. One
      // approval of a held create is then the project and every task in it.
      const created = await txDb.transaction(async (stepTx) => {
        const project = await createProject({ tx: stepTx as never, orgId, actor, input })
        const saved =
          levels.length === 0
            ? project.validationLevels
            : await setValidationLevels({
                tx: stepTx as never,
                orgId,
                userId: actor.userId,
                projectId: project.id,
                levels,
              })
        const tasks: Array<{ id: string; key: string | null; title: string }> = []
        if (initialTasks.length > 0) {
          const { createTask } = await import("~/apps/projects/service/tasks")
          const { resolveAssignee } = await import("~/apps/projects/service/resolve")
          for (const task of initialTasks) {
            const assigneeId = await resolveAssignee(stepTx as never, orgId, task)
            const row = await createTask({
              tx: stepTx as never,
              orgId,
              actor,
              input: {
                projectId: project.id,
                title: task.title,
                ...(task.description !== undefined ? { description: task.description } : {}),
                assigneeId,
                createdByAgentLabel: await agentCreatorLabel(),
              },
            })
            tasks.push({ id: row.id, key: row.key ?? null, title: row.title })
          }
        }
        return {
          ...project,
          validationLevels: saved,
          ...(initialTasks.length > 0 ? { tasks, taskCount: tasks.length } : {}),
        }
      })
      return JSON.stringify(created)
    },
    projects_createTask: async (paramsJson: string): Promise<string> => {
      if (appName !== "projects") {
        throw new Error("projects_createTask is only available to the projects app")
      }
      const params = JSON.parse(paramsJson || "{}") as {
        projectId?: string
        projectName?: string
        title: string
        description?: string
        sourceUrl?: string | null
        statusId?: string
        statusLabel?: string | null
        parentTaskId?: string | null
        assigneeId?: string | null
        assigneeName?: string | null
        priority?: string
        dueDate?: string | null
        startDate?: string | null
        blocked?: boolean
        release?: string | null
        beforeTaskId?: string | null
        afterTaskId?: string | null
        /** Own label values: group name/id to value name/id. */
        labels?: Record<string, string | null>
      }
      return typedServiceCall(async () => {
        const { createTask, appendSourceCitation } = await import("~/apps/projects/service/tasks")
        const { resolveAssignee, resolveNewTaskProjectId, resolveTaskRef } = await import(
          "~/apps/projects/service/resolve"
        )
        const { ProjectsServiceError } = await import("~/apps/projects/service/statuses")
        // A parent KEY that names no task is a missing parent, the code createTask
        // gives an unknown parent id (and the one the agent was told to expect).
        const resolveParent = async (ref: string): Promise<string> => {
          try {
            return await resolveTaskRef(txDb as never, orgId, ref)
          } catch (err) {
            if (err instanceof ProjectsServiceError && err.code === "not_found") {
              throw new ProjectsServiceError(404, "parent_not_found", "parent task not found")
            }
            throw err
          }
        }
        const resolvedParentTaskId = params.parentTaskId
          ? await resolveParent(params.parentTaskId)
          : params.parentTaskId
        const resolvedBeforeTaskId = params.beforeTaskId
          ? await resolveTaskRef(txDb as never, orgId, params.beforeTaskId)
          : params.beforeTaskId
        const resolvedAfterTaskId = params.afterTaskId
          ? await resolveTaskRef(txDb as never, orgId, params.afterTaskId)
          : params.afterTaskId
        const actor = await writeActor()
        // A subtask named only by its parent belongs to the parent's project. Resolving it
        // as "the org's single active project" refused it as project_ambiguous on any org
        // with more than one board, though the parent already names the project.
        const parentProjectId =
          resolvedParentTaskId && !params.projectId && !params.projectName
            ? extractRows<{ project_id: string }>(
                await txDb.execute(drizzleSql`
                  SELECT project_id::text AS project_id
                  FROM ${drizzleSql.raw(schemaRef("app_projects"))}.tasks
                  WHERE id = ${resolvedParentTaskId}::uuid AND org_id = ${orgId}::uuid
                  LIMIT 1
                `),
              )[0]?.project_id
            : undefined
        if (resolvedParentTaskId && !params.projectId && !params.projectName && !parentProjectId) {
          throw new ProjectsServiceError(404, "parent_not_found", "parent task not found")
        }
        const projectId =
          parentProjectId ??
          (await resolveNewTaskProjectId(txDb as never, orgId, params, {
            threadId: bridgeOptions?.threadId ?? null,
          }))
        const assigneeId = await resolveAssignee(txDb as never, orgId, params)
        // A web-derived task must be self-contained AND cite its source in the BODY (a reviewer opens
        // the task, not the chat). The weak model reliably builds the body but drops the citation on
        // the 3rd/4th task of a fan-out (price/expression cited, connectivity/software not — the documented
        // competitive-teardown failure). `sourceUrl` makes citation a discrete, enforceable input per
        // task: the host appends a `Source: <url> (web-sourced — verify)` line so the URL ALWAYS lands
        // in the stored body, idempotently (never double-appended if the agent already inlined it).
        const description = appendSourceCitation(params.description, params.sourceUrl)
        // createTask's `createdBy` / `completedAt` / `allowInactiveAssignee` are
        // bulk-import (CLI) only: an app must not attribute a task to another
        // user, forge a completion time, or assign a deactivated account. The
        // params come from untrusted app JSON, so drop them before the spread.
        const {
          createdBy: _createdBy,
          completedAt: _completedAt,
          allowInactiveAssignee: _allowInactiveAssignee,
          createdByAgentLabel: _createdByAgentLabel,
          ...appParams
        } = params as typeof params & {
          createdBy?: unknown
          completedAt?: unknown
          allowInactiveAssignee?: unknown
          createdByAgentLabel?: unknown
        }
        return JSON.stringify(
          await createTask({
            tx: txDb as never,
            orgId,
            actor,
            input: {
              ...appParams,
              description,
              projectId,
              assigneeId,
              parentTaskId: resolvedParentTaskId,
              beforeTaskId: resolvedBeforeTaskId,
              afterTaskId: resolvedAfterTaskId,
              createdByAgentLabel: await agentCreatorLabel(),
            },
          }),
        )
      })
    },
    projects_updateTask: async (paramsJson: string): Promise<string> => {
      if (appName !== "projects") {
        throw new Error("projects_updateTask is only available to the projects app")
      }
      const params = JSON.parse(paramsJson || "{}") as {
        taskId: string
        title?: string
        description?: string | null
        statusId?: string
        statusLabel?: string | null
        assigneeId?: string | null
        assigneeName?: string | null
        priority?: string
        dueDate?: string | null
        startDate?: string | null
        blocked?: boolean
        release?: string | null
        parentTaskId?: string | null
        /** Own label values: group name/id to value name/id, null clears. */
        labels?: Record<string, string | null>
      }
      return typedServiceCall(async () => {
        const { updateTask, getTask } = await import("~/apps/projects/service/tasks")
        const { moveTask } = await import("~/apps/projects/service/move-task")
        const { resolveAssignee, resolveTaskRef } = await import("~/apps/projects/service/resolve")
        const resolvedTaskId = await resolveTaskRef(txDb as never, orgId, params.taskId ?? "")
        const resolvedParentTaskId = params.parentTaskId
          ? await resolveTaskRef(txDb as never, orgId, params.parentTaskId)
          : params.parentTaskId
        const actor = await writeActor()
        const { assigneeName, ...rest } = params
        const taskId = resolvedTaskId
        const parentTaskId = resolvedParentTaskId
        delete (rest as { taskId?: unknown }).taskId
        delete (rest as { parentTaskId?: unknown }).parentTaskId
        const hasParentReparent = "parentTaskId" in params
        const input: Record<string, unknown> = { ...rest }
        if (assigneeName !== undefined || params.assigneeId !== undefined) {
          input.assigneeId = await resolveAssignee(txDb as never, orgId, params)
        }
        return withChecklistWarning(taskId, async () => {
          if (hasParentReparent) {
            await moveTask({
              tx: txDb as never,
              orgId,
              actor,
              taskId,
              parentTaskId: parentTaskId ?? null,
            })
          }
          const hasOtherUpdates = Object.keys(input).length > 0
          if (hasOtherUpdates) {
            return updateTask({ tx: txDb as never, orgId, actor, taskId, input: input as never })
          }
          return getTask({ tx: txDb as never, orgId, taskId })
        })
      })
    },
    projects_moveTask: async (paramsJson: string): Promise<string> => {
      if (appName !== "projects") {
        throw new Error("projects_moveTask is only available to the projects app")
      }
      const params = JSON.parse(paramsJson || "{}") as {
        taskId: string
        projectId?: string
        parentTaskId?: string | null
        statusId?: string
        beforeTaskId?: string | null
        afterTaskId?: string | null
      }
      const { moveTask } = await import("~/apps/projects/service/move-task")
      const { resolveTaskRef } = await import("~/apps/projects/service/resolve")
      const resolvedTaskId = await resolveTaskRef(txDb as never, orgId, params.taskId ?? "")
      const resolvedParentTaskId = params.parentTaskId
        ? await resolveTaskRef(txDb as never, orgId, params.parentTaskId)
        : params.parentTaskId
      const resolvedBeforeTaskId = params.beforeTaskId
        ? await resolveTaskRef(txDb as never, orgId, params.beforeTaskId)
        : params.beforeTaskId
      const resolvedAfterTaskId = params.afterTaskId
        ? await resolveTaskRef(txDb as never, orgId, params.afterTaskId)
        : params.afterTaskId
      const actor =
        inheritedActor.actorType === "user"
          ? inheritedActor
          : {
              actorType: "user" as const,
              userId,
              orgId,
              scopes: callerScopes ?? [],
              dimensionGrants: {},
            }
      return withChecklistWarning(resolvedTaskId, () =>
        moveTask({
          tx: txDb as never,
          orgId,
          actor,
          taskId: resolvedTaskId,
          // The agent tool's `projectId` is a DESTINATION (move this task to project
          // X) — map it to the service's `targetProjectId`. The boundary-assertion
          // `projectId` is REST-route-only.
          targetProjectId: params.projectId,
          parentTaskId: resolvedParentTaskId,
          statusId: params.statusId,
          beforeTaskId: resolvedBeforeTaskId,
          afterTaskId: resolvedAfterTaskId,
        }),
      )
    },
    projects_addStatus: async (paramsJson: string): Promise<string> => {
      if (appName !== "projects") {
        throw new Error("projects_addStatus is only available to the projects app")
      }
      const params = JSON.parse(paramsJson || "{}") as {
        projectId?: string
        projectName?: string
        label: string
        color?: string | null
        terminal?: boolean
        afterStatusId?: string
      }
      return typedServiceCall(async () => {
        const { addStatus } = await import("~/apps/projects/service/statuses")
        const { resolveProjectId } = await import("~/apps/projects/service/resolve")
        const actor = await writeActor()
        const projectId = await resolveProjectId(txDb as never, orgId, params)
        return JSON.stringify(
          await addStatus({
            tx: txDb as never,
            orgId,
            projectId,
            actor,
            input: {
              label: params.label,
              color: params.color,
              terminal: params.terminal,
              afterStatusId: params.afterStatusId,
            },
          }),
        )
      })
    },
    projects_updateStatus: async (paramsJson: string): Promise<string> => {
      if (appName !== "projects") {
        throw new Error("projects_updateStatus is only available to the projects app")
      }
      const params = JSON.parse(paramsJson || "{}") as {
        projectId?: string
        projectName?: string
        statusId?: string
        statusLabel?: string
        label?: string
        color?: string | null
        terminal?: boolean
      }
      return typedServiceCall(async () => {
        const { updateStatus } = await import("~/apps/projects/service/statuses")
        const { assertProjectExists, resolveProjectId, resolveStatusRef } = await import(
          "~/apps/projects/service/resolve"
        )
        const actor = await writeActor()
        const projectId = await resolveProjectId(txDb as never, orgId, params)
        // An unknown project id is `not_found`, not a `status_not_found` against
        // an empty column list.
        await assertProjectExists(txDb as never, orgId, projectId)
        const statusId = await resolveStatusRef(txDb as never, orgId, projectId, params)
        return JSON.stringify(
          await updateStatus({
            tx: txDb as never,
            orgId,
            projectId,
            statusId,
            actor,
            patch: { label: params.label, color: params.color, terminal: params.terminal },
          }),
        )
      })
    },
    projects_updateProject: async (paramsJson: string): Promise<string> => {
      if (appName !== "projects") {
        throw new Error("projects_updateProject is only available to the projects app")
      }
      const params = JSON.parse(paramsJson || "{}") as {
        projectId?: string
        projectName?: string
        name?: string
        description?: string | null
        icon?: string | null
        color?: string | null
        key?: string
        group?: string | null
      }
      return typedServiceCall(async () => {
        const { updateProject } = await import("~/apps/projects/service/update-project")
        const { assertProjectExists, resolveProjectId } = await import(
          "~/apps/projects/service/resolve"
        )
        const actor = await writeActor()
        const projectId = await resolveProjectId(txDb as never, orgId, params)
        await assertProjectExists(txDb as never, orgId, projectId)
        return JSON.stringify(
          await updateProject({
            tx: txDb as never,
            orgId,
            projectId,
            actor,
            actorType: actorKind === "agent" ? "agent" : "user",
            patch: {
              name: params.name,
              description: params.description,
              icon: params.icon,
              color: params.color,
              key: params.key,
              group: params.group,
            },
          }),
        )
      })
    },
    projects_deleteStatus: async (paramsJson: string): Promise<string> => {
      if (appName !== "projects") {
        throw new Error("projects_deleteStatus is only available to the projects app")
      }
      const params = JSON.parse(paramsJson || "{}") as {
        projectId?: string
        projectName?: string
        statusId?: string
        statusLabel?: string
      }
      const { deleteStatus } = await import("~/apps/projects/service/statuses")
      const { resolveProjectId, resolveStatusRef } = await import("~/apps/projects/service/resolve")
      const actor = await writeActor()
      const projectId = await resolveProjectId(txDb as never, orgId, params)
      const statusId = await resolveStatusRef(txDb as never, orgId, projectId, params)
      return JSON.stringify(
        await deleteStatus({ tx: txDb as never, orgId, projectId, statusId, actor }),
      )
    },
    projects_tasksByAssignee: async (paramsJson: string): Promise<string> => {
      if (appName !== "projects") {
        throw new Error("projects_tasksByAssignee is only available to the projects app")
      }
      const { hasScope: checkScope } = await import("~/modules/permissions/permissions")
      if (!checkScope("projects:tasks:read", callerScopes ?? [])) {
        return envelopeError("forbidden", "Missing required scope: projects:tasks:read")
      }
      const params = JSON.parse(paramsJson || "{}") as {
        assigneeId?: string
        due?: "overdue" | "due_soon" | "later" | "none" | "this_week"
        statusId?: string
        terminal?: boolean
        release?: string
      }
      if (!params.assigneeId) throw new Error("invalid_params: assigneeId required")
      const { listTasksAcrossProjects } = await import("~/apps/projects/service/tasks")
      return JSON.stringify(
        await listTasksAcrossProjects({
          tx: txDb as never,
          orgId,
          assigneeId: params.assigneeId,
          due: params.due,
          statusId: params.statusId,
          terminal: params.terminal,
          release: params.release,
        }),
      )
    },
    // BL-151: enumerate the tasks in ONE project (digest/backlog routines + launch-from-template).
    projects_tasksByProject: async (paramsJson: string): Promise<string> => {
      if (appName !== "projects") {
        throw new Error("projects_tasksByProject is only available to the projects app")
      }
      const { hasScope: checkScope } = await import("~/modules/permissions/permissions")
      if (!checkScope("projects:tasks:read", callerScopes ?? [])) {
        return envelopeError("forbidden", "Missing required scope: projects:tasks:read")
      }
      const params = JSON.parse(paramsJson || "{}") as {
        projectId?: string
        statusId?: string
        terminal?: boolean
        due?: "overdue" | "due_soon" | "later" | "none" | "this_week"
        limit?: number
        countOnly?: boolean
        release?: string
        /** Effective-label filter: group to value, or "__none__". */
        labels?: Record<string, string>
        /** Completion window: inclusive start, exclusive end (ISO-8601). */
        completedAfter?: string
        completedBefore?: string
      }
      if (!params.projectId) throw new Error("invalid_params: projectId required")
      const projectId = params.projectId
      const { listProjectTasks } = await import("~/apps/projects/service/tasks")
      // A label or window refusal (label_not_found, invalid_params) answers a
      // typed envelope instead of an opaque tool_error.
      return typedCall(() =>
        listProjectTasks({
          tx: txDb as never,
          orgId,
          projectId,
          statusId: params.statusId,
          terminal: params.terminal,
          due: params.due,
          limit: params.limit,
          countOnly: params.countOnly,
          release: params.release,
          labels: params.labels,
          completedAfter: params.completedAfter,
          completedBefore: params.completedBefore,
        }),
      )
    },
    // task label taxonomy. Reads answer through typedCall (typed
    // envelope on a refusal); writes run in their own savepoint through
    // typedServiceCall, so a refusal leaves nothing behind.
    projects_labelsList: async (paramsJson: string): Promise<string> => {
      if (appName !== "projects") {
        throw new Error("projects_labelsList is only available to the projects app")
      }
      const params = JSON.parse(paramsJson || "{}") as { includeArchived?: boolean }
      const { listLabels } = await import("~/apps/projects/service/labels")
      return typedCall(() =>
        listLabels({ tx: txDb as never, orgId, includeArchived: params.includeArchived === true }),
      )
    },
    projects_labelsTree: async (_paramsJson: string): Promise<string> => {
      if (appName !== "projects") {
        throw new Error("projects_labelsTree is only available to the projects app")
      }
      const { labelsTree } = await import("~/apps/projects/service/labels")
      return typedCall(() => labelsTree({ tx: txDb as never, orgId }))
    },
    projects_labelsCreate: async (paramsJson: string): Promise<string> => {
      if (appName !== "projects") {
        throw new Error("projects_labelsCreate is only available to the projects app")
      }
      const params = JSON.parse(paramsJson || "{}") as {
        name?: unknown
        parentId?: string | null
        sortOrder?: number
      }
      return typedServiceCall(async () => {
        const { createLabel } = await import("~/apps/projects/service/labels")
        const actor = await writeActor()
        return JSON.stringify(
          await createLabel({
            tx: txDb as never,
            orgId,
            actor,
            input: { name: params.name, parentId: params.parentId, sortOrder: params.sortOrder },
          }),
        )
      })
    },
    projects_labelsUpdate: async (paramsJson: string): Promise<string> => {
      if (appName !== "projects") {
        throw new Error("projects_labelsUpdate is only available to the projects app")
      }
      const params = JSON.parse(paramsJson || "{}") as {
        id: string
        name?: unknown
        sortOrder?: number
        parentId?: string | null
      }
      return typedServiceCall(async () => {
        const { updateLabel } = await import("~/apps/projects/service/labels")
        const actor = await writeActor()
        return JSON.stringify(await updateLabel({ tx: txDb as never, orgId, actor, input: params }))
      })
    },
    projects_labelsArchive: async (paramsJson: string): Promise<string> => {
      if (appName !== "projects") {
        throw new Error("projects_labelsArchive is only available to the projects app")
      }
      const params = JSON.parse(paramsJson || "{}") as { id: string; archived?: boolean }
      return typedServiceCall(async () => {
        const { archiveLabel } = await import("~/apps/projects/service/labels")
        const actor = await writeActor()
        return JSON.stringify(
          await archiveLabel({
            tx: txDb as never,
            orgId,
            actor,
            input: { id: params.id, archived: params.archived },
          }),
        )
      })
    },
    projects_labelsReorder: async (paramsJson: string): Promise<string> => {
      if (appName !== "projects") {
        throw new Error("projects_labelsReorder is only available to the projects app")
      }
      const params = JSON.parse(paramsJson || "{}") as { baseVersion?: unknown; nodes?: unknown }
      return typedServiceCall(async () => {
        const { reorderLabels } = await import("~/apps/projects/service/labels")
        const actor = await writeActor()
        return JSON.stringify(
          await reorderLabels({
            tx: txDb as never,
            orgId,
            actor,
            input: { baseVersion: params.baseVersion ?? null, nodes: params.nodes },
          }),
        )
      })
    },
    // BL-263: bounded PORTFOLIO ROLLUP across active projects — per-project
    // {done, remaining, overdue, %done, biggest-at-risk} in one aggregate read.
    projects_portfolioRollup: async (paramsJson: string): Promise<string> => {
      if (appName !== "projects") {
        throw new Error("projects_portfolioRollup is only available to the projects app")
      }
      const { hasScope: checkScope } = await import("~/modules/permissions/permissions")
      if (!checkScope("projects:tasks:read", callerScopes ?? [])) {
        return envelopeError("forbidden", "Missing required scope: projects:tasks:read")
      }
      const params = JSON.parse(paramsJson || "{}") as {
        limit?: number
        includeArchived?: boolean
      }
      const { portfolioRollup } = await import("~/apps/projects/service/tasks")
      return JSON.stringify(
        await portfolioRollup({
          tx: txDb as never,
          orgId,
          limit: params.limit,
          includeArchived: params.includeArchived,
        }),
      )
    },
    projects_deleteTask: async (paramsJson: string): Promise<string> => {
      if (appName !== "projects") {
        throw new Error("projects_deleteTask is only available to the projects app")
      }
      const params = JSON.parse(paramsJson || "{}") as { taskId?: string }
      if (!params.taskId) throw new Error("invalid_params: taskId required")
      const { deleteTask } = await import("~/apps/projects/service/tasks")
      const { resolveTaskRef } = await import("~/apps/projects/service/resolve")
      const resolvedTaskId = await resolveTaskRef(txDb as never, orgId, params.taskId)
      const actor =
        inheritedActor.actorType === "user"
          ? inheritedActor
          : {
              actorType: "user" as const,
              userId,
              orgId,
              scopes: callerScopes ?? [],
              dimensionGrants: {},
            }
      await deleteTask({ tx: txDb as never, orgId, actor, taskId: resolvedTaskId })
      return JSON.stringify({ taskId: resolvedTaskId, deleted: true })
    },
    projects_mergeTasks: async (paramsJson: string): Promise<string> => {
      if (appName !== "projects") {
        throw new Error("projects_mergeTasks is only available to the projects app")
      }
      const params = JSON.parse(paramsJson || "{}") as { sourceId?: string; targetId?: string }
      if (!params.sourceId || !params.targetId) {
        throw new Error("invalid_params: sourceId and targetId required")
      }
      const { mergeTasks } = await import("~/apps/projects/service/tasks")
      const { resolveTaskRef } = await import("~/apps/projects/service/resolve")
      const resolvedSourceId = await resolveTaskRef(txDb as never, orgId, params.sourceId)
      const resolvedTargetId = await resolveTaskRef(txDb as never, orgId, params.targetId)
      const actor =
        inheritedActor.actorType === "user"
          ? inheritedActor
          : {
              actorType: "user" as const,
              userId,
              orgId,
              scopes: callerScopes ?? [],
              dimensionGrants: {},
            }
      await mergeTasks({
        tx: txDb as never,
        orgId,
        actor,
        sourceId: resolvedSourceId,
        targetId: resolvedTargetId,
      })
      return JSON.stringify({
        sourceId: resolvedSourceId,
        targetId: resolvedTargetId,
        merged: true,
      })
    },
    projects_instantiateTemplate: async (paramsJson: string): Promise<string> => {
      if (appName !== "projects") {
        throw new Error("projects_instantiateTemplate is only available to the projects app")
      }
      const params = JSON.parse(paramsJson || "{}") as { templateId?: string; projectName?: string }
      if (!params.templateId || !params.projectName) {
        throw new Error("invalid_params: templateId and projectName required")
      }
      const { instantiateTemplate } = await import("~/apps/projects/service/tasks")
      const actor =
        inheritedActor.actorType === "user"
          ? inheritedActor
          : {
              actorType: "user" as const,
              userId,
              orgId,
              scopes: callerScopes ?? [],
              dimensionGrants: {},
            }
      return JSON.stringify(
        await instantiateTemplate({
          tx: txDb as never,
          orgId,
          actor,
          templateId: params.templateId,
          projectName: params.projectName,
        }),
      )
    },
    projects_addDependency: async (paramsJson: string): Promise<string> => {
      if (appName !== "projects") {
        throw new Error("projects_addDependency is only available to the projects app")
      }
      const params = JSON.parse(paramsJson || "{}") as {
        taskId?: string
        dependsOnTaskId?: string
        type?: "blocks" | "relates"
      }
      if (!params.taskId || !params.dependsOnTaskId) {
        throw new Error("invalid_params: taskId and dependsOnTaskId required")
      }
      const { addDependency } = await import("~/apps/projects/service/tasks")
      const { resolveTaskRef } = await import("~/apps/projects/service/resolve")
      const resolvedTaskId = await resolveTaskRef(txDb as never, orgId, params.taskId)
      const resolvedDependsOnTaskId = await resolveTaskRef(
        txDb as never,
        orgId,
        params.dependsOnTaskId,
      )
      const actor =
        inheritedActor.actorType === "user"
          ? inheritedActor
          : {
              actorType: "user" as const,
              userId,
              orgId,
              scopes: callerScopes ?? [],
              dimensionGrants: {},
            }
      await addDependency({
        tx: txDb as never,
        orgId,
        actor,
        taskId: resolvedTaskId,
        dependsOnTaskId: resolvedDependsOnTaskId,
        type: params.type,
      })
      return JSON.stringify({ taskId: resolvedTaskId, dependsOnTaskId: resolvedDependsOnTaskId })
    },
    // Read-only: resolve an assignee reference exactly as createTask/updateTask will, so the
    // gated-tool preflight refuses an unresolvable name at STAGING instead of the approver
    // hitting "no user with that name" on approve. Answers `{ id }` or `{ error }`, never throws
    // on a resolution miss (the preflight fails open on a throw).
    projects_resolveAssignee: async (paramsJson: string): Promise<string> => {
      if (appName !== "projects") {
        throw new Error("projects_resolveAssignee is only available to the projects app")
      }
      const params = JSON.parse(paramsJson || "{}") as {
        assigneeId?: string | null
        assigneeName?: string | null
      }
      const { resolveAssignee } = await import("~/apps/projects/service/resolve")
      const { ProjectsServiceError } = await import("~/apps/projects/service/statuses")
      try {
        return JSON.stringify({ id: await resolveAssignee(txDb as never, orgId, params) })
      } catch (err) {
        if (err instanceof ProjectsServiceError) {
          return JSON.stringify({
            error: { code: err.code, message: err.message, details: err.details ?? null },
          })
        }
        throw err
      }
    },
    // --- Checklist ---------------------------------------------------------
    //
    // Every write states the actor kind derived from the dispatch origin above.
    // A service refusal (ProjectsServiceError) answers a typed `{ error }`
    // envelope with its code and status instead of a flattened message, and the
    // write runs in its own savepoint so a refusal leaves nothing behind.
    projects_checklistGet: async (paramsJson: string): Promise<string> => {
      if (appName !== "projects") {
        throw new Error("projects_checklistGet is only available to the projects app")
      }
      const params = JSON.parse(paramsJson || "{}") as { taskId?: string }
      if (!params.taskId) throw new Error("invalid_params: taskId required")
      const { hasScope: checkScope } = await import("~/modules/permissions/permissions")
      if (!checkScope("projects:tasks:read", callerScopes ?? [])) {
        return envelopeError("forbidden", "Missing required scope: projects:tasks:read")
      }
      const { listChecklist } = await import("~/apps/projects/service/checklist")
      return typedCall(async () => {
        const taskId = await resolveTask(params.taskId!)
        return { taskId, ...(await listChecklist({ tx: txDb as never, orgId, taskId })) }
      })
    },
    projects_checklistAddItems: async (paramsJson: string): Promise<string> => {
      if (appName !== "projects") {
        throw new Error("projects_checklistAddItems is only available to the projects app")
      }
      const params = JSON.parse(paramsJson || "{}") as {
        taskId?: string
        items?: { title: string; details?: string | null }[]
      }
      if (!params.taskId) throw new Error("invalid_params: taskId required")
      const { addItems } = await import("~/apps/projects/service/checklist")
      return checklistWrite(async (stepTx) => {
        const taskId = await resolveTask(params.taskId!)
        const items = await addItems({
          tx: stepTx,
          orgId,
          userId,
          actorKind,
          taskId,
          items: params.items ?? [],
        })
        return { taskId, items }
      })
    },
    projects_checklistUpdateItem: async (paramsJson: string): Promise<string> => {
      if (appName !== "projects") {
        throw new Error("projects_checklistUpdateItem is only available to the projects app")
      }
      const params = JSON.parse(paramsJson || "{}") as {
        itemId?: string
        title?: string
        details?: string | null
        beforeItemId?: string | null
        afterItemId?: string | null
      }
      if (!params.itemId) throw new Error("invalid_params: itemId required")
      const { updateItem } = await import("~/apps/projects/service/checklist")
      return checklistWrite((stepTx) =>
        updateItem({
          tx: stepTx,
          orgId,
          userId,
          actorKind,
          itemId: params.itemId!,
          patch: {
            title: params.title,
            details: params.details,
            beforeItemId: params.beforeItemId,
            afterItemId: params.afterItemId,
          },
        }),
      )
    },
    projects_checklistSetValidation: async (paramsJson: string): Promise<string> => {
      if (appName !== "projects") {
        throw new Error("projects_checklistSetValidation is only available to the projects app")
      }
      const params = JSON.parse(paramsJson || "{}") as {
        itemId?: string
        level?: string
        state?: "not_done" | "fail" | "success" | "na"
        note?: string | null
        source?: string | null
        entries?: {
          itemId: string
          level: string
          state: "not_done" | "fail" | "success" | "na"
          note?: string | null
          source?: string | null
        }[]
      }
      const entries = Array.isArray(params.entries)
        ? params.entries
        : params.itemId
          ? [
              {
                itemId: params.itemId,
                level: params.level ?? "",
                state: params.state ?? ("" as never),
                note: params.note,
                source: params.source,
              },
            ]
          : []
      const { setValidations } = await import("~/apps/projects/service/checklist")
      return checklistWrite(async (stepTx) => ({
        items: await setValidations({
          tx: stepTx,
          orgId,
          userId,
          actorKind,
          agentId: commentingAgentId,
          entries,
          // A note becomes a task comment that may quote what this turn read:
          // tagged with the turn's taint, like projects_addComment.
          commentRequiredScopes: knowledgeWriteRequiredScopes("projects_checklistSetValidation"),
        }),
      }))
    },
    projects_checklistRemoveItem: async (paramsJson: string): Promise<string> => {
      if (appName !== "projects") {
        throw new Error("projects_checklistRemoveItem is only available to the projects app")
      }
      const params = JSON.parse(paramsJson || "{}") as { itemId?: string }
      if (!params.itemId) throw new Error("invalid_params: itemId required")
      const { removeItem } = await import("~/apps/projects/service/checklist")
      return checklistWrite(async (stepTx) => ({
        ...(await removeItem({ tx: stepTx, orgId, userId, actorKind, itemId: params.itemId! })),
        removed: true,
      }))
    },
    projects_attentionItems: async (paramsJson: string): Promise<string> => {
      if (appName !== "projects") {
        throw new Error("projects_attentionItems is only available to the projects app")
      }
      const { computeAttentionItems } = await import("~/apps/projects/attention")
      // Someone else's tasks only for a person the caller stands in for today, read again
      // here: a caller naming anyone else gets their own tasks alone.
      const asked = (JSON.parse(paramsJson || "{}") as { forUserIds?: unknown }).forUserIds
      let forUserIds: string[] = []
      if (Array.isArray(asked) && asked.length > 0) {
        const { readStandingInFor } = await import("~/modules/approvals/route-world")
        const standing = new Set(await readStandingInFor(txDb as never, orgId, userId))
        forUserIds = asked.filter((id): id is string => typeof id === "string" && standing.has(id))
      }
      return JSON.stringify(await computeAttentionItems(txDb as never, orgId, userId, forUserIds))
    },
  }
}
