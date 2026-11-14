// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The demo's guided scenarios, one per need the visitor picked, played in
// pick order through the ordinary tour engine: the welcome popup
// (DemoWelcome.tsx) offers them and the runner sequences them.
//
// Nothing here is a second tour engine. The queue and each scenario's progress
// come from `GET /api/demo/scenarios` (the tour engine's own progress rows);
// starting, pausing (the tour chip) and "Do it for me" are the tour store's.
// What the runner adds:
//  - the queue the welcome popup reads; nothing starts on load: a scenario
//    starts only when the visitor starts it, since a run asks the agent and
//    spends;
//  - the completion card offers "Next: <scenario>": the visitor's click
//    starts it, or resumes it when it is unfinished (never a second run of
//    it); nothing goes on by itself after a whole-scenario play. After the
//    last one the next-steps dialog replaces the card (DemoNextSteps.tsx);
//  - the world-beat gates it owns: `failed` (Retry, the scenarios retry route)
//    and `budget` (it opens the next-steps dialog). The `verify` gate is the
//    email-code prompt's, registered by the demo host.
import type { DemoNeed, TourBeatGate, TourStatus } from "@liaison/shared"
import {
  type Component,
  createEffect,
  createMemo,
  createSignal,
  on,
  onCleanup,
  onMount,
  Show,
} from "solid-js"
import { sessionOrgId } from "~/modules/auth/auth-store"
import { openDemoNextSteps } from "~/modules/demo/demo-store"
import { useI18n } from "~/modules/i18n/i18n-context"
import { useOptionalApi } from "~/modules/shell/ApiContext"
import { putAwayWindows } from "~/modules/shell/dock-store"
import {
  registerTourBeatGate,
  registerTourCompletedAction,
  type TourBeatGateProps,
  type TourCompletedActionProps,
} from "~/modules/tours/beat-gates"
import { resolveTour } from "~/modules/tours/tour-catalog"
import { tourStore } from "~/modules/tours/tour-store"
import { Button } from "~/ui/Button"

/** One scenario in the queue (`GET /api/demo/scenarios`, scenarios-routes.ts). */
export interface DemoScenarioItem {
  need: DemoNeed
  tourId: string
  status: TourStatus | "new"
  beatIndex: number
  beatCount: number
  /** Played once: it offers "Start over" once played, never to start it again. */
  singleRun?: true
}

type ApiClient = NonNullable<ReturnType<typeof useOptionalApi>>

/** The queue as last read, with the org it was read in. */
const [read, setRead] = createSignal<{ orgId: string | null; items: DemoScenarioItem[] } | null>(
  null,
)
let client: ApiClient | null = null

/** The queue has been read for the org the session is in (another org's is not this one's). */
function loaded(): boolean {
  const r = read()
  return r !== null && r.orgId === sessionOrgId()
}

/** The visitor's scenarios in pick order, as last read for this org. */
function queue(): DemoScenarioItem[] {
  return loaded() ? (read()?.items ?? []) : []
}

export { loaded as demoScenarioQueueLoaded, queue as demoScenarioQueue }

/** Re-read the queue (after a start, a completion, a retry, another org). */
async function reloadQueue(): Promise<void> {
  if (!client) return
  const orgId = sessionOrgId()
  try {
    const items = await client.get<DemoScenarioItem[]>("/demo/scenarios")
    if (sessionOrgId() === orgId) setRead({ orgId, items })
  } catch {
    // The banner entry simply shows nothing until the next read.
  }
}

/** The scenarios a visitor can still play, in pick order, `after` excluded. */
export function nextScenario(
  items: readonly DemoScenarioItem[],
  after?: string,
): DemoScenarioItem | undefined {
  return items.find(
    (item) => item.tourId !== after && item.status !== "completed" && resolveTour(item.tourId),
  )
}

async function startScenario(tourId: string): Promise<void> {
  // A chat window the last scenario left open would cover this one's elements.
  putAwayWindows()
  await tourStore.start(tourId, "demo")
  void reloadQueue()
}

/** Resume, start or replay one scenario (the welcome popup's Start, the card's Next). */
export async function openScenario(item: DemoScenarioItem): Promise<void> {
  if (item.status === "active" || item.status === "paused") {
    putAwayWindows()
    await tourStore.resume(item.tourId, "demo")
    void reloadQueue()
    return
  }
  await startScenario(item.tourId)
}

/**
 * After the visitor's last scenario the next-steps dialog takes the completion
 * card's place: the card closes as the dialog opens (before a frame is painted).
 */
const LastScenarioDone: Component = () => {
  onMount(() => {
    tourStore.dismissCompleted()
    openDemoNextSteps("end")
  })
  return null
}

/** The completion card's follow-up: the next scenario, or the next-steps dialog after the last one. */
const NextScenarioAction: Component<TourCompletedActionProps> = (props) => {
  const i18n = useI18n()
  const next = () => (props.tour.demoOnly ? nextScenario(queue(), props.tour.id) : undefined)
  return (
    <Show
      when={next()}
      fallback={
        <Show when={props.tour.demoOnly && loaded()}>
          <LastScenarioDone />
        </Show>
      }
    >
      {(item) => {
        const tour = resolveTour(item().tourId)
        return (
          <Button
            size="sm"
            class="mt-2"
            data-testid="demo-scenario-next"
            data-tour-id={item().tourId}
            // Resumed when unfinished: starting it again would be a second run (D43).
            onClick={() => void openScenario(item())}
          >
            {i18n.t("tours.engine.nextScenario", { tour: tour ? i18n.t(tour.title) : "" })}
          </Button>
        )
      }}
    </Show>
  )
}

/** `gate: failed`: the live event did not go through; Retry runs it again. */
const FailedGate: Component<TourBeatGateProps> = (props) => {
  const i18n = useI18n()
  const [busy, setBusy] = createSignal(false)
  const retry = async () => {
    if (!client) return
    setBusy(true)
    tourStore.clearGate()
    try {
      await client.post(`/demo/scenarios/${encodeURIComponent(props.tour.id)}/retry`, {})
    } catch {
      // A refused retry leaves the beat waiting; its next frame says why.
    } finally {
      setBusy(false)
    }
  }
  return (
    <div class="flex flex-col gap-2">
      <p class="text-[13px] text-text-secondary">{i18n.t("tours.engine.gateFailed")}</p>
      <div>
        <Button
          size="sm"
          variant="outline"
          data-testid="tour-gate-retry"
          disabled={busy()}
          onClick={() => void retry()}
        >
          {i18n.t("tours.engine.retry")}
        </Button>
      </div>
    </div>
  )
}

/** `gate: budget`: the demo budget is used up; the next-steps dialog says what next. */
const BudgetGate: Component<TourBeatGateProps> = () => {
  const i18n = useI18n()
  return (
    <div class="flex flex-col gap-2">
      <p class="text-[13px] text-text-secondary">{i18n.t("tours.engine.gateBudget")}</p>
      <div>
        <Button
          size="sm"
          variant="outline"
          data-testid="tour-gate-budget"
          onClick={() => openDemoNextSteps("budget")}
        >
          {i18n.t("tours.engine.gateBudgetLink")}
        </Button>
      </div>
    </div>
  )
}

const OWN_GATES: ReadonlyArray<[TourBeatGate, Component<TourBeatGateProps>]> = [
  ["failed", FailedGate],
  ["budget", BudgetGate],
]

/** Starts and sequences the visitor's scenarios. Mounted once, in DemoHost. */
export const DemoScenarioRunner: Component = () => {
  const api = useOptionalApi()

  onMount(() => {
    if (!api) return
    client = api
    const unregister = [
      // The card offering the next scenario, or what next after the last
      // one (always with "Continue exploring"), stays until the visitor acts
      // (walk D45).
      registerTourCompletedAction(NextScenarioAction, (tour) => tour.demoOnly === true),
      ...OWN_GATES.map(([gate, component]) => registerTourBeatGate(gate, component)),
    ]
    onCleanup(() => {
      for (const off of unregister) off()
      client = null
    })
  })

  // Read on mount, and again for each org the session moves to.
  const org = createMemo(sessionOrgId)
  createEffect(on(org, () => void reloadQueue()))

  // A scenario completed: refresh the queue (the card's Next reads it). The
  // next one waits for the visitor, even after a whole-scenario play.
  createEffect(
    on(
      () => tourStore.completed?.tourId,
      async (doneId) => {
        if (!doneId || !resolveTour(doneId)?.demoOnly) return
        await reloadQueue()
      },
    ),
  )

  // Keep the banner's k/n current as tours move.
  createEffect(
    on(
      () => [tourStore.current?.tourId, tourStore.current?.status] as const,
      () => void reloadQueue(),
      { defer: true },
    ),
  )

  return null
}

/** Test seam: reset the module's queue between tests. */
export const DemoScenarioRunnerTestAccess = {
  reset(): void {
    setRead(null)
    client = null
  },
}
