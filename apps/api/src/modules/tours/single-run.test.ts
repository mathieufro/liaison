// SPDX-License-Identifier: FSL-1.1-ALv2
//
// A single-run scenario is played once. Its money step cannot be undone, so a
// played run does not start again: not from a stale second tab whose list still
// says "new", not from its "Next", not from any direct call. Only the demo's
// Start over, which leaves the visitor with no progress at all, plays it again.
import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import type { Tour } from "@liaison/shared"
import { sql } from "~/db"
import { withPrivilegedDb } from "~/db/privileged"
import { KERNEL_DECLARED_EMITS } from "~/infra/events/event-bus"
import { declaredEmits } from "~/modules/apps/app-registries"
import { invalidateDemoMarker, markOrgAsDemo, visitorMarker } from "~/modules/demo/demo-org"
import {
  isPlayedSingleRun,
  loadTourOrgContext,
  serverTourCatalogue,
  startTour,
  TourPlayedError,
  tourBeats,
  updateTour,
} from "~/modules/tours/service"
import { seedUserRow } from "~/seed/factories/org/rows"
import { createTestOrg } from "~/tests/helpers/org"

let orgId: string
let alice: string
let priorKernelEmits: Set<string> | undefined
let tour: Tour

async function start(): Promise<unknown> {
  const ctx = { ...(await loadTourOrgContext(orgId)), isDemo: true }
  return withPrivilegedDb(orgId, "single-run-test", (tx) =>
    startTour(tx, {
      orgId,
      userId: alice,
      tour,
      beats: tourBeats(tour, ctx),
      source: "demo",
      actor: { userId: alice, actorType: "user" },
      conversationId: crypto.randomUUID(),
    }),
  )
}

async function row() {
  const [r] = await sql`SELECT status, beat_id, beat_index, beat_states, started_at, updated_at
    FROM kernel.tour_progress WHERE org_id = ${orgId} AND user_id = ${alice} AND tour_id = ${tour.id}`
  return r ?? null
}

beforeAll(async () => {
  const found = serverTourCatalogue().find((t) => t.singleRun === true)
  if (!found) throw new Error("no single-run tour in the catalogue")
  tour = found
  priorKernelEmits = declaredEmits.get("kernel")
  declaredEmits.set("kernel", new Set(KERNEL_DECLARED_EMITS))
  orgId = (await createTestOrg()).id
  alice = crypto.randomUUID()
  await seedUserRow({ id: alice, orgId, email: `single-run-${alice}@test.com`, name: "Alice" })
  await markOrgAsDemo(
    orgId,
    visitorMarker(24, new Date(), undefined, { worldId: tour.world ?? "saas" }),
  )
})

afterAll(async () => {
  if (priorKernelEmits) declaredEmits.set("kernel", priorKernelEmits)
  else declaredEmits.delete("kernel")
  await sql`DELETE FROM kernel.tour_progress WHERE org_id = ${orgId}`
  invalidateDemoMarker(orgId)
})

describe("a single-run scenario", () => {
  it("a stale second tab's start on a played run is refused and changes nothing", async () => {
    // Tab A starts it and plays it to the end.
    await start()
    await sql`UPDATE kernel.tour_progress SET status = 'completed', beat_id = NULL,
      beat_index = 1, beat_states = '{"card-updated":"done"}'::jsonb
      WHERE org_id = ${orgId} AND user_id = ${alice} AND tour_id = ${tour.id}`
    const played = await row()
    expect(isPlayedSingleRun(tour, { status: "completed" })).toBe(true)
    // Tab B still lists it as new: its "Next" (or start) asks for a start.
    await expect(start()).rejects.toBeInstanceOf(TourPlayedError)
    expect(await row()).toEqual(played)
  })

  it("a stale tab's Next on the played run moves nothing", async () => {
    const before = await row()
    const ctx = { ...(await loadTourOrgContext(orgId)), isDemo: true }
    const outcome = await withPrivilegedDb(orgId, "single-run-test", (tx) =>
      updateTour(tx, {
        orgId,
        userId: alice,
        tour,
        beats: tourBeats(tour, ctx),
        request: { advance: true },
        actor: { userId: alice, actorType: "user" },
      }),
    )
    expect(outcome.kind).toBe("refused")
    expect(await row()).toEqual(before)
  })

  it("a run left before its end is played too", async () => {
    await sql`UPDATE kernel.tour_progress SET status = 'abandoned'
      WHERE org_id = ${orgId} AND user_id = ${alice} AND tour_id = ${tour.id}`
    const left = await row()
    await expect(start()).rejects.toBeInstanceOf(TourPlayedError)
    expect(await row()).toEqual(left)
  })

  it("after Start over, with no progress left, it plays again from its first step", async () => {
    await sql`DELETE FROM kernel.tour_progress WHERE org_id = ${orgId} AND user_id = ${alice}`
    await start()
    expect((await row())?.status).toBe("active")
    expect((await row())?.beat_index).toBe(0)
  })
})
