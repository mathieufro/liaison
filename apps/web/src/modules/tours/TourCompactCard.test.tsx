// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The compact scenario card (D40): the scenario name, progress as dots and
// close on one line; the title, one grey line of why, the one thing to do
// now, the request folded to two lines; the main action and at most one
// other on the card, and the rest (Take me there, Play whole scenario,
// Pause, Skip) in its ⋯ menu.
import { defineTour, type TourProgress } from "@liaison/shared"
import { cleanup, fireEvent, render, screen, waitFor } from "@solidjs/testing-library"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { closeTourMenu, openTourMenu, pressTourMenuItem } from "./test-helpers"
import type { TourApi } from "./tour-api"

vi.mock("~/modules/shell/shell-tier", () => ({ shellTier: () => "desktop" }))
vi.mock("~/framework/spa-navigate", () => ({ spaNavigate: vi.fn() }))
vi.mock("~/modules/shell/dock-store", () => ({ putAwayWindows: vi.fn() }))
const fixtures = vi.hoisted(() => ({ tours: [] as unknown[] }))
vi.mock("./tour-catalog", () => ({
  resolveTour: (id: string) => (fixtures.tours as { id: string }[]).find((t) => t.id === id),
}))

const { resetTourStore, setTourApi, tourStore } = await import("./tour-store")
const { TourOverlay } = await import("./TourHost")

const tour = defineTour({
  id: "kernel.fixture-compact",
  app: "kernel",
  title: "tours.knowledge.basics.title",
  summary: "tours.knowledge.basics.summary",
  beats: [
    {
      id: "ask",
      kind: "do",
      title: "tours.knowledge.basics.create.title",
      body: "tours.knowledge.basics.create.body",
      role: "tours.knowledge.basics.recent.body",
      anchor: "fixture-composer",
      route: "/knowledge",
      say: {
        lead: "tours.knowledge.basics.create.title",
        text: "tours.knowledge.basics.create.body",
      },
      event: {
        app: "kernel",
        entity: "message",
        action: "create",
        match: { threadType: "agent_chat" },
      },
      autoplay: [
        { type: { testid: "fixture-composer", text: "tours.knowledge.basics.create.body" } },
        { click: "fixture-send" },
      ],
    },
    {
      id: "done",
      kind: "show",
      title: "tours.knowledge.basics.recent.title",
      body: "tours.knowledge.basics.recent.body",
    },
  ],
})

const at = "2026-10-26T10:00:00.000Z"
const progress = (): TourProgress => ({
  tourId: tour.id,
  status: "active",
  beatId: "ask",
  beatIndex: 0,
  beatCount: 2,
  beatStates: {},
  source: "help",
  startedAt: at,
  updatedAt: at,
})

function api(): TourApi & { update: ReturnType<typeof vi.fn> } {
  return {
    list: vi.fn(async () => [
      {
        tourId: tour.id,
        app: "kernel",
        title: tour.title,
        summary: tour.summary,
        beatCount: 2,
        progress: progress(),
      },
    ]),
    start: vi.fn(async () => progress()),
    update: vi.fn(async () => ({ ...progress(), status: "paused" as const })),
    progress: vi.fn(async () => progress()),
  }
}

async function mount(): Promise<ReturnType<typeof api>> {
  const a = api()
  setTourApi(a)
  render(() => <TourOverlay />)
  await tourStore.load()
  await screen.findByTestId("tour-panel")
  return a
}

beforeEach(() => {
  fixtures.tours = [tour]
  resetTourStore()
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  document.body.innerHTML = ""
})

describe("the compact scenario card", () => {
  it("keeps the main action and one other on the card, and the rest in its ⋯ menu", async () => {
    await mount()
    // On the card: Do it for me, I'll do it, and ⋯.
    expect(screen.getByTestId("tour-do-for-me")).toBeTruthy()
    expect(screen.getByTestId("tour-do-myself")).toBeTruthy()
    for (const moved of ["tour-take-me-there", "tour-play-all", "tour-pause", "tour-skip"]) {
      expect(screen.queryByTestId(moved)).toBeNull()
    }
    const more = screen.getByTestId("tour-more")
    expect(more.getAttribute("aria-label")).toBe("More actions")
    // In ⋯: Take me there (the composer is not on screen), Play, Pause, Skip.
    const menu = await openTourMenu()
    for (const moved of ["tour-take-me-there", "tour-play-all", "tour-pause", "tour-skip"]) {
      expect(menu.querySelector(`[data-testid="${moved}"]`)).not.toBeNull()
    }
    // The menu is part of the tour's own UI: never an obstacle the card avoids.
    expect(menu.hasAttribute("data-tour-ui")).toBe(true)
    await closeTourMenu()
  })

  it("Pause from the ⋯ menu pauses the scenario", async () => {
    const a = await mount()
    await pressTourMenuItem("tour-pause")
    await waitFor(() => expect(a.update).toHaveBeenCalledWith(tour.id, { status: "paused" }))
    await screen.findByTestId("tour-chip")
  })

  it("shows the request in full, never clamped: it is the sentence the person may type", async () => {
    await mount()
    const say = screen.getByTestId("tour-beat-say")
    expect(say.className).not.toMatch(/line-clamp|truncate/)
    expect(say.textContent).toContain("helps you write a document from a page")
    // A card taller than the window scrolls its body; nothing is cut.
    expect(screen.getByTestId("tour-panel-body").className).toContain("overflow-y-auto")
    expect(screen.getByTestId("tour-panel").style.maxHeight).toContain("100dvh")
  })

  it("moves by its header, stays there on the next step, and Reset puts it back", async () => {
    const a = await mount()
    const panel = screen.getByTestId("tour-panel")
    const handle = screen.getByTestId("tour-panel-handle")
    expect(handle.className).toContain("cursor-grab")
    vi.spyOn(panel, "getBoundingClientRect").mockReturnValue({
      top: 500,
      left: 80,
      width: 330,
      height: 240,
      bottom: 740,
      right: 410,
    } as DOMRect)
    fireEvent.pointerDown(handle, { pointerId: 1, button: 0, clientX: 100, clientY: 510 })
    fireEvent.pointerMove(handle, { pointerId: 1, clientX: 400, clientY: 210 })
    fireEvent.pointerUp(handle, { pointerId: 1, clientX: 400, clientY: 210 })
    expect(panel.hasAttribute("data-moved")).toBe(true)
    expect(panel.style.left).toBe("380px")
    expect(panel.style.top).toBe("200px")
    expect(panel.style.bottom).toBe("")
    // Off screen is clamped back in.
    fireEvent.pointerDown(handle, { pointerId: 2, button: 0, clientX: 100, clientY: 510 })
    fireEvent.pointerMove(handle, { pointerId: 2, clientX: 5000, clientY: -500 })
    fireEvent.pointerUp(handle, { pointerId: 2 })
    expect(panel.style.left).toBe(`${window.innerWidth - 330}px`)
    expect(panel.style.top).toBe("0px")
    // A press on the header's buttons is no drag.
    fireEvent.pointerDown(screen.getByTestId("tour-end"), {
      pointerId: 3,
      button: 0,
      clientX: 0,
      clientY: 0,
    })
    fireEvent.pointerMove(handle, { pointerId: 3, clientX: 300, clientY: 300 })
    expect(panel.style.top).toBe("0px")
    // The next step keeps the moved position.
    a.update.mockResolvedValueOnce({ ...progress(), beatId: "done", beatIndex: 1 })
    await tourStore.next()
    await waitFor(() => expect(screen.getByTestId("tour-panel").dataset.beatId).toBe("done"))
    expect(screen.getByTestId("tour-panel").style.top).toBe("0px")
    // Reset card position, from the ⋯ menu, gives it back to auto placement.
    await pressTourMenuItem("tour-reset-position")
    await waitFor(() =>
      expect(screen.getByTestId("tour-panel").hasAttribute("data-moved")).toBe(false),
    )
  })

  it("says why in one grey line, and progress as dots named for a screen reader", async () => {
    await mount()
    const role = screen.getByTestId("tour-beat-role")
    expect(role.className).not.toContain("bg-surface-sunken")
    expect(role.className).toContain("text-text-tertiary")
    const steps = screen.getByTestId("tour-step-count")
    expect(steps.getAttribute("aria-label")).toBe("Step 1 of 2")
    expect(steps.querySelectorAll("span.rounded-full")).toHaveLength(2)
    expect(steps.textContent).toBe("Step 1 of 2")
  })
})
