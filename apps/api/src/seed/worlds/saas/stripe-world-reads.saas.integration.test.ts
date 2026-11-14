// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The software world seeded once, as a visitor org at the board date, then
// read back through the product's own reads: the pipeline rollup, the
// companies and their duplicate, the team and who is away, the desks, the
// routines and the channels, and the money: MRR from the card mirror, the
// year's invoice numbers, the schedules billed by transfer, who issues what,
// and the money decisions waiting on Home.
//
//   bun run scripts/test-run.ts demo-seed --file src/seed/worlds/saas/stripe-world-reads.saas.integration.test.ts
import { afterAll, beforeAll, describe, expect, it, setSystemTime } from "bun:test"
import { mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { and, desc, eq, isNull, sql } from "drizzle-orm"
import { dealsRollup } from "~/apps/projects/service/deals"
import { withPrivilegedDb } from "~/db/privileged"
import type { UserContext } from "~/db/rls"
import { messages, routines } from "~/db/schema/kernel"
import { dispatchAppJobWithContext } from "~/infra/jobs/job-context"
import { JobsTestAccess } from "~/infra/jobs/jobs"
import { MORNING_BRIEF_TEMPLATE_KEY } from "~/modules/agent/routines/kernel-routine-templates"
import { aggregateAttentionItems } from "~/modules/apps/attention-aggregator"
import { executeTool } from "~/modules/apps/execute-tool"
import { DemoModeTestAccess } from "~/modules/demo/demo-mode"
import { seedContext } from "~/seed/context"
import { actorFor, asUser } from "~/seed/factories/people/actors"
import { type SeedDemoWorldResult, seedDemoWorld } from "~/seed/tiers/demo/seed-demo"
import {
  buildAttention,
  type InvoiceItem as HomeInvoiceItem,
  type SubItem as HomeSubItem,
} from "../../../../../../bundled-apps/stripe/src/ui/home-model"
import { installFromDist } from "../../../../test-support/seed/install-dist-apps"
import { saasMorningBrief } from "./brief"

/** The software world's catalog apps, installed the way a demo box has them. */
const CATALOG_WORLD_APPS = ["invoicing", "stripe"]

const BOARD_DATE = new Date("2026-11-09T08:30:00.000Z")
// A new org every run: the namespace database outlives a run, and a re-seed adopts what it finds.
const ORG_SLUG = `saas-world-reads-${Date.now().toString(36)}`
const OWNER = {
  email: `owner@${ORG_SLUG}.example`,
  name: "Visitor Owner",
  password: "SaasWorld1!Owner",
}

type Row = Record<string, unknown>
async function rows(orgId: string, query: ReturnType<typeof sql>): Promise<Row[]> {
  return withPrivilegedDb(orgId, "saas-world-test", async (tx) => {
    const r = await tx.execute(query)
    return (Array.isArray(r) ? r : ((r as { rows?: unknown[] }).rows ?? [])) as Row[]
  })
}

let world: SeedDemoWorldResult

/** The owner, as the product's reads see them. */
async function ownerActor(): Promise<UserContext> {
  return actorFor(
    seedContext({ orgId: world.orgId, now: BOARD_DATE }),
    world.org.ownerUserId as string,
  )
}

/** A kernel tool called by the owner at the board date: the reads that use today read the board's. */
async function ownerCall<T>(tool: string, params: Record<string, unknown>): Promise<T> {
  const actor = await ownerActor()
  setSystemTime(BOARD_DATE)
  try {
    const r = await executeTool<T>({
      toolName: `kernel:${tool}`,
      orgId: world.orgId,
      actor,
      params,
      origin: "human-ui",
    })
    return r.data as T
  } finally {
    setSystemTime()
  }
}

/** An app's tool called by the owner at the board date, through the sandbox. */
async function appCall<T>(toolName: string, params: Record<string, unknown>): Promise<T> {
  const actor = await ownerActor()
  setSystemTime(BOARD_DATE)
  try {
    const r = await executeTool<T>({
      toolName,
      orgId: world.orgId,
      actor,
      params,
      origin: "human-ui",
    })
    return r.data as T
  } finally {
    setSystemTime()
  }
}

async function companyId(name: string): Promise<string> {
  const [row] = await rows(
    world.orgId,
    sql`SELECT id FROM kernel.companies WHERE org_id = ${world.orgId} AND name = ${name}`,
  )
  if (!row) throw new Error(`no company ${name}`)
  return row.id as string
}
let appsRoot: string | null = null

beforeAll(async () => {
  DemoModeTestAccess.set(true)
  // Installed packages go to a temporary root unless the run names one.
  if (!process.env.LIAISON_APPS_DIR) {
    appsRoot = mkdtempSync(path.join(tmpdir(), "saas-world-reads-"))
    process.env.LIAISON_APPS_DIR = path.join(appsRoot, "apps")
  }
  for (const app of CATALOG_WORLD_APPS) await installFromDist(app, crypto.randomUUID())
  world = await seedDemoWorld({
    orgSlug: ORG_SLUG,
    worldId: "saas",
    variant: "visitor",
    owner: OWNER,
    baseTime: BOARD_DATE,
  })
}, 2_400_000)

afterAll(() => {
  DemoModeTestAccess.set(null)
  if (appsRoot) rmSync(appsRoot, { recursive: true, force: true })
})

describe("the software world, seeded and read back", () => {
  it("seeds every layer with no failure", () => {
    expect(world.failures).toEqual([])
  })

  it("14 active members, none external, and the account manager reads away with the visitor next in line", async () => {
    const members = await rows(
      world.orgId,
      sql`SELECT u.id, u.status, m.is_external FROM kernel.users u
          LEFT JOIN kernel.org_members m ON m.user_id = u.id AND m.org_id = u.org_id
          WHERE u.org_id = ${world.orgId}`,
    ).catch(async () =>
      rows(world.orgId, sql`SELECT id, status FROM kernel.users WHERE org_id = ${world.orgId}`),
    )
    const active = members.filter((m) => m.status === "active")
    expect(active).toHaveLength(14)
    expect(active.filter((m) => m.is_external === true)).toHaveLength(0)
    const elodie = world.org.peopleByKey.elodie?.userId
    const arlon = await rows(
      world.orgId,
      sql`SELECT owner_user_id FROM kernel.companies
          WHERE org_id = ${world.orgId} AND name = 'Maison Arlon'`,
    )
    expect(arlon[0]?.owner_user_id).toBe(elodie)
    const away = await rows(
      world.orgId,
      sql`SELECT next_in_line_id FROM kernel.away_ranges
          WHERE org_id = ${world.orgId} AND user_id = ${elodie}::uuid`,
    )
    expect(away.length).toBeGreaterThan(0)
    for (const range of away) expect(range.next_in_line_id).toBe(world.org.ownerUserId)
    // The product's own read says the same: Élodie, away, the visitor next in line.
    const read = await ownerCall<{
      accountManager: {
        id: string
        name: string
        away: { until: string; nextInLine: { id: string } | null } | null
      } | null
    }>("companies_read", { companyId: await companyId("Maison Arlon") })
    expect(read.accountManager?.name).toBe("Élodie Renard")
    expect(read.accountManager?.away?.nextInLine?.id).toBe(world.org.ownerUserId as string)
  })

  it("the timeline of the hotel group with the past due card returns its tickets, deal and last meeting from their apps and stores nothing", async () => {
    const audit = sql`SELECT count(*)::int AS n FROM kernel.audit_log WHERE org_id = ${world.orgId}`
    const [before] = await rows(world.orgId, audit)
    const timeline = await ownerCall<{
      items: Array<{ source: string; title: string }>
      unavailable: unknown[]
    }>("company_timeline", { companyId: await companyId("Maison Arlon"), limit: 100 })
    expect(timeline.unavailable).toEqual([])
    const titles = (source: string) =>
      timeline.items.filter((i) => i.source === source).map((i) => i.title)
    expect(titles("calendar")).toEqual(["Maison Arlon, rollout review"])
    const tickets = titles("tickets").join("\n")
    expect(tickets).toContain("Export of last month's rotas")
    expect(tickets).toContain("Shift swap notifications arrive late")
    expect(titles("projects").some((t) => t.includes("Maison Arlon, 4 more hotels"))).toBe(true)
    const [after] = await rows(world.orgId, audit)
    expect(after?.n).toBe(before?.n)
  })

  it("the visitor's support and knowledge queues hold the seeded six tickets and one article to review", async () => {
    const actor = await ownerActor()
    setSystemTime(BOARD_DATE)
    try {
      const feed = await aggregateAttentionItems({ orgId: world.orgId, actor })
      expect(feed.errors ?? []).toEqual([])
      const count = (app: string) => feed.items.filter((i) => i.app === app).length
      expect(count("tickets")).toBe(6)
      expect(count("knowledge")).toBe(1)
    } finally {
      setSystemTime()
    }
  })

  it("the four follow-up rows exist as real approvals in their guard states and held or stopped rows are not counted", async () => {
    const drafts = await rows(
      world.orgId,
      sql`SELECT id, handle, status, tool_name, current_payload->'sendGuard'->>'mode' AS mode
          FROM kernel.approval_requests
          WHERE org_id = ${world.orgId} AND handle LIKE 'demo-%-followup' ORDER BY handle`,
    )
    expect(drafts.map((d) => [d.handle, d.tool_name, d.mode, d.status])).toEqual([
      ["demo-kora-followup", "mail:compose", "followup", "pending"],
      ["demo-lumen-followup", "mail:compose", "followup", "pending"],
      ["demo-sauvan-followup", "mail:compose", "followup", "pending"],
      ["demo-tilleul-followup", "mail:compose", "followup", "cancelled"],
    ])
    const idOf = (handle: string) => drafts.find((d) => d.handle === handle)?.id as string
    const actor = await ownerActor()
    setSystemTime(BOARD_DATE)
    try {
      const feed = await aggregateAttentionItems({ orgId: world.orgId, actor })
      const item = (handle: string) => feed.items.find((i) => i.entityId === idOf(handle))
      const state = (handle: string) =>
        (item(handle)?.metadata?.sendGuard as { state?: string } | undefined)?.state ?? "clear"
      // Lumen waits on the owner and counts.
      expect(item("demo-lumen-followup")?.kind).toBe("approval_pending")
      expect(state("demo-lumen-followup")).toBe("clear")
      expect(item("demo-lumen-followup")?.metadata?.uncounted).not.toBe(true)
      // Marc answered after Sauvan's was staged: stopped, shown, not counted.
      expect(state("demo-sauvan-followup")).toBe("replied")
      // Samir's out-of-office holds Kora's until the morning after the day it names.
      expect(state("demo-kora-followup")).toBe("held")
      // Hugo's opt-out withdrew Tilleul's: it is not on Home at all.
      expect(item("demo-tilleul-followup")).toBeUndefined()
    } finally {
      setSystemTime()
    }
  })

  it("214 companies and the duplicate pair found by domain", async () => {
    const [count] = await rows(
      world.orgId,
      sql`SELECT count(*)::int AS n FROM kernel.companies WHERE org_id = ${world.orgId}`,
    )
    expect(count?.n).toBe(214)
    const kora = await rows(
      world.orgId,
      sql`SELECT domain FROM kernel.companies
          WHERE org_id = ${world.orgId} AND lower(name) LIKE 'kora%'`,
    )
    expect(kora).toHaveLength(2)
    expect(new Set(kora.map((k) => k.domain)).size).toBe(1)
  })

  it("the deals rollup reads Lead 12,300, Qualified 9,800, Demo 23,280, Proposal 23,280, open 9 at 68,660, one won and one lost this month", async () => {
    const ctx = seedContext({ orgId: world.orgId, now: BOARD_DATE })
    const owner = await actorFor(ctx, world.org.ownerUserId as string)
    const byStage = await asUser(owner, (tx) =>
      dealsRollup(tx as never, world.orgId, { groupBy: "stage" }),
    )
    const sumOf = (label: string) => {
      const g = byStage.groups.find((x) => x.label === label)
      return { count: g?.count ?? 0, eur: (g?.sumByCurrency[0]?.sum_minor ?? 0) / 100 }
    }
    expect(sumOf("Lead")).toEqual({ count: 3, eur: 12_300 })
    expect(sumOf("Qualified")).toEqual({ count: 2, eur: 9_800 })
    expect(sumOf("Demo")).toEqual({ count: 2, eur: 23_280 })
    expect(sumOf("Proposal")).toEqual({ count: 2, eur: 23_280 })
    const monthStart = new Date("2026-10-31T23:00:00.000Z").toISOString()
    const closed = await asUser(owner, (tx) =>
      dealsRollup(tx as never, world.orgId, { groupBy: "stage", closedAfter: monthStart }),
    )
    const closedOf = (label: string) => closed.groups.find((g) => g.label === label)?.count ?? 0
    expect(closedOf("Won")).toBe(1)
    expect(closedOf("Lost")).toBe(1)
    const keys = await rows(
      world.orgId,
      sql`SELECT p.key, t.number, t.title FROM app_projects.tasks t
          JOIN app_projects.projects p ON p.id = t.project_id
          WHERE t.org_id = ${world.orgId} AND p.key = 'SALES' AND t.number IN (14, 30, 31)
          ORDER BY t.number`,
    )
    expect(keys.map((k) => `${k.key}-${k.number}`)).toEqual(["SALES-14", "SALES-30", "SALES-31"])
    expect(keys[0]?.title).toBe("Maison Arlon, 4 more hotels")
  })

  it("routines made from a follow-up template stage their drafts and end, never waiting for a decision", async () => {
    const routines = await rows(
      world.orgId,
      sql`SELECT name, follow_up FROM kernel.routines WHERE org_id = ${world.orgId} ORDER BY name`,
    )
    const followUp = routines.filter((r) => r.follow_up === true).map((r) => r.name)
    expect(followUp).toEqual(["Deal follow-ups", "Failed payments"])
  })

  it("a developer holds a developer's role, which reads no invoice", async () => {
    const developer = world.org.peopleByKey.baptiste?.userId as string
    const held = await rows(
      world.orgId,
      sql`SELECT r.name, rs.scope FROM kernel.user_roles ur
          JOIN kernel.roles r ON r.id = ur.role_id
          LEFT JOIN kernel.role_scope_grants rs ON rs.role_id = r.id
          WHERE ur.user_id = ${developer} AND ur.org_id = ${world.orgId}`,
    )
    expect([...new Set(held.map((h) => h.name))]).toContain("engineering")
    expect(held.filter((h) => String(h.scope ?? "").startsWith("invoicing:"))).toEqual([])
  })

  it("the agents, routines and channels exist and the seeded routines do not tick from seeded events", async () => {
    for (const handle of ["@support", "@sales", "@finance"]) {
      expect(world.org.agentsByHandle[handle]).toBeDefined()
    }
    expect(world.org.agentsByHandle["@sales"]?.displayName).toBe("Sales Desk")
    const routines = await rows(
      world.orgId,
      sql`SELECT name, enabled FROM kernel.routines WHERE org_id = ${world.orgId} ORDER BY name`,
    )
    const on = routines.filter((r) => r.enabled === true).map((r) => r.name)
    expect(world.org.appsByName.stripe?.enabled).toBe(true)
    expect(on).toEqual(["Deal follow-ups", "Failed payments", "Morning brief"])
    const runs = await rows(
      world.orgId,
      sql`SELECT count(*)::int AS n FROM kernel.routine_runs WHERE org_id = ${world.orgId}`,
    ).catch(() => [{ n: 0 }])
    expect(runs[0]?.n).toBe(0)
    const channels = await rows(
      world.orgId,
      sql`SELECT title FROM kernel.threads
          WHERE org_id = ${world.orgId} AND title IN ('Pipeline', 'Product feedback', 'Support handover', 'Rota bugs')`,
    )
    expect(channels.map((c) => c.title).sort()).toEqual([
      "Pipeline",
      "Product feedback",
      "Rota bugs",
      "Support handover",
    ])
  })

  it("the visitor and the founder both read the Support handover channel", async () => {
    const [channel] = await rows(
      world.orgId,
      sql`SELECT id FROM kernel.threads WHERE org_id = ${world.orgId} AND title = 'Support handover'`,
    )
    const threadId = channel?.id as string
    const seats = await rows(
      world.orgId,
      sql`SELECT p.user_id FROM kernel.thread_participants p WHERE p.thread_id = ${threadId}::uuid`,
    )
    const seated = seats.map((s) => s.user_id)
    expect(seated).toContain(world.org.ownerUserId as string)
    expect(seated).toContain(world.org.peopleByKey.yann?.userId as string)
    const read = await ownerCall<{ thread: { title: string }; messages: unknown[] }>(
      "threads_read",
      { threadId },
    )
    expect(read.thread.title).toBe("Support handover")
    expect(read.messages.length).toBeGreaterThanOrEqual(2)
  })
})

interface MrrLine {
  currency: string
  monthStart: string
  mrrMinor: number
  pastDueMinor: number
  activeCount: number
  byPlan: Array<{ plan: string; mrrMinor: number; count: number }>
  movements: {
    newMinor: number
    upgradeMinor: number
    downgradeMinor: number
    cancelledMinor: number
    netMinor: number
    startMinor: number
  }
}
const mrr = async () =>
  await appCall<{ partial: boolean; lines: MrrLine[] }>("stripe:mrr_query", { breakdown: true })

interface DocRow {
  id: string
  number: string | null
  issued_at?: string
  issuedAt?: string
  counterparty_name?: string
}
/** Every invoice, oldest first, through the invoicing app's own search. */
async function allInvoices(): Promise<DocRow[]> {
  const out: DocRow[] = []
  for (let offset = 0; ; offset += 100) {
    const page = await appCall<{ results?: DocRow[] } | DocRow[]>("invoicing:documents_search", {
      type: "invoice",
      sort: "oldest",
      limit: 100,
      offset,
    })
    const rows = Array.isArray(page) ? page : (page.results ?? [])
    out.push(...rows)
    if (rows.length < 100) return out
  }
}

describe("the software world's money, read through the apps", () => {
  it("the MRR query at the board date returns 8,470,800 minor, past due 336,700, 169 active, split 62, 83, 24, and the four movements", async () => {
    const r = await mrr()
    expect(r.partial).toBe(false)
    expect(r.lines).toHaveLength(1)
    const line = r.lines[0] as MrrLine
    expect(line.currency).toBe("eur")
    expect([line.mrrMinor, line.pastDueMinor, line.activeCount]).toEqual([8_470_800, 336_700, 169])
    const count = (plan: string) => line.byPlan.find((p) => p.plan === plan)?.count
    expect([count("Starter"), count("Team"), count("Group")]).toEqual([62, 83, 24])
    const mv = line.movements
    expect([mv.newMinor, mv.upgradeMinor, mv.downgradeMinor, mv.cancelledMinor]).toEqual([
      294_000, 96_000, -34_100, -127_800,
    ])
    expect(mv.startMinor).toBe(8_242_700)
  })

  it("a workspace live across a month's end shows this month's movements empty and nothing rewritten", async () => {
    // The host's clock, not the sandbox's, names the month: two days into the next one.
    const nextMonth = new Date(BOARD_DATE.getTime() + 24 * 86_400_000)
    const before = await rows(
      world.orgId,
      sql`SELECT count(*)::int AS n FROM app_stripe.stripe_mrr_events WHERE org_id = ${world.orgId}`,
    )
    const actor = await ownerActor()
    setSystemTime(nextMonth)
    let line: MrrLine
    try {
      const r = await executeTool<{ lines: MrrLine[] }>({
        toolName: "stripe:mrr_query",
        orgId: world.orgId,
        actor,
        params: { breakdown: true },
        origin: "human-ui",
      })
      line = (r.data as { lines: MrrLine[] }).lines[0] as MrrLine
    } finally {
      setSystemTime()
    }
    expect(line.monthStart).toBe("2026-12-01")
    expect(line.mrrMinor).toBe(8_470_800)
    const mv = line.movements
    expect([
      mv.newMinor,
      mv.upgradeMinor,
      mv.downgradeMinor,
      mv.cancelledMinor,
      mv.netMinor,
    ]).toEqual([0, 0, 0, 0, 0])
    expect(mv.startMinor).toBe(8_470_800)
    const after = await rows(
      world.orgId,
      sql`SELECT count(*)::int AS n FROM app_stripe.stripe_mrr_events WHERE org_id = ${world.orgId}`,
    )
    expect(after).toEqual(before)
  })

  it("changing one seeded subscription's status moves the MRR query", async () => {
    const [row] = await rows(
      world.orgId,
      sql`SELECT id FROM app_stripe.stripe_subscriptions
          WHERE org_id = ${world.orgId} AND status = 'past_due' AND plan_name = 'Starter' LIMIT 1`,
    )
    const id = row?.id as string
    const set = (status: string, mrrMinor: number) =>
      rows(
        world.orgId,
        sql`UPDATE app_stripe.stripe_subscriptions SET status = ${status}, mrr_minor = ${mrrMinor}
            WHERE org_id = ${world.orgId} AND id = ${id}::uuid RETURNING id`,
      )
    await set("canceled", 0)
    try {
      const line = (await mrr()).lines[0] as MrrLine
      expect([line.mrrMinor, line.pastDueMinor, line.activeCount]).toEqual([
        8_470_800 - 14_900,
        336_700 - 14_900,
        168,
      ])
    } finally {
      await set("past_due", 14_900)
    }
    expect(((await mrr()).lines[0] as MrrLine).mrrMinor).toBe(8_470_800)
  })

  it("document numbers run from 0001 with no gap in date order per series and equal the board numbers", async () => {
    const docs = await allInvoices()
    const year = docs.filter((d) => d.number?.startsWith("F-2026-"))
    expect(year).toHaveLength(418)
    expect(year.map((d) => Number(d.number?.slice(-4)))).toEqual(
      Array.from({ length: 418 }, (_, i) => i + 1),
    )
    const named = await rows(
      world.orgId,
      sql`SELECT number, counterparty_name FROM app_invoicing.documents
          WHERE org_id = ${world.orgId} AND number IN ('F-2026-0007', 'F-2026-0284', 'F-2026-0298',
            'F-2026-0362', 'F-2026-0369', 'F-2026-0391', 'F-2026-0411', 'F-2026-0412', 'F-2026-0413',
            'F-2026-0414', 'F-2026-0415', 'F-2026-0416', 'F-2026-0418')
          ORDER BY number`,
    )
    expect(named.map((d) => d.counterparty_name)).toEqual([
      "Groupe Verrières",
      "Camping Les Pins",
      "Domaine Ferrand",
      "Maison Arlon",
      "Relais Saint-Cyr",
      "Café Ombre",
      "Hôtels Belcour",
      "Résidence Alizé",
      "Cantines du Port",
      "Bistrot Marceau",
      "Le Comptoir Sud",
      "Stadshotel Noord BV",
      "Maison Arlon",
    ])
  })

  it("the next number issued is one above the last seeded", async () => {
    const seq = await rows(
      world.orgId,
      sql`SELECT key, value FROM kernel.app_sequences
          WHERE org_id = ${world.orgId} AND app_id = 'invoicing' AND key LIKE '%:invoice:2026'`,
    )
    expect(seq).toHaveLength(1)
    expect(Number(seq[0]?.value)).toBe(418)
    const [max] = await rows(
      world.orgId,
      sql`SELECT max(number_int)::int AS n FROM app_invoicing.documents
          WHERE org_id = ${world.orgId} AND type = 'invoice' AND year_of_issue = 2026`,
    )
    expect(max?.n).toBe(418)
  })

  it("ten schedules, seven monthly due at this month's end, no run fired, the yearly transfer customer outside MRR", async () => {
    const list = await appCall<{ rows: Array<Record<string, unknown>> }>(
      "invoicing:recurring_list",
      { limit: 50 },
    )
    const schedules = list.rows
    expect(schedules).toHaveLength(10)
    const nextOf = (s: Record<string, unknown>) => String(s.next_issue_on ?? s.nextIssueOn ?? "")
    const monthEnd = schedules.filter(
      (s) => (s.repeats ?? s.every) === "month" && s.status === "active",
    )
    expect(monthEnd).toHaveLength(7)
    expect(new Set(monthEnd.map(nextOf))).toEqual(new Set(["2026-11-30"]))
    const [runs] = await rows(
      world.orgId,
      sql`SELECT count(*)::int AS n FROM app_invoicing.recurring_runs WHERE org_id = ${world.orgId}`,
    ).catch(() => [{ n: 0 }])
    expect(runs?.n).toBe(0)
    const verrieres = await rows(
      world.orgId,
      sql`SELECT count(*)::int AS n FROM app_stripe.stripe_customers
          WHERE org_id = ${world.orgId} AND name = 'Groupe Verrières'`,
    )
    expect(verrieres[0]?.n).toBe(0)
    const streams = await appCall<{
      issuers: Array<{ streams: Array<{ stream: string; issuer: string }> }>
    }>("invoicing:issuer_stream_get", {})
    const stream = (name: string) =>
      streams.issuers[0]?.streams.find((s) => s.stream === name)?.issuer
    expect([stream("card"), stream("transfer")]).toEqual(["liaison", "liaison"])
  })

  it("every total equals its lines at the rounding rule, the Dutch customer at reverse charge", async () => {
    const mismatched = await rows(
      world.orgId,
      sql`SELECT d.number FROM app_invoicing.documents d
          JOIN app_invoicing.document_lines l ON l.document_id = d.id AND l.org_id = d.org_id
          WHERE d.org_id = ${world.orgId}
          GROUP BY d.id, d.number, d.subtotal_minor, d.tax_total_minor, d.grand_total_minor
          HAVING sum(l.subtotal_minor) <> d.subtotal_minor OR sum(l.tax_minor) <> d.tax_total_minor
             OR d.subtotal_minor + d.tax_total_minor <> d.grand_total_minor
             OR sum(round(l.subtotal_minor * l.tax_rate_bp / 10000.0)) <> d.tax_total_minor`,
    )
    expect(mismatched).toEqual([])
    const [noord] = await rows(
      world.orgId,
      sql`SELECT id FROM app_invoicing.documents
          WHERE org_id = ${world.orgId} AND number = 'F-2026-0416'`,
    )
    const doc = await appCall<Record<string, unknown>>("invoicing:documents_get", {
      id: noord?.id as string,
    })
    const d = (doc.document ?? doc) as Record<string, unknown>
    expect(d.tax_treatment).toBe("eu_reverse_charge")
    expect([
      Number(d.subtotal_minor),
      Number(d.tax_total_minor),
      Number(d.grand_total_minor),
    ]).toEqual([49_000, 0, 49_000])
    const [arlon] = await rows(
      world.orgId,
      sql`SELECT grand_total_minor, tax_total_minor, payment_status FROM app_invoicing.documents
          WHERE org_id = ${world.orgId} AND number = 'F-2026-0418'`,
    )
    expect([
      Number(arlon?.grand_total_minor),
      Number(arlon?.tax_total_minor),
      arlon?.payment_status,
    ]).toEqual([174_000, 29_000, "unpaid"])
  })

  it("the last webhook line shows its true age without an alarm", async () => {
    const home = await appCall<{
      connection?: { state?: string; overlay?: string | null; lastEventAt?: string | null }
    }>("stripe:home_load", {})
    expect(home.connection?.state).toBe("connected")
    expect(home.connection?.overlay ?? null).toBeNull()
    expect(Date.parse(home.connection?.lastEventAt ?? "")).toBe(BOARD_DATE.getTime() - 2 * 60_000)
  })

  it("the hotel group's timeline shows its invoices from the invoicing app", async () => {
    const timeline = await ownerCall<{ items: Array<{ source: string; title: string }> }>(
      "company_timeline",
      { companyId: await companyId("Maison Arlon"), limit: 100 },
    )
    const invoices = timeline.items
      .filter((i) => i.source === "invoicing")
      .map((i) => i.title)
      .join("\n")
    expect(invoices).toContain("F-2026-0418")
    expect(invoices).toContain("F-2026-0362")
  })

  it("Home holds the card reminder for the away account manager and the refund, with the follow-up and the quiet deal", async () => {
    const actor = await ownerActor()
    setSystemTime(BOARD_DATE)
    try {
      const feed = await aggregateAttentionItems({ orgId: world.orgId, actor })
      const approvals = await rows(
        world.orgId,
        sql`SELECT id, handle, tool_name FROM kernel.approval_requests
            WHERE org_id = ${world.orgId} AND handle IN ('demo-arlon-card-reminder', 'demo-ombre-refund')
            ORDER BY handle`,
      )
      expect(approvals.map((a) => [a.handle, a.tool_name])).toEqual([
        ["demo-arlon-card-reminder", "mail:compose"],
        ["demo-ombre-refund", "stripe:refunds_create"],
      ])
      const item = (handle: string) =>
        feed.items.find((i) => i.entityId === approvals.find((a) => a.handle === handle)?.id)
      expect(item("demo-arlon-card-reminder")?.kind).toBe("approval_pending")
      expect(item("demo-arlon-card-reminder")?.metadata?.placement).toBe("standing_in")
      expect(item("demo-ombre-refund")?.kind).toBe("approval_pending")
    } finally {
      setSystemTime()
    }
  })
})

interface SubItem {
  id: string
  customerId: string
  status: string
  plan: string | null
  mrrMinor: number
  trialEnd: string | null
}
/** Every subscription in one status, through the payments app's search, page by page. */
async function subscriptionsIn(status: string): Promise<SubItem[]> {
  const out: SubItem[] = []
  let cursor: string | null = null
  do {
    const page: { items: SubItem[]; nextCursor: string | null } = await appCall(
      "stripe:subscriptions_search",
      { status, limit: 50, ...(cursor ? { cursor } : {}) },
    )
    out.push(...page.items)
    cursor = page.nextCursor
  } while (cursor)
  return out
}

describe("the software world's figures, read through the payments app", () => {
  it("seven past due subscriptions, one Group, three Team, three Starter, 3,367 a month of which 1,917 beside Maison Arlon's", async () => {
    const pastDue = await subscriptionsIn("past_due")
    const count = (plan: string) => pastDue.filter((s) => s.plan === plan).length
    expect([pastDue.length, count("Group"), count("Team"), count("Starter")]).toEqual([7, 1, 3, 3])
    const total = pastDue.reduce((n, s) => n + s.mrrMinor, 0)
    expect(total).toBe(336_700)
    const arlon = pastDue.find((s) => s.id === "sub_1Q8XarlonGroup")
    expect(arlon?.mrrMinor).toBe(145_000)
    expect(total - (arlon?.mrrMinor ?? 0)).toBe(191_700)
    // Counted in MRR: without them, 81,341 a month.
    const line = (await mrr()).lines[0] as MrrLine
    expect(line.mrrMinor - total).toBe(8_134_100)
  })

  it("the payments home's failed payments are the card reminder Home holds: the expired card, with the other six in retries", async () => {
    const page = async <T>(tool: string, args: Record<string, unknown>): Promise<T[]> =>
      (await appCall<{ items: T[] }>(tool, { ...args, limit: 50 })).items
    // The very reads the payments home makes, then its own attention rule.
    const attention = buildAttention({
      pastDue: await page<HomeSubItem>("stripe:subscriptions_search", { status: "past_due" }),
      openInvoices: await page<HomeInvoiceItem>("stripe:invoices_search", { status: "open" }),
      disputes: [],
      approvals: [],
      now: BOARD_DATE,
    })
    expect(attention.failed.map((f) => f.subscriptionId)).toEqual(["sub_1Q8XarlonGroup"])
    expect(attention.retrying.count).toBe(6)
    // Home's failed-payment reminder is for the same customer, and it is the only one.
    const reminders = await rows(
      world.orgId,
      sql`SELECT handle FROM kernel.approval_requests
          WHERE org_id = ${world.orgId} AND handle LIKE '%card-reminder'`,
    )
    expect(reminders.map((r) => r.handle)).toEqual(["demo-arlon-card-reminder"])
  })

  it("four trials, each ending within seven days of the board date, in no MRR figure", async () => {
    const trials = await subscriptionsIn("trialing")
    expect(trials).toHaveLength(4)
    for (const t of trials) {
      const days = (Date.parse(t.trialEnd ?? "") - BOARD_DATE.getTime()) / 86_400_000
      expect(days).toBeGreaterThan(0)
      expect(days).toBeLessThanOrEqual(7)
    }
    const customers = await appCall<{ items: Array<{ id: string }> }>("stripe:customers_search", {
      filter: "trial",
      limit: 50,
    })
    expect(customers.items.map((c) => c.id).sort()).toEqual(
      [...new Set(trials.map((t) => t.customerId))].sort(),
    )
    const line = (await mrr()).lines[0] as MrrLine
    expect(line.activeCount).toBe(169)
  })
})

/** The apps each door line about the company's operations speaks for. */
const DOOR_OPS_APPS: Record<string, readonly string[]> = {
  payments: ["stripe"],
  invoicing: ["invoicing"],
  support: ["tickets"],
  sales: ["projects"],
  product: ["projects"],
  knowledge: ["knowledge"],
}

describe("the door's lines, held to the seeded world", () => {
  it("every operations line the door shows names an app that is on in the world", () => {
    const kernel = JSON.parse(
      readFileSync(
        path.join(
          import.meta.dir,
          "../../../../../../packages/shared/src/i18n/locales/en/kernel.json",
        ),
        "utf8",
      ),
    ) as { demo: { world: { saas: { companyOps: Record<string, unknown> } } } }
    const lines = Object.keys(kernel.demo.world.saas.companyOps).sort()
    expect(lines).toEqual(Object.keys(DOOR_OPS_APPS).sort())
    const off = lines.flatMap((line) =>
      (DOOR_OPS_APPS[line] ?? []).filter((app) => !world.org.appsByName[app]?.enabled),
    )
    expect(off).toEqual([])
  })
})

describe("the visitor's Home at the board date", () => {
  it("Home's groups read Needs you with the card reminder, the follow-up and the refund, then Support 6, Tasks 2 and Knowledge 1", async () => {
    const actor = await ownerActor()
    setSystemTime(BOARD_DATE)
    try {
      const feed = await aggregateAttentionItems({ orgId: world.orgId, actor })
      expect(feed.errors ?? []).toEqual([])
      const byApp = (app: string) => feed.items.filter((i) => i.app === app)
      expect(byApp("tickets")).toHaveLength(6)
      expect(byApp("knowledge")).toHaveLength(1)
      // The Arlon expansion's two subtasks are the owner's, due within the week.
      expect(
        byApp("projects")
          .map((i) => i.summary)
          .sort(),
      ).toEqual([
        "Draft the rollout plan for the 4 hotels",
        "Send the pricing sheet for the 4 hotels",
      ])
      // Needs you: the decisions waiting on the owner and counted. Sauvan's
      // (replied) and Kora's (held) are shown but not counted.
      const counted = feed.items
        .filter(
          (i) =>
            i.kind === "approval_pending" &&
            i.metadata?.uncounted !== true &&
            (i.metadata?.sendGuard as { state?: string } | undefined)?.state !== "held",
        )
        .map((i) => i.metadata?.requestHandle)
      expect(counted.sort()).toEqual([
        "demo-arlon-card-reminder",
        "demo-lumen-followup",
        "demo-ombre-refund",
      ])
    } finally {
      setSystemTime()
    }
  })

  it("the brief card shows the seeded Morning brief, the owner's own, with the board's text", async () => {
    const actor = await ownerActor()
    const brief = await asUser(actor, async (tx) => {
      const [routine] = await tx
        .select({ name: routines.name, outputThreadId: routines.outputThreadId })
        .from(routines)
        .where(
          and(
            eq(routines.orgId, world.orgId),
            eq(routines.ownerUserId, actor.userId),
            eq(routines.templateKey, MORNING_BRIEF_TEMPLATE_KEY),
          ),
        )
      if (!routine?.outputThreadId) return null
      const [latest] = await tx
        .select({ content: messages.content })
        .from(messages)
        .where(
          and(
            eq(messages.threadId, routine.outputThreadId),
            eq(messages.authorType, "agent"),
            isNull(messages.deletedAt),
          ),
        )
        .orderBy(desc(messages.createdAt))
        .limit(1)
      return { name: routine.name, text: latest?.content ?? null }
    })
    expect(brief).toEqual({ name: "Morning brief", text: saasMorningBrief(BOARD_DATE) })
    expect(brief?.text).toContain(
      "Hôtels Sauvan answered, so the follow-up drafted for Marc will not go out.",
    )
  })
})

// Last in this file: it runs the month-end draft job, which writes runs the reads above assert absent.
describe("the transfer schedules' runs", () => {
  it("every active schedule's next run row is ready, the yearly group schedule on its due date included", async () => {
    const list = await appCall<{ rows: Array<Record<string, unknown>> }>(
      "invoicing:recurring_list",
      { limit: 50 },
    )
    const active = list.rows.filter((s) => s.status === "active")
    expect(active.length).toBe(9)
    const draftDays = [...new Set(active.map((s) => String(s.next_draft_on)))].sort()
    const handler = JobsTestAccess.getHandler("invoicing", "recurring-draft")
    if (!handler) throw new Error("recurring-draft is not registered")
    for (const day of draftDays) {
      // Mid-morning in Paris on the schedule's draft day.
      setSystemTime(new Date(Date.parse(day) + 9 * 3_600_000))
      try {
        await dispatchAppJobWithContext(
          handler,
          { orgId: world.orgId },
          { actorType: "system", orgId: world.orgId, purpose: "job", scopes: ["invoicing:*"] },
          "session",
        )
      } finally {
        setSystemTime()
      }
    }
    const items = await rows(
      world.orgId,
      sql`SELECT i.schedule_id::text AS schedule_id, i.state, i.note, r.issue_on::text AS issue_on
          FROM app_invoicing.recurring_run_items i
          JOIN app_invoicing.recurring_runs r ON r.id = i.run_id
          WHERE i.org_id = ${world.orgId}
          ORDER BY r.issue_on`,
    )
    const firstOf = new Map<string, Row>()
    for (const i of items)
      if (!firstOf.has(String(i.schedule_id))) firstOf.set(String(i.schedule_id), i)
    const notReady = active
      .map((s) => ({ name: s.company_name ?? s.id, item: firstOf.get(String(s.id)) }))
      .filter(({ item }) => item?.state !== "ready")
      .map(
        ({ name, item }) => `${String(name)}: ${String(item?.state)} ${String(item?.note ?? "")}`,
      )
    expect(notReady).toEqual([])
    const verrieres = active.find((s) => String(s.next_issue_on).endsWith("-01-05"))
    if (!verrieres) throw new Error("no yearly schedule due on 5 January")
    const row = firstOf.get(String(verrieres.id))
    expect([row?.state, String(row?.issue_on).slice(0, 10)]).toEqual([
      "ready",
      String(verrieres.next_issue_on),
    ])
  })
})
