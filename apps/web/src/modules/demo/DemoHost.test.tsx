// SPDX-License-Identifier: FSL-1.1-ALv2
//
// What the demo adds once the visitor is inside the product: the standing
// banner, the honest seed state, the model-key form (shown in the welcome
// popup's step 1) and the expired takeover. All of it is gated on the SERVER's demo flag, so the first test
// here is that a normal deployment gets none of it.
import { Route, Router } from "@solidjs/router"
import { cleanup, fireEvent, render, screen, waitFor } from "@solidjs/testing-library"
import type { JSX } from "solid-js"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { resetCreditsStore } from "~/modules/agent/credits/credits-store"
import { clearAuth, setTokens } from "~/modules/auth/auth-store"
import { DemoByokPrompt } from "~/modules/demo/DemoByokPrompt"
import { DemoHost } from "~/modules/demo/DemoHost"
import { DemoVerifyGate } from "~/modules/demo/DemoVerifyPrompt"
import {
  _hydrateDemoWorkspace,
  _resetDemoStore,
  type DemoProvisioningState,
} from "~/modules/demo/demo-store"
import { _setDemoWorld, demoWorldId } from "~/modules/demo/demo-world"
import { I18nProvider } from "~/modules/i18n/i18n-context"
import { ApiProvider } from "~/modules/shell/ApiContext"
import {
  _resetBranding,
  ensureBrandingLoaded,
  ensureSignedInOrgNameLoaded,
} from "~/modules/shell/branding-store"
import { tourBeatGate } from "~/modules/tours/beat-gates"

function jwt(): string {
  const header = btoa(JSON.stringify({ alg: "HS256", typ: "JWT" }))
  const body = btoa(
    JSON.stringify({
      userId: "u1",
      orgId: "o1",
      name: "Visitor",
      roles: ["admin"],
      scopes: ["kernel:org:admin"],
      dimensionGrants: {},
      exp: Math.floor(Date.now() / 1000) + 3600,
    }),
  )
  return `${header}.${body}.fake`
}

/**
 * Teach the branding store what the server said, the way the app does: the
 * deployment's flag, then (unless `org` is "unknown") the signed-in org's own
 * `demo` from GET /org. A demo deployment's org is a demo one unless told.
 */
async function serverSays(demo: boolean, org: boolean | "unknown" = demo): Promise<void> {
  _resetBranding()
  await ensureBrandingLoaded(
    (async () =>
      ({
        ok: true,
        json: async () => ({
          data: { orgName: "Resonant Audio Labs", flags: demo ? { demo: true } : {} },
        }),
      }) as unknown as Response) as unknown as typeof fetch,
  )
  if (org !== "unknown") {
    await ensureSignedInOrgNameLoaded(async () => ({ data: { name: "Resonant", demo: org } }))
  }
}

/** Put a workspace record in place without going through the network. */
function storeWorkspace(state: DemoProvisioningState, expiresAt: string | null): void {
  localStorage.setItem(
    "liaison:demo-workspace",
    JSON.stringify({
      orgId: "11111111-1111-4111-8111-111111111111",
      orgSlug: "demo-acme",
      statusUrl: "/api/demo/orgs/11111111-1111-4111-8111-111111111111/status",
      state,
      expiresAt,
    }),
  )
  _hydrateDemoWorkspace()
}

/**
 * Answer the two server reads the demo host makes, by path: the readiness
 * status and the org's usable models. Everything else gets an empty `data`.
 */
function serverAnswers(answers: {
  status?: { state: DemoProvisioningState; expiresAt?: string }
  models?: string[]
  /** What `GET /demo/world` says; absent: the read is refused (404), as for the reserved org. */
  world?: string
}): string[] {
  const seen: string[] = []
  vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url
    seen.push(url)
    let data: unknown = {}
    if (url.includes("/demo/orgs/") && url.endsWith("/status") && answers.status) {
      data = answers.status
    } else if (url.includes("/demo/world")) {
      if (!answers.world) {
        return new Response(JSON.stringify({ error: { message: "Not found" } }), { status: 404 })
      }
      data = { worldId: answers.world }
    } else if (url.includes("/credits/models") && answers.models) {
      data = { models: answers.models.map((modelId) => ({ modelId })) }
    }
    return new Response(JSON.stringify({ data }), {
      status: 200,
      headers: { "content-type": "application/json" },
    })
  })
  return seen
}

/** The host, plus what a test puts beside it (the key form, as the welcome popup shows it). */
function renderHost(beside?: () => JSX.Element) {
  render(() => (
    <I18nProvider initialLocale="en">
      <Router>
        <Route
          path="*"
          component={() => (
            <ApiProvider>
              <DemoHost />
              {beside?.()}
            </ApiProvider>
          )}
        />
      </Router>
    </I18nProvider>
  ))
}

beforeEach(() => {
  _resetDemoStore()
  _resetBranding()
  resetCreditsStore()
  setTokens(jwt(), "refresh")
  vi.stubGlobal(
    "fetch",
    vi.fn(
      async () =>
        new Response(JSON.stringify({ data: {} }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    ),
  )
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  _resetDemoStore()
  _resetBranding()
  resetCreditsStore()
  clearAuth()
})

describe("a deployment that is not the demo", () => {
  it("shows no banner, no key prompt and no expiry, whatever is in storage", async () => {
    // An expired workspace record IS in place: the gate, not an empty store,
    // is what keeps the demo off a normal deployment.
    storeWorkspace("ready", "2000-01-01T00:00:00.000Z")
    await serverSays(false)
    renderHost()
    expect(screen.queryByTestId("demo-banner")).toBeNull()
    expect(screen.queryByTestId("demo-welcome")).toBeNull()
    expect(screen.queryByTestId("demo-expired")).toBeNull()
    expect(tourBeatGate("verify")).toBeUndefined()
  })
})

describe("the workspace's world", () => {
  it("is read from the server into the demo world store", async () => {
    serverAnswers({ status: { state: "ready" }, world: "saas" })
    await serverSays(true)
    renderHost()
    await waitFor(() => expect(demoWorldId()).toBe("saas"))
  })

  it("stays unknown when the read is refused, as it is for the reserved review org", async () => {
    _setDemoWorld("saas")
    const seen = serverAnswers({ status: { state: "ready" } })
    await serverSays(true)
    renderHost()
    await waitFor(() => expect(seen.some((u) => u.includes("/demo/world"))).toBe(true))
    await waitFor(() => expect(demoWorldId()).toBeNull())
  })

  it("is never read, and is forgotten, in an org that is not a demo one", async () => {
    _setDemoWorld("saas")
    const seen = serverAnswers({ world: "saas" })
    await serverSays(true, false)
    renderHost()
    await new Promise((r) => setTimeout(r, 20))
    expect(seen.some((u) => u.includes("/demo/world"))).toBe(false)
    expect(demoWorldId()).toBeNull()
  })
})

describe("a real workspace on the demo deployment", () => {
  it("shows no banner and no demo gates: the org is not a demo one", async () => {
    await serverSays(true, false)
    renderHost()
    expect(screen.queryByTestId("demo-banner")).toBeNull()
    expect(screen.queryByTestId("demo-welcome")).toBeNull()
    expect(tourBeatGate("verify")).toBeUndefined()
  })

  it("shows nothing and reads no demo status while the org is not known yet", async () => {
    storeWorkspace("provisioning", null)
    const seen = serverAnswers({ status: { state: "ready" } })
    await serverSays(true, "unknown")
    renderHost()
    expect(screen.queryByTestId("demo-banner")).toBeNull()
    expect(screen.queryByTestId("demo-state-provisioning")).toBeNull()
    expect(tourBeatGate("verify")).toBeUndefined()
    // No syncDemoWorkspace: the status route is never read on an unknown org.
    await new Promise((r) => setTimeout(r, 20))
    expect(seen.some((u) => u.includes("/demo/orgs/"))).toBe(false)
    // Once GET /org says it is a demo one, the banner comes (no latch on unknown).
    await ensureSignedInOrgNameLoaded(async () => ({ data: { name: "Resonant", demo: true } }))
    await waitFor(() => expect(screen.getByTestId("demo-banner")).toBeTruthy())
  })

  it("a demo org on the same deployment keeps the banner", async () => {
    await serverSays(true, true)
    renderHost()
    expect(screen.getByTestId("demo-banner")).toBeTruthy()
  })
})

describe("the guided scenarios' verify gate", () => {
  it("is the email-code prompt on a demo deployment, and goes with the host", async () => {
    await serverSays(true)
    renderHost()
    expect(tourBeatGate("verify")).toBe(DemoVerifyGate)
    cleanup()
    expect(tourBeatGate("verify")).toBeUndefined()
  })
})

describe("the standing banner", () => {
  it("is there on every tier, naming the instance", async () => {
    await serverSays(true)
    renderHost()
    const banner = screen.getByTestId("demo-banner")
    expect(banner.getAttribute("role")).toBe("status")
    expect(banner.textContent).toContain("Demo instance")
  })

  it("names the server's own expiry for a workspace the visitor created", async () => {
    storeWorkspace("ready", "2030-03-04T10:00:00.000Z")
    await serverSays(true)
    renderHost()
    const expiry = screen.getByTestId("demo-banner-expiry")
    expect(expiry.textContent).toContain("2030")
    expect(expiry.textContent).toContain("expires")
  })

  it("opens a list of exactly what the demo cannot do", async () => {
    serverAnswers({ world: "products" })
    await serverSays(true)
    renderHost()
    await waitFor(() => expect(demoWorldId()).toBe("products"))
    fireEvent.click(screen.getByTestId("demo-limits-open"))
    const list = await screen.findByTestId("demo-limits")
    const text = list.textContent ?? ""
    expect(text).toContain("No mail leaves this instance")
    expect(text).toContain("Connectors are fixtures")
    expect(text).toContain("Ads is not part of the demo")
    expect(text).toContain("once you confirm your email, within a small budget")
    expect(text).toContain("small budget per confirmed address")
    expect(text).toContain("expires")
    expect(list.querySelectorAll("li")).toHaveLength(6)
  })

  // The mail line names the one mail that leaves (the verification code) and
  // what happens to replies to the fictional customers; the agents line says
  // where the key comes from: ours once confirmed, or the visitor's own.
  it("tells the truth about mail and about where the agent key comes from", async () => {
    await serverSays(true)
    renderHost()
    fireEvent.click(screen.getByTestId("demo-limits-open"))
    const text = (await screen.findByTestId("demo-limits")).textContent ?? ""
    expect(text).toContain("except your verification code")
    expect(text).toContain("any other send is refused")
    expect(text).toContain("With your own model key they run on yours")
  })
})

describe("the seed still running", () => {
  it("says so plainly, and does not pretend the workspace is empty", async () => {
    storeWorkspace("provisioning", "2030-01-01T00:00:00.000Z")
    await serverSays(true)
    renderHost()
    expect(screen.getByTestId("demo-state-provisioning").textContent).toContain("still filling in")
  })

  it("says the seed failed and lets the visitor carry on", async () => {
    storeWorkspace("failed", "2030-01-01T00:00:00.000Z")
    await serverSays(true)
    renderHost()
    const notice = screen.getByTestId("demo-state-failed")
    expect(notice.textContent).toContain("failed to set up")
    expect(notice.getAttribute("role")).toBe("alert")
    fireEvent.click(screen.getByTestId("demo-state-dismiss"))
    expect(screen.queryByTestId("demo-state-failed")).toBeNull()
  })

  it("says nothing once the world is ready", async () => {
    storeWorkspace("ready", "2030-01-01T00:00:00.000Z")
    await serverSays(true)
    renderHost()
    expect(screen.queryByTestId("demo-state-provisioning")).toBeNull()
    expect(screen.queryByTestId("demo-state-failed")).toBeNull()
  })
})

const keyForm = () => <DemoByokPrompt />

describe("the model key form", () => {
  it("waits until the workspace is usable", async () => {
    storeWorkspace("provisioning", "2030-01-01T00:00:00.000Z")
    await serverSays(true)
    renderHost(keyForm)
    expect(screen.queryByTestId("demo-byok")).toBeNull()
  })

  it("explains why the key is needed", async () => {
    storeWorkspace("ready", "2030-01-01T00:00:00.000Z")
    await serverSays(true)
    renderHost(keyForm)
    const prompt = screen.getByTestId("demo-byok")
    expect(prompt.textContent).toContain("once you confirm your email")
    expect(prompt.textContent).toContain("stored encrypted")
    expect(prompt.textContent).toContain("Your own key lifts that budget")
  })

  it("writes through the shipped keys endpoint and reports real success", async () => {
    storeWorkspace("ready", "2030-01-01T00:00:00.000Z")
    await serverSays(true)
    const seen: { url: string; body: unknown }[] = []
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url
      seen.push({ url, body: init?.body ? JSON.parse(String(init.body)) : undefined })
      return new Response(JSON.stringify({ data: { provider: "anthropic" } }), {
        status: 200,
        headers: { "content-type": "application/json" },
      })
    })
    renderHost(keyForm)
    fireEvent.input(screen.getByTestId("demo-byok-key"), { target: { value: "sk-ant-secret" } })
    fireEvent.click(screen.getByTestId("demo-byok-save"))

    await waitFor(() => expect(screen.getByTestId("demo-byok-saved")).toBeInTheDocument())
    const call = seen.find((c) => c.url.includes("/settings/ai/keys"))
    expect(call?.body).toEqual({ provider: "anthropic", apiKey: "sk-ant-secret" })
  })

  it("surfaces the server's own refusal rather than a silent nothing", async () => {
    storeWorkspace("ready", "2030-01-01T00:00:00.000Z")
    await serverSays(true)
    vi.stubGlobal(
      "fetch",
      async () =>
        new Response(JSON.stringify({ error: { message: "That key was rejected upstream" } }), {
          status: 400,
          headers: { "content-type": "application/json" },
        }),
    )
    renderHost(keyForm)
    fireEvent.input(screen.getByTestId("demo-byok-key"), { target: { value: "bad" } })
    fireEvent.click(screen.getByTestId("demo-byok-save"))
    await waitFor(() =>
      expect(screen.getByTestId("demo-byok-error").textContent).toContain(
        "That key was rejected upstream",
      ),
    )
    expect(screen.getByTestId("demo-byok")).toBeInTheDocument()
  })
})

describe("a workspace whose time is up", () => {
  it("says so and offers a fresh one instead of a broken product", async () => {
    storeWorkspace("ready", "2000-01-01T00:00:00.000Z")
    await serverSays(true)
    renderHost()
    const over = screen.getByTestId("demo-expired")
    expect(over.getAttribute("aria-modal")).toBe("true")
    expect(over.textContent).toContain("has ended")
    // And the product surfaces underneath are not competing with it.
    expect(screen.queryByTestId("demo-welcome")).toBeNull()
    expect(screen.queryByTestId("demo-state-provisioning")).toBeNull()
  })

  it("clears the record and the session when a fresh one is asked for", async () => {
    storeWorkspace("ready", "2000-01-01T00:00:00.000Z")
    await serverSays(true)
    renderHost()
    fireEvent.click(screen.getByTestId("demo-expired-restart"))
    expect(localStorage.getItem("liaison:demo-workspace")).toBeNull()
    expect(screen.queryByTestId("demo-expired")).toBeNull()
  })
})

// A reload during provisioning used to lose the key prompt for good: the
// prompt waited on a readiness flag only this browser's poller could change,
// and nothing restarted that poller unless the stored value was exactly
// "provisioning". Readiness and "is a key needed" now come from the server.
describe("after a reload", () => {
  it("asks the server once and shows the key prompt when the seed has finished", async () => {
    storeWorkspace("provisioning", "2030-01-01T00:00:00.000Z")
    const seen = serverAnswers({ status: { state: "ready" }, models: [] })
    await serverSays(true)
    renderHost(keyForm)
    expect(await screen.findByTestId("demo-byok")).toBeInTheDocument()
    expect(screen.queryByTestId("demo-state-provisioning")).toBeNull()
    expect(seen.filter((u) => u.endsWith("/status"))).toHaveLength(1)
  })

  it("re-checks a failed record too, and does not ask about a ready one", async () => {
    storeWorkspace("failed", "2030-01-01T00:00:00.000Z")
    const seen = serverAnswers({ status: { state: "ready" }, models: [] })
    await serverSays(true)
    renderHost(keyForm)
    await waitFor(() => expect(screen.queryByTestId("demo-state-failed")).toBeNull())
    cleanup()
    seen.length = 0
    renderHost(keyForm)
    await screen.findByTestId("demo-byok")
    expect(seen.filter((u) => u.endsWith("/status"))).toHaveLength(0)
  })

  it("offers the prompt when the server says no model is usable, whatever this browser remembers", async () => {
    storeWorkspace("ready", "2030-01-01T00:00:00.000Z")
    // A "saved" flag left behind, with no key behind it on the server.
    localStorage.setItem("liaison:demo-byok-saved", "1")
    _hydrateDemoWorkspace()
    serverAnswers({ models: [] })
    await serverSays(true)
    renderHost(keyForm)
    expect(await screen.findByTestId("demo-byok")).toBeInTheDocument()
  })

  it("offers the prompt with no workspace record at all when no model is usable", async () => {
    serverAnswers({ models: [] })
    await serverSays(true)
    renderHost(keyForm)
    expect(await screen.findByTestId("demo-byok")).toBeInTheDocument()
  })

  it("does not nag an org that already has a usable model", async () => {
    storeWorkspace("ready", "2030-01-01T00:00:00.000Z")
    const seen = serverAnswers({ models: ["gemini-flash-lite-latest"] })
    await serverSays(true)
    renderHost(keyForm)
    await waitFor(() => expect(seen.some((u) => u.includes("/credits/models"))).toBe(true))
    await waitFor(() => expect(screen.queryByTestId("demo-byok")).toBeNull())
  })
})
