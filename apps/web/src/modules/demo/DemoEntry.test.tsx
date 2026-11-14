// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The entry screen is the whole demo, so the one door and every refusal the
// server can hand back are exercised here.

import { DEMO_ENTRY_TEXT_MAX, DEMO_WORLD_NEEDS, type DemoNeed } from "@liaison/shared"
import { Route, Router } from "@solidjs/router"
import { cleanup, fireEvent, render, screen, waitFor } from "@solidjs/testing-library"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { clearAuth, isAuthenticated } from "~/modules/auth/auth-store"
import { DemoEntry, linkedEntry, linkedNeeds, parseNeedsParam } from "~/modules/demo/DemoEntry"
import { _resetDemoStore, demoWorkspace } from "~/modules/demo/demo-store"
import { _setDoorWorlds } from "~/modules/demo/demo-world"
import { DEMO_DOOR } from "~/modules/demo/door-company"
import { needsAfterEntry } from "~/modules/demo/EntryQuestion"
import { I18nProvider } from "~/modules/i18n/i18n-context"
import { _resetBranding, ensureBrandingLoaded } from "~/modules/shell/branding-store"
import kernelEn from "../../../../../packages/shared/src/i18n/locales/en/kernel.json"

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

interface Reply {
  status: number
  body: unknown
  headers?: Record<string, string>
}

/** A fetch mock that answers per path and records what it was asked. */
function serve(replies: Record<string, Reply>): { calls: { url: string; body: unknown }[] } {
  const calls: { url: string; body: unknown }[] = []
  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url
    calls.push({ url, body: init?.body ? JSON.parse(String(init.body)) : undefined })
    for (const [needle, reply] of Object.entries(replies)) {
      if (url.includes(needle)) {
        return new Response(JSON.stringify(reply.body), {
          status: reply.status,
          headers: { "content-type": "application/json", ...(reply.headers ?? {}) },
        })
      }
    }
    return new Response(JSON.stringify({ error: { message: "unmapped" } }), { status: 404 })
  })
  return { calls }
}

/** Tiles sit in `DEMO_WORLD_NEEDS.products` order, so the DOM lists picks in that order. */
const cmpTile = (a: string, b: string) =>
  DEMO_WORLD_NEEDS.products.indexOf(a as DemoNeed) -
  DEMO_WORLD_NEEDS.products.indexOf(b as DemoNeed)

function renderEntry(onSignedIn = vi.fn()) {
  render(() => (
    <I18nProvider initialLocale="en">
      <Router>
        <Route path="*" component={() => <DemoEntry onSignedIn={onSignedIn} />} />
      </Router>
    </I18nProvider>
  ))
  return { onSignedIn }
}

beforeEach(() => {
  _resetBranding()
  _resetDemoStore()
  clearAuth()
})

afterEach(() => {
  cleanup()
  window.history.replaceState(null, "", "/")
  vi.unstubAllGlobals()
  _resetDemoStore()
  clearAuth()
})

describe("the door that creates a workspace", () => {
  /** Steps 1 and 2: pick a scenario, continue past the company page. */
  function pick() {
    fireEvent.click(screen.getByTestId("demo-needs-support"))
    fireEvent.click(screen.getByTestId("demo-continue"))
    fireEvent.click(screen.getByTestId("demo-company-continue"))
  }
  /** Step 3: the details. */
  function fill() {
    fireEvent.input(screen.getByTestId("demo-name"), { target: { value: "Jane Doe" } })
    fireEvent.input(screen.getByTestId("demo-email"), { target: { value: "v@example.com" } })
  }

  const CREATED = {
    orgId: "11111111-1111-4111-8111-111111111111",
    orgSlug: "demo-acme-abc",
    userId: "u1",
    state: "provisioning",
    statusUrl: "/api/demo/orgs/11111111-1111-4111-8111-111111111111/status",
    expiresAt: "2030-01-01T00:00:00.000Z",
    accessToken: "",
  }

  it("puts the visitor into the product while the world is still seeding", async () => {
    serve({
      "/demo/orgs": { status: 201, body: { data: { ...CREATED, accessToken: jwt() } } },
    })
    const { onSignedIn } = renderEntry()
    pick()
    fill()
    fireEvent.click(screen.getByTestId("demo-create"))

    await waitFor(() => expect(onSignedIn).toHaveBeenCalledTimes(1))
    // The state is honestly still `provisioning`, and the session is live.
    expect(demoWorkspace()?.state).toBe("provisioning")
    expect(isAuthenticated()).toBe(true)
  })

  it("reads a 429 as a wait, not as an error code", async () => {
    serve({
      "/demo/orgs": {
        status: 429,
        body: { error: { message: "Too many" } },
        headers: { "Retry-After": "900" },
      },
    })
    renderEntry()
    pick()
    fill()
    fireEvent.click(screen.getByTestId("demo-create"))
    await waitFor(() =>
      expect(screen.getByTestId("demo-signup-error").textContent).toContain(
        "Try again in about 15 minutes",
      ),
    )
    expect(isAuthenticated()).toBe(false)
  })

  it("reads a 503 duplicate as work already under way", async () => {
    serve({
      "/demo/orgs": {
        status: 503,
        body: { error: { message: "in progress" } },
        headers: { "Retry-After": "2" },
      },
    })
    renderEntry()
    pick()
    fill()
    fireEvent.click(screen.getByTestId("demo-create"))
    await waitFor(() =>
      expect(screen.getByTestId("demo-signup-error").textContent).toContain(
        "already being prepared",
      ),
    )
  })

  it("reads a 404 as a server that is not running the demo", async () => {
    serve({ "/demo/orgs": { status: 404, body: { error: { message: "Not found" } } } })
    renderEntry()
    pick()
    fill()
    fireEvent.click(screen.getByTestId("demo-create"))
    await waitFor(() =>
      expect(screen.getByTestId("demo-signup-error").textContent).toContain("not running the demo"),
    )
  })

  it("says a busy moment calmly while the server prepares the workspace, and keeps trying on its own", async () => {
    serve({
      "/demo/orgs": {
        status: 202,
        body: { data: { state: "creating", retryAfter: 5 } },
        headers: { "retry-after": "5" },
      },
    })
    renderEntry()
    pick()
    fill()
    fireEvent.click(screen.getByTestId("demo-create"))
    await waitFor(() =>
      expect(screen.getByTestId("demo-signup-preparing").textContent).toContain("busy moment"),
    )
    expect(screen.queryByTestId("demo-signup-error")).toBeNull()
    expect(screen.getByTestId("demo-create")).toBeDisabled()
  })

  it("will not submit without a name and an address", () => {
    serve({})
    renderEntry()
    pick()
    expect(screen.getByTestId("demo-create")).toBeDisabled()
    fill()
    expect(screen.getByTestId("demo-create")).not.toBeDisabled()
  })
})

describe("three pages: scenarios, the company, your details", () => {
  const counter = () =>
    ["scenarios", "company", "details"].map((id) =>
      screen.getByTestId(`demo-step-${id}`).getAttribute("data-state"),
    )

  it("goes scenarios, company, details, and each back link goes one page back", () => {
    serve({})
    renderEntry()
    expect(screen.getByTestId("demo-pick-step")).toBeTruthy()
    expect(screen.queryByTestId("demo-intro")).toBeNull()
    expect(counter()).toEqual(["current", "todo", "todo"])
    expect(screen.getByTestId("demo-step-scenarios").getAttribute("aria-current")).toBe("step")

    fireEvent.click(screen.getByTestId("demo-needs-support"))
    fireEvent.click(screen.getByTestId("demo-continue"))
    expect(screen.getByTestId("demo-company-step")).toBeTruthy()
    expect(screen.queryByTestId("demo-name")).toBeNull()
    expect(counter()).toEqual(["done", "current", "todo"])
    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe("Resonant Audio Labs")
    expect(screen.getByTestId("demo-company-ops").children).toHaveLength(6)
    const team = screen.getByTestId("demo-team").textContent ?? ""
    expect(team).toContain("CEO")
    expect(team).toContain("Giulia Ferrari")
    expect(team).not.toContain("Elodie")

    fireEvent.click(screen.getByTestId("demo-company-continue"))
    expect(screen.getByTestId("demo-signup-door")).toBeTruthy()
    expect(screen.getByTestId("demo-name")).toBeTruthy()
    expect(counter()).toEqual(["done", "done", "current"])

    fireEvent.click(screen.getByTestId("demo-details-back"))
    expect(screen.getByTestId("demo-company-step")).toBeTruthy()
    fireEvent.click(screen.getByTestId("demo-change-picks"))
    expect(screen.getByTestId("demo-pick-step")).toBeTruthy()
    expect(screen.getByTestId("demo-needs-rank-support").textContent).toBe("1")
  })

  it("lands a needs link and the explore link on the company page, with the picks", () => {
    serve({})
    window.history.replaceState(null, "", "/demo?needs=commerce,support")
    renderEntry()
    expect(screen.getByTestId("demo-company-step")).toBeTruthy()
    expect(screen.getByTestId("demo-picked-commerce").textContent).toContain("Orders & shipping")
    expect(screen.getByTestId("demo-picked-support").textContent).toContain("Customer support")
    cleanup()

    window.history.replaceState(null, "", "/")
    renderEntry()
    fireEvent.click(screen.getByTestId("demo-explore"))
    expect(screen.getByTestId("demo-company-step")).toBeTruthy()
    expect(screen.getByTestId("demo-picked-all").textContent).toBe(
      "Everything loaded, explore at your own pace",
    )
  })

  it("keeps only the name, the email and Start on the details page, not the picks", () => {
    serve({})
    renderEntry()
    fireEvent.click(screen.getByTestId("demo-needs-support"))
    fireEvent.click(screen.getByTestId("demo-continue"))
    expect(screen.getByTestId("demo-picked")).toBeTruthy()
    fireEvent.click(screen.getByTestId("demo-company-continue"))
    expect(screen.queryByTestId("demo-picked")).toBeNull()
    expect(screen.queryByTestId("demo-picked-support")).toBeNull()
    expect(screen.queryByTestId("demo-intro")).toBeNull()
    expect(screen.getByTestId("demo-name")).toBeTruthy()
    expect(screen.getByTestId("demo-email")).toBeTruthy()
    expect(screen.getByTestId("demo-create")).toBeTruthy()
    expect(screen.getByTestId("demo-lead-notice")).toBeTruthy()
  })
})

describe("the notice under the button", () => {
  it("tells the visitor what the address is for, with an unticked news box and no link when none is set", () => {
    serve({})
    renderEntry()
    fireEvent.click(screen.getByTestId("demo-needs-support"))
    fireEvent.click(screen.getByTestId("demo-continue"))
    fireEvent.click(screen.getByTestId("demo-company-continue"))
    expect(screen.getByTestId("demo-lead-notice").textContent).toContain(
      "Unless you tick the box and confirm your email, your name and email are deleted when your demo ends, after 72 hours.",
    )
    expect(screen.queryByTestId("demo-privacy-link")).toBeNull()
    expect((screen.getByTestId("demo-news-opt-in") as HTMLInputElement).checked).toBe(false)
  })

  it("links the instance's privacy policy when the server names one", async () => {
    serve({
      "/settings/branding": {
        status: 200,
        body: {
          data: {
            orgName: "Demo",
            flags: { demo: true },
            privacyUrl: "https://example.com/privacy",
          },
        },
      },
    })
    await ensureBrandingLoaded()
    renderEntry()
    fireEvent.click(screen.getByTestId("demo-needs-support"))
    fireEvent.click(screen.getByTestId("demo-continue"))
    fireEvent.click(screen.getByTestId("demo-company-continue"))
    await waitFor(() =>
      expect(screen.getByTestId("demo-privacy-link").getAttribute("href")).toBe(
        "https://example.com/privacy",
      ),
    )
  })
})

describe("a link that preselects needs", () => {
  it("keeps the given order and drops unknown and repeated values", () => {
    expect(parseNeedsParam("commerce,support")).toEqual(["commerce", "support"])
    expect(parseNeedsParam(" Sales ,junk,sales,,dev")).toEqual(["sales", "dev"])
    expect(parseNeedsParam("junk")).toEqual([])
    expect(parseNeedsParam(undefined)).toEqual([])
  })

  it("reads all as every need in canonical order", () => {
    expect(parseNeedsParam("all")).toEqual([
      "support",
      "projects",
      "chat",
      "sales",
      "commerce",
      "dev",
      "knowledge",
    ])
  })

  it("reads knowledge, the company knowledge scenario, for a link to it alone", () => {
    expect(parseNeedsParam("knowledge")).toEqual(["knowledge"])
  })

  it("finds the parameter inside the sign-in redirect's returnTo", () => {
    expect(linkedNeeds({ returnTo: "/?needs=projects,chat" })).toEqual(["projects", "chat"])
    expect(linkedNeeds({ needs: "dev", returnTo: "/?needs=chat" })).toEqual(["dev"])
    expect(linkedNeeds({ returnTo: "https://evil.example/?needs=chat" })).toEqual([])
  })

  it("lands a link on the company page with its picks, and they stay changeable", () => {
    serve({})
    window.history.replaceState(null, "", "/demo?needs=commerce,support")
    renderEntry()
    expect(screen.getByTestId("demo-company-step")).toBeTruthy()
    const picked = screen.getByTestId("demo-picked").textContent
    expect(picked).toContain("Orders & shipping")
    expect(picked?.indexOf("Orders & shipping")).toBeLessThan(
      picked?.indexOf("Customer support") ?? 0,
    )
    fireEvent.click(screen.getByTestId("demo-change-picks"))
    expect(screen.getByTestId("demo-needs-rank-commerce").textContent).toBe("1")
    expect(screen.getByTestId("demo-needs-rank-support").textContent).toBe("2")
    fireEvent.click(screen.getByTestId("demo-needs-commerce"))
    expect(screen.queryByTestId("demo-needs-rank-commerce")).toBeNull()
    expect(screen.getByTestId("demo-needs-rank-support").textContent).toBe("1")
  })

  it("reads a single-need link inside the sign-in redirect", () => {
    serve({})
    window.history.replaceState(null, "", "/login?returnTo=%2F%3Fneeds%3Dsupport")
    renderEntry()
    expect(screen.getByTestId("demo-picked-support").textContent).toContain("Customer support")
  })

  it("sends the linked needs with the signup", async () => {
    const { calls } = serve({
      "/demo/orgs": { status: 503, body: { error: { message: "in progress" } } },
    })
    window.history.replaceState(null, "", "/?needs=all")
    renderEntry()
    fireEvent.click(screen.getByTestId("demo-company-continue"))
    fireEvent.input(screen.getByTestId("demo-name"), { target: { value: "Jane Doe" } })
    fireEvent.input(screen.getByTestId("demo-email"), { target: { value: "v@example.com" } })
    fireEvent.click(screen.getByTestId("demo-create"))
    await waitFor(() => expect(calls.some((c) => c.url.includes("/demo/orgs"))).toBe(true))
    const signup = calls.find((c) => c.url.includes("/demo/orgs"))
    expect(signup?.body).toMatchObject({
      needs: ["support", "projects", "chat", "sales", "commerce", "dev", "knowledge"],
    })
  })
})

describe("the company question", () => {
  const ranks = () =>
    screen
      .getAllByTestId(/^demo-needs-rank-/)
      .map((el) => [
        el.getAttribute("data-testid")?.replace("demo-needs-rank-", ""),
        el.textContent,
      ])

  /** Fill the two later pages and press Start; the signup request it sends. */
  async function signUp(calls: { url: string; body: unknown }[]) {
    fireEvent.click(screen.getByTestId("demo-continue"))
    fireEvent.click(screen.getByTestId("demo-company-continue"))
    fireEvent.input(screen.getByTestId("demo-name"), { target: { value: "Jane Doe" } })
    fireEvent.input(screen.getByTestId("demo-email"), { target: { value: "v@example.com" } })
    fireEvent.click(screen.getByTestId("demo-create"))
    await waitFor(() => expect(calls.some((c) => c.url.includes("/demo/orgs"))).toBe(true))
    return calls.find((c) => c.url.includes("/demo/orgs"))?.body as Record<string, unknown>
  }

  it("is on the needs page, adds no step and asks for nothing first", () => {
    serve({})
    renderEntry()
    expect(screen.getByTestId("demo-pick-step")).toBeTruthy()
    expect(screen.getByTestId("demo-entry-question").textContent).toContain(
      "Which looks most like your company?",
    )
    expect(screen.getAllByTestId(/^demo-step-/)).toHaveLength(3)
    expect(screen.queryAllByTestId(/^demo-needs-rank-/)).toEqual([])
    fireEvent.click(screen.getByTestId("demo-needs-support"))
    fireEvent.click(screen.getByTestId("demo-continue"))
    expect(screen.getByTestId("demo-company-step")).toBeTruthy()
  })

  it.each([
    ["products", ["support", "commerce", "knowledge"]],
    ["software", ["support", "dev", "knowledge"]],
    ["expertise", ["projects", "sales", "knowledge"]],
  ])("%s preselects its needs, in order, on the same page", (entry, needs) => {
    serve({})
    renderEntry()
    fireEvent.click(screen.getByTestId(`demo-entry-${entry}`))
    expect(screen.getByTestId(`demo-entry-${entry}`).getAttribute("aria-pressed")).toBe("true")
    expect(screen.getByTestId("demo-pick-step")).toBeTruthy()
    expect(screen.getByTestId("demo-entry-preselected")).toBeTruthy()
    expect(ranks()).toEqual(
      needs.map((need, i) => [need, String(i + 1)]).sort((a, b) => cmpTile(a[0], b[0])),
    )
  })

  it("leaves the picks open to adjusting, and sends what the visitor settled on", async () => {
    const { calls } = serve({
      "/demo/orgs": { status: 503, body: { error: { message: "in progress" } } },
    })
    renderEntry()
    fireEvent.click(screen.getByTestId("demo-entry-software"))
    fireEvent.click(screen.getByTestId("demo-needs-dev"))
    fireEvent.click(screen.getByTestId("demo-needs-chat"))
    const body = await signUp(calls)
    expect(body.needs).toEqual(["support", "knowledge", "chat"])
    expect(body.entry).toEqual({ id: "software" })
  })

  it("other keeps the empty start, asks for a short text, and Continue explores", async () => {
    const { calls } = serve({
      "/demo/orgs": { status: 503, body: { error: { message: "in progress" } } },
    })
    renderEntry()
    expect((screen.getByTestId("demo-continue") as HTMLButtonElement).disabled).toBe(true)
    fireEvent.click(screen.getByTestId("demo-entry-other"))
    expect(screen.queryAllByTestId(/^demo-needs-rank-/)).toEqual([])
    const text = screen.getByTestId("demo-entry-other-text") as HTMLInputElement
    expect(text.maxLength).toBe(DEMO_ENTRY_TEXT_MAX)
    fireEvent.input(text, { target: { value: "  <b>A bakery</b>  " } })
    expect((screen.getByTestId("demo-continue") as HTMLButtonElement).disabled).toBe(false)
    fireEvent.click(screen.getByTestId("demo-continue"))
    expect(screen.getByTestId("demo-picked-all").textContent).toBe(
      "Everything loaded, explore at your own pace",
    )
    fireEvent.click(screen.getByTestId("demo-company-continue"))
    fireEvent.input(screen.getByTestId("demo-name"), { target: { value: "Jane Doe" } })
    fireEvent.input(screen.getByTestId("demo-email"), { target: { value: "v@example.com" } })
    fireEvent.click(screen.getByTestId("demo-create"))
    await waitFor(() => expect(calls.some((c) => c.url.includes("/demo/orgs"))).toBe(true))
    const body = calls.find((c) => c.url.includes("/demo/orgs"))?.body as Record<string, unknown>
    expect(body.entry).toEqual({ id: "other", text: "<b>A bakery</b>" })
  })

  it("sends no entry when the question is skipped, or pressed again to clear it", async () => {
    const { calls } = serve({
      "/demo/orgs": { status: 503, body: { error: { message: "in progress" } } },
    })
    renderEntry()
    fireEvent.click(screen.getByTestId("demo-entry-products"))
    fireEvent.click(screen.getByTestId("demo-entry-products"))
    expect(screen.queryAllByTestId(/^demo-needs-rank-/)).toEqual([])
    fireEvent.click(screen.getByTestId("demo-needs-support"))
    const body = await signUp(calls)
    expect(body).not.toHaveProperty("entry")
    expect(body.needs).toEqual(["support"])
  })

  it("keeps the answer when the visitor explores on their own", async () => {
    const { calls } = serve({
      "/demo/orgs": { status: 503, body: { error: { message: "in progress" } } },
    })
    renderEntry()
    fireEvent.click(screen.getByTestId("demo-entry-expertise"))
    fireEvent.click(screen.getByTestId("demo-explore"))
    fireEvent.click(screen.getByTestId("demo-company-continue"))
    fireEvent.input(screen.getByTestId("demo-name"), { target: { value: "Jane Doe" } })
    fireEvent.input(screen.getByTestId("demo-email"), { target: { value: "v@example.com" } })
    fireEvent.click(screen.getByTestId("demo-create"))
    await waitFor(() => expect(calls.some((c) => c.url.includes("/demo/orgs"))).toBe(true))
    const body = calls.find((c) => c.url.includes("/demo/orgs"))?.body as Record<string, unknown>
    expect(body.entry).toEqual({ id: "expertise" })
    expect(body.needs).toHaveLength(7)
  })

  it("renders the free text as text in its field, never as markup", () => {
    serve({})
    renderEntry()
    fireEvent.click(screen.getByTestId("demo-entry-other"))
    fireEvent.input(screen.getByTestId("demo-entry-other-text"), {
      target: { value: "<img src=x onerror=alert(1)>" },
    })
    expect(document.querySelector("[data-testid='demo-entry'] img")).toBeNull()
  })

  it("says Resonant is an example where the visitor meets it", () => {
    serve({})
    window.history.replaceState(null, "", "/demo?needs=support")
    renderEntry()
    expect(screen.getByTestId("demo-example-line").textContent).toBe(
      "This is an example company: Resonant Audio Labs, which makes field recorders. Your own workspace would hold your data.",
    )
  })
})

describe("needsAfterEntry", () => {
  it("sets a preset, whatever was picked", () => {
    expect(needsAfterEntry(["chat"], null, "products", ["products"])).toEqual([
      "support",
      "commerce",
      "knowledge",
    ])
  })

  it("clears an untouched preset for other or no answer", () => {
    expect(
      needsAfterEntry(["support", "dev", "knowledge"], "software", "other", ["products"]),
    ).toEqual([])
    expect(
      needsAfterEntry(["support", "dev", "knowledge"], "software", null, ["products"]),
    ).toEqual([])
  })

  it("keeps what the visitor picked by hand for other or no answer", () => {
    expect(needsAfterEntry(["support", "chat"], "software", "other", ["products"])).toEqual([
      "support",
      "chat",
    ])
    expect(needsAfterEntry(["chat"], null, "other", ["products"])).toEqual(["chat"])
  })
})

describe("the entry link parameter", () => {
  it("reads a known entry, trimmed and in any case, and only that", () => {
    expect(linkedEntry({ entry: "software" })).toBe("software")
    expect(linkedEntry({ entry: " EXPERTISE " })).toBe("expertise")
    for (const entry of ["crm", "", "products,software", "<script>", "__proto__"]) {
      expect(linkedEntry({ entry })).toBeNull()
    }
    expect(linkedEntry({})).toBeNull()
  })

  it("finds it inside the sign-in redirect's returnTo, from this site only", () => {
    expect(linkedEntry({ returnTo: "/?entry=products" })).toBe("products")
    expect(linkedEntry({ entry: "other", returnTo: "/?entry=products" })).toBe("other")
    expect(linkedEntry({ returnTo: "https://evil.example/?entry=products" })).toBeNull()
  })

  it("lands on the company page with the entry's needs, as a needs link does", () => {
    serve({})
    window.history.replaceState(null, "", "/demo?entry=software")
    renderEntry()
    expect(screen.getByTestId("demo-company-step")).toBeTruthy()
    expect(screen.getByTestId("demo-picked-dev")).toBeTruthy()
    fireEvent.click(screen.getByTestId("demo-change-picks"))
    expect(screen.getByTestId("demo-entry-software").getAttribute("aria-pressed")).toBe("true")
  })

  it("lets a needs link keep its own picks beside an entry", () => {
    serve({})
    window.history.replaceState(null, "", "/demo?entry=software&needs=chat")
    renderEntry()
    expect(screen.getByTestId("demo-picked-chat")).toBeTruthy()
    expect(screen.queryByTestId("demo-picked-dev")).toBeNull()
  })

  it("stays on the needs page for other, and never takes free text from a link", () => {
    serve({})
    window.history.replaceState(null, "", "/demo?entry=other&text=hello")
    renderEntry()
    expect(screen.getByTestId("demo-pick-step")).toBeTruthy()
    expect((screen.getByTestId("demo-entry-other-text") as HTMLInputElement).value).toBe("")
  })

  it("ignores an unknown entry: the door opens as usual", () => {
    serve({})
    window.history.replaceState(null, "", "/demo?entry=crm")
    renderEntry()
    expect(screen.getByTestId("demo-pick-step")).toBeTruthy()
    expect(screen.queryAllByTestId(/^demo-needs-rank-/)).toEqual([])
  })
})

describe("the door in a world", () => {
  const door = (worlds: string[]) => ({ "/demo/door": { status: 200, body: { data: { worlds } } } })
  const both = ["products", "saas"]

  it("an entry link presets the answer, a needs link wins over it, an unknown entry is none and a need outside the world drops", async () => {
    serve(door(both))
    window.history.replaceState(null, "", "/demo?entry=software")
    renderEntry()
    // The software answer opens its own world once the door has said it runs.
    await waitFor(() => expect(screen.getByTestId("demo-picked-money")).toBeTruthy())
    expect(screen.queryByTestId("demo-picked-commerce")).toBeNull()
    cleanup()
    _resetDemoStore()

    serve(door(both))
    window.history.replaceState(null, "", "/demo?entry=software&needs=chat,commerce,money")
    renderEntry()
    // commerce is not one of the software world's seven: dropped, the rest kept in order.
    await waitFor(() => expect(screen.getByTestId("demo-picked-money")).toBeTruthy())
    expect(screen.getByTestId("demo-picked-chat")).toBeTruthy()
    expect(screen.queryByTestId("demo-picked-commerce")).toBeNull()
    expect(screen.queryByTestId("demo-picked-dev")).toBeNull()
    cleanup()
    _resetDemoStore()

    serve(door(both))
    window.history.replaceState(null, "", "/demo?entry=crm")
    renderEntry()
    expect(screen.getByTestId("demo-pick-step")).toBeTruthy()
    expect(screen.queryAllByTestId(/^demo-needs-rank-/)).toEqual([])
    expect(parseNeedsParam("money,support", "products")).toEqual(["support"])
    expect(parseNeedsParam("all", "saas")).toEqual([...DEMO_WORLD_NEEDS.saas])
    expect(linkedNeeds({ returnTo: "/?needs=money,client,dev" }, "saas")).toEqual(["money", "dev"])
  })

  it("the company step of the software world equals the shipped strings", () => {
    _setDoorWorlds(both as ("products" | "saas")[])
    serve(door(both))
    window.history.replaceState(null, "", "/demo")
    renderEntry()
    fireEvent.click(screen.getByTestId("demo-entry-software"))
    fireEvent.click(screen.getByTestId("demo-continue"))
    const copy = kernelEn.demo.world.saas
    const company = DEMO_DOOR.saas
    expect(screen.getByTestId("demo-company-step").textContent).toContain(company.name)
    expect(screen.getByText(copy.companyFacts)).toBeTruthy()
    expect(screen.getByTestId("demo-example-line").textContent).toBe(copy.companyExample)
    expect(screen.getByText(copy.companyAbout)).toBeTruthy()
    for (const op of company.opsList) {
      const row = screen.getByTestId(`demo-company-op-${op.key}`).textContent ?? ""
      const entry = copy.companyOps[op.key as keyof typeof copy.companyOps]
      expect(row).toContain(entry.title)
      expect(row).toContain(entry.body)
    }
    expect(screen.getByText(copy.companyYou)).toBeTruthy()
    const team = screen.getByTestId("demo-team").textContent ?? ""
    for (const person of company.team) {
      expect(team).toContain(person.name)
      expect(team).toContain(copy.teamRole[person.key as keyof typeof copy.teamRole])
    }
    expect(screen.getByTestId("demo-company-simulated").textContent).toBe(copy.companySimulated)
    // Nothing of the products company is on this page.
    expect(screen.getByTestId("demo-company-step").textContent).not.toContain("Resonant")
  })

  it("a door whose config changed before Start returns to the company step", async () => {
    let doorWorlds = both
    const calls: string[] = []
    vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url
      calls.push(url)
      if (url.includes("/demo/door")) {
        return new Response(JSON.stringify({ data: { worlds: doorWorlds } }), {
          status: 200,
          headers: { "content-type": "application/json" },
        })
      }
      return new Response(JSON.stringify({ error: { message: "unmapped" } }), { status: 404 })
    })
    window.history.replaceState(null, "", "/demo?entry=software")
    renderEntry()
    await waitFor(() => expect(screen.getByTestId("demo-picked-money")).toBeTruthy())
    fireEvent.click(screen.getByTestId("demo-company-continue"))
    fireEvent.input(screen.getByTestId("demo-name"), { target: { value: "Jane Doe" } })
    fireEvent.input(screen.getByTestId("demo-email"), { target: { value: "v@example.com" } })
    // The software company is switched off between the door's read and Start.
    doorWorlds = ["products"]
    fireEvent.click(screen.getByTestId("demo-create"))
    await waitFor(() => expect(screen.getByTestId("demo-company-step")).toBeTruthy())
    expect(screen.getByTestId("demo-example-line").textContent).toContain("Resonant Audio Labs")
    expect(calls.some((url) => url.includes("/demo/orgs"))).toBe(false)
    _setDoorWorlds(["products"])
  })

  it("other with or without text and no answer open the products world, the text rendered nowhere", () => {
    _setDoorWorlds(both as ("products" | "saas")[])
    serve(door(both))
    window.history.replaceState(null, "", "/demo")
    renderEntry()
    expect(screen.getByTestId("demo-needs-commerce")).toBeTruthy()
    fireEvent.click(screen.getByTestId("demo-entry-other"))
    fireEvent.input(screen.getByTestId("demo-entry-other-text"), {
      target: { value: "ZZFREE makes things" },
    })
    expect(screen.getByTestId("demo-needs-commerce")).toBeTruthy()
    expect(screen.queryByTestId("demo-needs-money")).toBeNull()
    fireEvent.click(screen.getByTestId("demo-explore"))
    expect(screen.getByTestId("demo-example-line").textContent).toContain("Resonant Audio Labs")
    expect(document.body.textContent).not.toContain("ZZFREE")
  })
})
