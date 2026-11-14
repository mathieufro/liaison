// SPDX-License-Identifier: FSL-1.1-ALv2
//
// P3-T6: the tour engine's on-screen states (S22): not started, active,
// paused (chip), waiting for the event, anchor not on screen (Take me there /
// waiting to appear), completed (shown once) and abandoned, against a fake
// tour API. One tour on screen at a time; never a panel and a chip together.
import { defineTour, type TourListItem, type TourProgress } from "@liaison/shared"
import { cleanup, fireEvent, render, screen, waitFor } from "@solidjs/testing-library"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { pressTourMenuItem, tourMenuItem } from "./test-helpers"
import type { TourApi } from "./tour-api"

const tier = vi.hoisted(() => ({ value: "desktop" as "desktop" | "tablet" | "phone" }))
vi.mock("~/modules/shell/shell-tier", () => ({ shellTier: () => tier.value }))

const nav = vi.hoisted(() => ({ spaNavigate: vi.fn() }))
vi.mock("~/framework/spa-navigate", () => nav)

const dock = vi.hoisted(() => ({ putAwayWindows: vi.fn() }))
vi.mock("~/modules/shell/dock-store", () => dock)

const fixtures = vi.hoisted(() => ({ tours: [] as unknown[] }))
vi.mock("./tour-catalog", () => ({
  resolveTour: (id: string) => (fixtures.tours as { id: string }[]).find((t) => t.id === id),
}))

const { applyProgress, resetTourStore, setTourApi, tourStore } = await import("./tour-store")
const { TourOverlay } = await import("./TourHost")

const tour = defineTour({
  id: "kernel.demo",
  app: "kernel",
  title: "tours.kernel.sample.title",
  summary: "tours.kernel.sample.summary",
  beats: [
    {
      id: "welcome",
      kind: "show",
      title: "tours.kernel.sample.welcome.title",
      body: "tours.kernel.sample.welcome.body",
      anchor: "fixture-anchor",
      anchorPhone: "fixture-anchor-phone",
    },
    {
      id: "post",
      kind: "do",
      title: "tours.kernel.sample.postMessage.title",
      body: "tours.kernel.sample.postMessage.body",
      anchor: "fixture-elsewhere",
      route: "/threads",
      event: { app: "kernel", entity: "message", action: "create" },
      autoplay: [{ click: "fixture-elsewhere" }],
    },
    {
      id: "last",
      kind: "show",
      title: "tours.kernel.sample.ticketsInbox.title",
      body: "tours.kernel.sample.ticketsInbox.body",
      anchor: "fixture-never",
    },
  ],
})
const other = defineTour({ ...tour, id: "kernel.other" })
/** The same beats as a demo scenario: its routed beats start with the chat windows put away. */
const scenario = defineTour({ ...tour, id: "kernel.scenario-fixture", demoOnly: true })
/** A live arrival, then the step that shows the very entity it recorded (walk D51). */
const arrival = defineTour({
  id: "kernel.arrival",
  app: "kernel",
  demoOnly: true,
  title: "tours.kernel.sample.title",
  summary: "tours.kernel.sample.summary",
  beats: [
    {
      id: "arrive",
      kind: "world",
      title: "tours.kernel.sample.welcome.title",
      body: "tours.kernel.sample.welcome.body",
      injector: "fixture-injector",
      anchor: "fixture-list",
    },
    {
      id: "open",
      kind: "show",
      title: "tours.kernel.sample.welcome.title",
      body: "tours.kernel.sample.welcome.body",
      anchor: "fixture-row-{arrive}",
    },
  ],
})
/** A step pointing at what the agent's answer brings (its sources): it waits on the agent. */
const answer = defineTour({
  id: "kernel.answer",
  app: "kernel",
  title: "tours.kernel.sample.title",
  summary: "tours.kernel.sample.summary",
  beats: [
    {
      id: "sources",
      kind: "show",
      title: "tours.kernel.sample.welcome.title",
      body: "tours.kernel.sample.welcome.body",
      anchor: "fixture-citations",
      waitsOn: "agent",
    },
    {
      id: "after",
      kind: "show",
      title: "tours.kernel.sample.welcome.title",
      body: "tours.kernel.sample.welcome.body",
    },
  ],
})
/** Ask in the dock beside a screen, then watch the agent on that same screen. */
const sameScreen = defineTour({
  id: "kernel.scenario-same-screen",
  app: "kernel",
  demoOnly: true,
  title: "tours.kernel.sample.title",
  summary: "tours.kernel.sample.summary",
  beats: [
    {
      id: "ask",
      kind: "show",
      title: "tours.kernel.sample.welcome.title",
      body: "tours.kernel.sample.welcome.body",
      anchor: "fixture-anchor",
      route: "/threads",
    },
    {
      id: "watch",
      kind: "show",
      title: "tours.kernel.sample.welcome.title",
      body: "tours.kernel.sample.welcome.body",
      anchor: "fixture-anchor",
      route: "/threads",
    },
  ],
})
/** Watch the agent in the dock beside a screen, then point back at the screen itself. */
const dockThenScreen = defineTour({
  id: "kernel.scenario-dock-then-screen",
  app: "kernel",
  demoOnly: true,
  title: "tours.kernel.sample.title",
  summary: "tours.kernel.sample.summary",
  beats: [
    {
      id: "watch",
      kind: "show",
      title: "tours.kernel.sample.welcome.title",
      body: "tours.kernel.sample.welcome.body",
      anchor: "fixture-anchor",
      path: [{ label: "tours.kernel.sample.welcome.title", anchor: "dock-chats" }],
      route: "/threads",
    },
    {
      id: "review",
      kind: "show",
      title: "tours.kernel.sample.welcome.title",
      body: "tours.kernel.sample.welcome.body",
      anchor: "fixture-anchor",
      route: "/threads",
    },
  ],
})
const ownConversation = defineTour({
  ...tour,
  id: "kernel.own-conversation",
  talksToAgent: true,
})

function progress(over: Partial<TourProgress> = {}): TourProgress {
  return {
    tourId: "kernel.demo",
    status: "active",
    beatId: "welcome",
    beatIndex: 0,
    beatCount: 3,
    beatStates: {},
    source: "help",
    startedAt: "2026-10-23T10:00:00.000Z",
    updatedAt: "2026-10-23T10:00:00.000Z",
    ...over,
  }
}

function item(p: TourProgress | null, tourId = "kernel.demo"): TourListItem {
  return {
    tourId,
    app: "kernel",
    title: tour.title,
    summary: tour.summary,
    beatCount: 3,
    progress: p,
  }
}

function fakeApi(over: Partial<TourApi> = {}): TourApi & { calls: unknown[][] } {
  const calls: unknown[][] = []
  const api: TourApi = {
    list: vi.fn(async () => []),
    start: vi.fn(async (id: string) => progress({ tourId: id })),
    update: vi.fn(async (id: string, body) => {
      calls.push(["update", id, body])
      return progress({ tourId: id })
    }),
    progress: vi.fn(async (id: string) => progress({ tourId: id })),
    ...over,
  }
  return Object.assign(api, { calls })
}

/** A box for every element unless it opts out (jsdom lays nothing out). */
function stubLayout() {
  vi.spyOn(HTMLElement.prototype, "getClientRects").mockImplementation(function (
    this: HTMLElement,
  ) {
    const noBox = this.hasAttribute("data-no-box")
    return (noBox ? [] : [{}]) as unknown as DOMRectList
  })
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(
    () => ({ top: 10, left: 20, width: 100, height: 30, bottom: 40, right: 120 }) as DOMRect,
  )
}

beforeEach(() => {
  fixtures.tours = [tour, other, scenario]
  dock.putAwayWindows.mockReset()
  tier.value = "desktop"
  resetTourStore()
  stubLayout()
  nav.spaNavigate.mockReset()
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  vi.useRealTimers()
  document.body.innerHTML = ""
})

describe("tour engine states", () => {
  it("not started: nothing on screen", async () => {
    setTourApi(fakeApi({ list: vi.fn(async () => [item(null)]) }))
    render(() => <TourOverlay />)
    await tourStore.load()
    expect(screen.queryByTestId("tour-panel")).toBeNull()
    expect(screen.queryByTestId("tour-chip")).toBeNull()
  })

  it("active show beat: the panel, step k/n, a spotlight on the visible anchor, Next advances", async () => {
    const anchor = document.createElement("button")
    anchor.dataset.testid = "fixture-anchor"
    document.body.append(anchor)
    const api = fakeApi({ list: vi.fn(async () => [item(progress())]) })
    setTourApi(api)
    render(() => <TourOverlay />)
    await tourStore.load()

    const panel = await screen.findByTestId("tour-panel")
    expect(panel.dataset.beatId).toBe("welcome")
    // Progress as dashes with the step in words beside them, named for a screen reader too.
    const steps = screen.getByTestId("tour-step-count")
    expect(steps.getAttribute("aria-label")).toBe("Step 1 of 3")
    expect(steps.querySelectorAll("span[aria-hidden='true'].rounded-full")).toHaveLength(3)
    expect(steps.textContent).toBe("Step 1 of 3")
    expect(screen.getByTestId("tour-beat-title").textContent).toBe("Your apps")
    const spot = await screen.findByTestId("tour-spotlight")
    expect(spot.dataset.anchor).toBe("fixture-anchor")
    expect(spot.style.pointerEvents === "" || spot.className.includes("pointer-events-none")).toBe(
      true,
    )
    expect(screen.queryByTestId("tour-chip")).toBeNull()
    // Usable over a dialog the beat opens: above the z-50 overlays, and
    // clickable through a modal's disabled outside pointer events.
    expect(panel.className).toContain("pointer-events-auto")
    expect(panel.className).toContain("z-[58]")
    expect(panel.hasAttribute("data-kb-top-layer")).toBe(true)

    fireEvent.click(screen.getByTestId("tour-next"))
    await waitFor(() =>
      expect(api.calls).toContainEqual([
        "update",
        "kernel.demo",
        { advance: true, fromBeatId: "welcome" },
      ]),
    )
  })

  /** Lay `testid` out at `rect` (every other element keeps the stub's box). */
  function placeAt(
    testid: string,
    rect: { top: number; left: number; width: number; height: number },
  ) {
    const box = { ...rect, bottom: rect.top + rect.height, right: rect.left + rect.width }
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (
      this: HTMLElement,
    ) {
      return (
        this.dataset.testid === testid
          ? box
          : { top: 10, left: 20, width: 100, height: 30, bottom: 40, right: 120 }
      ) as DOMRect
    })
  }

  /** Lay out several elements by testid (every other element keeps the stub's box). */
  function layOut(
    boxes: Record<string, { top: number; left: number; width: number; height: number }>,
  ) {
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (
      this: HTMLElement,
    ) {
      const r = boxes[this.dataset.testid ?? ""] ?? { top: 10, left: 20, width: 100, height: 30 }
      return { ...r, bottom: r.top + r.height, right: r.left + r.width } as DOMRect
    })
  }

  it("desktop: the card sits bottom left, and leaves that corner when the spotlit element is there", async () => {
    // jsdom's viewport is 1024 x 768: the anchor sits under the bottom-left corner.
    placeAt("fixture-anchor", { top: 680, left: 70, width: 300, height: 80 })
    const anchor = document.createElement("button")
    anchor.dataset.testid = "fixture-anchor"
    document.body.append(anchor)
    setTourApi(fakeApi({ list: vi.fn(async () => [item(progress())]) }))
    render(() => <TourOverlay />)
    await tourStore.load()
    await screen.findByTestId("tour-spotlight")
    await waitFor(() => expect(screen.getByTestId("tour-panel").dataset.placement).toBe("top-left"))
  })

  it("desktop: the card stays in the main panel area, never over the rail or the sidebar", async () => {
    // A chat open: the sidebar fills 64..360, the main panel the rest, and the
    // composer, ringed, lies under the main panel's bottom-left corner.
    layOut({
      "main-panel": { top: 0, left: 360, width: 664, height: 768 },
      "fixture-anchor": { top: 690, left: 380, width: 600, height: 60 },
    })
    const main = document.createElement("main")
    main.dataset.testid = "main-panel"
    const anchor = document.createElement("button")
    anchor.dataset.testid = "fixture-anchor"
    document.body.append(main, anchor)
    setTourApi(fakeApi({ list: vi.fn(async () => [item(progress())]) }))
    render(() => <TourOverlay />)
    await tourStore.load()
    await screen.findByTestId("tour-spotlight")
    const panel = screen.getByTestId("tour-panel")
    await waitFor(() => expect(panel.dataset.placement).toBe("top-left"))
    // Its corner of the main panel, not of the window: right of the sidebar.
    expect(Number.parseFloat(panel.style.left)).toBeGreaterThanOrEqual(360 + 16)
    expect(panel.style.width).toBe("330px")
    // The composer clear again: back to the bottom left, still in the main panel.
    layOut({ "main-panel": { top: 0, left: 360, width: 664, height: 768 } })
    anchor.remove()
    await waitFor(() => expect(panel.dataset.placement).toBe("bottom-left"), { timeout: 2000 })
    expect(Number.parseFloat(panel.style.left)).toBeGreaterThanOrEqual(360 + 16)
    expect(panel.style.bottom).not.toBe("")
  })

  it("phone: the sheet moves to the top when the spotlit bar is under it", async () => {
    tier.value = "phone"
    placeAt("fixture-anchor-phone", { top: 700, left: 0, width: 1024, height: 60 })
    const anchor = document.createElement("div")
    anchor.dataset.testid = "fixture-anchor-phone"
    document.body.append(anchor)
    setTourApi(fakeApi({ list: vi.fn(async () => [item(progress())]) }))
    render(() => <TourOverlay />)
    await tourStore.load()
    await screen.findByTestId("tour-spotlight")
    await waitFor(() => expect(screen.getByTestId("tour-panel").dataset.placement).toBe("top"))
  })

  it("phone: a sheet over every free area folds the panel to a strip until the step changes (D14)", async () => {
    tier.value = "phone"
    placeAt("fixture-sheet", { top: 0, left: 0, width: 1024, height: 768 })
    const anchor = document.createElement("div")
    anchor.dataset.testid = "fixture-anchor-phone"
    const sheet = document.createElement("div")
    sheet.dataset.testid = "fixture-sheet"
    sheet.setAttribute("role", "dialog")
    document.body.append(anchor, sheet)
    const api = fakeApi({
      list: vi.fn(async () => [item(progress())]),
      update: vi.fn(async () => progress({ beatId: "post", beatIndex: 1 })),
    })
    setTourApi(api)
    render(() => <TourOverlay />)
    await tourStore.load()
    const panel = await screen.findByTestId("tour-panel")
    await waitFor(() => expect(panel.dataset.collapsed).toBe(""))
    // The sheet closing does not unfold it mid-step; the person can.
    sheet.remove()
    await new Promise((r) => setTimeout(r, 600))
    expect(screen.getByTestId("tour-panel").dataset.collapsed).toBe("")
    fireEvent.click(screen.getByTestId("tour-fold"))
    await waitFor(() => expect(screen.getByTestId("tour-panel").dataset.collapsed).toBeUndefined())
    fireEvent.click(screen.getByTestId("tour-fold"))
    await waitFor(() => expect(screen.getByTestId("tour-panel").dataset.collapsed).toBe(""))
    // The step completes: the next one opens in full.
    fireEvent.click(screen.getByTestId("tour-next"))
    await waitFor(() => expect(screen.getByTestId("tour-panel").dataset.beatId).toBe("post"))
    expect(screen.getByTestId("tour-panel").dataset.collapsed).toBeUndefined()
  })

  it("the ring is not drawn while a later layer covers its anchor (D13)", async () => {
    const anchor = document.createElement("button")
    anchor.dataset.testid = "fixture-anchor"
    const sheet = document.createElement("div")
    document.body.append(anchor, sheet)
    let top: Element = anchor
    Object.defineProperty(document, "elementsFromPoint", {
      configurable: true,
      value: () => [top, document.body],
    })
    try {
      setTourApi(fakeApi({ list: vi.fn(async () => [item(progress())]) }))
      render(() => <TourOverlay />)
      await tourStore.load()
      await screen.findByTestId("tour-spotlight")
      top = sheet
      await waitFor(() => expect(screen.queryByTestId("tour-spotlight")).toBeNull())
      top = anchor
      await screen.findByTestId("tour-spotlight")
    } finally {
      Reflect.deleteProperty(document, "elementsFromPoint")
    }
  })

  it("the paused chip sits where it covers no control", async () => {
    const control = document.createElement("button")
    document.body.append(control)
    // A sidebar item under the bottom-left corner, nothing elsewhere.
    Object.defineProperty(document, "elementsFromPoint", {
      configurable: true,
      value: (x: number, y: number) => (x < 400 && y > 600 ? [control] : [document.body]),
    })
    try {
      setTourApi(fakeApi({ list: vi.fn(async () => [item(progress({ status: "paused" }))]) }))
      render(() => <TourOverlay />)
      await tourStore.load()
      const chip = await screen.findByTestId("tour-chip")
      await waitFor(() => expect(chip.dataset.placement).toBe("bottom-center"))
    } finally {
      Reflect.deleteProperty(document, "elementsFromPoint")
    }
  })

  it("phone: a page read beside the tour (the demo's budget) folds the sheet while it is open (D3)", async () => {
    tier.value = "phone"
    const anchor = document.createElement("div")
    anchor.dataset.testid = "fixture-anchor-phone"
    const page = document.createElement("div")
    page.setAttribute("data-tour-clear", "")
    document.body.append(anchor, page)
    setTourApi(fakeApi({ list: vi.fn(async () => [item(progress())]) }))
    render(() => <TourOverlay />)
    await tourStore.load()
    const panel = await screen.findByTestId("tour-panel")
    await waitFor(() => expect(panel.dataset.collapsed).toBe(""))
    // The person can still open it there; leaving the page opens it again.
    expect(screen.getByTestId("tour-fold")).toBeTruthy()
    page.remove()
    await waitFor(
      () => expect(screen.getByTestId("tour-panel").dataset.collapsed).toBeUndefined(),
      {
        timeout: 2000,
      },
    )
  })

  it("a demo scenario's beat with a screen of its own puts the chat windows away, one without a route leaves them (D13)", async () => {
    const api = fakeApi({
      list: vi.fn(async () => [
        item(progress({ tourId: scenario.id, beatId: "welcome" }), scenario.id),
      ]),
      update: vi.fn(async () => progress({ tourId: scenario.id, beatId: "post", beatIndex: 1 })),
    })
    setTourApi(api)
    const anchor = document.createElement("div")
    anchor.dataset.testid = "fixture-anchor"
    document.body.append(anchor)
    render(() => <TourOverlay />)
    await tourStore.load()
    await screen.findByTestId("tour-panel")
    // "welcome" has no route: an answer in the open window stays in view.
    expect(dock.putAwayWindows).not.toHaveBeenCalled()
    fireEvent.click(screen.getByTestId("tour-next"))
    await waitFor(() => expect(screen.getByTestId("tour-panel").dataset.beatId).toBe("post"))
    expect(dock.putAwayWindows).toHaveBeenCalledTimes(1)
  })

  it("a scenario beat on the same screen as the one before keeps the chat windows open", async () => {
    fixtures.tours = [...fixtures.tours, sameScreen]
    const api = fakeApi({
      list: vi.fn(async () => [
        item(progress({ tourId: sameScreen.id, beatId: "ask" }), sameScreen.id),
      ]),
      update: vi.fn(async () => progress({ tourId: sameScreen.id, beatId: "watch", beatIndex: 1 })),
    })
    setTourApi(api)
    const anchor = document.createElement("div")
    anchor.dataset.testid = "fixture-anchor"
    document.body.append(anchor)
    render(() => <TourOverlay />)
    await tourStore.load()
    await screen.findByTestId("tour-panel")
    // Arriving on the screen puts away what was left open.
    expect(dock.putAwayWindows).toHaveBeenCalledTimes(1)
    fireEvent.click(screen.getByTestId("tour-next"))
    await waitFor(() => expect(screen.getByTestId("tour-panel").dataset.beatId).toBe("watch"))
    // The next beat stays on that screen: the conversation the person asked in stays open.
    expect(dock.putAwayWindows).toHaveBeenCalledTimes(1)
  })

  it("back from the dock to the screen itself, the chat windows are put away", async () => {
    fixtures.tours = [...fixtures.tours, dockThenScreen]
    const api = fakeApi({
      list: vi.fn(async () => [
        item(progress({ tourId: dockThenScreen.id, beatId: "watch" }), dockThenScreen.id),
      ]),
      update: vi.fn(async () =>
        progress({ tourId: dockThenScreen.id, beatId: "review", beatIndex: 1 }),
      ),
    })
    setTourApi(api)
    const anchor = document.createElement("div")
    anchor.dataset.testid = "fixture-anchor"
    document.body.append(anchor)
    render(() => <TourOverlay />)
    await tourStore.load()
    await screen.findByTestId("tour-panel")
    expect(dock.putAwayWindows).toHaveBeenCalledTimes(1)
    fireEvent.click(screen.getByTestId("tour-next"))
    await waitFor(() => expect(screen.getByTestId("tour-panel").dataset.beatId).toBe("review"))
    // Same screen, but the beat points at the page the dock window covered.
    expect(dock.putAwayWindows).toHaveBeenCalledTimes(2)
  })

  it("an app tour never touches the chat windows", async () => {
    const api = fakeApi({
      list: vi.fn(async () => [item(progress({ beatId: "post", beatIndex: 1 }))]),
    })
    setTourApi(api)
    render(() => <TourOverlay />)
    await tourStore.load()
    await screen.findByTestId("tour-panel")
    expect(dock.putAwayWindows).not.toHaveBeenCalled()
  })

  // Walk D50: the Tickets tour's conversation window stayed open over the
  // mail list when the Mail tour, which talks to the agent, began.
  it("an app tour that talks to the agent puts the last run's windows away on a beat with a screen", async () => {
    fixtures.tours = [...fixtures.tours, ownConversation]
    const api = fakeApi({
      list: vi.fn(async () => [
        item(progress({ tourId: ownConversation.id, beatId: "welcome" }), ownConversation.id),
      ]),
      update: vi.fn(async () =>
        progress({ tourId: ownConversation.id, beatId: "post", beatIndex: 1 }),
      ),
    })
    setTourApi(api)
    const anchor = document.createElement("div")
    anchor.dataset.testid = "fixture-anchor"
    document.body.append(anchor)
    render(() => <TourOverlay />)
    await tourStore.load()
    await screen.findByTestId("tour-panel")
    expect(dock.putAwayWindows).not.toHaveBeenCalled()
    fireEvent.click(screen.getByTestId("tour-next"))
    await waitFor(() => expect(screen.getByTestId("tour-panel").dataset.beatId).toBe("post"))
    expect(dock.putAwayWindows).toHaveBeenCalledTimes(1)
  })

  // Walk D51: in manual mode the visitor passed the live ticket before it
  // existed, and "Her ticket is here" showed a list without it.
  it("a live arrival cannot be passed while it is coming: no Next, no Skip, it says it is watching", async () => {
    fixtures.tours = [...fixtures.tours, arrival]
    setTourApi(
      fakeApi({
        list: vi.fn(async () => [
          item(progress({ tourId: arrival.id, beatId: "arrive", beatCount: 2 }), arrival.id),
        ]),
      }),
    )
    render(() => <TourOverlay />)
    await tourStore.load()
    await screen.findByTestId("tour-panel")
    expect(screen.getByTestId("tour-world-watching")).toBeTruthy()
    expect(screen.queryByTestId("tour-next")).toBeNull()
    expect(await tourMenuItem("tour-skip")).toBeNull()
  })

  it("the step after an arrival shows the entity it recorded, and Next waits until it is on screen", async () => {
    fixtures.tours = [...fixtures.tours, arrival]
    const other = document.createElement("div")
    other.dataset.testid = "fixture-row-t-0"
    document.body.append(other)
    setTourApi(
      fakeApi({
        list: vi.fn(async () => [
          item(
            progress({
              tourId: arrival.id,
              beatId: "open",
              beatIndex: 1,
              beatCount: 2,
              beatStates: { arrive: { state: "done", entityId: "t-1" } },
            }),
            arrival.id,
          ),
        ]),
      }),
    )
    render(() => <TourOverlay />)
    await tourStore.load()
    await screen.findByTestId("tour-panel")
    expect((screen.getByTestId("tour-next") as HTMLButtonElement).disabled).toBe(true)
    expect(screen.getByTestId("tour-anchor-waiting")).toBeTruthy()
    const row = document.createElement("div")
    row.dataset.testid = "fixture-row-t-1"
    document.body.append(row)
    const spot = await screen.findByTestId("tour-spotlight")
    expect(spot.dataset.anchor).toBe("fixture-row-t-1")
    await waitFor(() =>
      expect((screen.getByTestId("tour-next") as HTMLButtonElement).disabled).toBe(false),
    )
  })

  it("a step showing the agent's answer keeps Next off until the answer is on screen", async () => {
    fixtures.tours = [...fixtures.tours, answer]
    setTourApi(
      fakeApi({
        list: vi.fn(async () => [
          item(progress({ tourId: answer.id, beatId: "sources", beatCount: 2 }), answer.id),
        ]),
      }),
    )
    render(() => <TourOverlay />)
    await tourStore.load()
    await screen.findByTestId("tour-panel")
    expect((screen.getByTestId("tour-next") as HTMLButtonElement).disabled).toBe(true)
    const citations = document.createElement("div")
    citations.dataset.testid = "fixture-citations"
    document.body.append(citations)
    await waitFor(() =>
      expect((screen.getByTestId("tour-next") as HTMLButtonElement).disabled).toBe(false),
    )
    expect((await screen.findByTestId("tour-spotlight")).dataset.anchor).toBe("fixture-citations")
  })

  // Owner feedback (walk 6): a step with nothing to point at floated over an
  // undimmed app.
  it("a step with nothing on screen to point at dims the page behind the card, never blocking it", async () => {
    setTourApi(
      fakeApi({ list: vi.fn(async () => [item(progress({ beatId: "last", beatIndex: 2 }))]) }),
    )
    render(() => <TourOverlay />)
    await tourStore.load()
    await screen.findByTestId("tour-panel")
    const scrim = await screen.findByTestId("tour-scrim")
    expect(scrim.className).toContain("pointer-events-none")
    expect(screen.queryByTestId("tour-spotlight")).toBeNull()
  })

  it("a step whose element is spotlit has no scrim: the spotlight dims around it", async () => {
    const anchor = document.createElement("div")
    anchor.dataset.testid = "fixture-anchor"
    document.body.append(anchor)
    setTourApi(fakeApi({ list: vi.fn(async () => [item(progress())]) }))
    render(() => <TourOverlay />)
    await tourStore.load()
    await screen.findByTestId("tour-spotlight")
    expect(screen.queryByTestId("tour-scrim")).toBeNull()
  })

  it("phone: the sheet tier and the phone anchor", async () => {
    tier.value = "phone"
    const anchor = document.createElement("div")
    anchor.dataset.testid = "fixture-anchor-phone"
    document.body.append(anchor)
    setTourApi(fakeApi({ list: vi.fn(async () => [item(progress())]) }))
    render(() => <TourOverlay />)
    await tourStore.load()
    expect((await screen.findByTestId("tour-panel")).dataset.tier).toBe("phone")
    expect((await screen.findByTestId("tour-spotlight")).dataset.anchor).toBe(
      "fixture-anchor-phone",
    )
  })

  it("anchor not on screen: Take me there when the beat has a route, else waiting to appear", async () => {
    const api = fakeApi({
      list: vi.fn(async () => [item(progress({ beatId: "post", beatIndex: 1 }))]),
    })
    setTourApi(api)
    render(() => <TourOverlay />)
    await tourStore.load()
    await pressTourMenuItem("tour-take-me-there")
    expect(nav.spaNavigate).toHaveBeenCalledWith("/threads")
    expect(screen.queryByTestId("tour-spotlight")).toBeNull()

    applyProgress("kernel.demo", progress({ beatId: "last", beatIndex: 2 }))
    expect(await screen.findByTestId("tour-anchor-waiting")).toBeTruthy()
    expect(await tourMenuItem("tour-take-me-there")).toBeNull()
    expect(screen.getByTestId("tour-next").textContent).toBe("Finish")
  })

  it("a hidden duplicate anchor is never spotlit", async () => {
    const hidden = document.createElement("div")
    hidden.style.display = "none"
    const dup = document.createElement("div")
    dup.dataset.testid = "fixture-anchor"
    dup.id = "hidden-copy"
    hidden.append(dup)
    document.body.append(hidden)
    setTourApi(fakeApi({ list: vi.fn(async () => [item(progress())]) }))
    render(() => <TourOverlay />)
    await tourStore.load()
    await screen.findByTestId("tour-panel")
    expect(screen.queryByTestId("tour-spotlight")).toBeNull()
  })

  it("do beat: I'll do it shows it is waiting; the pushed progress moves it on", async () => {
    const api = fakeApi({
      list: vi.fn(async () => [item(progress({ beatId: "post", beatIndex: 1 }))]),
      progress: vi.fn(async () => progress({ beatId: "last", beatIndex: 2 })),
    })
    setTourApi(api)
    render(() => <TourOverlay />)
    await tourStore.load()
    expect(screen.queryByTestId("tour-next")).toBeNull()
    fireEvent.click(await screen.findByTestId("tour-do-myself"))
    expect(await screen.findByTestId("tour-waiting")).toBeTruthy()
    expect(screen.queryByTestId("tour-do-myself")).toBeNull()

    tourStore.onFrame(
      {
        ownerUserId: "me",
        tourId: "kernel.demo",
        status: "active",
        beatId: "last",
        beatIndex: 2,
        emittedAt: new Date().toISOString(),
      },
      "me",
    )
    await waitFor(() => expect(screen.getByTestId("tour-panel").dataset.beatId).toBe("last"))
    expect(screen.queryByTestId("tour-waiting")).toBeNull()
  })

  it("one status line: a refusal is replaced, not stacked, when the person says I'll do it", async () => {
    const api = fakeApi({
      list: vi.fn(async () => [item(progress({ beatId: "post", beatIndex: 1 }))]),
    })
    setTourApi(api)
    render(() => <TourOverlay />)
    await tourStore.load()
    await screen.findByTestId("tour-panel")
    tourStore.setAutoplay("refused", "post", "fixture-elsewhere")
    await screen.findByTestId("tour-autoplay-refused")
    expect(document.querySelectorAll("[data-tour-status]")).toHaveLength(1)

    fireEvent.click(screen.getByTestId("tour-do-myself"))
    await screen.findByTestId("tour-waiting")
    expect(screen.queryByTestId("tour-autoplay-refused")).toBeNull()
    expect(document.querySelectorAll("[data-tour-status]")).toHaveLength(1)
  })

  it("one status line: waiting for the anchor and waiting for the event never stack", async () => {
    const api = fakeApi({
      list: vi.fn(async () => [item(progress({ beatId: "post", beatIndex: 1 }))]),
    })
    setTourApi(api)
    render(() => <TourOverlay />)
    await tourStore.load()
    await screen.findByTestId("tour-panel")
    tourStore.setAutoplay("takeover", "post")
    await screen.findByTestId("tour-autoplay-takeover")
    expect(screen.queryByTestId("tour-waiting")).toBeNull()
    expect(document.querySelectorAll("[data-tour-status]")).toHaveLength(1)
  })

  it("ignores another user's frame and a stale replay", async () => {
    const api = fakeApi({ list: vi.fn(async () => [item(progress())]) })
    setTourApi(api)
    await tourStore.load()
    const frame = {
      ownerUserId: "someone-else",
      tourId: "kernel.demo",
      status: "active",
      beatId: "post",
      beatIndex: 1,
      emittedAt: new Date().toISOString(),
    }
    tourStore.onFrame(frame, "me")
    tourStore.onFrame({ ...frame, ownerUserId: "me", emittedAt: "2020-01-01T00:00:00Z" }, "me")
    tourStore.onFrame({ nonsense: true }, "me")
    expect(api.progress).not.toHaveBeenCalled()
  })

  it("paused: only the chip, and it resumes the same beat", async () => {
    const api = fakeApi({
      list: vi.fn(async () => [item(progress({ status: "paused", beatId: "post", beatIndex: 1 }))]),
      update: vi.fn(async (_id, body) => {
        api.calls.push(["update", _id, body])
        return progress({ beatId: "post", beatIndex: 1 })
      }),
    })
    setTourApi(api)
    render(() => <TourOverlay />)
    await tourStore.load()
    const chip = await screen.findByTestId("tour-chip")
    expect(chip.textContent).toContain("Resume: Sample tour, step 2/3")
    expect(screen.queryByTestId("tour-panel")).toBeNull()

    fireEvent.click(screen.getByTestId("tour-chip-resume"))
    await waitFor(() => expect(screen.getByTestId("tour-panel").dataset.beatId).toBe("post"))
    expect(api.calls).toContainEqual(["update", "kernel.demo", { status: "active" }])
    expect(screen.queryByTestId("tour-chip")).toBeNull()
  })

  it("Pause collapses the panel to the chip", async () => {
    const api = fakeApi({
      list: vi.fn(async () => [item(progress())]),
      update: vi.fn(async () => progress({ status: "paused" })),
    })
    setTourApi(api)
    render(() => <TourOverlay />)
    await tourStore.load()
    await pressTourMenuItem("tour-pause")
    expect(await screen.findByTestId("tour-chip")).toBeTruthy()
    expect(screen.queryByTestId("tour-panel")).toBeNull()
  })

  it("one tour on screen: an active tour wins over a paused one, never both", async () => {
    setTourApi(
      fakeApi({
        list: vi.fn(async () => [
          item(progress({ status: "paused", updatedAt: "2026-10-23T11:00:00.000Z" })),
          item(progress({ tourId: "kernel.other" }), "kernel.other"),
        ]),
      }),
    )
    render(() => <TourOverlay />)
    await tourStore.load()
    expect((await screen.findByTestId("tour-panel")).dataset.tourId).toBe("kernel.other")
    expect(screen.queryByTestId("tour-chip")).toBeNull()
    expect(screen.getAllByTestId("tour-panel")).toHaveLength(1)
  })

  it("completed: shown once with the skipped count, then nothing", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    setTourApi(
      fakeApi({ list: vi.fn(async () => [item(progress({ beatId: "last", beatIndex: 2 }))]) }),
    )
    render(() => <TourOverlay />)
    await tourStore.load()
    applyProgress(
      "kernel.demo",
      progress({
        status: "completed",
        beatId: null,
        beatIndex: 3,
        beatStates: { welcome: "done", post: "skipped", last: "done" },
      }),
    )
    expect(await screen.findByTestId("tour-completed")).toBeTruthy()
    expect(screen.getByTestId("tour-completed-skipped").textContent).toBe("1 skipped")
    expect(screen.queryByTestId("tour-panel")).toBeNull()
    vi.advanceTimersByTime(7000)
    await waitFor(() => expect(screen.queryByTestId("tour-completed")).toBeNull())
    expect(screen.queryByTestId("tour-chip")).toBeNull()
  })

  it("a tour completed before this session is not announced", async () => {
    setTourApi(
      fakeApi({
        list: vi.fn(async () => [
          item(progress({ status: "completed", beatId: null, beatIndex: 3 })),
        ]),
      }),
    )
    render(() => <TourOverlay />)
    await tourStore.load()
    expect(screen.queryByTestId("tour-completed")).toBeNull()
    expect(screen.queryByTestId("tour-panel")).toBeNull()
  })

  it("ending the tour (abandoned) leaves nothing behind", async () => {
    const api = fakeApi({
      list: vi.fn(async () => [item(progress())]),
      update: vi.fn(async () => progress({ status: "abandoned" })),
    })
    setTourApi(api)
    render(() => <TourOverlay />)
    await tourStore.load()
    fireEvent.click(await screen.findByTestId("tour-end"))
    await waitFor(() => expect(screen.queryByTestId("tour-panel")).toBeNull())
    expect(screen.queryByTestId("tour-chip")).toBeNull()
  })

  it("a failed request says so in the panel", async () => {
    setTourApi(
      fakeApi({
        list: vi.fn(async () => [item(progress())]),
        update: vi.fn(async () => {
          throw new Error("boom")
        }),
      }),
    )
    render(() => <TourOverlay />)
    await tourStore.load()
    await pressTourMenuItem("tour-skip")
    expect((await screen.findByTestId("tour-error")).textContent).toBe(
      "That did not go through. Try again.",
    )
  })
})
