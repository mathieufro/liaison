// SPDX-License-Identifier: FSL-1.1-ALv2
import type pino from "pino"
import type { RlsClient } from "~/db"
import type { ActorContext, RlsSession } from "~/db/rls"
import type { AppEvent } from "~/infra/events/event-bus"
import { enqueueAppJob } from "~/infra/jobs/jobs"
import { rootLogger } from "~/lib/logger"
import { getDeclaredEmits } from "~/modules/apps/app-registries"
import { appContactAudience, resolveContact as resolve } from "~/modules/contacts/service"

export interface AppContext {
  userId: string
  orgId: string
  db: RlsClient
  emit: (event: AppEvent) => Promise<void>
  /** `delay` in ms (at most 15 min), `jobId` an org-scoped deduplication key (as for app code). */
  enqueueJob: (
    jobName: string,
    payload: unknown,
    opts?: { delay?: number; jobId?: string },
  ) => Promise<void>
  resolveContact: (params: any) => Promise<any>
  logger: pino.Logger
  /**
   * Provenance: who originated the call.
   * `'user'`  = direct UI/API call. `'agent'` = in-app agent call. `'mcp'` = MCP-origin.
   * Handlers that record `createdByActorType` should read this. Defaults to `'user'`.
   */
  actorType: "user" | "agent" | "mcp"
  /**
   * The approver in a gated flow, OR the calling user in a direct flow.
   * Same as `userId` for non-gated tools; for gated tools, the approver's user id.
   */
  approverUserId: string | null
  /** The routine this call originated from, if any. A routine executes as its
   *  OWNER, so a handler that records an author must prefer the routine over
   *  `userId` or the work reads as the owner's. Set by execute-tool. */
  originRoutineId?: string
  /**
   * The thread the agent loop is executing in (its conversation thread), when
   * the call originates from the in-app agent. Used to attribute agent thread
   * posts — a routine's execution thread resolves the post to "Routine {name}".
   * Undefined for direct UI/API calls and MCP calls without a thread.
   */
  agentExecutionThreadId?: string
  /**
   * The approval this call executes, when a person approved it (set by execute-tool). A handler
   * that reports back through the approval card (the dispatch to the person's computer) reads it.
   */
  approvalRequestId?: string
  /**
   * The `kernel.agents` row acting in this call, resolved by execute-tool from
   * the live run frame (or forwarded by a frameless gateway) — the same single
   * field every audit and approval row already records. `null` is a positive
   * "no agent acted"; a handler whose data is keyed BY AGENT rather than by
   * user (the memory tree) must read this or a role agent's call lands in the
   * calling human's rows.
   */
  actingAgentId?: string | null
  /**
   * The calling turn's scope taint as the dispatch resolved it, raw (see
   * execute-tool's bridge option of the same name). `undefined` when no turn
   * called this or the dispatch did not forward it.
   */
  turnTaintScopes?: readonly string[]
  /** The caller's stop (a chat turn the person stopped), for a handler that waits on long work. */
  abortSignal?: AbortSignal
  /**
   * The call's session, for a tool declaring `ownsTransactions` (app-registries.ts): each
   * `run` is one short transaction. Set only when the dispatch passed a session; `ctx.db`
   * then refuses every use.
   */
  rlsSession?: RlsSession
  /** The actor's effective scopes — injected for handlers that do scope-subset checks. */
  scopes?: string[]
  /**
   * The app whose handler dispatched this call through its own `ctx.executeTool` (a declared
   * cross-app call, set by execute-tool from the bridge, never by the caller's params).
   * `undefined` for a direct user, agent or MCP call.
   */
  callerApp?: string
  /**
   * The acting user's dimension grants (e.g. `{ market: ["EU", "US"] }`).
   * Populated by `createAppContext` when a `UserContext` actor is provided
   * (always present from the production code path); empty `{}` for system
   * actors or when no actor was plumbed. Optional in the type so manual
   * test-mock objects built without going through `createAppContext` (the
   * agent service test suite predates this field) continue to type-check.
   */
  dimensionGrants?: Record<string, string[]>
  /**
   * The role ids the acting user holds, as their row security reads them (a
   * record shared to one of those roles is theirs). Absent for non-user actors
   * or when no actor was plumbed. A handler that opens its own row-security
   * context for the person passes them on.
   */
  roles?: string[]
}

export function createAppContext(
  appName: string,
  userId: string,
  orgId: string,
  txDb: RlsClient,
  actorType: "user" | "agent" | "mcp" = "user",
  approverUserId: string | null = null,
  actor?: ActorContext,
): AppContext {
  const logger = rootLogger.child({ app: appName })

  return {
    userId,
    orgId,
    db: txDb,
    actorType,
    approverUserId,
    dimensionGrants: actor?.actorType === "user" ? actor.dimensionGrants : {},
    ...(actor?.actorType === "user" && actor.roles ? { roles: actor.roles } : {}),
    emit: async (event: AppEvent) => {
      // Enforce app identity — prevent cross-app event impersonation
      if (event.app !== appName) {
        throw new Error(`App "${appName}" cannot emit events on behalf of "${event.app}"`)
      }

      // Validate against declared emits — prevents undeclared events from creating
      // infinite retry loops in the outbox worker (they'd fail on publish every time).
      const appEmits = getDeclaredEmits(orgId, appName)
      if (appEmits && !appEmits.has(`${event.entity}:${event.action}`)) {
        throw new Error(
          `App "${appName}" emitted undeclared event "${event.entity}:${event.action}"`,
        )
      }
      await txDb.queueEvent({
        ...event,
        orgId,
        timestamp: event.timestamp ?? new Date().toISOString(),
      })
    },
    enqueueJob: async (
      jobName: string,
      payload: unknown,
      opts?: { delay?: number; jobId?: string },
    ) => {
      // SECURITY (cross-tenant escalation): pin the context's trusted `orgId`
      // into the payload and forbid an override. The BullMQ worker (jobs.ts)
      // derives the RLS tenant from `payload.orgId`; spreading the caller
      // payload first ensures the trusted `orgId` always wins. Mirrors the
      // sandbox bridge enqueueJob pin (rpc-bridge.ts) and emit's orgId stamp.
      // The job's identity fields (`_userId`, `_callerScopes`) and host handles are
      // never taken from the payload: a job enqueued here runs as the app.
      const { MAX_SANDBOX_JOB_DELAY_MS, withoutHostJobFields } = await import(
        "~/modules/apps/sandbox/bridge/platform"
      )
      const merged = { ...withoutHostJobFields(payload), orgId }
      if (!opts) {
        await enqueueAppJob(appName, jobName, merged)
        return
      }
      const delay =
        typeof opts.delay === "number" && Number.isFinite(opts.delay) && opts.delay > 0
          ? Math.min(Math.round(opts.delay), MAX_SANDBOX_JOB_DELAY_MS)
          : undefined
      await enqueueAppJob(appName, jobName, merged, {
        ...(typeof opts.jobId === "string" && opts.jobId !== ""
          ? { jobId: `${orgId}:${opts.jobId}` }
          : {}),
        ...(delay ? { delay } : {}),
      })
    },
    resolveContact: async (params: any) => {
      const { appBridgeManifest } = await import("~/modules/apps/app-registries")
      const { contact } = await resolve(
        txDb,
        orgId,
        userId,
        params,
        appContactAudience(appBridgeManifest(orgId, appName)?.capabilities),
      )
      return contact
    },
    logger,
  }
}
