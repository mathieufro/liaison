// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The manifests feed is what puts every app on the page (nav, settings pages,
// the App store's rows). A signed-in first read that fails (a 5xx or a timeout
// while a new workspace is still being set up) must be read again, and a
// reload asked for while the first read is in flight must not be dropped:
// either one left the session with no apps until a page reload.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { getTabType, resetRegistry } from "~/framework/app-registry"
import { loadManifestApps, reloadManifestApps, resetBootstrap } from "~/framework/bootstrap"
import { clearAuth, setTokens } from "~/modules/auth/auth-store"

const mailManifest = {
  name: "mail",
  version: "1.0.0",
  views: {
    tabTypes: { "mail:inbox": { component: "MailInbox", label: "Mail" } },
    activityBar: { icon: "MailIcon", label: "Mail", order: 10 },
  },
}

function feed(apps: unknown[]): Response {
  return new Response(JSON.stringify({ data: apps, unavailableApps: [] }), {
    headers: { "Content-Type": "application/json" },
  })
}

const withMail = () => feed([{ name: "mail", manifest: mailManifest, uiBundleUrl: null }])

/**
 * Stub `fetch`: each manifests read takes the next answer in turn; the app
 * features read that follows a successful manifests read answers an empty list.
 * The counters below count each endpoint on its own.
 */
function stubFeed(manifestAnswers: Array<() => Promise<Response>>) {
  const manifestReads = vi.fn((_url: string) => {
    const next = manifestAnswers.shift()
    if (!next) throw new Error("unexpected manifests read")
    return next()
  })
  const featureReads = vi.fn((_url: string) => Promise.resolve(feed([])))
  vi.stubGlobal(
    "fetch",
    vi.fn((input: RequestInfo | URL) => {
      const url = String(input)
      if (url.endsWith("/apps/manifests")) return manifestReads(url)
      if (url.endsWith("/apps/features")) return featureReads(url)
      throw new Error(`unexpected fetch ${url}`)
    }),
  )
  return { manifestReads, featureReads }
}

/** Let pending fetch/json/registration work run (it imports the app's module). */
async function until(check: () => boolean): Promise<void> {
  const deadline = Date.now() + 5_000
  while (!check() && Date.now() < deadline) {
    await new Promise<void>((resolve) => setImmediate(resolve))
  }
}

describe("manifest feed: no session left without apps", () => {
  beforeEach(() => {
    // Only the retry's timer is faked; module imports and I/O run for real.
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] })
    vi.stubGlobal("localStorage", {
      getItem: vi.fn(() => "fake-token"),
      setItem: vi.fn(),
      removeItem: vi.fn(),
    })
    resetRegistry()
    resetBootstrap()
    setTokens("fake-token")
  })

  afterEach(() => {
    resetBootstrap()
    resetRegistry()
    clearAuth()
    vi.unstubAllGlobals()
    vi.useRealTimers()
  })

  it("a failed first read is read again until it succeeds", async () => {
    const { manifestReads, featureReads } = stubFeed([
      async () => new Response("busy", { status: 503 }),
      async () => withMail(),
    ])

    await loadManifestApps()
    expect(getTabType("mail:inbox")).toBeUndefined()
    expect(manifestReads).toHaveBeenCalledTimes(1)
    // A failed manifests read reads no features either.
    expect(featureReads).toHaveBeenCalledTimes(0)

    await vi.advanceTimersByTimeAsync(30_000)
    await until(() => getTabType("mail:inbox") !== undefined)
    expect(manifestReads).toHaveBeenCalledTimes(2)
    expect(featureReads).toHaveBeenCalledTimes(1)
    expect(getTabType("mail:inbox")).toBeDefined()

    // Loaded: no further reads on a timer.
    await vi.advanceTimersByTimeAsync(120_000)
    expect(manifestReads).toHaveBeenCalledTimes(2)
    expect(featureReads).toHaveBeenCalledTimes(1)
  })

  it("a reload asked for during the first read runs after it", async () => {
    let answerFirst: (r: Response) => void = () => {}
    const { manifestReads, featureReads } = stubFeed([
      () =>
        new Promise<Response>((resolve) => {
          answerFirst = resolve
        }),
      async () => withMail(),
    ])

    const first = loadManifestApps()
    await until(() => manifestReads.mock.calls.length > 0)
    // The scopes changed while the first read was on the wire (its token was
    // the old one): the reload must not be lost.
    const reload = reloadManifestApps()
    answerFirst(feed([]))
    await first
    await reload
    await until(() => getTabType("mail:inbox") !== undefined)

    expect(manifestReads).toHaveBeenCalledTimes(2)
    // One features read per successful manifests read, never a repeat.
    expect(featureReads).toHaveBeenCalledTimes(2)
    expect(getTabType("mail:inbox")).toBeDefined()
  })
})
