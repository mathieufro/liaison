// SPDX-License-Identifier: FSL-1.1-ALv2
// World beats (C7): the registry runs a demo scenario's world beat once, only
// in a demo org, only while it is the owner's current beat, only after the
// visitor verified when its follow-up spends; a failure releases the claim and
// says why (gate frame), Retry runs it again; a replay completes the beat on
// entry without a second injection within one run, while starting the
// scenario again is a new run that injects again; a stale claim is reclaimable.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, mock } from "bun:test"
import { findTour, PROSPECT_ROUTINE_NAME, type Tour, type TourFrameData } from "@liaison/shared"
import { sql } from "~/db"
import { withPrivilegedDb } from "~/db/privileged"
import { KERNEL_DECLARED_EMITS } from "~/infra/events/event-bus"
import { declaredEmits } from "~/modules/apps/app-registries"
import {
  invalidateDemoMarker,
  markOrgAsDemo,
  reservedMarker,
  visitorMarker,
} from "~/modules/demo/demo-org"
import * as verification from "~/modules/demo/demo-verification"
import { loadTourOrgContext, startTour, tourBeats } from "~/modules/tours/service"
import * as minimal from "~/seed/tiers/minimal"
import { createTestOrg } from "~/tests/helpers/org"

let verified = false
const realVerification = { ...verification }
mock.module("~/modules/demo/demo-verification", () => ({
  ...realVerification,
  demoVerifiedIdentity: async () =>
    verified ? { emailNormalized: "visitor@example.com", network: "198.51.100.0/24" } : null,
}))
afterAll(() => {
  mock.module("~/modules/demo/demo-verification", () => realVerification)
})

const { WorldRegistryTestAccess, runWorldBeatOnce, resumeWorldBeats, WORLD_CLAIM_STALE_MS } =
  await import("~/modules/demo/world/registry")
const { handleDemoWorldEvent } = await import("~/modules/demo/world/consumer")

const TOUR_ID = "kernel.scenario-chat"
const TOUR = findTour(TOUR_ID) as Tour
const WORLD_BEAT = "question"

let priorKernelEmits: Set<string> | undefined
let demoOrg: string
let plainOrg: string
let owner: string
let plainOwner: string
let calls: number
let fail: boolean
let spends: boolean
let entity: string | null
let runs: number[]
let restore: (() => void) | null = null

async function addUser(orgId: string): Promise<string> {
  const id = crypto.randomUUID()
  await sql`INSERT INTO kernel.users (id, org_id, email, name)
    VALUES (${id}, ${orgId}, ${`world-${id}@test.com`}, 'Visitor')`
  return id
}

/** Start the chat scenario for `userId` and stand them on its world beat. */
async function onWorldBeat(orgId: string, userId: string): Promise<void> {
  const ctx = { ...(await loadTourOrgContext(orgId)), isDemo: true }
  await withPrivilegedDb(orgId, "world-test-start", (tx) =>
    startTour(tx, {
      orgId,
      userId,
      tour: TOUR,
      beats: tourBeats(TOUR, ctx),
      source: "demo",
      actor: { userId, actorType: "user" },
    }),
  ).catch(() => undefined)
  await sql`INSERT INTO kernel.tour_progress (org_id, user_id, tour_id, status, beat_id, beat_index, beat_states, source)
    VALUES (${orgId}, ${userId}, ${TOUR_ID}, 'active', ${WORLD_BEAT}, 1, '{"channels":"done"}'::jsonb, 'demo')
    ON CONFLICT (org_id, user_id, tour_id) DO UPDATE
      SET status = 'active', beat_id = ${WORLD_BEAT}, beat_index = 1,
          beat_states = '{"channels":"done"}'::jsonb`
}

/** Put the owner back on the world beat within the SAME run (a back move, a reload). */
async function backToWorldBeat(orgId: string, userId: string): Promise<void> {
  await sql`UPDATE kernel.tour_progress
    SET status = 'active', beat_id = ${WORLD_BEAT}, beat_index = 1,
        beat_states = '{"channels":"done"}'::jsonb
    WHERE org_id = ${orgId} AND user_id = ${userId} AND tour_id = ${TOUR_ID}`
}

/** Start the scenario again (what startTour writes: a new started_at) and stand on the world beat. */
async function startAgain(orgId: string, userId: string): Promise<void> {
  await sql`UPDATE kernel.tour_progress SET started_at = clock_timestamp()
    WHERE org_id = ${orgId} AND user_id = ${userId} AND tour_id = ${TOUR_ID}`
  await backToWorldBeat(orgId, userId)
}

async function rowOf(orgId: string, userId: string) {
  const [row] = await sql`SELECT status, beat_id, beat_states FROM kernel.tour_progress
    WHERE org_id = ${orgId} AND user_id = ${userId} AND tour_id = ${TOUR_ID}`
  return row as { status: string; beat_id: string | null; beat_states: Record<string, unknown> }
}

async function marks(orgId: string) {
  return sql`SELECT state FROM kernel.demo_world_marks WHERE org_id = ${orgId}`
}

async function gateFrames(orgId: string, userId: string): Promise<TourFrameData[]> {
  const rows = await sql`SELECT payload FROM kernel.pending_events
    WHERE org_id = ${orgId} AND payload->>'entity' = 'tour'
      AND payload->'data'->>'ownerUserId' = ${userId} AND payload->'data' ? 'gate'`
  return rows.map((r) => (r.payload as { data: TourFrameData }).data)
}

beforeAll(async () => {
  priorKernelEmits = declaredEmits.get("kernel")
  declaredEmits.set("kernel", new Set(KERNEL_DECLARED_EMITS))
  demoOrg = (await createTestOrg()).id
  await markOrgAsDemo(demoOrg, visitorMarker(24))
  plainOrg = (await minimal.secondOrg()).orgId
})

afterAll(() => {
  if (priorKernelEmits) declaredEmits.set("kernel", priorKernelEmits)
  else declaredEmits.delete("kernel")
})

beforeEach(async () => {
  calls = 0
  fail = false
  spends = false
  entity = null
  runs = []
  verified = false
  await sql`DELETE FROM kernel.demo_world_marks WHERE org_id IN (${demoOrg}, ${plainOrg})`
  owner = await addUser(demoOrg)
  plainOwner = await addUser(plainOrg)
  const injector = {
    id: "chat-question",
    get spends() {
      return spends
    },
    async injectWorldEvent(ctx: { run: number }) {
      calls++
      runs.push(ctx.run)
      if (fail) throw new Error("boom")
    },
    async entityOf() {
      return entity
    },
  }
  restore = WorldRegistryTestAccess.override("chat-question", injector)
})

afterEach(() => {
  restore?.()
  restore = null
})

describe("runWorldBeat", () => {
  it("refuses a non-demo org: no injection, no mark, the row untouched", async () => {
    await onWorldBeat(plainOrg, plainOwner)
    expect(await runWorldBeatOnce(plainOrg, plainOwner, TOUR_ID)).toBe("not_demo")
    expect(calls).toBe(0)
    expect(await marks(plainOrg)).toHaveLength(0)
    expect((await rowOf(plainOrg, plainOwner)).beat_id).toBe(WORLD_BEAT)
  })

  it("an injector bound to another world refuses: no injection, no mark, the beat stays", async () => {
    restore?.()
    restore = WorldRegistryTestAccess.override("chat-question", {
      id: "chat-question",
      world: "saas",
      async injectWorldEvent() {
        calls++
      },
    })
    await onWorldBeat(demoOrg, owner)
    expect(await runWorldBeatOnce(demoOrg, owner, TOUR_ID)).toBe("other_world")
    expect(calls).toBe(0)
    expect(await marks(demoOrg)).toHaveLength(0)
    expect((await rowOf(demoOrg, owner)).beat_id).toBe(WORLD_BEAT)
  })

  it("runs the current world beat once and stays on it to be read; a second delivery runs nothing", async () => {
    await onWorldBeat(demoOrg, owner)
    expect(await runWorldBeatOnce(demoOrg, owner, TOUR_ID)).toBe("completed")
    expect(calls).toBe(1)
    expect((await marks(demoOrg)).map((m) => m.state)).toEqual(["succeeded"])
    const row = await rowOf(demoOrg, owner)
    expect(row.beat_id).toBe(WORLD_BEAT)
    expect(row.beat_states[WORLD_BEAT]).toBe("done")
    expect(await runWorldBeatOnce(demoOrg, owner, TOUR_ID)).toBe("no_world_beat")
    expect(calls).toBe(1)
  })

  it("a frame for a beat that is no longer current runs nothing", async () => {
    await onWorldBeat(demoOrg, owner)
    await sql`UPDATE kernel.tour_progress SET beat_id = 'channels', beat_index = 0
      WHERE org_id = ${demoOrg} AND user_id = ${owner}`
    expect(await runWorldBeatOnce(demoOrg, owner, TOUR_ID)).toBe("no_world_beat")
    expect(calls).toBe(0)
  })

  it("a back move within one run completes the beat on entry without injecting again", async () => {
    await onWorldBeat(demoOrg, owner)
    await runWorldBeatOnce(demoOrg, owner, TOUR_ID)
    await backToWorldBeat(demoOrg, owner)
    expect(await runWorldBeatOnce(demoOrg, owner, TOUR_ID)).toBe("replayed")
    expect(calls).toBe(1)
    expect((await rowOf(demoOrg, owner)).beat_id).toBe(WORLD_BEAT)
  })

  it("starting the scenario again is a new run: the world beat injects again, keyed to that run", async () => {
    await onWorldBeat(demoOrg, owner)
    expect(await runWorldBeatOnce(demoOrg, owner, TOUR_ID)).toBe("completed")
    await startAgain(demoOrg, owner)
    expect(await runWorldBeatOnce(demoOrg, owner, TOUR_ID)).toBe("completed")
    expect(calls).toBe(2)
    expect(runs).toEqual([0, 1])
    expect((await rowOf(demoOrg, owner)).beat_id).toBe(WORLD_BEAT)
    // Within the new run, a second pass injects nothing.
    await backToWorldBeat(demoOrg, owner)
    expect(await runWorldBeatOnce(demoOrg, owner, TOUR_ID)).toBe("replayed")
    expect(calls).toBe(2)
  })

  it("a failed pass in a new run keeps that run's key: the retry injects for the same run", async () => {
    await onWorldBeat(demoOrg, owner)
    await runWorldBeatOnce(demoOrg, owner, TOUR_ID)
    await startAgain(demoOrg, owner)
    fail = true
    expect(await runWorldBeatOnce(demoOrg, owner, TOUR_ID)).toBe("failed")
    fail = false
    expect(await runWorldBeatOnce(demoOrg, owner, TOUR_ID)).toBe("completed")
    expect(runs).toEqual([0, 1, 1])
  })

  it("a mark from before runs were recorded belongs to the run current when it was claimed", async () => {
    await onWorldBeat(demoOrg, owner)
    // Claimed during the current run: a back move replays it.
    await sql`INSERT INTO kernel.demo_world_marks (org_id, tour_id, beat_id, state, claimed_at)
      VALUES (${demoOrg}, ${TOUR_ID}, ${WORLD_BEAT}, 'succeeded', now() + interval '1 second')`
    expect(await runWorldBeatOnce(demoOrg, owner, TOUR_ID)).toBe("replayed")
    expect(calls).toBe(0)
    // Claimed before the current run started: the run is new, it injects.
    await sql`UPDATE kernel.demo_world_marks
      SET run_started_at = NULL, claimed_at = now() - interval '1 day' WHERE org_id = ${demoOrg}`
    await backToWorldBeat(demoOrg, owner)
    expect(await runWorldBeatOnce(demoOrg, owner, TOUR_ID)).toBe("completed")
    expect(runs).toEqual([1])
  })

  it("a failure releases the claim and pushes gate: failed; Retry then runs and succeeds", async () => {
    await onWorldBeat(demoOrg, owner)
    fail = true
    expect(await runWorldBeatOnce(demoOrg, owner, TOUR_ID)).toBe("failed")
    // Released: no live claim stays (the row may stay, to keep the run's key).
    expect((await marks(demoOrg)).filter((m) => m.state === "succeeded")).toHaveLength(0)
    expect((await rowOf(demoOrg, owner)).beat_id).toBe(WORLD_BEAT)
    expect((await gateFrames(demoOrg, owner)).map((f) => f.gate)).toEqual(["failed"])
    fail = false
    expect(await runWorldBeatOnce(demoOrg, owner, TOUR_ID)).toBe("completed")
    expect(calls).toBe(2)
  })

  it("an injector that spends waits for verification (gate: verify), then verify-then-continue runs it", async () => {
    spends = true
    await onWorldBeat(demoOrg, owner)
    expect(await runWorldBeatOnce(demoOrg, owner, TOUR_ID)).toBe("gated")
    expect(calls).toBe(0)
    expect((await gateFrames(demoOrg, owner)).map((f) => f.gate)).toEqual(["verify"])
    verified = true
    // What the verify success calls: no tour event needed.
    await resumeWorldBeats(demoOrg, owner)
    expect(calls).toBe(1)
    expect((await rowOf(demoOrg, owner)).beat_id).toBe(WORLD_BEAT)
  })

  it("a visitor with a model key of their own runs a spending world beat unverified; without one it is still gated", async () => {
    spends = true
    const ownKey = (on: boolean) =>
      on
        ? sql`UPDATE kernel.organizations SET settings = jsonb_set(coalesce(settings, '{}'::jsonb),
            '{providerKeys}', '{"openrouter":{"encrypted":"v1:own-key","maskedHint":"or-test"}}'::jsonb)
            WHERE id = ${demoOrg}`
        : sql`UPDATE kernel.organizations SET settings = coalesce(settings, '{}'::jsonb) - 'providerKeys'
            WHERE id = ${demoOrg}`
    try {
      await ownKey(true)
      await onWorldBeat(demoOrg, owner)
      expect(await runWorldBeatOnce(demoOrg, owner, TOUR_ID)).toBe("completed")
      expect(calls).toBe(1)
      expect(await gateFrames(demoOrg, owner)).toEqual([])

      await ownKey(false)
      await sql`DELETE FROM kernel.demo_world_marks WHERE org_id = ${demoOrg}`
      await onWorldBeat(demoOrg, owner)
      expect(await runWorldBeatOnce(demoOrg, owner, TOUR_ID)).toBe("gated")
      expect(calls).toBe(1)
    } finally {
      await ownKey(false)
    }
  })

  it("records what the live event brought in on the beat, on the first pass and on a replay", async () => {
    entity = crypto.randomUUID()
    await onWorldBeat(demoOrg, owner)
    expect(await runWorldBeatOnce(demoOrg, owner, TOUR_ID)).toBe("completed")
    expect((await rowOf(demoOrg, owner)).beat_states[WORLD_BEAT]).toEqual({
      state: "done",
      entityId: entity,
    })
    await backToWorldBeat(demoOrg, owner)
    expect(await runWorldBeatOnce(demoOrg, owner, TOUR_ID)).toBe("replayed")
    expect((await rowOf(demoOrg, owner)).beat_states[WORLD_BEAT]).toEqual({
      state: "done",
      entityId: entity,
    })
  })

  it("a live claim makes another pass a no-op; a stale one (> 2 min) is reclaimable", async () => {
    await onWorldBeat(demoOrg, owner)
    await sql`INSERT INTO kernel.demo_world_marks (org_id, tour_id, beat_id, state, claimed_at)
      VALUES (${demoOrg}, ${TOUR_ID}, ${WORLD_BEAT}, 'claimed', now())`
    expect(await runWorldBeatOnce(demoOrg, owner, TOUR_ID)).toBe("busy")
    expect(calls).toBe(0)
    const stale = new Date(Date.now() - WORLD_CLAIM_STALE_MS - 1000).toISOString()
    await sql`UPDATE kernel.demo_world_marks SET claimed_at = ${stale}::timestamptz
      WHERE org_id = ${demoOrg}`
    expect(await runWorldBeatOnce(demoOrg, owner, TOUR_ID)).toBe("completed")
    expect(calls).toBe(1)
  })
})

describe("demo-world consumer", () => {
  const frame = (orgId: string, userId: string, extra: Partial<TourFrameData> = {}) => ({
    eventId: crypto.randomUUID(),
    event: {
      app: "kernel",
      entity: "tour",
      action: "update",
      entityId: `${userId}:${TOUR_ID}`,
      orgId,
      actorId: userId,
      actorType: "user" as const,
      data: {
        ownerUserId: userId,
        tourId: TOUR_ID,
        status: "active",
        beatId: WORLD_BEAT,
        beatIndex: 1,
        emittedAt: new Date().toISOString(),
        ...extra,
      },
    },
  })

  it("runs the world beat on a tour frame, never on its own gate frame, and never throws", async () => {
    await onWorldBeat(demoOrg, owner)
    await handleDemoWorldEvent(frame(demoOrg, owner, { gate: "failed" }))
    expect(calls).toBe(0)
    await handleDemoWorldEvent(frame(demoOrg, owner))
    expect(calls).toBe(1)
    fail = true
    await onWorldBeat(demoOrg, owner)
    await sql`DELETE FROM kernel.demo_world_marks WHERE org_id = ${demoOrg}`
    await expect(handleDemoWorldEvent(frame(demoOrg, owner))).resolves.toBeUndefined()
  })

  it("refuses the reserved review org: no injection, no mark", async () => {
    const reviewOrg = (await minimal.secondOrg()).orgId
    await markOrgAsDemo(reviewOrg, reservedMarker())
    invalidateDemoMarker()
    const reviewer = await addUser(reviewOrg)
    await onWorldBeat(reviewOrg, reviewer)
    expect(await runWorldBeatOnce(reviewOrg, reviewer, TOUR_ID)).toBe("not_demo")
    expect(calls).toBe(0)
    expect(await marks(reviewOrg)).toHaveLength(0)
  })

  it("completes the sales enable beat at once when the prospect routine is already on, recording the routine", async () => {
    const SALES = findTour("kernel.scenario-sales") as Tour
    const ctx = await loadTourOrgContext(demoOrg)
    const beats = tourBeats(SALES, ctx)
    const at = beats.findIndex((b) => b.id === "enable")
    expect(at).toBeGreaterThan(0)
    const done = Object.fromEntries(beats.slice(0, at).map((b) => [b.id, "done"]))
    await sql`INSERT INTO kernel.tour_progress (org_id, user_id, tour_id, status, beat_id, beat_index, beat_states, source)
      VALUES (${demoOrg}, ${owner}, ${SALES.id}, 'active', 'enable', ${at}, ${JSON.stringify(done)}::jsonb, 'demo')
      ON CONFLICT (org_id, user_id, tour_id) DO UPDATE
        SET status = 'active', beat_id = 'enable', beat_index = ${at}, beat_states = ${JSON.stringify(done)}::jsonb`
    const salesRow = async () => {
      const [row] = await sql`SELECT beat_id, beat_states FROM kernel.tour_progress
        WHERE org_id = ${demoOrg} AND user_id = ${owner} AND tour_id = ${SALES.id}`
      return row as { beat_id: string; beat_states: Record<string, unknown> }
    }
    const salesFrame = () => frame(demoOrg, owner, { tourId: SALES.id })
    // The routine is off: the beat waits for the visitor's click.
    const routineId = crypto.randomUUID()
    await sql`INSERT INTO kernel.routines
        (id, org_id, owner_user_id, name, description, kind, event, prompt, scopes, created_by_actor_type, enabled)
      VALUES (${routineId}, ${demoOrg}, ${owner}, ${PROSPECT_ROUTINE_NAME}, 'd', 'event',
              'mail:message:create', 'p', ${sql.array(["mail:conversations:read"])}, 'user', false)`
    const injected = WorldRegistryTestAccess.override("sales-email", {
      id: "sales-email",
      async injectWorldEvent() {
        calls++
      },
    })
    try {
      await handleDemoWorldEvent(salesFrame())
      expect((await salesRow()).beat_id).toBe("enable")
      // Already on (enabled earlier): the beat completes and the live email runs.
      await sql`UPDATE kernel.routines SET enabled = true WHERE id = ${routineId}`
      await handleDemoWorldEvent(salesFrame())
      const row = await salesRow()
      // The routine it found is recorded on the beat, as the enable event's
      // would be: the researching beat waits on that routine's run (walk D27).
      expect(row.beat_states.enable).toEqual({ state: "done", entityId: routineId })
      expect(row.beat_id).not.toBe("enable")
      expect(calls).toBe(1)
    } finally {
      injected()
      await sql`DELETE FROM kernel.routines WHERE id = ${routineId}`
      await sql`DELETE FROM kernel.tour_progress WHERE org_id = ${demoOrg} AND tour_id = ${SALES.id}`
    }
  })
})
