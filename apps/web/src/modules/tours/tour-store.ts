// SPDX-License-Identifier: FSL-1.1-ALv2
/**
 * Tour engine state. Progress is the server's (per user, survives reload and
 * device change); this store only mirrors it and keeps the per-session UI
 * bits (a beat the person said they would do, autoplay, the completion card).
 *
 * One tour on screen at a time: the active one as the panel, else the most
 * recently paused one as the chip, never both.
 */
import {
  createdEntityIds,
  type EffectiveBeat,
  effectiveBeats,
  isTourFrameFresh,
  resolveBeatAnchor,
  TOUR_FEATURES,
  type Tour,
  type TourBeatGate,
  TourFrameDataSchema,
  type TourListItem,
  type TourProgress,
  type TourSource,
  type UpdateTourRequest,
} from "@liaison/shared"
import { createStore, produce } from "solid-js/store"
import { subscribeResync } from "~/framework/resync"
import { onSessionTeardown } from "~/lib/session-lifecycle"
import { tourCompletedCardHolds } from "./beat-gates"
import type { TourApi } from "./tour-api"
import { resolveTour } from "./tour-catalog"

export type TourView = "panel" | "chip" | "completed" | null

/**
 * `agentFailed`: the agent turn a beat waits on failed (no model, provider error).
 * `agentAnswered`: the agent's turn a beat waits on ended without the beat's
 * event (it answered without doing the step): the panel says so.
 * `agentWaiting`: a played beat's event has not come after a bounded wait (the
 * agent asked a question back, or is still working): the panel says so.
 * `working`: play-all waits on what the beat waits on (`beatWaitsOn`: the
 * agent's answer, a routine's run, a replay), sized to it, and says so.
 */
export type AutoplayStatus =
  | "idle"
  | "playing"
  | "takeover"
  | "failed"
  | "refused"
  | "agentFailed"
  | "agentAnswered"
  | "agentWaiting"
  | "working"

/**
 * The turn an `agentFailed` step waited on: where it failed and why. From the
 * server's step status (`agent-failed`) it also names the person's message
 * that got no answer and what it asked (Try again sends it again), and a
 * refusal's code.
 */
export interface FailedTurn {
  threadId: string
  message: string
  code?: string | null
  askId?: string
  question?: string
}

interface TourState {
  items: TourListItem[]
  itemsLoaded: boolean
  current: TourProgress | null
  /** The tour that just completed in this session (shown once). */
  completed: TourProgress | null
  /** Beat the person chose "I'll do it" on: the panel shows it is waiting. */
  selfDoingBeatId: string | null
  /**
   * Beat whose Do it for me is spent: the tour played its script (the request
   * went out, the approval was pressed). Its panel offers nothing to press,
   * and a press there does nothing (walk D78).
   */
  spentBeatId: string | null
  /**
   * Beat on screen a frame said the server already moved past, while the next
   * step is still being read: nothing to say or press on it (walk D78).
   */
  passedBeatId: string | null
  /** "Play whole scenario": every remaining beat plays by itself. */
  playAll: boolean
  autoplay: {
    status: AutoplayStatus
    beatId: string | null
    /** The testid a failed step could not find, or a refused step's guard was on. */
    missing: string | null
    /** `agentFailed`: the conversation and error of the turn that failed (its refusal line may name a gate). */
    turn?: FailedTurn | null
  }
  /**
   * Why the current world beat waits, from the last `kernel:tour` frame that
   * said so (`gate`), for that tour and beat only.
   */
  gate: { tourId: string; beatId: string | null; gate: TourBeatGate } | null
  /** i18n key of the last failed request, shown in the panel. */
  error: string | null
  busy: boolean
  /**
   * A tour about to come on screen: a start or resume in flight, or the deep
   * link (`/?tour=<id>`) read on boot before the catalogue has loaded. What
   * offers something else on load (the demo's scenario list) waits for it.
   */
  starting: string | null
}

const initial = (): TourState => ({
  items: [],
  itemsLoaded: false,
  current: null,
  completed: null,
  selfDoingBeatId: null,
  spentBeatId: null,
  passedBeatId: null,
  playAll: false,
  autoplay: { status: "idle", beatId: null, missing: null },
  gate: null,
  error: null,
  busy: false,
  starting: null,
})

const [state, setState] = createStore<TourState>(initial())

let api: TourApi | null = null
let completedTimer: ReturnType<typeof setTimeout> | null = null

/**
 * How long the completion card stays before the panel closes to nothing,
 * unless what it offers next holds it (`registerTourCompletedAction`'s
 * `holds`: the demo's "Next: <scenario>" stays until the visitor acts).
 */
export const COMPLETED_CARD_MS = 6000

export function setTourApi(next: TourApi | null): void {
  api = next
}

/**
 * What a read tool answers the signed-in person, for a step's figures
 * (`EffectiveBeat.figures`). Null with no API, or when the API reads no tools.
 */
export async function readTourTool(tool: string, params: Record<string, unknown>) {
  return api?.readTool ? api.readTool(tool, params) : null
}

export function resetTourStore(): void {
  if (completedTimer) clearTimeout(completedTimer)
  completedTimer = null
  api = null
  setState(initial())
}

// Sign-out: the next person never inherits this one's tour on screen.
onSessionTeardown(resetTourStore)

// A resync (a WS reconnect, a sync frame): the `kernel:tour` frames sent while
// the socket was away may be lost, so the tour on screen is read again.
subscribeResync(() => {
  const current = state.current
  if (api && current) void refresh(current.tourId)
})

function latest(items: TourListItem[], status: TourProgress["status"]): TourProgress | null {
  let best: TourProgress | null = null
  for (const item of items) {
    const p = item.progress
    if (!p || p.status !== status) continue
    if (!resolveTour(p.tourId)) continue
    if (!best || p.updatedAt > best.updatedAt) best = p
  }
  return best
}

function upsertItem(progress: TourProgress): void {
  setState(
    "items",
    (item) => item.tourId === progress.tourId,
    produce((item) => {
      item.progress = progress
    }),
  )
}

function resetBeatUi(): void {
  setState("gate", null)
  setState("selfDoingBeatId", null)
  setState("spentBeatId", null)
  setState("passedBeatId", null)
  setState("autoplay", { status: "idle", beatId: null, missing: null })
}

/**
 * A read of the tour on screen older than what it shows: reads cross (a frame's
 * refetch, a Next, a resync), and the slower one must never move the panel
 * back onto a beat the server already left (walk D28).
 */
function olderThanShown(progress: TourProgress): boolean {
  const prev = state.current
  if (!prev || prev.tourId !== progress.tourId) return false
  const shown = Date.parse(prev.updatedAt)
  const read = Date.parse(progress.updatedAt)
  return Number.isFinite(shown) && Number.isFinite(read) && read < shown
}

/** Mirror one tour's server progress into the store. */
export function applyProgress(tourId: string, progress: TourProgress | null): void {
  const prev = state.current
  if (progress && olderThanShown(progress)) return
  if (progress) upsertItem(progress)
  if (!progress) {
    if (prev?.tourId === tourId) setState("current", null)
    return
  }
  if (!resolveTour(progress.tourId)) return
  switch (progress.status) {
    case "active": {
      if (prev?.tourId !== progress.tourId || prev.beatId !== progress.beatId) {
        resetBeatUi()
      }
      if (prev?.tourId !== progress.tourId) setState("playAll", false)
      setState("completed", null)
      setState("current", progress)
      return
    }
    case "paused": {
      // A paused tour never replaces another tour's open panel.
      if (prev && prev.tourId !== progress.tourId && prev.status === "active") return
      resetBeatUi()
      setState("playAll", false)
      setState("current", progress)
      return
    }
    case "completed": {
      if (prev?.tourId !== progress.tourId) return
      resetBeatUi()
      setState("playAll", false)
      setState("current", null)
      setState("completed", progress)
      if (completedTimer) clearTimeout(completedTimer)
      completedTimer = null
      // A card offering what comes next is the visitor's prompt to go on: it
      // stays until they act on it or close it.
      const tour = resolveTour(progress.tourId)
      if (tour && tourCompletedCardHolds(tour)) return
      completedTimer = setTimeout(() => {
        completedTimer = null
        setState("completed", null)
      }, COMPLETED_CARD_MS)
      return
    }
    case "abandoned": {
      if (prev?.tourId !== progress.tourId) return
      resetBeatUi()
      setState("playAll", false)
      setState("current", null)
      return
    }
  }
}

async function run<T>(fn: (client: TourApi) => Promise<T>): Promise<T | undefined> {
  if (!api) return undefined
  setState("busy", true)
  setState("error", null)
  try {
    return await fn(api)
  } catch {
    setState("error", "tours.engine.requestFailed")
    return undefined
  } finally {
    setState("busy", false)
  }
}

/** Load the catalogue and put the tour in progress (if any) back on screen. */
async function load(): Promise<void> {
  const items = await run((c) => c.list())
  if (!items) return
  setState("items", items)
  setState("itemsLoaded", true)
  if (state.current?.status === "active") return
  const pick = latest(items, "active") ?? latest(items, "paused")
  if (pick) applyProgress(pick.tourId, pick)
}

async function refreshList(): Promise<void> {
  const items = await run((c) => c.list())
  if (!items) return
  setState("items", items)
  setState("itemsLoaded", true)
}

async function refresh(tourId: string): Promise<void> {
  const progress = await run((c) => c.progress(tourId))
  if (progress === undefined) return
  applyProgress(tourId, progress)
}

async function update(body: UpdateTourRequest): Promise<void> {
  const current = state.current
  if (!current) return
  const progress = await run((c) => c.update(current.tourId, body))
  if (progress === undefined) return
  applyProgress(current.tourId, progress)
}

/** Start (or restart) a tour; a tour already open is paused first. */
async function start(tourId: string, source: TourSource): Promise<void> {
  setState("starting", tourId)
  try {
    const current = state.current
    if (current && current.tourId !== tourId && current.status === "active") {
      await update({ status: "paused" })
    }
    const progress = await run((c) => c.start(tourId, source))
    if (progress === undefined) return
    applyProgress(tourId, progress)
  } finally {
    if (state.starting === tourId) setState("starting", null)
  }
}

/** Resume a paused tour, start one that is new, done or abandoned. */
async function resume(tourId: string, source: TourSource = "help"): Promise<void> {
  setState("starting", tourId)
  try {
    await resumeTour(tourId, source)
  } finally {
    if (state.starting === tourId) setState("starting", null)
  }
}

async function resumeTour(tourId: string, source: TourSource): Promise<void> {
  const item = state.items.find((i) => i.tourId === tourId)
  const progress = state.current?.tourId === tourId ? state.current : (item?.progress ?? null)
  if (progress?.status === "active" && state.current?.tourId === tourId) return
  if (progress?.status === "paused" || progress?.status === "active") {
    const other = state.current
    if (other && other.tourId !== tourId && other.status === "active") {
      await update({ status: "paused" })
    }
    const next = await run((c) => c.update(tourId, { status: "active" }))
    if (next !== undefined) applyProgress(tourId, next)
    return
  }
  await start(tourId, source)
}

/**
 * A `kernel:tour` frame. Never trusted as state: it only says "this tour's
 * progress changed", so the store refetches it. Stale replays and another
 * user's frames are ignored.
 */
function onFrame(data: unknown, currentUserId: string): void {
  const parsed = TourFrameDataSchema.safeParse(data)
  if (!parsed.success) return
  if (parsed.data.ownerUserId !== currentUserId) return
  if (!isTourFrameFresh(parsed.data)) return
  const { gate, tourId, beatId } = parsed.data
  if (gate) {
    // A held-back world beat: nothing moved, the panel says why.
    setState("gate", { tourId, beatId, gate })
    return
  }
  // The step on screen is already behind the server (it completed, or the
  // tour did): nothing more to press on it while the next one is read.
  const current = state.current
  if (
    current?.tourId === tourId &&
    current.beatId !== null &&
    (parsed.data.status === "completed" ||
      (parsed.data.status === "active" && parsed.data.beatIndex > current.beatIndex))
  ) {
    setState("passedBeatId", current.beatId)
  }
  void refresh(parsed.data.tourId).finally(() => {
    // The read did not move the step after all (a failed read, a frame out of
    // order): the step is the person's again rather than stuck with nothing.
    if (state.passedBeatId !== null && state.passedBeatId === state.current?.beatId) {
      setState("passedBeatId", null)
    }
  })
  if (state.itemsLoaded) void refreshList()
}

function view(): TourView {
  if (state.completed) return "completed"
  const current = state.current
  if (!current) return null
  return current.status === "active" ? "panel" : current.status === "paused" ? "chip" : null
}

function currentTour(): Tour | undefined {
  const current = state.current ?? state.completed
  return current ? resolveTour(current.tourId) : undefined
}

/** The beat on screen, phone overrides applied when `phone`. */
function currentBeat(phone: boolean): EffectiveBeat | undefined {
  const current = state.current
  if (!current || current.beatId === null) return undefined
  return beatOfCurrentTour(current.beatId, phone)
}

/** A beat of the tour in progress by id, phone overrides applied when `phone`. */
function beatOfCurrentTour(beatId: string, phone: boolean): EffectiveBeat | undefined {
  const current = state.current
  const tour = currentTour()
  if (!current || !tour) return undefined
  // The server already chose the beat from the org's effective list; resolve
  // it from the full definition so only the phone overrides apply here.
  const allApps = tour.beats.flatMap((b) => (b.optional?.whenApp ? [b.optional.whenApp] : []))
  const beat = effectiveBeats(tour, {
    installedApps: allApps,
    isDemo: true,
    // The server only runs a tour the org's world is offered; its own world is the context here.
    worldId: tour.world,
    features: TOUR_FEATURES,
    phone,
  }).find((b) => b.id === beatId)
  if (!beat) return beat
  const created = createdEntityIds(current.beatStates)
  // An anchor naming what an earlier beat recorded points at that very entity;
  // until it is recorded, at nothing (the template matches no element). So
  // do the hops of the way to it (`path`: the row that opens it).
  const anchor = beat.anchorPinned ? resolveBeatAnchor(beat.anchor, created) : null
  const path = beat.path?.map((hop) => {
    const resolved = hop.anchor ? resolveBeatAnchor(hop.anchor, created) : null
    return resolved ? { ...hop, anchor: resolved } : hop
  })
  if (!anchor && !path) return beat
  return { ...beat, ...(anchor ? { anchor } : {}), ...(path ? { path } : {}) }
}

export const tourStore = {
  get items() {
    return state.items
  },
  get itemsLoaded() {
    return state.itemsLoaded
  },
  get current() {
    return state.current
  },
  get completed() {
    return state.completed
  },
  get selfDoingBeatId() {
    return state.selfDoingBeatId
  },
  get spentBeatId() {
    return state.spentBeatId
  },
  get passedBeatId() {
    return state.passedBeatId
  },
  get playAll() {
    return state.playAll
  },
  get autoplay() {
    return state.autoplay
  },
  get error() {
    return state.error
  },
  /** The gate on the current beat, if the last frame for it carried one. */
  get gate(): TourBeatGate | null {
    const g = state.gate
    const current = state.current
    if (!g || !current || g.tourId !== current.tourId || g.beatId !== current.beatId) return null
    return g.gate
  },
  clearGate: () => setState("gate", null),
  get busy() {
    return state.busy
  },
  /** A tour about to come on screen (a start, a resume, a deep link read on boot). */
  get starting() {
    return state.starting
  },
  /**
   * A tour will be started once the catalogue is loaded (the deep link read
   * on boot): nothing else is offered over it meanwhile. Cleared by that
   * start, or by `expectStart(null)` when it turns out not to be offered.
   */
  expectStart: (tourId: string | null) => setState("starting", tourId),
  view,
  currentTour,
  currentBeat,
  beatOfCurrentTour,
  load,
  refreshList,
  refresh,
  start,
  resume,
  onFrame,
  next: () => update({ advance: true, fromBeatId: state.current?.beatId ?? undefined }),
  skip: () => update({ skip: true, fromBeatId: state.current?.beatId ?? undefined }),
  pause: () => update({ status: "paused" }),
  end: () => update({ status: "abandoned" }),
  dismissCompleted: () => {
    if (completedTimer) clearTimeout(completedTimer)
    completedTimer = null
    setState("completed", null)
  },
  /** "I'll do it": the panel waits for the event; a stopped autoplay's line goes. */
  doItMyself: () => {
    const beatId = state.current?.beatId ?? null
    setState("selfDoingBeatId", beatId)
    if (state.autoplay.beatId === beatId && state.autoplay.status !== "playing") {
      setState("autoplay", { status: "idle", beatId, missing: null })
    }
  },
  /** The tour played this beat's script: its Do it for me is spent (`spentBeatId`). */
  spend: (beatId: string) => {
    if (state.current?.beatId === beatId) setState("spentBeatId", beatId)
  },
  setPlayAll: (on: boolean) => setState("playAll", on),
  setAutoplay: (
    status: AutoplayStatus,
    beatId: string | null,
    missing: string | null = null,
    turn: FailedTurn | null = null,
  ) => setState("autoplay", { status, beatId, missing, turn }),
}
