// SPDX-License-Identifier: FSL-1.1-ALv2
//
// `seedDemoWorld` with a visitor's picks (the seed split) against a REAL
// database: the baseline plus the picked needs' apps and parts, nothing else;
// no approval names a tool of an absent app; the support scenario's routine is
// on (switched on after every seeded ticket was written, so none fired it and
// no system message or refused turn exists); the sales scenario's routine is
// seeded off, filtered on the prospect; the visitor's scenario task exists
// only when projects is picked.
//
//   cd apps/api && DATABASE_URL=postgres://liaison_app:liaison_app@localhost:5432/liaison_hardening_test \
//     bun test src/seed/tiers/demo/seed-tailored.integration.test.ts --timeout 2400000
import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { DEMO_WORLD_NEEDS } from "@liaison/shared"
import { sql } from "drizzle-orm"
import { withPrivilegedDb } from "~/db/privileged"
import { DemoModeTestAccess } from "~/modules/demo/demo-mode"
import { computeUnreadMessageCount } from "~/modules/push/badge-count"
import { demoId } from "~/seed/context"
import { installFromDist } from "../../../../test-support/seed/install-dist-apps"
import { demoSeedPlan } from "./demo-apps"
import { PROSPECT_SCENARIO_ROUTINE, SUPPORT_SCENARIO_ROUTINE } from "./seed-agent-native"
import { type SeedDemoWorldResult, seedDemoWorld, seedScenarioStart } from "./seed-demo"
import {
  approvalScenarioNeed,
  MAIL_TOUR_CONVERSATION,
  SCENARIO_PROSPECT,
  SCENARIO_TASK,
  SHORT_BACKLOG,
} from "./seed-support"

const DB_URL = process.env.DATABASE_URL ?? ""
const BASE_TIME = new Date("2026-09-16T09:00:00.000Z")
const NEEDS = ["support", "sales"] as const
/** The demo apps shipped as catalog bundles; the others are in-tree. */
const CATALOG_DEMO_APPS = ["invoicing", "social", "pennylane", "boxtal", "shopify", "monitoring"]

async function rows<T>(orgId: string, query: ReturnType<typeof sql>): Promise<T[]> {
  return withPrivilegedDb(orgId, "demo-tailored-test", async (tx) => {
    const result = await tx.execute(query)
    return (Array.isArray(result) ? result : ((result as { rows?: unknown[] }).rows ?? [])) as T[]
  })
}

/**
 * The Mail tour opens the newest unread conversation, the one waiting on an
 * answer (walk D49): after a visitor's seed it is the only unread one, its
 * last message is the customer's, and nobody (no routine) has replied or
 * staged a reply to it.
 */
async function expectOnlyMailTourConversationUnread(orgId: string): Promise<void> {
  const target = demoId(orgId, "mail-conversation", MAIL_TOUR_CONVERSATION)
  const unread = await rows<{ id: string }>(
    orgId,
    sql`SELECT id::text AS id FROM app_mail.conversations WHERE org_id = ${orgId} AND is_read = false`,
  )
  expect(unread.map((r) => r.id)).toEqual([target])
  const [last] = await rows<{ direction: string }>(
    orgId,
    sql`SELECT direction FROM app_mail.messages WHERE org_id = ${orgId}
        AND conversation_id = ${target}::uuid ORDER BY sent_at DESC LIMIT 1`,
  )
  expect(last?.direction).toBe("inbound")
  const replies = await rows<{ id: string }>(
    orgId,
    sql`SELECT id::text AS id FROM kernel.approval_requests WHERE org_id = ${orgId}
        AND tool_name LIKE 'mail:%' AND tool_params::text LIKE ${`%${target}%`}`,
  )
  expect(replies).toEqual([])
}

beforeAll(() => {
  if (DB_URL === "") throw new Error("DATABASE_URL must be set for this test")
  if (/liaison_dev|liaison_test(?!_)/.test(DB_URL)) {
    throw new Error("refusing to seed a shared database: use liaison_hardening_test")
  }
  DemoModeTestAccess.set(true)
  if (!process.env.LIAISON_APPS_DIR) {
    process.env.LIAISON_APPS_DIR = path.join(
      mkdtempSync(path.join(tmpdir(), "demo-tailored-")),
      "apps",
    )
  }
})

afterAll(() => {
  DemoModeTestAccess.set(null)
})

describe("seedDemoWorld with needs [support, sales]", () => {
  let world: SeedDemoWorldResult

  beforeAll(async () => {
    // A demo box has every catalog app installed before any visitor arrives
    // (the sales pick quotes through invoicing), and a fresh database has none:
    // without this, what the world held depended on which file ran before it.
    for (const app of CATALOG_DEMO_APPS) await installFromDist(app, crypto.randomUUID())
    world = await seedDemoWorld({
      orgSlug: `demo-tailored-${crypto.randomUUID().slice(0, 8)}`,
      variant: "visitor",
      owner: {
        email: `visitor-${crypto.randomUUID()}@visitor.demo.invalid`,
        name: "Visitor",
        password: "VisitorOwner1!Seed",
      },
      baseTime: BASE_TIME,
      needs: NEEDS,
    })
  }, 2_400_000)

  it("lands every layer it was asked for", () => {
    expect(world.failures).toEqual([])
    expect(world.complete).toBe(true)
    expect(world.commerce).toBeNull()
    expect(world.warehouse).toBeNull()
  })

  it("enables the plan's apps, and no shop, no projects", async () => {
    const [org] = await rows<{ enabled: string[] | null }>(
      world.orgId,
      sql`SELECT settings->'enabledApps' AS enabled FROM kernel.organizations WHERE id = ${world.orgId}`,
    )
    const enabled = new Set(org?.enabled ?? [])
    for (const app of demoSeedPlan([...NEEDS], { warehouse: false }).apps)
      expect(enabled.has(app)).toBe(true)
    expect(enabled.has("shopify")).toBe(false)
    expect(enabled.has("projects")).toBe(false)
  })

  it("turns Off every demo app the visitor did not pick, and none they picked", async () => {
    const state = await rows<{ name: string; status: string }>(
      world.orgId,
      sql`SELECT name, status::text AS status FROM kernel.apps WHERE org_id = ${world.orgId}`,
    )
    const status = new Map(state.map((r) => [r.name, r.status]))
    // An app this deployment registered for the org is Off; one it never
    // registered has no row, so the visitor has no way to it either.
    // The apps the picks leave out come from the plan: the sales pick needs
    // invoicing, so it is not one of them.
    const unpicked = demoSeedPlan([...NEEDS], { warehouse: false }).offApps
    expect([...unpicked]).toEqual(
      expect.arrayContaining(["shopify", "boxtal", "monitoring", "social", "projects"]),
    )
    for (const app of unpicked) {
      expect({ app, status: status.get(app) ?? "absent" }).toEqual({
        app,
        status: expect.stringMatching(/^(disabled|absent)$/),
      })
    }
    // Projects is in-tree, always registered: the Off write itself is proven.
    expect(status.get("projects")).toBe("disabled")
    // And a catalog app the box installed (beforeAll) is Off too.
    expect(status.get("shopify")).toBe("disabled")
    for (const app of demoSeedPlan([...NEEDS], { warehouse: false }).apps) {
      expect({ app, off: status.get(app) === "disabled" }).toEqual({ app, off: false })
    }
  })

  it("leaves only the Mail tour's conversation unread, unanswered", async () => {
    await expectOnlyMailTourConversationUnread(world.orgId)
  })

  it("seeds tickets and mail, no projects and no scenario task", async () => {
    const [c] = await rows<{ tickets: number; mail: number; tasks: number }>(
      world.orgId,
      sql`SELECT
        (SELECT count(*)::int FROM app_tickets.tickets WHERE org_id = ${world.orgId}) AS tickets,
        (SELECT count(*)::int FROM app_mail.conversations WHERE org_id = ${world.orgId}) AS mail,
        (SELECT count(*)::int FROM kernel.contacts WHERE org_id = ${world.orgId}
           AND lower(email) = ${SCENARIO_PROSPECT.email}) AS tasks`,
    )
    expect(c?.tickets).toBeGreaterThan(0)
    expect(c?.mail).toBeGreaterThan(0)
    expect(c?.tasks).toBe(1) // the prospect contact
    expect(world.support?.projectIds).toEqual([])
    expect(SCENARIO_TASK.externalRef).toBeTruthy()
  })

  it("no approval names a tool of an absent app", async () => {
    const installed = new Set(demoSeedPlan([...NEEDS], { warehouse: false }).apps)
    const tools = await rows<{ tool_name: string }>(
      world.orgId,
      sql`SELECT tool_name FROM kernel.approval_requests WHERE org_id = ${world.orgId}`,
    )
    for (const { tool_name } of tools) {
      const app = tool_name.split(":")[0] ?? ""
      expect(app === "kernel" || installed.has(app)).toBe(true)
    }
  })

  it("the support routine is on, the prospect routine off and filtered on the prospect", async () => {
    const list = await rows<{ name: string; enabled: boolean; event_filter: unknown }>(
      world.orgId,
      sql`SELECT name, enabled, event_filter FROM kernel.routines WHERE org_id = ${world.orgId}
          AND name IN (${SUPPORT_SCENARIO_ROUTINE}, ${PROSPECT_SCENARIO_ROUTINE})`,
    )
    const byName = new Map(list.map((r) => [r.name, r]))
    expect(byName.get(SUPPORT_SCENARIO_ROUTINE)?.enabled).toBe(true)
    expect(byName.get(PROSPECT_SCENARIO_ROUTINE)?.enabled).toBe(false)
    expect(byName.get(PROSPECT_SCENARIO_ROUTINE)?.event_filter).toMatchObject({
      fromContactIds: [expect.any(String)],
    })
  })

  // The sales scenario's brief beat points at the routine's report in the
  // owner's direct messages with their agent: the routine reports there.
  it("the prospect routine reports to the owner's direct messages with its agent", async () => {
    const [r] = await rows<{ thread_type: string | null; seats: number; owner_seated: boolean }>(
      world.orgId,
      sql`SELECT t.type AS thread_type,
            (SELECT count(*)::int FROM kernel.thread_participants tp
              WHERE tp.thread_id = t.id AND tp.agent_id = r.owner_agent_id) AS seats,
            EXISTS (SELECT 1 FROM kernel.thread_participants tp
              WHERE tp.thread_id = t.id AND tp.user_id = r.owner_user_id) AS owner_seated
          FROM kernel.routines r LEFT JOIN kernel.threads t ON t.id = r.report_thread_id
          WHERE r.org_id = ${world.orgId} AND r.name = ${PROSPECT_SCENARIO_ROUTINE}`,
    )
    expect(r).toEqual({ thread_type: "agent_chat", seats: 1, owner_seated: true })
  })

  it("no seeded ticket fired the support routine: no run, no system message", async () => {
    const [c] = await rows<{ runs: number; system: number }>(
      world.orgId,
      sql`SELECT
        (SELECT count(*)::int FROM kernel.routine_runs WHERE org_id = ${world.orgId}) AS runs,
        (SELECT count(*)::int FROM kernel.messages WHERE org_id = ${world.orgId}
           AND author_type = 'system') AS system`,
    )
    expect(c).toEqual({ runs: 0, system: 0 })
  })
})

describe("seedDemoWorld with needs [projects, chat]", () => {
  let world: SeedDemoWorldResult

  beforeAll(async () => {
    world = await seedDemoWorld({
      orgSlug: `demo-tailored-${crypto.randomUUID().slice(0, 8)}`,
      variant: "visitor",
      owner: {
        email: `visitor-${crypto.randomUUID()}@visitor.demo.invalid`,
        name: "Visitor",
        password: "VisitorOwner1!Seed",
      },
      baseTime: BASE_TIME,
      needs: ["projects", "chat"],
    })
  }, 2_400_000)

  it("seeds projects and the visitor's scenario task, assigned to them; no tickets", async () => {
    expect(world.failures).toEqual([])
    const [c] = await rows<{ tickets: number; assignee: string | null }>(
      world.orgId,
      sql`SELECT
        (SELECT count(*)::int FROM app_tickets.tickets WHERE org_id = ${world.orgId}) AS tickets,
        (SELECT assignee_id::text FROM app_projects.tasks WHERE org_id = ${world.orgId}
           AND external_ref = ${SCENARIO_TASK.externalRef}) AS assignee`,
    )
    expect(c?.tickets).toBe(0)
    expect(c?.assignee).toBe(world.org.ownerUserId)
  })
})

// Walk D65: Team chat picked alone ends by turning the agent's answer into a
// task, so it brings Projects and a project to put the task in, not the
// Projects scenario's own task.
describe("seedDemoWorld with needs [chat]", () => {
  let world: SeedDemoWorldResult

  beforeAll(async () => {
    world = await seedDemoWorld({
      orgSlug: `demo-tailored-${crypto.randomUUID().slice(0, 8)}`,
      variant: "visitor",
      owner: {
        email: `visitor-${crypto.randomUUID()}@visitor.demo.invalid`,
        name: "Visitor",
        password: "VisitorOwner1!Seed",
      },
      baseTime: BASE_TIME,
      needs: ["chat"],
    })
  }, 2_400_000)

  it("shows Projects with its seeded projects, and no scenario task", async () => {
    expect(world.failures).toEqual([])
    const [org] = await rows<{ hidden: string[] | null }>(
      world.orgId,
      sql`SELECT settings->'hiddenApps' AS hidden FROM kernel.organizations WHERE id = ${world.orgId}`,
    )
    expect(org?.hidden ?? []).not.toContain("projects")
    const [c] = await rows<{ projects: number; scenarioTask: number }>(
      world.orgId,
      sql`SELECT
        (SELECT count(*)::int FROM app_projects.projects WHERE org_id = ${world.orgId}) AS projects,
        (SELECT count(*)::int FROM app_projects.tasks WHERE org_id = ${world.orgId}
           AND external_ref = ${SCENARIO_TASK.externalRef}) AS "scenarioTask"`,
    )
    expect(c?.projects).toBeGreaterThan(0)
    expect(c?.scenarioTask).toBe(0)
  })
})

// D23: an Everything visit opens calm. The seeded world is background the
// visitor never saw arrive (read), nothing waits on them until a scenario
// starts (its own approvals then), and each app holds a short backlog.
describe("an Everything visit", () => {
  let world: SeedDemoWorldResult
  let ownerId: string

  async function pendingForOwner(): Promise<string[]> {
    const list = await rows<{ tool_name: string }>(
      world.orgId,
      sql`SELECT tool_name FROM kernel.approval_requests
          WHERE org_id = ${world.orgId} AND status = 'pending'
            AND ${ownerId}::uuid = ANY(notify_user_ids)`,
    )
    return list.map((r) => r.tool_name)
  }

  beforeAll(async () => {
    // Everything seeds every layer, whose catalog apps a demo box has
    // installed before any visitor arrives; a fresh database has none.
    for (const app of CATALOG_DEMO_APPS) await installFromDist(app, crypto.randomUUID())
    world = await seedDemoWorld({
      orgSlug: `demo-everything-${crypto.randomUUID().slice(0, 8)}`,
      variant: "visitor",
      owner: {
        email: `visitor-${crypto.randomUUID()}@visitor.demo.invalid`,
        name: "Visitor",
        password: "VisitorOwner1!Seed",
      },
      needs: [...DEMO_WORLD_NEEDS.products],
    })
    ownerId = world.org.ownerUserId ?? ""
  }, 2_400_000)

  it("opens with no unread conversation, ticket or mail but the Mail tour's", async () => {
    expect(world.failures).toEqual([])
    expect(await computeUnreadMessageCount(ownerId, world.orgId)).toBe(0)
    const [c] = await rows<{ tickets: number; mail: number }>(
      world.orgId,
      sql`SELECT
        (SELECT count(*)::int FROM app_tickets.tickets t WHERE t.org_id = ${world.orgId}
           AND t.last_inbound_at IS NOT NULL AND t.status <> 'closed'
           AND NOT EXISTS (SELECT 1 FROM app_tickets.ticket_reads tr
             WHERE tr.ticket_id = t.id AND tr.read_at >= t.last_inbound_at)) AS tickets,
        (SELECT count(*)::int FROM app_mail.conversations WHERE org_id = ${world.orgId}
           AND is_read = false) AS mail`,
    )
    expect(c).toEqual({ tickets: 0, mail: 1 })
    await expectOnlyMailTourConversationUnread(world.orgId)
  })

  it("has nothing waiting on the visitor before a scenario starts", async () => {
    expect(await pendingForOwner()).toEqual([])
  })

  it("seeds a short backlog per app", async () => {
    const [c] = await rows<{ tickets: number; mail: number }>(
      world.orgId,
      sql`SELECT
        (SELECT count(*)::int FROM app_tickets.tickets WHERE org_id = ${world.orgId}) AS tickets,
        (SELECT count(*)::int FROM app_mail.conversations WHERE org_id = ${world.orgId}) AS mail`,
    )
    // The most recent few, plus what a seeded approval names.
    expect(c?.tickets).toBeGreaterThan(0)
    expect(c?.tickets).toBeLessThanOrEqual(SHORT_BACKLOG + 3)
    expect(c?.mail).toBeGreaterThan(0)
    expect(c?.mail).toBeLessThanOrEqual(SHORT_BACKLOG + 3)
  })

  it("starting a scenario brings in that scenario's approvals only", async () => {
    const ids = await seedScenarioStart(world.orgId, ownerId, "support")
    expect(ids.length).toBeGreaterThan(0)
    const pending = await pendingForOwner()
    expect(pending.length).toBe(ids.length)
    for (const tool of pending) expect(approvalScenarioNeed({ toolName: tool })).toBe("support")
    // A replay brings in nothing twice.
    await seedScenarioStart(world.orgId, ownerId, "support")
    expect((await pendingForOwner()).length).toBe(ids.length)
  })
})
