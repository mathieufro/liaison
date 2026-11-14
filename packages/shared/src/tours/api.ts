// SPDX-License-Identifier: FSL-1.1-ALv2
/**
 * Wire contract of the tour routes and the `kernel:tour` websocket frame,
 * shared by the API (implements them) and the web engine (calls them).
 *
 *   GET   /api/tours               → ListToursResponse
 *   POST  /api/tours/:id/start     StartTourRequest  → TourProgressResponse
 *   PATCH /api/tours/:id           UpdateTourRequest → TourProgressResponse
 *   GET   /api/tours/:id/progress  → TourProgressResponse
 *
 * Progress is per (org, user, tour) and server-side. It stores the current
 * beat's ID; the index is re-derived from `effectiveBeats` on every read.
 */
import { z } from "zod"
import type { EffectiveBeat } from "./schema"

export const TOUR_STATUSES = ["active", "paused", "completed", "abandoned"] as const
export type TourStatus = (typeof TOUR_STATUSES)[number]

export const TOUR_SOURCES = ["cli", "help", "demo"] as const
export type TourSource = (typeof TOUR_SOURCES)[number]

/**
 * Per-beat outcome kept in `beat_states`. A skipped beat is never shown as
 * done. A `do` beat whose event named an entity keeps its id
 * (`{state: "done", entityId}`), so a later beat's autoplay works on what the
 * tour itself created (a step's `created` pin), never on someone's existing
 * content.
 */
export type TourBeatState = "done" | "skipped" | TourBeatDone
export interface TourBeatDone {
  state: "done"
  entityId: string
  /**
   * The beat completed on its write's approval (`heldAs`), not the write
   * itself: `entityId` is that approval, which the beat's `whenHeld` beat
   * approves.
   */
  held?: true
}

/** Done or skipped, whatever the state carries. */
export function beatOutcome(state: TourBeatState): "done" | "skipped" {
  return typeof state === "string" ? state : state.state
}

/**
 * A step whose moment comes from someone other than the visitor: a world beat
 * (a live event the demo brings in) or a do beat that waits on someone else's
 * work (a routine's, anyone's: `actor: "any"`; the agent's answer to the
 * visitor's request: `causedBy`). It is there to be READ: when that happens
 * the run records it on the beat and stays there (`beatArrived`), and only the
 * visitor's Next moves on. A do beat the visitor does themselves moves on as
 * soon as they did it.
 */
export function beatArrives(beat: Pick<EffectiveBeat, "kind" | "event">): boolean {
  if (beat.kind === "world") return true
  if (beat.kind !== "do" || !beat.event) return false
  return beat.event.actor === "any" || beat.event.causedBy !== undefined
}

/**
 * A step whose moment happened while the run was on it or before it got there:
 * an arriving step (`beatArrives`) that arrived, or a do step whose event the
 * run recorded ahead (it happened while the visitor was still on an earlier
 * step). The visitor reads it, then Next; it never offers to do it again.
 */
export function beatArrived(
  beat: Pick<EffectiveBeat, "id" | "kind" | "event">,
  beatStates: Readonly<Record<string, TourBeatState>>,
): boolean {
  const state = beatStates[beat.id]
  if (state === undefined || beatOutcome(state) !== "done") return false
  return beatArrives(beat) || beat.kind === "do"
}

/**
 * A later do step of the run is already done (recorded ahead): the visitor did
 * it from this step, such as approving the request whose card this step
 * shows. What this step points at may be gone for good (an approved request
 * leaves Home), so it must not wait for it to come back: Next moves on.
 */
export function beatOvertaken(
  beats: readonly Pick<EffectiveBeat, "id" | "kind">[],
  beatId: string,
  beatStates: Readonly<Record<string, TourBeatState>>,
): boolean {
  const index = beats.findIndex((beat) => beat.id === beatId)
  if (index < 0) return false
  return beats.slice(index + 1).some((beat) => {
    const state = beatStates[beat.id]
    return beat.kind === "do" && state !== undefined && beatOutcome(state) === "done"
  })
}

/** The entity ids the run recorded, by beat id: what its `do` and `world` beats created, and the person's conversation with their agent (`RUN_CONVERSATION`). */
export function createdEntityIds(
  beatStates: Readonly<Record<string, TourBeatState>>,
): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [beatId, state] of Object.entries(beatStates)) {
    if (typeof state !== "string") out[beatId] = state.entityId
  }
  return out
}

/**
 * What the current step is at, as the server computes it from its own rows
 * (the run's beat states, the routine runs, the agent turns it runs), in one
 * place (`apps/api` tours `beat-status.ts`). The tour card renders this and
 * nothing it remembers from live frames: every change of an input pushes a
 * `kernel:tour` frame, and the card re-reads progress on that frame, on a
 * reconnect and when the tab comes back.
 *
 *  - `done`: the step's moment happened (`beatArrived`); `held` when what it
 *    waited for was a write parked for approval. Never shown as running.
 *  - `pending`: nothing the server knows of is at work on it (it waits on the
 *    person, or on an event nothing reports progress on).
 *  - `agent-working`: the person's agent is running a turn the step waits on.
 *  - `held-for-approval`: that turn parked a tool call for approval (any tool,
 *    for any reason: a scope mark, a policy) and waits on the person to
 *    approve it; the card says so and points at that request's card. A write
 *    the step itself declares may park (`heldAs`) completes it instead.
 *  - `agent-failed`: the turn answering the question the step waits on (the
 *    person's newest message in that conversation, at or after the recorded
 *    one) ended without an answer: refused before it ran (a spend or usage
 *    gate), failed or cut off. The card says so, with the refusal's own words
 *    when there are some, and Try again sends the same question again.
 *  - `routine-*`: the run of the routine the step waits on, on what this run
 *    brought in: under way, finished, stopped with an error, or not run (why).
 */
export type TourBeatStatus =
  | { kind: "done"; held: boolean }
  | { kind: "pending" }
  | { kind: "agent-working"; since: string }
  | {
      kind: "held-for-approval"
      /** The pending approval the agent's turn parked (its card: `approval-card[data-request-id=…]`). */
      requestId: string
      toolName: string
      reason: string | null
    }
  | {
      kind: "agent-failed"
      /** The conversation the question was asked in. */
      threadId: string
      /** The person's message whose turn ended without an answer. */
      askId: string
      /** What that message asked: Try again sends it again, in the same conversation. */
      question: string
      /** Why, in the words the conversation or the failure gave; null when nothing says. */
      message: string | null
      /** A refusal's code (`metadata.demoRefusal` on its line), when it carries one. */
      code: string | null
    }
  | { kind: "routine-running"; routineName: string | null; startedAt: string }
  | { kind: "routine-succeeded"; routineName: string | null }
  | { kind: "routine-failed"; routineName: string | null; error: string | null }
  | {
      kind: "routine-skipped"
      routineName: string | null
      /** The run row's status (`skipped_no_credits`, …). */
      status: string
      error: string | null
    }

export type TourBeatStatusKind = TourBeatStatus["kind"]

export interface TourProgress {
  tourId: string
  status: TourStatus
  /** The current beat; null once completed (or when the beat no longer exists). */
  beatId: string | null
  /** Index of `beatId` in the caller's effective beats (= beatCount once completed). */
  beatIndex: number
  /** Number of effective beats for this org. */
  beatCount: number
  beatStates: Record<string, TourBeatState>
  /**
   * The current step's status (`TourBeatStatus`), on an active run with a
   * current step. Every server read carries it; absent only on a paused,
   * finished or empty run.
   */
  beatStatus?: TourBeatStatus
  source: TourSource
  startedAt: string
  updatedAt: string
}

/** One catalogue row: tours available for the org's apps and the caller's scopes. */
export interface TourListItem {
  tourId: string
  app: string
  /** `tours.*` i18n keys. */
  title: string
  summary: string
  beatCount: number
  /** Played once: once played it offers no "Start again", only the demo's "Start over". */
  singleRun?: true
  /** null = never started ("new"). */
  progress: TourProgress | null
}

export interface ListToursResponse {
  tours: TourListItem[]
}

export const StartTourRequestSchema = z
  .object({
    /** Where the start came from (the web help menu, the demo, the CLI). */
    source: z.enum(TOUR_SOURCES).optional(),
  })
  .strict()
export type StartTourRequest = z.infer<typeof StartTourRequestSchema>

/**
 * Owner-only progress update. Exactly one intent per request:
 *   - `{status: "paused" | "active" | "abandoned"}`: pause, resume, abandon;
 *   - `{advance: true}`: Next on a `show` beat (the server refuses it on a `do`
 *     beat: do beats complete only on their product event); past the last beat
 *     the tour completes;
 *   - `{skip: true}`: skip the current beat (recorded as skipped);
 *   - `{beatIndex}`: go back to an earlier beat (never forward).
 * `fromBeatId` is a compare-and-set guard: when given and the current beat is
 * another one, the server answers 409 with the fresh progress, so a stale
 * click never moves the person twice. The server clamps every move to the
 * effective beats and refuses to land on a world beat outside a demo org.
 */
export const UpdateTourRequestSchema = z
  .object({
    status: z.enum(["active", "paused", "abandoned"]).optional(),
    advance: z.literal(true).optional(),
    skip: z.literal(true).optional(),
    beatIndex: z.number().int().min(0).optional(),
    fromBeatId: z.string().min(1).optional(),
  })
  .strict()
  .refine(
    (v) =>
      [v.status !== undefined, v.advance, v.skip, v.beatIndex !== undefined].filter(Boolean)
        .length === 1,
    { message: "Give exactly one of status, advance, skip or beatIndex" },
  )
export type UpdateTourRequest = z.infer<typeof UpdateTourRequestSchema>

export interface TourProgressResponse {
  progress: TourProgress | null
}

// ── Websocket ──────────────────────────────────────────────────────────

/** Kernel entity of the progress push (`kernel:tour`, actions start/update). */
export const TOUR_WS_ENTITY = "tour"

/**
 * `data` of a `kernel:tour` frame. Delivered to the owner's sockets only.
 * The web treats any frame as "refetch progress" and never trusts its state;
 * frames older than TOUR_FRAME_TTL_MS (a replay after a long disconnect) are
 * ignored.
 */
export interface TourFrameData {
  ownerUserId: string
  tourId: string
  status: TourStatus
  beatId: string | null
  beatIndex: number
  /** ISO timestamp of the change. */
  emittedAt: string
  /**
   * A demo world beat that cannot run yet says why: the visitor must confirm
   * their email (`verify`), the demo budget is spent (`budget`), or the live
   * event failed (`failed`, the panel offers Retry). Absent on every other frame.
   */
  gate?: TourBeatGate
}

export const TOUR_BEAT_GATES = ["verify", "budget", "failed"] as const
export type TourBeatGate = (typeof TOUR_BEAT_GATES)[number]

export const TOUR_FRAME_TTL_MS = 10 * 60 * 1000

export const TourFrameDataSchema = z.object({
  ownerUserId: z.string().min(1),
  tourId: z.string().min(1),
  status: z.enum(TOUR_STATUSES),
  beatId: z.string().nullable(),
  beatIndex: z.number().int().min(0),
  emittedAt: z.string().min(1),
  gate: z.enum(TOUR_BEAT_GATES).optional(),
})

/** The frame is recent enough to act on (not a stale replay). */
export function isTourFrameFresh(frame: TourFrameData, now: number = Date.now()): boolean {
  const at = Date.parse(frame.emittedAt)
  if (Number.isNaN(at)) return false
  return now - at <= TOUR_FRAME_TTL_MS
}
