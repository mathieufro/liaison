// SPDX-License-Identifier: FSL-1.1-ALv2
//
// P3-T8: "Show me how" (the list with status and Start/Resume, desktop menu
// and phone sheet), the `?tour=` deep link (read once, then stripped) and the
// kernel:tour websocket handler (any fresh own frame refetches progress).
import type { TourListItem, TourProgress } from "@liaison/shared"
import { Route, Router } from "@solidjs/router"
import { cleanup, fireEvent, render, screen, waitFor } from "@solidjs/testing-library"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { dispatchWsEntityEvent } from "~/framework/app-registry"
import { useI18n } from "~/modules/i18n/i18n-context"
import { ApiContext } from "~/modules/shell/ApiContext"
import type { TourApi } from "./tour-api"

vi.mock("~/modules/shell/shell-tier", () => ({ shellTier: () => "desktop" }))

const { resetTourStore, setTourApi, tourStore } = await import("./tour-store")
const { ToursList, arrangeTours, tourActionLabel, tourStatusLabel } = await import("./ToursMenu")
const { TourHost } = await import("./TourHost")

function progress(over: Partial<TourProgress> = {}): TourProgress {
  return {
    tourId: "kernel.sample",
    status: "active",
    beatId: "post-message",
    beatIndex: 1,
    beatCount: 2,
    beatStates: {},
    source: "help",
    startedAt: "2026-10-23T10:00:00.000Z",
    updatedAt: "2026-10-23T10:00:00.000Z",
    ...over,
  }
}

function item(p: TourProgress | null): TourListItem {
  return {
    tourId: "kernel.sample",
    app: "kernel",
    title: "tours.kernel.sample.title",
    summary: "tours.kernel.sample.summary",
    beatCount: 2,
    progress: p,
  }
}

function fakeApi(items: TourListItem[]): TourApi {
  return {
    list: vi.fn(async () => items),
    start: vi.fn(async () => progress({ beatId: "welcome", beatIndex: 0 })),
    update: vi.fn(async () => progress()),
    progress: vi.fn(async () => progress()),
  }
}

beforeEach(() => {
  resetTourStore()
})

afterEach(() => {
  cleanup()
  window.history.replaceState(null, "", "/")
})

describe("Show me how", () => {
  // No provider in a unit test: the static English translator.
  const t = useI18n().t

  it("labels each tour new / step k of n / done, with Start, Resume or Play again", () => {
    expect(tourStatusLabel(item(null), t)).toBe("New")
    expect(tourActionLabel(item(null), t)).toBe("Start")
    expect(tourStatusLabel(item(progress({ status: "paused" })), t)).toBe("Step 2 of 2")
    expect(tourActionLabel(item(progress({ status: "paused" })), t)).toBe("Resume")
    expect(tourStatusLabel(item(progress({ status: "completed", beatIndex: 2 })), t)).toBe("Done")
    expect(tourActionLabel(item(progress({ status: "completed" })), t)).toBe("Play again")
    // Ended with × before the last beat: shown as stopped, never as new.
    expect(tourStatusLabel(item(progress({ status: "abandoned" })), t)).toBe("Stopped")
    expect(tourActionLabel(item(progress({ status: "abandoned" })), t)).toBe("Start again")
    // A single-run scenario is played, and only the whole demo starts over.
    const single = (p: TourProgress): TourListItem => ({ ...item(p), singleRun: true })
    expect(tourStatusLabel(single(progress({ status: "completed" })), t)).toBe("Played")
    expect(tourActionLabel(single(progress({ status: "completed" })), t)).toBe("Start over")
    expect(tourActionLabel(single(progress({ status: "abandoned" })), t)).toBe("Start over")
    expect(tourActionLabel(single(progress({ status: "paused" })), t)).toBe("Resume")
  })

  it("phone list: a new tour starts from the help source", async () => {
    const api = fakeApi([item(null)])
    setTourApi(api)
    await tourStore.refreshList()
    const picked = vi.fn()
    render(() => <ToursList onPicked={picked} />)
    const row = screen.getByTestId("tours-menu-item")
    expect(row.dataset.status).toBe("new")
    expect(screen.getByTestId("tours-menu-status").textContent).toBe("New")
    fireEvent.click(row)
    expect(picked).toHaveBeenCalled()
    await waitFor(() => expect(api.start).toHaveBeenCalledWith("kernel.sample", "help"))
  })

  it("phone list: a paused tour resumes (no restart)", async () => {
    const api = fakeApi([item(progress({ status: "paused" }))])
    setTourApi(api)
    await tourStore.refreshList()
    render(() => <ToursList />)
    expect(screen.getByTestId("tours-menu-action").textContent).toBe("Resume")
    fireEvent.click(screen.getByTestId("tours-menu-item"))
    await waitFor(() =>
      expect(api.update).toHaveBeenCalledWith("kernel.sample", { status: "active" }),
    )
    expect(api.start).not.toHaveBeenCalled()
  })

  it("an empty catalogue says so once loaded", async () => {
    setTourApi(fakeApi([]))
    await tourStore.refreshList()
    render(() => <ToursList />)
    expect(screen.getByTestId("tours-menu-empty").textContent).toBe(
      "No tours for the apps in this workspace yet.",
    )
  })
})

describe("deep link and websocket", () => {
  function mountHost(api: TourApi, url: string) {
    window.history.replaceState(null, "", url)
    // The host builds its TourApi from the client; hand it one that answers
    // through the fake, unwrapped like the real client.
    const client = {
      get: vi.fn(async (path: string) =>
        path === "/tours" ? { tours: await api.list() } : { progress: await api.progress("") },
      ),
      post: vi.fn(async (path: string, body: { source: string }) => ({
        progress: await api.start(path.split("/")[2] ?? "", body.source as "cli"),
      })),
      patch: vi.fn(async (path: string, body: never) => ({
        progress: await api.update(path.split("/")[2] ?? "", body),
      })),
    }
    render(() => (
      <ApiContext.Provider value={client as never}>
        <Router>
          <Route path="*" component={() => <TourHost />} />
        </Router>
      </ApiContext.Provider>
    ))
    return client
  }

  it("?tour= starts the tour once and is stripped from the URL", async () => {
    const api = fakeApi([item(null)])
    const client = mountHost(api, "/threads?x=1&tour=kernel.sample")
    await waitFor(() => expect(api.start).toHaveBeenCalledWith("kernel.sample", "cli"))
    expect(client.post).toHaveBeenCalledWith("/tours/kernel.sample/start", { source: "cli" })
    await waitFor(() => expect(window.location.search).toBe("?x=1"))
    expect(window.location.pathname).toBe("/threads")
    expect(await screen.findByTestId("tour-panel")).toBeTruthy()
  })

  it("?tour= for a tour already active does not restart it", async () => {
    const api = fakeApi([item(progress())])
    mountHost(api, "/?tour=kernel.sample")
    expect(await screen.findByTestId("tour-panel")).toBeTruthy()
    await waitFor(() => expect(window.location.search).toBe(""))
    expect(api.start).not.toHaveBeenCalled()
  })

  it("an unknown ?tour= is stripped and ignored", async () => {
    const api = fakeApi([])
    mountHost(api, "/?tour=nope.nothing")
    await waitFor(() => expect(window.location.search).toBe(""))
    expect(api.start).not.toHaveBeenCalled()
  })

  it("a kernel:tour frame for me refetches progress", async () => {
    const api = fakeApi([])
    mountHost(api, "/")
    await waitFor(() => expect(api.list).toHaveBeenCalled())
    dispatchWsEntityEvent(
      "kernel:tour",
      "start",
      {
        ownerUserId: "me",
        tourId: "kernel.sample",
        status: "active",
        beatId: "post-message",
        beatIndex: 1,
        emittedAt: new Date().toISOString(),
      },
      { currentUserId: "me", activeTabId: null, isDocumentVisible: true, isOwnAction: false },
    )
    await waitFor(() => expect(api.progress).toHaveBeenCalled())
    expect(await screen.findByTestId("tour-panel")).toBeTruthy()
  })
})

describe("arrangeTours", () => {
  const row = (tourId: string, title: string, p: TourProgress | null = null): TourListItem => ({
    tourId,
    app: "kernel",
    title,
    summary: `${title}.summary`,
    beatCount: 3,
    progress: p,
  })
  const words = (k: string) => k.replace(/^t\./, "")

  it("lists one entry for a title two tours share, the one furthest along", () => {
    const first = row("projects.basics", "t.Projects")
    const second = row("kernel.scenario-projects", "t.Projects")
    expect(arrangeTours([first, second], words, []).map((i) => i.tourId)).toEqual([
      "projects.basics",
    ])
    const started = row(
      "kernel.scenario-projects",
      "t.Projects",
      progress({ tourId: "kernel.scenario-projects" }),
    )
    expect(arrangeTours([first, started], words, []).map((i) => i.tourId)).toEqual([
      "kernel.scenario-projects",
    ])
  })

  it("puts the tours that point at the person's roles first and keeps the rest in catalogue order", () => {
    const items = [
      row("kernel.scenario-sales", "t.Sales"),
      row("kernel.scenario-commerce", "t.Commerce"),
      row("kernel.scenario-dev", "t.Developers"),
      row("tickets.basics", "t.Tickets"),
    ]
    expect(arrangeTours(items, words, ["Developer"]).map((i) => i.tourId)).toEqual([
      "kernel.scenario-dev",
      "kernel.scenario-sales",
      "kernel.scenario-commerce",
      "tickets.basics",
    ])
    expect(arrangeTours(items, words, []).map((i) => i.tourId)).toEqual(items.map((i) => i.tourId))
  })
})
