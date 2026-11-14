// SPDX-License-Identifier: FSL-1.1-ALv2
/**
 * Guided tour progress (kernel.tour_progress, migration 0174).
 *
 * One row per (org, user, tour). The row stores the current beat by ID; its
 * index is re-derived from `effectiveBeats` (packages/shared/src/tours) on
 * every read, so a beat appearing or disappearing (an app installed mid-tour)
 * never moves the person onto another beat. Every change queues a
 * `kernel/tour:start` or `kernel/tour:update` frame (TourFrameData) for the
 * owner's sockets only (infra/websocket.ts OWNER_ONLY_NODE_ENTITIES).
 *
 * Callers: the routes (the person's own row, under RLS), the completion
 * consumer and the CLI (privileged). Both connection kinds go through the same
 * functions here, which take whichever client the caller holds.
 */

import {
  beatArrived,
  beatArrives,
  beatIndexOf,
  beatOutcome,
  type DemoWorldId,
  type EffectiveBeat,
  effectiveBeats,
  findTour,
  isTourAvailable,
  RUN_CONVERSATION,
  TOUR_WS_ENTITY,
  type Tour,
  type TourBeatGate,
  type TourBeatState,
  type TourFeature,
  type TourFrameData,
  type TourProgress,
  type TourSource,
  type TourStatus,
  tourCatalogue,
  type UpdateTourRequest,
} from "@liaison/shared"
import { and, eq, isNull, notInArray, sql } from "drizzle-orm"
import type { RlsClient } from "~/db"
import { type TourProgressRow, tourProgress } from "~/db/schema/kernel"
import type { AppEvent } from "~/infra/events/event-bus"
import { env } from "~/lib/env"
import { listInstalledAppNames } from "~/modules/apps/app-registries"
import { customerLookupConfigured } from "~/modules/apps/connections/api/customer"
import { apiConnectionsOf } from "~/modules/apps/connections/api/declarations"
import { ensureAppsForOrg } from "~/modules/apps/init"
import { isDemoEgressRestricted } from "~/modules/demo/demo-egress"
import { demoWorldOf, isVisitorDemoOrgId, loadDemoMarker } from "~/modules/demo/demo-org"
import { hasScope } from "~/modules/permissions/permissions"
import { routineRaisedNothingFor } from "~/modules/tours/beat-status"

/** The query surface both an RLS client and a privileged transaction offer. */
export type TourDb = Pick<RlsClient, "select" | "insert" | "update" | "queueEvent">

/** What decides a person's effective beats in an org. */
export interface TourOrgContext {
  installedApps: readonly string[]
  isDemo: boolean
  /** The demo world of the org (the default world outside a demo org). */
  worldId: DemoWorldId
  features: readonly TourFeature[]
}

/** Shipped tours, plus the test fixtures under NODE_ENV=test (shared registry contract). */
export function serverTourCatalogue(): readonly Tour[] {
  return tourCatalogue({ includeTestTours: env.NODE_ENV === "test" })
}

export function findServerTour(tourId: string): Tour | undefined {
  return findTour(tourId, { includeTestTours: env.NODE_ENV === "test" })
}

export async function loadTourOrgContext(orgId: string): Promise<TourOrgContext> {
  await ensureAppsForOrg(orgId)
  const installedApps = listInstalledAppNames(orgId)
  // An app that declares an API connection (declarations.ts), whatever its name.
  const connector = apiConnectionsOf(orgId).length > 0
  const [marker, customerCard, connectorReadOnly] = await Promise.all([
    loadDemoMarker(orgId),
    connector ? customerLookupConfigured(orgId) : false,
    // The page a demo org shows is read-only (api-connector routes, `readOnly`).
    connector ? isDemoEgressRestricted(orgId) : true,
  ])
  const features: TourFeature[] = []
  if (customerCard) features.push("customer-card")
  if (connector && !connectorReadOnly) features.push("connector-add")
  return { installedApps, isDemo: marker !== null, worldId: demoWorldOf(marker), features }
}

/**
 * Tours this caller can be offered. `isTourAvailable` matches scopes exactly,
 * while a held scope grants its children (`projects:tasks` covers
 * `projects:tasks:read`), so every required scope the caller covers
 * hierarchically is added to the set it reads.
 */
export function availableTours(
  tours: readonly Tour[],
  ctx: {
    installedApps: readonly string[]
    scopes: readonly string[]
    isDemo?: boolean
    worldId?: DemoWorldId
  },
): Tour[] {
  const held = [...ctx.scopes]
  return tours.filter((tour) => {
    const covered = (tour.requires?.scopes ?? []).filter((s) => hasScope(s, held))
    return isTourAvailable(tour, {
      installedApps: ctx.installedApps,
      scopes: [...held, ...covered],
      isDemo: ctx.isDemo,
      worldId: ctx.worldId,
    })
  })
}

export function tourBeats(tour: Tour, ctx: TourOrgContext): EffectiveBeat[] {
  return effectiveBeats(tour, {
    installedApps: ctx.installedApps,
    isDemo: ctx.isDemo,
    worldId: ctx.worldId,
    features: ctx.features,
  })
}

/** The state a move reads and writes (the progress row minus its keys). */
export interface TourState {
  status: TourStatus
  beatId: string | null
  beatIndex: number
  beatStates: Record<string, TourBeatState>
}

/**
 * Index of the current beat. Completed is past the end. A beat that left the
 * effective list (its app was uninstalled) is replaced by the beat now at the
 * stored index, so the person always stands on a real beat.
 */
export function currentIndex(beats: readonly EffectiveBeat[], state: TourState): number {
  if (state.status === "completed") return beats.length
  const found = beatIndexOf(beats, state.beatId)
  if (found >= 0) return found
  return Math.min(state.beatIndex, Math.max(beats.length - 1, 0))
}

export function progressOf(
  tour: Tour,
  row: TourProgressRow,
  beats: readonly EffectiveBeat[],
): TourProgress {
  const index = currentIndex(beats, row)
  return {
    tourId: tour.id,
    status: row.status,
    beatId: row.status === "completed" ? null : (beats[index]?.id ?? null),
    beatIndex: index,
    beatCount: beats.length,
    beatStates: row.beatStates,
    source: row.source,
    startedAt: row.startedAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  }
}

/** The beats a completed tour skipped (the CLI's "completed, skipped k"). */
export function skippedCount(progress: Pick<TourProgress, "beatStates">): number {
  return Object.values(progress.beatStates).filter((s) => beatOutcome(s) === "skipped").length
}

// ── moves (pure) ───────────────────────────────────────────────────────────

export type TourMoveRefusal =
  | "tour_not_active"
  | "tour_finished"
  | "tour_event_beat"
  | "tour_forward_move"
  | "tour_empty"

export type TourMove =
  | { ok: true; next: TourState; target: EffectiveBeat | null }
  | { ok: false; code: TourMoveRefusal }

/**
 * A beat that approves a held write (`whenHeld`) when that write ran at once:
 * nothing waits for approval, so the run goes straight past it.
 */
export function notHeld(beat: EffectiveBeat, beatStates: TourState["beatStates"]): boolean {
  if (beat.whenHeld === undefined) return false
  const state = beatStates[beat.whenHeld]
  return !(typeof state === "object" && state.held === true)
}

/**
 * Record that an arriving beat's moment came (`beatArrives`: a live event, the
 * agent's or a routine's work), staying on it: the person reads it and moves
 * on with Next. Null when it was recorded already (a second delivery).
 */
function arriveAt(
  beat: EffectiveBeat,
  state: TourState,
  index: number,
  mark: TourBeatState,
): (TourMove & { ok: true }) | null {
  if (beatArrived(beat, state.beatStates)) return null
  return {
    ok: true,
    next: {
      ...state,
      beatId: beat.id,
      beatIndex: index,
      beatStates: { ...state.beatStates, [beat.id]: mark },
    },
    target: beat,
  }
}

/** Move to the beat after `from` (marking `from` with `mark`), completing past the end. */
function stepFrom(
  beats: readonly EffectiveBeat[],
  state: TourState,
  from: number,
  mark: TourBeatState,
): TourMove {
  const current = beats[from]
  const beatStates = current ? { ...state.beatStates, [current.id]: mark } : state.beatStates
  let to = from + 1
  // A beat whose moment already came (a routine's note that landed while the
  // person was on an earlier beat) is still shown, to be read: never passed.
  while (to < beats.length && notHeld(beats[to]!, beatStates)) {
    to += 1
  }
  if (to >= beats.length) {
    return {
      ok: true,
      next: { status: "completed", beatId: null, beatIndex: beats.length, beatStates },
      target: null,
    }
  }
  const target = beats[to]!
  return {
    ok: true,
    next: { status: "active", beatId: target.id, beatIndex: to, beatStates },
    target,
  }
}

/**
 * Pass the `whenRaised` steps the run is on, one after another, whose routine
 * finished without raising their request (`unraised`, the database's answer):
 * each is recorded skipped and the run moves to the next step, as `whenHeld`
 * steps are passed when nothing was held. A step whose request came, or whose
 * routine still works, stays.
 */
export async function passUnraisedBeats(
  beats: readonly EffectiveBeat[],
  state: TourState,
  unraised: (beat: EffectiveBeat, beatStates: TourState["beatStates"]) => Promise<boolean>,
): Promise<TourState> {
  let next = state
  while (next.status === "active") {
    const index = currentIndex(beats, next)
    const beat = beats[index]
    if (!beat?.whenRaised || next.beatStates[beat.id] !== undefined) break
    if (!(await unraised(beat, next.beatStates))) break
    const move = stepFrom(beats, next, index, "skipped")
    if (!move.ok) break
    next = move.next
  }
  return next
}

/**
 * Apply one PATCH intent to a tour's state, against the caller's effective
 * beats. Clamped to the list; never lands outside it. The caller checks the
 * world-beat guard on `target` before writing.
 */
export function applyTourMove(
  beats: readonly EffectiveBeat[],
  state: TourState,
  request: UpdateTourRequest,
): TourMove {
  if (beats.length === 0) return { ok: false, code: "tour_empty" }
  const index = currentIndex(beats, state)
  const finished = state.status === "completed" || state.status === "abandoned"
  const here = (status: TourStatus): TourMove => ({
    ok: true,
    next: { ...state, status, beatId: beats[index]?.id ?? null, beatIndex: index },
    target: beats[index] ?? null,
  })
  if (request.status !== undefined) {
    if (finished) return { ok: false, code: "tour_finished" }
    return here(request.status)
  }
  if (request.advance) {
    if (state.status !== "active") return { ok: false, code: "tour_not_active" }
    const beat = beats[index]
    // Next is for show beats, and for a beat whose live event or someone
    // else's work arrived (kept as recorded): a do beat moves on its event.
    if (beat && beatArrived(beat, state.beatStates)) {
      return stepFrom(beats, state, index, state.beatStates[beat.id]!)
    }
    if (beat?.kind !== "show") return { ok: false, code: "tour_event_beat" }
    return stepFrom(beats, state, index, "done")
  }
  if (request.skip) {
    if (state.status !== "active") return { ok: false, code: "tour_not_active" }
    const beat = beats[index]
    // An arrived beat keeps what it recorded: later beats open that entity.
    const arrived = beat && beatArrived(beat, state.beatStates)
    return stepFrom(beats, state, index, arrived ? state.beatStates[beat.id]! : "skipped")
  }
  if (request.beatIndex !== undefined) {
    if (finished) return { ok: false, code: "tour_finished" }
    if (request.beatIndex > index) return { ok: false, code: "tour_forward_move" }
    const to = Math.max(0, Math.min(request.beatIndex, beats.length - 1))
    const target = beats[to]!
    return {
      ok: true,
      next: { ...state, beatId: target.id, beatIndex: to },
      target,
    }
  }
  return { ok: false, code: "tour_not_active" }
}

/**
 * The current `do` beat's product event happened: mark it done and move on
 * (completing past the end); a beat that waited on someone else's work stays,
 * to be read (`arriveAt`). Null when the current beat is not a `do` beat or
 * the tour is not active, so a late or duplicate event changes nothing.
 */
export function completeDoBeat(
  beats: readonly EffectiveBeat[],
  state: TourState,
  /** The entity the event named (kept so a later beat's autoplay can work on it). */
  entityId?: string,
  /** `held`: the event was the approval the beat's write parked as (`heldAs`). */
  opts: { held?: boolean } = {},
): (TourMove & { ok: true }) | null {
  if (state.status !== "active") return null
  const index = currentIndex(beats, state)
  const beat = beats[index]
  if (beat?.kind !== "do") return null
  const mark: TourBeatState = entityId
    ? opts.held
      ? { state: "done", entityId, held: true }
      : { state: "done", entityId }
    : "done"
  // A beat that approved a held write (`whenHeld`) records what that write made
  // on the beat that held it too: later steps pinned to that beat then work on
  // what the approved write created, as they would had it run at once.
  let from = state
  if (beat.whenHeld && entityId) {
    const made: TourBeatState = { state: "done", entityId }
    from = { ...state, beatStates: { ...state.beatStates, [beat.whenHeld]: made } }
  }
  // Someone else's work this step waited on (a routine's, the agent's): the
  // person reads it there, then Next.
  if (beatArrives(beat)) return arriveAt(beat, from, index, mark)
  const move = stepFrom(beats, from, index, mark)
  return move.ok ? move : null
}

/**
 * The current `world` beat's live event happened (its injector finished, or
 * finished on an earlier pass): mark it done and stay on it, so the person
 * reads what came in (`arriveAt`); Next moves on. Null when the current beat
 * is not a world beat, its event was recorded already, or the tour is not active.
 */
export function completeWorldBeat(
  beats: readonly EffectiveBeat[],
  state: TourState,
  /** What the live event brought into the org (a ticket, a task): later beats open it. */
  entityId?: string,
): (TourMove & { ok: true }) | null {
  if (state.status !== "active") return null
  const index = currentIndex(beats, state)
  const beat = beats[index]
  if (beat?.kind !== "world") return null
  return arriveAt(beat, state, index, entityId ? { state: "done", entityId } : "done")
}

// ── world-beat guard ──────────────────────────────────────────────────────

export class TourWorldBeatRefusedError extends Error {
  readonly code = "tour_world_beat_refused"
  constructor(readonly orgId: string) {
    super("A world beat plays only in a demo org")
    this.name = "TourWorldBeatRefusedError"
  }
}

/**
 * The server-side guard every path that lands a person on a `world` beat, or
 * injects that beat's live event, calls first (the tour routes here, the demo
 * injectors). Reads the org's demo marker from the database, never a caller's
 * claim; throws outside a VISITOR demo org (the reserved review org included).
 */
export async function assertWorldBeatAllowed(orgId: string): Promise<void> {
  if (!(await isVisitorDemoOrgId(orgId))) throw new TourWorldBeatRefusedError(orgId)
}

/**
 * A single-run tour (`singleRun`) that was played, to its end or left: it does
 * not start again. Only the demo's Start over, which gives the visitor a fresh
 * workspace with no progress, plays it again.
 */
export class TourPlayedError extends Error {
  readonly code = "tour_played"
  constructor(readonly tourId: string) {
    super("This scenario was played once; Start over plays it again")
    this.name = "TourPlayedError"
  }
}

/** The statuses that make a single-run tour played. */
const PLAYED_STATUSES: readonly TourStatus[] = ["completed", "abandoned"]

/** Whether `row` is a played run of a single-run `tour`, which does not start again. */
export function isPlayedSingleRun(
  tour: Tour,
  row: Pick<TourProgressRow, "status"> | null,
): boolean {
  return tour.singleRun === true && row !== null && PLAYED_STATUSES.includes(row.status)
}

// ── persistence ────────────────────────────────────────────────────────────

export async function readProgressRow(
  db: TourDb,
  key: { orgId: string; userId: string; tourId: string },
): Promise<TourProgressRow | null> {
  const [row] = await db
    .select()
    .from(tourProgress)
    .where(
      and(
        eq(tourProgress.orgId, key.orgId),
        eq(tourProgress.userId, key.userId),
        eq(tourProgress.tourId, key.tourId),
      ),
    )
    .limit(1)
  return row ?? null
}

export async function listProgressRows(
  db: TourDb,
  key: { orgId: string; userId: string },
): Promise<TourProgressRow[]> {
  return db
    .select()
    .from(tourProgress)
    .where(and(eq(tourProgress.orgId, key.orgId), eq(tourProgress.userId, key.userId)))
}

/** Who caused a change, for the frame's event actor. */
export interface TourActor {
  userId: string | null
  actorType: NonNullable<AppEvent["actorType"]>
}

/** The `kernel/tour:*` frame for the owner's sockets (TourFrameData). */
export function tourFrameEvent(
  orgId: string,
  ownerUserId: string,
  progress: TourProgress,
  action: "start" | "update",
  actor: TourActor,
  /** A demo world beat held back: why (the panel renders it). */
  gate?: TourBeatGate,
): AppEvent {
  const data: TourFrameData = {
    ownerUserId,
    tourId: progress.tourId,
    status: progress.status,
    beatId: progress.beatId,
    beatIndex: progress.beatIndex,
    emittedAt: new Date().toISOString(),
    ...(gate ? { gate } : {}),
  }
  return {
    app: "kernel",
    entity: TOUR_WS_ENTITY,
    action,
    entityId: `${ownerUserId}:${progress.tourId}`,
    data,
    actorId: actor.userId,
    actorType: actor.actorType,
    orgId,
    timestamp: data.emittedAt,
  }
}

/**
 * Start (or restart) a tour for a person: the row is upserted back to the
 * first effective beat, active, with no beat states, and the owner's tabs are
 * told (`kernel/tour:start`). A tour that talks to the agent (`talksToAgent`)
 * records the person's DM with it, which the caller found
 * (`runConversationId`), as the run's `RUN_CONVERSATION`; it refuses to start
 * without one. A played single-run tour is refused (`TourPlayedError`) and
 * its row left as it is, even when another tab started it a moment before.
 */
export async function startTour(
  db: TourDb,
  input: {
    orgId: string
    userId: string
    tour: Tour
    beats: readonly EffectiveBeat[]
    source: TourSource
    actor: TourActor
    /** The person's DM with their agent (`talksToAgent` tours). */
    conversationId?: string
  },
): Promise<TourProgress> {
  const first = input.beats[0]
  // A demo scenario, or a tour opening on a live event, starts in a demo org only.
  if (input.tour.demoOnly || first?.kind === "world") await assertWorldBeatAllowed(input.orgId)
  if (input.tour.talksToAgent && !input.conversationId) {
    throw new Error(`Tour ${input.tour.id} starts only with the person's agent conversation`)
  }
  const beatStates: Record<string, TourBeatState> =
    input.tour.talksToAgent && input.conversationId
      ? { [RUN_CONVERSATION]: { state: "done", entityId: input.conversationId } }
      : {}
  const now = new Date()
  const values = {
    status: (first ? "active" : "completed") as TourStatus,
    beatId: first?.id ?? null,
    beatIndex: 0,
    beatStates,
    source: input.source,
    startedAt: now,
    updatedAt: now,
  }
  const [row] = await db
    .insert(tourProgress)
    .values({ orgId: input.orgId, userId: input.userId, tourId: input.tour.id, ...values })
    .onConflictDoUpdate({
      target: [tourProgress.orgId, tourProgress.userId, tourProgress.tourId],
      set: values,
      // Checked in the same statement as the write: a run another tab just
      // finished is never reset.
      ...(input.tour.singleRun
        ? { setWhere: notInArray(tourProgress.status, [...PLAYED_STATUSES]) }
        : {}),
    })
    .returning()
  if (!row) throw new TourPlayedError(input.tour.id)
  const progress = progressOf(input.tour, row, input.beats)
  await db.queueEvent(tourFrameEvent(input.orgId, input.userId, progress, "start", input.actor))
  return progress
}

export type TourUpdateOutcome =
  | { kind: "ok"; progress: TourProgress }
  | { kind: "not_found" }
  | { kind: "conflict"; progress: TourProgress }
  | { kind: "refused"; code: TourMoveRefusal }

/**
 * Write a move with a compare-and-set on the state it was computed from
 * (status + beat id): a concurrent move (another tab, the completion consumer)
 * makes this one a conflict instead of moving the person twice.
 */
export async function writeTourMove(
  db: TourDb,
  input: {
    orgId: string
    userId: string
    tour: Tour
    beats: readonly EffectiveBeat[]
    from: TourProgressRow
    next: TourState
    actor: TourActor
  },
): Promise<TourProgress | null> {
  const { from, next } = input
  const [row] = await db
    .update(tourProgress)
    .set({
      status: next.status,
      beatId: next.beatId,
      beatIndex: next.beatIndex,
      beatStates: next.beatStates,
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(tourProgress.orgId, input.orgId),
        eq(tourProgress.userId, input.userId),
        eq(tourProgress.tourId, input.tour.id),
        eq(tourProgress.status, from.status),
        from.beatId === null ? isNull(tourProgress.beatId) : eq(tourProgress.beatId, from.beatId),
        sql`${tourProgress.beatStates} = ${JSON.stringify(from.beatStates)}::jsonb`,
      ),
    )
    .returning()
  if (!row) return null
  const progress = progressOf(input.tour, row, input.beats)
  await db.queueEvent(tourFrameEvent(input.orgId, input.userId, progress, "update", input.actor))
  return progress
}

/** One PATCH from the person (routes): CAS guard, move, world-beat guard, write. */
export async function updateTour(
  db: TourDb,
  input: {
    orgId: string
    userId: string
    tour: Tour
    beats: readonly EffectiveBeat[]
    request: UpdateTourRequest
    actor: TourActor
  },
): Promise<TourUpdateOutcome> {
  const key = { orgId: input.orgId, userId: input.userId, tourId: input.tour.id }
  const row = await readProgressRow(db, key)
  if (!row) return { kind: "not_found" }
  const current = progressOf(input.tour, row, input.beats)
  if (input.request.fromBeatId !== undefined && input.request.fromBeatId !== current.beatId) {
    return { kind: "conflict", progress: current }
  }
  const move = applyTourMove(input.beats, row, input.request)
  if (!move.ok) return { kind: "refused", code: move.code }
  // A step this move lands on that its routine's run will never need is passed.
  const next = await passUnraisedBeats(input.beats, move.next, (beat, states) =>
    routineRaisedNothingFor(input.orgId, beat, states, row.startedAt),
  )
  const target =
    next === move.next ? move.target : (input.beats[currentIndex(input.beats, next)] ?? null)
  if (target?.kind === "world") await assertWorldBeatAllowed(input.orgId)
  const written = await writeTourMove(db, { ...input, from: row, next })
  if (written) return { kind: "ok", progress: written }
  const fresh = await readProgressRow(db, key)
  return fresh
    ? { kind: "conflict", progress: progressOf(input.tour, fresh, input.beats) }
    : { kind: "not_found" }
}
