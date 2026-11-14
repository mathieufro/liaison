// SPDX-License-Identifier: FSL-1.1-ALv2
// A project's money never reaches someone without the money scope through a later write.
//
// `budget_get` reads under `projects:projects:read`, which every member holds, and adds the
// price, what is invoiced and what is left only for a holder of `projects:money:read`. A result
// that carries that money stamps the money scope on the turn's taint (`resultTaintWhen`), so a
// post into a conversation with a member who lacks it does not land: in a person's DM it waits
// for that person's own disclosure decision, from a routine it never runs. A result without money
// stamps nothing. `cost_rate_set` names a person's hourly cost: it runs only on a person's own
// turn in their DM, and its turn is tainted by the margin scope only finance holds.
import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import { sql } from "~/db"
import { withSystemDb } from "~/db/privileged"
import type { UserContext } from "~/db/rls"
import { withRlsContext } from "~/db/rls"
import { type RunContext, runContextStore } from "~/modules/agent/runtime/run-context"
import { createTurnScopeAccumulator } from "~/modules/agent/scopes/turn-scope-accumulator"
import { registerKernelAgentTools } from "~/modules/agent/tools/kernel-tools"
import { executeToolCore } from "~/modules/apps/execute-tool"
import { ensureAppsForOrg } from "~/modules/apps/init"
import { forgetOrgApps, primeOrgApps } from "~/modules/apps/org-apps"
import { createRpcBridge } from "~/modules/apps/sandbox/rpc-bridge"
import { loadEffectivePermissions } from "~/modules/permissions/permissions"
import * as minimal from "~/seed/tiers/minimal"
import { createTestOrg } from "~/tests/helpers/org"
import { acquireTestLock, releaseTestLock } from "~/tests/route-test-setup"
import { projectsAppManifest } from "../manifest-descriptor"
import { awaitTimeFeatureSync } from "./time-feature"

const MONEY = "projects:money:read"
const MARGIN = "projects:margin:read"

let orgId = ""
let adminId = ""
let leadId = ""
let financeId = ""
let memberId = ""
let projectId = ""

async function held(userId: string): Promise<UserContext> {
  const perms = await withSystemDb("money-taint-perms", (tx) =>
    loadEffectivePermissions(tx as never, userId, orgId),
  )
  return {
    actorType: "user",
    userId,
    orgId,
    scopes: perms.scopes,
    dimensionGrants: perms.dimensionGrants ?? {},
    roles: perms.roles,
  }
}

async function bridgeCall(method: string, input: unknown): Promise<Record<string, any>> {
  const actor: UserContext = {
    actorType: "user",
    userId: adminId,
    orgId,
    scopes: ["*"],
    dimensionGrants: { "*": ["*"] },
  }
  return runContextStore.run({} as never, () =>
    withRlsContext(actor, async (tx) => {
      const bridge = createRpcBridge(
        "projects",
        adminId,
        orgId,
        tx,
        { name: "projects" },
        actor.scopes,
        "user",
        undefined,
        { origin: "human-ui" } as never,
      )
      return JSON.parse(await bridge[method](JSON.stringify(input)))
    }),
  )
}

type Outcome = Record<string, any>
type Call = (toolName: string, params: Record<string, unknown>) => Promise<Outcome>

/** One agent turn of `userId` in `threadId`: every call shares the turn's taint. */
async function turn<T>(
  userId: string,
  threadId: string,
  frame: Partial<RunContext>,
  steps: (call: Call, taint: () => string[]) => Promise<T>,
): Promise<T> {
  const actor = await held(userId)
  const accumulator = createTurnScopeAccumulator({ orgId })
  const runId = crypto.randomUUID()
  const call: Call = (toolName, params) =>
    executeToolCore({
      toolName,
      orgId,
      actor,
      params,
      threadId,
      origin: "in-app-agent",
    } as never) as Promise<Outcome>
  const ctx: RunContext = {
    runId,
    parentRunId: null,
    rootRunId: runId,
    nestingDepth: 0,
    effectiveScope: actor.scopes,
    turnScopeAccumulator: accumulator,
    ...frame,
  } as RunContext
  return runContextStore.run(ctx, () => steps(call, () => accumulator.snapshot()))
}

async function postedIn(threadId: string, marker: string): Promise<number> {
  const [row] = await sql<{ n: number }[]>`
    SELECT count(*)::int AS n FROM kernel.messages
     WHERE thread_id = ${threadId}::uuid AND content LIKE ${`%${marker}%`}`
  return row?.n ?? 0
}

const ROUTINE = { routineId: "00000000-0000-4000-8000-0000000c0001" }

beforeAll(async () => {
  await acquireTestLock()
  orgId = (await createTestOrg()).id
  adminId = (await minimal.adminSession(orgId)).userId
  leadId = (await minimal.session(orgId, { role: "member" })).userId
  financeId = (await minimal.session(orgId, { role: "member" })).userId
  memberId = (await minimal.session(orgId, { role: "member" })).userId
  await ensureAppsForOrg(orgId)
  await primeOrgApps(orgId, 0)
  await registerKernelAgentTools(orgId)
  for (const id of [leadId, financeId, memberId]) {
    await minimal.grantScope(id, "projects:projects:read")
  }
  await minimal.grantScope(leadId, MONEY)
  await minimal.grantScope(financeId, "projects:cost_rates:write")
  await minimal.grantScope(financeId, MARGIN)
  const made = await bridgeCall("projects_createProject", { name: "Retainer account" })
  projectId = made.id
  await bridgeCall("projects_updateProject", { projectId, timeBudgets: true })
  await awaitTimeFeatureSync(orgId)
  const terms = await bridgeCall("projects_billingTermsSet", {
    projectId,
    fixedPrice: 64000,
    currency: "EUR",
  })
  expect(terms.error).toBeUndefined()
}, 180_000)

afterAll(async () => {
  forgetOrgApps(orgId)
  await releaseTestLock()
})

describe("a budget read that carries money taints the turn with the money scope", () => {
  it("a DM budget read with money, then a post into a thread with a member lacking the money scope, does not land", async () => {
    const dm = await minimal.agentDm(orgId, leadId)
    const room = await minimal.thread(orgId, leadId, {
      title: "Delivery",
      participantIds: [memberId],
    })
    const out = await turn(leadId, dm, { humanTurn: true }, async (call, taint) => {
      const read = await call("projects:budget_get", { projectId })
      expect(JSON.stringify(read)).toContain("64000")
      expect(taint()).toContain(MONEY)
      return call("kernel:threads_reply", { threadId: room, content: "Price is 64000 (dm-case)" })
    })
    expect("data" in out).toBe(false)
    expect(await postedIn(room, "dm-case")).toBe(0)
  })

  it("a routine doing the same never posts", async () => {
    const dm = await minimal.agentDm(orgId, leadId)
    const room = await minimal.thread(orgId, leadId, {
      title: "Weekly delivery",
      participantIds: [memberId],
    })
    const out = await turn(leadId, dm, ROUTINE, async (call, taint) => {
      const read = await call("projects:budget_get", { projectId })
      expect(JSON.stringify(read)).toContain("64000")
      expect(taint()).toContain(MONEY)
      return call("kernel:threads_reply", {
        threadId: room,
        content: "Price is 64000 (routine-case)",
      })
    })
    expect("data" in out).toBe(false)
    expect(await postedIn(room, "routine-case")).toBe(0)
  })

  it("a budget read without money stamps nothing, and the same post lands", async () => {
    const dm = await minimal.agentDm(orgId, memberId)
    const room = await minimal.thread(orgId, memberId, {
      title: "Hours only",
      participantIds: [leadId],
    })
    const out = await turn(memberId, dm, { humanTurn: true }, async (call, taint) => {
      const read = await call("projects:budget_get", { projectId })
      expect(read.error).toBeUndefined()
      expect(JSON.stringify(read)).not.toContain("64000")
      expect(taint()).not.toContain(MONEY)
      return call("kernel:threads_reply", { threadId: room, content: "Hours are on track (plain)" })
    })
    expect(out.error).toBeUndefined()
    expect(out.blocked).toBeUndefined()
    expect(await postedIn(room, "(plain)")).toBe(1)
  })
})

describe("setting a cost rate", () => {
  it("is declared DM-only and human-turn-only, and carries the margin scope", () => {
    const tool = (projectsAppManifest as any).tools.cost_rate_set
    expect(tool.dmOnly).toBe(true)
    expect(tool.humanTurnOnly).toBe(true)
    expect(tool.requiredScopes).toContain(MARGIN)
  })

  it("is refused in a shared thread and from a routine", async () => {
    const room = await minimal.thread(orgId, financeId, {
      title: "Finance and team",
      participantIds: [memberId],
    })
    const params = { userId: memberId, rate: 60, from: "2026-11-01" }
    const shared = await turn(financeId, room, { humanTurn: true }, (call) =>
      call("projects:cost_rate_set", params),
    )
    expect(shared.error?.code).toBe("dm_only")
    const dm = await minimal.agentDm(orgId, financeId)
    const routine = await turn(financeId, dm, ROUTINE, (call) =>
      call("projects:cost_rate_set", params),
    )
    expect(routine.error?.code).toBe("human_turn_only")
  })

  it("in a DM it runs, and a post of the rate into a shared thread does not land", async () => {
    const dm = await minimal.agentDm(orgId, financeId)
    const room = await minimal.thread(orgId, financeId, {
      title: "Team",
      participantIds: [memberId],
    })
    const out = await turn(financeId, dm, { humanTurn: true }, async (call, taint) => {
      // What the tool bridge records for the call itself: its own scopes.
      const set = await call("projects:cost_rate_set", {
        userId: memberId,
        rate: 60,
        from: "2026-11-01",
        currency: "EUR",
      })
      expect(set.error).toBeUndefined()
      const accumulator = runContextStore.getStore()?.turnScopeAccumulator
      const tool = (projectsAppManifest as any).tools.cost_rate_set
      accumulator?.record({ requiredScopes: tool.requiredScopes } as never)
      expect(taint()).toContain(MARGIN)
      return call("kernel:threads_reply", { threadId: room, content: "Rate is 60 (rate-case)" })
    })
    expect("data" in out).toBe(false)
    expect(await postedIn(room, "rate-case")).toBe(0)
  })

  it("refuses a currency that is not an ISO 4217 code", async () => {
    const dm = await minimal.agentDm(orgId, financeId)
    const out = await turn(financeId, dm, { humanTurn: true }, (call) =>
      call("projects:cost_rate_set", {
        userId: memberId,
        rate: 60,
        from: "2026-12-01",
        currency: "e",
      }),
    )
    expect(out.error?.code).toBe("invalid_currency")
  })
})
