// SPDX-License-Identifier: FSL-1.1-ALv2
//
// THE OWNER'S QUESTION ABOUT THE HOTEL GROUP, on the software world seeded as a
// visitor org at the board date: "Where do we stand with Maison Arlon?". The
// turn runs through the REAL agent loop (context, tool list, tool search, tool
// execution, cards) against a local OpenRouter stub that answers with a
// scripted model, so no model is ever called. The script searches for tools in
// plain words, the way a model does, and calls a read only once the turn holds
// it: a read the turn cannot reach is skipped and the test names it.
//
//   bun run scripts/test-run.ts demo-seed --file src/seed/worlds/saas/owner-question-reach.saas.integration.test.ts
import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { sql } from "drizzle-orm"
import { withPrivilegedDb } from "~/db/privileged"
import { env } from "~/lib/env"
import { invokeAgentForThread } from "~/modules/agent/runtime/agent-service"
import { registerDemoAlertMailer } from "~/modules/demo/demo-alerts"
import { DemoBudgetTestAccess } from "~/modules/demo/demo-budget"
import { DemoModeTestAccess } from "~/modules/demo/demo-mode"
import { sendMessage } from "~/modules/threads/message"
import { createOrGetAgentDm, resolvePersonalAgentId } from "~/modules/threads/thread"
import { seedContext } from "~/seed/context"
import { actorFor, asUser } from "~/seed/factories/people/actors"
import { type SeedDemoWorldResult, seedDemoWorld } from "~/seed/tiers/demo/seed-demo"
import { clearRedisPatterns } from "~/tests/route-test-setup"
import { installFromDist } from "../../../../test-support/seed/install-dist-apps"

/** The software world's catalog apps, installed the way a demo box has them. */
const CATALOG_WORLD_APPS = ["invoicing", "stripe"]
const BOARD_DATE = new Date("2026-11-09T08:30:00.000Z")
// A new org every run: the namespace database outlives a run, and a re-seed adopts what it finds.
const ORG_SLUG = `saas-owner-question-${Date.now().toString(36)}`
const OWNER = {
  email: `owner@${ORG_SLUG}.example`,
  name: "Visitor Owner",
  password: "SaasWorld1!Owner",
}
const QUESTION = "Where do we stand with Maison Arlon?"

/** The five reads the question needs. */
const READS = [
  "kernel__companies_read",
  "stripe__customers_get",
  "invoicing__documents_search",
  "tickets__listForContact",
  "projects__deals_search",
] as const

/** One tool call the scripted model makes, by a matcher over the tools the turn can call. */
interface ScriptCall {
  tool: RegExp
  args: () => Record<string, unknown>
}

/** Seeded ids the script reads with (set once the world is seeded). */
const ids = { company: "", contact: "" }

const SEARCH = (query: string): ScriptCall => ({
  tool: /^kernel__tool_search$/,
  args: () => ({ query }),
})

/** The visitor's per-turn step budget (spec: 8 steps and 6 searches). */
const VISITOR_STEPS = 8

// The first step asks for each read in plain words, one need per search.
const SEARCHES: ScriptCall[] = [
  SEARCH("company account manager"),
  SEARCH("customer subscription and card"),
  SEARCH("invoices and quotes"),
  SEARCH("support tickets of a contact"),
  SEARCH("deals of a company"),
]
// Then the reads, all at once. A read the search listed but did not load is
// loaded by its first call, which does not run it (its result says so), and
// is called again on the next step, as the result tells the model to.
const READ_CALLS: Record<(typeof READS)[number], ScriptCall> = {
  kernel__companies_read: {
    tool: /^kernel__companies_read$/,
    args: () => ({ companyId: ids.company }),
  },
  stripe__customers_get: {
    tool: /^stripe__customers_get$/,
    args: () => ({ companyId: ids.company }),
  },
  invoicing__documents_search: {
    tool: /^invoicing__documents_search$/,
    args: () => ({ company_id: ids.company }),
  },
  tickets__listForContact: {
    tool: /^tickets__listForContact$/,
    args: () => ({ contactId: ids.contact }),
  },
  projects__deals_search: {
    tool: /^projects__deals_search$/,
    args: () => ({ companyId: ids.company }),
  },
}
const ANSWER_TEXT = "Here is where we stand with Maison Arlon."

/** What the scripted model does this turn: its searches, then the reads it calls. */
const script: { searches: ScriptCall[]; reads: readonly (typeof READS)[number][] } = {
  searches: SEARCHES,
  reads: READS,
}

/** Clear what the stub saw, for a new turn. */
function resetStub(): void {
  offeredPerStep.length = 0
  called.length = 0
  skipped.length = 0
  results.clear()
  cursor = 0
}

/** A call's result said the tool was only loaded, not run. */
const notRun = (result: string) => result.includes("did not run")

let world: SeedDemoWorldResult
let stub: ReturnType<typeof Bun.serve>
let appsRoot: string | null = null
const saved: Record<string, string | undefined> = {}
// The visitor budget is not under test here: room for the turn, restored after.
const BUDGET_KEYS = [
  "LIAISON_DEMO_BUDGET_PER_EMAIL_EUR",
  "LIAISON_DEMO_BUDGET_PER_NETWORK_EUR",
  "LIAISON_DEMO_BOX_DAILY_EUR",
  "LIAISON_DEMO_BOX_HOURLY_EUR",
] as const
const savedBudgets: Partial<Record<(typeof BUDGET_KEYS)[number], number>> = {}
const savedAlert = env.LIAISON_DEMO_ALERT_EMAIL
const savedCapture = env.LIAISON_DEMO_MAIL_CAPTURE

/** What the stub saw: the tools each step offered, the calls it made and their results. */
const offeredPerStep: string[][] = []
const called: Array<{ id: string; name: string; via: "direct" | "entry" }> = []
const skipped: string[] = []
const results = new Map<string, string>()
let cursor = 0

function sse(chunks: unknown[]): Response {
  const body = `${chunks.map((c) => `data: ${JSON.stringify(c)}\n\n`).join("")}data: [DONE]\n\n`
  return new Response(body, { headers: { "Content-Type": "text/event-stream" } })
}

function answer(body: {
  messages: Array<{ role?: string; tool_call_id?: string; content?: unknown }>
  tools?: Array<{ function?: { name?: string } }>
}): Response {
  const offered = (body.tools ?? []).map((t) => t.function?.name ?? "")
  offeredPerStep.push(offered)
  for (const m of body.messages) {
    if (m.role === "tool" && m.tool_call_id) {
      results.set(
        m.tool_call_id,
        typeof m.content === "string" ? m.content : JSON.stringify(m.content),
      )
    }
  }
  // Tools loaded outside the fixed list are described in the conversation and
  // called through kernel__call_tool, as a model does.
  const viaEntry = offered.includes("kernel__call_tool")
    ? [
        ...new Set(
          [
            ...JSON.stringify(body.messages).matchAll(
              /\\"name\\":\\"([a-z0-9-]+__[A-Za-z0-9_]+)\\"/g,
            ),
          ].map((m) => m[1] as string),
        ),
      ].filter((n) => !offered.includes(n))
    : []
  const callable = [...offered, ...viaEntry]
  cursor += 1
  const ran = new Set(
    called.filter((c) => results.has(c.id) && !notRun(results.get(c.id) ?? "")).map((c) => c.name),
  )
  const pending = script.reads.filter((r) => !ran.has(r))
  const step: ScriptCall[] | null =
    cursor === 1
      ? script.searches
      : pending.length > 0 && cursor < VISITOR_STEPS
        ? pending.map((r) => READ_CALLS[r])
        : null
  const base = { id: "stub", object: "chat.completion.chunk", created: 0, model: "stub" }
  const usage = { prompt_tokens: 1000, completion_tokens: 60, total_tokens: 1060 }
  // A call whose tool the turn cannot call is skipped, and named.
  const calls = step
    ? step.filter((c) => {
        const ok = callable.some((n) => c.tool.test(n))
        if (!ok) skipped.push(String(c.tool))
        return ok
      })
    : []
  if (calls.length === 0) {
    const text = ANSWER_TEXT
    return sse([
      { ...base, choices: [{ index: 0, delta: { role: "assistant", content: text } }] },
      { ...base, choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage },
    ])
  }
  const toolCalls = calls.map((c, index) => {
    const target = callable.find((n) => c.tool.test(n)) ?? ""
    const direct = offered.includes(target)
    const args = c.args()
    const id = `call_${cursor}_${index}`
    called.push({ id, name: target, via: direct ? "direct" : "entry" })
    const input = direct ? args : { name: target, arguments: args }
    return {
      index,
      id,
      type: "function",
      function: {
        name: direct ? target : "kernel__call_tool",
        arguments: JSON.stringify(input),
      },
    }
  })
  return sse([
    {
      ...base,
      choices: [{ index: 0, delta: { role: "assistant", tool_calls: toolCalls } }],
    },
    { ...base, choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }], usage },
  ])
}

type Row = Record<string, unknown>
async function rows(orgId: string, query: ReturnType<typeof sql>): Promise<Row[]> {
  return withPrivilegedDb(orgId, "saas-owner-question-test", async (tx) => {
    const r = await tx.execute(query)
    return (Array.isArray(r) ? r : ((r as { rows?: unknown[] }).rows ?? [])) as Row[]
  })
}

beforeAll(async () => {
  DemoModeTestAccess.set(true)
  if (!process.env.LIAISON_APPS_DIR) {
    appsRoot = mkdtempSync(path.join(tmpdir(), "saas-owner-question-"))
    process.env.LIAISON_APPS_DIR = path.join(appsRoot, "apps")
  }
  for (const app of CATALOG_WORLD_APPS) await installFromDist(app, crypto.randomUUID())
  stub = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(req) {
      // The host ranking reads a model's endpoints; none means the default routing.
      if (req.method === "GET") return Response.json({ data: { endpoints: [] } })
      return answer((await req.json()) as Parameters<typeof answer>[0])
    },
  })
  for (const k of ["OPENROUTER_API_KEY", "OPENROUTER_BASE_URL"]) saved[k] = process.env[k]
  process.env.OPENROUTER_API_KEY = "sk-or-owner-question-stub-key"
  process.env.OPENROUTER_BASE_URL = `http://127.0.0.1:${stub.port}/api/v1`
  for (const k of BUDGET_KEYS) {
    savedBudgets[k] = env[k]
    env[k] = 10_000
  }
  env.LIAISON_DEMO_ALERT_EMAIL = "owner@example.com"
  env.LIAISON_DEMO_MAIL_CAPTURE = true
  registerDemoAlertMailer(async () => {})
  DemoBudgetTestAccess.setVerifiedIdentity(async () => ({
    emailNormalized: `owner-question-${Date.now()}@example.com`,
    network: "192.0.2.0/24",
  }))
  world = await seedDemoWorld({
    orgSlug: ORG_SLUG,
    worldId: "saas",
    variant: "visitor",
    owner: OWNER,
    baseTime: BOARD_DATE,
  })
}, 2_400_000)

afterAll(async () => {
  await clearRedisPatterns(["demo:*"])
  stub?.stop(true)
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k]
    else process.env[k] = v
  }
  for (const k of BUDGET_KEYS) env[k] = savedBudgets[k] as number
  env.LIAISON_DEMO_ALERT_EMAIL = savedAlert
  env.LIAISON_DEMO_MAIL_CAPTURE = savedCapture
  registerDemoAlertMailer(null)
  DemoBudgetTestAccess.setVerifiedIdentity(null)
  DemoModeTestAccess.set(null)
  if (appsRoot) rmSync(appsRoot, { recursive: true, force: true })
})

describe("the owner's question about the hotel group, with a scripted model", () => {
  it("the hotel group question reaches the company, customer, documents, tickets and deals reads with a scripted model", async () => {
    expect(world.failures).toEqual([])
    const orgId = world.orgId
    const ownerId = world.org.ownerUserId as string
    const [company] = await rows(
      orgId,
      sql`SELECT id::text AS id FROM kernel.companies WHERE org_id = ${orgId} AND name = 'Maison Arlon'`,
    )
    ids.company = String(company?.id ?? "")
    // The contact of the group with the most tickets.
    const [contact] = await rows(
      orgId,
      sql`SELECT t.contact_id::text AS id FROM app_tickets.tickets t
          JOIN kernel.contacts c ON c.id = t.contact_id
          WHERE t.org_id = ${orgId} AND c.company_id = ${ids.company}::uuid
          GROUP BY t.contact_id ORDER BY count(*) DESC LIMIT 1`,
    )
    ids.contact = String(contact?.id ?? "")
    expect(ids.company).not.toBe("")
    expect(ids.contact).not.toBe("")

    const actor = await actorFor(seedContext({ orgId, now: BOARD_DATE }), ownerId)
    const dm = await withPrivilegedDb(orgId, "saas-owner-question-dm", async (tx) => {
      const agentId = await resolvePersonalAgentId(tx as never, { orgId, userId: ownerId })
      if (!agentId) throw new Error("the owner has no personal agent")
      return createOrGetAgentDm(tx as never, { orgId, userId: ownerId, agentId })
    })
    if (!dm) throw new Error("no conversation with the personal agent")
    const posted = await asUser(actor, (tx) =>
      sendMessage(
        tx as never,
        {
          orgId,
          userId: ownerId,
          threadId: dm.id,
          content: QUESTION,
          authorType: "user",
          requiredScopes: [],
        } as never,
      ),
    )
    if (!posted) throw new Error("the owner's question was not posted")
    const messageId = posted.id
    const outcome = await invokeAgentForThread(dm.id, messageId, actor, orgId)

    console.log(
      `CALLED ${called.map((c) => `${c.name}(${c.via})`).join(", ")}\nSKIPPED ${skipped.join(", ")}`,
    )
    for (const c of called.filter((x) => x.name === "kernel__tool_search")) {
      console.log(
        `SEARCH ${c.id} -> ${[...(results.get(c.id) ?? "").matchAll(/[a-z0-9-]+__[A-Za-z0-9_]+/g)].map((m) => m[0]).join(" ")}`,
      )
    }
    // Every read was reachable in the turn and ran, within the visitor's steps, and none failed.
    expect(skipped).toEqual([])
    const ranReads = called.filter((c) => READS.includes(c.name as (typeof READS)[number]))
    const completed = new Set<string>()
    for (const c of ranReads) {
      const result = results.get(c.id) ?? ""
      expect(result).not.toBe("")
      expect({ tool: c.name, result: result.slice(0, 300) }).not.toMatchObject({
        result: expect.stringMatching(/"(error|isError)"\s*:\s*(true|"|\{)/),
      })
      if (!notRun(result)) completed.add(c.name)
    }
    expect([...completed].sort()).toEqual([...READS].sort())
    expect(cursor).toBeLessThanOrEqual(VISITOR_STEPS)
    expect(outcome.finishReason).toBe("stop")

    // The company read resolved one company card, for the hotel group.
    const stored = await rows(
      orgId,
      sql`SELECT metadata->'toolCalls' AS calls FROM kernel.messages
          WHERE org_id = ${orgId} AND thread_id = ${dm.id}::uuid AND author_type <> 'user'`,
    )
    const cards = stored
      .flatMap((r) => (Array.isArray(r.calls) ? r.calls : []))
      .map(
        (c) => (c as { card?: { kind?: string; title?: string; pill?: { label?: string } } }).card,
      )
      .filter((c) => c?.kind === "entity" && c.pill?.label === "Company")
    expect(cards.map((c) => c?.title)).toEqual(["Maison Arlon"])
  }, 600_000)
})

describe("the company read alone, with a scripted model", () => {
  it("one company read carries the plan, the unpaid invoice, the open ticket and the deal, on one company card", async () => {
    expect(world.failures).toEqual([])
    const orgId = world.orgId
    const ownerId = world.org.ownerUserId as string
    const [company] = await rows(
      orgId,
      sql`SELECT id::text AS id FROM kernel.companies WHERE org_id = ${orgId} AND name = 'Maison Arlon'`,
    )
    ids.company = String(company?.id ?? "")
    expect(ids.company).not.toBe("")
    resetStub()
    script.searches = [SEARCH("company account manager")]
    script.reads = ["kernel__companies_read"]

    const actor = await actorFor(seedContext({ orgId, now: BOARD_DATE }), ownerId)
    const thread = await withPrivilegedDb(orgId, "saas-owner-question-dm", async (tx) => {
      const agentId = await resolvePersonalAgentId(tx as never, { orgId, userId: ownerId })
      if (!agentId) throw new Error("the owner has no personal agent")
      return createOrGetAgentDm(tx as never, { orgId, userId: ownerId, agentId })
    })
    if (!thread) throw new Error("no conversation with the personal agent")
    const posted = await asUser(actor, (tx) =>
      sendMessage(
        tx as never,
        {
          orgId,
          userId: ownerId,
          threadId: thread.id,
          content: QUESTION,
          authorType: "user",
          requiredScopes: [],
        } as never,
      ),
    )
    if (!posted) throw new Error("the owner's question was not posted")
    const outcome = await invokeAgentForThread(thread.id, posted.id, actor, orgId)
    expect(outcome.finishReason).toBe("stop")
    expect(skipped).toEqual([])

    const read = called.find(
      (c) => c.name === "kernel__companies_read" && !notRun(results.get(c.id) ?? ""),
    )
    if (!read) throw new Error("the company read never ran")
    const result = results.get(read.id) ?? ""
    // The one read names what each other app holds for the group: the plan and
    // the failed card payment, its invoices, its open ticket, its deal.
    const listed = /"linkedRecords":(\[[^\]]*\])/.exec(result)?.[1]
    const lines = listed ? (JSON.parse(listed) as string[]) : []
    console.log(`LINKED ${lines.join(" | ")}`)
    const line = (label: string) => lines.find((l) => l.startsWith(`${label}:`)) ?? ""
    expect(line("Stripe")).toMatch(/started/)
    expect(line("Stripe")).toMatch(/Payment failed|Retry failed/)
    expect(line("Invoices")).not.toBe("")
    expect(line("Tickets")).not.toBe("")
    expect(line("Deals and projects")).toContain("4 more hotels")

    // And its card is the company card, with a row per app that holds records.
    const stored = await rows(
      orgId,
      sql`SELECT metadata->'toolCalls' AS calls FROM kernel.messages
          WHERE org_id = ${orgId} AND thread_id = ${thread.id}::uuid AND author_type <> 'user'
            AND created_at >= (SELECT created_at FROM kernel.messages WHERE id = ${posted.id}::uuid)`,
    )
    const cards = stored
      .flatMap((r) => (Array.isArray(r.calls) ? r.calls : []))
      .map(
        (c) =>
          (
            c as {
              card?: {
                kind?: string
                title?: string
                pill?: { label?: string }
                rows?: Array<{ label?: { label?: string }; value?: unknown }>
                open?: unknown
              }
            }
          ).card,
      )
      .filter((c) => c?.kind === "entity" && c.pill?.label === "Company")
    expect(cards.map((c) => c?.title)).toEqual(["Maison Arlon"])
    const labels = (cards[0]?.rows ?? []).map((r) => r.label?.label)
    for (const label of ["Stripe", "Invoices", "Tickets", "Deals and projects"]) {
      expect(labels).toContain(label)
    }
    expect(cards[0]?.open).toBeDefined()
  }, 600_000)
})
