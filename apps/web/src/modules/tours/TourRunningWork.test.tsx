// SPDX-License-Identifier: FSL-1.1-ALv2
//
// A do step that only waits on work already running on its own (the Developers
// scenario's recorded session playing, the Sales scenario's routine running)
// had "Do it for me" and "I'll do it" on its card, with nothing for the person
// to do. It reads like a step waiting on the agent's reply: the working line
// with its spinner, Next held until the work is done, and no action buttons.
// "Do it for me" (it opens where the work shows) stays in the ⋯ menu. A step
// the person completes themselves while a routine runs (approving its draft)
// keeps its buttons.
import {
  type EffectiveBeat,
  effectiveBeats,
  SCENARIO_TOURS,
  type TourProgress,
} from "@liaison/shared"
import { cleanup, render, screen, within } from "@solidjs/testing-library"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { I18nProvider } from "~/modules/i18n/i18n-context"
import { closeTourMenu, tourMenuItem } from "./test-helpers"

vi.mock("~/modules/shell/shell-tier", () => ({ shellTier: () => "desktop" }))
vi.mock("~/framework/spa-navigate", () => ({ spaNavigate: vi.fn() }))

const { resetTourStore } = await import("./tour-store")
const { TourPanel, ROUTINE_START_GRACE_MS } = await import("./TourPanel")

function scenarioBeat(tourId: string, beatId: string) {
  const tour = SCENARIO_TOURS.find((t) => t.id === tourId)
  if (!tour) throw new Error(`no scenario ${tourId}`)
  const beats = effectiveBeats(tour, {
    installedApps: tour.beats.flatMap((b) => (b.optional?.whenApp ? [b.optional.whenApp] : [])),
    isDemo: true,
  })
  const beat = beats.find((b) => b.id === beatId)
  if (!beat) throw new Error(`no beat ${beatId} in ${tourId}`)
  return { tour, beat, beatCount: beats.length, beatIndex: beats.indexOf(beat) }
}

function renderBeat(tourId: string, beatId: string) {
  const { tour, beat, beatCount, beatIndex } = scenarioBeat(tourId, beatId)
  const at = "2026-10-27T10:00:00.000Z"
  const progress: TourProgress = {
    tourId: tour.id,
    status: "active",
    beatId: beat.id,
    beatIndex,
    beatCount,
    beatStates: {},
    source: "help",
    startedAt: at,
    updatedAt: at,
  }
  render(() => (
    <I18nProvider initialLocale="en">
      <TourPanel
        tour={tour}
        progress={progress}
        beat={beat as EffectiveBeat}
        anchorVisible={true}
        atRoute={true}
        phone={false}
        onDoItForMe={() => {}}
        onTakeMeThere={() => {}}
        onPlayAll={() => {}}
        onStopPlaying={() => {}}
      />
    </I18nProvider>
  ))
  return screen.getByTestId("tour-panel")
}

/** The card itself, the ⋯ menu aside. */
function onCard(panel: HTMLElement, testid: string): HTMLElement | null {
  const el = within(panel).queryByTestId(testid)
  return el && !el.closest('[data-testid="tour-menu"]') ? el : null
}

beforeEach(() => resetTourStore())
afterEach(cleanup)

describe("a step waiting on work running on its own", () => {
  // `opens`: the step has somewhere to show the work. The sales routine's run
  // is waited for where the visitor is, with no trip to Routines.
  for (const [tourId, beatId, line, opens] of [
    [
      "kernel.scenario-dev",
      "stream",
      "The recorded session is playing. This step moves on when it gets there.",
      true,
    ],
    [
      "kernel.scenario-sales",
      "researching",
      "The routine is running. This step moves on when it has finished.",
      false,
    ],
  ] as const) {
    it(`${tourId} ${beatId}: the working line, no action buttons, Next held`, async () => {
      const panel = renderBeat(tourId, beatId)
      const working = within(panel).getByTestId("tour-working")
      expect(working.getAttribute("data-tour-status")).toBe("working")
      expect(working.textContent).toBe(line)
      expect(onCard(panel, "tour-do-for-me")).toBeNull()
      expect(onCard(panel, "tour-do-myself")).toBeNull()
      expect((within(panel).getByTestId("tour-next") as HTMLButtonElement).disabled).toBe(true)
      // Opening where the work shows is still offered, out of the way.
      expect(await tourMenuItem("tour-do-for-me")).toEqual(opens ? expect.anything() : null)
      await closeTourMenu()
    })
  }

  it("a routine whose run never shows up says it has not started and offers Skip this step", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "Date"] })
    try {
      const panel = renderBeat("kernel.scenario-sales", "researching")
      expect(onCard(panel, "tour-skip-beat")).toBeNull()
      await vi.advanceTimersByTimeAsync(ROUTINE_START_GRACE_MS + 2_000)
      expect(within(panel).getByTestId("tour-working").textContent).toBe(
        "The routine has not started. Skip this step to go on.",
      )
      expect(onCard(panel, "tour-skip-beat")).not.toBeNull()
    } finally {
      vi.useRealTimers()
    }
  })

  it("a routine's draft the person approves keeps its buttons", () => {
    const panel = renderBeat("kernel.scenario-support", "approve")
    expect(within(panel).queryByTestId("tour-working")).toBeNull()
    expect(onCard(panel, "tour-do-for-me")).not.toBeNull()
    expect(onCard(panel, "tour-do-myself")).not.toBeNull()
  })
})
