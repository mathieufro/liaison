// SPDX-License-Identifier: FSL-1.1-ALv2
import {
  beatArrived,
  beatOvertaken,
  beatWaitsOn,
  createdEntityIds,
  type EffectiveBeat,
  resolveBeatRoute,
  type Tour,
  type TourBeatGate,
  type TourBeatStatus,
  type TourProgress,
  type TourStep,
} from "@liaison/shared"
import { Check, ChevronDown, ChevronUp, Ellipsis, X } from "lucide-solid"
import {
  type Component,
  createEffect,
  createMemo,
  createSignal,
  For,
  type JSX,
  Match,
  on,
  onCleanup,
  onMount,
  Show,
  Switch,
} from "solid-js"
import { spaNavigate } from "~/framework/spa-navigate"
import { cn } from "~/lib/cn"
import { useI18n } from "~/modules/i18n/i18n-context"
import { pluralFormFor } from "~/modules/projects/plural"
import { refusalCodeInThread } from "~/modules/threads/turn-refusal"
import { Button } from "~/ui/Button"
import { PopupMenu } from "~/ui/PopupMenu"
import { createBeatFigures } from "./beat-figures"
import { tourBeatGate, tourCompletedAction, tourRefusalGate } from "./beat-gates"
import { tourCopyVars } from "./copy-vars"
import { createPanelLayout } from "./panel-layout"
import {
  type ChipPlacement,
  chipCandidates,
  coveredControls,
  PANEL_WIDTH,
  pickPlacement,
  type Rect,
  type SheetPlacement,
} from "./placement"
import { type AutoplayStatus, tourStore } from "./tour-store"

type StatusLine = Exclude<AutoplayStatus, "idle"> | "waiting" | "anchorWaiting" | "watching"

const STATUS_TESTID: Record<StatusLine, string> = {
  playing: "tour-autoplay-playing",
  failed: "tour-autoplay-failed",
  refused: "tour-autoplay-refused",
  takeover: "tour-autoplay-takeover",
  agentFailed: "tour-agent-failed",
  agentAnswered: "tour-agent-answered",
  agentWaiting: "tour-agent-waiting",
  working: "tour-working",
  waiting: "tour-waiting",
  anchorWaiting: "tour-anchor-waiting",
  watching: "tour-world-watching",
}

const STATUS_KEY: Record<StatusLine, string> = {
  playing: "tours.engine.playing",
  failed: "tours.engine.autoplayFailed",
  refused: "tours.engine.autoplayRefused",
  takeover: "tours.engine.takeover",
  agentFailed: "tours.engine.agentFailed",
  agentAnswered: "tours.engine.agentAnswered",
  agentWaiting: "tours.engine.agentWaiting",
  working: "tours.engine.workingAgent",
  waiting: "tours.engine.waiting",
  anchorWaiting: "tours.engine.anchorWaiting",
  watching: "tours.engine.watching",
}

/** Lines the person must read: the panel never stays folded over them. */
const ATTENTION_STATUS = new Set<AutoplayStatus>([
  "failed",
  "refused",
  "agentFailed",
  "agentAnswered",
  "agentWaiting",
])

/** The beat will not move on by itself for now: Try again and Skip this step. */
const RETRY_STATUS = new Set<AutoplayStatus>(["agentFailed", "agentAnswered", "agentWaiting"])

/** Lines that only say the tour is waiting: quieter than one that asks for something. */
const QUIET_STATUS = new Set<StatusLine>([
  "playing",
  "waiting",
  "working",
  "anchorWaiting",
  "watching",
])

/**
 * What a step says while it waits without knowing on what: a step whose
 * routine's run the server told about says that instead.
 */
const GENERIC_WAIT = new Set<AutoplayStatus>(["idle", "playing", "working", "agentWaiting"])

/** Where a model is set up: what a routine that did not run for want of one needs. */
const MODEL_SETUP_ROUTE = "/settings/ai-models"

/** The routine run a step waits on, as the server's step status says it. */
interface RoutineRunView {
  phase: "running" | "succeeded" | "failed" | "skipped"
  routineName: string | null
  /** When the run began (ms, the server's clock); null when unknown or not running. */
  startedAt: number | null
  error: string | null
  /** The run row's status (`skipped_no_credits`, …); null unless skipped. */
  status: string | null
}

/** The routine line of a step status (`TourBeatStatus`), or null for any other status. */
export function routineRunOf(status: TourBeatStatus | undefined): RoutineRunView | null {
  switch (status?.kind) {
    case "routine-running": {
      const started = Date.parse(status.startedAt)
      return {
        phase: "running",
        routineName: status.routineName,
        startedAt: Number.isFinite(started) ? started : null,
        error: null,
        status: null,
      }
    }
    case "routine-succeeded":
      return {
        phase: "succeeded",
        routineName: status.routineName,
        startedAt: null,
        error: null,
        status: null,
      }
    case "routine-failed":
      return {
        phase: "failed",
        routineName: status.routineName,
        startedAt: null,
        error: status.error,
        status: null,
      }
    case "routine-skipped":
      return {
        phase: "skipped",
        routineName: status.routineName,
        startedAt: null,
        error: status.error,
        status: status.status,
      }
    default:
      return null
  }
}

/** A tool's name as a person reads it (`web_search` → "web search", `projects__create` → "projects create"). */
export function toolLabel(toolName: string): string {
  // The workspace's own tools read without their prefix ("web search", not
  // "kernel web search"); an app's keep its name ("projects create").
  return toolName
    .replace(/^kernel(:|__)/, "")
    .replace(/[_:]+/g, " ")
    .trim()
}

/** How long a run has taken, as m:ss. */
export function formatElapsed(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000))
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`
}

/** How long a step waits for its routine's run to show up before saying it has not started. */
export const ROUTINE_START_GRACE_MS = 90_000

/** What the working line says, by what the beat waits on. */
const WORKING_KEY = {
  agent: "tours.engine.workingAgent",
  routine: "tours.engine.workingRoutine",
  replay: "tours.engine.workingReplay",
} as const

/** What a world beat's gate says when no module registered a component for it. */
const GATE_KEY: Record<TourBeatGate, string> = {
  verify: "tours.engine.gateVerify",
  budget: "tours.engine.gateBudget",
  failed: "tours.engine.gateFailed",
}

/** Bottom offset of a phone sheet: above the five-seat tab bar. */
export const PHONE_SHEET_BOTTOM = "calc(56px + env(safe-area-inset-bottom, 0px) + 8px)"
/** Top offset of a phone sheet moved up: below the status bar. */
const PHONE_SHEET_TOP = "calc(env(safe-area-inset-top, 0px) + 8px)"

/** Room the desktop card keeps from the viewport's far edge. */
const CARD_MARGIN = 16
/** A card growing upward stops below the tab strip. */
const CARD_TOP = 64

const SHEET_STYLE: Record<SheetPlacement, JSX.CSSProperties> = {
  bottom: { bottom: PHONE_SHEET_BOTTOM },
  top: { top: PHONE_SHEET_TOP },
}

/** Script steps that do nothing in the person's place: they wait, or open where the work shows. */
function standsBy(step: TourStep): boolean {
  return (
    "waitEvent" in step || "openRunConversation" in step || "waitFor" in step || "require" in step
  )
}

/**
 * A do step the person's agent or a routine completes, with nothing for the
 * person to press or type (its script only waits for the work): the card
 * offers neither "I'll do it" nor "Do it for me", only Next once it is done.
 */
export function watchOnly(beat: EffectiveBeat): boolean {
  if (beat.kind !== "do") return false
  const steps = beat.autoplay ?? []
  return steps.length > 0 && steps.every(standsBy)
}

/**
 * A do step completed by work already running on its own (a routine's run,
 * the recorded session's replay: anyone's event, `actor: "any"`), never by
 * anything the person does. The card says what it waits on and offers
 * nothing to press, only Next once it is done; "Do it for me" stays in ⋯
 * when its script opens where the work shows (the session, the routine).
 */
export function waitsOnRunningWork(beat: EffectiveBeat): boolean {
  if (watchOnly(beat)) return true
  return beat.kind === "do" && beat.event?.actor === "any" && beatWaitsOn(beat) !== undefined
}

/** "Do it for me" plays something in the person's place (presses, types, sends). */
function playsForPerson(beat: EffectiveBeat): boolean {
  return (beat.autoplay ?? []).some((step) => !standsBy(step))
}

function viewport() {
  return { width: window.innerWidth, height: window.innerHeight }
}

export interface TourPanelProps {
  tour: Tour
  progress: TourProgress
  beat: EffectiveBeat
  /** The beat's anchor is on screen (always true for a beat without one). */
  anchorVisible: boolean
  /** The person's agent is working on the request this do beat waits on: nothing to press. */
  working?: boolean
  /** The approval the step asked for waits out its undo window: the step says so (`beat.undo`). */
  undoing?: boolean
  /** Where the spotlit element is: the panel keeps clear of it. */
  spot?: Rect | null
  /**
   * The person is on the very page the beat's route opens (true), elsewhere
   * (false), or that cannot be told (undefined).
   */
  atRoute?: boolean
  /**
   * The way to the step's element, listed while it is away (`TourBeat.path`):
   * hop labels (copy keys), how many are passed, and the one to take now.
   */
  way?: { labels: string[]; done: number; current: number | null } | null
  /** The hop to take now (`way.current`) is on screen, ringed: the person can open it. */
  wayAtHand?: boolean
  phone: boolean
  onDoItForMe: () => void
  /**
   * "Try again" on a beat still waiting: replays what starts the work again
   * (its script, or the request it waits on). Absent: nothing to replay, so
   * only Skip is offered.
   */
  onTryAgain?: () => void
  /** Approve the request the agent's turn parked (`beatStatus` held-for-approval). */
  onApproveHeld?: (requestId: string) => void
  /** Do it for me already approved this parked request once: it is not offered again. */
  heldApproved?: (requestId: string) => boolean
  /** Go to the beat's screen and open what it points at ("Take me there"). */
  onTakeMeThere: () => void
  onPlayAll: () => void
  onStopPlaying: () => void
}

/**
 * Where the person dragged the desktop card, for the scenario run it was
 * dragged in (tour id and start time): kept for every later step of that run,
 * dropped when the run ends or another starts (its key no longer matches).
 * In memory only.
 */
const [movedCard, setMovedCard] = createSignal<{ run: string; left: number; top: number } | null>(
  null,
)
const runKey = (p: TourProgress) => `${p.tourId}@${p.startedAt}`
/** A press moves this far before it counts as a drag (a click on the header stays a click). */
const DRAG_SLOP = 3

/**
 * The current beat: a non-modal card at the right (desktop) or a sheet above
 * the tab bar (phone). Never blocks the app: no backdrop, no focus trap. It
 * stays above (and clickable over) a dialog or sheet the app opens, often the
 * beat's own (z-[58] over the z-50 overlays; pointer-events-auto through a
 * modal's disabled outside pointer events).
 */
export const TourPanel: Component<TourPanelProps> = (props) => {
  const i18n = useI18n()
  let el: HTMLElement | undefined
  /** Clear of the beat's sheet or editor, then of the spotlit element; a strip when crowded. */
  const layout = createPanelLayout({
    phone: () => props.phone,
    beat: () => props.beat,
    spot: () => props.spot ?? null,
    height: () => el?.getBoundingClientRect().height ?? 0,
    created: () => createdEntityIds(props.progress.beatStates),
    // A world beat's gate (verify, budget, failed) asks for something: never folded over it.
    attention: () =>
      tourStore.error !== null ||
      ATTENTION_STATUS.has(autoplay()) ||
      (props.beat.kind === "world" && tourStore.gate !== null),
  })
  const placement = layout.placement
  /** The person moved the card in this run: it stays there instead of placing itself. */
  const moved = () => {
    const m = movedCard()
    return !props.phone && m && m.run === runKey(props.progress) ? m : null
  }
  const placementStyle = (): JSX.CSSProperties => {
    if (props.phone) return SHEET_STYLE[placement() as SheetPlacement]
    const m = moved()
    if (m) {
      return {
        left: `${m.left}px`,
        top: `${m.top}px`,
        width: `${PANEL_WIDTH}px`,
        "max-height": `calc(100dvh - ${m.top}px - ${CARD_MARGIN}px)`,
      }
    }
    const f = layout.frame()
    // Never taller than the room it has: the body scrolls, no text is cut.
    return {
      left: `${f.left}px`,
      width: `${PANEL_WIDTH}px`,
      ...(f.top !== undefined
        ? { top: `${f.top}px`, "max-height": `calc(100dvh - ${f.top}px - ${CARD_MARGIN}px)` }
        : {
            bottom: `${f.bottom ?? 0}px`,
            "max-height": `calc(100dvh - ${f.bottom ?? 0}px - ${CARD_TOP}px)`,
          }),
    }
  }
  /** Drag the desktop card by its header (not its buttons), mouse or pen, kept on screen. */
  let drag: { id: number; dx: number; dy: number; x: number; y: number; on: boolean } | null = null
  const clampTo = (left: number, top: number) => {
    const box = el?.getBoundingClientRect()
    const w = box?.width || PANEL_WIDTH
    const h = box?.height || 0
    return {
      left: Math.round(Math.max(0, Math.min(left, window.innerWidth - w))),
      top: Math.round(Math.max(0, Math.min(top, window.innerHeight - h))),
    }
  }
  const onHeaderDown = (e: PointerEvent) => {
    if (props.phone || e.button !== 0 || !el) return
    if ((e.target as Element | null)?.closest("button, a, [role='button']")) return
    const box = el.getBoundingClientRect()
    drag = {
      id: e.pointerId,
      dx: e.clientX - box.left,
      dy: e.clientY - box.top,
      x: e.clientX,
      y: e.clientY,
      on: false,
    }
    ;(e.currentTarget as Element).setPointerCapture?.(e.pointerId)
  }
  const onHeaderMove = (e: PointerEvent) => {
    if (!drag || e.pointerId !== drag.id) return
    if (!drag.on && Math.hypot(e.clientX - drag.x, e.clientY - drag.y) < DRAG_SLOP) return
    drag.on = true
    e.preventDefault()
    setMovedCard({
      run: runKey(props.progress),
      ...clampTo(e.clientX - drag.dx, e.clientY - drag.dy),
    })
  }
  const onHeaderUp = (e: PointerEvent) => {
    if (!drag || e.pointerId !== drag.id) return
    ;(e.currentTarget as Element).releasePointerCapture?.(e.pointerId)
    drag = null
  }
  // A smaller window keeps a moved card on screen.
  onMount(() => {
    const keep = () => {
      const m = moved()
      if (m) setMovedCard({ run: m.run, ...clampTo(m.left, m.top) })
    }
    window.addEventListener("resize", keep)
    onCleanup(() => window.removeEventListener("resize", keep))
  })
  /** The ⋯ menu holding the less used actions (Take me there, Play, Pause, Skip). */
  const [menuOpen, setMenuOpen] = createSignal(false)
  /** The figures the step's copy names, read from the tool the screen reads (`beat.figures`). */
  const figures = createBeatFigures(() => props.beat)
  /** Step copy in the person's language, with the names and figures it may carry. */
  const copy = (key: string) => i18n.t(key, { ...tourCopyVars(), ...figures() })
  /** The approval waits out its undo window: what the step says meanwhile. */
  const undo = () => (props.undoing ? (props.beat.undo ?? null) : null)
  const stepNumber = () => Math.min(props.progress.beatIndex + 1, props.progress.beatCount)
  const isLast = () => props.progress.beatIndex + 1 >= props.progress.beatCount
  const autoplay = () =>
    tourStore.autoplay.beatId === props.beat.id ? tourStore.autoplay.status : "idle"
  /** The beat's route with what earlier beats recorded filled in; null when there is none. */
  const route = () =>
    resolveBeatRoute(props.beat.route, createdEntityIds(props.progress.beatStates))
  const waiting = () =>
    props.beat.kind === "do" &&
    autoplay() !== "playing" &&
    (tourStore.selfDoingBeatId === props.beat.id || autoplay() === "takeover")
  /**
   * The gate a refused agent turn names (the demo's "confirm your email"): the
   * turn the beat waited on was refused before it ran, and its refusal line
   * says why. Read live: the line may land just after the failure.
   */
  const refusalGate = () => {
    if (autoplay() !== "agentFailed") return null
    const turn = tourStore.autoplay.turn
    return turn
      ? tourRefusalGate(turn.code ?? refusalCodeInThread(turn.threadId, turn.message))
      : null
  }
  /**
   * Why the turn the step waited on gave no answer, in the refusal's or the
   * failure's own words (the server's `agent-failed`), under the failed line.
   */
  const failedReason = () => {
    if (autoplay() !== "agentFailed" || refusalGate()) return null
    const turn = tourStore.autoplay.turn
    return turn?.askId !== undefined && turn.message.trim() ? turn.message.trim() : null
  }
  /** A world beat held back (verify, budget, failed), or a refused turn: its gate replaces the line. */
  const gate = () =>
    props.beat.kind === "world"
      ? beatArrived(props.beat, props.progress.beatStates)
        ? null
        : tourStore.gate
      : refusalGate()
  const waitsOn = () => beatWaitsOn(props.beat)
  /**
   * The visitor already did a later step from here (approved the request whose
   * card this step shows): what it points at is gone for good, so it neither
   * waits for it nor offers to go there; Next moves on.
   */
  const overtaken = () => beatOvertaken(props.tour.beats, props.beat.id, props.progress.beatStates)
  /**
   * A show beat pointing at what an earlier beat recorded (the ticket a live
   * beat brought in), or at what work still under way produces (the agent's
   * sourced answer: `waitsOn`), that is not on screen yet: Next waits for it
   * (walk D51).
   */
  const pinnedPending = () =>
    props.beat.kind === "show" &&
    (props.beat.anchorPinned === true || props.beat.waitsOn !== undefined) &&
    !props.anchorVisible &&
    !overtaken()
  /**
   * "Take me there": the element is not on screen and the beat has somewhere
   * to go. Already on that very screen, going there again does nothing, unless
   * steps bring the element up there (`reach`).
   */
  const takeMeThere = () =>
    props.beat.anchor !== undefined &&
    !props.anchorVisible &&
    route() !== null &&
    !(props.atRoute === true && !props.beat.reach) &&
    !overtaken()
  /** The agent or the tour is on this step: the panel offers nothing to press. */
  const onIt = () =>
    autoplay() === "playing" || props.working || spent() || passed() || status() === "working"
  /**
   * What this step announces (a live event, the agent's or a routine's work)
   * arrived: the step stays, to be read, and the visitor moves on with Next.
   */
  const arrived = () => beatArrived(props.beat, props.progress.beatStates)
  /** A live arrival still coming: nothing to press until it came. */
  const arriving = () => props.beat.kind === "world" && gate() === null && !arrived()
  /** The tour already did this step's part (`tourStore.spentBeatId`): nothing more to press. */
  const spent = () => tourStore.spentBeatId === props.beat.id
  /** The server already moved past this step; the next one is on its way. */
  const passed = () => tourStore.passedBeatId === props.beat.id
  /**
   * What the routine this step waits on is doing, as the server computed it
   * (`progress.beatStatus`): said instead of a generic wait. A step that is
   * done says nothing of it (the server never reports one as running).
   */
  const routineLine = () => (passed() || arrived() ? null : routineRunOf(props.progress.beatStatus))
  /**
   * The agent's turn this step waits on parked a tool call for approval (any
   * tool, whatever made it ask): the step says so and points at that card.
   */
  const held = () => {
    const s = props.progress.beatStatus
    return !passed() && !arrived() && s?.kind === "held-for-approval" ? s : null
  }
  const status = (): StatusLine | null => {
    if (passed() || arrived() || undo() || held()) return null
    const a = autoplay()
    if (routineLine() && GENERIC_WAIT.has(a)) return null
    if (a === "agentFailed" && refusalGate()) return null
    if (a !== "idle") return a
    if (props.working) return "working"
    // Work the tour set going says what it waits on (the agent's answer, a
    // routine, a replay); a step the person does by hand waits on them.
    if (spent()) return waitsOn() ? "working" : "waiting"
    if (waiting()) return "waiting"
    // The agent, a routine or a replay does this step: it says so, there is nothing to press.
    if (waitsOnRunningWork(props.beat)) return "working"
    // A world beat moves on when its live event happened: no Next, it says it is watching.
    if (props.beat.kind === "world") return gate() ? null : "watching"
    // Waiting for the element to appear only where it will appear: away from
    // the beat's screen, "Take me there" is the way, not a wait.
    if (
      props.beat.anchor &&
      !props.anchorVisible &&
      (!route() || (pinnedPending() && props.atRoute !== false))
    ) {
      // An element the work under way produces (a routine's draft, the
      // agent's answer) says that work is going on, with its spinner, until
      // the way to it shows; then the hop line says what to open. "Waiting
      // for this to appear" alone read as stuck (sales walk 2026-10-29).
      if (props.beat.kind === "show" && waitsOn()) return props.wayAtHand ? null : "working"
      return "anchorWaiting"
    }
    return null
  }

  /**
   * A step a routine does whose run never showed up: after a grace the line says the routine has
   * not started and Skip this step is on the card, instead of a spinner that waits for ever.
   */
  const waitsOnUnstartedRoutine = () =>
    waitsOn() === "routine" && status() === "working" && !routineLine()
  const [unstartedSince, setUnstartedSince] = createSignal<number | null>(null)
  const [unstartedNow, setUnstartedNow] = createSignal(Date.now())
  createEffect(on(waitsOnUnstartedRoutine, (waits) => setUnstartedSince(waits ? Date.now() : null)))
  createEffect(() => {
    if (unstartedSince() === null) return
    const timer = setInterval(() => setUnstartedNow(Date.now()), 1000)
    onCleanup(() => clearInterval(timer))
  })
  const routineNotStarted = () => {
    const since = unstartedSince()
    return since !== null && unstartedNow() - since >= ROUTINE_START_GRACE_MS
  }

  /** The hop to take now, while the step's element is away: one line, "n/m". */
  const hop = () => {
    const way = props.way
    if (undo() || held() || !way || way.current === null) return null
    const label = way.labels[way.current]
    return label === undefined ? null : { n: way.current + 1, m: way.labels.length, label }
  }
  /** Skip this step: in the ⋯ menu beside Try again, on the card when it is the only way on. */
  const retrying = () =>
    RETRY_STATUS.has(autoplay()) && (props.beat.kind === "do" || props.beat.kind === "show")
  const skipBeatInline = () => retrying() && !props.onTryAgain
  const skipBeatInMenu = () => retrying() && props.onTryAgain !== undefined
  const skipBeatButton = () => (
    <Button
      variant="outline"
      size="sm"
      data-testid="tour-skip-beat"
      disabled={tourStore.busy}
      onClick={() => void tourStore.skip()}
    >
      {i18n.t("tours.engine.skipStep")}
    </Button>
  )
  const tryAgainButton = () => (
    <Show when={props.onTryAgain}>
      {(retry) => (
        <Button size="sm" data-testid="tour-do-for-me" onClick={() => retry()()}>
          {i18n.t("tours.engine.tryAgain")}
        </Button>
      )}
    </Show>
  )
  const doMyselfButton = () => (
    <Show when={!waiting()}>
      <Button
        variant="outline"
        size="sm"
        data-testid="tour-do-myself"
        onClick={() => tourStore.doItMyself()}
      >
        {i18n.t("tours.engine.doItMyself")}
      </Button>
    </Show>
  )
  /** Next (Finish on the last step); `held` keeps it disabled while it says so. */
  const nextButton = (held: () => boolean) => (
    <Button
      size="sm"
      data-testid="tour-next"
      disabled={tourStore.busy || held()}
      onClick={() => void tourStore.next()}
    >
      {isLast() ? i18n.t("tours.engine.finish") : i18n.t("tours.engine.next")}
    </Button>
  )
  const stepLabel = () =>
    i18n.t("tours.engine.stepOf", { k: stepNumber(), n: props.progress.beatCount })

  return (
    <section
      data-testid="tour-panel"
      // A press here is never "outside" a dialog the beat opened: it acts in one click.
      data-kb-top-layer=""
      data-tour-ui=""
      data-tour-id={props.tour.id}
      data-beat-id={props.beat.id}
      data-beat-kind={props.beat.kind}
      data-tier={props.phone ? "phone" : "wide"}
      data-placement={placement()}
      data-moved={moved() ? "" : undefined}
      data-collapsed={layout.collapsed() ? "" : undefined}
      data-play-all={tourStore.playAll ? "" : undefined}
      aria-label={i18n.t(props.tour.title)}
      ref={el}
      class={cn(
        "pointer-events-auto fixed z-[58] flex flex-col gap-2 rounded-lg border border-border-subtle bg-bg px-3.5 py-3 text-[13.5px] text-text shadow-lg",
        props.phone && "inset-x-2",
        // Folded: the header alone, on one line.
        layout.collapsed() && "gap-0 py-2 [&>*:not(header)]:hidden",
      )}
      style={placementStyle()}
    >
      {/* Scenario name, progress as dots, close: one line. On a desktop, the
          handle the card is dragged by (its buttons stay buttons). */}
      <header
        data-testid="tour-panel-handle"
        onPointerDown={onHeaderDown}
        onPointerMove={onHeaderMove}
        onPointerUp={onHeaderUp}
        onPointerCancel={onHeaderUp}
        class={cn(
          "flex shrink-0 items-center gap-2 text-[12px] text-text-tertiary",
          !props.phone && "cursor-grab touch-none select-none active:cursor-grabbing",
        )}
      >
        <span class="min-w-0 truncate">{i18n.t(props.tour.title)}</span>
        <span
          data-testid="tour-step-count"
          role="img"
          aria-label={stepLabel()}
          title={stepLabel()}
          data-step={stepNumber()}
          data-steps={props.progress.beatCount}
          class="flex min-w-0 shrink items-center gap-[3px]"
        >
          <For each={Array.from({ length: props.progress.beatCount }, (_, i) => i)}>
            {(i) => (
              <span
                aria-hidden="true"
                class={cn(
                  "h-[3px] w-[14px] min-w-[3px] shrink rounded-full",
                  i < stepNumber() ? "bg-text-secondary" : "bg-border",
                )}
              />
            )}
          </For>
          {/* The step in words beside the dashes: "Step 1 of 6". */}
          <span
            aria-hidden="true"
            data-testid="tour-step-label"
            class="ml-1 shrink-0 whitespace-nowrap text-[11px] tabular-nums text-text-tertiary"
          >
            {stepLabel()}
          </span>
        </span>
        <span class="flex-1" />
        <Show when={layout.canFold()}>
          <button
            type="button"
            data-testid="tour-fold"
            aria-label={i18n.t(layout.collapsed() ? "tours.engine.unfold" : "tours.engine.fold")}
            aria-expanded={!layout.collapsed()}
            onClick={() => layout.toggle()}
            class="flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-text-tertiary hover:bg-surface-hover hover:text-text-secondary"
          >
            {layout.collapsed() ? <ChevronUp size={15} /> : <ChevronDown size={15} />}
          </button>
        </Show>
        <button
          type="button"
          data-testid="tour-end"
          aria-label={i18n.t("tours.engine.end")}
          onClick={() => void tourStore.end()}
          class="-mr-1 flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-text-tertiary hover:bg-surface-hover hover:text-text-secondary"
        >
          <X size={15} />
        </button>
      </header>

      <div data-testid="tour-panel-body" class="flex min-h-0 flex-col gap-1.5 overflow-y-auto">
        <h2 data-testid="tour-beat-title" class="text-[15px] font-semibold leading-snug text-text">
          {held() ? i18n.t("tours.engine.heldTitle") : copy(undo()?.title ?? props.beat.title)}
        </h2>
        {/* Why this step: one grey line under the title. */}
        <Show when={!held() && (undo()?.role ?? props.beat.role)}>
          {(role) => (
            <p
              data-testid="tour-beat-role"
              class="-mt-1 text-[12.5px] leading-snug text-text-tertiary"
            >
              {copy(role())}
            </p>
          )}
        </Show>
        {/* What to do now: the hop to take while the element is away (the ring
            shows where), else the step's own instruction. */}
        <Show
          when={hop()}
          fallback={
            <p
              data-testid="tour-beat-body"
              data-done={arrived() ? "" : undefined}
              class={cn(
                "flex items-baseline gap-1.5 leading-snug",
                arrived() ? "text-success" : "text-text-secondary",
              )}
            >
              <Show when={arrived()}>
                <Check size={13} aria-hidden="true" class="shrink-0 self-center" />
              </Show>
              <span>
                {held()
                  ? i18n.t("tours.engine.heldBody", { tool: toolLabel(held()?.toolName ?? "") })
                  : copy(undo()?.body ?? props.beat.body)}
              </span>
            </p>
          }
        >
          {(h) => (
            <p data-testid="tour-path" class="flex items-baseline gap-2 leading-snug">
              <span class="shrink-0 text-[11.5px] tabular-nums text-text-tertiary">
                {h().n}/{h().m}
              </span>
              <span data-testid="tour-path-hop" data-hop-state="now" class="text-text">
                {copy(h().label)}
              </span>
            </p>
          )}
        </Show>
        {/* The request, in full: the very sentence the person may type themselves. */}
        <Show when={!undo() && props.beat.say}>
          {(say) => (
            <p
              data-testid="tour-beat-say"
              class="shrink-0 select-text rounded-md bg-surface-sunken px-2.5 py-1.5 text-[12.5px] leading-snug text-text-secondary"
            >
              {copy(say().lead)} <span class="font-medium text-text">“{copy(say().text)}”</span>
            </p>
          )}
        </Show>
      </div>

      {/* One status line: the most specific thing that is true now. */}
      <Show when={status()}>
        {(line) => (
          <p
            data-testid={STATUS_TESTID[line()]}
            data-tour-status={line()}
            data-missing={
              line() === "failed" ? (tourStore.autoplay.missing ?? undefined) : undefined
            }
            data-target={
              line() === "refused" ? (tourStore.autoplay.missing ?? undefined) : undefined
            }
            class={cn(
              "flex items-baseline gap-1.5 text-[12.5px] leading-snug",
              QUIET_STATUS.has(line()) ? "text-text-tertiary" : "text-text-secondary",
            )}
          >
            <Show when={line() === "working" || line() === "playing"}>
              <Spinner />
            </Show>
            <span>
              {i18n.t(
                line() === "working"
                  ? routineNotStarted()
                    ? "tours.engine.routineNotStarted"
                    : WORKING_KEY[waitsOn() ?? "agent"]
                  : line() === "agentFailed" && props.beat.kind === "show"
                    ? "tours.engine.agentNoAnswer"
                    : STATUS_KEY[line()],
              )}
            </span>
          </p>
        )}
      </Show>

      <Show when={failedReason()}>
        {(reason) => (
          <p
            data-testid="tour-agent-failed-reason"
            class="text-[12.5px] leading-snug text-text-tertiary"
          >
            {reason()}
          </p>
        )}
      </Show>

      <Show when={routineLine()}>{(run) => <RoutineRunLine run={run()} />}</Show>

      <Show when={gate()}>
        {(g) => {
          const Gate = tourBeatGate(g())
          return (
            <div data-testid="tour-beat-gate" data-gate={g()}>
              {Gate ? (
                <Gate tour={props.tour} progress={props.progress} beat={props.beat} gate={g()} />
              ) : (
                <p class="text-[12.5px] text-text-secondary">{i18n.t(GATE_KEY[g()])}</p>
              )}
            </div>
          )
        }}
      </Show>

      <Show when={tourStore.error}>
        {(key) => (
          <p data-testid="tour-error" role="alert" class="text-[12.5px] text-error">
            {i18n.t(key())}
          </p>
        )}
      </Show>

      {/* The main action and at most one other; the rest in ⋯. */}
      <div class="flex shrink-0 items-center gap-1.5">
        <Switch>
          {/* The agent's turn waits on an approval: Do it for me approves that very request. */}
          <Match when={held()}>
            {(h) => (
              <Button
                size="sm"
                data-testid="tour-do-for-me"
                data-request-id={h().requestId}
                disabled={!props.onApproveHeld || props.heldApproved?.(h().requestId) === true}
                onClick={() => props.onApproveHeld?.(h().requestId)}
              >
                {i18n.t("tours.engine.doItForMe")}
              </Button>
            )}
          </Match>
          <Match when={arrived()}>{nextButton(() => false)}</Match>
          {/* Waiting out the undo window: nothing to press here, Undo is on the toast. */}
          <Match when={undo()}>{null}</Match>
          {/* A failed or unanswered turn: Try again, or do it by hand (Skip in ⋯). */}
          <Match when={props.beat.kind === "do" && RETRY_STATUS.has(autoplay())}>
            {tryAgainButton()}
            {doMyselfButton()}
            <Show when={skipBeatInline()}>{skipBeatButton()}</Show>
          </Match>
          {/* A routine that never started: skip this step to go on. */}
          <Match when={routineNotStarted()}>{skipBeatButton()}</Match>
          {/* The agent, a routine or a replay does it: Next, once it is done. */}
          <Match when={waitsOnRunningWork(props.beat)}>{nextButton(() => true)}</Match>
          {/* ONE state: the agent or the tour is on it (working, or a step the
              tour already played or the server already passed), with nothing
              to press, or the step waits on the person. Never both: in
              between, neither (walk D78). */}
          <Match when={props.beat.kind === "do"}>
            <Show when={!onIt()}>
              <Show when={playsForPerson(props.beat)}>
                <Button size="sm" data-testid="tour-do-for-me" onClick={() => props.onDoItForMe()}>
                  {i18n.t("tours.engine.doItForMe")}
                </Button>
              </Show>
              {doMyselfButton()}
            </Show>
          </Match>
          <Match when={props.beat.kind === "show" && RETRY_STATUS.has(autoplay())}>
            {/* The work a show beat points at has not come: wait again, or skip it. */}
            {tryAgainButton()}
            <Show when={skipBeatInline()}>{skipBeatButton()}</Show>
          </Match>
          <Match when={props.beat.kind === "show"}>
            {nextButton(
              () => pinnedPending() || (props.beat.waitsOn === "agent" && props.working === true),
            )}
          </Match>
        </Switch>
        <span class="flex-1" />
        <PopupMenu open={menuOpen()} onOpenChange={setMenuOpen}>
          <PopupMenu.Trigger
            data-testid="tour-more"
            aria-label={i18n.t("tours.engine.more")}
            title={i18n.t("tours.engine.more")}
            class="-mr-1 flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-text-tertiary hover:bg-surface-hover hover:text-text-secondary"
          >
            <Ellipsis size={16} />
          </PopupMenu.Trigger>
          {/* Part of the card: above it, clickable over a modal the beat opened,
              never "outside" that dialog, and looked through by the placement. */}
          <PopupMenu.Content
            data-testid="tour-menu"
            class="pointer-events-auto z-[59] min-w-[180px]"
            attrs={{ "data-tour-ui": "", "data-kb-top-layer": "" }}
          >
            {/* Work running on its own: opening where it shows is all there is to do for them. */}
            <Show
              when={
                waitsOnRunningWork(props.beat) &&
                playsForPerson(props.beat) &&
                autoplay() === "idle" &&
                !spent() &&
                !passed() &&
                !arrived()
              }
            >
              <PopupMenu.Item data-testid="tour-do-for-me" onSelect={() => props.onDoItForMe()}>
                {i18n.t("tours.engine.doItForMe")}
              </PopupMenu.Item>
            </Show>
            <Show when={takeMeThere()}>
              <PopupMenu.Item
                data-testid="tour-take-me-there"
                onSelect={() => props.onTakeMeThere()}
              >
                {i18n.t("tours.engine.takeMeThere")}
              </PopupMenu.Item>
            </Show>
            <Show
              when={tourStore.playAll}
              fallback={
                <PopupMenu.Item data-testid="tour-play-all" onSelect={() => props.onPlayAll()}>
                  {i18n.t("tours.engine.playAll")}
                </PopupMenu.Item>
              }
            >
              <PopupMenu.Item
                data-testid="tour-stop-playing"
                onSelect={() => props.onStopPlaying()}
              >
                {i18n.t("tours.engine.stopPlaying")}
              </PopupMenu.Item>
            </Show>
            <Show when={moved()}>
              <PopupMenu.Item data-testid="tour-reset-position" onSelect={() => setMovedCard(null)}>
                {i18n.t("tours.engine.resetPosition")}
              </PopupMenu.Item>
            </Show>
            <PopupMenu.Item
              data-testid="tour-pause"
              disabled={tourStore.busy}
              onSelect={() => void tourStore.pause()}
            >
              {i18n.t("tours.engine.pause")}
            </PopupMenu.Item>
            {/* After a failed agent turn, "Skip this step" says the same. */}
            <Show when={!RETRY_STATUS.has(autoplay()) && !arriving()}>
              <PopupMenu.Item
                data-testid="tour-skip"
                disabled={tourStore.busy}
                onSelect={() => void tourStore.skip()}
              >
                {i18n.t("tours.engine.skipStep")}
              </PopupMenu.Item>
            </Show>
            <Show when={skipBeatInMenu()}>
              <PopupMenu.Item
                data-testid="tour-skip-beat"
                disabled={tourStore.busy}
                onSelect={() => void tourStore.skip()}
              >
                {i18n.t("tours.engine.skipStep")}
              </PopupMenu.Item>
            </Show>
          </PopupMenu.Content>
        </PopupMenu>
      </div>
    </section>
  )
}

/** A small calm spinner; still under reduced motion. */
const Spinner: Component = () => (
  <span
    aria-hidden="true"
    class="inline-block h-2.5 w-2.5 shrink-0 self-center rounded-full border-2 border-border border-t-text-secondary motion-safe:animate-spin"
  />
)

/**
 * The routine's run, in one calm line: working on it (with the time taken, a
 * one-second clock while it runs), finished, stopped with an error, or did
 * not run and why, with the way to set up a model when that is the reason.
 */
const RoutineRunLine: Component<{ run: RoutineRunView }> = (props) => {
  const i18n = useI18n()
  const [now, setNow] = createSignal(Date.now())
  /** When this card first saw this run under way (the client's clock): a new run, a new sight. */
  const seenAt = createMemo(
    on(
      () => props.run.startedAt,
      () => Date.now(),
    ),
  )
  onMount(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000)
    onCleanup(() => clearInterval(timer))
  })
  /**
   * The run's start for the clock: the server's, unless it is unknown or
   * later than this card first saw the run (the two clocks disagree), then
   * that first sight, so the time taken ticks on and never sits at 0:00.
   */
  const start = () => {
    const server = props.run.startedAt
    const seen = seenAt()
    return server !== null && server <= seen ? server : seen
  }
  const text = () => {
    const name = props.run.routineName
    const error = props.run.error
    switch (props.run.phase) {
      case "running": {
        const elapsed = formatElapsed(now() - start())
        return name
          ? i18n.t("tours.engine.routineRunning", { name, elapsed })
          : i18n.t("tours.engine.routineRunningUnnamed", { elapsed })
      }
      case "succeeded":
        return name
          ? i18n.t("tours.engine.routineDone", { name })
          : i18n.t("tours.engine.routineDoneUnnamed")
      case "failed":
        if (error) {
          return name
            ? i18n.t("tours.engine.routineFailed", { name, error })
            : i18n.t("tours.engine.routineFailedUnnamed", { error })
        }
        return name
          ? i18n.t("tours.engine.routineFailedNoReason", { name })
          : i18n.t("tours.engine.routineFailedNoReasonUnnamed")
      default:
        if (error) {
          return name
            ? i18n.t("tours.engine.routineSkipped", { name, error })
            : i18n.t("tours.engine.routineSkippedUnnamed", { error })
        }
        return name
          ? i18n.t("tours.engine.routineSkippedNoReason", { name })
          : i18n.t("tours.engine.routineSkippedNoReasonUnnamed")
    }
  }
  return (
    <p
      data-testid="tour-routine-progress"
      data-status={props.run.phase}
      aria-live="polite"
      class={cn(
        "flex flex-wrap items-baseline gap-x-1.5 gap-y-1 text-[12.5px] leading-snug",
        props.run.phase === "running" && "text-text-tertiary",
        props.run.phase === "succeeded" && "text-success",
        (props.run.phase === "failed" || props.run.phase === "skipped") && "text-text-secondary",
      )}
    >
      <Show when={props.run.phase === "running"}>
        <Spinner />
      </Show>
      <Show when={props.run.phase === "succeeded"}>
        <Check size={13} aria-hidden="true" class="shrink-0 self-center" />
      </Show>
      <span class="min-w-0 flex-1">{text()}</span>
      <Show when={props.run.status === "skipped_no_credits"}>
        <button
          type="button"
          data-testid="tour-routine-setup"
          onClick={() => spaNavigate(MODEL_SETUP_ROUTE)}
          class="shrink-0 font-medium text-accent hover:underline"
        >
          {i18n.t("tours.engine.routineSetUpModel")}
        </button>
      </Show>
    </p>
  )
}

/** How often the chip re-checks what is under it (lists render and scroll). */
export const CHIP_PLACE_MS = 1000

function chipStyle(placement: ChipPlacement, rect: Rect, phone: boolean): JSX.CSSProperties {
  const bottom = phone ? PHONE_SHEET_BOTTOM : "16px"
  switch (placement) {
    case "bottom-left":
      return { bottom, left: phone ? "16px" : "60px" }
    case "bottom-center":
      return { bottom, left: "50%", transform: "translateX(-50%)" }
    case "bottom-right":
      return { bottom: phone ? PHONE_SHEET_BOTTOM : "64px", right: "16px" }
    case "top-right":
      return { top: phone ? PHONE_SHEET_TOP : "64px", right: "16px" }
    default:
      return { top: `${rect.top}px`, left: `${rect.left}px` }
  }
}

/** Splits the chip line around the tour name, so only the name truncates. */
const TOUR_SLOT = "\u0000"

/** Paused: one small chip, placed where it covers no control. */
export const TourChip: Component<{ tour: Tour; progress: TourProgress; phone: boolean }> = (
  props,
) => {
  const i18n = useI18n()
  const k = () => Math.min(props.progress.beatIndex + 1, props.progress.beatCount)
  let el: HTMLDivElement | undefined
  const [placed, setPlaced] = createSignal<{ id: ChipPlacement; rect: Rect }>({
    id: "bottom-left",
    rect: { top: 0, left: 0, width: 0, height: 0 },
  })
  const placement = () => placed().id
  const place = () => {
    const r = el?.getBoundingClientRect()
    const size = { width: r?.width || 220, height: r?.height || 30 }
    const candidates = chipCandidates(viewport(), size, props.phone)
    const id = pickPlacement(candidates, (rect) => coveredControls(rect))
    const rect = candidates.find((c) => c.id === id)?.rect ?? placed().rect
    setPlaced({ id, rect })
  }
  const line = () =>
    i18n
      .t("tours.engine.resumeChip", { tour: TOUR_SLOT, k: k(), n: props.progress.beatCount })
      .split(TOUR_SLOT)
  onMount(() => {
    place()
    const timer = setInterval(place, CHIP_PLACE_MS)
    window.addEventListener("resize", place)
    onCleanup(() => {
      clearInterval(timer)
      window.removeEventListener("resize", place)
    })
  })
  return (
    <div
      data-testid="tour-chip"
      data-kb-top-layer=""
      data-tour-ui=""
      data-tour-id={props.tour.id}
      data-placement={placement()}
      ref={el}
      class="pointer-events-auto fixed z-[58] flex max-w-[calc(100vw-32px)] items-center whitespace-nowrap rounded-full border border-border-subtle bg-bg text-[12.5px] shadow-md"
      style={chipStyle(placement(), placed().rect, props.phone)}
    >
      {/* One line: the tour name truncates, never the step it resumes at. */}
      <button
        type="button"
        data-testid="tour-chip-resume"
        onClick={() => void tourStore.resume(props.tour.id)}
        class="flex min-w-0 items-baseline rounded-l-full py-1.5 pl-3 pr-2 text-text-secondary hover:text-text"
      >
        <span class="shrink-0 whitespace-pre">{line()[0]}</span>
        <span data-testid="tour-chip-name" class="min-w-0 truncate">
          {i18n.t(props.tour.title)}
        </span>
        <span class="shrink-0 whitespace-pre">{line().slice(1).join("")}</span>
      </button>
      <button
        type="button"
        data-testid="tour-chip-end"
        aria-label={i18n.t("tours.engine.end")}
        onClick={() => void tourStore.end()}
        class="flex h-7 w-7 shrink-0 items-center justify-center rounded-r-full text-text-tertiary hover:text-text-secondary"
      >
        <X size={13} />
      </button>
    </div>
  )
}

/** The desktop completion card's top edge: below the tab strip. */
const COMPLETED_TOP = 64
/** How often the desktop completion card re-checks what it must keep clear of. */
export const COMPLETED_PLACE_MS = 250

/**
 * The desktop completion card's top: below the tab strip, and below every
 * surface marked `data-tour-keep-clear` (an open list with its own buttons,
 * such as the demo's scenarios) that lies in the card's column, so the card,
 * which stays until the person acts, never covers it (walk D58).
 */
export function completedCardTop(doc: Document = document): number {
  const columnLeft = window.innerWidth - 16 - PANEL_WIDTH
  let top = COMPLETED_TOP
  for (const el of doc.querySelectorAll("[data-tour-keep-clear]")) {
    const r = el.getBoundingClientRect()
    // Empty, left of the card's column, or above the card: nothing to keep clear of.
    if (r.bottom <= r.top || r.right <= columnLeft || r.bottom <= COMPLETED_TOP) continue
    top = Math.max(top, Math.ceil(r.bottom) + 8)
  }
  return top
}

/** Shown once when a tour completes, then the panel closes to nothing. */
export const TourCompleted: Component<{ tour: Tour; progress: TourProgress; phone: boolean }> = (
  props,
) => {
  const i18n = useI18n()
  const [top, setTop] = createSignal(props.phone ? COMPLETED_TOP : completedCardTop())
  onMount(() => {
    if (props.phone) return
    const place = () => setTop(completedCardTop())
    const timer = setInterval(place, COMPLETED_PLACE_MS)
    window.addEventListener("resize", place)
    onCleanup(() => {
      clearInterval(timer)
      window.removeEventListener("resize", place)
    })
  })
  const skipped = () =>
    Object.values(props.progress.beatStates).filter((s) => s === "skipped").length
  return (
    <section
      data-testid="tour-completed"
      data-kb-top-layer=""
      data-tour-ui=""
      data-tour-id={props.tour.id}
      class={cn(
        "pointer-events-auto fixed z-[58] flex items-start gap-2 border border-border-subtle bg-bg p-4 shadow-lg",
        props.phone ? "inset-x-2 rounded-lg" : "right-4 rounded-lg",
      )}
      style={
        props.phone
          ? { bottom: PHONE_SHEET_BOTTOM }
          : { top: `${top()}px`, width: `${PANEL_WIDTH}px` }
      }
    >
      <div class="min-w-0 flex-1">
        <p class="text-[14px] font-semibold text-text">
          {i18n.t("tours.engine.completed", { tour: i18n.t(props.tour.title) })}
        </p>
        <Show when={skipped() > 0}>
          <p data-testid="tour-completed-skipped" class="text-[12.5px] text-text-tertiary">
            {i18n.t(
              pluralFormFor(i18n.locale(), skipped()) === "one"
                ? "tours.engine.completedSkippedOne"
                : "tours.engine.completedSkippedOther",
              { count: skipped() },
            )}
          </p>
        </Show>
        <Show when={tourCompletedAction()}>
          {(action) => {
            const Action = action()
            return <Action tour={props.tour} progress={props.progress} />
          }}
        </Show>
      </div>
      <button
        type="button"
        data-testid="tour-completed-close"
        aria-label={i18n.t("tours.engine.close")}
        onClick={() => tourStore.dismissCompleted()}
        class="flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-text-tertiary hover:bg-surface-hover"
      >
        <X size={16} />
      </button>
    </section>
  )
}
