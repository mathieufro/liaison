// SPDX-License-Identifier: FSL-1.1-ALv2
/**
 * Phase 4 — Routines HTTP routes.
 *
 * Mount: app.ts under `/api/agent/routines`.
 *
 * Thin RPC wrapper over the gated tool handlers — they're the single source
 * of truth for validation, provenance stamping, AND the BullMQ scheduler /
 * job wiring. Both HTTP and agent/MCP code paths now agree on the side effects.
 *
 *   POST /                  → handleCreateRoutine (handler upserts scheduler)
 *   PUT  /:id               → handleUpdateRoutine (handler re-upserts on cron/tz change)
 *   DELETE /:id             → handleDeleteRoutine (handler removes scheduler)
 *   POST /:id/run-now       → handleRunRoutineNow (handler enqueues with idempotent jobId)
 *   POST /:id/mailbox-waits/:runId/run → Run now of a run waiting for the owner's
 *                             private mailbox, from the owner's own browser (routine-mailbox-wait.ts)
 *   POST /:id/mailbox-waits/:runId/dismiss → dismiss it instead (the owner only)
 *   GET  /:id/runs          → routine_runs ORDER BY ran_at DESC LIMIT 50
 *   GET  /entity-runs       → the recent runs fired on one record, across the readable routines
 *   GET  /scope-options     → the scopes the caller may put on a routine (D20 picker)
 *   PUT  /:id/node-placement → the folder, repo and model of the routine's node runs (P2-D6)
 */
import { createRoutineRequestSchema, updateRoutineRequestSchema } from "@liaison/shared"
import { and, desc, eq, inArray, isNull, lt, or, sql } from "drizzle-orm"
import { type Context, Hono } from "hono"
import { HTTPException } from "hono/http-exception"
import { z } from "zod"
import type { AppEnv } from "~/app"
import { withPrivilegedDb } from "~/db/privileged"
import { withRlsContext } from "~/db/rls"
import {
  agents as agentsTbl,
  messages,
  routineRuns,
  routines as routinesTbl,
} from "~/db/schema/kernel"
import { extractRlsContext, withRequestRls } from "~/lib/request-rls"
import { zValidator } from "~/lib/validate"
import {
  ReassignAssetNotFoundError,
  ReassignForbiddenError,
  ReassignTargetNotFoundError,
  reassignAssetOwner,
} from "~/modules/agent/directory/reassign"
import { reassignOwnerSchema } from "~/modules/agent/directory/reassign-schema"
import { isScopeCovered } from "~/modules/agent/scopes/scope-coverage"
import { buildAppContext, errToStatus, handlerResult } from "~/modules/agent/skills/handler-rpc"
import {
  APP_RUN_ROUTINE_REFUSAL,
  agentWriteAuthority,
  handleCreateRoutine,
  handleDeleteRoutine,
  handleEnableRoutineTemplate,
  handleListRoutineEvents,
  handleRunRoutineNow,
  handleUpdateRoutine,
} from "~/modules/agent/tools/skills-routines-tools"
import { routineTemplateRegistry } from "~/modules/apps/app-registries"
import { getScopeCatalog } from "~/modules/permissions/scope-catalog"
import { listMessages } from "~/modules/threads/message"
import { flowRecordSource, readFlowRecords } from "./flow-records"
import { isAppRunRoutine, MORNING_BRIEF_TEMPLATE_KEY } from "./kernel-routine-templates"
import { firstMessageAfter, readRunSlices, runWindow } from "./routine-run-window"

/**
 * The two `ownerAgentId` refusals `resolveOwnerAgentForWrite` can return, as
 * HTTP. They are answered with the `{ error: { code, message } }` envelope
 * rather than an `HTTPException` message, because the client acts on the CODE:
 * `agent_write_forbidden` is "ask an admin", `agent_not_found` is "that agent
 * is not yours to write for, or does not exist" and must stay indistinguishable
 * from a plain miss.
 */
function ownerAgentErrorStatus(code: string): 403 | 404 | null {
  if (code === "agent_write_forbidden") return 403
  if (code === "agent_not_found") return 404
  return null
}

/**
 * `canWrite` per listed row (P4c-T32b): the A15 answer for THIS viewer, so the
 * agent page's Routines tab renders its edit affordances from the rule itself
 * instead of a client-side guess at it. A row whose owning agent is missing
 * (a pre-backfill NULL `owner_agent_id`) is `false`.
 */
async function withCanWrite<T extends { ownerAgentId: string | null }>(
  actor: { orgId: string; userId: string; scopes: string[] },
  rows: T[],
): Promise<Array<T & { canWrite: boolean }>> {
  const authority = await agentWriteAuthority(
    actor,
    rows.map((r) => r.ownerAgentId),
    "routine",
  )
  return rows.map((r) => ({ ...r, canWrite: authority.get(r.ownerAgentId ?? "") ?? false }))
}

/** A run's step as a list row carries it: what a progress strip draws, no notes or outputs. */
interface StepSummary {
  id: string
  type?: string
  state: string
  startedAt?: string | null
  endedAt?: string | null
}

function stepSummaries(steps: unknown): StepSummary[] | null {
  if (!Array.isArray(steps)) return null
  return steps.flatMap((s) => {
    if (!s || typeof s !== "object") return []
    const r = s as Record<string, unknown>
    if (typeof r.id !== "string" || typeof r.state !== "string") return []
    return [
      {
        id: r.id,
        ...(typeof r.type === "string" ? { type: r.type } : {}),
        state: r.state,
        ...(typeof r.startedAt === "string" || r.startedAt === null
          ? { startedAt: r.startedAt as string | null }
          : {}),
        ...(typeof r.endedAt === "string" || r.endedAt === null
          ? { endedAt: r.endedAt as string | null }
          : {}),
      },
    ]
  })
}

/**
 * `?includeLastRun=1` on the list: each listed routine's latest run (id, when, status, its steps'
 * states), read in one query for the whole page, so a list that draws run progress makes one
 * request instead of one per row. The rows are already the caller's readable routines.
 */
async function withLastRun<T extends { id: string }>(
  c: Context<AppEnv>,
  orgId: string,
  rows: T[],
): Promise<
  Array<
    T & {
      lastRun?: { id: string; ranAt: Date; status: string; steps: StepSummary[] | null } | null
    }
  >
> {
  const flag = c.req.query("includeLastRun")
  if (flag !== "1" && flag !== "true") return rows
  if (rows.length === 0) return rows
  const latest = await withPrivilegedDb(orgId, "routines-list-last-run", (tx) =>
    tx
      .selectDistinctOn([routineRuns.routineId], {
        id: routineRuns.id,
        routineId: routineRuns.routineId,
        ranAt: routineRuns.ranAt,
        status: routineRuns.status,
        steps: routineRuns.steps,
      })
      .from(routineRuns)
      .where(
        and(
          eq(routineRuns.orgId, orgId),
          inArray(
            routineRuns.routineId,
            rows.map((r) => r.id),
          ),
        ),
      )
      .orderBy(routineRuns.routineId, desc(routineRuns.ranAt), desc(routineRuns.id)),
  )
  const byRoutine = new Map(latest.map((r) => [r.routineId, r]))
  return rows.map((r) => {
    const run = byRoutine.get(r.id)
    return {
      ...r,
      lastRun: run
        ? { id: run.id, ranAt: run.ranAt, status: run.status, steps: stepSummaries(run.steps) }
        : null,
    }
  })
}

export const routinesRoutes = new Hono<AppEnv>()

// ---- GET /api/agent/routines ---------------------------------------------
// `?visibility=mine` (default) → the caller's own routines.
// `?visibility=shared` → org-shared routines from any owner.
// `?ownerAgentId=` (P4c-T32) → the agent page's Routines tab: what THIS agent
// owns, read under the caller's own RLS (`routines_select`, 0048) rather than
// the visibility split above, so an owner_agent_id the caller cannot see (a
// role agent's private routine, another colleague's personal agent, or one
// that does not exist) yields an empty list, never an error.
routinesRoutes.get("/", async (c) => {
  const actor = extractRlsContext(c)
  const ownerAgentId = c.req.query("ownerAgentId")
  if (ownerAgentId) {
    const visible = await withRlsContext(actor, (tx) =>
      tx
        .select()
        .from(routinesTbl)
        .where(and(eq(routinesTbl.orgId, actor.orgId), eq(routinesTbl.ownerAgentId, ownerAgentId))),
    )
    // The caller's OWN routines on this agent too (a personal routine on a role
    // agent, which the select policy keeps to personal agents): the person who
    // made it can always find it again where they made it (walk N12).
    const own = await withPrivilegedDb(actor.orgId, "routines-list-own-on-agent", (tx) =>
      tx
        .select()
        .from(routinesTbl)
        .where(
          and(
            eq(routinesTbl.orgId, actor.orgId),
            eq(routinesTbl.ownerAgentId, ownerAgentId),
            eq(routinesTbl.ownerUserId, actor.userId),
          ),
        ),
    )
    // A routine with NO owner agent (made before routines had one) runs for its
    // owner, so it lives under the owner's personal agent: listed there, and only
    // to that owner.
    const unassigned = await withPrivilegedDb(
      actor.orgId,
      "routines-list-unassigned",
      async (tx) => {
        const [personal] = await tx
          .select({ id: agentsTbl.id })
          .from(agentsTbl)
          .where(
            and(
              eq(agentsTbl.id, ownerAgentId),
              eq(agentsTbl.orgId, actor.orgId),
              eq(agentsTbl.kind, "personal"),
              eq(agentsTbl.ownerUserId, actor.userId),
            ),
          )
          .limit(1)
        if (!personal) return []
        return tx
          .select()
          .from(routinesTbl)
          .where(
            and(
              eq(routinesTbl.orgId, actor.orgId),
              isNull(routinesTbl.ownerAgentId),
              eq(routinesTbl.ownerUserId, actor.userId),
            ),
          )
      },
    )
    const seen = new Set(visible.map((r) => r.id))
    const rows = [...visible]
    for (const r of [...own, ...unassigned]) {
      if (seen.has(r.id)) continue
      seen.add(r.id)
      rows.push(r)
    }
    rows.sort((a, b) => a.name.localeCompare(b.name))
    return c.json({ data: await withLastRun(c, actor.orgId, await withCanWrite(actor, rows)) })
  }
  // A project's automations (0303): the routines the caller sees (their own, or shared) whose
  // event filter names that project.
  const projectId = c.req.query("projectId")
  if (projectId) {
    if (!z.string().uuid().safeParse(projectId).success) {
      throw new HTTPException(400, { message: "Invalid projectId" })
    }
    const rows = await withPrivilegedDb(actor.orgId, "routines-list-project", (tx) =>
      tx
        .select()
        .from(routinesTbl)
        .where(
          and(
            eq(routinesTbl.orgId, actor.orgId),
            or(eq(routinesTbl.ownerUserId, actor.userId), eq(routinesTbl.visibility, "shared")),
            sql`${routinesTbl.eventFilter}->>'projectId' = ${projectId.toLowerCase()}`,
          ),
        ),
    )
    rows.sort((a, b) => a.name.localeCompare(b.name))
    return c.json({ data: await withLastRun(c, actor.orgId, await withCanWrite(actor, rows)) })
  }
  const visibility = c.req.query("visibility") === "shared" ? "shared" : "mine"
  const rows = await withPrivilegedDb(actor.orgId, "routines-list", (tx) =>
    tx
      .select()
      .from(routinesTbl)
      .where(
        visibility === "shared"
          ? and(eq(routinesTbl.orgId, actor.orgId), eq(routinesTbl.visibility, "shared"))
          : and(eq(routinesTbl.orgId, actor.orgId), eq(routinesTbl.ownerUserId, actor.userId)),
      ),
  )
  rows.sort((a, b) => a.name.localeCompare(b.name))
  return c.json({ data: await withLastRun(c, actor.orgId, await withCanWrite(actor, rows)) })
})

// ---- GET /api/agent/routines/scope-options (D20) ---------------------------
// What the routine editor's scope picker may ADD: the catalog scopes the caller holds (a glob or
// wildcard grant counts), each with its description so the picker reads as words. A routine runs
// as its owner and its scopes are capped at the editor's own, so nothing else is offered; the
// update handler enforces the same cap. Bare app names and the global wildcard are not routine
// scopes and are left out.
//
// Registered BEFORE `/:id/...` so `scope-options` is never read as a routine id.
routinesRoutes.get("/scope-options", (c) => {
  const actor = extractRlsContext(c)
  const options = getScopeCatalog(actor.orgId).filter(
    (entry) =>
      entry.scope !== "*" &&
      entry.scope.includes(":") &&
      isScopeCovered([entry.scope], actor.scopes),
  )
  return c.json({ data: options })
})

// ---- GET /api/agent/routines/latest-brief ---------------------------------
// Home's Agents > "Morning brief" (D21): the caller's OWN morning-brief routine
// (the kernel template, S28), its last run, and the latest agent message in its
// output thread, so Home can open the brief where it is. `null` when the caller
// has none: Home then offers to set one up. Registered BEFORE `/:id/...`.
routinesRoutes.get("/latest-brief", async (c) => {
  const actor = extractRlsContext(c)
  const data = await withPrivilegedDb(actor.orgId, "routines-latest-brief", async (tx) => {
    const [routine] = await tx
      .select({
        id: routinesTbl.id,
        name: routinesTbl.name,
        status: routinesTbl.status,
        enabled: routinesTbl.enabled,
        lastRunAt: routinesTbl.lastRunAt,
        lastRunStatus: routinesTbl.lastRunStatus,
        outputThreadId: routinesTbl.outputThreadId,
      })
      .from(routinesTbl)
      .where(
        and(
          eq(routinesTbl.orgId, actor.orgId),
          eq(routinesTbl.ownerUserId, actor.userId),
          eq(routinesTbl.templateKey, MORNING_BRIEF_TEMPLATE_KEY),
        ),
      )
      .orderBy(desc(routinesTbl.lastRunAt))
      .limit(1)
    if (!routine) return null
    // The brief's one time is its newest message's, the same row and the same
    // column Home's brief card reads (GET /api/home/brief), so the two never
    // show two different times. The routine's last run is not the brief's time.
    let messageId: string | null = null
    let messageAt: string | null = null
    if (routine.outputThreadId) {
      const [latest] = await tx
        .select({ id: messages.id, createdAt: messages.createdAt })
        .from(messages)
        .where(
          and(
            eq(messages.orgId, actor.orgId),
            eq(messages.threadId, routine.outputThreadId),
            eq(messages.authorType, "agent"),
            isNull(messages.deletedAt),
          ),
        )
        .orderBy(desc(messages.createdAt))
        .limit(1)
      messageId = latest?.id ?? null
      messageAt = latest ? latest.createdAt.toISOString() : null
    }
    return {
      routineId: routine.id,
      name: routine.name,
      status: routine.status,
      enabled: routine.enabled,
      lastRunAt: routine.lastRunAt ? routine.lastRunAt.toISOString() : null,
      lastRunStatus: routine.lastRunStatus,
      outputThreadId: routine.outputThreadId,
      messageId,
      messageAt,
    }
  })
  return c.json({ data })
})

// ---- GET /api/agent/routines/events --------------------------------------
// The catalog of `app:entity:action` events a kind:'event' routine can bind to,
// for the create/edit event picker. It is THE SAME catalog the `list_routine_events`
// agent tool returns, through the tool's own handler: a second copy assembled here
// would drift from what the routine subscriber actually accepts, and the picker
// would offer an event no routine can bind to.
//
// Registered BEFORE `/:id/...` so `events` is never read as a routine id.
routinesRoutes.get("/events", async (c) => {
  const app = c.req.query("app")
  const entity = c.req.query("entity")
  const { events } = await handleListRoutineEvents(
    { ...(app ? { app } : {}), ...(entity ? { entity } : {}) },
    buildAppContext(c),
  )
  // Split once, here: every consumer of this list groups by app and labels by
  // entity and action, and splitting in each of them is the same parse written
  // twice. `event` stays the whole string, which is what a routine stores.
  return c.json({
    data: events.map((e) => {
      const [, entityPart = "", actionPart = ""] = e.event.split(":")
      return { event: e.event, app: e.app, entity: entityPart, action: actionPart }
    }),
  })
})

// ---- GET /api/agent/routines/entity-runs ----------------------------------
// The recent runs fired on one record (`routine_runs.event_entity_id`), across
// every routine the caller may read, newest first: a record's detail view shows
// what the automations did with it. `app` and `entity` name the record's family,
// which must declare a flow record (`entities.<e>.routineFlow`): the caller must
// read the record through that declared reader, under their own RLS, or the list
// is empty. Only runs that family's events fired count. Visibility of a routine is
// the run history's (`readableRoutine`): under the caller's select policy, or
// owned. A run is served as the view draws it: the routine's name and title, the
// run's status and times, and each step's state with a wait step's deadline; never
// its error, notes, outputs, pause state or flow context.
// Registered BEFORE `/:id/...` so `entity-runs` is never read as a routine id.
const ENTITY_RUNS_DEFAULT = 10
const ENTITY_RUNS_MAX = 50

/** A run's step as a record's view draws it: its state, times and a wait step's deadline. */
function entityRunSteps(steps: unknown): Array<StepSummary & { output?: { deadline: string } }> {
  if (!Array.isArray(steps)) return []
  const summaries = stepSummaries(steps) ?? []
  return summaries.map((st) => {
    const raw = steps.find(
      (x) => x && typeof x === "object" && (x as Record<string, unknown>).id === st.id,
    ) as { output?: unknown } | undefined
    const out = raw?.output
    const deadline =
      out && typeof out === "object" ? (out as Record<string, unknown>).deadline : undefined
    return typeof deadline === "string" ? { ...st, output: { deadline } } : st
  })
}

routinesRoutes.get("/entity-runs", async (c) => {
  const actor = extractRlsContext(c)
  const entityId = c.req.query("entityId") ?? ""
  if (!entityId || entityId.length > 200) {
    throw new HTTPException(400, { message: "entityId is required (at most 200 characters)" })
  }
  const app = c.req.query("app") ?? ""
  const entity = c.req.query("entity") ?? ""
  const src = flowRecordSource(actor.orgId, app, entity)
  if (!src) {
    throw new HTTPException(400, {
      message: "app and entity must name a record family that declares a flow record",
    })
  }
  const limit = Math.min(
    Math.max(Number(c.req.query("limit") ?? ENTITY_RUNS_DEFAULT) || ENTITY_RUNS_DEFAULT, 1),
    ENTITY_RUNS_MAX,
  )
  // The record itself, read as the caller through its app's declared reader: no read, no runs.
  const records = await readFlowRecords(src, actor, [entityId], { includeArchived: true })
  if (!records.some((r) => r.id === entityId)) return c.json({ data: [] })

  const columns = { id: routinesTbl.id, name: routinesTbl.name, title: routinesTbl.title }
  const visible = await withRlsContext(actor, (tx) =>
    tx.select(columns).from(routinesTbl).where(eq(routinesTbl.orgId, actor.orgId)),
  )
  const own = await withPrivilegedDb(actor.orgId, "routines-entity-runs-own", (tx) =>
    tx
      .select(columns)
      .from(routinesTbl)
      .where(and(eq(routinesTbl.orgId, actor.orgId), eq(routinesTbl.ownerUserId, actor.userId))),
  )
  const readable = new Map([...visible, ...own].map((r) => [r.id, r]))
  if (readable.size === 0) return c.json({ data: [] })

  const familyPrefix = `${src.app}.${src.entity}.`
  const rows = await withPrivilegedDb(actor.orgId, "routines-entity-runs", (tx) =>
    tx
      .select({
        id: routineRuns.id,
        routineId: routineRuns.routineId,
        ranAt: routineRuns.ranAt,
        startedAt: routineRuns.startedAt,
        status: routineRuns.status,
        steps: routineRuns.steps,
      })
      .from(routineRuns)
      .where(
        and(
          eq(routineRuns.orgId, actor.orgId),
          inArray(routineRuns.routineId, [...readable.keys()]),
          eq(routineRuns.eventEntityId, entityId),
          sql`left(${routineRuns.triggerLabel}, ${familyPrefix.length}) = ${familyPrefix}`,
        ),
      )
      .orderBy(desc(routineRuns.ranAt), desc(routineRuns.id))
      .limit(limit),
  )
  return c.json({
    data: rows.map((r) => {
      const routine = readable.get(r.routineId)
      return {
        id: r.id,
        routineId: r.routineId,
        routineName: routine?.name ?? "",
        routineTitle: routine?.title ?? routine?.name ?? "",
        ranAt: r.ranAt,
        startedAt: r.startedAt,
        status: r.status,
        steps: entityRunSteps(r.steps),
      }
    }),
  })
})

// ---- GET /api/agent/routines/templates -----------------------------------
// Component A: list the app-provided routine templates registered for the
// caller's org, annotated with whether an instance already exists (so the UI
// can render "Enable" vs "Enabled").
routinesRoutes.get("/templates", async (c) => {
  const actor = extractRlsContext(c)
  const templates: Array<{
    appName: string
    templateKey: string
    description: string
    kind: string
    enabled: boolean
    event?: string
    scopes?: string[]
    prompt?: string
    flow?: Record<string, unknown>
    eventFilter?: Record<string, unknown>
  }> = []
  for (const [key, tpl] of routineTemplateRegistry.entriesOf(actor.orgId)) {
    const [, appName, templateKey] = key
    templates.push({
      appName,
      templateKey,
      description: tpl.description,
      kind: tpl.kind,
      enabled: false,
      // A flow template (0303) carries what the editor prefills: its trigger, scopes, summary,
      // steps and filter, placeholders unfilled (resolveRoutineTemplatePlaceholders fills them).
      ...(tpl.flow
        ? {
            event: tpl.event,
            scopes: tpl.scopes,
            prompt: tpl.promptTemplate,
            flow: tpl.flow,
            ...(tpl.eventFilter ? { eventFilter: tpl.eventFilter } : {}),
          }
        : {}),
    })
  }
  // Mark which templates already have an instantiated routine for this org.
  if (templates.length > 0) {
    const rows = await withPrivilegedDb(actor.orgId, "routine-templates-instances", (tx) =>
      tx
        .select({
          appName: routinesTbl.appName,
          templateKey: routinesTbl.templateKey,
          sourceKind: routinesTbl.sourceKind,
          ownerUserId: routinesTbl.ownerUserId,
        })
        .from(routinesTbl)
        .where(
          and(
            eq(routinesTbl.orgId, actor.orgId),
            inArray(routinesTbl.sourceKind, ["app", "kernel"]),
          ),
        ),
    )
    // A kernel template's routine has no app; the registry files it under "kernel".
    // It is personal, so it reads as enabled only for the caller's own routine.
    const have = new Set(
      rows
        .filter((r) => r.sourceKind !== "kernel" || r.ownerUserId === actor.userId)
        .map((r) => `${r.sourceKind === "kernel" ? "kernel" : r.appName}\0${r.templateKey}`),
    )
    for (const t of templates) {
      if (have.has(`${t.appName}\0${t.templateKey}`)) t.enabled = true
    }
  }
  templates.sort((a, b) =>
    `${a.appName}${a.templateKey}`.localeCompare(`${b.appName}${b.templateKey}`),
  )
  return c.json({ data: templates })
})

// ---- POST /api/agent/routines/templates/:app/:key/enable -----------------
// Instantiate an app routine template as one of the caller's routines.
routinesRoutes.post("/templates/:app/:key/enable", async (c) => {
  const appName = c.req.param("app")
  const templateKey = c.req.param("key")
  const ctx = buildAppContext(c)
  // Optional body: { time?: "HH:MM", timezone?: IANA } (a kernel template's time, S28).
  const body = (await c.req.json().catch(() => ({}))) as { time?: unknown; timezone?: unknown }
  const result = await handleEnableRoutineTemplate(
    {
      appName,
      templateKey,
      ...(typeof body.time === "string" ? { time: body.time } : {}),
      ...(typeof body.timezone === "string" ? { timezone: body.timezone } : {}),
    },
    ctx,
  )
  const r = handlerResult<{ routine: unknown }>(result)
  if (!r.ok) throw new HTTPException(errToStatus(r.code), { message: r.message })
  return c.json({ data: r.data.routine }, 201)
})

// ---- Node placement (P2-D6, L26, m7) -------------------------------------
// Where a node run of this routine works and on which model: a shared folder's
// name, or a git URL the node clones (https or ssh only, the P1b B8 rule), and
// a model id. REST only. It travels with the create or the edit (`nodePlacement`)
// so the routine and its placement are saved together, or on its own route.

/** https://, ssh:// (or git+ssh://), or scp-like `user@host:path`; never a local path or an option. */
function isCloneableRepoUrl(url: string): boolean {
  const u = url.trim()
  if (!u || u.startsWith("-") || /\s/.test(u)) return false
  if (/^[A-Za-z0-9+.-]+::/.test(u)) return false
  if (!u.includes("://") && /^(?:[A-Za-z0-9._-]+@)?[A-Za-z0-9.-]+:(?!\/\/)\S+$/.test(u)) {
    return !u.startsWith("/")
  }
  try {
    const parsed = new URL(u)
    if (!parsed.hostname) return false
    return (
      parsed.protocol === "https:" || parsed.protocol === "ssh:" || parsed.protocol === "git+ssh:"
    )
  } catch {
    return false
  }
}

const nodePlacementSchema = z
  .object({
    folder: z.string().trim().min(1).max(200).nullable().optional(),
    repo: z
      .string()
      .trim()
      .min(1)
      .max(500)
      .refine(isCloneableRepoUrl, "repo must be an https or ssh git URL")
      .nullable()
      .optional(),
    model: z.string().trim().min(1).max(200).nullable().optional(),
  })
  .strict()

type NodePlacement = z.infer<typeof nodePlacementSchema>
type PlacementCheck =
  | { ok: true; placement: NodePlacement | null }
  | { ok: false; status: 400 | 422; code: string; message: string }

/**
 * The `nodePlacement` a create or an edit carries (m7, REST only: the shared
 * routine schemas are the agent tool's and stay as they are). Checked before
 * anything is written, so a refused placement saves nothing.
 */
function checkPlacement(raw: unknown): PlacementCheck {
  if (raw === undefined || raw === null) return { ok: true, placement: null }
  const parsed = nodePlacementSchema.safeParse(raw)
  if (!parsed.success) {
    return {
      ok: false,
      status: 400,
      code: "invalid_node_placement",
      message: parsed.error.issues[0]?.message ?? "Invalid node placement.",
    }
  }
  if (parsed.data.folder && parsed.data.repo) {
    return {
      ok: false,
      status: 422,
      code: "folder_and_repo",
      message: "Give either a folder or a repo, not both.",
    }
  }
  return { ok: true, placement: parsed.data }
}

async function placementFromBody(c: Context<AppEnv>): Promise<PlacementCheck> {
  const raw = (await c.req.json().catch(() => ({}))) as { nodePlacement?: unknown }
  return checkPlacement(raw?.nodePlacement)
}

const PLACEMENT_OWNER_ONLY = {
  code: "placement_owner_only",
  message:
    "Only the routine's owner can choose its folder, repository and model: they are on the owner's own computer.",
} as const

/** The columns a placement writes: a folder replaces a repo and the other way round. */
function placementSet(body: NodePlacement): {
  folder?: string | null
  repo?: string | null
  model?: string | null
} {
  const set: { folder?: string | null; repo?: string | null; model?: string | null } = {}
  if (body.folder !== undefined) set.folder = body.folder
  if (body.repo !== undefined) set.repo = body.repo
  if (body.model !== undefined) set.model = body.model
  if (body.folder) set.repo = null
  if (body.repo) set.folder = null
  return set
}

/** Write a placement as the routine's owner (their own RLS); null when not theirs. */
async function writePlacement(
  actor: ReturnType<typeof extractRlsContext>,
  id: string,
  body: NodePlacement,
) {
  const [row] = await withRlsContext(actor, (tx) =>
    tx
      .update(routinesTbl)
      .set({ ...placementSet(body), updatedAt: new Date() })
      .where(
        and(
          eq(routinesTbl.id, id),
          eq(routinesTbl.orgId, actor.orgId),
          eq(routinesTbl.ownerUserId, actor.userId),
        ),
      )
      .returning(),
  )
  return row ?? null
}

// ---- POST /api/agent/routines --------------------------------------------
// The handler is the single source of truth for both the DB insert AND the
// BullMQ scheduler upsert — see handleCreateRoutine. This route is a thin RPC.
//
// `ownerAgentId` (P4c-T32b) creates the routine FOR that agent instead of the
// run-as user's own personal agent. A15 decides, in the handler's own resolver;
// a refusal is an explicit 403 `agent_write_forbidden` (or a 404 for an agent
// the caller cannot see), never a silent landing on the caller's own agent.
routinesRoutes.post("/", zValidator("json", createRoutineRequestSchema), async (c) => {
  const body = c.req.valid("json")
  const actor = extractRlsContext(c)
  const placed = await placementFromBody(c)
  if (!placed.ok) {
    return c.json({ error: { code: placed.code, message: placed.message } }, placed.status)
  }
  // A routine set up to run as someone else runs on THEIR node: not the creator's to place.
  if (placed.placement && body.ownerUserId && body.ownerUserId !== actor.userId) {
    return c.json({ error: PLACEMENT_OWNER_ONLY }, 403)
  }
  const ctx = buildAppContext(c)
  const result = await handleCreateRoutine(body, ctx)
  const r = handlerResult<{
    routine: { id: string } & Record<string, unknown>
    requestUuid: string
  }>(result)
  if (!r.ok) {
    const ownerStatus = ownerAgentErrorStatus(r.code)
    if (ownerStatus) return c.json({ error: { code: r.code, message: r.message } }, ownerStatus)
    if (r.code === "scheduler_register_failed") {
      throw new HTTPException(500, { message: r.message })
    }
    throw new HTTPException(errToStatus(r.code), { message: r.message })
  }
  if (placed.placement) {
    const row = await writePlacement(actor, r.data.routine.id, placed.placement).catch(() => null)
    if (!row) {
      // Never leave a routine without the placement the owner asked for: undo the create,
      // so a retry does not make a second routine.
      await withPrivilegedDb(actor.orgId, "routines-create-placement-undo", (tx) =>
        tx
          .delete(routinesTbl)
          .where(and(eq(routinesTbl.id, r.data.routine.id), eq(routinesTbl.orgId, actor.orgId))),
      )
      throw new HTTPException(500, {
        message: "The routine's folder and model could not be saved.",
      })
    }
    return c.json(
      { data: { ...r.data.routine, folder: row.folder, repo: row.repo, model: row.model } },
      201,
    )
  }
  return c.json({ data: r.data.routine }, 201)
})

// ---- PUT /api/agent/routines/:id -----------------------------------------
// Handler re-upserts the scheduler when cron/timezone change.
/** The routine's `enabled` flag before an update, or undefined when it is not this org's. */
async function readRoutineEnabled(orgId: string, id: string): Promise<boolean | undefined> {
  if (!z.string().uuid().safeParse(id).success) return undefined
  const [row] = await withPrivilegedDb(orgId, "routines-enabled-before", (tx) =>
    tx
      .select({ enabled: routinesTbl.enabled })
      .from(routinesTbl)
      .where(and(eq(routinesTbl.id, id), eq(routinesTbl.orgId, orgId))),
  )
  return row?.enabled
}

/**
 * The durable `kernel/routine:update` for a change of the enabled flag (ids,
 * the flag and, for a shared routine, its name): a guided tour's "switch it
 * on" beat completes on it, whichever tab the person used, and only for the
 * routine it names.
 */
async function queueRoutineEnabledChanged(
  actor: ReturnType<typeof extractRlsContext>,
  routineId: string,
  enabled: boolean,
  name: string | null,
): Promise<void> {
  await withPrivilegedDb(actor.orgId, "routines-enabled-event", (tx) =>
    tx.queueEvent({
      app: "kernel",
      entity: "routine",
      action: "update",
      entityId: routineId,
      data: { id: routineId, routineId, enabled, name },
      actorId: actor.userId,
      actorType: "user",
      orgId: actor.orgId,
      timestamp: new Date().toISOString(),
    }),
  )
}

routinesRoutes.put("/:id", zValidator("json", updateRoutineRequestSchema), async (c) => {
  const id = c.req.param("id")
  const body = c.req.valid("json")
  const actor = extractRlsContext(c)
  const placed = await placementFromBody(c)
  if (!placed.ok) {
    return c.json({ error: { code: placed.code, message: placed.message } }, placed.status)
  }
  if (placed.placement && z.string().uuid().safeParse(id).success) {
    // An admin may edit another member's routine, but its placement is on the owner's
    // computer: refused before anything is saved, in words (m7).
    const [owner] = await withPrivilegedDb(actor.orgId, "routines-placement-owner", (tx) =>
      tx
        .select({ ownerUserId: routinesTbl.ownerUserId })
        .from(routinesTbl)
        .where(and(eq(routinesTbl.id, id), eq(routinesTbl.orgId, actor.orgId))),
    )
    if (owner && owner.ownerUserId !== actor.userId) {
      return c.json({ error: PLACEMENT_OWNER_ONLY }, 403)
    }
  }
  const ctx = buildAppContext(c)
  const wasEnabled =
    body.enabled !== undefined ? await readRoutineEnabled(actor.orgId, id) : undefined
  const result = await handleUpdateRoutine({ id, ...body }, ctx)
  const r = handlerResult<{ routine: Record<string, unknown>; requestUuid: string }>(result)
  if (!r.ok) throw new HTTPException(errToStatus(r.code), { message: r.message })
  if (body.enabled !== undefined && wasEnabled !== undefined && wasEnabled !== body.enabled) {
    // The name rides only on a shared routine's frame: every routines reader
    // sees a shared routine anyway, and a personal one's name stays its owner's.
    const routine = r.data.routine
    const name =
      routine.visibility === "shared" && typeof routine.name === "string" ? routine.name : null
    await queueRoutineEnabledChanged(actor, id, body.enabled, name)
  }
  if (placed.placement) {
    const row = await writePlacement(actor, id, placed.placement)
    if (!row) return c.json({ error: PLACEMENT_OWNER_ONLY }, 403)
    return c.json({
      data: { ...r.data.routine, folder: row.folder, repo: row.repo, model: row.model },
    })
  }
  return c.json({ data: r.data.routine })
})

// ---- PUT /api/agent/routines/:id/node-placement (P2-D6, L26) -------------
// Where a node run of this routine works and on which model: a shared folder's
// name, or a git URL the node clones (https or ssh only, the P1b B8 rule), and
// a model id. REST only: the agent tool schemas stay as they are (frozen agent
// context). The routine's owner only, under their own RLS; anyone else gets
// 404. `null` clears a field; an omitted field is left as it is.

routinesRoutes.put("/:id/node-placement", zValidator("json", nodePlacementSchema), async (c) => {
  const actor = extractRlsContext(c)
  const id = c.req.param("id")
  const body = c.req.valid("json")
  if (!z.string().uuid().safeParse(id).success) {
    throw new HTTPException(404, { message: "Routine not found" })
  }
  if (body.folder && body.repo) {
    return c.json(
      { error: { code: "folder_and_repo", message: "Give either a folder or a repo, not both." } },
      422,
    )
  }
  const row = await writePlacement(actor, id, body)
  if (!row) throw new HTTPException(404, { message: "Routine not found" })
  return c.json({ data: row })
})

// ---- PATCH /api/agent/routines/:id ---------------------------------------
// Ownership transfer only (P4b-D5): `{ ownerAgentId }` hands this routine to
// another live agent of the org, which is what unblocks archiving the agent
// that owns it. Every other field still goes through the PUT above, whose
// handler owns validation and the scheduler wiring.
routinesRoutes.patch("/:id", zValidator("json", reassignOwnerSchema), async (c) => {
  const actor = extractRlsContext(c)
  const { ownerAgentId } = c.req.valid("json")
  // An app-run routine acts as the person who switched its app setting on:
  // handing it to an agent would move whose permissions the app acts with.
  const id = c.req.param("id")
  if (z.string().uuid().safeParse(id).success) {
    const [row] = await withPrivilegedDb(actor.orgId, "routines-reassign-kind", (tx) =>
      tx
        .select({ templateKey: routinesTbl.templateKey })
        .from(routinesTbl)
        .where(and(eq(routinesTbl.id, id), eq(routinesTbl.orgId, actor.orgId))),
    )
    if (row && isAppRunRoutine(row.templateKey)) {
      return c.json(APP_RUN_ROUTINE_REFUSAL, 409)
    }
  }
  try {
    const result = await reassignAssetOwner(actor, {
      asset: "routines",
      assetId: c.req.param("id"),
      ownerAgentId,
    })
    return c.json({ data: result })
  } catch (err) {
    if (err instanceof ReassignTargetNotFoundError || err instanceof ReassignAssetNotFoundError) {
      throw new HTTPException(404, { message: err.message })
    }
    if (err instanceof ReassignForbiddenError) {
      throw new HTTPException(403, { message: err.message })
    }
    throw err
  }
})

// ---- DELETE /api/agent/routines/:id --------------------------------------
// Handler removes the BullMQ scheduler.
routinesRoutes.delete("/:id", async (c) => {
  const id = c.req.param("id")
  const ctx = buildAppContext(c)
  const result = await handleDeleteRoutine({ id }, ctx)
  const r = handlerResult<{ routine: unknown; requestUuid: string }>(result)
  if (!r.ok) throw new HTTPException(errToStatus(r.code), { message: r.message })
  return c.body(null, 204)
})

// ---- POST /api/agent/routines/:id/run-now --------------------------------
// Delegates to handleRunRoutineNow — the handler owns ownership check + the
// BullMQ enqueue with idempotent jobId. Single source of truth across HTTP,
// agent kernel-tool, and MCP entry points.
routinesRoutes.post("/:id/run-now", async (c) => {
  const id = c.req.param("id")
  const ctx = buildAppContext(c)
  // Optional TARGETED-REPLAY body for kind:'event' routines: { event_data,
  // event_entity_id } simulates the routine's OWN trigger event with that payload
  // (see handleRunRoutineNow) so the routine can be run ON a chosen entity.
  const body = (await c.req.json().catch(() => null)) as {
    event_data?: Record<string, unknown>
    event_entity_id?: string
  } | null
  const result = await handleRunRoutineNow(
    {
      id,
      ...(body?.event_data !== undefined ? { event_data: body.event_data } : {}),
      ...(typeof body?.event_entity_id === "string"
        ? { event_entity_id: body.event_entity_id }
        : {}),
    },
    ctx,
  )
  const r = handlerResult<{ routine: unknown; requestUuid: string }>(result)
  if (!r.ok) throw new HTTPException(errToStatus(r.code), { message: r.message })
  return c.json({ data: { queued: true, requestUuid: r.data.requestUuid } }, 202)
})

// ---- POST /api/agent/routines/:id/mailbox-waits/:runId/run ---------------
// Run now of a run that waits for its owner's private mailbox. Only the
// mailbox owner, signed in as themselves, with the turn nonce their browser
// minted for this run. The answer carries the handoff request the browser
// answers in the same click (the mail that started the run), so the window may
// close right after, and says whether the run is queued behind a run of the
// same routine. Every refusal is a named error, never a 202 that does nothing
// (routine-mailbox-wait.ts).
const mailboxWaitRunSchema = z.object({ turnNonce: z.string().min(8).max(128) }).strict()

routinesRoutes.post(
  "/:id/mailbox-waits/:runId/run",
  zValidator("json", mailboxWaitRunSchema),
  async (c) => {
    const actor = extractRlsContext(c)
    const id = c.req.param("id")
    const runId = c.req.param("runId")
    if (!z.string().uuid().safeParse(id).success || !z.string().uuid().safeParse(runId).success) {
      throw new HTTPException(404, { message: "Routine not found" })
    }
    if (!actor.userId) {
      throw new HTTPException(403, { message: "Only the mailbox owner can run this" })
    }
    const { runWaitingMailboxRun } = await import("./routine-mailbox-wait")
    const outcome = await runWaitingMailboxRun({
      orgId: actor.orgId,
      userId: actor.userId,
      routineId: id,
      runId,
      turnNonce: c.req.valid("json").turnNonce,
    })
    // `queued`: another run of the routine is running, this one starts right
    // after it. `handoff`: the broker request for the mail that started the
    // run, which the browser answers in this same click (routine-mailbox-wait.ts).
    if (outcome.ok) {
      return c.json(
        {
          data: {
            started: true,
            runId: outcome.runId,
            queued: outcome.queued,
            handoff: outcome.handoff,
          },
        },
        202,
      )
    }
    const status =
      outcome.code === "not_found"
        ? 404
        : outcome.code === "expired"
          ? 410
          : outcome.code === "claimed"
            ? 409
            : 403
    return c.json({ error: { code: outcome.code, message: outcome.message } }, status)
  },
)

// ---- POST /api/agent/routines/:id/mailbox-waits/:runId/dismiss -----------
// Dismiss a run that waits for its owner's private mailbox, from the owner's
// approvals list: it does not run, the run history says it was dismissed.
// Only the mailbox owner (routine-mailbox-wait.ts `dismissWaitingMailboxRun`).
routinesRoutes.post("/:id/mailbox-waits/:runId/dismiss", async (c) => {
  const actor = extractRlsContext(c)
  const id = c.req.param("id")
  const runId = c.req.param("runId")
  if (!z.string().uuid().safeParse(id).success || !z.string().uuid().safeParse(runId).success) {
    throw new HTTPException(404, { message: "Routine not found" })
  }
  if (!actor.userId) {
    throw new HTTPException(403, { message: "Only the mailbox owner can dismiss this" })
  }
  const { dismissWaitingMailboxRun } = await import("./routine-mailbox-wait")
  const outcome = await dismissWaitingMailboxRun({
    orgId: actor.orgId,
    userId: actor.userId,
    routineId: id,
    runId,
  })
  if (outcome.ok) return c.json({ data: { dismissed: true, runId: outcome.runId } })
  return c.json({ error: { code: outcome.code, message: outcome.message } }, 404)
})

// ---- GET /api/agent/routines/:id/runs ------------------------------------
// The run history the agent page draws per routine: each run's row plus what
// started it, whether it has a transcript, how many messages it wrote and its
// last agent line as a summary. The summary and the count are read under the
// caller's own RLS context, so they never say more than the thread would.
async function readableRoutine(c: Context<AppEnv>, id: string) {
  const actor = extractRlsContext(c)
  const columns = { id: routinesTbl.id, outputThreadId: routinesTbl.outputThreadId }
  const thisRoutine = and(eq(routinesTbl.id, id), eq(routinesTbl.orgId, actor.orgId))
  // Who may read the routine may read its history: the listing shows a shared routine to
  // everyone the select policy lets in, and answering "not found" for its runs broke that page
  // for all but the owner. Its owner too, as in the listing: a personal routine on a role agent
  // is outside that policy.
  const [visible] = await withRlsContext(actor, (tx) =>
    tx.select(columns).from(routinesTbl).where(thisRoutine),
  )
  const [routine] = visible
    ? [visible]
    : await withPrivilegedDb(actor.orgId, "routines-runs-check", (tx) =>
        tx
          .select(columns)
          .from(routinesTbl)
          .where(and(thisRoutine, eq(routinesTbl.ownerUserId, actor.userId))),
      )
  if (!routine) throw new HTTPException(404, { message: "Routine not found" })
  return { actor, routine }
}

/** A run history page, newest first. */
const RUNS_PAGE = 50

routinesRoutes.get("/:id/runs", async (c) => {
  const id = c.req.param("id")
  const { actor, routine } = await readableRoutine(c, id)
  // Paged newest first: `before=<run id>` returns the page older than that run
  // (a busy event routine has thousands of runs), `limit` caps a page at 100.
  const limit = Math.min(Math.max(Number(c.req.query("limit") ?? RUNS_PAGE) || RUNS_PAGE, 1), 100)
  const before = c.req.query("before") || null
  if (before && !z.string().uuid().safeParse(before).success) {
    throw new HTTPException(400, { message: "Invalid cursor" })
  }

  const rows = await withPrivilegedDb(actor.orgId, "routines-runs-list", async (tx) => {
    let cursor: { ranAt: Date; id: string } | null = null
    if (before) {
      const [row] = await tx
        .select({ ranAt: routineRuns.ranAt, id: routineRuns.id })
        .from(routineRuns)
        .where(
          and(
            eq(routineRuns.orgId, actor.orgId),
            eq(routineRuns.routineId, id),
            eq(routineRuns.id, before),
          ),
        )
        .limit(1)
      if (!row) throw new HTTPException(400, { message: "Invalid cursor" })
      cursor = row
    }
    return tx
      .select()
      .from(routineRuns)
      .where(
        and(
          eq(routineRuns.orgId, actor.orgId),
          eq(routineRuns.routineId, id),
          cursor
            ? or(
                lt(routineRuns.ranAt, cursor.ranAt),
                and(eq(routineRuns.ranAt, cursor.ranAt), lt(routineRuns.id, cursor.id)),
              )
            : undefined,
        ),
      )
      .orderBy(desc(routineRuns.ranAt), desc(routineRuns.id))
      .limit(limit)
  })
  const windows = rows.flatMap((r) => {
    const w = runWindow(r)
    return w ? [{ runId: r.id, ...w }] : []
  })
  const threadId = routine.outputThreadId
  const slices = threadId
    ? await withRequestRls(c, (tx) => readRunSlices(tx, { orgId: actor.orgId, threadId, windows }))
    : new Map<string, { summary: string | null; messageCount: number }>()
  return c.json({
    data: rows.map((r) => {
      const slice = slices.get(r.id)
      return {
        ...publicRun(r),
        outputThreadId: threadId,
        summary: slice?.summary ?? null,
        messageCount: slice?.messageCount ?? 0,
        hasTranscript: (slice?.messageCount ?? 0) > 0,
      }
    }),
  })
})

/**
 * A run row as the API serves it: without its pause state, which is the
 * resume's own bookkeeping (approval ids, what the agent wrote at the pause)
 * and is read by the worker only (routine-run-resume.ts).
 */
function publicRun<T extends { pauseState?: unknown }>(run: T): Omit<T, "pauseState"> {
  const { pauseState: _pauseState, ...rest } = run
  return rest
}

// ---- GET /api/agent/routines/:id/runs/:runId/messages ----------------------
// One run's transcript: the output thread's messages inside the run's slice,
// read through the thread's own message reader (the same RLS, visibility
// mirror and shape the chat view renders), oldest first.
const RUN_TRANSCRIPT_PAGE = 100

routinesRoutes.get("/:id/runs/:runId/messages", async (c) => {
  const id = c.req.param("id")
  const runId = c.req.param("runId")
  const { actor, routine } = await readableRoutine(c, id)
  const [run] = await withPrivilegedDb(actor.orgId, "routines-run-get", (tx) =>
    tx
      .select()
      .from(routineRuns)
      .where(
        and(
          eq(routineRuns.orgId, actor.orgId),
          eq(routineRuns.routineId, id),
          eq(routineRuns.id, runId),
        ),
      )
      .limit(1),
  )
  if (!run) throw new HTTPException(404, { message: "Run not found" })
  const threadId = routine.outputThreadId
  const window = runWindow(run)
  if (!threadId || !window) {
    return c.json({ data: { run: publicRun(run), outputThreadId: threadId, messages: [] } })
  }
  const messagesInRun = await withRequestRls(c, async (tx) => {
    const before = await firstMessageAfter(tx, {
      orgId: actor.orgId,
      threadId,
      to: window.to,
    })
    const page = await listMessages(tx, {
      orgId: actor.orgId,
      userId: actor.userId,
      threadId,
      limit: RUN_TRANSCRIPT_PAGE,
      before: before ?? undefined,
    })
    if (!page) return null
    // The reader pages newest first; a transcript reads oldest first.
    return [...page.messages].reverse().filter((m) => {
      const at = new Date(m.createdAt as string | Date).getTime()
      return at >= window.from.getTime() && at <= window.to.getTime()
    })
  })
  if (messagesInRun === null) throw new HTTPException(404, { message: "Run not found" })
  return c.json({
    data: { run: publicRun(run), outputThreadId: threadId, messages: messagesInRun },
  })
})
