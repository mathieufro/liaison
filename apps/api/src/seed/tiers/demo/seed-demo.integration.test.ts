// SPDX-License-Identifier: FSL-1.1-ALv2
//
// `seedDemoWorld` against a REAL database: ONE org holding the WHOLE demo.
//
// This is the test whose absence let the gap through. The three layer seeders
// each had a thorough integration test, and each of them seeded its OWN org, so
// every one of them passed while no org on the box held people AND tickets AND
// invoices at the same time, which is the only state a visitor ever sees.
//
// What is proved here:
//
//  1. THE HEADLINE. One org, seeded once through the composed entry point,
//     holds people, agents, tickets, mail, knowledge, projects, invoices,
//     shipments, social findings, the demo marker and the Shopify fixture
//     connection, every count read back out of Postgres.
//  2. IDEMPOTENT ON CONTENT. Drift a row in each layer, re-seed, and assert the
//     content converged. Row counts alone cannot see a re-seed that leaves a
//     visitor's edit in place.
//  3. THE SPECIAL ACCOUNTS. The guest is real and really limited, and the
//     reviewer opens onto conversations and an approval waiting for a decision.
//
// Locally, against the isolated hardening database, never a shared one. Run it
// from `apps/api`: the modules it reaches for are written against apps/api's
// own `~/*` alias, which only resolves from a cwd whose tsconfig declares it.
//
//   cd apps/api && DATABASE_URL=postgres://liaison_app:liaison_app@localhost:5432/liaison_hardening_test \
//     bun test src/seed/tiers/demo/seed-demo.integration.test.ts --timeout 2400000
import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { sql } from "drizzle-orm"
import { searchTickets } from "~/apps/tickets/search"
import { withPrivilegedDb } from "~/db/privileged"
import { aggregateAttentionItems } from "~/modules/apps/attention-aggregator"
import { DemoModeTestAccess } from "~/modules/demo/demo-mode"
import { resetDemoOrgContent } from "~/modules/demo/demo-reset"
import { DEMO_REVIEWER_EMAIL } from "~/modules/demo/demo-seeder"
import { DEMO_SHOP_DOMAIN } from "~/modules/demo/shopify"
import { hasOverlay, orderPatch } from "~/modules/demo/shopify/overlay"
import { DEMO_WAREHOUSE_DSN_ENV } from "~/modules/demo/warehouse"
import { loadEffectivePermissions } from "~/modules/permissions/permissions"
import { seedContext } from "~/seed/context"
import { actorFor } from "~/seed/factories/people/actors"
import { installFromDist } from "../../../../test-support/seed/install-dist-apps"
import { ACTIVITY_THREAD_TITLES } from "./seed-agent-native"
import { type SeedDemoWorldResult, seedDemoWorld } from "./seed-demo"

const ORG_SLUG = process.env.DEMO_WORLD_TEST_SLUG ?? "demo-world-integration"
const DB_URL = process.env.DATABASE_URL ?? ""
const BASE_TIME = new Date("2026-09-16T09:00:00.000Z")
/** The demo apps shipped as catalog bundles, installed the way a demo box has them. */
const CATALOG_DEMO_APPS = [
  "invoicing",
  "social",
  "pennylane",
  "boxtal",
  "shopify",
  "monitoring",
  "stripe",
  // The oracle layer's headless app: a catalog app on a demo box like the others, so a
  // database with no catalog holding it would enable it for the org without registering it.
  "database",
]

/**
 * The org's OWNER: the one account a seeded demo org can be signed into. On the
 * reserved org that is App Review; on a visitor org it is the person who
 * registered. Either way it is the caller who supplies it, which is the whole
 * change: the seven seeded people are data and hold no password at all.
 */
const OWNER = {
  email: DEMO_REVIEWER_EMAIL,
  name: "App Review",
  password: "ReviewOwner1!Seed",
}

beforeAll(async () => {
  if (DB_URL === "") throw new Error("DATABASE_URL must be set for this test")
  if (/liaison_dev|liaison_test(?!_)/.test(DB_URL)) {
    throw new Error("refusing to seed a shared database: use liaison_hardening_test")
  }
  // `resetDemoOrgContent` refuses a process that is not a demo instance, which
  // is the guard that keeps `demo:seed --slug <a real tenant>` from emptying a
  // workspace on an ordinary production box. This test really does clear an
  // org, so it really is a demo instance for the duration.
  DemoModeTestAccess.set(true)
  // The warehouse layer runs on its own read-only login (a role in no Liaison
  // role), named by this variable on the demo box; here, the same login the
  // warehouse integration test provisions.
  process.env[DEMO_WAREHOUSE_DSN_ENV] ??= DB_URL.replace(
    /\/\/[^@]*@/,
    "//liaison_demo_warehouse_it:it-warehouse-password-0123456789@",
  )
  // The oracle layer creates a schema and a read-only role, which the
  // application role has no rights to. The demo box's app container carries
  // this variable already (deploy/docker-compose.yml); locally it is the same
  // superuser `db-reset.ts` uses.
  if (!process.env.MIGRATION_DATABASE_URL) {
    const name = DB_URL.split("/").pop() ?? "liaison_hardening_test"
    process.env.MIGRATION_DATABASE_URL = `postgres://postgres:postgres@localhost:5432/${name}`
  }
  if (!process.env.LIAISON_APPS_DIR) {
    process.env.LIAISON_APPS_DIR = path.join(
      mkdtempSync(path.join(tmpdir(), "demo-world-")),
      "apps",
    )
  }
  // A demo box has every catalog app installed before any seed; a fresh database has none, and the
  // commerce layer writes into their tables.
  for (const app of CATALOG_DEMO_APPS) await installFromDist(app, crypto.randomUUID())
})

/**
 * One count per LAYER, so a missing layer is visible as a zero rather than as a
 * slightly wrong total. Read straight out of Postgres: nothing here is taken
 * from the seeder's own return value.
 */
async function worldCounts(orgId: string): Promise<Record<string, number>> {
  return withPrivilegedDb(orgId, "demo-world-test-counts", async (tx) => {
    const one = async (query: ReturnType<typeof sql>): Promise<number> => {
      const result = await tx.execute(query)
      const list = Array.isArray(result) ? result : ((result as { rows?: unknown[] }).rows ?? [])
      return Number((list[0] as { count?: string | number } | undefined)?.count ?? 0)
    }
    return {
      // org layer
      users: await one(sql`SELECT count(*) AS count FROM kernel.users WHERE org_id = ${orgId}`),
      agents: await one(sql`SELECT count(*) AS count FROM kernel.agents WHERE org_id = ${orgId}`),
      // support layer
      tickets: await one(
        sql`SELECT count(*) AS count FROM app_tickets.tickets WHERE org_id = ${orgId}`,
      ),
      mailConversations: await one(
        sql`SELECT count(*) AS count FROM app_mail.conversations WHERE org_id = ${orgId}`,
      ),
      knowledgeDocuments: await one(
        sql`SELECT count(*) AS count FROM app_knowledge.documents WHERE org_id = ${orgId}`,
      ),
      projects: await one(
        sql`SELECT count(*) AS count FROM app_projects.projects WHERE org_id = ${orgId}`,
      ),
      calendarEvents: await one(
        sql`SELECT count(*) AS count FROM app_calendar.events WHERE org_id = ${orgId}`,
      ),
      contacts: await one(
        sql`SELECT count(*) AS count FROM kernel.contacts WHERE org_id = ${orgId}`,
      ),
      threads: await one(sql`SELECT count(*) AS count FROM kernel.threads WHERE org_id = ${orgId}`),
      approvals: await one(
        sql`SELECT count(*) AS count FROM kernel.approval_requests WHERE org_id = ${orgId}`,
      ),
      // commerce layer
      invoices: await one(
        sql`SELECT count(*) AS count FROM app_invoicing.documents WHERE org_id = ${orgId}`,
      ),
      shipments: await one(
        sql`SELECT count(*) AS count FROM app_boxtal.shipment WHERE org_id = ${orgId}`,
      ),
      socialFindings: await one(
        sql`SELECT count(*) AS count FROM app_social.finding WHERE org_id = ${orgId}`,
      ),
      pnlSnapshots: await one(
        sql`SELECT count(*) AS count FROM app_pennylane.pnl_snapshot WHERE org_id = ${orgId}`,
      ),
      // the marker and the fixture connection
      demoMarkers: await one(
        sql`SELECT count(*) AS count FROM kernel.organizations
            WHERE id = ${orgId} AND settings -> 'demo' IS NOT NULL`,
      ),
      shopifyConnections: await one(
        sql`SELECT count(*) AS count FROM kernel.connected_accounts
            WHERE org_id = ${orgId} AND app_name = 'shopify'
              AND identifier = ${DEMO_SHOP_DOMAIN} AND status = 'active'`,
      ),
      // the oracle layer: without this row every db_* tool answers
      // not_connected, which is exactly what the live demo box did.
      warehouseConnections: await one(
        sql`SELECT count(*) AS count FROM kernel.connected_accounts
            WHERE org_id = ${orgId} AND app_name = 'database' AND status = 'active'`,
      ),
    }
  })
}

async function scalar<T>(orgId: string, query: ReturnType<typeof sql>): Promise<T | undefined> {
  return withPrivilegedDb(orgId, "demo-world-test-scalar", async (tx) => {
    const result = await tx.execute(query)
    const list = Array.isArray(result) ? result : ((result as { rows?: unknown[] }).rows ?? [])
    const row = list[0] as Record<string, unknown> | undefined
    return row ? (Object.values(row)[0] as T) : undefined
  })
}

async function scopesFor(orgId: string, userId: string): Promise<string[]> {
  const perms = await withPrivilegedDb(orgId, "demo-world-test-perms", (tx) =>
    loadEffectivePermissions(tx, userId, orgId),
  )
  return perms.scopes
}

/** Does `scopes` satisfy `needed`, by the product's own prefix-hierarchical rule? */
afterAll(() => {
  DemoModeTestAccess.set(null)
})

function holds(scopes: string[], needed: string): boolean {
  return scopes.some((s) => s === "*" || s === needed || needed.startsWith(`${s}:`))
}

describe("seedDemoWorld: one org holding the whole demo", () => {
  let world: SeedDemoWorldResult
  let counts: Record<string, number>

  beforeAll(async () => {
    // Seed once to resolve the org, clear whatever a previous run left in it,
    // then seed the baseline. The hardening database is shared with the other
    // demo tests and with earlier runs of this one, so the baseline has to be
    // produced rather than assumed.
    const first = await seedDemoWorld({
      orgSlug: ORG_SLUG,
      variant: "reserved",
      owner: OWNER,
      baseTime: BASE_TIME,
      warehouse: true,
    })
    await resetDemoOrgContent(first.orgId)
    world = await seedDemoWorld({
      orgSlug: ORG_SLUG,
      variant: "reserved",
      owner: OWNER,
      baseTime: BASE_TIME,
      warehouse: true,
    })
    counts = await worldCounts(world.orgId)
  }, 2_400_000)

  // ── The headline ─────────────────────────────────────────────────────────

  it("seeds people AND tickets AND invoices AND knowledge AND shipments into the SAME org", () => {
    // Every one of these was zero in at least one of the three per layer orgs
    // the layer tests seed, which is exactly how the gap survived.
    expect(counts.users).toBeGreaterThanOrEqual(7)
    expect(counts.agents).toBeGreaterThanOrEqual(11)
    expect(counts.tickets).toBeGreaterThanOrEqual(30)
    expect(counts.mailConversations).toBeGreaterThanOrEqual(8)
    expect(counts.knowledgeDocuments).toBeGreaterThanOrEqual(10)
    expect(counts.projects).toBeGreaterThanOrEqual(3)
    expect(counts.calendarEvents).toBeGreaterThanOrEqual(8)
    expect(counts.contacts).toBeGreaterThanOrEqual(26)
    expect(counts.threads).toBeGreaterThanOrEqual(4)
    expect(counts.approvals).toBeGreaterThanOrEqual(5)
    expect(counts.invoices).toBeGreaterThanOrEqual(30)
    expect(counts.shipments).toBeGreaterThanOrEqual(10)
    expect(counts.socialFindings).toBeGreaterThanOrEqual(5)
    expect(counts.pnlSnapshots).toBeGreaterThanOrEqual(1)
    expect(counts.demoMarkers).toBe(1)
    expect(counts.shopifyConnections).toBe(1)
    expect(counts.warehouseConnections).toBe(1)
  })

  it("reports every layer as landed", () => {
    expect(world.failures).toEqual([])
    expect(world.complete).toBe(true)
    expect(world.support).not.toBeNull()
    expect(world.commerce).not.toBeNull()
    expect(world.accounts).not.toBeNull()
  })

  it("serves the ticket queue of THIS org through the product's own search path", async () => {
    const result = await withPrivilegedDb(world.orgId, "demo-world-test-search", (tx) =>
      searchTickets(tx as never, world.orgId, { limit: 100 } as never),
    )
    const items = (result as unknown as { items: unknown[] }).items
    expect(items.length).toBeGreaterThanOrEqual(25)
  })

  // ── Idempotency on CONTENT ───────────────────────────────────────────────

  it("restores every layer after a visitor has drifted it, the way the nightly reset does", async () => {
    const orgId = world.orgId
    // The seeders are idempotent but NOT self healing: a ticket is adopted by
    // its `externalRef`, an article by its title, a person by their address, so
    // re-running the seeder on its own leaves a rewritten subject rewritten.
    // `resetDemoOrgContent` is what closes that, and the two together are the
    // nightly reset. Drift one row per layer first.
    const ticketId = await scalar<string>(
      orgId,
      sql`SELECT id FROM app_tickets.tickets WHERE org_id = ${orgId} ORDER BY created_at LIMIT 1`,
    )
    const docId = await scalar<string>(
      orgId,
      sql`SELECT id FROM app_invoicing.documents WHERE org_id = ${orgId} ORDER BY created_at LIMIT 1`,
    )
    const articleId = await scalar<string>(
      orgId,
      sql`SELECT id FROM app_knowledge.documents WHERE org_id = ${orgId} ORDER BY created_at LIMIT 1`,
    )
    expect(ticketId).toBeDefined()
    expect(docId).toBeDefined()
    expect(articleId).toBeDefined()

    const before = {
      subject: await scalar<string>(
        orgId,
        sql`SELECT subject FROM app_tickets.tickets WHERE id = ${ticketId}`,
      ),
      docNumber: await scalar<string>(
        orgId,
        sql`SELECT number FROM app_invoicing.documents WHERE id = ${docId}`,
      ),
      articleTitle: await scalar<string>(
        orgId,
        sql`SELECT title FROM app_knowledge.documents WHERE id = ${articleId}`,
      ),
      marker: await scalar<string>(
        orgId,
        sql`SELECT settings -> 'demo' ->> 'variant' FROM kernel.organizations WHERE id = ${orgId}`,
      ),
      counts: await worldCounts(orgId),
    }

    await withPrivilegedDb(orgId, "demo-world-test-drift", async (tx) => {
      await tx.execute(
        sql`UPDATE app_tickets.tickets SET subject = 'drifted by a visitor' WHERE id = ${ticketId}`,
      )
      await tx.execute(
        sql`UPDATE app_invoicing.documents SET number = 'DRIFTED-0001' WHERE id = ${docId}`,
      )
      await tx.execute(
        sql`UPDATE app_knowledge.documents SET title = 'drifted by a visitor' WHERE id = ${articleId}`,
      )
      // The org layer's own drift: the marker a visitor's org would carry.
      await tx.execute(
        sql`UPDATE kernel.organizations
            SET settings = settings || jsonb_build_object('demo',
              (settings -> 'demo') || '{"variant":"visitor"}'::jsonb)
            WHERE id = ${orgId}`,
      )
    })
    // And a write against the Shopify fixture store, which lives in memory and
    // no SQL reset would ever reach.
    orderPatch(orgId, "gid://shopify/Order/1").note = "drifted by a visitor"
    expect(hasOverlay(orgId)).toBe(true)

    // THE RESET, exactly as the nightly job runs it.
    await resetDemoOrgContent(orgId)
    const again = await seedDemoWorld({
      orgSlug: ORG_SLUG,
      variant: "reserved",
      owner: OWNER,
      baseTime: BASE_TIME,
      warehouse: true,
    })
    expect(again.failures).toEqual([])
    expect(again.orgId).toBe(orgId)

    // Ids are re-derived from the same natural keys, so the drifted rows are
    // located by the same query rather than by the id the drift used.
    const after = {
      subject: await scalar<string>(
        orgId,
        sql`SELECT subject FROM app_tickets.tickets WHERE org_id = ${orgId} ORDER BY created_at LIMIT 1`,
      ),
      docNumber: await scalar<string>(
        orgId,
        sql`SELECT number FROM app_invoicing.documents WHERE org_id = ${orgId} ORDER BY created_at LIMIT 1`,
      ),
      articleTitle: await scalar<string>(
        orgId,
        sql`SELECT title FROM app_knowledge.documents WHERE org_id = ${orgId} ORDER BY created_at LIMIT 1`,
      ),
      marker: await scalar<string>(
        orgId,
        sql`SELECT settings -> 'demo' ->> 'variant' FROM kernel.organizations WHERE id = ${orgId}`,
      ),
      counts: await worldCounts(orgId),
    }
    expect(after).toEqual(before)
    expect(hasOverlay(orgId)).toBe(false)
  }, 2_400_000)

  it("does not duplicate anything when the seeder is simply run again", async () => {
    const before = await worldCounts(world.orgId)
    const again = await seedDemoWorld({
      orgSlug: ORG_SLUG,
      variant: "reserved",
      owner: OWNER,
      baseTime: BASE_TIME,
      warehouse: true,
    })
    expect(again.failures).toEqual([])
    expect(await worldCounts(world.orgId)).toEqual(before)
  }, 2_400_000)

  // ── The owner, and the people who are only data ──────────────────────────
  //
  // THE MUTATION THAT PROVES THESE BITE: drop the `owner` field from
  // `buildConfig`'s `admin` entry in seed-org.ts, so the founder persona takes
  // the seat back. The owner is then not an admin, not in any thread and on no
  // approval, and the personas get passwords again.

  it("a return declares its goods' positive value, and a personal mailbox awaiting its keys never synced", async () => {
    const rows = await withPrivilegedDb(world.orgId, "demo-world-test-returns", async (tx) => {
      const list = async (query: ReturnType<typeof sql>) => {
        const result = await tx.execute(query)
        return (
          Array.isArray(result) ? result : ((result as { rows?: unknown[] }).rows ?? [])
        ) as Array<Record<string, unknown>>
      }
      return {
        returns: await list(
          sql`SELECT declared_total FROM app_boxtal.shipment WHERE org_id = ${world.orgId} AND kind = 'return'`,
        ),
        pending: await list(
          sql`SELECT last_sync_at FROM app_mail.accounts
              WHERE org_id = ${world.orgId} AND encryption_state = 'pending_enrollment'`,
        ),
      }
    })
    expect(rows.returns.length).toBeGreaterThan(0)
    for (const r of rows.returns) expect(Number(r.declared_total)).toBeGreaterThan(0)
    for (const m of rows.pending) expect(m.last_sync_at).toBeNull()
  })

  it("makes the OWNER the org's admin, not one of the seeded people", async () => {
    const ownerUserId = world.org.ownerUserId
    expect(ownerUserId).not.toBeNull()
    const scopes = await scopesFor(world.orgId, ownerUserId ?? "")
    expect(holds(scopes, "tickets:tickets:read")).toBe(true)
    expect(holds(scopes, "kernel:approvals:write")).toBe(true)
    expect(holds(scopes, "invoicing:documents:read")).toBe(true)
  })

  it("puts the owner INSIDE the world: the conversations and a live approval", async () => {
    const orgId = world.orgId
    const userId = world.org.ownerUserId ?? ""
    const threadCount = await scalar<string>(
      orgId,
      sql`SELECT count(*) AS count FROM kernel.thread_participants
          WHERE org_id = ${orgId} AND user_id = ${userId}`,
    )
    expect(Number(threadCount ?? 0)).toBeGreaterThan(0)

    const pending = await scalar<string>(
      orgId,
      sql`SELECT count(*) AS count FROM kernel.approval_requests
          WHERE org_id = ${orgId} AND status = 'pending' AND ${userId}::uuid = ANY(notify_user_ids)`,
    )
    expect(Number(pending ?? 0)).toBeGreaterThan(0)
  })

  // The Home feed reads an app's stored attention list and runs no app code, so
  // a seed that did not store the lists opens on empty queues.
  it("opens the owner's Home with the seeded support and knowledge queues already stored", async () => {
    const orgId = world.orgId
    const userId = world.org.ownerUserId ?? ""
    const stored = await withPrivilegedDb(orgId, "demo-world-test-attention", async (tx) => {
      const r = await tx.execute(
        sql`SELECT app FROM kernel.app_attention_items
            WHERE org_id = ${orgId} AND user_id = ${userId}::uuid AND error IS NULL`,
      )
      return (Array.isArray(r) ? r : ((r as { rows?: unknown[] }).rows ?? [])) as Array<{
        app: string
      }>
    })
    expect(stored.map((r) => r.app)).toEqual(expect.arrayContaining(["tickets", "knowledge"]))

    const actor = await actorFor(seedContext({ orgId, now: BASE_TIME }), userId)
    const feed = await aggregateAttentionItems({ orgId, actor })
    expect(feed.errors ?? []).toEqual([])
    const count = (app: string) => feed.items.filter((i) => i.app === app).length
    expect(count("tickets")).toBeGreaterThan(0)
    expect(count("knowledge")).toBeGreaterThan(0)
  })

  // THE TWO LAYERS AGREE ON THE WORLD. The activity timeline points at threads
  // BY TITLE, and a spec naming a title the support layer never writes is
  // skipped silently: the agent's Activity tab then holds fewer rows than the
  // seed thinks it wrote, and nothing fails. The agent native layer's own suite
  // cannot see it, because it manufactures the threads it needs. Only the whole
  // world can, so it is asserted here.
  //
  // THE MUTATION THAT PROVES THIS BITES: change one `threadTitle` in
  // ACTIVITY_SPECS to a title no THREAD_SPEC carries. The row vanishes and this
  // count drops.
  it("names only threads the support layer really writes, so no activity row is dropped", async () => {
    const agentNative = world.agentNative
    expect(agentNative).not.toBeNull()
    expect(agentNative?.counts.knowledgePointers ?? 0).toBeGreaterThan(0)
    expect(ACTIVITY_THREAD_TITLES.length).toBeGreaterThan(0)
    for (const title of ACTIVITY_THREAD_TITLES) {
      const found = await scalar<string>(
        world.orgId,
        sql`SELECT count(*) AS count FROM kernel.threads
            WHERE org_id = ${world.orgId} AND title = ${title}`,
      )
      expect({ title, found: Number(found ?? 0) }).toEqual({ title, found: 1 })
    }
  })

  // A CHANNEL NOBODY HANDED YOU. The accounts layer joins the owner to every
  // conversation in the org, which is what stops a fresh sign in opening onto
  // an empty Chats list. A DISCOVERABLE channel is the one thing that must
  // survive that: it exists to be FOUND, in the browser, by somebody who is not
  // in it, and an owner joined to it on their way in has nothing left to find.
  //
  // THE MUTATION THAT PROVES THIS BITES: drop the discoverable clause from
  // `threadIdsFor` in seed-accounts.ts. The owner becomes a participant of the
  // open channel too and the channel browser has nothing to show them.
  it("leaves a discoverable channel UNJOINED, so the owner has one to find", async () => {
    const orgId = world.orgId
    const userId = world.org.ownerUserId ?? ""
    const open = await scalar<string>(
      orgId,
      sql`SELECT count(*) AS count FROM kernel.threads t
          WHERE t.org_id = ${orgId} AND t.discoverable = true
            AND NOT EXISTS (
              SELECT 1 FROM kernel.thread_participants p
              WHERE p.thread_id = t.id AND p.user_id = ${userId}::uuid
            )`,
    )
    expect(Number(open ?? 0)).toBeGreaterThan(0)
  })

  // THE MUTATION THAT PROVES THIS BITES: delete the `ownerUserId && !people
  // .some(...)` block in seed-org.ts. The seven staff personas keep their
  // agents and every other assertion here still passes, but the one account
  // anybody signs in as (App Review, or a visitor) opens the product on a chat
  // with nobody in it.
  it("gives the OWNER their own personal agent, not just the seeded staff", async () => {
    const orgId = world.orgId
    const userId = world.org.ownerUserId ?? ""
    const mine = await scalar<string>(
      orgId,
      sql`SELECT count(*) AS count FROM kernel.agents
          WHERE org_id = ${orgId} AND owner_user_id = ${userId}::uuid AND kind = 'personal'`,
    )
    expect(Number(mine ?? 0)).toBe(1)

    // And nobody in the org is left without one, owner included.
    const orphans = await scalar<string>(
      orgId,
      sql`SELECT count(*) AS count FROM kernel.users u
          WHERE u.org_id = ${orgId}
            AND NOT EXISTS (
              SELECT 1 FROM kernel.agents a
              WHERE a.org_id = u.org_id AND a.owner_user_id = u.id AND a.kind = 'personal')`,
    )
    expect(Number(orphans ?? 0)).toBe(0)
  })

  it("leaves every seeded person with NO password, so none of them is a door", async () => {
    const orgId = world.orgId
    const withPasswords = await scalar<string>(
      orgId,
      sql`SELECT count(*) AS count FROM kernel.users
          WHERE org_id = ${orgId} AND password_hash IS NOT NULL`,
    )
    // Exactly one account in the org can be signed into: its owner.
    expect(Number(withPasswords ?? 0)).toBe(1)
    const ownerHash = await scalar<string>(
      orgId,
      sql`SELECT password_hash FROM kernel.users WHERE id = ${world.org.ownerUserId}`,
    )
    expect(typeof ownerHash).toBe("string")
  })
})

// The plan fails loud. The warehouse is an OPT-IN part: off, it is not seeded,
// the result names it in `partsOff` and the seed is complete, so a box without
// the warehouse's login no longer reports every seed as half done. On, its
// failure is an error like any other part's: `complete` is false and the
// failure names the part, never a quiet success.
//
// THE MUTATION THAT PROVES THESE BITE: default `warehouse` to true in
// `seedDemoWorldLayers` (the first fails), or drop the DSN check at the top of
// `seedDemoWarehouse` (the second comes back complete with a dead connection).
describe("seedDemoWorld: the warehouse part is explicit and its failure is an error", () => {
  const slug = `${ORG_SLUG}-parts`

  it("off: not seeded, named in partsOff, and the seed is complete", async () => {
    const world = await seedDemoWorld({
      orgSlug: slug,
      variant: "visitor",
      baseTime: BASE_TIME,
      needs: ["commerce"],
      warehouse: false,
    })
    expect(world.failures).toEqual([])
    expect(world.complete).toBe(true)
    expect(world.warehouse).toBeNull()
    expect(world.partsOff).toEqual(["warehouse"])
    expect((await worldCounts(world.orgId)).warehouseConnections).toBe(0)
  }, 2_400_000)

  it("on without the warehouse login: the seed FAILS and names the part", async () => {
    const saved = process.env[DEMO_WAREHOUSE_DSN_ENV]
    delete process.env[DEMO_WAREHOUSE_DSN_ENV]
    try {
      const world = await seedDemoWorld({
        orgSlug: slug,
        variant: "visitor",
        baseTime: BASE_TIME,
        needs: ["commerce"],
        warehouse: true,
      })
      expect(world.complete).toBe(false)
      expect(world.partsOff).toEqual([])
      expect(world.failures.map((f) => f.layer)).toEqual(["warehouse"])
      expect(world.failures[0]?.message).toContain(DEMO_WAREHOUSE_DSN_ENV)
      expect(world.warehouse).toBeNull()
    } finally {
      if (saved !== undefined) process.env[DEMO_WAREHOUSE_DSN_ENV] = saved
    }
  }, 2_400_000)
})

// Regression, and the reason the guard exists. Run as a script inside the app
// container, the demo seed pulled the api import graph, which registered the
// `app-kernel` BullMQ worker at module scope. The seed process therefore became
// a WORKER: its log carried `"service":"jobs","worker":"app-kernel"` and "No
// handler registered for job: app-kernel:search-index-upsert ... Job exhausted
// all retries" for the tickets and knowledge documents it had just seeded, so
// it ate the jobs the app process owned and those items never reached the
// search index.
//
// The seed now runs through `liaison seed --tier demo`. Asserted on that
// process's real prelude plus the whole seed graph, in a real subprocess,
// because the failure is a property of the process's import graph: nothing
// in-process can see it.
describe("the seed CLI process owns no job worker", () => {
  it("the liaison CLI prelude plus the demo seed graph registers zero BullMQ workers", async () => {
    const script = `
      import "~/cli/cli-env"
      import "~/cli/seed/run"
      import "~/seed/tiers/demo/seed-demo"
      const jobs = await import("~/infra/jobs/jobs")
      console.log("job-workers=" + jobs.jobWorkerCount())
      await jobs.closeAllQueues()
      process.exit(0)
    `
    const proc = Bun.spawn(["bun", "-e", script], {
      // apps/api: the graph is written against its own path alias.
      cwd: path.resolve(import.meta.dir, "../../../.."),
      env: { ...process.env },
      stdout: "pipe",
      stderr: "pipe",
    })
    const [out, err, code] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ])
    expect(`${code} ${out} ${err}`).toContain("job-workers=0")
    expect(code).toBe(0)
  }, 300_000)
})
