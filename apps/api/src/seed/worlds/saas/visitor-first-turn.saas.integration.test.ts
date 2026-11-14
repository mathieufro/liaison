// SPDX-License-Identifier: FSL-1.1-ALv2
//
// A VISITOR'S FIRST TURN on the software world, freshly seeded as a visitor org
// at the board date: a question about a prospect who has no card-payments customer.
// The turn runs through the REAL agent loop (context, tool list, tool search,
// tool execution) against a local OpenRouter stub that answers with a scripted
// model, so no model is ever called. Each read the script makes must answer:
// a read that finds nothing says so, and none comes back as a failed call,
// which the trace would show as an app that "did not answer".
//
//   bun run scripts/test-run.ts demo-seed --file src/seed/worlds/saas/visitor-first-turn.saas.integration.test.ts
import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { sql } from "drizzle-orm"
import { withPrivilegedDb } from "~/db/privileged"
import { env } from "~/lib/env"
import { invokeAgentForThread } from "~/modules/agent/runtime/agent-service"
import { updatePayload } from "~/modules/approvals/edit"
import {
  attentionRefreshesSettled,
  wireAttentionRefreshWakes,
} from "~/modules/apps/attention-store"
import { ActivityTestAccess, type LinkedRecordsAsked } from "~/modules/contacts/activity"
import { registerDemoAlertMailer } from "~/modules/demo/demo-alerts"
import { DemoBudgetTestAccess } from "~/modules/demo/demo-budget"
import { DemoModeTestAccess } from "~/modules/demo/demo-mode"
import { PAYMENTS_APP } from "~/modules/demo/worlds/saas/payments/sentinel"
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
const ORG_SLUG = `saas-first-turn-${Date.now().toString(36)}`
const OWNER = {
  email: `owner@${ORG_SLUG}.example`,
  name: "Visitor Owner",
  password: "SaasWorld1!Owner",
}
const QUESTION =
  "The prospect from the brasserie says they are leaving. What does that mean for the business, and what should I do?"

/** The reads a model makes on a first question about a prospect, as the walk saw them. */
const READS = [
  "stripe__customers_search",
  "kernel__companies_search",
  "kernel__companies_read",
  "stripe__customers_get",
  "projects__deals_search",
  "kernel__approvals_list",
  "stripe__mrr_query",
] as const

/** One tool call the scripted model makes, by a matcher over the tools the turn can call. */
interface ScriptCall {
  tool: RegExp
  args: () => Record<string, unknown>
  /** Called through kernel__call_tool even once the tool is offered, as a model may. */
  viaEntry?: boolean
}

/** Seeded ids the script reads with (set once the world is seeded). */
const ids = { company: "", contact: "" }

const SEARCH = (query: string): ScriptCall => ({
  tool: /^kernel__tool_search$/,
  args: () => ({ query }),
})

/** The processor's name as the payments app writes it in its answers. */
const PAYMENTS_LABEL = PAYMENTS_APP.charAt(0).toUpperCase() + PAYMENTS_APP.slice(1)

/** The visitor's per-turn step budget (spec: 8 steps and 6 searches). */
const VISITOR_STEPS = 8

const SEARCHES: ScriptCall[] = [
  SEARCH("find a card-payments customer by name"),
  SEARCH("customer subscription and card"),
  SEARCH("company account manager"),
  SEARCH("deals of a company"),
  SEARCH("approvals waiting on me"),
  SEARCH("monthly recurring revenue"),
]
const READ_CALLS: Record<(typeof READS)[number], ScriptCall> = {
  stripe__customers_search: {
    tool: /^stripe__customers_search$/,
    args: () => ({ query: "Lumen" }),
  },
  kernel__companies_search: {
    tool: /^kernel__companies_search$/,
    args: () => ({ query: "Lumen" }),
  },
  kernel__companies_read: {
    tool: /^kernel__companies_read$/,
    args: () => ({ companyId: ids.company }),
  },
  stripe__customers_get: {
    tool: /^stripe__customers_get$/,
    args: () => ({ companyId: ids.company }),
  },
  projects__deals_search: {
    tool: /^projects__deals_search$/,
    args: () => ({ companyId: ids.company }),
  },
  kernel__approvals_list: { tool: /^kernel__approvals_list$/, args: () => ({}) },
  stripe__mrr_query: { tool: /^stripe__mrr_query$/, args: () => ({}) },
}
const ANSWER_TEXT = "Here is what it means for the business."

/**
 * The visitor's next question, as the walk asked it: the follow-up a sales
 * agent staged for the prospect waits on the visitor, and should it go?
 */
const FOLLOW_UP_QUESTION =
  "Sales Desk drafted a follow-up to Noor at Lumen pushing the proposal again. Should it go out as written, and can you change it?"
const NEXT_READS = [
  "kernel__approvals_list",
  "kernel__companies_read",
  "projects__deals_search",
  "kernel__contacts_search",
  "kernel__contacts_read",
  "kernel__company_timeline",
  "kernel__threads_search",
  "kernel__list_routines",
  "kernel__users_search",
  "kernel__memory_search",
] as const
/**
 * The change the walk's agent tried: rewriting another agent's staged mail,
 * named by the handle the approval card prints rather than its id.
 */
const NEXT_WRITES = ["kernel__approval_update_payload"] as const
const NEXT_SEARCHES: ScriptCall[] = [
  SEARCH("approvals waiting on me"),
  SEARCH("edit a pending approval"),
  SEARCH("deals of a company"),
  SEARCH("contact person details and timeline"),
  SEARCH("which agent or routine drafted this"),
  SEARCH("search conversations and memory"),
]
const NEXT_CALLS: Record<(typeof NEXT_READS)[number] | (typeof NEXT_WRITES)[number], ScriptCall> = {
  kernel__approvals_list: READ_CALLS.kernel__approvals_list,
  kernel__companies_read: READ_CALLS.kernel__companies_read,
  projects__deals_search: READ_CALLS.projects__deals_search,
  kernel__contacts_search: { tool: /^kernel__contacts_search$/, args: () => ({ query: "Noor" }) },
  kernel__contacts_read: {
    tool: /^kernel__contacts_read$/,
    args: () => ({ contactId: ids.contact, includeTimeline: true }),
  },
  kernel__company_timeline: {
    tool: /^kernel__company_timeline$/,
    args: () => ({ companyId: ids.company }),
  },
  kernel__threads_search: { tool: /^kernel__threads_search$/, args: () => ({ query: "Lumen" }) },
  kernel__list_routines: { tool: /^kernel__list_routines$/, args: () => ({}) },
  kernel__users_search: { tool: /^kernel__users_search$/, args: () => ({ query: "Sales Desk" }) },
  kernel__memory_search: { tool: /^kernel__memory_search$/, args: () => ({ query: "Lumen" }) },
  kernel__approval_update_payload: {
    tool: /^kernel__approval_update_payload$/,
    viaEntry: true,
    args: () => ({
      requestId: "demo-lumen-followup",
      fields: { textBody: "Hello Noor, before I close the proposal: what made you decide?" },
    }),
  },
}

type Turn = {
  searches: ScriptCall[]
  /** Called until each has run. */
  reads: readonly string[]
  /** Called until each has run, whatever it answers. */
  writes: readonly string[]
  calls: Record<string, ScriptCall>
}
/** What the scripted model does this turn: its searches, then the reads it calls. */
let script: Turn = {
  searches: SEARCHES,
  reads: READS,
  writes: [],
  calls: READ_CALLS,
}

/** A call's result said the tool was only loaded, not run (the tool-calling entry's note). */
const notRun = (result: string) => result.includes('"ran":false')

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

/** Every linked-records read of the run, in order (the shipped deadline, never a test one). */
const linkedReads: LinkedRecordsAsked[] = []

/** What the stub saw: the tools each step offered, the calls it made and their results. */
const offeredPerStep: string[][] = []
const called: Array<{ id: string; name: string; via: "direct" | "entry" }> = []
const skipped: string[] = []
const results = new Map<string, string>()
let cursor = 0
/** Where this turn's calls start in `called`. */
let turnStart = 0

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
  const thisTurn = called.slice(turnStart)
  const ran = new Set(
    thisTurn
      .filter((c) => results.has(c.id) && !notRun(results.get(c.id) ?? ""))
      .map((c) => c.name),
  )
  const pending = [...script.reads, ...script.writes].filter((r) => !ran.has(r))
  const step: ScriptCall[] | null =
    cursor === 1
      ? script.searches
      : pending.length > 0 && cursor < VISITOR_STEPS
        ? pending.map((r) => script.calls[r] as ScriptCall)
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
    const direct =
      offered.includes(target) && !(c.viaEntry && offered.includes("kernel__call_tool"))
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
  return withPrivilegedDb(orgId, "saas-first-turn-test", async (tx) => {
    const r = await tx.execute(query)
    return (Array.isArray(r) ? r : ((r as { rows?: unknown[] }).rows ?? [])) as Row[]
  })
}

beforeAll(async () => {
  DemoModeTestAccess.set(true)
  // As a server's boot wires it: an app's run wakes its stored attention refresh,
  // which runs beside the turn's own reads.
  wireAttentionRefreshWakes()
  ActivityTestAccess.observeLinkedRecords((asked) => linkedReads.push(asked))
  if (!process.env.LIAISON_APPS_DIR) {
    appsRoot = mkdtempSync(path.join(tmpdir(), "saas-first-turn-"))
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
  process.env.OPENROUTER_API_KEY = "sk-or-first-turn-stub-key"
  process.env.OPENROUTER_BASE_URL = `http://127.0.0.1:${stub.port}/api/v1`
  for (const k of BUDGET_KEYS) {
    savedBudgets[k] = env[k]
    env[k] = 10_000
  }
  env.LIAISON_DEMO_ALERT_EMAIL = "owner@example.com"
  env.LIAISON_DEMO_MAIL_CAPTURE = true
  registerDemoAlertMailer(async () => {})
  DemoBudgetTestAccess.setVerifiedIdentity(async () => ({
    emailNormalized: `first-turn-${Date.now()}@example.com`,
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
  await attentionRefreshesSettled()
  ActivityTestAccess.observeLinkedRecords(null)
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

/** One stored call of the agent's reply, as the trace reads it. */
interface StoredCall {
  toolName?: string
  name?: string
  args?: Record<string, unknown>
  readOnly?: boolean
  appLabel?: string
  status?: string
  result?: unknown
}

/** The trace's own test of a failed call (web ToolCard.tsx `toolCallFailed`). */
const callFailed = (c: StoredCall) =>
  c.status === "error" ||
  (c.result !== null &&
    typeof c.result === "object" &&
    (c.result as { error?: unknown }).error != null)

/** The tool a stored call ran: the one `kernel__call_tool` named, else its own. */
const ranTool = (c: StoredCall) => {
  const own = c.toolName ?? c.name ?? ""
  return own === "kernel__call_tool" && typeof c.args?.name === "string" ? c.args.name : own
}

/** The calls stored on the agent's replies to one posted message. */
async function storedCallsAfter(orgId: string, threadId: string, messageId: string) {
  const stored = await rows(
    orgId,
    sql`SELECT metadata->'toolCalls' AS calls FROM kernel.messages
        WHERE org_id = ${orgId} AND thread_id = ${threadId}::uuid AND author_type <> 'user'
          AND created_at >= (SELECT created_at FROM kernel.messages WHERE id = ${messageId}::uuid)`,
  )
  return stored.flatMap((r) => (Array.isArray(r.calls) ? r.calls : [])).map((c) => c as StoredCall)
}

/** The visitor's conversation with the personal agent, kept across turns. */
const convo = { threadId: "", ownerId: "" }

describe("a visitor's first turn, with a scripted model", () => {
  it("every read of a first question about a prospect answers, none fails, the one with no card-payments customer included", async () => {
    expect(world.failures).toEqual([])
    const orgId = world.orgId
    const ownerId = world.org.ownerUserId as string
    const [company] = await rows(
      orgId,
      sql`SELECT id::text AS id FROM kernel.companies WHERE org_id = ${orgId} AND name = 'Brasserie Lumen'`,
    )
    ids.company = String(company?.id ?? "")
    expect(ids.company).not.toBe("")

    const actor = await actorFor(seedContext({ orgId, now: BOARD_DATE }), ownerId)
    const dm = await withPrivilegedDb(orgId, "saas-first-turn-dm", async (tx) => {
      const agentId = await resolvePersonalAgentId(tx as never, { orgId, userId: ownerId })
      if (!agentId) throw new Error("the owner has no personal agent")
      return createOrGetAgentDm(tx as never, { orgId, userId: ownerId, agentId })
    })
    if (!dm) throw new Error("no conversation with the personal agent")
    convo.threadId = dm.id
    convo.ownerId = ownerId
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
    if (!posted) throw new Error("the visitor's question was not posted")
    const outcome = await invokeAgentForThread(dm.id, posted.id, actor, orgId)

    console.log(
      `CALLED ${called.map((c) => `${c.name}(${c.via})`).join(", ")}\nSKIPPED ${skipped.join(", ")}`,
    )
    for (const c of called)
      console.log(`RESULT ${c.name}: ${(results.get(c.id) ?? "").slice(0, 400)}`)
    expect(skipped).toEqual([])
    expect(outcome.finishReason).toBe("stop")

    // The trace's own verdict on each stored call: none failed.
    const stored = await rows(
      orgId,
      sql`SELECT metadata->'toolCalls' AS calls FROM kernel.messages
          WHERE org_id = ${orgId} AND thread_id = ${dm.id}::uuid AND author_type <> 'user'`,
    )
    const calls = stored
      .flatMap((r) => (Array.isArray(r.calls) ? r.calls : []))
      .map((c) => c as { name?: string; status?: string; result?: unknown })
    const failed = calls
      .filter(
        (c) =>
          c.status === "error" ||
          (c.result !== null &&
            typeof c.result === "object" &&
            (c.result as { error?: unknown }).error != null),
      )
      .map((c) => `${c.name}: ${JSON.stringify(c.result).slice(0, 300)}`)
    expect(failed).toEqual([])
    // Every read ran.
    const ran = new Set(
      called
        .filter((c) => results.has(c.id) && !notRun(results.get(c.id) ?? ""))
        .map((c) => c.name),
    )
    expect([...READS].filter((r) => !ran.has(r))).toEqual([])
    expect(cursor).toBeLessThanOrEqual(VISITOR_STEPS)

    // The prospect has no card-payments customer, and the read says so in words.
    // The app's own sentence names the processor (PAYMENTS_LABEL).
    const get = called.find(
      (c) => c.name === "stripe__customers_get" && !notRun(results.get(c.id) ?? ""),
    )
    expect(results.get(get?.id ?? "") ?? "").toContain(`No ${PAYMENTS_LABEL} customer is linked`)
  }, 600_000)
  it("the next question, about a sales agent's staged follow-up, reads without a failed read, and a refused change is its own row, not a read that did not answer", async () => {
    const orgId = world.orgId
    expect(convo.threadId).not.toBe("")
    const [contact] = await rows(
      orgId,
      sql`SELECT id::text AS id FROM kernel.contacts WHERE org_id = ${orgId} AND name LIKE 'Noor%'`,
    )
    ids.contact = String(contact?.id ?? "")
    expect(ids.contact).not.toBe("")

    script = { searches: NEXT_SEARCHES, reads: NEXT_READS, writes: NEXT_WRITES, calls: NEXT_CALLS }
    cursor = 0
    turnStart = called.length
    skipped.length = 0

    const actor = await actorFor(seedContext({ orgId, now: BOARD_DATE }), convo.ownerId)
    const posted = await asUser(actor, (tx) =>
      sendMessage(
        tx as never,
        {
          orgId,
          userId: convo.ownerId,
          threadId: convo.threadId,
          content: FOLLOW_UP_QUESTION,
          authorType: "user",
          requiredScopes: [],
        } as never,
      ),
    )
    if (!posted) throw new Error("the visitor's next question was not posted")
    const outcome = await invokeAgentForThread(convo.threadId, posted.id, actor, orgId)

    const turn = called.slice(turnStart)
    console.log(
      `CALLED ${turn.map((c) => `${c.name}(${c.via})`).join(", ")}\nSKIPPED ${skipped.join(", ")}`,
    )
    for (const c of turn)
      console.log(`RESULT ${c.name}: ${(results.get(c.id) ?? "").slice(0, 600)}`)
    expect(skipped).toEqual([])
    expect(outcome.finishReason).toBe("stop")

    const calls = await storedCallsAfter(orgId, convo.threadId, posted.id)
    // The trace rolls reads up and names each read that failed as an app that
    // "did not answer": no read of this turn may be one.
    const failedReads = calls
      .filter((c) => c.readOnly === true && callFailed(c))
      .map((c) => `${ranTool(c)}: ${JSON.stringify(c.result).slice(0, 300)}`)
    expect(failedReads).toEqual([])
    // Every read ran.
    const ran = new Set(
      turn.filter((c) => results.has(c.id) && !notRun(results.get(c.id) ?? "")).map((c) => c.name),
    )
    expect([...NEXT_READS].filter((r) => !ran.has(r))).toEqual([])
    // The first, cold read of the prospect's contact hears from every app that
    // holds records for her: none is named as one that did not answer in time.
    const contactRead = turn.find(
      (c) => c.name === "kernel__contacts_read" && !notRun(results.get(c.id) ?? ""),
    )
    const contactResult = results.get(contactRead?.id ?? "") ?? ""
    expect(contactResult).toContain("linkedRecords")
    expect(contactResult).not.toContain("not read (")
    expect(contactResult).not.toContain("were not read")
    // That first read asked each of the five apps holding records for a contact,
    // and every one answered within the shipped deadline.
    const firstContactRead = linkedReads.find((r) => "contactId" in r.target)
    expect(firstContactRead?.sources.map((x) => x.app).sort()).toEqual([
      "calendar",
      "invoicing",
      "projects",
      "stripe",
      "tickets",
    ])
    expect(firstContactRead?.sources.filter((x) => !x.answered)).toEqual([])
    // The change was refused by the tool-calling entry (an approval named by its
    // handle, not its id). The refusal stays on the trace, in its own row with
    // its reason: it is not a read, so it never reads as an app that did not answer.
    const change = calls.find((c) => ranTool(c) === "kernel__approval_update_payload")
    expect(change?.toolName).toBe("kernel__call_tool")
    expect(callFailed(change as StoredCall)).toBe(true)
    expect(JSON.stringify(change?.result)).toContain("Invalid arguments")
    expect(change?.readOnly).toBe(false)
  }, 600_000)
  it("the owner, who decides the sales agent's staged follow-up, can change it, though not a member of the channel it waits in", async () => {
    const orgId = world.orgId
    const [approval] = await rows(
      orgId,
      sql`SELECT ar.id::text AS id,
                 EXISTS (SELECT 1 FROM kernel.thread_participants tp
                         WHERE tp.thread_id = ar.thread_id AND tp.user_id = ${convo.ownerId}::uuid) AS owner_in_thread
          FROM kernel.approval_requests ar
          WHERE ar.org_id = ${orgId} AND ar.handle = 'demo-lumen-followup'`,
    )
    expect(approval?.id).toBeTruthy()
    // The world as the walk saw it: the draft waits in a channel the owner never joined.
    expect(approval?.owner_in_thread).toBe(false)
    const actor = await actorFor(seedContext({ orgId, now: BOARD_DATE }), convo.ownerId)
    const textBody = "Hello Noor, before I close the proposal: what made you decide?"
    const edited = await updatePayload({
      orgId,
      requestId: String(approval?.id),
      fields: { textBody },
      actor,
    })
    expect(edited.currentPayload.textBody).toBe(textBody)
    expect(edited.lastEdit?.editorUserId).toBe(convo.ownerId)
  }, 120_000)
})
