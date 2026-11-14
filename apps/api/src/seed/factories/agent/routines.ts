// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The routines factory: an org's routines, seeded OFF (`enabled = false`,
// `status = 'active'`), their scope ceiling clamped to what the owner really
// holds through the product's own `grantableScopes`, converged on
// `(org_id, owner_user_id, name)`; switching one on with its event
// subscription, the way the routines route does; and the org's delegate
// (sub agent) roles through `createSubAgentDefinition`.
//
// Privileged: `kernel.routines` is written over the privileged connection,
// like the kernel's own routine tools do once the caller's scopes are checked;
// here the check is the clamp against the owner's effective permissions.
import { and, eq, sql } from "drizzle-orm"
import { withPrivilegedDb } from "~/db/privileged"
import { routines } from "~/db/schema/kernel/routines"
import { createSubAgentDefinition } from "~/modules/agent/subruns/sub-agent-definitions"
import { grantableScopes } from "~/modules/agent/tools/skills-routines-tools"
import { loadEffectivePermissions } from "~/modules/permissions/permissions"
import type { SeedContext } from "~/seed/context"

/** The scopes a person holds in the org, read once per person per call site. */
export function scopeReader(ctx: SeedContext): (userId: string) => Promise<string[]> {
  const cache = new Map<string, string[]>()
  return async (userId) => {
    const cached = cache.get(userId)
    if (cached) return cached
    const perms = await withPrivilegedDb(ctx.orgId, "seed-routine-perms", (tx) =>
      loadEffectivePermissions(tx, userId, ctx.orgId),
    )
    cache.set(userId, perms.scopes)
    return perms.scopes
  }
}

export interface RoutineSeed {
  name: string
  /** At most 200 characters (DB check constraint). */
  description: string
  kind: "recurring" | "event"
  /** Set for `recurring`. */
  cron?: string
  /** The timezone a recurring routine's cron reads in. */
  timezone?: string
  /** Set for `event`: a full `app:entity:action` string the org declares. */
  event?: string
  /** A sender filter, or the row filter of a dashboard table routine. */
  eventFilter?: (typeof routines.$inferInsert)["eventFilter"]
  /** The conversation the routine reports its result to. */
  reportThreadId?: string | null
  /** Its flow (0303): steps after the trigger; none = a legacy routine. */
  flow?: (typeof routines.$inferInsert)["flow"]
  ownerUserId: string
  /** The agent it runs as; none runs it as the owner's own agent. */
  ownerAgentId?: string | null
  /** Requested ceiling, clamped to what the owner holds before it is written. */
  scopes: string[]
  prompt: string
  /**
   * The product template it was made from, recorded as enabling the template
   * records it: a kernel template carries no app name.
   */
  template?: { appName: string; templateKey: string }
  /**
   * The template's follow-up mark (`followUp`): its run stages drafts and ends, never waiting
   * for their decisions. Copied as enabling the template copies it.
   */
  followUp?: boolean
}

/**
 * One shared routine, OFF and honestly off (`status` stays `active`, so the
 * row reads "off" rather than claiming a pause that never happened). Nothing
 * is registered with the job queue and no event subscription is opened: both
 * select `enabled = true`. Returns its id.
 *
 * `enabled: true` writes it on for a seed that runs before any server boots
 * over its data: a booting server re-creates every enabled routine's trigger
 * (its cron scheduler, its event subscription) from the table, so the row is
 * all a later boot needs. A live server's routine is switched on through
 * `enableEventRoutine` instead.
 */
export async function seedRoutine(
  ctx: SeedContext,
  input: {
    createdByUserId: string
    ownerScopes: string[]
    routine: RoutineSeed
    enabled?: boolean
  },
): Promise<string> {
  const spec = input.routine
  const { granted } = grantableScopes(spec.scopes, input.ownerScopes)
  const recurring = spec.kind === "recurring"
  const definition = {
    ownerAgentId: spec.ownerAgentId ?? null,
    description: spec.description,
    kind: spec.kind,
    cron: recurring ? (spec.cron ?? null) : null,
    timezone: recurring ? (spec.timezone ?? null) : null,
    runAt: null,
    event: spec.kind === "event" ? (spec.event ?? null) : null,
    ...(spec.eventFilter !== undefined ? { eventFilter: spec.eventFilter } : {}),
    ...(spec.reportThreadId !== undefined ? { reportThreadId: spec.reportThreadId } : {}),
    ...(spec.flow !== undefined ? { flow: spec.flow } : {}),
    prompt: spec.prompt,
    ...(spec.template
      ? {
          appName: spec.template.appName === "kernel" ? null : spec.template.appName,
          templateKey: spec.template.templateKey,
          sourceKind: spec.template.appName === "kernel" ? "kernel" : "app",
        }
      : {}),
    scopes: granted,
    followUp: spec.followUp === true,
    // Shared, not personal: the whole org sees it under Shared.
    visibility: "shared" as const,
    enabled: input.enabled ?? false,
    status: "active" as const,
  }
  const [row] = await withPrivilegedDb(ctx.orgId, "seed-routine", (tx) =>
    tx
      .insert(routines)
      .values({
        orgId: ctx.orgId,
        ownerUserId: spec.ownerUserId,
        name: spec.name,
        ...definition,
        createdByUserId: input.createdByUserId,
        createdByActorType: "user",
      })
      .onConflictDoUpdate({
        target: [routines.orgId, routines.ownerUserId, routines.name],
        set: { ...definition, updatedAt: sql`now()` },
      })
      .returning({ id: routines.id }),
  )
  if (!row) throw new Error(`routines seed: routine '${spec.name}' not returned`)
  return row.id
}

/**
 * Switch a seeded routine on and open its event subscription, the way the
 * routines route does.
 */
export async function enableEventRoutine(orgId: string, routineId: string): Promise<void> {
  const [row] = await withPrivilegedDb(orgId, "seed-enable-routine", (tx) =>
    tx
      .update(routines)
      .set({ enabled: true, updatedAt: sql`now()` })
      .where(and(eq(routines.orgId, orgId), eq(routines.id, routineId)))
      .returning({ id: routines.id, event: routines.event, eventFilter: routines.eventFilter }),
  )
  if (!row) throw new Error(`routines seed: routine ${routineId} not found`)
  const { subscribeActiveEventRoutines } = await import("~/infra/jobs/event-routine-subscriber")
  await subscribeActiveEventRoutines([
    { id: row.id, orgId, event: row.event, filter: row.eventFilter },
  ])
}

export interface SubAgentRoleSeed {
  agentType: string
  whenToUse: string
  systemPrompt: string
  /** Clamped to what the creator holds before the row is written. */
  scopeCeiling: string[]
  /** Skill names the spawned instance loads. */
  skills: string[]
}

/**
 * Delegate roles, through `createSubAgentDefinition` (upsert on
 * `(org_id, agent_type)`, with its real ceiling check against the creator's
 * own live scopes). Returns the agent types written.
 */
export async function seedSubAgentRoles(
  ctx: SeedContext,
  input: { creatorUserId: string; roles: readonly SubAgentRoleSeed[] },
): Promise<string[]> {
  const perms = await withPrivilegedDb(ctx.orgId, "seed-subagent-perms", (tx) =>
    loadEffectivePermissions(tx, input.creatorUserId, ctx.orgId),
  )
  const seeded: string[] = []
  for (const spec of input.roles) {
    const { granted } = grantableScopes(spec.scopeCeiling, perms.scopes)
    await createSubAgentDefinition({
      orgId: ctx.orgId,
      creatorScopes: perms.scopes,
      agentType: spec.agentType,
      whenToUse: spec.whenToUse,
      scopeCeiling: granted,
      skills: spec.skills,
      systemPrompt: spec.systemPrompt,
      contextProfile: "minimal",
    })
    seeded.push(spec.agentType)
  }
  return seeded
}
