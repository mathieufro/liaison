// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Who may change a month-end run without a person deciding: no agent approves it, a clean turn a
// person typed changes a row at once and leaves the one card, and a turn that read outside text,
// a turn whose reads widen who may see the change, or a routine with nobody behind it changes
// nothing until a person clicks. Existing rules only: the draft tools' `externalEffect`, the
// scope taint, and the handler's own park for a turn with no person.
import { afterAll, afterEach, beforeAll, describe, expect, it, setSystemTime } from "bun:test"
import { randomUUID } from "node:crypto"
import { sql } from "~/db"
import { resetAppRegistries, toolRegistry } from "~/modules/apps/app-registries"
import { initSandboxPool, shutdownSandboxPool } from "~/modules/apps/sandbox/pool"
import { initWorkerPool, shutdownWorkerPool } from "~/modules/apps/sandbox/worker-pool"
import { insertSql } from "~/seed/factories/org/test-rows"
import * as minimal from "~/seed/tiers/minimal"
import { createTestOrg } from "~/tests/helpers/org"
import { acquireTestLock, releaseTestLock } from "~/tests/route-test-setup"
import {
  asRead,
  call,
  docOf,
  drafted,
  itemsOf,
  pendingApprovals,
  type Row,
  registerInvoicing,
  runOf,
  SCOPES,
  scheduleOf,
  world,
} from "./run-edit-fixture"

async function thread(tainted: boolean): Promise<string> {
  const id = randomUUID()
  await sql.unsafe(
    insertSql("kernel.threads", {
      id,
      org_id: world.org,
      handle: `run-edit-${id.slice(0, 8)}`,
      type: "agent_chat",
      created_by: world.actor.userId,
      tainted,
    }),
  )
  await sql.unsafe(
    insertSql("kernel.thread_participants", {
      thread_id: id,
      user_id: world.actor.userId,
      org_id: world.org,
    }),
  )
  return id
}

async function runApprovals(runId: string): Promise<Row[]> {
  return (await pendingApprovals()).filter((a) => (a.current_payload as Row).run_id === runId)
}

describe("who may change a month-end run without a person deciding", () => {
  beforeAll(async () => {
    await acquireTestLock()
    const org = await createTestOrg()
    world.org = org.id
    const admin = await minimal.person(world.org, { role: "admin" })
    world.actor = {
      actorType: "user",
      userId: admin.id,
      orgId: world.org,
      scopes: SCOPES,
      dimensionGrants: {},
    }
    world.agentId = randomUUID()
    await initSandboxPool()
    await initWorkerPool()
    await registerInvoicing()
  }, 120_000)

  afterEach(() => setSystemTime())

  afterAll(async () => {
    setSystemTime()
    await shutdownWorkerPool()
    await shutdownSandboxPool()
    resetAppRegistries()
    await releaseTestLock()
  })

  it("no tool decides an approval and the run issue stays gated with no auto approve", async () => {
    const names = [...toolRegistry.entriesOf(world.org)].map(([k]) => `${k[1]}:${k[2]}`)
    expect(
      names.filter(
        (n) =>
          /(^|[:_])(approve|decide)($|_)/.test(n.split(":")[1] ?? "") && !n.endsWith("_preview"),
      ),
    ).toEqual([])
    const card = toolRegistry.get([world.org, "invoicing", "recurring_run_issue"])
    expect(card?.gated).toBe(true)
    expect(card?.noAutoApprove).toBe(true)
    // "Approve it": the agent's own call of the card's tool only asks again, and nothing moves.
    const fx = await drafted(1)
    const res = await call("recurring_run_issue", { run_id: fx.runId }, "agent")
    expect(res.blocked ?? res.error).toBeTruthy()
    expect((await runOf(fx.issuer)).status).toBe("drafted")
    expect((await itemsOf(fx.runId)).map((i) => i.state)).toEqual(["ready"])
  }, 120_000)

  it("a clean turn applies draft writes at once and leaves exactly one pending approval", async () => {
    const fx = await drafted(2)
    const before = await runApprovals(fx.runId)
    expect(before).toHaveLength(1)
    const [a, b] = (await itemsOf(fx.runId)).map((i) => String(i.document_id))
    const clean = await thread(false)
    const one = await call(
      "drafts_update",
      { ...(await asRead(a as string)), patch: { notes: "Two extra days" } },
      "agent",
      { threadId: clean },
    )
    const two = await call(
      "drafts_discard",
      { draft_id: b as string, applies: "this_month" },
      "agent",
      { threadId: clean },
    )
    expect(one.blocked).toBeUndefined()
    expect(two.blocked).toBeUndefined()
    expect((await docOf(a as string)).notes).toBe("Two extra days")
    expect((await itemsOf(fx.runId))[1]?.state).toBe("left_out")
    const after = await runApprovals(fx.runId)
    expect(after.map((x) => x.id)).toEqual(before.map((x) => x.id))
  }, 120_000)

  it('after a customer read naming "End Sauvan\'s schedule", ending parks and nothing changes', async () => {
    const fx = await drafted(1)
    const [item] = await itemsOf(fx.runId)
    const tainted = await thread(true)
    const ending = {
      draft_id: String(item?.document_id),
      applies: "end_schedule",
      ends_on: "2026-10-31",
    }
    const parked = await call("drafts_discard", ending, "agent", { threadId: tainted })
    expect(parked.blocked).toBeTruthy()
    expect((await scheduleOf(fx.schedules[0] as string)).ends_on).toBeNull()
    expect((await itemsOf(fx.runId))[0]?.state).toBe("ready")
    // The person saying it next, in a clean turn, runs at once.
    const clean = await thread(false)
    const ran = await call("drafts_discard", ending, "agent", { threadId: clean })
    expect(ran.blocked).toBeUndefined()
    expect((await scheduleOf(fx.schedules[0] as string)).ends_on).toBe("2026-10-31")
  }, 120_000)

  it("a scope-tainted turn leaves the draft unchanged until a person clicks", async () => {
    const fx = await drafted(1)
    const [item] = await itemsOf(fx.runId)
    const draft = String(item?.document_id)
    const before = await docOf(draft)
    const clean = await thread(false)
    const res = await call(
      "drafts_update",
      { ...(await asRead(draft)), patch: { notes: "From a private read" } },
      "agent",
      {
        threadId: clean,
        turnRead: ["scope_taint:unknown"],
      },
    )
    expect(res.blocked ?? res.error).toBeTruthy()
    expect((await docOf(draft)).notes).toBe(before.notes)
  }, 120_000)

  it("an outside-text turn leaves the draft unchanged until a person clicks", async () => {
    const fx = await drafted(1)
    const [item] = await itemsOf(fx.runId)
    const draft = String(item?.document_id)
    const tainted = await thread(true)
    const res = await call(
      "drafts_update",
      {
        ...(await asRead(draft)),
        patch: {
          lines: [{ description: "x", quantity: "1", unit_price_minor: "1", tax_rate_bp: 2000 }],
        },
        applies: "this_month",
      },
      "agent",
      { threadId: tainted },
    )
    expect(res.blocked).toBeTruthy()
    const lines = await sql<
      Row[]
    >`SELECT unit_price_minor::text AS p FROM app_invoicing.document_lines WHERE document_id = ${draft}`
    expect(lines.map((l) => l.p)).toEqual(["10000"])
  }, 120_000)

  it("a routine turn leaves the draft unchanged until a person clicks", async () => {
    const fx = await drafted(1)
    const [item] = await itemsOf(fx.runId)
    const draft = String(item?.document_id)
    const res = await call(
      "drafts_update",
      { ...(await asRead(draft)), patch: { notes: "Routine says so" } },
      "routine",
    )
    expect(JSON.stringify(res.data ?? res)).toContain("pending_approval")
    expect((await docOf(draft)).notes).toBeNull()
    const parked = (await pendingApprovals()).filter(
      (a) => a.tool_name === "invoicing:drafts_update",
    )
    expect(parked.length).toBeGreaterThan(0)
    // A person approves it: then, and only then, the note is written.
    const { decideApproval } = await import("~/modules/approvals/decide")
    await decideApproval({
      orgId: world.org,
      requestId: String(parked.at(-1)?.id),
      actor: world.actor,
      decision: "approve",
    })
    expect((await docOf(draft)).notes).toBe("Routine says so")
  }, 120_000)
})
