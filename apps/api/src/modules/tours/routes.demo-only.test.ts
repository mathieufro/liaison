// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Demo scenarios (`demoOnly` tours) exist only in a demo org: a regular org's
// catalogue never lists one and starting one answers 404 with no progress row;
// a demo org lists and starts it.
import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import {
  type ListToursResponse,
  RUN_CONVERSATION,
  type TourProgressResponse,
} from "@liaison/shared"
import { app } from "~/app"
import { sql } from "~/db"
import { KERNEL_DECLARED_EMITS } from "~/infra/events/event-bus"
import { env } from "~/lib/env"
import { declaredEmits } from "~/modules/apps/app-registries"
import { signAccessToken } from "~/modules/auth/jwt"
import { DemoModeTestAccess } from "~/modules/demo/demo-mode"
import { invalidateDemoMarker, markOrgAsDemo, visitorMarker } from "~/modules/demo/demo-org"
import { DemoSeederTestAccess } from "~/modules/demo/demo-seeder"
import { loadTourOrgContext } from "~/modules/tours/service"
import { createTestOrg } from "~/tests/helpers/org"

let orgId: string
let alice: string
let token: string
let priorKernelEmits: Set<string> | undefined
const SCENARIO = "kernel.scenario-chat"

function call(method: string, path: string, body?: unknown) {
  return app.request(`/api/tours${path}`, {
    method,
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  })
}

async function rows() {
  return sql`SELECT 1 FROM kernel.tour_progress WHERE org_id = ${orgId} AND tour_id = ${SCENARIO}`
}

const prepared: Array<[string, string, string]> = []

beforeAll(async () => {
  // What a scenario's start writes is the seeder's (its own tests): record the call.
  DemoSeederTestAccess.setScenarioStart(async (org, owner, need) => {
    prepared.push([org, owner, need])
    return []
  })
  priorKernelEmits = declaredEmits.get("kernel")
  declaredEmits.set("kernel", new Set(KERNEL_DECLARED_EMITS))
  orgId = (await createTestOrg()).id
  alice = crypto.randomUUID()
  await sql`INSERT INTO kernel.users (id, org_id, email, name)
    VALUES (${alice}, ${orgId}, ${`tour-demo-${alice}@test.com`}, 'Alice')`
  token = await signAccessToken(
    { userId: alice, orgId, name: "T", authVersion: 1, permissionVersion: 1, scopes: ["*"] },
    env.JWT_SECRET,
  )
})

afterAll(async () => {
  DemoSeederTestAccess.reset()
  if (priorKernelEmits) declaredEmits.set("kernel", priorKernelEmits)
  else declaredEmits.delete("kernel")
  await sql`DELETE FROM kernel.tour_progress WHERE org_id = ${orgId}`
  invalidateDemoMarker(orgId)
})

describe("demo-only tours", () => {
  it("on a regular org: not listed, start and progress answer 404, no row written", async () => {
    const list = ((await (await call("GET", "")).json()) as { data: ListToursResponse }).data
    expect(list.tours.some((t) => t.tourId.startsWith("kernel.scenario-"))).toBe(false)
    const start = await call("POST", `/${SCENARIO}/start`, { source: "demo" })
    expect(start.status).toBe(404)
    expect(prepared).toEqual([])
    expect((await call("GET", `/${SCENARIO}/progress`)).status).toBe(404)
    expect(await rows()).toHaveLength(0)
  })

  // The connector page is read-only in a demo org: its tour's Add step is not there.
  it("the API connector tour's add step is for orgs whose connector page allows adding", async () => {
    const installed = (await loadTourOrgContext(orgId)).installedApps.includes("api-connector")
    expect((await loadTourOrgContext(orgId)).features.includes("connector-add")).toBe(installed)
    DemoModeTestAccess.set(true)
    try {
      await markOrgAsDemo(orgId, visitorMarker(24))
      expect((await loadTourOrgContext(orgId)).features).not.toContain("connector-add")
    } finally {
      DemoModeTestAccess.set(null)
    }
  })

  it("a software world tour is unavailable, 404s and its injector refuses in any other world", async () => {
    const FIXTURE = "kernel.world-fixture"
    // A demo org of the default world: not listed, not found, no row written.
    await markOrgAsDemo(orgId, visitorMarker(24))
    const list = ((await (await call("GET", "")).json()) as { data: ListToursResponse }).data
    expect(list.tours.some((t) => t.tourId === FIXTURE)).toBe(false)
    expect((await call("POST", `/${FIXTURE}/start`, { source: "demo" })).status).toBe(404)
    expect((await call("GET", `/${FIXTURE}/progress`)).status).toBe(404)
    const rowsOf = () =>
      sql`SELECT 1 FROM kernel.tour_progress WHERE org_id = ${orgId} AND tour_id = ${FIXTURE}`
    expect(await rowsOf()).toHaveLength(0)
    // The same org holding the software world is offered it and starts it.
    await markOrgAsDemo(orgId, visitorMarker(24, new Date(), undefined, { worldId: "saas" }))
    const inWorld = ((await (await call("GET", "")).json()) as { data: ListToursResponse }).data
    expect(inWorld.tours.some((t) => t.tourId === FIXTURE)).toBe(true)
    expect((await call("POST", `/${FIXTURE}/start`, { source: "demo" })).status).toBe(200)
    expect(await rowsOf()).toHaveLength(1)
    // And the scenarios of the default world are no longer offered there.
    expect(inWorld.tours.some((t) => t.tourId === SCENARIO)).toBe(false)
    expect((await call("POST", `/${SCENARIO}/start`, { source: "demo" })).status).toBe(404)
    await sql`DELETE FROM kernel.tour_progress WHERE org_id = ${orgId}`
    await markOrgAsDemo(orgId, visitorMarker(24))
  })

  it("on a demo org: listed and startable", async () => {
    await markOrgAsDemo(orgId, visitorMarker(24))
    const list = ((await (await call("GET", "")).json()) as { data: ListToursResponse }).data
    expect(list.tours.some((t) => t.tourId === SCENARIO)).toBe(true)
    const start = await call("POST", `/${SCENARIO}/start`, { source: "demo" })
    expect(start.status).toBe(200)
    expect(await rows()).toHaveLength(1)
  })

  // D23: a visitor's workspace opens with nothing waiting; a scenario brings
  // in its own seeded approvals as it starts.
  it("starting a scenario on a visitor org brings in what that scenario needs", async () => {
    await markOrgAsDemo(orgId, visitorMarker(24))
    prepared.length = 0
    const start = await call("POST", `/${SCENARIO}/start`, { source: "demo" })
    expect(start.status).toBe(200)
    expect(prepared).toEqual([[orgId, alice, "chat"]])
  })

  it("starting a scenario records the person's DM with their own agent; starting again records the same one", async () => {
    await markOrgAsDemo(orgId, visitorMarker(24))
    const conversationOf = async () => {
      const res = await call("POST", `/${SCENARIO}/start`, { source: "demo" })
      expect(res.status).toBe(200)
      const body = (await res.json()) as { data: TourProgressResponse }
      const recorded = body.data.progress?.beatStates[RUN_CONVERSATION]
      return typeof recorded === "object" ? recorded.entityId : undefined
    }
    const first = await conversationOf()
    const second = await conversationOf()
    expect(first).toBeString()
    expect(second).toBe(first)
    // It is her conversation with her personal agent, and the only one she has with it.
    const owned = await sql`SELECT t.id FROM kernel.threads t
      JOIN kernel.thread_participants me ON me.thread_id = t.id AND me.user_id = ${alice}
      JOIN kernel.thread_participants seat ON seat.thread_id = t.id AND seat.agent_id IS NOT NULL
      JOIN kernel.agents a ON a.id = seat.agent_id AND a.kind = 'personal' AND a.owner_user_id = ${alice}
      WHERE t.org_id = ${orgId} AND t.type = 'agent_chat'`
    expect(owned.map((r) => r.id)).toEqual([first])
  })
})
