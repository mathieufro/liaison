// SPDX-License-Identifier: FSL-1.1-ALv2

import { sql as drizzleSql } from "drizzle-orm"
import type { TransitionActor } from "~/apps/projects/service/transitions"
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
   * The routine whose run made this call signs the comments it posts ("Routine <title>"), as it
   * signs its messages and Home items: its owner's agent did not write them. Null when no routine
   * acted. Resolved once per bridge.
   */
  let routineCommentLabelMemo: Promise<string | null> | undefined
  const routineCommentLabel = (): Promise<string | null> => {
    routineCommentLabelMemo ??= (async () => {
      if (actorKind !== "agent") return null
      const routineId = bridgeRoutineId ?? approvalContext?.originRoutineId
      if (!routineId) return null
      const { routineAuthorLabel } = await import("~/modules/agent/routines/routine-report")
      return routineAuthorLabel(orgId, routineId)
    })()
    return routineCommentLabelMemo
  }
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
   * An approved re-entry runs in no sub-run frame, so whether a person was behind the turn
   * that asked is read from the approval itself (`metadata.originHasPerson`). Outside an
   * approval this is false.
   */
  const approvedWithoutPerson = async (): Promise<boolean> => {
    const id = approvalContext?.approvalRequestId
    if (!id) return false
    const { approvalOriginHadPerson } = await import("~/modules/bug-reports/service")
    return !(await approvalOriginHadPerson(orgId, id))
  }
  /**
   * Turning time and budgets on or off is a person's own act: from a routine tick, a
   * sub-run or a job it is refused `human_turn_only`, before anything is written. Only
   * the `timeBudgets` argument is held to it; the rest of the call is not.
   */
  const timeBudgetsPlaceRefusal = async (timeBudgets: unknown): Promise<string | null> => {
    if (timeBudgets === undefined) return null
    const { HUMAN_TURN_ONLY_CODE, humanTurnOnlyAllows } = await import(
      "~/modules/apps/execute-tool"
    )
    const { currentRunContext } = await import("~/modules/agent/runtime/run-context")
    const origin = (bridgeOptions?.origin ?? "system") as Parameters<typeof humanTurnOnlyAllows>[0]
    const fromRoutine = Boolean(bridgeRoutineId ?? approvalContext?.originRoutineId)
    if (
      !fromRoutine &&
      !(await approvedWithoutPerson()) &&
      humanTurnOnlyAllows(origin, currentRunContext())
    )
      return null
    return JSON.stringify({
      error: {
        code: HUMAN_TURN_ONLY_CODE,
        message:
          "Time and budgets was not turned on or off and nothing changed: only a person turns it, in their own chat, in the app or from their own coding agent, never a routine, a sub-run or a job.",
        status: 409,
        retryable: false,
        details: {
          next: "Tell the person: they ask for it themselves, in their chat with the agent or on the project's edit form.",
        },
      },
    })
  }
  /**
   * The switch's keys on a project result: `timeBudgets` and `timeBudgetsNote` when the call
   * passed `timeBudgets` or the org uses it, otherwise neither. The first project of the org
   * turned on adds the notice for the team and when the tools arrive.
   */
  const withTimeBudgetsNote = async (
    detail: { id: string; name: string; timeBudgets?: boolean } & Record<string, unknown>,
    passed: boolean,
    flipped: "on" | "off" | undefined,
  ): Promise<Record<string, unknown>> => {
    const { orgUsesTimeBudgets } = await import("~/apps/projects/service/planning")
    if (!passed && !orgUsesTimeBudgets(orgId)) {
      const {
        timeBudgets: _t,
        timeBudgetsChangedAt: _a,
        timeBudgetsChangedBy: _b,
        ...rest
      } = detail
      return rest
    }
    const on = detail.timeBudgets === true
    let note: string
    if (flipped === "on") {
      note = `Time and budgets is now on for ${detail.name}: planned time, time spent and its budget can be recorded on it.`
      const { activeMemberCount, anotherProjectUsesTime, firstOnNotice, NEXT_MESSAGE_LINE } =
        await import("~/apps/projects/service/time-feature")
      if (!(await anotherProjectUsesTime(orgId, detail.id))) {
        note = `${note} ${firstOnNotice(await activeMemberCount(orgId))} ${NEXT_MESSAGE_LINE}`
      }
    } else if (flipped === "off") {
      note = `Time and budgets is now off for ${detail.name}: its time and budget rows are kept, and nothing counts them until it is turned on again.`
    } else if (passed) {
      note = `Time and budgets was already ${on ? "on" : "off"} for ${detail.name}; nothing changed.`
    } else {
      note = on
        ? `${detail.name} uses time and budgets.`
        : `${detail.name} does not use time and budgets.`
    }
    return { ...detail, timeBudgets: on, timeBudgetsNote: note }
  }
  /**
   * A task's timebox and milestone flag, then its time keys: present only on a project using
   * time and budgets. A timebox on a project that does not use it refuses `planning_off`.
   */
  const taskPlanKeys = async (
    taskId: string,
    timebox: string | null | undefined,
    isMilestone: boolean | undefined,
  ): Promise<Record<string, unknown>> => {
    const { taskTimeKeys, writeTaskPlan } = await import("~/apps/projects/service/time-plan")
    const keys =
      timebox !== undefined || isMilestone !== undefined
        ? await writeTaskPlan({
            tx: txDb,
            orgId,
            taskId,
            scopes: callerScopes ?? [],
            patch: {
              ...(timebox !== undefined ? { timebox } : {}),
              ...(isMilestone !== undefined ? { isMilestone } : {}),
            },
          })
        : await taskTimeKeys(txDb, orgId, taskId)
    return {
      ...(keys ?? {}),
      ...(isMilestone !== undefined ? { isMilestone } : {}),
    }
  }
  /** Where a Took call comes from, for the person-statement rule. */
  const tookPlace = async () => {
    const { currentRunContext } = await import("~/modules/agent/runtime/run-context")
    const frame = currentRunContext()
    const origin = (bridgeOptions?.origin ??
      "system") as import("~/apps/projects/service/took").TookOrigin
    const routineId = bridgeRoutineId ?? approvalContext?.originRoutineId
    return {
      origin,
      frame: {
        ...(routineId ? { routineId } : {}),
        ...(frame?.background || (await approvedWithoutPerson()) ? { background: true } : {}),
        ...(frame?.mcpGateway ? { mcpGateway: true } : {}),
        ...(frame?.agentId ? { agentId: frame.agentId } : {}),
      },
      actingAgentId: origin === "mcp" ? (bridgeActingAgentId ?? null) : null,
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
  /**
   * Who changes a task's status through this bridge, for its transition: the routine whose tick
   * acted, else the agent, else the person in the app. The run frame is gone in a bridge call,
   * so the service cannot read it itself.
   */
  const transitionVia = async (): Promise<TransitionActor> => {
    const person = await writeActor()
    const routineId =
      actorKind === "agent" ? (bridgeRoutineId ?? approvalContext?.originRoutineId ?? null) : null
    const agentId = actorKind === "agent" ? (bridgeActingAgentId ?? null) : null
    return {
      type: routineId ? "routine" : actorKind === "agent" ? "agent" : "user",
      userId: person.userId,
      agentId,
      routineId,
    }
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
    /** Rows for a company's or a contact's timeline, read under the caller's row security. */
    projects_activityRead: async (paramsJson: string): Promise<string> => {
      if (ctx.appName !== "projects")
        throw new Error("projects_activityRead is only available to the projects app")
      const { hasScope } = await import("~/modules/permissions/permissions")
      if (!hasScope("projects:tasks:read", ctx.callerScopes ?? [])) {
        throw new Error("forbidden: missing scope projects:tasks:read")
      }
      const { projectActivityRows } = await import("~/apps/projects/service/activity")
      const { withReadOnlySource } = await import("~/modules/contacts/activity")
      const params = JSON.parse(paramsJson)
      return JSON.stringify(
        await withReadOnlySource(ctx.txDb as never, (tx) =>
          projectActivityRows(tx, ctx.orgId, params),
        ),
      )
    },
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
        kind?: "project" | "task"
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
        const { ProjectsServiceError } = await import("~/apps/projects/service/statuses")
        if (err instanceof ProjectsServiceError) return envelopeError(err.code, err.message)
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
        // The latest status changes (time in status is `statusEnteredAt`).
        const { listTaskTransitions } = await import("~/apps/projects/service/transitions")
        const transitions = await listTaskTransitions(txDb as never, orgId, taskId)
        return JSON.stringify({ ...task, checklist, transitions })
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
      const routineLabel = await routineCommentLabel()
      const posted = await postTaskComment(txDb as never, {
        orgId,
        userId,
        taskId,
        body,
        requiredScopes: knowledgeWriteRequiredScopes("projects_addComment"),
        ...(commentingAgentId || routineLabel
          ? {
              authorType: "agent" as const,
              ...(commentingAgentId ? { agentId: commentingAgentId } : {}),
              ...(routineLabel ? { agentAuthorLabel: routineLabel } : {}),
            }
          : {}),
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
        /** Task field definitions (the dashboard column shape). */
        fields?: unknown
        tasks?: unknown
        companyId?: string | null
        timeBudgets?: boolean
      }
      const placeRefusal = await timeBudgetsPlaceRefusal(params.timeBudgets)
      if (placeRefusal) return placeRefusal
      const { createProject, normalizeInitialTasks } = await import(
        "~/apps/projects/service/create-project"
      )
      const { setValidationLevels } = await import("~/apps/projects/service/checklist")
      const actor = await writeActor()
      const { validationLevels, tasks: rawTasks, companyId, timeBudgets, ...input } = params
      const levels = Array.isArray(validationLevels) ? validationLevels : []
      // Checked before anything is written: a bad list creates no project.
      const initialTasks = normalizeInitialTasks(rawTasks)
      // A client company the caller cannot read answers its code; nothing is created.
      if (companyId) {
        const { assertVisibleCompany } = await import("~/apps/projects/service/deals")
        const refused = await typedCall(() => assertVisibleCompany(txDb as never, orgId, companyId))
        if (refused.startsWith('{"error"')) return refused
      }
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
              via: await transitionVia(),
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
        let timeBudgetsFlipped: "on" | "off" | undefined
        let switchKeys: Record<string, unknown> = {}
        if (companyId || timeBudgets !== undefined) {
          const { updateProjectWithOutcome } = await import(
            "~/apps/projects/service/update-project"
          )
          const outcome = await updateProjectWithOutcome({
            tx: stepTx as never,
            orgId,
            projectId: project.id,
            actor,
            actorType: actorKind === "agent" ? "agent" : "user",
            patch: {
              ...(companyId ? { companyId } : {}),
              ...(timeBudgets !== undefined ? { timeBudgets } : {}),
            },
          })
          timeBudgetsFlipped = outcome.timeBudgetsFlipped
          const d = outcome.detail
          if (d.timeBudgets !== undefined) {
            switchKeys = {
              timeBudgets: d.timeBudgets,
              ...(d.timeBudgetsChangedAt ? { timeBudgetsChangedAt: d.timeBudgetsChangedAt } : {}),
              ...(d.timeBudgetsChangedBy ? { timeBudgetsChangedBy: d.timeBudgetsChangedBy } : {}),
            }
          }
        }
        return withTimeBudgetsNote(
          { ...project, ...switchKeys } as never,
          timeBudgets !== undefined,
          timeBudgetsFlipped,
        ).then((withNote) => ({
          ...withNote,
          ...(companyId ? { companyId } : {}),
          validationLevels: saved,
          ...(initialTasks.length > 0 ? { tasks, taskCount: tasks.length } : {}),
        }))
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
        /** A deal's company, contact and amount: only in a pipeline. */
        companyId?: string | null
        contactId?: string | null
        amountMinor?: number | null
        currency?: string | null
        /** Planned size ("3 days", "20 h"), only on a project using time and budgets. */
        timebox?: string | null
        isMilestone?: boolean
        /** Values of the project's fields {key: value}. */
        fields?: Record<string, unknown> | null
      }
      return typedServiceCall(async () => {
        const { createTask, appendSourceCitation } = await import("~/apps/projects/service/tasks")
        const { assertPipelineForDealFields, hasDealFields, writeDealFields } = await import(
          "~/apps/projects/service/deals"
        )
        const {
          companyId: dealCompanyId,
          contactId: dealContactId,
          amountMinor: dealAmountMinor,
          currency: dealCurrency,
        } = params
        const dealFields = {
          ...(dealCompanyId !== undefined ? { companyId: dealCompanyId } : {}),
          ...(dealContactId !== undefined ? { contactId: dealContactId } : {}),
          ...(dealAmountMinor !== undefined ? { amountMinor: dealAmountMinor } : {}),
          ...(dealCurrency !== undefined ? { currency: dealCurrency } : {}),
        }
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
        const wantsDeal = hasDealFields(dealFields)
        if (wantsDeal) {
          await assertPipelineForDealFields(txDb as never, orgId, projectId, !!resolvedParentTaskId)
        }
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
          companyId: _companyId,
          contactId: _contactId,
          amountMinor: _amountMinor,
          currency: _currency,
          timebox: _timebox,
          isMilestone: _isMilestone,
          requireFields: _requireFields,
          ...appParams
        } = params as typeof params & {
          createdBy?: unknown
          completedAt?: unknown
          allowInactiveAssignee?: unknown
          createdByAgentLabel?: unknown
          requireFields?: unknown
        }
        const task = await createTask({
          tx: txDb as never,
          orgId,
          actor,
          via: await transitionVia(),
          input: {
            ...appParams,
            // An agent's (or a person's) create: the project's required fields apply.
            requireFields: true,
            description,
            projectId,
            assigneeId,
            parentTaskId: resolvedParentTaskId,
            beforeTaskId: resolvedBeforeTaskId,
            afterTaskId: resolvedAfterTaskId,
            createdByAgentLabel: await agentCreatorLabel(),
          },
        })
        const planned = await taskPlanKeys(task.id, params.timebox, params.isMilestone)
        if (!wantsDeal) return JSON.stringify({ ...task, ...planned })
        await writeDealFields(txDb as never, orgId, callerScopes ?? [], task.id, dealFields)
        return JSON.stringify({ ...task, deal: dealFields })
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
        timebox?: string | null
        isMilestone?: boolean
        /** Field values to set {key: value}; null empties one, keys left out are untouched. */
        fields?: Record<string, unknown> | null
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
        const via = await transitionVia()
        const { assigneeName, timebox, isMilestone, ...rest } = params
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
              via,
              taskId,
              parentTaskId: parentTaskId ?? null,
            })
          }
          const planned = await taskPlanKeys(taskId, timebox, isMilestone)
          const hasOtherUpdates = Object.keys(input).length > 0
          const task = hasOtherUpdates
            ? await updateTask({
                tx: txDb as never,
                orgId,
                actor,
                via,
                taskId,
                input: input as never,
              })
            : await getTask({ tx: txDb as never, orgId, taskId })
          return planned && task && typeof task === "object" ? { ...task, ...planned } : task
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
      const { projectOfTask } = await import("~/apps/projects/service/time-plan")
      const { planningOn, orgUsesTimeBudgets } = await import("~/apps/projects/service/planning")
      const counted = (p: { kind: "work" | "pipeline"; timeBudgetsOn: boolean }) =>
        planningOn(p, orgUsesTimeBudgets(orgId))
      const before = await projectOfTask(txDb, orgId, resolvedTaskId).catch(() => null)
      const via = await transitionVia()
      const moved = await withChecklistWarning(resolvedTaskId, () =>
        moveTask({
          tx: txDb as never,
          orgId,
          actor,
          via,
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
      if (!before) return moved
      const after = await projectOfTask(txDb, orgId, resolvedTaskId)
      if (after.project.id === before.project.id) return moved
      // Its time rows moved with it in this transaction; planned and spent stay on the task.
      const wasCounted = counted(before.project)
      const isCounted = counted(after.project)
      if (!wasCounted && !isCounted) return moved
      const note = isCounted
        ? wasCounted
          ? `Its planned time and time spent moved with it and now count on ${after.project.name}.`
          : `${after.project.name} uses time and budgets, so this task's planned time and time spent count there from now.`
        : `${after.project.name} does not use time and budgets: the task keeps its planned time and time spent, and they stop counting in any budget until it is back on a project that uses it.`
      const parsed = JSON.parse(moved) as Record<string, unknown>
      return JSON.stringify({ ...parsed, timeBudgetsNote: note })
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
        companyId?: string | null
        timeBudgets?: boolean
      }
      const placeRefusal = await timeBudgetsPlaceRefusal(params.timeBudgets)
      if (placeRefusal) return placeRefusal
      return typedServiceCall(async () => {
        const { updateProjectWithOutcome } = await import("~/apps/projects/service/update-project")
        const { assertProjectExists, resolveProjectId } = await import(
          "~/apps/projects/service/resolve"
        )
        const actor = await writeActor()
        const projectId = await resolveProjectId(txDb as never, orgId, params)
        await assertProjectExists(txDb as never, orgId, projectId)
        const outcome = await updateProjectWithOutcome({
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
            ...(params.companyId !== undefined ? { companyId: params.companyId } : {}),
            ...(params.timeBudgets !== undefined ? { timeBudgets: params.timeBudgets } : {}),
          },
        })
        const detail =
          params.companyId === null ? { ...outcome.detail, companyId: null } : outcome.detail
        return JSON.stringify(
          await withTimeBudgetsNote(
            detail as never,
            params.timeBudgets !== undefined,
            outcome.timeBudgetsFlipped,
          ),
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
        /** Field filter {key: value | value[] | null}. */
        fields?: Record<string, unknown> | null
        /** One assignee's tasks; null = unassigned ones. */
        assigneeId?: string | null
        priority?: string
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
          fields: params.fields,
          assigneeId: params.assigneeId,
          priority: params.priority,
        }),
      )
    },
    // tasks_aggregate: one or several projects' tasks grouped and measured (a manager's chart).
    projects_tasksAggregate: async (paramsJson: string): Promise<string> => {
      if (appName !== "projects") {
        throw new Error("projects_tasksAggregate is only available to the projects app")
      }
      const { hasScope: checkScope } = await import("~/modules/permissions/permissions")
      if (!checkScope("projects:tasks:read", callerScopes ?? [])) {
        return envelopeError("forbidden", "Missing required scope: projects:tasks:read")
      }
      const params = JSON.parse(paramsJson || "{}") as Omit<
        import("~/apps/projects/service/tasks-aggregate").TasksAggregateArgs,
        "tx" | "orgId" | "now"
      >
      const { tasksAggregate } = await import("~/apps/projects/service/tasks-aggregate")
      return typedCall(() =>
        tasksAggregate({
          tx: txDb as never,
          orgId,
          projectId: params.projectId,
          projectIds: params.projectIds,
          groupBy: params.groupBy,
          series: params.series,
          measure: params.measure,
          where: params.where,
          includeTerminal: params.includeTerminal,
          ageBuckets: params.ageBuckets,
          sla: params.sla,
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
    // --- Deals: a pipeline's root tasks with a company, a contact and an amount ---
    projects_dealsPipelineCreate: async (paramsJson: string): Promise<string> => {
      if (appName !== "projects") {
        throw new Error("projects_dealsPipelineCreate is only available to the projects app")
      }
      const params = JSON.parse(paramsJson || "{}") as {
        name: string
        key?: string
        stages?: string[]
        companyId?: string | null
      }
      return typedServiceCall(async () => {
        const { createPipeline } = await import("~/apps/projects/service/create-project")
        const actor = await writeActor()
        let pipeline: Awaited<ReturnType<typeof createPipeline>>
        try {
          pipeline = await createPipeline({
            tx: txDb as never,
            orgId,
            actor,
            input: {
              name: params.name,
              ...(params.key ? { key: params.key } : {}),
              ...(params.stages ? { stages: params.stages } : {}),
            },
          })
        } catch (err) {
          const message = String((err as Error)?.message ?? err)
          const code = /^([a-z_]+):/.exec(message)?.[1]
          if (!code) throw err
          return envelopeError(code, `${message}. Nothing was created.`)
        }
        const stages = pipeline.statuses.map((st) => st.label)
        return JSON.stringify({
          projectId: pipeline.id,
          key: pipeline.key,
          name: pipeline.name,
          stages,
          message: `Pipeline ${pipeline.name} (${pipeline.key}) created with stages ${stages.join(", ")}. Add deals with create and this projectId.`,
        })
      })
    },
    projects_dealsUpdate: async (paramsJson: string): Promise<string> => {
      if (appName !== "projects") {
        throw new Error("projects_dealsUpdate is only available to the projects app")
      }
      const params = JSON.parse(paramsJson || "{}") as {
        taskId: string
        companyId?: string | null
        contactId?: string | null
        amountMinor?: number | null
        currency?: string | null
        amountPeriod?: "once" | "month" | "year"
        probability?: number | null
        nextStep?: string | null
        outcome?: "won" | "lost" | "open"
        reason?: string | null
      }
      return typedServiceCall(async () => {
        const { listDeals, setDealOutcome, setLostReason, writeDealFields } = await import(
          "~/apps/projects/service/deals"
        )
        const { ProjectsServiceError } = await import("~/apps/projects/service/statuses")
        const actor = await writeActor()
        const taskId = await resolveTask(String(params.taskId ?? ""))
        const before = (await listDeals(txDb as never, orgId, { taskId }))[0]
        if (!before) {
          throw new ProjectsServiceError(
            404,
            "deal_not_found",
            "This task is not a live deal (a top-level task of a pipeline). Nothing was changed.",
          )
        }
        const { taskId: _t, outcome, reason, ...fields } = params
        await writeDealFields(txDb as never, orgId, callerScopes ?? [], taskId, fields)
        let outcomeChanged = false
        if (outcome) {
          const r = await setDealOutcome({
            tx: txDb as never,
            orgId,
            actor,
            taskId,
            outcome,
            reason: reason ?? null,
          })
          outcomeChanged = r.changed
        }
        // Already lost: the reason given now is saved on its own.
        let reasonSaved = false
        if (outcome === "lost" && !outcomeChanged && reason !== undefined) {
          reasonSaved = await setLostReason(txDb as never, orgId, taskId, reason)
        }
        const after = (await listDeals(txDb as never, orgId, { taskId }))[0]!
        const name = `${after.companyName ? `${after.companyName}, ` : ""}${after.title} (${after.key})`
        const changed = Object.keys(fields)
        const lines: string[] = []
        if (outcome && outcomeChanged) lines.push(`${name} moved to ${after.statusLabel}.`)
        else if (outcome)
          lines.push(`${name} was already ${after.outcome}; its stage did not change.`)
        if (reasonSaved) {
          lines.push(
            after.lostReason
              ? `The reason it was lost is now: ${after.lostReason}.`
              : "The reason it was lost was cleared.",
          )
        }
        if (changed.length > 0) lines.push(`Changed on ${name}: ${changed.join(", ")}.`)
        if (reason && outcome !== "lost") {
          lines.push("The reason was not saved: it is kept only with outcome lost.")
        }
        if (lines.length === 0) lines.push(`Nothing was given to change on ${name}.`)
        return JSON.stringify({
          taskId,
          key: after.key,
          outcome: after.outcome,
          closedAt: after.closedAt,
          statusId: after.statusId,
          stage: after.statusLabel,
          message: lines.join(" "),
        })
      })
    },
    projects_dealsSearch: async (paramsJson: string): Promise<string> => {
      if (appName !== "projects") {
        throw new Error("projects_dealsSearch is only available to the projects app")
      }
      const params = JSON.parse(paramsJson || "{}") as {
        taskId?: string
        projectId?: string
        companyId?: string
        contactId?: string
        outcome?: "open" | "won" | "lost"
        closedAfter?: string
        closedBefore?: string
        limit?: number
      }
      return typedServiceCall(async () => {
        const { listDeals } = await import("~/apps/projects/service/deals")
        const { hasScope: checkScope } = await import("~/modules/permissions/permissions")
        const dealAccess = checkScope("projects:deals:read", callerScopes ?? [])
        const taskId = params.taskId ? await resolveTask(params.taskId) : undefined
        const rows = await listDeals(txDb as never, orgId, {
          ...(taskId ? { taskId } : {}),
          ...(params.projectId ? { projectId: params.projectId } : {}),
          ...(params.companyId ? { companyId: params.companyId } : {}),
          ...(params.contactId ? { contactId: params.contactId } : {}),
          ...(params.outcome ? { outcome: params.outcome } : {}),
          ...(params.closedAfter ? { closedAfter: params.closedAfter } : {}),
          ...(params.closedBefore ? { closedBefore: params.closedBefore } : {}),
          limit: Math.min(Math.max(Number(params.limit ?? 25), 1), 100),
        })
        const items = rows.map((d) => ({
          task: {
            id: d.taskId,
            key: d.key,
            title: d.title,
            projectId: d.projectId,
            stage: d.statusLabel,
            ownerId: d.assigneeId,
          },
          deal: {
            companyId: d.companyId,
            companyName: d.companyName,
            contactId: d.contactId,
            outcome: d.outcome,
            nextStep: d.nextStep,
            lostReason: d.lostReason,
            closedAt: d.closedAt,
            closedBy: d.closedBy,
          },
          ...(dealAccess && d.value ? { values: d.value } : {}),
        }))
        const message =
          items.length === 0
            ? taskId
              ? "This task is not a live deal you can see."
              : "No deal you can see matches."
            : `${items.length} deal${items.length === 1 ? "" : "s"}.${dealAccess ? "" : " Amounts need deal access and are not shown."}`
        return JSON.stringify({ items, count: items.length, message })
      })
    },
    projects_dealsRollup: async (paramsJson: string): Promise<string> => {
      if (appName !== "projects") {
        throw new Error("projects_dealsRollup is only available to the projects app")
      }
      const { hasScope: checkScope } = await import("~/modules/permissions/permissions")
      if (!checkScope("projects:deals:read", callerScopes ?? [])) {
        return envelopeError("forbidden", "Missing required scope: projects:deals:read")
      }
      const params = JSON.parse(paramsJson || "{}") as {
        projectId?: string
        groupBy?: "stage" | "owner" | "month"
        weighted?: boolean
        closedAfter?: string
        closedBefore?: string
      }
      const groupBy = params.groupBy ?? "stage"
      if (!["stage", "owner", "month"].includes(groupBy)) {
        return envelopeError(
          "invalid_params",
          "groupBy is stage, owner or month. Nothing was read.",
        )
      }
      return typedServiceCall(async () => {
        const { dealsRollup } = await import("~/apps/projects/service/deals")
        const r = await dealsRollup(txDb as never, orgId, {
          groupBy,
          ...(params.projectId ? { projectId: params.projectId } : {}),
          ...(params.weighted ? { weighted: true } : {}),
          ...(params.closedAfter ? { closedAfter: params.closedAfter } : {}),
          ...(params.closedBefore ? { closedBefore: params.closedBefore } : {}),
        })
        return JSON.stringify({
          ...r,
          message: `${r.dealCount} deal${r.dealCount === 1 ? "" : "s"} in ${r.groups.length} group${r.groups.length === 1 ? "" : "s"} by ${groupBy}; sums are per currency, never converted.${r.truncated ? " Only the 500 most recently changed deals are counted." : ""}`,
        })
      })
    },
    projects_dealsFollowupCandidates: async (paramsJson: string): Promise<string> => {
      if (appName !== "projects") {
        throw new Error("projects_dealsFollowupCandidates is only available to the projects app")
      }
      const params = JSON.parse(paramsJson || "{}") as { quietDays?: number; projectId?: string }
      const quietDays = Number(params.quietDays)
      if (!Number.isInteger(quietDays) || quietDays < 1) {
        return envelopeError("invalid_params", "quietDays is a whole number of days, 1 or more.")
      }
      return typedServiceCall(async () => {
        const { followupCandidates } = await import("~/apps/projects/service/deals")
        const items = await followupCandidates(txDb as never, orgId, callerScopes ?? [], {
          quietDays,
          callerUserId: userId,
          ...(params.projectId ? { projectId: params.projectId } : {}),
        })
        const ready = items.filter((i) => i.skip === null).length
        const bySkip = new Map<string, number>()
        for (const i of items) if (i.skip) bySkip.set(i.skip, (bySkip.get(i.skip) ?? 0) + 1)
        const skipped = [...bySkip.entries()].map(([k, n]) => `${n} ${k}`).join(", ")
        return JSON.stringify({
          items,
          ready,
          message: `${ready} of ${items.length} open deal${items.length === 1 ? "" : "s"} can get a follow-up now (skip null)${ready > 0 ? ", each drafted to its address from its accountId" : ""}.${skipped ? ` Skipped: ${skipped}.` : ""}`,
        })
      })
    },
    // The work projects whose client is a company, with their open tasks, for
    // the Work section of its page, read under the caller's row security.
    // Pipelines are left out: their deals are the page's Deals section.
    projects_companyProjects: async (paramsJson: string): Promise<string> => {
      if (appName !== "projects") {
        throw new Error("projects_companyProjects is only available to the projects app")
      }
      const params = JSON.parse(paramsJson || "{}") as { companyId?: string }
      const companyId = String(params.companyId ?? "")
      if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(companyId)) {
        return envelopeError("invalid_params", "companyId is a company id. Nothing was read.")
      }
      const schema = drizzleSql.raw(`"${schemaRef("app_projects")}"`)
      const rows = extractRows<{
        id: string
        name: string
        key: string | null
        open_tasks: number
        tasks: Array<{ id: string; key: string | null; title: string; status: string | null }>
      }>(
        await txDb.execute(drizzleSql`
          SELECT p.id::text AS id, p.name, p.key,
                 (SELECT count(*)::int FROM ${schema}.tasks t
                    JOIN ${schema}.project_statuses s ON s.id = t.status_id
                   WHERE t.project_id = p.id AND t.archived_at IS NULL AND NOT s.terminal) AS open_tasks,
                 COALESCE((
                   SELECT json_agg(json_build_object(
                            'id', o.id::text,
                            'key', CASE WHEN p.key IS NOT NULL AND o.number IS NOT NULL
                                        THEN p.key || '-' || o.number END,
                            'title', o.title,
                            'status', o.label) ORDER BY o.position, o.id)
                     FROM (SELECT t.id, t.number, t.title, t.position, s.label
                             FROM ${schema}.tasks t
                             JOIN ${schema}.project_statuses s ON s.id = t.status_id
                            WHERE t.project_id = p.id AND t.archived_at IS NULL AND NOT s.terminal
                            ORDER BY t.position, t.id
                            LIMIT 10) o
                 ), '[]'::json) AS tasks
            FROM ${schema}.projects p
           WHERE p.org_id = ${orgId}::uuid AND p.company_id = ${companyId}::uuid
             AND p.kind = 'work' AND p.archived_at IS NULL
           ORDER BY p.updated_at DESC, p.id
           LIMIT 50`),
      )
      return JSON.stringify({
        items: rows.map((r) => ({
          id: r.id,
          name: r.name,
          key: r.key,
          openTasks: r.open_tasks,
          tasks: r.tasks,
        })),
      })
    },
    projects_dealSendState: async (paramsJson: string): Promise<string> => {
      if (appName !== "projects") {
        throw new Error("projects_dealSendState is only available to the projects app")
      }
      const params = JSON.parse(paramsJson || "{}") as { ref?: { kind?: string; id?: string } }
      if (params.ref?.kind !== "projects:deal" || typeof params.ref.id !== "string") {
        return envelopeError("invalid_params", "ref is {kind: 'projects:deal', id: <task id>}.")
      }
      const { dealSendState } = await import("~/apps/projects/service/deals")
      return JSON.stringify(await dealSendState(txDb as never, orgId, params.ref.id))
    },
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
      // The target keeps its timebox, or takes the source's when it has none; the
      // source's time joined the target's in mergeTasks (one person's row adds up).
      await txDb.execute(drizzleSql`
        UPDATE ${drizzleSql.raw(schemaRef("app_projects"))}.tasks t
           SET timebox_minutes = COALESCE(t.timebox_minutes, s.timebox_minutes)
          FROM ${drizzleSql.raw(schemaRef("app_projects"))}.tasks s
         WHERE t.id = ${resolvedTargetId}::uuid AND s.id = ${resolvedSourceId}::uuid
           AND t.org_id = ${orgId}::uuid AND s.org_id = ${orgId}::uuid
           AND t.timebox_minutes IS NULL AND s.timebox_minutes IS NOT NULL`)
      const { taskTimeKeys } = await import("~/apps/projects/service/time-plan")
      const keys = await taskTimeKeys(txDb, orgId, resolvedTargetId)
      return JSON.stringify({
        sourceId: resolvedSourceId,
        targetId: resolvedTargetId,
        merged: true,
        ...(keys
          ? {
              timeboxMinutes: keys.timeboxMinutes,
              timeBudgetsNote:
                "The source's time spent now counts on the target, and the target keeps its timebox (or takes the source's when it had none).",
            }
          : {}),
      })
    },
    projects_instantiateTemplate: async (paramsJson: string): Promise<string> => {
      if (appName !== "projects") {
        throw new Error("projects_instantiateTemplate is only available to the projects app")
      }
      const params = JSON.parse(paramsJson || "{}") as {
        templateId?: string
        projectName?: string
        timeBudgets?: boolean
      }
      if (!params.templateId || !params.projectName) {
        throw new Error("invalid_params: templateId and projectName required")
      }
      const placeRefusal = await timeBudgetsPlaceRefusal(params.timeBudgets)
      if (placeRefusal) return placeRefusal
      const { templateId, projectName } = params
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
      return typedServiceCall(async () => {
        const made = await instantiateTemplate({
          tx: txDb as never,
          orgId,
          actor,
          via: await transitionVia(),
          templateId,
          projectName,
        })
        const { orgUsesTimeBudgets } = await import("~/apps/projects/service/planning")
        if (params.timeBudgets === undefined && !orgUsesTimeBudgets(orgId)) {
          return JSON.stringify(made)
        }
        const { updateProjectWithOutcome } = await import("~/apps/projects/service/update-project")
        const outcome = await updateProjectWithOutcome({
          tx: txDb as never,
          orgId,
          projectId: made.projectId,
          actor,
          actorType: actorKind === "agent" ? "agent" : "user",
          patch: params.timeBudgets !== undefined ? { timeBudgets: params.timeBudgets } : {},
        })
        const noted = await withTimeBudgetsNote(
          outcome.detail as never,
          params.timeBudgets !== undefined,
          outcome.timeBudgetsFlipped,
        )
        return JSON.stringify({
          ...made,
          timeBudgets: noted.timeBudgets,
          timeBudgetsNote: noted.timeBudgetsNote,
        })
      })
    },
    // Field definitions and templates (direct writes, projects:projects:write by the tool).
    projects_setFields: async (paramsJson: string): Promise<string> => {
      if (appName !== "projects") {
        throw new Error("projects_setFields is only available to the projects app")
      }
      const params = JSON.parse(paramsJson || "{}") as {
        projectId?: string
        projectName?: string
        fields?: unknown
        renames?: Record<string, Record<string, string>> | null
      }
      return typedServiceCall(async () => {
        const { setFields } = await import("~/apps/projects/service/fields")
        const { assertProjectExists, resolveProjectId } = await import(
          "~/apps/projects/service/resolve"
        )
        const actor = await writeActor()
        const projectId = await resolveProjectId(txDb as never, orgId, params)
        await assertProjectExists(txDb as never, orgId, projectId)
        const fields = await setFields({
          tx: txDb as never,
          orgId,
          actor,
          projectId,
          fields: params.fields ?? [],
          renames: params.renames ?? null,
        })
        return JSON.stringify({ projectId, fields })
      })
    },
    projects_saveTemplate: async (paramsJson: string): Promise<string> => {
      if (appName !== "projects") {
        throw new Error("projects_saveTemplate is only available to the projects app")
      }
      const params = JSON.parse(paramsJson || "{}") as {
        templateId?: string | null
        name?: string
        statuses?: unknown
        fields?: unknown
        tasks?: unknown
        fromProjectId?: string | null
      }
      return typedServiceCall(async () => {
        const { saveTemplate } = await import("~/apps/projects/service/templates")
        const actor = await writeActor()
        return JSON.stringify(
          await saveTemplate({
            tx: txDb as never,
            orgId,
            actor,
            input: {
              templateId: params.templateId ?? null,
              name: params.name ?? "",
              statuses: params.statuses,
              fields: params.fields,
              tasks: params.tasks,
              fromProjectId: params.fromProjectId ?? null,
            },
          }),
        )
      })
    },
    projects_listTemplates: async (_paramsJson: string): Promise<string> => {
      if (appName !== "projects") {
        throw new Error("projects_listTemplates is only available to the projects app")
      }
      const { listTemplates } = await import("~/apps/projects/service/templates")
      return typedCall(async () => ({ items: await listTemplates(txDb as never, orgId) }))
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
          agentAuthorLabel: await routineCommentLabel(),
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
    /** Took: the caller's own real time on a task, only from their own statement. */
    projects_taskTimeSet: async (paramsJson: string): Promise<string> => {
      const params = JSON.parse(paramsJson || "{}") as {
        taskId?: string
        time?: string | null
        date?: string
        quote?: string
      }
      return typedServiceCall(async () => {
        const { setTaskTime } = await import("~/apps/projects/service/time-plan")
        const actor = await writeActor()
        const taskId = await resolveTask(params.taskId ?? "")
        return JSON.stringify(
          await setTaskTime({
            tx: txDb,
            orgId,
            userId: actor.userId,
            scopes: callerScopes ?? [],
            place: await tookPlace(),
            ...(bridgeOptions?.threadId ? { threadId: bridgeOptions.threadId } : {}),
            input: {
              taskId,
              time: params.time ?? null,
              ...(params.date !== undefined ? { date: params.date } : {}),
              ...(params.quote !== undefined ? { quote: params.quote } : {}),
            },
          }),
        )
      })
    },
    /** The caller's own Took rows on a task, and the task's total. */
    projects_taskTimeGet: async (paramsJson: string): Promise<string> => {
      const params = JSON.parse(paramsJson || "{}") as { taskId?: string }
      return typedCall(async () => {
        const { getTaskTime } = await import("~/apps/projects/service/time-plan")
        const actor = await writeActor()
        return getTaskTime({
          tx: txDb,
          orgId,
          userId: actor.userId,
          scopes: callerScopes ?? [],
          taskId: await resolveTask(params.taskId ?? ""),
        })
      })
    },
    /** The dated corrector (the project's lead or finance) changes an entry, in their own words. */
    projects_taskTimeCorrect: async (paramsJson: string): Promise<string> => {
      const params = JSON.parse(paramsJson || "{}") as {
        entryId?: string
        time?: string
        date?: string
        quote?: string
      }
      return typedServiceCall(async () => {
        const { correctTaskTime } = await import("~/apps/projects/service/time-plan")
        const actor = await writeActor()
        return JSON.stringify(
          await correctTaskTime({
            tx: txDb,
            orgId,
            actorId: actor.userId,
            scopes: callerScopes ?? [],
            place: await tookPlace(),
            ...(bridgeOptions?.threadId ? { threadId: bridgeOptions.threadId } : {}),
            input: {
              entryId: params.entryId ?? "",
              time: params.time ?? "",
              ...(params.date !== undefined ? { date: params.date } : {}),
              ...(params.quote !== undefined ? { quote: params.quote } : {}),
            },
          }),
        )
      })
    },
    /** A project's plan: basis, timebox, biller, repositories and dated hours. */
    projects_timePlanSet: async (paramsJson: string): Promise<string> => {
      const params = JSON.parse(paramsJson || "{}") as Record<string, unknown> & {
        projectId?: string
        projectName?: string
      }
      return typedServiceCall(async () => {
        const { setTimePlan } = await import("~/apps/projects/service/time-plan")
        const { resolveProjectId } = await import("~/apps/projects/service/resolve")
        const actor = await writeActor()
        const projectId = await resolveProjectId(txDb as never, orgId, params as never)
        const { projectId: _p, projectName: _n, ...rest } = params
        const out = await setTimePlan({
          tx: txDb,
          orgId,
          actorId: actor.userId,
          scopes: callerScopes ?? [],
          input: { ...(rest as object), projectId },
        })
        if (out.datedTurnedOn) {
          const { loadPlanningProject } = await import("~/apps/projects/service/time-plan")
          const { tellEntrantsDatedOn } = await import("~/apps/projects/service/time-rows")
          const project = await loadPlanningProject(txDb, orgId, projectId)
          if (project) tellEntrantsDatedOn(orgId, project, actor.userId)
        }
        return JSON.stringify({ ...out.plan, message: out.message })
      })
    },
    /** A project's rate or fixed price. */
    projects_billingTermsSet: async (paramsJson: string): Promise<string> => {
      const params = JSON.parse(paramsJson || "{}") as {
        projectId?: string
        projectName?: string
        rate?: number | null
        fixedPrice?: number | null
        currency?: string
      }
      return typedServiceCall(async () => {
        const { setBillingTerms } = await import("~/apps/projects/service/time-plan")
        const { resolveProjectId } = await import("~/apps/projects/service/resolve")
        const projectId = await resolveProjectId(txDb as never, orgId, params)
        return JSON.stringify(
          await setBillingTerms({
            tx: txDb,
            orgId,
            scopes: callerScopes ?? [],
            input: {
              projectId,
              ...(params.rate !== undefined ? { rate: params.rate } : {}),
              ...(params.fixedPrice !== undefined ? { fixedPrice: params.fixedPrice } : {}),
              ...(params.currency !== undefined ? { currency: params.currency } : {}),
            },
          }),
        )
      })
    },
    /** A month's or a period's timebox on a project; null removes it. */
    projects_periodTimeboxSet: async (paramsJson: string): Promise<string> => {
      const params = JSON.parse(paramsJson || "{}") as {
        projectId?: string
        projectName?: string
        month?: string
        from?: string
        to?: string
        timebox?: string | null
      }
      return typedServiceCall(async () => {
        const { setPeriodTimebox } = await import("~/apps/projects/service/time-plan")
        const { resolveProjectId } = await import("~/apps/projects/service/resolve")
        const actor = await writeActor()
        const projectId = await resolveProjectId(txDb as never, orgId, params)
        return JSON.stringify(
          await setPeriodTimebox({
            tx: txDb,
            orgId,
            actorId: actor.userId,
            scopes: callerScopes ?? [],
            input: {
              projectId,
              timebox: params.timebox ?? null,
              ...(params.month !== undefined ? { month: params.month } : {}),
              ...(params.from !== undefined ? { from: params.from } : {}),
              ...(params.to !== undefined ? { to: params.to } : {}),
            },
          }),
        )
      })
    },
    /** A project's planned time against its real time, with the coverage that makes it honest. */
    projects_budgetGet: async (paramsJson: string): Promise<string> => {
      const params = JSON.parse(paramsJson || "{}") as { projectId?: string; projectName?: string }
      return typedCall(async () => {
        const { getBudget } = await import("~/apps/projects/service/budget")
        const { resolveProjectId } = await import("~/apps/projects/service/resolve")
        const projectId = await resolveProjectId(txDb as never, orgId, params)
        return getBudget({ tx: txDb, orgId, scopes: callerScopes ?? [], projectId })
      })
    },
    /** Margin's cost side for one project (finance only); the handler adds the invoices. */
    projects_marginCost: async (paramsJson: string): Promise<string> => {
      const params = JSON.parse(paramsJson || "{}") as {
        projectId?: string
        projectName?: string
        month?: string
      }
      return typedCall(async () => {
        const { getMarginCost } = await import("~/apps/projects/service/margin")
        const { resolveProjectId } = await import("~/apps/projects/service/resolve")
        const projectId = await resolveProjectId(txDb as never, orgId, params)
        return getMarginCost({
          tx: txDb,
          orgId,
          scopes: callerScopes ?? [],
          projectId,
          ...(params.month ? { month: params.month } : {}),
        })
      })
    },
    /** The org's cost rates, per person and date: finance only. */
    projects_costRatesList: async (_paramsJson: string): Promise<string> =>
      typedCall(async () => {
        const { listCostRates } = await import("~/apps/projects/service/margin")
        return listCostRates({ tx: txDb, orgId, scopes: callerScopes ?? [] })
      }),
    /** A person's cost rate from a date on: the exact cost-rates write scope. */
    projects_costRateSet: async (paramsJson: string): Promise<string> => {
      const params = JSON.parse(paramsJson || "{}") as {
        userId?: string
        rate?: number
        from?: string
        currency?: string
      }
      return typedServiceCall(async () => {
        const { setCostRate } = await import("~/apps/projects/service/margin")
        return JSON.stringify(
          await setCostRate({ tx: txDb, orgId, scopes: callerScopes ?? [], input: params }),
        )
      })
    },
    /** One project's dated sheet for a month: lead and finance only. */
    projects_timesheetGet: async (paramsJson: string): Promise<string> => {
      const params = JSON.parse(paramsJson || "{}") as {
        projectId?: string
        projectName?: string
        month?: string
      }
      return typedCall(async () => {
        const { getTimesheet } = await import("~/apps/projects/service/timesheet")
        const { resolveProjectId } = await import("~/apps/projects/service/resolve")
        const projectId = await resolveProjectId(txDb as never, orgId, params)
        const actor = await writeActor()
        return getTimesheet({
          tx: txDb,
          orgId,
          userId: actor.userId,
          scopes: callerScopes ?? [],
          projectId,
          ...(params.month ? { month: params.month } : {}),
        })
      })
    },
    /** The dated sheet as a PDF or CSV file for its caller; a partial sheet asks once. */
    projects_timesheetExport: async (paramsJson: string): Promise<string> => {
      const params = JSON.parse(paramsJson || "{}") as {
        projectId?: string
        projectName?: string
        month?: string
        format?: string
        acceptPartial?: boolean
      }
      return typedCall(async () => {
        const { exportTimesheet } = await import("~/apps/projects/service/timesheet")
        const { resolveProjectId } = await import("~/apps/projects/service/resolve")
        const projectId = await resolveProjectId(txDb as never, orgId, params)
        const actor = await writeActor()
        return exportTimesheet({
          tx: txDb,
          viewer: actor,
          scopes: callerScopes ?? [],
          projectId,
          format: params.format,
          acceptPartial: params.acceptPartial === true,
          ...(params.month ? { month: params.month } : {}),
        })
      })
    },
    /** The facts of one project's period, for a reconcile the person asked for. */
    projects_reconcileFacts: async (paramsJson: string): Promise<string> => {
      const params = JSON.parse(paramsJson || "{}") as {
        project?: string
        month?: string
        from?: string
        to?: string
      }
      return typedCall(async () => {
        const { reconcileFacts } = await import("~/apps/projects/service/reconcile")
        const actor = await writeActor()
        return reconcileFacts({
          tx: txDb,
          orgId,
          userId: actor.userId,
          scopes: callerScopes ?? [],
          input: {
            project: params.project ?? "",
            ...(params.month !== undefined ? { month: params.month } : {}),
            ...(params.from !== undefined ? { from: params.from } : {}),
            ...(params.to !== undefined ? { to: params.to } : {}),
          },
        })
      })
    },
    /** The reconcile card: the agent's grouping and proofs, every figure the server's. */
    projects_reconcilePropose: async (paramsJson: string): Promise<string> => {
      const params = JSON.parse(paramsJson || "{}") as Record<string, unknown>
      return typedServiceCall(async () => {
        const { reconcilePropose } = await import("~/apps/projects/service/reconcile")
        const actor = await writeActor()
        return JSON.stringify(
          await reconcilePropose({
            tx: txDb,
            orgId,
            userId: actor.userId,
            scopes: callerScopes ?? [],
            ...(bridgeOptions?.threadId ? { threadId: bridgeOptions.threadId } : {}),
            ...(bridgeOptions?.origin ? { origin: bridgeOptions.origin } : {}),
            input: params as never,
          }),
        )
      })
    },
    /** One line of the person's own proposed card: its bill, wording or time-spent note. */
    projects_reconcileLineUpdate: async (paramsJson: string): Promise<string> => {
      const params = JSON.parse(paramsJson || "{}") as Record<string, unknown>
      return typedServiceCall(async () => {
        const { reconcileLineUpdate } = await import("~/apps/projects/service/reconcile")
        const actor = await writeActor()
        return JSON.stringify(
          await reconcileLineUpdate({
            tx: txDb,
            orgId,
            userId: actor.userId,
            scopes: callerScopes ?? [],
            ...(bridgeOptions?.origin ? { origin: bridgeOptions.origin } : {}),
            input: params as never,
          }),
        )
      })
    },
    /** A stored reconcile card, read again under the reader's own rows. */
    projects_reconcileGet: async (paramsJson: string): Promise<string> => {
      const params = JSON.parse(paramsJson || "{}") as { reconciliationId?: string }
      return typedServiceCall(async () => {
        const { reconcileGet } = await import("~/apps/projects/service/reconcile")
        const actor = await writeActor()
        return JSON.stringify(
          await reconcileGet({
            tx: txDb,
            orgId,
            userId: actor.userId,
            scopes: callerScopes ?? [],
            input: { reconciliationId: params.reconciliationId ?? "" },
          }),
        )
      })
    },
    /** Planned against available time per person for one ISO week, in name order. */
    projects_capacityGet: async (paramsJson: string): Promise<string> => {
      const params = JSON.parse(paramsJson || "{}") as { week?: string; taskId?: string }
      return typedCall(async () => {
        const { getCapacity } = await import("~/apps/projects/service/capacity")
        return getCapacity({
          tx: txDb,
          orgId,
          ...(params.week ? { week: params.week } : {}),
          ...(params.taskId ? { taskId: params.taskId } : {}),
        })
      })
    },
    /** The capacity board's "Move to <person>": gives a task to someone else and tells both. */
    projects_capacityMove: async (paramsJson: string): Promise<string> => {
      const params = JSON.parse(paramsJson || "{}") as {
        taskId?: string
        toUserId?: string | null
      }
      return typedServiceCall(async () => {
        const { moveCapacityTask } = await import("~/apps/projects/service/capacity-move")
        const actor = await writeActor()
        return JSON.stringify(
          await moveCapacityTask({
            tx: txDb as never,
            orgId,
            actor,
            input: {
              ...(params.taskId ? { taskId: params.taskId } : {}),
              ...(params.toUserId || params.toUserId === null ? { toUserId: params.toUserId } : {}),
            },
          }),
        )
      })
    },
    /** A company day off: one day, a range or an ISO week, resolved on the server. */
    projects_daysOffSet: async (paramsJson: string): Promise<string> => {
      const params = JSON.parse(paramsJson || "{}") as Record<string, unknown>
      return typedServiceCall(async () => {
        const { setDaysOff } = await import("~/apps/projects/service/days-off")
        const actor = await writeActor()
        return JSON.stringify(
          await setDaysOff({
            tx: txDb,
            orgId,
            actorId: actor.userId,
            scopes: callerScopes ?? [],
            via: bridgeOptions?.origin === "human-ui" ? "settings" : "agent",
            input: params as never,
          }),
        )
      })
    },
    /** The company days off, each marked when it was read from the shared calendar. */
    projects_daysOffList: async (paramsJson: string): Promise<string> => {
      const params = JSON.parse(paramsJson || "{}") as { from?: string; to?: string }
      return typedCall(async () => {
        const { listDaysOff } = await import("~/apps/projects/service/days-off")
        return listDaysOff({
          tx: txDb,
          orgId,
          ...(params.from ? { from: params.from } : {}),
          ...(params.to ? { to: params.to } : {}),
        })
      })
    },
    /** Removes typed company days off by id or by a day they cover; imported ones stay. */
    projects_daysOffRemove: async (paramsJson: string): Promise<string> => {
      const params = JSON.parse(paramsJson || "{}") as { id?: string; on?: string }
      return typedServiceCall(async () => {
        const { removeDaysOff } = await import("~/apps/projects/service/days-off")
        return JSON.stringify(
          await removeDaysOff({
            tx: txDb,
            orgId,
            scopes: callerScopes ?? [],
            input: {
              ...(params.id ? { id: params.id } : {}),
              ...(params.on ? { on: params.on } : {}),
            },
          }),
        )
      })
    },
    /** Hours in a day, the shared calendar, how many projects use time; or one person's days per week. */
    projects_timeSettingsGet: async (paramsJson: string): Promise<string> => {
      const params = JSON.parse(paramsJson || "{}") as { userId?: string }
      return typedCall(async () => {
        const { getTimeSettings } = await import("~/apps/projects/service/time-settings")
        const actor = await writeActor()
        return getTimeSettings({
          tx: txDb,
          orgId,
          userId: actor.userId,
          scopes: callerScopes ?? [],
          input: params.userId ? { userId: params.userId } : {},
        })
      })
    },
    /** Saves hours in a day, the shared calendar, or one person's days per week. */
    projects_timeSettingsSet: async (paramsJson: string): Promise<string> => {
      const params = JSON.parse(paramsJson || "{}") as {
        hoursPerDay?: number | string
        daysOffCalendarId?: string | null
        userId?: string
        daysPerWeek?: number
      }
      return typedServiceCall(async () => {
        const { setTimeSettings } = await import("~/apps/projects/service/time-settings")
        const actor = await writeActor()
        const [me] = extractRows<{ name: string | null }>(
          await txDb.execute(
            drizzleSql`SELECT name FROM ${drizzleSql.raw(schemaRef("kernel"))}.users
              WHERE id = ${actor.userId}::uuid AND org_id = ${orgId}::uuid LIMIT 1`,
          ),
        )
        return JSON.stringify(
          await setTimeSettings({
            tx: txDb,
            orgId,
            userId: actor.userId,
            ...(me?.name ? { userName: me.name } : {}),
            scopes: callerScopes ?? [],
            input: {
              ...(params.hoursPerDay !== undefined ? { hoursPerDay: params.hoursPerDay } : {}),
              ...(params.daysOffCalendarId !== undefined
                ? { daysOffCalendarId: params.daysOffCalendarId }
                : {}),
              ...(params.userId ? { userId: params.userId } : {}),
              ...(params.daysPerWeek !== undefined ? { daysPerWeek: params.daysPerWeek } : {}),
            },
          }),
        )
      })
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
