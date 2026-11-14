// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The lively tier against a real database: ten people with logins, fourteen
// days of activity per domain, nothing older than the window, the newest
// within the last hour, nothing in the future; a second run adopts everything
// (same counts, no new row); `--replace` builds the org again from nothing.
//
//   bun run scripts/test-run.ts demo-seed --file "$PWD/apps/api/src/seed/tiers/lively/seed-lively.integration.test.ts"
import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { sql } from "drizzle-orm"
import { listTasks } from "~/apps/projects/service/tasks"
import { withSystemDb } from "~/db/privileged"
import { DemoModeTestAccess } from "~/modules/demo/demo-mode"
import { seedContext } from "~/seed/context"
import { actorFor, asUser, rowsOf as typedRows } from "~/seed/factories/people/actors"
import { installFromDist } from "../../../../test-support/seed/install-dist-apps"
import { type LivelyActivity, type SeedLivelyResult, seedLivelyWorld } from "./seed-lively"

const DB_URL = process.env.DATABASE_URL ?? ""
const SLUG = `lively-${crypto.randomUUID().slice(0, 8)}`
const CATALOG_DEMO_APPS = ["invoicing", "social", "pennylane", "boxtal", "shopify", "monitoring"]
const DAY_MS = 86_400_000

type Rows = Array<Record<string, unknown>>
const rowsOf = (r: unknown): Rows =>
  (Array.isArray(r) ? r : ((r as { rows?: unknown[] }).rows ?? [])) as Rows

/** Each activity domain: its table, the column that says when, and its id list. */
const DOMAINS: Array<{ name: keyof LivelyActivity; table: string; at: string; min: number }> = [
  { name: "messages", table: "kernel.messages", at: "created_at", min: 150 },
  { name: "agentTurns", table: "kernel.agent_turns", at: "created_at", min: 60 },
  { name: "tickets", table: "app_tickets.tickets", at: "created_at", min: 60 },
  { name: "timelineEntries", table: "kernel.timeline_entries", at: "created_at", min: 100 },
  { name: "routineRuns", table: "kernel.routine_runs", at: "ran_at", min: 30 },
  { name: "subRuns", table: "kernel.agent_runs", at: "created_at", min: 15 },
  { name: "attentionEvents", table: "kernel.attention_events", at: "occurred_at", min: 70 },
  {
    name: "notificationDeliveries",
    table: "kernel.notification_deliveries",
    at: "attempted_at",
    min: 70,
  },
]

async function window(table: string, at: string, ids: string[]) {
  const [row] = rowsOf(
    await withSystemDb("lively-test-window", (tx) =>
      tx.execute(
        sql.raw(
          `SELECT count(*)::int AS n, min(${at}) AS oldest, max(${at}) AS newest FROM ${table}
           WHERE id IN (${ids.map((id) => `'${id}'`).join(",")})`,
        ),
      ),
    ),
  )
  return {
    n: Number(row?.n ?? 0),
    oldest: new Date(String(row?.oldest)),
    newest: new Date(String(row?.newest)),
  }
}

async function orgRowCounts(orgId: string): Promise<Record<string, number>> {
  const out: Record<string, number> = {}
  for (const d of DOMAINS) {
    const [row] = rowsOf(
      await withSystemDb("lively-test-count", (tx) =>
        tx.execute(sql.raw(`SELECT count(*)::int AS n FROM ${d.table} WHERE org_id = '${orgId}'`)),
      ),
    )
    out[d.name] = Number(row?.n ?? 0)
  }
  return out
}

let first: SeedLivelyResult
let counts: Record<string, number>
const startedAt = new Date(Date.now())

beforeAll(async () => {
  if (DB_URL === "") throw new Error("DATABASE_URL must be set for this test")
  if (/liaison_dev|liaison_test(?!_)/.test(DB_URL)) {
    throw new Error("refusing to seed a shared database")
  }
  // A private box: demo mode off, so the people may have a password.
  DemoModeTestAccess.set(false)
  if (!process.env.LIAISON_APPS_DIR) {
    process.env.LIAISON_APPS_DIR = path.join(mkdtempSync(path.join(tmpdir(), "lively-")), "apps")
  }
  for (const app of CATALOG_DEMO_APPS) await installFromDist(app, crypto.randomUUID())
  first = await seedLivelyWorld({ orgSlug: SLUG, personaPassword: "Lively-Walk-1!" })
  counts = await orgRowCounts(first.world.orgId)
}, 1_200_000)

afterAll(() => {
  DemoModeTestAccess.set(null)
})

describe("the lively tier", () => {
  it("seeds the whole world, ten people, each able to sign in", async () => {
    expect(first.complete).toBe(true)
    expect(first.world.failures).toEqual([])
    expect(first.world.org.people.length).toBe(10)
    const [row] = rowsOf(
      await withSystemDb("lively-test-passwords", (tx) =>
        tx.execute(
          sql`SELECT count(*)::int AS n FROM kernel.users
              WHERE org_id = ${first.world.orgId}::uuid AND password_hash IS NOT NULL`,
        ),
      ),
    )
    expect(Number(row?.n)).toBe(10)
  })

  it("writes every activity domain, within fourteen days, the newest within the hour", async () => {
    const activity = first.activity as LivelyActivity
    const now = startedAt.getTime()
    for (const d of DOMAINS) {
      const ids = activity[d.name]
      expect({ domain: d.name, ok: ids.length >= d.min }).toEqual({ domain: d.name, ok: true })
      const w = await window(d.table, d.at, ids)
      expect({ domain: d.name, n: w.n }).toEqual({ domain: d.name, n: ids.length })
      expect({ domain: d.name, old: w.oldest.getTime() >= now - 14 * DAY_MS }).toEqual({
        domain: d.name,
        old: true,
      })
      expect({ domain: d.name, fresh: w.newest.getTime() >= now - 3_600_000 }).toEqual({
        domain: d.name,
        fresh: true,
      })
      expect({ domain: d.name, future: w.newest.getTime() > Date.now() }).toEqual({
        domain: d.name,
        future: false,
      })
    }
  })

  it("a seeded lively org has companies with people and deals on a pipeline", async () => {
    const orgId = first.world.orgId
    const rows = (q: ReturnType<typeof sql>) =>
      withSystemDb("lively-test-crm", async (tx) =>
        typedRows<Record<string, unknown>>(await tx.execute(q)),
      )
    const [companies] = await rows(
      sql`SELECT count(*)::int AS n,
                 count(*) FILTER (WHERE EXISTS (
                   SELECT 1 FROM kernel.contacts c WHERE c.company_id = k.id))::int AS with_people
          FROM kernel.companies k WHERE k.org_id = ${orgId}::uuid`,
    )
    expect(Number(companies?.n)).toBeGreaterThanOrEqual(10)
    expect(Number(companies?.with_people)).toBe(Number(companies?.n))
    const stages = await rows(
      sql`SELECT s.label AS stage, count(*)::int AS n
          FROM app_projects.deals d
          JOIN app_projects.tasks t ON t.id = d.task_id
          JOIN app_projects.project_statuses s ON s.id = t.status_id
          JOIN app_projects.projects p ON p.id = t.project_id AND p.kind = 'pipeline'
          WHERE d.org_id = ${orgId}::uuid AND d.company_id IS NOT NULL
          GROUP BY s.label`,
    )
    expect(stages.map((r) => r.stage).sort()).toEqual(
      ["Demo", "Lead", "Lost", "Proposal", "Qualified", "Won"].sort(),
    )
    const [amounts] = await rows(
      sql`SELECT count(*)::int AS n FROM app_projects.deal_values
          WHERE org_id = ${orgId}::uuid AND amount_minor > 0 AND currency IS NOT NULL`,
    )
    expect(Number(amounts?.n)).toBe(9)
  })

  it("records the country its world gives a contact as that contact's recipient country", async () => {
    // Mutation caught: no seeded contact had a recipient country, so the send check never knew one.
    const orgId = first.world.orgId
    const [row] = await withSystemDb("lively-test-contact-country", async (tx) =>
      typedRows<{ named: number; recorded: number }>(
        await tx.execute(
          sql`SELECT count(*) FILTER (WHERE metadata->>'country' IS NOT NULL)::int AS named,
                     count(*) FILTER (WHERE metadata->>'country' IS NOT NULL
                       AND recipient_country = upper(metadata->>'country'))::int AS recorded
              FROM kernel.contacts WHERE org_id = ${orgId}::uuid`,
        ),
      ),
    )
    expect(Number(row?.named)).toBeGreaterThanOrEqual(30)
    expect(Number(row?.recorded)).toBe(Number(row?.named))
  })

  it("puts each dealer's sales address on its dealer's company", async () => {
    const orgId = first.world.orgId
    const dealers = await withSystemDb("lively-test-dealer-contacts", async (tx) =>
      typedRows<{ company: string; on_company: number; sales: number }>(
        await tx.execute(
          sql`SELECT k.name AS company,
                     count(c.id) FILTER (WHERE c.company_id = k.id)::int AS on_company,
                     count(c.id)::int AS sales
              FROM kernel.companies k
              JOIN kernel.contacts c ON c.org_id = k.org_id AND c.email LIKE 'sales@%' AND c.name = k.name
              WHERE k.org_id = ${orgId}::uuid AND 'dealer' = ANY(k.tags)
              GROUP BY k.name`,
        ),
      ),
    )
    expect(dealers.length).toBeGreaterThan(0)
    expect(dealers.filter((d) => d.on_company !== d.sales)).toEqual([])
  })

  it("seeds no API connection on a box that does not answer its fixture origin", async () => {
    const [row] = await withSystemDb("lively-test-api-connector", async (tx) =>
      typedRows<{ n: number }>(
        await tx.execute(
          sql`SELECT count(*)::int AS n FROM kernel.connected_accounts
              WHERE org_id = ${first.world.orgId}::uuid AND app_name = 'api-connector'`,
        ),
      ),
    )
    expect(Number(row?.n)).toBe(0)
  })

  it("leaves each person a few unread attention items and reads the rest", async () => {
    const [row] = rowsOf(
      await withSystemDb("lively-test-unread", (tx) =>
        tx.execute(
          sql`SELECT count(DISTINCT user_id)::int AS people,
                     count(*) FILTER (WHERE read_at IS NULL)::int AS unread,
                     count(*) FILTER (WHERE read_at > now())::int AS future_reads
              FROM kernel.attention_events WHERE org_id = ${first.world.orgId}::uuid`,
        ),
      ),
    )
    expect(Number(row?.people)).toBe(10)
    expect(Number(row?.unread)).toBeGreaterThanOrEqual(10)
    expect(Number(row?.unread)).toBeLessThanOrEqual(30)
    expect(Number(row?.future_reads)).toBe(0)
  })

  it("labels demo tasks, so the board's Labels filter has groups and narrows the list", async () => {
    const orgId = first.world.orgId
    const activity = first.activity as LivelyActivity
    expect(activity.labelledTasks.length).toBe(10)
    const groups = typedRows<{ name: string; values: string[] }>(
      await withSystemDb("lively-test-labels", (tx) =>
        tx.execute(
          sql`SELECT g.name, array_agg(v.name ORDER BY v.sort_order) AS values
              FROM app_projects.labels g
              JOIN app_projects.labels v ON v.parent_id = g.id
              WHERE g.org_id = ${orgId}::uuid AND g.parent_id IS NULL
              GROUP BY g.name, g.sort_order ORDER BY g.sort_order`,
        ),
      ),
    )
    expect(groups).toEqual([
      { name: "Type", values: ["Bug", "Feature", "Chore"] },
      { name: "Area", values: ["Firmware", "Docs", "Web", "Logistics"] },
    ])
    // The board filter, as a person reads it: Area = Docs on the preamp board is
    // the manual, its two translations (inherited) and the knowledge base guide.
    const founder = first.world.org.people.find((p) => p.role === "founder_admin")
    expect(founder).toBeTruthy()
    const ctx = seedContext({ orgId, now: startedAt, log: () => {} })
    const viewer = await actorFor(ctx, founder!.userId)
    const titles = await asUser(viewer, async (tx) => {
      const project = typedRows<{ id: string }>(
        await tx.execute(
          sql`SELECT id FROM app_projects.projects WHERE org_id = ${orgId}::uuid AND key = 'PREAMP'`,
        ),
      )[0]
      expect(project).toBeTruthy()
      const all = await listTasks({ tx, orgId, projectId: project!.id })
      const docs = await listTasks({
        tx,
        orgId,
        projectId: project!.id,
        filters: { labels: { Area: "Docs" } },
      })
      return { all: all.items.length, docs: docs.items.map((t) => t.title).sort() }
    })
    expect(titles.docs).toEqual(
      [
        "English manual copy",
        "French manual translation",
        "Troubleshooting guide in the knowledge base",
        "Write the preamp manual",
      ].sort(),
    )
    expect(titles.all).toBeGreaterThan(titles.docs.length)
  })

  it("is idempotent: a second run writes no new row", async () => {
    const again = await seedLivelyWorld({
      orgSlug: SLUG,
      personaPassword: "Lively-Walk-1!",
      baseTime: first.world.support ? new Date(first.world.support.seededAt) : startedAt,
    })
    expect(again.complete).toBe(true)
    expect(again.world.orgId).toBe(first.world.orgId)
    expect(await orgRowCounts(first.world.orgId)).toEqual(counts)
  }, 900_000)

  it("replaces the org with a fresh one on request", async () => {
    const replaced = await seedLivelyWorld({ orgSlug: SLUG, replace: true })
    expect(replaced.replaced).toBe(true)
    expect(replaced.complete).toBe(true)
    expect(replaced.world.orgId).not.toBe(first.world.orgId)
    const [gone] = rowsOf(
      await withSystemDb("lively-test-gone", (tx) =>
        tx.execute(
          sql`SELECT count(*)::int AS n FROM kernel.organizations WHERE id = ${first.world.orgId}::uuid`,
        ),
      ),
    )
    expect(Number(gone?.n)).toBe(0)
    expect(await orgRowCounts(replaced.world.orgId)).toEqual(counts)
  }, 900_000)
})
