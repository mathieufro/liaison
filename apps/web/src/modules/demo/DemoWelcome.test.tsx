// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The demo's welcome popup: it opens by itself on the first arrival, step 1
// turns the agents on (the email code, or the visitor's own key) and is
// skipped when they already can run, step 2 starts one of the visitor's
// scenarios, and every other way out counts as browsing. The answer is the
// server's, so a reload after it never opens the popup again; the banner's
// scenario count always does.

import { DEMO_WORLD_NEEDS, findTour, type TourListItem, type TourProgress } from "@liaison/shared"
import { cleanup, fireEvent, render, screen, waitFor } from "@solidjs/testing-library"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { _setDemoWorld } from "~/modules/demo/demo-world"
import type { TourApi } from "~/modules/tours/tour-api"
import type { DemoScenarioItem } from "./DemoScenarioRunner"

const tier = vi.hoisted(() => ({ value: "desktop" as "desktop" | "phone" }))
vi.mock("~/modules/shell/shell-tier", () => ({ shellTier: () => tier.value }))
vi.mock("~/framework/spa-navigate", () => ({ spaNavigate: vi.fn() }))
vi.mock("~/modules/tours/tour-catalog", () => ({ resolveTour: (id: string) => findTour(id) }))

/** The server, by path: the queue, the welcome answer, the budget, the code. */
const server = vi.hoisted(() => ({
  queue: [] as unknown[],
  welcome: null as string | null,
  verified: false,
  byok: [] as string[],
  posts: [] as Array<{ path: string; body: unknown }>,
  /** What POST /demo/start-over answers: a signup's body, or an error to throw. */
  startOver: null as unknown,
  /** Reads that wait until the test lets them answer, by path. */
  held: new Map<string, Promise<void>>(),
}))
const client = vi.hoisted(() => ({
  get: vi.fn(async (path: string) => {
    await server.held.get(path)
    if (path === "/demo/scenarios") return server.queue
    if (path === "/demo/scenarios/welcome") return { choice: server.welcome }
    if (path === "/demo/budget") {
      return {
        verified: server.verified,
        emailMasked: "l•••@example.com",
        notifyManaged: false,
        budget: { usedMicroEur: 0, capMicroEur: 1_000_000 },
        box: { exhausted: false },
        byok: server.byok,
        codeSent: true,
      }
    }
    if (path === "/credits/models") return { models: [] }
    return {}
  }),
  post: vi.fn(async (path: string, body: unknown) => {
    server.posts.push({ path, body })
    if (path === "/demo/scenarios/welcome") {
      server.welcome = (body as { choice: string }).choice
      return { choice: server.welcome }
    }
    if (path === "/demo/start-over") {
      if (server.startOver instanceof Error) throw server.startOver
      return server.startOver
    }
    if (path === "/demo/verify") {
      server.verified = true
      return { verified: true }
    }
    return {}
  }),
}))
vi.mock("~/modules/shell/ApiContext", () => ({
  useOptionalApi: () => client,
  useApi: () => client,
}))

const { resetTourStore, setTourApi, tourStore } = await import("~/modules/tours/tour-store")
const { DemoScenarioRunner, DemoScenarioRunnerTestAccess } = await import("./DemoScenarioRunner")
const { DemoWelcome, DemoWelcomeTestAccess, ScenariosBannerEntry } = await import("./DemoWelcome")
const demoStore = await import("./demo-store")
const auth = await import("~/modules/auth/auth-store")

/** An access token for one org (the client reads its payload, never its signature). */
function tokenFor(orgId: string): string {
  const enc = (v: unknown) => btoa(JSON.stringify(v)).replace(/=+$/, "")
  const body = {
    userId: `u-${orgId}`,
    orgId,
    name: "Visitor",
    roles: ["admin"],
    scopes: ["kernel:org:admin"],
    exp: Math.floor(Date.now() / 1000) + 3600,
  }
  return `${enc({ alg: "HS256", typ: "JWT" })}.${enc(body)}.sig`
}

const item = (
  need: DemoScenarioItem["need"],
  status: DemoScenarioItem["status"] = "new",
): DemoScenarioItem => ({
  need,
  tourId: `kernel.scenario-${need}`,
  status,
  beatIndex: 0,
  beatCount: 8,
})

function progress(tourId: string, status: TourProgress["status"]): TourProgress {
  const tour = findTour(tourId)
  return {
    tourId,
    status,
    beatId: tour?.beats[0]?.id ?? null,
    beatIndex: 0,
    beatCount: 8,
    beatStates: {},
    source: "demo",
    startedAt: "2026-10-24T10:00:00.000Z",
    updatedAt: "2026-10-24T10:00:00.000Z",
  }
}

function tourApi(list: TourListItem[] = []): TourApi {
  return {
    list: vi.fn(async () => list),
    start: vi.fn(async (tourId: string) => progress(tourId, "active")),
    update: vi.fn(async (tourId: string) => progress(tourId, "paused")),
    progress: vi.fn(async (tourId: string) => progress(tourId, "active")),
  }
}

function mount() {
  render(() => (
    <>
      <div data-testid="banner-line">
        <ScenariosBannerEntry />
      </div>
      <DemoScenarioRunner />
      <DemoWelcome />
    </>
  ))
}

/** A fresh page load: the module state goes, the server's answers stay. */
async function reload(api: TourApi) {
  cleanup()
  resetTourStore()
  DemoScenarioRunnerTestAccess.reset()
  DemoWelcomeTestAccess.reset()
  demoStore._resetDemoStore()
  setTourApi(api)
  mount()
  await tourStore.load()
}

const welcomePosts = () =>
  server.posts.filter((p) => p.path === "/demo/scenarios/welcome").map((p) => p.body)

beforeEach(() => {
  // The door settings read (the code prompt's Turnstile key) goes nowhere here.
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response(JSON.stringify({ data: {} }), { status: 200 })),
  )
  tier.value = "desktop"
  server.queue = [item("support"), item("chat"), item("sales")]
  server.welcome = null
  server.verified = false
  server.byok = []
  server.posts = []
  server.startOver = null
  server.held.clear()
  client.get.mockClear()
  client.post.mockClear()
  resetTourStore()
  DemoScenarioRunnerTestAccess.reset()
  DemoWelcomeTestAccess.reset()
  demoStore._resetDemoStore()
})

afterEach(() => {
  vi.unstubAllGlobals()
  cleanup()
  auth.clearAuth()
  document.body.innerHTML = ""
  demoStore._resetDemoStore()
})

describe("DemoWelcome", () => {
  it("opens by itself on the first arrival, on step 1 while the agents cannot run", async () => {
    setTourApi(tourApi())
    mount()
    await tourStore.load()
    const dialog = await screen.findByTestId("demo-welcome")
    expect(dialog.getAttribute("data-step")).toBe("agents")
    expect(screen.getByTestId("demo-verify")).toBeTruthy()
    expect(screen.getByTestId("demo-welcome-own-key")).toBeTruthy()
    expect(screen.getByTestId("demo-welcome-browse")).toBeTruthy()
  })

  it("says the company is an example on the first view inside the world", async () => {
    setTourApi(tourApi())
    _setDemoWorld("products")
    mount()
    await tourStore.load()
    await screen.findByTestId("demo-welcome")
    expect(screen.getByTestId("demo-example-line").textContent).toContain("Resonant Audio Labs")
  })

  it("skips step 1 when the email is already confirmed", async () => {
    server.verified = true
    setTourApi(tourApi())
    mount()
    await tourStore.load()
    const dialog = await screen.findByTestId("demo-welcome")
    await waitFor(() => expect(dialog.getAttribute("data-step")).toBe("choose"))
    expect(screen.queryByTestId("demo-verify")).toBeNull()
  })

  it("skips step 1 when the visitor's own key is set", async () => {
    server.byok = ["openrouter"]
    setTourApi(tourApi())
    mount()
    await tourStore.load()
    const dialog = await screen.findByTestId("demo-welcome")
    await waitFor(() => expect(dialog.getAttribute("data-step")).toBe("choose"))
  })

  it("moves to step 2 once the code is confirmed", async () => {
    setTourApi(tourApi())
    mount()
    await tourStore.load()
    await screen.findByTestId("demo-verify")
    fireEvent.input(screen.getByTestId("demo-verify-code"), { target: { value: "123456" } })
    fireEvent.click(screen.getByTestId("demo-verify-submit"))
    await waitFor(() =>
      expect(screen.getByTestId("demo-welcome").getAttribute("data-step")).toBe("choose"),
    )
    expect(screen.getByTestId("demo-welcome-confirmed")).toBeTruthy()
    // Confirming is not an answer: the popup stays and nothing is recorded yet.
    expect(welcomePosts()).toEqual([])
  })

  it("opens the key form in place from step 1, and goes back to the code", async () => {
    setTourApi(tourApi())
    mount()
    await tourStore.load()
    fireEvent.click(await screen.findByTestId("demo-welcome-own-key"))
    expect(screen.getByTestId("demo-byok")).toBeTruthy()
    expect(screen.queryByTestId("demo-verify")).toBeNull()
    fireEvent.click(screen.getByTestId("demo-welcome-back-to-code"))
    expect(screen.getByTestId("demo-verify")).toBeTruthy()
  })

  it("features the first pick and lists the others in pick order, with their Agentic names", async () => {
    server.verified = true
    setTourApi(tourApi())
    mount()
    await tourStore.load()
    const featured = await screen.findByTestId("demo-welcome-featured")
    expect(featured.getAttribute("data-need")).toBe("support")
    expect(featured.textContent).toContain("Agentic customer support")
    expect(featured.textContent).toContain("a routine drafts the reply")
    const rows = screen.getAllByTestId(/^demo-welcome-row-[a-z]+$/)
    expect(rows.map((r) => r.getAttribute("data-need"))).toEqual(["chat", "sales"])
    expect(rows[0]?.textContent).toContain("Agentic team chat")
  })

  it("a played single-run tour offers Start over, never Start again", async () => {
    server.verified = true
    server.queue = [
      item("support"),
      { ...item("chat", "completed"), singleRun: true },
      item("sales"),
    ]
    setTourApi(tourApi())
    mount()
    await tourStore.load()
    const row = await screen.findByTestId("demo-welcome-row-chat")
    expect(row.textContent).toContain("Played")
    expect(row.textContent).not.toMatch(/Replay|Start again|Play again/)
    expect(screen.queryByTestId("demo-welcome-row-chat-start")).toBeNull()
    // A played scenario that is not single-run still replays.
    expect(screen.getByTestId("demo-welcome-row-sales-start").textContent).toBe("Start")
    fireEvent.click(screen.getByTestId("demo-welcome-row-chat-start-over"))
    expect(await screen.findByTestId("demo-start-over")).toBeTruthy()
  })

  it("a played single-run tour featured when every scenario is played says so and offers Start over", async () => {
    server.verified = true
    server.queue = [{ ...item("chat", "completed"), singleRun: true }]
    setTourApi(tourApi())
    mount()
    await tourStore.load()
    const featured = await screen.findByTestId("demo-welcome-featured")
    expect(featured.textContent).toContain("Played")
    expect(screen.queryByTestId("demo-welcome-featured-start")).toBeNull()
    expect(screen.getByTestId("demo-welcome-featured-start-over")).toBeTruthy()
  })

  for (const way of ["browse", "close", "escape"] as const) {
    it(`closes on ${way} and records it as browsing`, async () => {
      setTourApi(tourApi())
      mount()
      await tourStore.load()
      await screen.findByTestId("demo-welcome")
      if (way === "browse") fireEvent.click(screen.getByTestId("demo-welcome-browse"))
      if (way === "close") fireEvent.click(screen.getByTestId("demo-welcome-close"))
      if (way === "escape") {
        fireEvent.keyDown(document.activeElement ?? document.body, { key: "Escape" })
      }
      await waitFor(() => expect(screen.queryByTestId("demo-welcome")).toBeNull())
      await waitFor(() => expect(welcomePosts()).toEqual([{ choice: "browse" }]))
    })
  }

  it("does not open by itself again on a reload once a choice is made", async () => {
    const api = tourApi()
    setTourApi(api)
    mount()
    await tourStore.load()
    fireEvent.click(await screen.findByTestId("demo-welcome-browse"))
    await waitFor(() => expect(server.welcome).toBe("browse"))
    await reload(api)
    await waitFor(() =>
      expect(client.get.mock.calls.some(([p]) => p === "/demo/scenarios/welcome")).toBe(true),
    )
    await new Promise((r) => setTimeout(r, 50))
    expect(screen.queryByTestId("demo-welcome")).toBeNull()
  })

  it("the banner's Scenarios k/n reopens it: on step 1 while unconfirmed, on step 2 once confirmed", async () => {
    server.welcome = "browse"
    setTourApi(tourApi())
    mount()
    await tourStore.load()
    const open = await screen.findByTestId("demo-scenarios-open")
    expect(open.textContent).toContain("0/3")
    await new Promise((r) => setTimeout(r, 30))
    expect(screen.queryByTestId("demo-welcome")).toBeNull()
    fireEvent.click(open)
    await waitFor(() =>
      expect(screen.getByTestId("demo-welcome").getAttribute("data-step")).toBe("agents"),
    )
    fireEvent.click(screen.getByTestId("demo-welcome-browse"))
    await waitFor(() => expect(screen.queryByTestId("demo-welcome")).toBeNull())
    demoStore._setDemoVerification({ verified: true, emailMasked: null, codeSent: true })
    fireEvent.click(screen.getByTestId("demo-scenarios-open"))
    await waitFor(() =>
      expect(screen.getByTestId("demo-welcome").getAttribute("data-step")).toBe("choose"),
    )
  })

  it("Start begins that scenario through the queue and records the choice", async () => {
    server.verified = true
    const api = tourApi()
    setTourApi(api)
    mount()
    await tourStore.load()
    fireEvent.click(await screen.findByTestId("demo-welcome-row-chat-start"))
    await waitFor(() => expect(api.start).toHaveBeenCalledWith("kernel.scenario-chat", "demo"))
    expect(screen.queryByTestId("demo-welcome")).toBeNull()
    expect(welcomePosts()).toEqual([{ choice: "start" }])
  })

  it("the featured Start begins the first pick", async () => {
    server.verified = true
    const api = tourApi()
    setTourApi(api)
    mount()
    await tourStore.load()
    fireEvent.click(await screen.findByTestId("demo-welcome-featured-start"))
    await waitFor(() => expect(api.start).toHaveBeenCalledWith("kernel.scenario-support", "demo"))
  })

  it("Start on an unfinished scenario resumes it, never starts it over", async () => {
    server.verified = true
    server.welcome = "start"
    server.queue = [item("support", "paused"), item("chat")]
    const api = tourApi([
      {
        tourId: "kernel.scenario-support",
        app: "kernel",
        title: "",
        summary: "",
        beatCount: 8,
        progress: progress("kernel.scenario-support", "paused"),
      },
    ])
    setTourApi(api)
    mount()
    await tourStore.load()
    fireEvent.click(await screen.findByTestId("demo-scenarios-open"))
    fireEvent.click(await screen.findByTestId("demo-welcome-featured-start"))
    await waitFor(() =>
      expect(api.update).toHaveBeenCalledWith("kernel.scenario-support", { status: "active" }),
    )
    expect(api.start).not.toHaveBeenCalled()
  })

  it("does not open over a tour already on screen", async () => {
    const paused = progress("kernel.scenario-support", "paused")
    setTourApi(
      tourApi([
        {
          tourId: "kernel.scenario-support",
          app: "kernel",
          title: "",
          summary: "",
          beatCount: 8,
          progress: paused,
        },
      ]),
    )
    server.queue = [item("support", "paused"), item("chat")]
    mount()
    await tourStore.load()
    await new Promise((r) => setTimeout(r, 50))
    expect(screen.queryByTestId("demo-welcome")).toBeNull()
  })

  it("is a bottom sheet with a grab handle and a full-width Browse on a phone", async () => {
    tier.value = "phone"
    server.verified = true
    setTourApi(tourApi())
    mount()
    await tourStore.load()
    const dialog = await screen.findByTestId("demo-welcome")
    expect(dialog.getAttribute("data-variant")).toBe("sheet")
    expect(screen.getByTestId("demo-welcome-handle")).toBeTruthy()
    expect(screen.getByTestId("demo-welcome-browse").className).toMatch(/\bw-full\b/)
    // Rows show names only on a phone.
    expect(screen.queryByTestId("demo-welcome-row-chat-desc")).toBeNull()
  })

  describe("a new workspace in the same tab", () => {
    const seven = () => DEMO_WORLD_NEEDS.products.map((need) => item(need))

    /** Org A answered and finished a scenario; the session then moves to org B. */
    async function answerInOrgA(api: TourApi) {
      auth.setTokens(tokenFor("org-a"))
      server.verified = true
      setTourApi(api)
      mount()
      await tourStore.load()
      fireEvent.click(await screen.findByTestId("demo-welcome-featured-start"))
      await waitFor(() => expect(server.welcome).toBe("start"))
      // The scenario ran to its end: the completion card is still in the tour store.
      const { applyProgress } = await import("~/modules/tours/tour-store")
      applyProgress("kernel.scenario-support", progress("kernel.scenario-support", "completed"))
      expect(tourStore.completed).not.toBeNull()
    }

    /** Org B's server answers: unanswered, seven picks, the address not confirmed yet. */
    function orgBServer() {
      server.welcome = null
      server.verified = false
      server.queue = seven()
      client.get.mockClear()
    }

    /** Hold one of org B's reads until `release` is called. */
    function hold(path: string): () => void {
      let release = () => {}
      server.held.set(
        path,
        new Promise<void>((r) => {
          release = r
        }),
      )
      return () => {
        server.held.delete(path)
        release()
      }
    }

    /** Start over and sign up again, with the shell remounted, as the tab does it. */
    async function signUpInOrgB(api: TourApi) {
      cleanup()
      auth.clearAuth()
      orgBServer()
      auth.setTokens(tokenFor("org-b"))
      demoStore._setDemoVerification({
        verified: false,
        emailMasked: "v•••@example.com",
        codeSent: true,
      })
      setTourApi(api)
      mount()
      await tourStore.load()
    }

    for (const path of ["/demo/scenarios/welcome", "/demo/scenarios"]) {
      it(`does not act on org A's answers while org B's ${path} is still being read`, async () => {
        const api = tourApi()
        await answerInOrgA(api)
        const release = hold(path)
        await signUpInOrgB(api)
        await new Promise((r) => setTimeout(r, 50))
        // Nothing yet: org B's read has not answered (org A's answer, or its
        // queue, is not org B's).
        expect(screen.queryByTestId("demo-welcome")).toBeNull()
        release()
        expect((await screen.findByTestId("demo-welcome")).getAttribute("data-step")).toBe("agents")
        expect(screen.getByTestId("demo-scenarios-open").textContent).toContain("0/7")
      })
    }

    const budgetReads = () => client.get.mock.calls.filter(([p]) => p === "/demo/budget").length

    it("the expired workspace's Start over, then a new signup: the popup opens for the new org", async () => {
      const api = tourApi()
      await answerInOrgA(api)
      // Start over: the session ends without a page load (the shell unmounts)...
      cleanup()
      auth.clearAuth()
      orgBServer()
      // ...and the signup signs the visitor into org B, verification state included.
      auth.setTokens(tokenFor("org-b"))
      demoStore._setDemoVerification({
        verified: false,
        emailMasked: "v•••@example.com",
        codeSent: true,
      })
      setTourApi(api)
      mount()
      await tourStore.load()
      const dialog = await screen.findByTestId("demo-welcome")
      expect(dialog.getAttribute("data-step")).toBe("agents")
      // Org A's finished scenario is not on screen in org B.
      expect(tourStore.completed).toBeNull()
    })

    it("an org switch with the shell still mounted: the popup opens and org B's budget is read", async () => {
      const api = tourApi()
      await answerInOrgA(api)
      orgBServer()
      auth.setTokens(tokenFor("org-b"))
      // What TourHost does for the new org: wire the store and read its tours.
      setTourApi(api)
      await tourStore.load()
      const dialog = await screen.findByTestId("demo-welcome")
      await waitFor(() => expect(budgetReads()).toBe(1))
      expect(dialog.getAttribute("data-step")).toBe("agents")
      expect(tourStore.completed).toBeNull()
    })
  })

  describe("start over", () => {
    it("asks first, then moves the session to the fresh workspace", async () => {
      server.verified = true
      auth.setTokens(tokenFor("org-old"))
      server.startOver = {
        orgId: "org-new",
        orgSlug: "demo-lea-1",
        userId: "u-org-new",
        state: "ready",
        statusUrl: "/api/demo/orgs/org-new/status",
        expiresAt: "2099-01-01T00:00:00.000Z",
        accessToken: tokenFor("org-new"),
        needs: ["support"],
        verification: { sent: false, emailMasked: "l•••@example.com" },
      }
      setTourApi(tourApi())
      mount()
      await tourStore.load()
      const dialog = await screen.findByTestId("demo-welcome")
      await waitFor(() => expect(dialog.getAttribute("data-step")).toBe("choose"))

      fireEvent.click(screen.getByTestId("demo-welcome-start-over"))
      expect(screen.getByTestId("demo-welcome").getAttribute("data-step")).toBe("startOver")
      expect(screen.getByTestId("demo-start-over").textContent).toContain("0/3")
      // Nothing happens until the visitor confirms; Cancel goes back to the list.
      expect(server.posts.some((p) => p.path === "/demo/start-over")).toBe(false)
      fireEvent.click(screen.getByTestId("demo-start-over-cancel"))
      expect(screen.getByTestId("demo-welcome").getAttribute("data-step")).toBe("choose")

      fireEvent.click(screen.getByTestId("demo-welcome-start-over"))
      fireEvent.click(screen.getByTestId("demo-start-over-confirm"))
      await waitFor(() => expect(auth.sessionOrgId()).toBe("org-new"))
      expect(server.posts.filter((p) => p.path === "/demo/start-over")).toHaveLength(1)
      expect(demoStore.demoWorkspace()?.orgId).toBe("org-new")
      // Leaving the question is never recorded as a welcome answer.
      expect(welcomePosts()).toEqual([])
    })

    it("shows the server's reason when it refuses", async () => {
      server.verified = true
      const { ApiError } = await import("~/lib/api-error")
      server.startOver = new ApiError("Already starting over.", 409, "start_over_running")
      setTourApi(tourApi())
      mount()
      await tourStore.load()
      const dialog = await screen.findByTestId("demo-welcome")
      await waitFor(() => expect(dialog.getAttribute("data-step")).toBe("choose"))
      fireEvent.click(screen.getByTestId("demo-welcome-start-over"))
      fireEvent.click(screen.getByTestId("demo-start-over-confirm"))
      expect((await screen.findByTestId("demo-start-over-error")).textContent).toBe(
        "Already starting over.",
      )
      expect(screen.getByTestId("demo-welcome").getAttribute("data-step")).toBe("startOver")
    })
  })
})
