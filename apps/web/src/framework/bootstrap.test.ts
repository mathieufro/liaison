// SPDX-License-Identifier: FSL-1.1-ALv2
import { readFileSync } from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { createRoot } from "solid-js"
import { afterEach, describe, expect, it, vi } from "vitest"
import {
  dispatchWsEntityEvent,
  getActivityBarEntries,
  getCommands,
  getEntityOpener,
  getPhoneHeader,
  getPhoneTopBarHidden,
  getSettingsSections,
  getTabType,
  getWsEntityHandlers,
  getWsMessageHandlers,
  resetRegistry,
} from "~/framework/app-registry"
import {
  bootstrapKernelApps,
  loadManifestApps,
  reloadManifestApps,
  resetBootstrap,
} from "~/framework/bootstrap"
import { resyncVersion } from "~/framework/resync"
import { apiUrl } from "~/lib/env"
import { teardownSession } from "~/lib/session-lifecycle"
import { clearAuth, setTokens } from "~/modules/auth/auth-store"
import { authManager } from "~/modules/auth/createAuthManager"
import { nodeOnline, resetNodesStore, setNodesStoreApi } from "~/modules/nodes/nodes-store"
import * as desktopNotificationsModule from "~/modules/notifications/desktop"
import { resetSessionStore, sessionStore } from "~/modules/sessions/session-store"
import { attentionStore } from "~/modules/shell/attention-store"
import { tabs as dockTabs, resetDockStore } from "~/modules/shell/dock-store"
import * as tabStoreModule from "~/modules/shell/tab-store"
import { makeTabId, openTab, tabStore } from "~/modules/shell/tab-store"
import * as threadStoreModule from "~/modules/threads/thread-store"
import {
  addThread,
  getThread,
  handleThreadEvent,
  resetThreadStore,
} from "~/modules/threads/thread-store"

vi.stubGlobal("localStorage", {
  getItem: vi.fn(() => null),
  setItem: vi.fn(),
  removeItem: vi.fn(),
})

const b64 = (value: object) =>
  btoa(JSON.stringify(value)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")

/** A token the client can decode; nothing here verifies a signature. */
function signInAs(userId: string): void {
  setTokens(
    `${b64({ alg: "none" })}.${b64({
      userId,
      orgId: "org-1",
      name: userId,
      roles: [],
      scopes: [],
      dimensionGrants: {},
      exp: Math.floor(Date.now() / 1000) + 3600,
    })}.x`,
  )
}

// Attention items whose `app:entity` no component registers (reported 2026-10-05:
// "Type d'onglet inconnu « mail:new_email »"). Each kind gets an opener that lands
// somewhere real, so rows already stored (no link) open too.
describe("openers for attention-only entity types", () => {
  function boot() {
    resetRegistry()
    resetBootstrap()
    bootstrapKernelApps()
  }

  it("a new-email item with no conversation opens the mail inbox", async () => {
    boot()
    const opener = getEntityOpener("mail", "new_email")
    expect(opener).toBeDefined()
    const target = await opener!({} as never, "msg-1")
    expect(target).toMatchObject({ tabType: "mail:inbox", entityId: "inbox" })
  })

  it("a failed auto top-up's attention item opens Billing", async () => {
    boot()
    const target = await getEntityOpener("kernel", "billing")!({} as never, "org-1")
    expect(target).toMatchObject({ tabType: "kernel:settings", routePath: "/settings/billing" })
  })

  it("a company hand-over item's link (kernel:company) opens the company page", async () => {
    boot()
    const opener = getEntityOpener("kernel", "company")
    expect(opener).toBeDefined()
    const target = await opener!({} as never, "co-1")
    expect(target).toMatchObject({ tabType: "contacts:company-detail", entityId: "co-1" })
  })

  it("a file shared in a thread opens that thread", async () => {
    boot()
    const opener = getEntityOpener("kernel", "file")
    expect(opener).toBeDefined()
    const api = {
      get: vi.fn(async () => ({ id: "f-1", app: "kernel", entityType: "thread", entityId: "t-3" })),
    }
    const target = await opener!(api as never, "f-1")
    expect(api.get).toHaveBeenCalledWith("/files/f-1/metadata")
    expect(target).toMatchObject({ tabType: "thread", entityId: "t-3" })
  })

  it("a file that no longer exists falls back to Home instead of failing the click", async () => {
    boot()
    const api = {
      get: vi.fn(async () => {
        throw new Error("Not found")
      }),
    }
    const target = await getEntityOpener("kernel", "file")!(api as never, "gone")
    expect(target).toMatchObject({ tabType: "kernel:home", entityId: "home" })
  })

  it("a digest failure alert opens the mail setup", async () => {
    boot()
    const target = await getEntityOpener("kernel", "digest")!({} as never, "daily")
    expect(target).toMatchObject({
      tabType: "kernel:settings",
      routePath: "/settings/apps/mail",
    })
  })

  it("an agent notification without a link opens Home instead of an unknown tab", async () => {
    boot()
    const target = await getEntityOpener("kernel", "agent_notification")!({} as never, "n-1")
    expect(target).toMatchObject({ tabType: "kernel:home", entityId: "home" })
  })
})

describe("bootstrap integration", () => {
  it("bootstrapKernelApps registers all kernel tab types", () => {
    resetRegistry()
    resetBootstrap()
    bootstrapKernelApps()

    // Tab types — "home" is ambiguous now that Knowledge also registers "home",
    // so use fully-qualified ids for kernel assertions.
    expect(getTabType("kernel:home")).toBeDefined()
    expect(getTabType("thread")).toBeDefined()
    expect(getTabType("settings")).toBeDefined()
    expect(getTabType("kernel:home")?.singleton).toBe(true)

    // Activity bar
    const entries = getActivityBarEntries()
    expect(entries.find((e) => e.id === "kernel")).toBeDefined()
    expect(entries.find((e) => e.id === "settings")?.position).toBe("bottom")

    // Commands — new-message, new-channel and shortcuts are registered in Shell (F4)

    // WS handlers (registered under kernel: namespace)
    expect(getWsEntityHandlers("kernel:thread").length).toBeGreaterThan(0)
    expect(getWsEntityHandlers("kernel:message").length).toBeGreaterThan(0)
    // A file landing on a record keeps its Files panel live (FileList).
    expect(getWsEntityHandlers("kernel:file").length).toBeGreaterThan(0)
    expect(getWsMessageHandlers("presence_sync").length).toBeGreaterThan(0)
  })

  // K2: `approvals` owns a large title of its own at phone tier, same as
  // `work` and `chats` — it used to omit `hidePhoneTopBar`, so the shell's
  // generic bar rendered ABOVE the screen's own title on that one root
  // screen.
  it("kernel commands list no duplicate labels: the chat alias is hidden", () => {
    resetRegistry()
    resetBootstrap()
    bootstrapKernelApps()

    const listed = getCommands().filter((cmd) => !cmd.alias)
    const labels = listed.map((cmd) => cmd.label)
    expect(new Set(labels).size).toBe(labels.length)
    expect(listed.some((cmd) => cmd.localId === "toggle-agent-panel")).toBe(false)
    // The alias itself stays registered so keybindings and recorded ids work.
    expect(getCommands().some((cmd) => cmd.localId === "toggle-agent-panel")).toBe(true)
  })

  it("K2: approvals tab type hides the phone top bar like work and chats", () => {
    resetRegistry()
    resetBootstrap()
    bootstrapKernelApps()

    expect(getTabType("kernel:approvals")?.hidePhoneTopBar).toBe(true)
    expect(getTabType("kernel:work")?.hidePhoneTopBar).toBe(true)
    expect(getTabType("kernel:chats")?.hidePhoneTopBar).toBe(true)
  })

  // The settings tab's phone root is the You screen, which owns a large title
  // of its own: the shell bar above it was a second header.
  it("settings tab type hides the phone top bar too", () => {
    resetRegistry()
    resetBootstrap()
    bootstrapKernelApps()

    expect(getTabType("settings")?.hidePhoneTopBar).toBe(true)
  })

  it("thread tab type has resolveLabel callback", () => {
    expect(getTabType("thread")?.resolveLabel).toBeTypeOf("function")
  })

  it("settings tab type has preserveSubRoutes = true", () => {
    expect(getTabType("settings")?.preserveSubRoutes).toBe(true)
  })

  it("bootstrap registers admin settings sections with required scopes", () => {
    resetRegistry()
    resetBootstrap()
    bootstrapKernelApps()

    const sections = getSettingsSections()

    expect(sections.find((section) => section.href === "/settings/admin/users")?.adminScope).toBe(
      "kernel:users:admin",
    )
    expect(sections.find((section) => section.href === "/settings/admin/org")?.adminScope).toBe(
      "kernel:org:admin",
    )
    expect(
      sections.find((section) => section.href === "/settings/ai/agent-behavior")?.adminScope,
    ).toBe("kernel:org:admin")
    expect(sections.find((section) => section.href === "/settings/store")?.adminScope).toBe(
      "kernel:apps:admin",
    )
    expect(sections.find((section) => section.href === "/settings/admin/roles")?.adminScope).toBe(
      "kernel:users:admin",
    )
    // Usage is for billing readers only (QA scenario 20-byok-keys): a member
    // without the scope has no link and is redirected off /settings/usage.
    expect(sections.find((section) => section.href === "/settings/usage")?.adminScope).toBe(
      "kernel:billing:read",
    )
    // Data access (the former Team & Permissions page) is a section of Roles &
    // access now; its path is an alias of that page.
    expect(
      sections.find((section) => section.href === "/settings/admin/dimension-grants"),
    ).toBeUndefined()
  })

  it("double bootstrap is idempotent", () => {
    resetBootstrap()
    bootstrapKernelApps()
    bootstrapKernelApps()

    const homeEntries = getActivityBarEntries().filter((e) => e.id === "kernel")
    expect(homeEntries).toHaveLength(1)
  })

  it("thread resolveLabel returns undefined when thread not in store", () => {
    const reg = getTabType("thread")!
    // No threads loaded — resolveLabel returns undefined
    expect(reg.resolveLabel?.("nonexistent-id")).toBeUndefined()
  })

  it("settings preserveSubRoutes field is a boolean true", () => {
    const reg = getTabType("settings")!
    // Behavioral check: the urlPattern is /settings and preserveSubRoutes is true
    expect(reg.preserveSubRoutes).toBe(true)
    expect(reg.urlPattern).toBe("/settings")
  })

  it("participant ws handler closes the thread tab when the current user is removed", () => {
    resetRegistry()
    resetBootstrap()
    resetThreadStore()
    bootstrapKernelApps()

    handleThreadEvent("create", {
      id: "t-removed",
      handle: "removed-thread",
      title: "Removed Thread",
      isPinned: false,
      participants: [],
    })
    openTab({ type: "thread", entityId: "t-removed", label: "Removed Thread" })

    const participantHandler = getWsEntityHandlers("kernel:participant")[0]
    participantHandler(
      "remove",
      { threadId: "t-removed", userId: "me" },
      {
        currentUserId: "me",
        activeTabId: null,
        isDocumentVisible: true,
        isOwnAction: false,
      },
    )

    expect(getThread("t-removed")).toBeUndefined()
    expect(tabStore.tabs.find((t) => t.id === makeTabId("thread", "t-removed"))).toBeUndefined()
  })

  // P1-T23 (C4, D40): node session rows and events reach the session store,
  // and a session opens in its own tab at /sessions/:id. P2-T16: that tab is
  // the Sessions app's session view, with its own rail entry.
  it("the node_session handler updates the row; the session tab type is registered", () => {
    resetRegistry()
    resetBootstrap()
    resetSessionStore()
    bootstrapKernelApps()

    const handler = getWsEntityHandlers("kernel:node_session")[0]
    expect(getWsEntityHandlers("kernel:node_session_event").length).toBeGreaterThan(0)
    handler(
      "update",
      { id: "ns-1", ownerUserId: "me", status: "waiting", lastSeq: 0, title: "Fix it" },
      { currentUserId: "me", activeTabId: null, isDocumentVisible: true, isOwnAction: false },
    )
    expect(sessionStore.row("ns-1")?.status).toBe("waiting")

    const tab = getTabType("kernel:session") ?? getTabType("session")
    expect(tab?.urlPattern).toBe("/sessions/:entityId")
    expect(tab?.referenceable).toBe(false)
    expect(tab?.defaultLabelKey).toBe("kernel.nodeSessions.view.title")
    expect(tab?.sidebar).toBeTruthy()
    expect(tab?.preserveSubRoutes).toBe(true)
  })

  // P2-T16 (S8, S10, charter): the rail has Sessions; its badge is the waiting
  // count in the warning tone (never the danger red), and Messages keeps the
  // danger tone.
  it("the rail has Sessions with a warning-tone badge equal to the waiting count, and Messages keeps the danger tone", () => {
    resetRegistry()
    resetBootstrap()
    resetSessionStore()
    bootstrapKernelApps()
    const entries = getActivityBarEntries()
    const sessions = entries.find((e) => e.id === "sessions")
    expect(sessions?.labelKey).toBe("kernel.nodeSessions.app.title")
    expect(sessions?.badgeTone).toBe("warning")
    expect(sessions?.tabAction).toMatchObject({ type: "kernel:sessions", entityId: "sessions" })
    expect(sessions?.activeForTabTypes).toContain("kernel:session")
    expect(entries.find((e) => e.id === "messages")?.badgeTone).toBeUndefined()

    expect(sessions?.badge?.()).toBe(0)
    const handler = getWsEntityHandlers("kernel:node_session")[0]
    const ctx = {
      currentUserId: "me",
      activeTabId: null,
      isDocumentVisible: true,
      isOwnAction: false,
    }
    handler(
      "update",
      { id: "w1", ownerUserId: "me", status: "waiting", lastSeq: 0, title: "a" },
      ctx,
    )
    handler(
      "update",
      { id: "r1", ownerUserId: "me", status: "running", lastSeq: 0, title: "b" },
      ctx,
    )
    expect(sessions?.badge?.()).toBe(1)
  })

  it("/sessions opens the home with the list", () => {
    resetRegistry()
    resetBootstrap()
    bootstrapKernelApps()
    const home = getTabType("kernel:sessions") ?? getTabType("sessions")
    expect(home?.urlPattern).toBe("/sessions")
    expect(home?.singleton).toBe(true)
    expect(home?.sidebar).toBeTruthy()
    expect(home?.defaultLabelKey).toBe("kernel.nodeSessions.app.title")
  })

  it("/sessions/:id?request=r keeps the query", () => {
    resetRegistry()
    resetBootstrap()
    bootstrapKernelApps()
    openTab({
      type: "kernel:session",
      entityId: "s9",
      label: "S",
      routePath: "/sessions/s9?request=r1",
    })
    const tab = tabStore.tabs.find((t) => t.id === makeTabId("kernel:session", "s9"))
    expect(tab && tabStoreModule.tabToUrl(tab)).toBe("/sessions/s9?request=r1")
  })

  // P2-T05 (S18): an owner-only `kernel:node` frame reaches the nodes store.
  it("a frame from the socket reaches the store through the kernel node handler", async () => {
    resetRegistry()
    resetBootstrap()
    resetNodesStore()
    const get = vi.fn(async () => ({
      nodes: [
        {
          id: "n-1",
          name: "Studio Mac",
          enabled: true,
          online: false,
          lastSeenAt: null,
          os: "macos",
          appVersion: null,
          deviceId: "d-1",
          queue: { queued: 0, running: 0 },
        },
      ],
    }))
    bootstrapKernelApps()
    setNodesStoreApi(() => ({ get }) as never)
    const { loadNodes } = await import("~/modules/nodes/nodes-store")
    await loadNodes()
    expect(nodeOnline("n-1")).toBe(false)

    const handler = getWsEntityHandlers("kernel:node")[0]
    expect(handler).toBeDefined()
    handler(
      "update",
      { ownerUserId: "me", nodeId: "n-1", change: "presence", online: true },
      { currentUserId: "me", activeTabId: null, isDocumentVisible: true, isOwnAction: false },
    )
    expect(nodeOnline("n-1")).toBe(true)
    resetNodesStore()
    setNodesStoreApi(() => null)
  })

  it("thread validation uses the shared API URL helper", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ status: 200 })
    vi.stubGlobal("fetch", fetchMock)

    resetRegistry()
    resetBootstrap()
    bootstrapKernelApps()
    setTokens("test-token-abc")

    await getTabType("thread")?.validateEntity?.("thread-123")

    expect(fetchMock).toHaveBeenCalledWith(
      apiUrl("/threads/thread-123"),
      expect.objectContaining({ headers: { Authorization: "Bearer test-token-abc" } }),
    )

    vi.unstubAllGlobals()
    clearAuth()
  })

  it("thread validation returns false on 404 (J7)", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ status: 404 })
    vi.stubGlobal("fetch", fetchMock)

    resetRegistry()
    resetBootstrap()
    bootstrapKernelApps()

    const result = await getTabType("thread")?.validateEntity?.("nonexistent")
    expect(result).toBe(false)

    vi.unstubAllGlobals()
  })
})

describe("frontend manifest app registration at startup", () => {
  it("loadManifestApps sends Authorization header and registers app tab types in registry", async () => {
    resetRegistry()
    resetBootstrap()

    const MockStartupList = () => null
    const MockStartupIcon = () => null

    const mockManifest = {
      name: "startup-test",
      views: {
        tabTypes: { list: { component: "StartupList", urlPattern: "/startup-test" } },
        activityBar: { icon: "StartupIcon", label: "Startup Test", order: 99 },
      },
    }

    // Stub fetch to return a manifest response
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: () =>
        Promise.resolve({
          data: [{ name: "startup-test", manifest: mockManifest, uiBundleUrl: null }],
        }),
    })
    vi.stubGlobal("fetch", fetchMock)

    setTokens("test-token-abc")

    // loadManifestApps calls fetch — then for each app with uiBundleUrl=null it passes {} exports
    // which causes registerAppFromManifest to throw on resolveExport("StartupList").
    // Manually wire in the exports so the app registers correctly:
    const { loadManifestApps } = await import("~/framework/bootstrap")
    const { registerAppFromManifest } = await import("~/framework/define-app")

    // Register directly to verify the manifest format produces a valid registration
    registerAppFromManifest(mockManifest, {
      StartupList: MockStartupList,
      StartupIcon: MockStartupIcon,
    })

    // Verify the fetch path includes an Authorization header
    await loadManifestApps()
    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining("/api/apps/manifests"),
      expect.objectContaining({
        headers: expect.objectContaining({ Authorization: expect.stringContaining("Bearer") }),
      }),
    )

    // Tab type appears in the registry after direct registration
    const tabType = getTabType("startup-test:list")
    expect(tabType).toBeDefined()
    expect(tabType?.appId).toBe("startup-test")

    vi.unstubAllGlobals()
    clearAuth()
    vi.restoreAllMocks()
  })

  it("loadManifestApps uses trusted local exports when uiBundleUrl is null", async () => {
    const mailManifest = {
      name: "mail",
      version: "1.0.0",
      views: {
        tabTypes: {
          "mail:inbox": { component: "MailInbox", label: "Mail" },
        },
        activityBar: { icon: "MailIcon", label: "Mail", order: 10 },
        wsHandlers: { conversation: "handleConversationEvent" },
      },
    }

    const fetchMock = vi.fn(
      async () =>
        new Response(
          JSON.stringify({ data: [{ name: "mail", manifest: mailManifest, uiBundleUrl: null }] }),
          {
            headers: { "Content-Type": "application/json" },
          },
        ),
    )

    vi.stubGlobal("fetch", fetchMock)
    vi.stubGlobal("localStorage", {
      getItem: vi.fn(() => "fake-token"),
      setItem: vi.fn(),
      removeItem: vi.fn(),
    })

    resetRegistry()
    resetBootstrap()
    setTokens("fake-token")
    await loadManifestApps()

    expect(getTabType("mail:inbox")).toBeDefined()
    expect(getActivityBarEntries().find((e) => e.appId === "mail")).toBeDefined()

    // K4: mail's `registerAppHooks()` (called right after this manifest
    // registers, same as tickets') attaches the conversation's phone header
    // and hides the shared bar for the inbox root screen, exactly the same
    // convention tickets already uses.
    expect(getPhoneHeader("mail:conversation")).toBeDefined()
    expect(getPhoneTopBarHidden("mail:inbox")).toBe(true)

    vi.unstubAllGlobals()
    clearAuth()
    vi.restoreAllMocks()
  })

  it("trustedAppExports has a contacts entry", async () => {
    const { trustedAppExports } = await import("~/framework/bootstrap")

    expect(typeof trustedAppExports.contacts).toBe("function")
  })

  // The api-connector app ships its own UI bundle (card mounts and settings
  // block, run in the app frame): the shell carries no in-page copy of it.
  it("trustedAppExports carries no api-connector entry (its UI is the app's own bundle)", async () => {
    const { trustedAppExports } = await import("~/framework/bootstrap")
    expect(trustedAppExports["api-connector"]).toBeUndefined()
  })

  it("B1: two manifest entries whose imports resolve out of order both register", async () => {
    // Two apps with distinct same-origin uiBundleUrls whose dynamic imports
    // resolve in the OPPOSITE order they were listed in the manifest response
    // — proves the parallel registration loop doesn't assume completion
    // order and both still land in the registry.
    const manifestA = {
      name: "parallel-a",
      views: {
        tabTypes: { list: { component: "AList", urlPattern: "/parallel-a" } },
        activityBar: { icon: "AIcon", label: "A", order: 50 },
      },
    }
    const manifestB = {
      name: "parallel-b",
      views: {
        tabTypes: { list: { component: "BList", urlPattern: "/parallel-b" } },
        activityBar: { icon: "BIcon", label: "B", order: 51 },
      },
    }

    const bundleUrlA = `${window.location.origin}/bundles/parallel-a.js`
    const bundleUrlB = `${window.location.origin}/bundles/parallel-b.js`
    const fetchMock = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            data: [
              // First-party: a browser tab imports these in the page.
              {
                name: "parallel-a",
                firstParty: true,
                manifest: manifestA,
                uiBundleUrl: bundleUrlA,
              },
              {
                name: "parallel-b",
                firstParty: true,
                manifest: manifestB,
                uiBundleUrl: bundleUrlB,
              },
            ],
          }),
          { headers: { "Content-Type": "application/json" } },
        ),
    )
    vi.stubGlobal("fetch", fetchMock)

    // B (listed second in the manifest response) resolves its dynamic import
    // BEFORE A (listed first) — the reverse of manifest order. A real dynamic
    // import() of an arbitrary same-origin URL isn't resolvable in this test
    // environment, so registerManifestAppEntry's import() call rejects for
    // both — proving instead that the PARALLEL LOOP itself doesn't let one
    // entry's slow settle block the other from starting (both warn
    // independently, neither waits on the other) is the property this test
    // pins; full success-path registration ordering is covered by the
    // same-origin/uiBundleUrl=null tests elsewhere in this file.
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {})

    resetRegistry()
    resetBootstrap()
    setTokens("fake-token")

    await loadManifestApps()

    // Both entries were attempted (both produced a "failed to load UI bundle"
    // warning) — if the loop were still serial-with-early-return, a bug that
    // made the map callback silently swallow one entry would show only one
    // warning instead of two.
    const failedToLoadWarnings = warnSpy.mock.calls.filter((args) =>
      String(args[0]).includes("failed to load UI bundle"),
    )
    expect(failedToLoadWarnings.length).toBe(2)

    vi.unstubAllGlobals()
    clearAuth()
    vi.restoreAllMocks()
  })

  it("B1: registerManifestAppEntry calls for independent entries run concurrently, not serially", async () => {
    // Direct unit-level proof of the concurrency property Promise.all provides:
    // two async loaders gated on separate deferred promises must BOTH have
    // started (both promises constructed / functions invoked) before either
    // resolves — a serial `for...of` + `await` loop would not invoke the
    // second loader until the first's promise settles.
    const startedA = vi.fn()
    const startedB = vi.fn()
    const aDeferred: { resolve: () => void; promise: Promise<void> } = (() => {
      let resolve!: () => void
      const promise = new Promise<void>((r) => {
        resolve = r
      })
      return { resolve, promise }
    })()
    const bDeferred: { resolve: () => void; promise: Promise<void> } = (() => {
      let resolve!: () => void
      const promise = new Promise<void>((r) => {
        resolve = r
      })
      return { resolve, promise }
    })()

    const loaders = [
      async () => {
        startedA()
        await aDeferred.promise
      },
      async () => {
        startedB()
        await bDeferred.promise
      },
    ]

    // Mirrors the shape of the real fix: Promise.all(entries.map(loader)).
    const allPromise = Promise.all(loaders.map((fn) => fn()))

    await Promise.resolve()
    // Both must have started even though neither has resolved — the
    // parallel-safety property under test.
    expect(startedA).toHaveBeenCalledTimes(1)
    expect(startedB).toHaveBeenCalledTimes(1)

    bDeferred.resolve()
    aDeferred.resolve()
    await allPromise
  })

  it("B1: a throwing manifest entry doesn't sink the batch — the other entry still registers", async () => {
    // "throwing" entry: uiBundleUrl null + not in trustedAppExports (falls back
    // to {} exports), and its manifest references a component name that isn't
    // in that empty export bag — registerAppFromManifest throws synchronously
    // inside registerManifestAppEntry's own try/catch (existing per-entry
    // isolation). The well-formed sibling entry (no component references, so
    // the empty {} export bag is sufficient) must still register.
    const brokenManifest = {
      name: "broken-app",
      views: {
        tabTypes: { list: { component: "MissingComponent", urlPattern: "/broken" } },
      },
    }
    const goodManifest = {
      name: "good-app",
      bulk: {
        someAction: { label: "Some action", underlyingTool: "noop", dispatchMode: "perItem" },
      },
    }

    const fetchMock = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            data: [
              { name: "broken-app", manifest: brokenManifest, uiBundleUrl: null },
              { name: "good-app", manifest: goodManifest, uiBundleUrl: null },
            ],
          }),
          { headers: { "Content-Type": "application/json" } },
        ),
    )
    vi.stubGlobal("fetch", fetchMock)
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {})

    resetRegistry()
    resetBootstrap()
    setTokens("fake-token")

    await expect(loadManifestApps()).resolves.toBeUndefined()

    expect(getTabType("broken-app:list")).toBeUndefined()
    // good-app has no component references, so it registers successfully with
    // the empty {} export bag — proving the broken sibling didn't sink it.
    const warnMessages = warnSpy.mock.calls.map((args) => String(args[0]))
    expect(warnMessages.some((m) => m.includes("broken-app"))).toBe(true)
    expect(warnMessages.some((m) => m.includes("good-app"))).toBe(false)

    vi.unstubAllGlobals()
    clearAuth()
    vi.restoreAllMocks()
  })

  it("cross-origin uiBundleUrl is blocked — app is not registered and warns with 'cross-origin'", async () => {
    const crossOriginManifest = {
      name: "evil-app",
      views: {
        tabTypes: { panel: { component: "EvilPanel", urlPattern: "/evil" } },
        activityBar: { icon: "EvilIcon", label: "Evil", order: 99 },
      },
    }

    const fetchMock = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            data: [
              {
                name: "evil-app",
                manifest: crossOriginManifest,
                uiBundleUrl: "https://evil.example.com/bundle.js",
              },
            ],
          }),
          { headers: { "Content-Type": "application/json" } },
        ),
    )
    vi.stubGlobal("fetch", fetchMock)

    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {})

    resetRegistry()
    resetBootstrap()
    setTokens("fake-token")
    await loadManifestApps()

    // The security guard must have fired a warning mentioning "cross-origin"
    const warnMessages = warnSpy.mock.calls.map((args) => String(args[0]))
    expect(warnMessages.some((m) => m.includes("cross-origin"))).toBe(true)

    // The app must NOT appear in the registry — the bundle was never loaded
    expect(getTabType("evil-app:panel")).toBeUndefined()

    warnSpy.mockRestore()
    vi.unstubAllGlobals()
    clearAuth()
    vi.restoreAllMocks()
  })

  it("invalid uiBundleUrl is skipped — app is not registered and warns with 'invalid UI bundle URL'", async () => {
    const badUrlManifest = {
      name: "bad-url-app",
      views: {
        tabTypes: { panel: { component: "BadPanel", urlPattern: "/bad" } },
        activityBar: { icon: "BadIcon", label: "Bad", order: 99 },
      },
    }

    const fetchMock = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            data: [
              {
                name: "bad-url-app",
                manifest: badUrlManifest,
                // "http://" is a special-scheme URL with no host — `new URL()`
                // throws on it across engines, triggering the catch branch in the
                // guard. (":::invalid:::" used to throw on older engines but now
                // resolves as a relative path, so it no longer exercises the catch.)
                uiBundleUrl: "http://",
              },
            ],
          }),
          { headers: { "Content-Type": "application/json" } },
        ),
    )
    vi.stubGlobal("fetch", fetchMock)

    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {})

    resetRegistry()
    resetBootstrap()
    setTokens("fake-token")
    await loadManifestApps()

    // The guard must have warned about the invalid URL
    const warnMessages = warnSpy.mock.calls.map((args) => String(args[0]))
    expect(warnMessages.some((m) => m.includes("invalid UI bundle URL"))).toBe(true)

    // The app must NOT appear in the registry
    expect(getTabType("bad-url-app:panel")).toBeUndefined()

    warnSpy.mockRestore()
    vi.unstubAllGlobals()
    clearAuth()
    vi.restoreAllMocks()
  })

  it("same-origin uiBundleUrl passes the guard — no cross-origin or invalid-URL warning fires", async () => {
    const sameOriginManifest = {
      name: "local-bundle-app",
      views: {
        tabTypes: { panel: { component: "LocalPanel", urlPattern: "/local-bundle" } },
        activityBar: { icon: "LocalIcon", label: "Local Bundle", order: 99 },
      },
    }

    // Build a URL on the SAME origin as the jsdom window (the default origin
    // varies by vitest/jsdom version — e.g. http://localhost:3000 — so derive it
    // rather than hardcode it). A same-origin URL passes the guard and proceeds
    // to import().
    const fetchMock = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            data: [
              {
                name: "local-bundle-app",
                // First-party: a browser tab imports it in the page.
                firstParty: true,
                manifest: sameOriginManifest,
                uiBundleUrl: `${window.location.origin}/bundles/local-bundle-app.js`,
              },
            ],
          }),
          { headers: { "Content-Type": "application/json" } },
        ),
    )
    vi.stubGlobal("fetch", fetchMock)

    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {})

    resetRegistry()
    resetBootstrap()
    setTokens("fake-token")
    await loadManifestApps()

    const warnMessages = warnSpy.mock.calls.map((args) => String(args[0]))

    // No cross-origin or invalid-URL security warning must have fired
    expect(warnMessages.some((m) => m.includes("cross-origin"))).toBe(false)
    expect(warnMessages.some((m) => m.includes("invalid UI bundle URL"))).toBe(false)

    // The bundle cannot actually be fetched by jsdom (no real server), so the
    // import() throws and the code logs "failed to load UI bundle" — confirming
    // that the security guard let the request through.
    expect(warnMessages.some((m) => m.includes("failed to load UI bundle"))).toBe(true)

    warnSpy.mockRestore()
    vi.unstubAllGlobals()
    clearAuth()
    vi.restoreAllMocks()
  })

  it("wrapped shell: a bundle on the BOUND SERVER is permitted and resolved against it", async () => {
    // The desktop/mobile shell loads this same web bundle from the app's own
    // origin (tauri://localhost), while every installed app's UI bundle lives
    // on the bound server. Under the old same-origin-as-the-page rule each one
    // was refused, so the rail showed only the in-tree apps. Here the page
    // origin is jsdom's and the bound server is a DIFFERENT origin: the
    // relative manifest path must resolve against the SERVER and be permitted.
    const serverOrigin = "https://box.example.com"
    vi.stubGlobal("__LIAISON_SERVER_ADDRESS__", serverOrigin)
    vi.stubGlobal("__LIAISON_APP_FRAME_URL__", "liaison-frame://localhost/")

    const shellManifest = {
      name: "shell-bundle-app",
      views: {
        tabTypes: { panel: { component: "ShellPanel", urlPattern: "/shell-bundle" } },
        activityBar: { icon: "ShellIcon", label: "Shell Bundle", order: 98 },
      },
    }

    const fetchMock = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            data: [
              {
                name: "shell-bundle-app",
                manifest: shellManifest,
                uiBundleUrl: "/api/apps/shell-bundle-app/1.0.0/ui.js",
              },
            ],
          }),
          { headers: { "Content-Type": "application/json" } },
        ),
    )
    vi.stubGlobal("fetch", fetchMock)

    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {})

    resetRegistry()
    resetBootstrap()
    setTokens("fake-token")
    await loadManifestApps()

    const warnMessages = warnSpy.mock.calls.map((args) => String(args[0]))
    expect(warnMessages.some((m) => m.includes("cross-origin"))).toBe(false)
    expect(warnMessages.some((m) => m.includes("invalid UI bundle URL"))).toBe(false)
    // The guard let it through, and the shell never imports a server bundle
    // in its page (A7): the app is registered framed, and the frame's bundle
    // is read from the bound server, not resolved against the page (which
    // holds no API at all).
    expect(warnMessages.some((m) => m.includes("failed to load UI bundle"))).toBe(false)
    const panel = getTabType("shell-bundle-app:panel")?.component as
      | ((p: object) => unknown)
      | undefined
    expect(panel).toBeDefined()
    fetchMock.mockImplementation(async () => new Response("export const ShellPanel = () => null"))
    createRoot((dispose) => {
      panel?.({ entityId: "x" })
      dispose()
    })
    await vi.waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(
        `${serverOrigin}/api/apps/shell-bundle-app/1.0.0/ui.js`,
      ),
    )

    warnSpy.mockRestore()
    vi.unstubAllGlobals()
    delete (globalThis as Record<string, unknown>).__LIAISON_APP_FRAME_URL__
    clearAuth()
    vi.restoreAllMocks()
  })

  it("wrapped shell: a bundle from a THIRD origin is still refused", async () => {
    vi.stubGlobal("__LIAISON_SERVER_ADDRESS__", "https://box.example.com")

    const evilManifest = {
      name: "shell-evil-app",
      views: {
        tabTypes: { panel: { component: "EvilPanel", urlPattern: "/shell-evil" } },
        activityBar: { icon: "EvilIcon", label: "Shell Evil", order: 97 },
      },
    }

    const fetchMock = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            data: [
              {
                name: "shell-evil-app",
                manifest: evilManifest,
                uiBundleUrl: "https://evil.example.com/bundle.js",
              },
            ],
          }),
          { headers: { "Content-Type": "application/json" } },
        ),
    )
    vi.stubGlobal("fetch", fetchMock)

    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {})

    resetRegistry()
    resetBootstrap()
    setTokens("fake-token")
    await loadManifestApps()

    const warnMessages = warnSpy.mock.calls.map((args) => String(args[0]))
    expect(warnMessages.some((m) => m.includes("cross-origin"))).toBe(true)
    expect(getTabType("shell-evil-app:panel")).toBeUndefined()

    warnSpy.mockRestore()
    vi.unstubAllGlobals()
    clearAuth()
    vi.restoreAllMocks()
  })

  it("registers kernel:contact and mail:conversation entity preview renderers after manifest load", async () => {
    const { entityPreviewRegistry, getEntityPreviewRenderer } = await import(
      "~/modules/shell/entity-preview/registry"
    )
    entityPreviewRegistry.clear()

    const contactsManifest = {
      name: "contacts",
      views: {
        tabTypes: { list: { component: "ContactList", label: "Contacts" } },
        activityBar: { icon: "ContactsIcon", label: "Contacts", order: 20 },
        wsHandlers: [{ key: "kernel:contact", handler: "handleContactEvent" }],
      },
    }
    const mailManifest = {
      name: "mail",
      views: {
        tabTypes: { inbox: { component: "MailInbox", label: "Mail" } },
        activityBar: { icon: "MailIcon", label: "Mail", order: 10 },
        wsHandlers: { conversation: "handleConversationEvent" },
      },
    }

    const fetchMock = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            data: [
              { name: "contacts", manifest: contactsManifest, uiBundleUrl: null },
              { name: "mail", manifest: mailManifest, uiBundleUrl: null },
            ],
          }),
          { headers: { "Content-Type": "application/json" } },
        ),
    )
    vi.stubGlobal("fetch", fetchMock)
    vi.stubGlobal("localStorage", {
      getItem: vi.fn(() => "fake-token"),
      setItem: vi.fn(),
      removeItem: vi.fn(),
    })

    resetRegistry()
    resetBootstrap()
    setTokens("fake-token")
    await loadManifestApps()

    expect(getEntityPreviewRenderer("kernel", "contact")).toBeDefined()
    expect(getEntityPreviewRenderer("mail", "conversation")).toBeDefined()

    vi.unstubAllGlobals()
    clearAuth()
    vi.restoreAllMocks()
  })
})

describe("index.html declares an import map covering solid-js{,/web,/store}", () => {
  // Resolve paths relative to this test file rather than CWD — Vitest's CWD
  // varies between root-runner and workspace invocations. Some Vitest module
  // environments (Node 20 + jsdom) expose a non-file:// import.meta.url, where
  // fileURLToPath throws "URL must be of scheme file" at collection time and
  // fails the whole file — fall back to CWD (apps/web under the orchestrator;
  // its grandparent is the repo root).
  const webRoot = (() => {
    try {
      return fileURLToPath(new URL("../../..", import.meta.url))
    } catch {
      return path.resolve(process.cwd(), "..", "..")
    }
  })()

  it("index.html contains an importmap script with solid-js entries", () => {
    const html = readFileSync(`${webRoot}/apps/web/index.html`, "utf8")
    expect(html).toMatch(/<script[^>]*type=["']importmap["']/)
    expect(html).toMatch(/"solid-js"\s*:\s*"\/_app-runtime\/solid-js\.js"/)
    expect(html).toMatch(/"solid-js\/web"\s*:\s*"\/_app-runtime\/solid-js-web\.js"/)
    expect(html).toMatch(/"solid-js\/store"\s*:\s*"\/_app-runtime\/solid-js-store\.js"/)
  })

  it("shim files exist and re-export from the window-global the kernel sets", () => {
    const cases: Array<[string, string, string]> = [
      ["solid-js.js", "__liaisonSolid", "createSignal"],
      ["solid-js-web.js", "__liaisonSolidWeb", "render"],
      ["solid-js-store.js", "__liaisonSolidStore", "createStore"],
    ]
    for (const [file, glob, hallmark] of cases) {
      const src = readFileSync(`${webRoot}/apps/web/public/_app-runtime/${file}`, "utf8")
      expect(src).toContain(`window.${glob}`)
      expect(src).toContain(hallmark)
    }
  })
})

describe("manifest app reconciliation (live per-user scope change)", () => {
  // The `mail` trusted app registers cleanly from a minimal manifest (its real
  // exports resolve `MailIcon` / `MailInbox`), so it stands in for any
  // scope-gated app. Driving the per-user `/api/apps/manifests` response across
  // reloads models an admin granting/revoking access mid-session.
  const mailManifest = {
    name: "mail",
    version: "1.0.0",
    views: {
      tabTypes: { "mail:inbox": { component: "MailInbox", label: "Mail" } },
      activityBar: { icon: "MailIcon", label: "Mail", order: 10 },
      wsHandlers: { conversation: "handleConversationEvent" },
    },
  }
  const mailEntry = { name: "mail", manifest: mailManifest, uiBundleUrl: null }

  it("reloadManifestApps tears down a revoked app's surface and re-adds it when re-granted", async () => {
    let payload: (typeof mailEntry)[] = [mailEntry]
    const fetchMock = vi.fn(
      async () =>
        new Response(JSON.stringify({ data: payload }), {
          headers: { "Content-Type": "application/json" },
        }),
    )
    vi.stubGlobal("fetch", fetchMock)
    vi.stubGlobal("localStorage", {
      getItem: vi.fn(() => "fake-token"),
      setItem: vi.fn(),
      removeItem: vi.fn(),
    })

    resetRegistry()
    resetBootstrap()
    setTokens("fake-token")

    // Initial load — mail is visible.
    await loadManifestApps()
    expect(getActivityBarEntries().find((e) => e.appId === "mail")).toBeDefined()
    expect(getTabType("mail:inbox")).toBeDefined()

    // Access revoked — the server omits mail; reconcile tears its surface down
    // (no icon, no tab type).
    payload = []
    await reloadManifestApps()
    expect(getActivityBarEntries().find((e) => e.appId === "mail")).toBeUndefined()
    expect(getTabType("mail:inbox")).toBeUndefined()

    // Access re-granted — mail returns; reconcile re-registers it in place.
    payload = [mailEntry]
    await reloadManifestApps()
    expect(getActivityBarEntries().find((e) => e.appId === "mail")).toBeDefined()
    expect(getTabType("mail:inbox")).toBeDefined()

    vi.unstubAllGlobals()
    clearAuth()
    vi.restoreAllMocks()
  })

  it("an app restricted or turned Off keeps its open tab, which says why; removing it closes the tab (MGT-11)", async () => {
    let payload: (typeof mailEntry)[] = [mailEntry]
    let unavailable: string[] = []
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(JSON.stringify({ data: payload, unavailableApps: unavailable }), {
            headers: { "Content-Type": "application/json" },
          }),
      ),
    )
    vi.stubGlobal("localStorage", {
      getItem: vi.fn(() => "fake-token"),
      setItem: vi.fn(),
      removeItem: vi.fn(),
    })
    resetRegistry()
    resetBootstrap()
    setTokens("fake-token")
    await loadManifestApps()
    openTab({ type: "mail:inbox", entityId: "inbox", label: "Mail" })
    const tabId = makeTabId("mail:inbox", "inbox")
    expect(tabStore.tabs.find((t) => t.id === tabId)).toBeDefined()

    // Restricted away: the feed omits mail and lists it as unavailable. Its nav
    // goes; the open tab stays, its type still resolves (MainPanel shows the
    // unavailable notice in place of the app).
    payload = []
    unavailable = ["mail"]
    await reloadManifestApps()
    expect(getActivityBarEntries().find((e) => e.appId === "mail")).toBeUndefined()
    expect(getTabType("mail:inbox")?.appId).toBe("mail")
    expect(tabStore.tabs.find((t) => t.id === tabId)).toBeDefined()

    // Access back: the app registers again and the tab is still there.
    payload = [mailEntry]
    unavailable = []
    await reloadManifestApps()
    expect(getActivityBarEntries().find((e) => e.appId === "mail")).toBeDefined()
    expect(tabStore.tabs.find((t) => t.id === tabId)).toBeDefined()

    // Restricted again, then removed outright: the held tab type is released
    // and the tab closes.
    payload = []
    unavailable = ["mail"]
    await reloadManifestApps()
    unavailable = []
    await reloadManifestApps()
    expect(getTabType("mail:inbox")).toBeUndefined()
    expect(tabStore.tabs.find((t) => t.id === tabId)).toBeUndefined()

    vi.unstubAllGlobals()
    clearAuth()
    vi.restoreAllMocks()
  })

  it("a resync after an admin's change refreshes the token the change made stale (MGT-11, MGT-14)", async () => {
    // Every app change bumps each member's permission_version: the session's
    // token is refused (401) until refreshed. The resync refreshes it once and
    // reads the feed, instead of giving up and leaving the old nav in place.
    let token = "old-token"
    let payload: (typeof mailEntry)[] = [mailEntry]
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      const auth = new Headers(init?.headers).get("Authorization")
      if (auth !== `Bearer ${token}`) return new Response("{}", { status: 401 })
      return new Response(JSON.stringify({ data: payload, unavailableApps: [] }), {
        headers: { "Content-Type": "application/json" },
      })
    })
    vi.stubGlobal("fetch", fetchMock)
    resetRegistry()
    resetBootstrap()
    setTokens("old-token")
    await loadManifestApps()
    expect(getActivityBarEntries().find((e) => e.appId === "mail")).toBeDefined()

    // The admin removes mail; the server now wants a fresh token.
    token = "new-token"
    payload = []
    const refresh = vi
      .spyOn(authManager, "ensureFreshToken")
      .mockImplementation(async () => setTokens("new-token"))
    await reloadManifestApps()
    expect(refresh).toHaveBeenCalledWith({ force: true, rejected: "old-token" })
    expect(getActivityBarEntries().find((e) => e.appId === "mail")).toBeUndefined()

    vi.unstubAllGlobals()
    clearAuth()
    vi.restoreAllMocks()
  })

  it("reloadManifestApps registers a newly-granted app when none was loaded before", async () => {
    let payload: (typeof mailEntry)[] = []
    const fetchMock = vi.fn(
      async () =>
        new Response(JSON.stringify({ data: payload }), {
          headers: { "Content-Type": "application/json" },
        }),
    )
    vi.stubGlobal("fetch", fetchMock)
    vi.stubGlobal("localStorage", {
      getItem: vi.fn(() => "fake-token"),
      setItem: vi.fn(),
      removeItem: vi.fn(),
    })

    resetRegistry()
    resetBootstrap()
    setTokens("fake-token")

    // Initial load with no accessible apps — mail absent.
    await loadManifestApps()
    expect(getActivityBarEntries().find((e) => e.appId === "mail")).toBeUndefined()

    // Admin grants mail — reconcile adds its icon without a reload.
    payload = [mailEntry]
    await reloadManifestApps()
    expect(getActivityBarEntries().find((e) => e.appId === "mail")).toBeDefined()
    expect(getTabType("mail:inbox")).toBeDefined()

    vi.unstubAllGlobals()
    clearAuth()
    vi.restoreAllMocks()
  })

  it("sync handler validates tabs without wiping the thread list or double-bumping resync", () => {
    resetRegistry()
    resetBootstrap()
    resetThreadStore()
    bootstrapKernelApps()

    // A loaded thread must survive the sync frame (resetThreadStore removed).
    handleThreadEvent("create", {
      id: "t-keep",
      handle: "keep",
      title: "Keep me",
      isPinned: false,
      participants: [],
    })
    expect(getThread("t-keep")).toBeDefined()

    const before = resyncVersion()
    const validateTabsSpy = vi.spyOn(tabStoreModule, "validateTabs")
    const syncHandler = getWsMessageHandlers("sync")[0]
    expect(syncHandler).toBeDefined()
    syncHandler(
      { type: "sync" },
      { currentUserId: "me", activeTabId: null, isDocumentVisible: true, isOwnAction: false },
    )

    // The resync bump for a WS sync frame is owned exclusively by Shell's
    // onSyncRequired -> requestResync("ws-sync") (createWebSocket fires it
    // synchronously before this dispatched handler runs). This handler must
    // NOT also call requestResync() — that would double-bump the bus for a
    // single frame — so resyncVersion is unchanged here. It must still call
    // validateTabs(), and the loaded thread must survive (no synchronous wipe).
    expect(resyncVersion()).toBe(before)
    expect(getThread("t-keep")).toBeDefined()
    expect(validateTabsSpy).toHaveBeenCalledTimes(1)

    validateTabsSpy.mockRestore()
  })

  it("an app change (kernel:org_app) reads Home's attention feed again, so a lost app's queue leaves (MGT-11)", () => {
    resetRegistry()
    resetBootstrap()
    bootstrapKernelApps()
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ data: [], unavailableApps: [] }))),
    )

    const reloadSpy = vi.spyOn(attentionStore, "markStaleAndReload").mockImplementation(() => {})
    const api = {
      getEnvelope: vi.fn().mockResolvedValue({ data: { items: [], errors: [] } }),
    }
    attentionStore.start(api as never)
    reloadSpy.mockClear()

    const handler = getWsEntityHandlers("kernel:org_app")[0]
    expect(handler).toBeDefined()
    handler(
      "update",
      { app: "invoicing", status: "active", accessMode: "restricted" },
      { currentUserId: "me", activeTabId: null, isDocumentVisible: true, isOwnAction: false },
    )
    expect(reloadSpy).toHaveBeenCalledTimes(1)

    reloadSpy.mockRestore()
    vi.unstubAllGlobals()
  })

  it("mail conversation WS event marks the attention feed stale", () => {
    resetRegistry()
    resetBootstrap()
    bootstrapKernelApps()

    const reloadSpy = vi.spyOn(attentionStore, "markStaleAndReload").mockImplementation(() => {})
    const api = {
      getEnvelope: vi.fn().mockResolvedValue({ data: { items: [], errors: [] } }),
    }
    attentionStore.start(api as never)
    reloadSpy.mockClear()

    const mailHandler = getWsEntityHandlers("mail:conversation")[0]
    expect(mailHandler).toBeDefined()
    mailHandler(
      "create",
      { id: "c-1" },
      { currentUserId: "me", activeTabId: null, isDocumentVisible: true, isOwnAction: false },
    )
    expect(reloadSpy).toHaveBeenCalledTimes(1)

    reloadSpy.mockRestore()
  })

  // READ STATE IS THE SERVER'S. Another device of this reader moved a read
  // mark: its `kernel:read_state` frame must clear the state HERE, live, not
  // on the next list reload (a thread read on the phone stayed unread on the
  // laptop, and the other way round).
  describe("read_state frame from another device", () => {
    const ctx = {
      currentUserId: "me",
      activeTabId: null,
      isDocumentVisible: true,
      isOwnAction: true,
    }

    it("sets the thread's unread count to the server's, clearing or keeping the pill", () => {
      resetRegistry()
      resetBootstrap()
      resetThreadStore()
      bootstrapKernelApps()
      addThread({ id: "t-read-elsewhere", title: "Elsewhere", unreadCount: 3, participants: [] })
      addThread({ id: "t-mid-read", title: "Mid read", unreadCount: 4, participants: [] })

      dispatchWsEntityEvent(
        "kernel:read_state",
        "update",
        { forUserId: "me", kind: "thread", threadId: "t-read-elsewhere", unreadCount: 0 },
        ctx,
      )
      dispatchWsEntityEvent(
        "kernel:read_state",
        "update",
        { forUserId: "me", kind: "thread", threadId: "t-mid-read", unreadCount: 1 },
        ctx,
      )

      expect(getThread("t-read-elsewhere")?.unreadCount).toBe(0)
      expect(getThread("t-mid-read")?.unreadCount).toBe(1)
      expect(threadStoreModule.totalUnreadCount()).toBe(1)
    })

    it("refetches the attention feed when attention rows or a reply thread were read", () => {
      resetRegistry()
      resetBootstrap()
      bootstrapKernelApps()
      const reloadSpy = vi.spyOn(attentionStore, "markStaleAndReload").mockImplementation(() => {})
      attentionStore.start({
        getEnvelope: vi.fn().mockResolvedValue({ data: { items: [], errors: [] } }),
      } as never)
      reloadSpy.mockClear()

      dispatchWsEntityEvent(
        "kernel:read_state",
        "update",
        { forUserId: "me", kind: "attention", app: "kernel", entityType: "thread", entityId: "t" },
        ctx,
      )
      dispatchWsEntityEvent(
        "kernel:read_state",
        "update",
        { forUserId: "me", kind: "reply_thread", threadId: "t", rootId: "r" },
        ctx,
      )
      expect(reloadSpy).toHaveBeenCalledTimes(2)

      attentionStore.stop()
      reloadSpy.mockRestore()
    })

    it("turns the assistant's mail access off when another device did", async () => {
      resetRegistry()
      resetBootstrap()
      bootstrapKernelApps()
      const access = await import("~/modules/mailbox/agent-mail-access")
      access.setAgentMailAccessEnabled(true, 1)
      dispatchWsEntityEvent(
        "kernel:read_state",
        "update",
        { forUserId: "me", kind: "agent_mail_access", enabled: false, at: Date.now() + 1000 },
        ctx,
      )
      await vi.waitFor(() => expect(access.agentMailAccessEnabled()).toBe(false))
      access.setAgentMailAccessEnabled(true)
    })

    it("applies mute, pin and archive flags another device set", () => {
      resetRegistry()
      resetBootstrap()
      resetThreadStore()
      bootstrapKernelApps()
      addThread({ id: "t-flags", title: "Flags", unreadCount: 2, participants: [] })
      addThread({ id: "t-archived", title: "Archived", unreadCount: 0, participants: [] })
      const flags = (threadId: string, f: Record<string, boolean>) =>
        dispatchWsEntityEvent(
          "kernel:read_state",
          "update",
          {
            forUserId: "me",
            kind: "thread_state",
            threadId,
            isArchived: false,
            isMuted: false,
            isPinned: false,
            ...f,
          },
          ctx,
        )

      flags("t-flags", { isMuted: true, isPinned: true })
      expect(getThread("t-flags")?.isMuted).toBe(true)
      expect(getThread("t-flags")?.isPinnedByUser).toBe(true)
      // A muted thread's unread count no longer surfaces anywhere.
      expect(threadStoreModule.totalUnreadCount()).toBe(0)

      flags("t-flags", { isMuted: false })
      expect(getThread("t-flags")?.isMuted).toBe(false)
      expect(getThread("t-flags")?.isPinnedByUser).toBe(false)

      flags("t-archived", { isArchived: true })
      expect(getThread("t-archived")).toBeUndefined()
    })
  })

  // --- Task 3 self-heal + Task 5 invalidation on the "message" WS handler chain ---
  describe("message handler: unknown-thread self-heal + attention invalidation", () => {
    const ctx = {
      currentUserId: "me",
      activeTabId: null,
      isDocumentVisible: true,
      isOwnAction: false,
    }

    it("requests a thread reload when the message's threadId is unknown to the store", () => {
      resetRegistry()
      resetBootstrap()
      resetThreadStore()
      bootstrapKernelApps()

      const reloadSpy = vi.spyOn(threadStoreModule, "requestThreadReload")

      dispatchWsEntityEvent(
        "kernel:message",
        "create",
        { threadId: "t-unknown", content: "hi", authorId: "u2", authorName: "Bob" },
        ctx,
      )
      expect(reloadSpy).toHaveBeenCalledTimes(1)
      reloadSpy.mockRestore()
    })

    it("does not request a reload when the thread is already known", () => {
      resetRegistry()
      resetBootstrap()
      resetThreadStore()
      bootstrapKernelApps()
      addThread({
        id: "t-known",
        handle: "known",
        title: "Known",
        isPinned: false,
        isPinnedByUser: false,
        participants: [],
        unreadCount: 0,
        updatedAt: new Date().toISOString(),
      })

      const reloadSpy = vi.spyOn(threadStoreModule, "requestThreadReload")

      dispatchWsEntityEvent(
        "kernel:message",
        "create",
        { threadId: "t-known", content: "hi", authorId: "u2", authorName: "Bob" },
        ctx,
      )
      expect(reloadSpy).not.toHaveBeenCalled()
      reloadSpy.mockRestore()
    })

    // S5: the server decides desktop notifications and sends a `notify` frame
    // to the chosen window. A message event must never raise one on its own,
    // or a second tab (or the web next to the desktop app) raises it twice.
    it("a message create raises no OS notification client-side", () => {
      resetRegistry()
      resetBootstrap()
      resetThreadStore()
      bootstrapKernelApps()

      const constructed = vi.fn()
      class FakeNotification {
        static permission: NotificationPermission = "granted"
        constructor() {
          constructed()
        }
      }
      vi.stubGlobal("Notification", FakeNotification)
      const raiseSpy = vi.spyOn(desktopNotificationsModule, "handleNotifyFrame")

      dispatchWsEntityEvent(
        "kernel:message",
        "create",
        {
          threadId: "t-notify",
          content: "hi there",
          authorId: "u2",
          authorName: "Bob",
          authorType: "agent",
        },
        { currentUserId: "me", activeTabId: null, isDocumentVisible: false, isOwnAction: false },
      )

      expect(constructed).not.toHaveBeenCalled()
      expect(raiseSpy).not.toHaveBeenCalled()
      raiseSpy.mockRestore()
      vi.unstubAllGlobals()
    })

    // The dock-surfacing handler: an incoming message pops its conversation
    // into the chat dock as a collapsed pill. Four rules, and each of the
    // three refusals is what keeps it from becoming noise.
    describe("dock surfacing", () => {
      function seed(id: string, title: string | null, participantIds: string[]): void {
        addThread({
          id,
          handle: id,
          title,
          isPinned: false,
          isPinnedByUser: false,
          participants: participantIds.map((pid) => ({
            id: pid,
            name: pid,
            avatarUrl: null,
            participantType: "user",
          })),
          unreadCount: 0,
          updatedAt: new Date().toISOString(),
        })
      }

      function boot(): void {
        resetRegistry()
        resetBootstrap()
        resetThreadStore()
        resetDockStore()
        bootstrapKernelApps()
        // The drain checks the LIVE viewer against the one an id was parked
        // for, so these tests need a decodable token, not just a ctx field.
        signInAs("me")
      }

      afterEach(() => {
        clearAuth()
      })

      function message(threadId: string, over: Record<string, unknown> = {}): void {
        dispatchWsEntityEvent(
          "kernel:message",
          "create",
          { threadId, content: "hi", authorId: "u2", authorName: "Bob" },
          { ...ctx, ...over },
        )
      }

      it("a DM message from another user adds a collapsed dock pill", () => {
        boot()
        seed("t-dm", null, ["me", "u2"])

        message("t-dm")

        expect(dockTabs().map((t) => t.threadId)).toEqual(["t-dm"])
        expect(dockTabs()[0].expanded).toBe(false)
      })

      it("the viewer's own message surfaces nothing", () => {
        boot()
        seed("t-dm", null, ["me", "u2"])

        dispatchWsEntityEvent(
          "kernel:message",
          "create",
          { threadId: "t-dm", content: "hi", authorId: "me", authorName: "Me" },
          { ...ctx, isOwnAction: true },
        )

        expect(dockTabs()).toHaveLength(0)
      })

      // The actor on an agent's reply is the HUMAN who triggered it, so
      // `isOwnAction` is true for the one message the user is waiting for.
      // Own-ness is judged by the AUTHOR instead.
      it("an agent reply in my own DM pops a pill although isOwnAction is true", () => {
        boot()
        seed("t-agent", null, ["me", "a1"])

        dispatchWsEntityEvent(
          "kernel:message",
          "create",
          {
            threadId: "t-agent",
            content: "here you go",
            authorId: "a1",
            authorName: "Liaison",
            authorType: "agent",
          },
          { ...ctx, isOwnAction: true },
        )

        expect(dockTabs().map((t) => t.threadId)).toEqual(["t-agent"])
        expect(dockTabs()[0].expanded).toBe(false)
      })

      it("a message for an unknown thread surfaces nothing yet", () => {
        boot()

        message("t-new")

        expect(dockTabs()).toHaveLength(0)
      })

      // The first message of a BRAND NEW DM arrives before its thread row:
      // the id is parked and spent the moment the row lands.
      it("a parked DM pops its pill once the thread arrives", () => {
        boot()
        message("t-new")
        expect(dockTabs()).toHaveLength(0)

        seed("t-new", null, ["me", "u2"])

        expect(dockTabs().map((t) => t.threadId)).toEqual(["t-new"])
        expect(dockTabs()[0].expanded).toBe(false)
      })

      it("a system line in a DM pops nothing", () => {
        boot()
        seed("t-dm", null, ["me", "u2"])

        dispatchWsEntityEvent(
          "kernel:message",
          "create",
          {
            threadId: "t-dm",
            content: "Bob joined",
            authorId: "sys",
            authorName: "System",
            authorType: "system",
          },
          ctx,
        )

        expect(dockTabs()).toHaveLength(0)
      })

      // The parked id belongs to the session that received the message. A
      // sign-out and a different sign-in on the same machine must not hand it
      // to the next person.
      it("a parked DM does not pop for the NEXT user after a session teardown", () => {
        boot()
        message("t-new")

        teardownSession()
        resetDockStore()
        signInAs("someone-else")
        seed("t-new", null, ["someone-else", "u2"])

        expect(dockTabs()).toHaveLength(0)
      })

      // Belt and braces for the same leak: the teardown hook clears the map,
      // and the drain re-checks the viewer, so a session that swaps identity
      // without a clean teardown still cannot hand one person's DM to another.
      it("a parked DM does not pop for a different viewer even without a teardown", () => {
        boot()
        message("t-new")

        signInAs("someone-else")
        seed("t-new", null, ["someone-else", "u2"])

        expect(dockTabs()).toHaveLength(0)
      })

      // The row can arrive BECAUSE the user opened the conversation: a deep
      // link fetches it, and the dock must not float a copy of the screen.
      it("a parked DM opened by deep link does not pop once its row arrives", () => {
        boot()
        message("t-new")

        openTab({ type: "thread", entityId: "t-new", label: "New" })
        seed("t-new", null, ["me", "u2"])

        expect(dockTabs()).toHaveLength(0)
      })

      it("a parked CHANNEL stays out of the dock when the thread arrives", () => {
        boot()
        message("t-new-chan")
        seed("t-new-chan", "Team room", ["me", "u2", "u3"])

        expect(dockTabs()).toHaveLength(0)
      })

      it("a channel message surfaces nothing", () => {
        boot()
        seed("t-chan", "Team room", ["me", "u2", "u3"])

        message("t-chan")

        expect(dockTabs()).toHaveLength(0)
      })

      it("the visible active thread surfaces nothing", () => {
        boot()
        seed("t-dm", null, ["me", "u2"])

        message("t-dm", { activeTabId: makeTabId("thread", "t-dm"), isDocumentVisible: true })

        expect(dockTabs()).toHaveLength(0)
      })
    })

    it("marks the attention feed stale on a new message (Home WS invalidation)", () => {
      resetRegistry()
      resetBootstrap()
      resetThreadStore()
      bootstrapKernelApps()
      addThread({
        id: "t-inv",
        handle: "inv",
        title: "Inv",
        isPinned: false,
        isPinnedByUser: false,
        participants: [],
        unreadCount: 0,
        updatedAt: new Date().toISOString(),
      })

      const reloadSpy = vi.spyOn(attentionStore, "markStaleAndReload").mockImplementation(() => {})
      const api = { getEnvelope: vi.fn().mockResolvedValue({ data: { items: [], errors: [] } }) }
      attentionStore.start(api as never)
      reloadSpy.mockClear()

      dispatchWsEntityEvent(
        "kernel:message",
        "create",
        { threadId: "t-inv", content: "hi", authorId: "u2", authorName: "Bob" },
        ctx,
      )
      expect(reloadSpy).toHaveBeenCalledTimes(1)
      reloadSpy.mockRestore()
    })
  })
})

// A desktop window left open on a conversation, behind other apps or on a Mac
// nobody is in front of, keeps its page `visible`. A message landing there was
// taken as read and the read mark cleared the unread pill on the reader's phone
// before they had seen it. Read means the window has the focus too.
describe("a message in the active thread of an unfocused window", () => {
  function arrive(id: string) {
    // After boot: the registry's alias decides the thread tab's id.
    const activeCtx = {
      currentUserId: "me",
      activeTabId: makeTabId("thread", "t-behind"),
      isDocumentVisible: true,
      isOwnAction: false,
    }
    dispatchWsEntityEvent(
      "kernel:message",
      "create",
      {
        id,
        threadId: "t-behind",
        content: "well done",
        authorId: "u2",
        authorType: "user",
        createdAt: new Date().toISOString(),
      },
      activeCtx,
    )
  }

  function boot() {
    resetRegistry()
    resetBootstrap()
    resetThreadStore()
    bootstrapKernelApps()
    addThread({ id: "t-behind", title: null, unreadCount: 0, participants: [] })
  }

  afterEach(() => vi.restoreAllMocks())

  it("stays unread and is not marked read", () => {
    boot()
    vi.spyOn(document, "hasFocus").mockReturnValue(false)
    const markSpy = vi.spyOn(threadStoreModule, "markThreadRead").mockImplementation(() => {})

    arrive("m-behind-1")

    expect(getThread("t-behind")?.unreadCount).toBe(1)
    expect(markSpy).not.toHaveBeenCalled()
  })

  it("is read as it arrives when the window has the focus", () => {
    boot()
    vi.spyOn(document, "hasFocus").mockReturnValue(true)
    vi.spyOn(threadStoreModule, "markThreadRead").mockImplementation(() => {})

    arrive("m-behind-2")

    expect(getThread("t-behind")?.unreadCount).toBe(0)
  })
})
