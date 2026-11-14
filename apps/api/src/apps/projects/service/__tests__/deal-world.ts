// SPDX-License-Identifier: FSL-1.1-ALv2
/**
 * A small world for the deal tests: one org, one person with every projects
 * scope, and helpers to make pipelines, deals and read what the outcome writer
 * left behind (the deal row and the queued deal events).
 */
import { sql as drizzleSql } from "drizzle-orm"
import { createPipeline, createProject } from "~/apps/projects/service/create-project"
import { createTask } from "~/apps/projects/service/tasks"
import { extractRows } from "~/db"
import { __privileged_db__ as db } from "~/db/connection"
import { type UserContext, withRlsContext } from "~/db/rls"
import { schemaRef } from "~/db/schema-ref"
import { quoteIdent } from "~/lib/sql-utils"

/** The kernel schema as this deployment names it. */
const K = drizzleSql.raw(quoteIdent(schemaRef("kernel")))

const SCOPES = [
  "projects:projects:read",
  "projects:projects:write",
  "projects:tasks:read",
  "projects:tasks:write",
  "projects:deals:read",
  "projects:deals:write",
  "kernel:threads:write",
  "kernel:threads:read",
]

export interface DealWorld {
  orgId: string
  userId: string
  actor: UserContext
}

export async function makeDealWorld(label: string): Promise<DealWorld> {
  const [org] = extractRows<{ id: string }>(
    await db.execute(drizzleSql`
      INSERT INTO ${K}.organizations (id, name, slug)
      VALUES (gen_random_uuid(), ${label}, ${`${label}-${crypto.randomUUID().slice(0, 8)}`})
      RETURNING id
    `),
  )
  const orgId = org!.id
  const [user] = extractRows<{ id: string }>(
    await db.execute(drizzleSql`
      INSERT INTO ${K}.users (id, org_id, email, name, status, password_hash, auth_version, permission_version)
      VALUES (gen_random_uuid(), ${orgId}::uuid, ${`seller-${crypto.randomUUID().slice(0, 8)}@deals.test`}, 'Seller', 'active', 'h', 1, 1)
      RETURNING id
    `),
  )
  const userId = user!.id
  return {
    orgId,
    userId,
    actor: { actorType: "user", userId, orgId, scopes: SCOPES, dimensionGrants: { "*": ["*"] } },
  }
}

export interface Pipeline {
  projectId: string
  stage: Record<string, string>
}

export async function makePipeline(w: DealWorld, name: string): Promise<Pipeline> {
  const p = await withRlsContext(w.actor, (tx) =>
    createPipeline({ tx, orgId: w.orgId, actor: w.actor, input: { name } }),
  )
  return { projectId: p.id, stage: Object.fromEntries(p.statuses.map((s) => [s.label, s.id])) }
}

export async function makeWorkProject(w: DealWorld, name: string): Promise<Pipeline> {
  const p = await withRlsContext(w.actor, (tx) =>
    createProject({ tx, orgId: w.orgId, actor: w.actor, input: { name } }),
  )
  return { projectId: p.id, stage: Object.fromEntries(p.statuses.map((s) => [s.label, s.id])) }
}

export async function makeTask(
  w: DealWorld,
  projectId: string,
  title: string,
  extra: { statusId?: string; parentTaskId?: string } = {},
): Promise<string> {
  return withRlsContext(w.actor, async (tx) => {
    const t = await createTask({
      tx,
      orgId: w.orgId,
      actor: w.actor,
      input: { projectId, title, statusId: extra.statusId, parentTaskId: extra.parentTaskId },
    })
    return t.id
  })
}

export interface DealState {
  outcome: string
  closed_at: string | null
  closed_by: string | null
  lost_reason: string | null
  company_id: string | null
  status_id: string
  has_value: boolean
  amount_minor: string | null
  currency: string | null
}

/** The deal row as stored, or null when the task has none. */
export async function dealState(taskId: string): Promise<DealState | null> {
  const rows = extractRows<DealState>(
    await db.execute(drizzleSql`
      SELECT d.outcome, d.closed_at::text AS closed_at, d.closed_by, d.lost_reason, d.company_id,
             t.status_id, (v.task_id IS NOT NULL) AS has_value,
             v.amount_minor::text AS amount_minor, v.currency
      FROM app_projects.deals d
      JOIN app_projects.tasks t ON t.id = d.task_id
      LEFT JOIN app_projects.deal_values v ON v.task_id = d.task_id
      WHERE d.task_id = ${taskId}::uuid
    `),
  )
  return rows[0] ?? null
}

export async function taskStatus(taskId: string): Promise<string> {
  const rows = extractRows<{ status_id: string }>(
    await db.execute(
      drizzleSql`SELECT status_id FROM app_projects.tasks WHERE id = ${taskId}::uuid`,
    ),
  )
  return rows[0]!.status_id
}

/** The deal events queued for one task, in order: "closed:won", "reopened", ... */
export async function dealEvents(w: DealWorld, taskId: string): Promise<string[]> {
  const rows = extractRows<{ action: string; outcome: string | null }>(
    await db.execute(drizzleSql`
      SELECT payload->>'action' AS action, payload->'data'->>'outcome' AS outcome
      FROM ${K}.pending_events
      WHERE org_id = ${w.orgId}::uuid
        AND payload->>'app' = 'projects'
        AND payload->>'entity' = 'deal'
        AND payload->>'entityId' = ${taskId}
      ORDER BY seq
    `),
  )
  return rows.map((r) => (r.action === "closed" ? `closed:${r.outcome}` : r.action))
}
