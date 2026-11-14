// SPDX-License-Identifier: FSL-1.1-ALv2
//
// World beats: the live events a demo scenario injects into a demo org (a
// customer's ticket arriving, a teammate's comment, an order) while its owner
// watches the guided tour.
//
// Every injector is listed here, statically, so adding one needs no other
// file to register it. The registry is the only caller of an injector: it is
// where the demo-org guard, the active-beat check, the verification check and
// the once-per-beat mark apply. An injector never takes caller input; its
// content is fixed.
//
// One pass of `runWorldBeat`:
//  1. Guard: the org's visitor demo marker (database), else nothing runs (the
//     reserved review org included).
//  2. Active beat: the owner's progress row is active and its current
//     effective beat is a world beat naming a registered injector.
//  3. Once-mark (`kernel.demo_world_marks`), per RUN of the scenario: a run
//     is one `started_at` of the owner's progress row, so Start again begins a
//     new run. `succeeded` for this run means the beat ran already (a back
//     move, a reload), so it completes with no second injection. A mark of an
//     earlier run is superseded: the pass claims it for this run and counts
//     the run (`generation`), and the injector keys what it brings in to that
//     run, so the new run gets a new live event and never binds to the old
//     one. Otherwise the pass claims the mark (a claim older than two minutes
//     is stale and reclaimable); a live claim held by another pass means
//     nothing to do.
//  4. Verification: an injector whose follow-up spends on the box key waits
//     until the visitor confirmed their email (`gate: verify`); the verify
//     success calls `resumeWorldBeats`. A visitor who saved a model key of
//     their own spends that key, not the box's: no verification is asked.
//  5. Run. Success marks `succeeded` and advances the row (compare-and-set,
//     actor system, same run); failure releases the claim (it goes stale, so
//     the run keeps its generation) and says so (`gate: failed`, or `budget`
//     for a spend refusal), and the panel's Retry runs it again.

import {
  beatArrived,
  type DemoWorldId,
  orgKernelSettingsSchema,
  PROSPECT_ROUTINE_NAME,
  type TourBeatGate,
} from "@liaison/shared"
import { and, sql as drizzleSql, eq } from "drizzle-orm"
import { extractRows } from "~/db"
import { withPrivilegedDb } from "~/db/privileged"
import { demoWorldMarks, routines, tourProgress } from "~/db/schema/kernel"
import { schemaRef } from "~/db/schema-ref"
import { byokEncryptionKey, env } from "~/lib/env"
import { rootLogger } from "~/lib/logger"
import { getOrgKernelSettings } from "~/lib/settings"
import { isChatModelProvider } from "~/modules/agent/credits/model-keys"
import { demoWorldOf, isVisitorDemoOrgId, loadDemoMarker } from "~/modules/demo/demo-org"
import { demoVerifiedIdentity } from "~/modules/demo/demo-verification"
import { chatQuestionInjector } from "~/modules/demo/world/chat-question"
import { commerceOrderInjector } from "~/modules/demo/world/commerce-order"
import { knowledgeLucasAsksInjector } from "~/modules/demo/world/knowledge-lucas-asks"
import { projectsCommentInjector } from "~/modules/demo/world/projects-comment"
import { salesEmailInjector } from "~/modules/demo/world/sales-email"
import { supportTicketInjector } from "~/modules/demo/world/support-ticket"
import { saasChatQuestionInjector } from "~/modules/demo/worlds/saas/chat-question"
import { saasKnowledgeAsksInjector } from "~/modules/demo/worlds/saas/knowledge-asks"
import { paymentRecoveredInjector } from "~/modules/demo/worlds/saas/payment-recovered"
import { saasProjectsCommentInjector } from "~/modules/demo/worlds/saas/projects-comment"
import { saasSalesEmailInjector } from "~/modules/demo/worlds/saas/sales-email"
import { saasSupportTicketInjector } from "~/modules/demo/worlds/saas/support-ticket"
import {
  assertWorldBeatAllowed,
  completeDoBeat,
  completeWorldBeat,
  currentIndex,
  findServerTour,
  loadTourOrgContext,
  progressOf,
  readProgressRow,
  tourBeats,
  tourFrameEvent,
  writeTourMove,
} from "~/modules/tours/service"

const K = () => drizzleSql.raw(schemaRef("kernel"))

const log = rootLogger.child({ module: "demo-world" })

/** What an injector is told: whose tour, which beat, which run. Never caller input. */
export interface WorldInjectorContext {
  orgId: string
  ownerUserId: string
  tourId: string
  beatId: string
  /**
   * Which run of the scenario this is for the beat: 0 for the first, one more
   * each time the scenario is started again. What the injector brings in is
   * keyed to it (`worldRunKey`), so each run gets its own live event and a
   * pass within one run finds the one it already brought in.
   */
  run: number
  /** When this run started (the progress row's `started_at`). */
  runStartedAt: Date
}

export interface WorldInjector {
  /** The world beat's `injector` slug. */
  id: string
  /**
   * The demo world the injector writes into. It runs in a workspace of that
   * world only: the registry refuses it anywhere else. Absent: not bound to a
   * world (it runs wherever its tour is offered).
   */
  world?: DemoWorldId
  /**
   * What the live event sets off spends on the box's model key (an agent
   * turn, a routine run): it waits until the visitor confirmed their email.
   */
  spends?: boolean
  injectWorldEvent(ctx: WorldInjectorContext): Promise<void>
  /**
   * The entity the live event brought into the org (the ticket, the task),
   * once it is there; recorded on the beat so later beats open that one
   * (`/tickets/{live-ticket}`) and approve only what concerns it. Read after
   * the injection and again on a replay, so a beat completed on an earlier
   * pass records it too.
   */
  entityOf?(ctx: WorldInjectorContext): Promise<string | null>
}

// Built on first use, not at module load: an injector module reaches this one
// back through the code it calls (a message write, the verification), so a
// map built at load would read an injector that is still initializing when an
// injector module is the first of the cycle to load.
let injectorMap: Map<string, WorldInjector> | null = null
function injectors(): Map<string, WorldInjector> {
  injectorMap ??= new Map<string, WorldInjector>(
    [
      supportTicketInjector,
      chatQuestionInjector,
      salesEmailInjector,
      projectsCommentInjector,
      commerceOrderInjector,
      knowledgeLucasAsksInjector,
      paymentRecoveredInjector,
      saasSupportTicketInjector,
      saasProjectsCommentInjector,
      saasChatQuestionInjector,
      saasSalesEmailInjector,
      saasKnowledgeAsksInjector,
    ].map((injector) => [injector.id, injector]),
  )
  return injectorMap
}

/** Every injector, by id. */
export function worldInjectors(): ReadonlyMap<string, WorldInjector> {
  return injectors()
}

/**
 * Would the agent turns this world beat sets off spend the BOX's model key?
 * Not when the visitor saved a key of their own: the visitor model runs on an
 * own OpenRouter key, and Auto prefers a chat provider they hold a key for
 * (the credit meter's `visitorModelFor` and `resolveKey`, which decide this
 * per call). The same test as there: a stored, decryptable key entry.
 */
export async function worldBeatSpendsBoxKey(orgId: string): Promise<boolean> {
  if (!byokEncryptionKey) return true
  const settings = await withPrivilegedDb(orgId, "demo-world-own-key", (tx) =>
    getOrgKernelSettings(tx, orgId, orgKernelSettingsSchema),
  )
  const owns = Object.entries(settings.providerKeys ?? {}).some(
    ([provider, entry]) =>
      Boolean(entry?.encrypted) && (provider === "openrouter" || isChatModelProvider(provider)),
  )
  return !owns
}

/** A claim older than this belongs to a pass that died: it may be claimed again. */
export const WORLD_CLAIM_STALE_MS = 2 * 60 * 1000

/** Spend refusals an injector may surface (B's codes): the gate says budget. */
const BUDGET_CODES = new Set([
  "demo_budget_exhausted",
  "demo_network_exhausted",
  "demo_box_exhausted",
  "demo_rate_limited",
  "demo_busy",
  "demo_unavailable",
])
const VERIFY_CODES = new Set(["demo_verification_required"])

function gateForError(err: unknown): TourBeatGate {
  const code =
    typeof err === "object" && err !== null && "code" in err
      ? (err as { code?: unknown }).code
      : undefined
  if (typeof code === "string" && VERIFY_CODES.has(code)) return "verify"
  if (typeof code === "string" && BUDGET_CODES.has(code)) return "budget"
  return "failed"
}

/** What a pass did, for the retry route and the tests. */
export type WorldBeatOutcome =
  | "not_demo"
  | "other_world"
  | "no_world_beat"
  | "completed"
  | "replayed"
  | "busy"
  | "gated"
  | "failed"

interface WorldBeatTarget {
  orgId: string
  ownerUserId: string
  tourId: string
}

/** Tell the owner's tabs why the world beat waits (a `kernel:tour` frame with `gate`). */
async function pushGate(target: WorldBeatTarget, gate: TourBeatGate): Promise<void> {
  const tour = findServerTour(target.tourId)
  if (!tour) return
  const orgCtx = await loadTourOrgContext(target.orgId)
  const beats = tourBeats(tour, orgCtx)
  await withPrivilegedDb(target.orgId, "demo-world-gate", async (tx) => {
    const row = await readProgressRow(tx, {
      orgId: target.orgId,
      userId: target.ownerUserId,
      tourId: target.tourId,
    })
    if (!row) return
    await tx.queueEvent(
      tourFrameEvent(
        target.orgId,
        target.ownerUserId,
        progressOf(tour, row, beats),
        "update",
        { userId: target.ownerUserId, actorType: "system" },
        gate,
      ),
    )
  })
}

/**
 * Advance the owner's row past its current world beat `beatId` (CAS on the
 * row as read here). Returns false when the row moved meanwhile.
 */
async function advancePastWorldBeat(
  target: WorldBeatTarget,
  beatId: string,
  runStartedAt: Date,
  entityId: string | null,
): Promise<boolean> {
  const tour = findServerTour(target.tourId)
  if (!tour) return false
  const orgCtx = await loadTourOrgContext(target.orgId)
  const beats = tourBeats(tour, orgCtx)
  return withPrivilegedDb(target.orgId, "demo-world-advance", async (tx) => {
    const row = await readProgressRow(tx, {
      orgId: target.orgId,
      userId: target.ownerUserId,
      tourId: target.tourId,
    })
    if (!row || row.status !== "active") return false
    // Started again meanwhile: this pass's entity belongs to the earlier run.
    if (row.startedAt.getTime() !== runStartedAt.getTime()) return false
    if (beats[currentIndex(beats, row)]?.id !== beatId) return false
    const move = completeWorldBeat(beats, row, entityId ?? undefined)
    if (!move) return false
    const written = await writeTourMove(tx, {
      orgId: target.orgId,
      userId: target.ownerUserId,
      tour,
      beats,
      from: row,
      next: move.next,
      actor: { userId: target.ownerUserId, actorType: "system" },
    })
    return written !== null
  })
}

type ClaimResult =
  | { state: "claimed" | "succeeded"; generation: number }
  | { state: "busy"; generation: null }

/**
 * Claim the mark for the owner's current run; `succeeded` when the beat
 * already ran in this run, `busy` when a live claim holds it. A mark of an
 * earlier run (its `run_started_at` is not this run's; a mark from before
 * runs were recorded, claimed before this run started) is superseded: it is
 * claimed for this run, one generation on.
 */
async function claimMark(
  orgId: string,
  ownerUserId: string,
  tourId: string,
  beatId: string,
): Promise<ClaimResult> {
  return withPrivilegedDb(orgId, "demo-world-claim", async (tx) => {
    const staleBefore = new Date(Date.now() - WORLD_CLAIM_STALE_MS).toISOString()
    const superseded = drizzleSql`CASE WHEN m.run_started_at IS NULL
        THEN m.claimed_at < EXCLUDED.run_started_at
        ELSE m.run_started_at <> EXCLUDED.run_started_at END`
    const [claimed] = extractRows<{ generation: number }>(
      await tx.execute(
        drizzleSql`INSERT INTO ${K()}.demo_world_marks AS m
            (org_id, tour_id, beat_id, state, run_started_at)
          SELECT ${orgId}::uuid, ${tourId}, ${beatId}, 'claimed', tp.started_at
            FROM ${K()}.tour_progress tp
            WHERE tp.org_id = ${orgId}::uuid AND tp.user_id = ${ownerUserId}::uuid
              AND tp.tour_id = ${tourId}
          ON CONFLICT (org_id, tour_id, beat_id) DO UPDATE SET
            state = 'claimed',
            claimed_at = now(),
            generation = m.generation + CASE WHEN ${superseded} THEN 1 ELSE 0 END,
            run_started_at = EXCLUDED.run_started_at
          WHERE ${superseded}
             OR (m.state = 'claimed' AND m.claimed_at < ${staleBefore}::timestamptz)
          RETURNING m.generation`,
      ),
    )
    if (claimed) return { state: "claimed", generation: claimed.generation }
    const [existing] = await tx
      .select({ state: demoWorldMarks.state, generation: demoWorldMarks.generation })
      .from(demoWorldMarks)
      .where(
        and(
          eq(demoWorldMarks.orgId, orgId),
          eq(demoWorldMarks.tourId, tourId),
          eq(demoWorldMarks.beatId, beatId),
        ),
      )
      .limit(1)
    return existing?.state === "succeeded"
      ? { state: "succeeded", generation: existing.generation }
      : { state: "busy", generation: null }
  })
}

/**
 * Settle this pass's claim (its generation: a pass of an earlier run never
 * settles the mark a newer run claimed). A release leaves the row as a stale
 * claim, so the retry reclaims it for the same run and generation.
 */
async function settleMark(
  orgId: string,
  tourId: string,
  beatId: string,
  generation: number,
  outcome: "succeeded" | "released",
): Promise<void> {
  const key = and(
    eq(demoWorldMarks.orgId, orgId),
    eq(demoWorldMarks.tourId, tourId),
    eq(demoWorldMarks.beatId, beatId),
    eq(demoWorldMarks.generation, generation),
    eq(demoWorldMarks.state, "claimed"),
  )
  await withPrivilegedDb(orgId, "demo-world-settle", async (tx) => {
    if (outcome === "succeeded") {
      await tx.update(demoWorldMarks).set({ state: "succeeded" }).where(key)
    } else {
      await tx.update(demoWorldMarks).set({ claimedAt: drizzleSql`to_timestamp(0)` }).where(key)
    }
  })
}

/** The owner's current beat in `tourId`, when it is a world beat with a registered injector. */
async function currentWorldBeat(
  target: WorldBeatTarget,
): Promise<{ beatId: string; injector: WorldInjector; runStartedAt: Date } | null> {
  const tour = findServerTour(target.tourId)
  if (!tour) return null
  const row = await withPrivilegedDb(target.orgId, "demo-world-read", (tx) =>
    readProgressRow(tx, {
      orgId: target.orgId,
      userId: target.ownerUserId,
      tourId: target.tourId,
    }),
  )
  if (!row || row.status !== "active") return null
  const beats = tourBeats(tour, await loadTourOrgContext(target.orgId))
  const beat = beats[currentIndex(beats, row)]
  if (beat?.kind !== "world" || !beat.injector) return null
  // Its live event already came in this run: the person is reading it.
  if (beatArrived(beat, row.beatStates)) return null
  const injector = injectors().get(beat.injector)
  if (!injector) {
    log.warn({ tourId: target.tourId, injector: beat.injector }, "World beat names no injector")
    return null
  }
  return { beatId: beat.id, injector, runStartedAt: row.startedAt }
}

/** One pass, with its outcome. Throws only on infrastructure errors (callers catch). */
export async function runWorldBeatOnce(
  orgId: string,
  ownerUserId: string,
  tourId: string,
): Promise<WorldBeatOutcome> {
  // The guard first, from the database marker: a VISITOR demo org (never the
  // reserved review org), or nothing below reads or writes.
  if (!(await isVisitorDemoOrgId(orgId))) return "not_demo"
  const target = { orgId, ownerUserId, tourId }
  const current = await currentWorldBeat(target)
  if (!current) return "no_world_beat"
  const { beatId, injector, runStartedAt } = current
  // An injector of one world never writes into a workspace of another.
  if (injector.world !== undefined && injector.world !== demoWorldOf(await loadDemoMarker(orgId))) {
    log.warn(
      { tourId, injector: injector.id, world: injector.world },
      "World beat injector refused outside its world",
    )
    return "other_world"
  }

  const claim = await claimMark(orgId, ownerUserId, tourId, beatId)
  if (claim.state === "busy") return "busy"
  const generation = claim.generation
  const ctx: WorldInjectorContext = {
    orgId,
    ownerUserId,
    tourId,
    beatId,
    run: generation,
    runStartedAt,
  }
  const entityOf = async () => (injector.entityOf ? await injector.entityOf(ctx) : null)
  if (claim.state === "succeeded") {
    // It ran on an earlier pass of this run: complete the beat, inject nothing.
    await advancePastWorldBeat(target, beatId, runStartedAt, await entityOf())
    return "replayed"
  }

  if (
    injector.spends &&
    (await worldBeatSpendsBoxKey(orgId)) &&
    !(await demoVerifiedIdentity(orgId))
  ) {
    await settleMark(orgId, tourId, beatId, generation, "released")
    await pushGate(target, "verify")
    return "gated"
  }

  try {
    await injector.injectWorldEvent(ctx)
  } catch (err) {
    log.warn({ err, orgId, tourId, beatId, injector: injector.id }, "World beat injector failed")
    await settleMark(orgId, tourId, beatId, generation, "released")
    await pushGate(target, gateForError(err))
    return "failed"
  }
  await settleMark(orgId, tourId, beatId, generation, "succeeded")
  await advancePastWorldBeat(target, beatId, runStartedAt, await entityOf())
  return "completed"
}

// ── `do` beats the visitor already did ─────────────────────────────────────

/**
 * A scenario `do` beat whose outcome may already hold when the beat comes up:
 * the visitor switched the prospect routine on earlier. Its event (an enable)
 * then never comes, and its autoplay never flips a toggle that is already on,
 * so the beat is completed here as soon as it is current, recording the entity
 * its event would have named (the routine): a later beat bound to it (the
 * routine's run, `{enable}`) then matches as if the event had come.
 */
const ALREADY_DONE: ReadonlyArray<{
  tourId: string
  beatId: string
  /** The entity the beat's event would have named when the outcome holds, else null. */
  holds(orgId: string): Promise<string | null>
}> = [
  {
    tourId: "kernel.scenario-sales",
    beatId: "enable",
    holds: (orgId) =>
      withPrivilegedDb(orgId, "demo-world-routine-enabled", async (tx) => {
        const [row] = await tx
          .select({ id: routines.id })
          .from(routines)
          .where(
            and(
              eq(routines.orgId, orgId),
              eq(routines.name, PROSPECT_ROUTINE_NAME),
              eq(routines.enabled, true),
            ),
          )
          .limit(1)
        return row?.id ?? null
      }),
  },
]

/**
 * Complete the owner's current `do` beat in `tourId` when what it asks for is
 * already done (see ALREADY_DONE). True when it moved the row. Visitor demo
 * orgs only; never throws.
 */
export async function completeAlreadyDoneBeat(
  orgId: string,
  ownerUserId: string,
  tourId: string,
): Promise<boolean> {
  try {
    const checks = ALREADY_DONE.filter((c) => c.tourId === tourId)
    if (checks.length === 0) return false
    if (!(await isVisitorDemoOrgId(orgId))) return false
    const tour = findServerTour(tourId)
    if (!tour) return false
    const beats = tourBeats(tour, await loadTourOrgContext(orgId))
    const key = { orgId, userId: ownerUserId, tourId }
    const row = await withPrivilegedDb(orgId, "demo-world-read", (tx) => readProgressRow(tx, key))
    if (!row || row.status !== "active") return false
    const beat = beats[currentIndex(beats, row)]
    const check = checks.find((c) => c.beatId === beat?.id)
    if (!check || beat?.kind !== "do") return false
    const entityId = await check.holds(orgId)
    if (entityId === null) return false
    const move = completeDoBeat(beats, row, entityId)
    if (!move) return false
    if (move.target?.kind === "world") await assertWorldBeatAllowed(orgId)
    const written = await withPrivilegedDb(orgId, "demo-world-done-beat", (tx) =>
      writeTourMove(tx, {
        orgId,
        userId: ownerUserId,
        tour,
        beats,
        from: row,
        next: move.next,
        actor: { userId: ownerUserId, actorType: "system" },
      }),
    )
    return written !== null
  } catch (err) {
    log.warn({ err, orgId, tourId }, "Completing an already-done beat failed")
    return false
  }
}

/**
 * Run the world beat `ownerUserId` is on in `tourId`, if their current beat is
 * one. Never throws.
 */
export async function runWorldBeat(
  orgId: string,
  ownerUserId: string,
  tourId: string,
): Promise<void> {
  try {
    await runWorldBeatOnce(orgId, ownerUserId, tourId)
  } catch (err) {
    log.error({ err, orgId, tourId }, "World beat pass failed")
  }
}

/**
 * Re-run the world beat of each of the owner's active tours, after something
 * that held it back changed (the visitor confirmed their email). Never throws.
 */
export async function resumeWorldBeats(orgId: string, ownerUserId: string): Promise<void> {
  try {
    if (!(await isVisitorDemoOrgId(orgId))) return
    const rows = await withPrivilegedDb(orgId, "demo-world-resume", (tx) =>
      tx
        .select({ tourId: tourProgress.tourId })
        .from(tourProgress)
        .where(
          and(
            eq(tourProgress.orgId, orgId),
            eq(tourProgress.userId, ownerUserId),
            eq(tourProgress.status, "active"),
          ),
        ),
    )
    for (const row of rows) await runWorldBeat(orgId, ownerUserId, row.tourId)
  } catch (err) {
    log.error({ err, orgId }, "Resuming world beats failed")
  }
}

/**
 * Test seam (NODE_ENV=test only): stand a fake in for a registered injector,
 * so the registry's guard, mark and gate logic is tested without the world an
 * injector writes into. Returns the restore.
 */
export const WorldRegistryTestAccess = {
  override(id: string, injector: WorldInjector): () => void {
    if (env.NODE_ENV !== "test") throw new Error("WorldRegistryTestAccess is for tests only")
    const prior = injectors().get(id)
    injectors().set(id, injector)
    return () => {
      if (prior) injectors().set(id, prior)
      else injectors().delete(id)
    }
  },
}
