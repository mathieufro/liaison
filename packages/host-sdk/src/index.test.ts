// SPDX-License-Identifier: FSL-1.1-ALv2
import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test"
import {
  accessToken,
  app,
  currentPath,
  fetch,
  getContext,
  HOST_API_VERSION,
  type HostServices,
  navigate,
  onEntityChange,
} from "./index"

const makeMockHost = (): HostServices => {
  const fetchFn: HostServices["fetch"] = mock(async () => ({ ok: true }) as never)
  const invokeFn: HostServices["invokeTool"] = mock(async () => ({ done: true }) as never)
  const openConnectFn: HostServices["openConnect"] = mock(async () => {})
  return {
    fetch: fetchFn,
    invokeTool: invokeFn,
    openConnect: openConnectFn,
    accessToken: () => "tok-xyz",
  }
}

let mockHost: HostServices

beforeEach(() => {
  mockHost = makeMockHost()
  ;(globalThis as unknown as { __liaisonHost: HostServices }).__liaisonHost = mockHost
  ;(globalThis as unknown as { __LIAISON_TEST_APP_NAME: string }).__LIAISON_TEST_APP_NAME =
    "test-app"
})

afterEach(() => {
  delete (globalThis as unknown as { __liaisonHost?: HostServices }).__liaisonHost
  delete (globalThis as unknown as { __LIAISON_TEST_APP_NAME?: string }).__LIAISON_TEST_APP_NAME
})

describe("@liaison/host runtime", () => {
  it("fetch delegates to window.__liaisonHost.fetch (un-bound, takes path + init)", async () => {
    const r = await fetch("/api/me")
    expect(mockHost.fetch).toHaveBeenCalledWith("/api/me", undefined)
    expect(r).toEqual({ ok: true })
  })

  it("accessToken reads through the window-global accessor", () => {
    expect(accessToken()).toBe("tok-xyz")
  })

  it("app.invokeTool binds appName from the test global (substitutes for freeze-time __LIAISON_APP_NAME__)", async () => {
    await app.invokeTool("staff_overrides_upsert", { liaisonUserId: "u1" })
    expect(mockHost.invokeTool).toHaveBeenCalledWith("test-app", "staff_overrides_upsert", {
      liaisonUserId: "u1",
    })
  })

  it("app.openConnect binds appName the same way", async () => {
    await app.openConnect()
    expect(mockHost.openConnect).toHaveBeenCalledWith("test-app", undefined)
  })

  it("app.openConnectDialog binds appName and returns the host's result", async () => {
    const dialog = mock(async () => ({ connected: true }))
    mockHost.openConnectDialog = dialog
    const result = await app.openConnectDialog({ connectionName: "gitlab" })
    expect(dialog).toHaveBeenCalledWith("test-app", { connectionName: "gitlab" })
    expect(result).toEqual({ connected: true })
  })

  it("app.openConnectDialog rejects with a clear error when the host lacks it", async () => {
    await expect(app.openConnectDialog()).rejects.toThrow(
      /host\.openConnectDialog is not available/,
    )
  })

  it("app.createResource delegates to the host factory with the fetcher + opts", () => {
    const madeResource = Object.assign(() => undefined, { loading: false, error: undefined })
    const actions = { refetch: mock(() => undefined), mutate: mock(() => undefined) }
    const factory = mock((_f: unknown, _o: unknown) => [madeResource, actions] as never)
    mockHost.createResource = factory as never

    const fetcher = async () => ({ v: 1 })
    const [res, ac] = app.createResource(fetcher, { staleAfterMs: 5000 })
    expect(factory).toHaveBeenCalledWith(fetcher, { staleAfterMs: 5000 })
    expect(res).toBe(madeResource as never)
    expect(ac).toBe(actions as never)
  })

  it("app.createResource throws a clear error when the host lacks the factory", () => {
    delete mockHost.createResource
    expect(() => app.createResource(async () => 1)).toThrow(/host\.createResource is not available/)
  })

  it("throws if window.__liaisonHost is missing", () => {
    delete (globalThis as unknown as { __liaisonHost?: HostServices }).__liaisonHost
    expect(() => fetch("/x")).toThrow(/window\.__liaisonHost/)
  })

  it("throws if neither __LIAISON_APP_NAME__ nor __LIAISON_TEST_APP_NAME is set", async () => {
    delete (globalThis as unknown as { __LIAISON_TEST_APP_NAME?: string }).__LIAISON_TEST_APP_NAME
    await expect(app.invokeTool("x", {})).rejects.toThrow(/app name not available/i)
  })

  it("navigate delegates to host.navigate when the host exposes it", () => {
    const navigateFn = mock((_path: string) => {})
    mockHost.navigate = navigateFn
    navigate("/invoicing/document/123")
    expect(navigateFn).toHaveBeenCalledWith("/invoicing/document/123")
  })

  it("currentPath is the host's page path: a framed app's location is its frame's, not the page's", () => {
    mockHost.currentPath = () => "/acme/orders?status=open"
    expect(currentPath()).toBe("/acme/orders?status=open")
  })

  it("currentPath falls back to the window's path and query on a host without it, or none", () => {
    const originalLocation = (globalThis as { location?: unknown }).location
    ;(globalThis as { location?: unknown }).location = { pathname: "/acme", search: "?a=1" }
    try {
      expect(currentPath()).toBe("/acme?a=1")
      delete (globalThis as unknown as { __liaisonHost?: HostServices }).__liaisonHost
      expect(currentPath()).toBe("/acme?a=1")
    } finally {
      ;(globalThis as { location?: unknown }).location = originalLocation
    }
  })

  it("the host API is 1.5: tabLabel and the typed host calls are additions", () => {
    expect(HOST_API_VERSION).toBe("1.5.0")
  })

  it("navigate falls back to globalThis.location.assign when host.navigate is absent", () => {
    // Ensure mockHost has no navigate method (it wasn't set in makeMockHost).
    delete mockHost.navigate
    const assignFn = mock((_url: string) => {})
    const originalLocation = (globalThis as { location?: unknown }).location
    ;(globalThis as { location?: { assign(url: string): void } }).location = { assign: assignFn }
    try {
      navigate("/settings")
      expect(assignFn).toHaveBeenCalledWith("/settings")
    } finally {
      ;(globalThis as { location?: unknown }).location = originalLocation
    }
  })

  it("onEntityChange passes the bound app name, keys, callback and options to the host", () => {
    const dispose = mock(() => {})
    const sub = mock((..._args: unknown[]) => dispose)
    mockHost.onEntityChange = sub
    const cb = () => {}
    const off = onEntityChange("test-app:thing", cb, { debounceMs: 0 })
    expect(sub).toHaveBeenCalledWith("test-app", "test-app:thing", cb, { debounceMs: 0 })
    off()
    expect(dispose).toHaveBeenCalledTimes(1)
  })

  it("onEntityChange is a no-op with a no-op disposer when the host lacks it", () => {
    delete mockHost.onEntityChange
    const off = onEntityChange("test-app:thing", () => {})
    expect(() => off()).not.toThrow()
    delete (globalThis as unknown as { __liaisonHost?: HostServices }).__liaisonHost
    expect(() => onEntityChange("test-app:thing", () => {})()).not.toThrow()
  })
})

// Host API 1.3: the typed calls. In a frame (`framed`) the host answers them; in
// the page, file opening, approval decisions and outside links keep their path.
describe("typed host calls (1.3)", () => {
  it("getContext: null when neither the host nor a token names an org", () => {
    expect(getContext()).toBeNull()
  })

  it("getContext reads the token's org on an older host", () => {
    const payload = btoa(JSON.stringify({ orgId: "org-1" }))
    mockHost.accessToken = () => `h.${payload}.s`
    expect(getContext()?.orgId).toBe("org-1")
    mockHost.context = () => ({
      orgId: "org-2",
      orgName: "Acme",
      locale: "fr",
      user: { id: "u", name: "Ann", locale: "fr" },
    })
    expect(getContext()?.orgName).toBe("Acme")
  })

  it("openFile and decideApproval use the host's calls only in a frame", async () => {
    const openFileById = mock(async () => {})
    const decideApproval = mock(async () => ({ status: "approved" }))
    mockHost.openFileById = openFileById
    mockHost.decideApproval = decideApproval
    expect(await app.openFile("f1", "a.pdf")).toBe(false)
    await app.decideApproval("a1", "approve", "h")
    expect(decideApproval).not.toHaveBeenCalled()
    expect(mockHost.fetch).toHaveBeenCalledWith("/api/approvals/a1/decide", {
      method: "POST",
      body: JSON.stringify({ decision: "approve", payloadHash: "h" }),
    })
    mockHost.framed = true
    expect(await app.openFile("f1", "a.pdf")).toBe(true)
    expect(openFileById).toHaveBeenCalledWith("test-app", "f1", "a.pdf")
    await app.decideApproval("a1", "deny")
    expect(decideApproval).toHaveBeenCalledWith("test-app", "a1", "deny", undefined)
  })

  it("editApproval posts the fields to the approvals route, or uses the host's call in a frame", async () => {
    const editApproval = mock(async () => ({ payloadHash: "h2" }))
    mockHost.editApproval = editApproval
    await app.editApproval("a1", { amountMinor: "500" })
    expect(editApproval).not.toHaveBeenCalled()
    expect(mockHost.fetch).toHaveBeenCalledWith("/api/approvals/a1/payload", {
      method: "POST",
      body: JSON.stringify({ fields: { amountMinor: "500" } }),
    })
    mockHost.framed = true
    await app.editApproval("a1", { amountMinor: "400" })
    expect(editApproval).toHaveBeenCalledWith("test-app", "a1", { amountMinor: "400" })
  })

  it("print, templates, approvals list and records fall back to the kernel routes on an older host", async () => {
    await app.listDocumentTemplates("shipment")
    expect(mockHost.fetch).toHaveBeenCalledWith(
      "/api/documents/templates?app=test-app&entity=shipment",
    )
    ;(mockHost.fetch as ReturnType<typeof mock>).mockImplementation(async () => [
      { toolName: "test-app:ship" },
      { toolName: "other:ship" },
    ])
    expect(await app.listMyApprovals()).toEqual([{ toolName: "test-app:ship" }])
    const nav = mock((_p: string) => {})
    mockHost.navigate = nav
    app.openRecord("invoicing", "document", "d1")
    expect(nav).toHaveBeenCalledWith("/detail/invoicing/document/d1")
    app.openApprovals()
    expect(nav).toHaveBeenLastCalledWith("/approvals")
  })
})
