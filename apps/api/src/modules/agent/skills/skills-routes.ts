// SPDX-License-Identifier: FSL-1.1-ALv2
/**
 * Phase 4 — Skills + app-skills HTTP routes.
 *
 * Mount: app.ts under `/api/agent/skills` and `/api/agent/app-skills`.
 *
 * Visibility uses the same `resolveAllSkills` helper as the context assembler
 * so the route and agent see the identical row set (Task 4.1 parity test).
 *
 * All mutating endpoints delegate to the gated tool handlers exported from
 * `~/modules/agent/tools/skills-routines-tools` — the route is a thin RPC wrapper
 * that supplies the AppContext + provenance (`actorType:'user'`) — there is no
 * approval round-trip on the direct REST surface (users authoring their own
 * skills don't need to approve themselves; agents go through the kernel tool
 * path instead, which IS approval-gated).
 */
import { createSkillRequestSchema, updateSkillRequestSchema } from "@liaison/shared"
import { and, eq, inArray } from "drizzle-orm"
import { Hono } from "hono"
import { HTTPException } from "hono/http-exception"
import { z } from "zod"
import type { AppEnv } from "~/app"
import { withPrivilegedDb } from "~/db/privileged"
import { withRlsContext } from "~/db/rls"
import { agents as agentsTbl, skills as skillsTbl } from "~/db/schema/kernel"
import { broadcastEphemeral } from "~/infra/events/event-bus"
import { rootLogger } from "~/lib/logger"
import { extractRlsContext } from "~/lib/request-rls"
import { UUID_RE } from "~/lib/uuid"
import { zValidator } from "~/lib/validate"
import {
  ReassignAssetNotFoundError,
  ReassignForbiddenError,
  ReassignTargetNotFoundError,
  reassignAssetOwner,
} from "~/modules/agent/directory/reassign"
import { reassignOwnerSchema } from "~/modules/agent/directory/reassign-schema"
import { buildAppContext, errToStatus, handlerResult } from "~/modules/agent/skills/handler-rpc"
import {
  agentWriteAuthority,
  handleCreateSkill,
  handleDeleteSkill,
  handleToggleAppSkill,
  handleUpdateSkill,
  resolveAllSkills,
  resolveDisabledAppSkills,
  subsetOfScopes,
} from "~/modules/agent/tools/skills-routines-tools"
import { skillRegistry } from "~/modules/apps/app-registries"
import { isFeatureOffForTool } from "~/modules/apps/org-apps"

const log = rootLogger.child({ module: "skills-routes" })

/**
 * The two `ownerAgentId` refusals `resolveOwnerAgentForWrite` can return, as
 * HTTP. They are answered with the `{ error: { code, message } }` envelope
 * rather than an `HTTPException` message, because the client acts on the CODE:
 * `agent_write_forbidden` is "ask an admin", `agent_not_found` is "that agent
 * is not yours to write for, or does not exist" and must stay indistinguishable
 * from a plain miss. `errToStatus` is left alone: these codes belong to the
 * create routes, not to every handler that maps through it.
 */
function ownerAgentErrorStatus(code: string): 403 | 404 | null {
  if (code === "agent_write_forbidden") return 403
  if (code === "agent_not_found") return 404
  return null
}

export const skillsRoutes = new Hono<AppEnv>()

// ---- GET /api/agent/skills ------------------------------------------------
// List every skill the caller can see — built-in + org-shared + personal,
// deduped by name with personal > org > app shadowing. Source of truth shared
// with the context assembler via `resolveAllSkills`.
//
// `?ownerAgentId=` (P4c-T32) is a DIFFERENT question: not "what can I see"
// (deduped, shadowed, app-shipped included) but "what does THIS agent own",
// which is what the agent page's Skills tab renders. It reads the DB rows
// directly under the caller's own RLS (`skills_select`, 0047): an
// owner_agent_id the caller cannot see (another colleague's personal agent,
// or one that does not exist) yields an empty list, never an error, because
// the RLS predicate simply matches no row.
skillsRoutes.get("/", async (c) => {
  const actor = extractRlsContext(c)
  const ownerAgentId = c.req.query("ownerAgentId")
  if (ownerAgentId) {
    const rows = await withRlsContext(actor, (tx) =>
      tx
        .select()
        .from(skillsTbl)
        .where(and(eq(skillsTbl.orgId, actor.orgId), eq(skillsTbl.ownerAgentId, ownerAgentId))),
    )
    rows.sort((a, b) => a.name.localeCompare(b.name))
    // `canWrite` per row (P4c-T32b): the A15 answer for THIS viewer, so the tab
    // renders its edit affordances from the rule itself instead of a client-side
    // guess at it.
    const authority = await agentWriteAuthority(
      actor,
      rows.map((s) => s.ownerAgentId),
      "skill",
    )
    return c.json({
      data: rows.map((s) => ({
        id: s.id,
        name: s.name,
        description: s.description,
        body: s.body,
        source: s.authorUserId === null ? "org" : "personal",
        appName: null,
        requiredScopes: s.requiredScopes ?? [],
        domain: s.domain ?? null,
        forkedFrom: s.forkedFrom ?? null,
        createdByActorType: s.createdByActorType,
        ownerAgentId: s.ownerAgentId,
        canWrite: authority.get(s.ownerAgentId ?? "") ?? false,
      })),
    })
  }
  const all = await resolveAllSkills(actor.orgId, actor.userId, actor.scopes)
  // Same `canWrite`, for the deduped "what can I see" listing. `resolveAllSkills`
  // does not carry `owner_agent_id` (it also yields app-shipped rows that have no
  // DB row at all), so the owning agent of the DB-backed rows is read here, in
  // one query, and every app-shipped row is `canWrite: false` — there is nothing
  // to edit behind it.
  const dbIds = all.map((s) => s.id).filter((id): id is string => typeof id === "string")
  const ownerByskillId = new Map<string, string | null>()
  if (dbIds.length > 0) {
    const ownerRows = await withPrivilegedDb(actor.orgId, "skills-list-owners", (tx) =>
      tx
        .select({ id: skillsTbl.id, ownerAgentId: skillsTbl.ownerAgentId })
        .from(skillsTbl)
        .where(and(eq(skillsTbl.orgId, actor.orgId), inArray(skillsTbl.id, dbIds))),
    )
    for (const row of ownerRows) ownerByskillId.set(row.id, row.ownerAgentId)
  }
  const listAuthority = await agentWriteAuthority(actor, [...ownerByskillId.values()], "skill")
  return c.json({
    data: all.map((s) => ({
      // For built-in (app-shipped) skills there is no DB row, so the id is
      // synthesized as `built-in/<appName>/<skillName>` so the client can pass
      // it back to POST /:id/fork (URL-encoded). DB-backed skills return the
      // UUID directly. The fork route accepts both shapes.
      id: s.id ?? (s.source === "app" && s.appName ? `built-in/${s.appName}/${s.name}` : null),
      name: s.name,
      description: s.description,
      // Skill bodies are bounded markdown (a few KB at most) and the
      // detail view needs them to render the "what the agent reads"
      // surface. No separate GET /:id endpoint exists, so include body
      // in the list response.
      body: s.body,
      source: s.source,
      appName: s.appName,
      requiredScopes: s.requiredScopes,
      domain: s.domain,
      forkedFrom: s.forkedFrom,
      createdByActorType: s.createdByActorType,
      canWrite: listAuthority.get(ownerByskillId.get(s.id ?? "") ?? "") ?? false,
    })),
  })
})

// ---- POST /api/agent/skills -----------------------------------------------
// `ownerAgentId` (P4c-T32b) authors the skill FOR that agent instead of the
// caller's own personal agent. A15 decides, in the handler's own resolver; a
// refusal is an explicit 403 `agent_write_forbidden` (or a 404 for an agent the
// caller cannot see), never the silent relocation onto the caller's own agent
// that an unrecognised key used to produce.
skillsRoutes.post("/", zValidator("json", createSkillRequestSchema), async (c) => {
  const body = c.req.valid("json")
  const ctx = buildAppContext(c)
  const result = await handleCreateSkill(body, ctx)
  const r = handlerResult<{ skill: { name?: string } }>(result)
  if (!r.ok) {
    const ownerStatus = ownerAgentErrorStatus(r.code)
    if (ownerStatus) return c.json({ error: { code: r.code, message: r.message } }, ownerStatus)
    throw new HTTPException(errToStatus(r.code), { message: r.message })
  }
  return c.json({ data: r.data.skill }, 201)
})

// ---- PUT /api/agent/skills/:id --------------------------------------------
const updateRouteBodySchema = updateSkillRequestSchema
skillsRoutes.put("/:id", zValidator("json", updateRouteBodySchema), async (c) => {
  const id = c.req.param("id")
  const body = c.req.valid("json")
  const ctx = buildAppContext(c)
  const result = await handleUpdateSkill({ id, ...body }, ctx)
  const r = handlerResult<{ skill: { name?: string } }>(result)
  if (!r.ok) throw new HTTPException(errToStatus(r.code), { message: r.message })

  // Emit WS skill:updated so other tabs/sessions refresh.
  try {
    await broadcastEphemeral({
      app: "kernel",
      entity: "skill",
      action: "updated",
      entityId: id,
      data: { skillId: id, name: r.data.skill?.name },
      actorId: ctx.userId,
      actorType: "user",
      orgId: ctx.orgId,
    })
  } catch (err) {
    log.warn({ err, id }, "Failed to broadcast skill:updated")
  }
  return c.json({ data: r.data.skill })
})

// ---- PATCH /api/agent/skills/:id ------------------------------------------
// Ownership transfer only (P4b-D5): `{ ownerAgentId }` hands this skill to
// another live agent of the org, which is what unblocks archiving the agent
// that owns it. Every other field still goes through the PUT above, whose
// handler owns validation and the approval provenance.
skillsRoutes.patch("/:id", zValidator("json", reassignOwnerSchema), async (c) => {
  const actor = extractRlsContext(c)
  const { ownerAgentId } = c.req.valid("json")
  try {
    const result = await reassignAssetOwner(actor, {
      asset: "skills",
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

// ---- DELETE /api/agent/skills/:id -----------------------------------------
skillsRoutes.delete("/:id", async (c) => {
  const id = c.req.param("id")
  const ctx = buildAppContext(c)
  const result = await handleDeleteSkill({ id }, ctx)
  const r = handlerResult<{ skill: { name?: string } }>(result)
  if (!r.ok) throw new HTTPException(errToStatus(r.code), { message: r.message })
  return c.body(null, 204)
})

// ---- POST /api/agent/skills/:id/fork --------------------------------------
// :id may be a UUID (forking a kernel.skills row) OR `built-in/<app>/<name>`
// (forking an app-shipped skill from `skillRegistry`).
const forkBodySchema = z.object({ name: z.string().min(1).max(60).optional() }).optional()

skillsRoutes.post("/:id/fork", async (c) => {
  const id = c.req.param("id")
  const actor = extractRlsContext(c)
  let bodyParsed: z.infer<typeof forkBodySchema>
  try {
    const raw = await c.req.json().catch(() => undefined)
    bodyParsed = forkBodySchema.parse(raw ?? {})
  } catch {
    throw new HTTPException(400, { message: "Invalid fork body" })
  }

  // Resolve source: UUID -> DB skill; else built-in registry lookup.
  let source: {
    name: string
    description: string
    body: string
    requiredScopes: string[]
    forkedFrom: string
  } | null = null

  if (UUID_RE.test(id)) {
    // Org-scope the lookup. `withPrivilegedDb` bypasses RLS, so without an
    // explicit org-equality predicate any tenant could fork any other tenant's
    // skill body by id. Filter on the caller's orgId and 404 on miss.
    const rows = await withPrivilegedDb(actor.orgId, "skill-fork-lookup", (tx) =>
      tx
        .select()
        .from(skillsTbl)
        .where(and(eq(skillsTbl.id, id), eq(skillsTbl.orgId, actor.orgId))),
    )
    if (rows.length === 0) {
      throw new HTTPException(404, { message: "Source skill not found" })
    }
    const s = rows[0]
    // The lookup above bypasses RLS, so apply the visibility rule here: the
    // same one the skill list and the edit/delete routes use. A personal skill
    // belongs to its author, and a skill owned by another user's personal
    // agent is theirs too. A miss is a 404, never a 403, so the route does not
    // confirm that someone else's skill id exists.
    if (s.authorUserId !== null && s.authorUserId !== actor.userId) {
      throw new HTTPException(404, { message: "Source skill not found" })
    }
    if (s.ownerAgentId) {
      const ownerAgentId = s.ownerAgentId
      const [owner] = await withPrivilegedDb(actor.orgId, "skill-fork-owner", (tx) =>
        tx
          .select({ kind: agentsTbl.kind, ownerUserId: agentsTbl.ownerUserId })
          .from(agentsTbl)
          .where(and(eq(agentsTbl.id, ownerAgentId), eq(agentsTbl.orgId, actor.orgId))),
      )
      if (!owner || (owner.kind === "personal" && owner.ownerUserId !== actor.userId)) {
        throw new HTTPException(404, { message: "Source skill not found" })
      }
    }
    source = {
      name: s.name,
      description: s.description,
      body: s.body,
      requiredScopes: s.requiredScopes ?? [],
      forkedFrom: `skill:${s.id}`,
    }
  } else {
    // built-in/<app>/<name>
    const m = id.match(/^built-in\/([^/]+)\/([^/]+)$/)
    if (!m) throw new HTTPException(400, { message: "Invalid skill id" })
    const [, appName, skillName] = m
    const entry = skillRegistry.get([actor.orgId, appName, skillName])
    // A skill of a feature the org has off cannot be read, so it cannot be forked either.
    if (!entry || isFeatureOffForTool(actor.orgId, { appName, feature: entry.feature })) {
      throw new HTTPException(404, { message: "Source skill not found" })
    }
    source = {
      name: entry.name,
      description: entry.description,
      body: entry.body,
      requiredScopes: entry.requiredScopes ?? [],
      forkedFrom: `app:${appName}/${skillName}`,
    }
  }

  const newName = bodyParsed?.name ?? source.name

  // Delegate to handleCreateSkill — same scope/admin checks and 23505 → name_conflict
  // translation. The fork's only added contract is the `forkedFrom` provenance,
  // passed via the helper's optional meta arg.
  const result = (await handleCreateSkill(
    {
      name: newName,
      description: source.description,
      body: source.body,
      requiredScopes: source.requiredScopes,
      visibility: "personal",
    },
    buildAppContext(c),
    { forkedFrom: source.forkedFrom },
  )) as { skill?: typeof skillsTbl.$inferSelect; error?: { code: string; message: string } }
  if (result.error) {
    if (result.error.code === "name_conflict") {
      throw new HTTPException(409, {
        message: `A personal skill named '${newName}' already exists. Pass {"name":"new-name"} to fork under a different name.`,
      })
    }
    throw new HTTPException(errToStatus(result.error.code), {
      message: result.error.message,
    })
  }
  return c.json({ data: result.skill }, 201)
})

// ---------------------------------------------------------------------------
// App-skills sub-resource — used by the Settings UI to view/toggle app-shipped
// skills. Same single source of visibility truth as the context assembler.
// Mounted at `/api/agent/app-skills` (see app.ts).
// ---------------------------------------------------------------------------
export const appSkillsRoutes = new Hono<AppEnv>()

// GET /api/agent/app-skills?disabled=true → list disabled rows visible to caller
appSkillsRoutes.get("/", async (c) => {
  const actor = extractRlsContext(c)
  const onlyDisabled = c.req.query("disabled") === "true"
  if (onlyDisabled) {
    const rows = await resolveDisabledAppSkills(actor.orgId, actor.userId)
    return c.json({ data: rows })
  }
  // Default: list app-shipped skills the caller can see — applies the same
  // scope-subset filter as `resolveAllSkills` (assembler parity). Disabled
  // entries are still returned so the UI can render the toggle off.
  const disabled = await resolveDisabledAppSkills(actor.orgId, actor.userId)
  const disabledKey = new Set(disabled.map((d) => `${d.appName}\u0000${d.skillName}`))
  const scopes = actor.scopes ?? []
  const out: Array<{ appName: string; name: string; description: string; enabled: boolean }> = []
  for (const [key, entry] of skillRegistry.entriesOf(actor.orgId)) {
    const [, appName, skillName] = key
    if (!subsetOfScopes(entry.requiredScopes ?? [], scopes)) continue
    if (isFeatureOffForTool(actor.orgId, { appName, feature: entry.feature })) continue
    out.push({
      appName,
      name: skillName,
      description: entry.description,
      enabled: !disabledKey.has(`${appName}\u0000${skillName}`),
    })
  }
  return c.json({ data: out })
})

// GET /api/agent/app-skills/:app/:name → single entry
appSkillsRoutes.get("/:app/:name", async (c) => {
  const actor = extractRlsContext(c)
  const appName = c.req.param("app")
  const skillName = c.req.param("name")
  // 404 with code=app_not_enabled if no entry for this app at all for this org.
  let appHasAny = false
  let target: ReturnType<typeof skillRegistry.get> | undefined
  for (const [key] of skillRegistry.entriesOf(actor.orgId)) {
    if (key[1] === appName) {
      appHasAny = true
      break
    }
  }
  if (!appHasAny) {
    throw new HTTPException(404, { message: `App '${appName}' is not enabled for this org` })
  }
  target = skillRegistry.get([actor.orgId, appName, skillName])
  // Off with its feature, as in the listing: the skill is not there to read.
  if (!target || isFeatureOffForTool(actor.orgId, { appName, feature: target.feature })) {
    throw new HTTPException(404, { message: `Skill '${skillName}' not found in app '${appName}'` })
  }
  const disabled = await resolveDisabledAppSkills(actor.orgId, actor.userId)
  const isDisabled = disabled.some((d) => d.appName === appName && d.skillName === skillName)
  return c.json({
    data: {
      appName,
      name: skillName,
      description: target.description,
      body: target.body,
      requiredScopes: target.requiredScopes ?? [],
      enabled: !isDisabled,
    },
  })
})

// ---------------------------------------------------------------------------
// Debug endpoint — gated on NODE_ENV === "test". Returns the skills-manifest
// section the context assembler would emit for the caller. Used by S3 (E2E)
// to assert that disabled built-in skills are excluded before any LLM call.
// ---------------------------------------------------------------------------
export const agentDebugRoutes = new Hono<AppEnv>()

agentDebugRoutes.get("/manifest", async (c) => {
  if (process.env.NODE_ENV !== "test") {
    throw new HTTPException(404, { message: "Not found" })
  }
  const actor = extractRlsContext(c)
  const all = await resolveAllSkills(actor.orgId, actor.userId, actor.scopes)
  // Reproduce the assembler line shape: `- <name> — <description>`. The full
  // assembler also de-dupes by name (personal > org > app) which resolveAllSkills
  // already does via the shadow loop.
  const skills = all.map((s) => ({
    name: s.name,
    description: s.description,
    source: s.source,
    appName: s.appName,
  }))
  const manifestText =
    skills.length > 0 ? skills.map((s) => `- ${s.name} — ${s.description}`).join("\n") : ""
  return c.json({ data: { skills, manifestText } })
})

// GET /api/agent/_debug/system-prompt?threadId=<id> — gated on NODE_ENV === "test".
// Runs the REAL context assembler for the caller against a real thread and returns
// the concatenated system-prompt text plus its parts. Used by the agent-instructions
// E2E (Module K) to assert that every installed app's `agentInstructions` paragraph
// reaches the assembled `## Apps` block end-to-end (registry → assembler → wire),
// the same seam the live `/api/agent/chat` stream uses to build the system prompt.
agentDebugRoutes.get("/system-prompt", async (c) => {
  if (process.env.NODE_ENV !== "test") {
    throw new HTTPException(404, { message: "Not found" })
  }
  const threadId = c.req.query("threadId")
  if (!threadId) {
    throw new HTTPException(400, { message: "threadId query param required" })
  }
  const { assembleContext } = await import("~/modules/agent/context/context")
  const actor = extractRlsContext(c)
  const result = await assembleContext({ threadId, orgId: actor.orgId, actor })
  const parts = result.system.map((p) => p.content)
  return c.json({ data: { systemText: parts.join("\n\n"), parts } })
})

const toggleBodySchema = z.object({ scope: z.enum(["user", "org"]) })

// POST /api/agent/app-skills/:app/:name/toggle
appSkillsRoutes.post("/:app/:name/toggle", zValidator("json", toggleBodySchema), async (c) => {
  const appName = c.req.param("app")
  const skillName = c.req.param("name")
  const { scope } = c.req.valid("json")
  const ctx = buildAppContext(c)
  const result = await handleToggleAppSkill({ appName, skillName, scope }, ctx)
  const r = handlerResult<{ skill: { name?: string } }>(result)
  if (!r.ok) throw new HTTPException(errToStatus(r.code), { message: r.message })
  return c.json({ data: r.data })
})
