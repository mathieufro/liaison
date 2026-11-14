// SPDX-License-Identifier: FSL-1.1-ALv2
// Time and budgets is per project (`projects.time_budgets_on`). The org row in
// `kernel.org_app_features` (feature `time_budgets`) is derived from the
// projects: on if and only if a work project that is not archived has the
// switch on. It is what
// keeps the time tools out of every catalog of an org that uses none.
//
// The project writer (update-project.ts) changes the project in the person's
// own RLS transaction. That transaction cannot see every project, so the org
// row is recomputed after it commits, here, on the privileged handle and under
// one advisory lock per org: every recompute reads committed state, so two
// writers on different projects, racing, always end with the row equal to the
// projects. A crash between the commit and the recompute is healed by the
// next recompute (`syncTimeBudgetsFeature` is idempotent).

import { sql as drizzleSql } from "drizzle-orm"
import { projectsRel } from "~/apps/projects/schema-refs"
import { extractRows, type PrivilegedDb } from "~/db"
import { afterCurrentCommit } from "~/db/commit-hooks"
import { withPrivilegedDb } from "~/db/privileged"
import { schemaRef } from "~/db/schema-ref"
import { rootLogger } from "~/lib/logger"
import { noteOrgFeatureChanged, writeOrgAppFeature } from "~/modules/apps/org-features"
import { isSeeding } from "~/modules/notifications/seeded"
import { scopeHoldersInTx } from "~/modules/permissions/scope-holders"

const log = rootLogger.child({ module: "projects/time-feature" })

import { TIME_FEATURE } from "./planning"

export { orgUsesTimeBudgets, TIME_FEATURE } from "./planning"

const APP = "projects"
/** The scope the feature declares as its `adminScope`: the system recompute writes as it. */
const WRITER_SCOPES = ["projects:projects:write"] as const
/** The people told once, on the Home page, when the first project of the org turns it on. */
export const FIRST_ON_AUDIENCE_SCOPE = "kernel:users:admin"
export const FIRST_ON_KIND = "projects:time_budgets.first_on"
const FIRST_ON_ENTITY = "time_budgets"
/** From this many active members, the notice also mentions consulting staff representatives. */
export const STAFF_CONSULTATION_MEMBERS = 50

/** The sentence the person who turned the first project on reads, and the admins' Home line. */
export function firstOnNotice(activeMembers: number): string {
  const base =
    "Before anyone records time, tell the team what is recorded and why: the documentation has a notice template for employees (Time and budgets, telling your team)."
  return activeMembers >= STAFF_CONSULTATION_MEMBERS
    ? `${base} With ${STAFF_CONSULTATION_MEMBERS} or more people, consult your staff representatives first.`
    : base
}

export const NEXT_MESSAGE_LINE =
  "The time tools are available from your next message. A connected coding agent sees them at its next tool list."

/** Test seam: runs inside the recompute, under the lock, between its read and its write. */
export const timeFeatureTestHooks: { afterRead?: (orgId: string) => Promise<void> } = {}

const inFlight = new Map<string, Promise<void>>()

/** Resolves once every recompute queued for the org so far has finished. */
export async function awaitTimeFeatureSync(orgId: string): Promise<void> {
  while (inFlight.has(orgId)) await inFlight.get(orgId)
}

/**
 * Recompute the org row from the committed projects. Answers what the row says now
 * and whether this call changed it. `actorUserId` is recorded as who changed it.
 */
export async function syncTimeBudgetsFeature(
  orgId: string,
  actorUserId: string | null,
  /** `jobs`: the background pool, for a sweep or job that heals the row. */
  opts: { pool?: "jobs" } = {},
): Promise<{ enabled: boolean; changed: boolean }> {
  const result = await withPrivilegedDb(
    orgId,
    "projects-time-feature",
    async (tx) => {
      await tx.execute(
        drizzleSql`SELECT pg_advisory_xact_lock(hashtext(${`time_budgets:${orgId}`}))`,
      )
      const enabled = await anyWorkProjectOn(tx, orgId)
      if (timeFeatureTestHooks.afterRead) await timeFeatureTestHooks.afterRead(orgId)
      const { changed } = await writeOrgAppFeature(tx, {
        orgId,
        app: APP,
        feature: TIME_FEATURE,
        enabled,
        actor: { userId: actorUserId, scopes: WRITER_SCOPES },
      })
      // A seeded world has used time and budgets all along: no first-on line on its Home.
      if (changed && enabled && !isSeeding()) await tellAdminsFirstOn(tx, orgId, actorUserId)
      return { enabled, changed }
    },
    opts.pool ? { pool: opts.pool } : undefined,
  )
  if (result.changed) await noteOrgFeatureChanged(orgId, APP, TIME_FEATURE, result.enabled)
  return result
}

/**
 * Queue the recompute for when the caller's transaction ends (commit or rollback: it
 * reads committed state either way). Outside any transaction it starts at once.
 */
export function scheduleTimeBudgetsSync(orgId: string, actorUserId: string | null): void {
  const start = () => {
    const previous = inFlight.get(orgId) ?? Promise.resolve()
    const next = previous
      .then(() => syncTimeBudgetsFeature(orgId, actorUserId))
      .then(
        () => undefined,
        (err) => log.error({ err, orgId }, "time and budgets org row recompute failed"),
      )
      .finally(() => {
        if (inFlight.get(orgId) === next) inFlight.delete(orgId)
      })
    inFlight.set(orgId, next)
  }
  if (!afterCurrentCommit(start)) start()
}

async function anyWorkProjectOn(tx: PrivilegedDb, orgId: string): Promise<boolean> {
  const rows = extractRows<{ on: boolean }>(
    await tx.execute(drizzleSql`
      SELECT EXISTS (
        SELECT 1 FROM ${projectsRel("projects")}
        WHERE org_id = ${orgId}::uuid AND kind = 'work' AND time_budgets_on
          AND archived_at IS NULL
      ) AS on
    `),
  )
  return rows[0]?.on === true
}

/** Does another work project of the org already have it on (committed)? Privileged read. */
export async function anotherProjectUsesTime(orgId: string, projectId: string): Promise<boolean> {
  return withPrivilegedDb(orgId, "projects-time-feature-read", async (tx) => {
    const rows = extractRows<{ on: boolean }>(
      await tx.execute(drizzleSql`
        SELECT EXISTS (
          SELECT 1 FROM ${projectsRel("projects")}
          WHERE org_id = ${orgId}::uuid AND kind = 'work' AND time_budgets_on
            AND archived_at IS NULL AND id <> ${projectId}::uuid
        ) AS on
      `),
    )
    return rows[0]?.on === true
  })
}

/** Active members of the org, for the notice's staff-representative sentence. */
export async function activeMemberCount(orgId: string): Promise<number> {
  return withPrivilegedDb(orgId, "projects-time-feature-members", async (tx) => {
    const rows = extractRows<{ n: number | string }>(
      await tx.execute(drizzleSql`
        SELECT count(*) AS n FROM ${drizzleSql.raw(schemaRef("kernel"))}.users
        WHERE org_id = ${orgId}::uuid AND status = 'active'
      `),
    )
    return Number(rows[0]?.n ?? 0)
  })
}

/**
 * One Home line per admin, once for the org: an org that has had the line, read or not,
 * is not told again when its projects go off and one comes back on. The unread dedupe
 * index keeps two racing writers to one line.
 */
async function tellAdminsFirstOn(
  tx: PrivilegedDb,
  orgId: string,
  actorUserId: string | null,
): Promise<void> {
  const K0 = drizzleSql.raw(schemaRef("kernel"))
  const told = extractRows<{ told: boolean }>(
    await tx.execute(drizzleSql`
      SELECT EXISTS (
        SELECT 1 FROM ${K0}.attention_events
         WHERE org_id = ${orgId}::uuid AND app = ${APP} AND entity_type = ${FIRST_ON_ENTITY}
           AND entity_id = ${orgId} AND kind = ${FIRST_ON_KIND}
      ) AS told`),
  )
  if (told[0]?.told === true) return
  const admins = await scopeHoldersInTx(tx, orgId, FIRST_ON_AUDIENCE_SCOPE)
  if (admins.length === 0) return
  const members = extractRows<{ n: number | string }>(
    await tx.execute(drizzleSql`
      SELECT count(*) AS n FROM ${drizzleSql.raw(schemaRef("kernel"))}.users
      WHERE org_id = ${orgId}::uuid AND status = 'active'
    `),
  )
  const summary = `A first project now uses time and budgets. ${firstOnNotice(Number(members[0]?.n ?? 0))}`
  const K = drizzleSql.raw(schemaRef("kernel"))
  const actorType = actorUserId ? "user" : "system"
  for (const userId of admins) {
    await tx.execute(drizzleSql`
      INSERT INTO ${K}.attention_events
        (org_id, user_id, app, entity_type, entity_id, kind, urgency, summary, actor_id,
         actor_type, metadata, occurred_at, is_urgent, digest_state, digest_eligible_at, email_only)
      VALUES (${orgId}::uuid, ${userId}::uuid, ${APP}, ${FIRST_ON_ENTITY}, ${orgId},
              ${FIRST_ON_KIND}, 20, ${summary}, ${actorUserId}::uuid, ${actorType}, '{}'::jsonb,
              now(), false, 'not_eligible', now(), false)
      ON CONFLICT (user_id, app, entity_type, entity_id, kind)
        WHERE read_at IS NULL AND email_only = false
        DO NOTHING`)
  }
}
