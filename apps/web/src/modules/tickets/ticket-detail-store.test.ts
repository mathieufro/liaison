// SPDX-License-Identifier: FSL-1.1-ALv2
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

describe("ticket-detail-store", () => {
  // Every module any case in this file stubs. vi.doMock is NOT undone by
  // vi.resetModules (which only drops the module cache), so a stub left
  // registered replaces the real module for every later case: one flaky case
  // then reads as a cascade of unrelated failures.
  const MOCKED_MODULES = [
    "~/modules/tickets/ticket-list-store",
    "~/modules/auth/auth-store",
    "~/framework/resync",
    "~/modules/shell/tab-store",
  ]

  beforeEach(() => vi.resetModules())

  afterEach(() => {
    for (const mod of MOCKED_MODULES) vi.doUnmock(mod)
    vi.resetModules()
  })

  it("a create notice (ticketId, no id) never makes a row without an id", async () => {
    // The server's create event names the ticket `ticketId` and carries no
    // status or requester. Replayed on a reconnect while the tab loads, it used
    // to become the row the detail rendered, with `id` undefined: the file
    // shelf then asked for an upload URL with no entityId (a 400).
    const post = vi.fn().mockImplementation(async (_path: string, body: any) => {
      if (body?.toolName === "tickets:get") {
        return { ticket: { id: "t1", subject: "Hi", status: "open", priority: "normal" } }
      }
      return null
    })
    const { handleTicketEvent, loadTicket, getTicket, resetTicketDetailStore } = await import(
      "~/modules/tickets/ticket-detail-store"
    )
    resetTicketDetailStore()
    const notice = { ticketId: "t1", handle: "ticket-1", subject: "Hi", priority: "normal" }
    handleTicketEvent("create", notice)
    expect(getTicket("t1")).toBeUndefined()
    await loadTicket({ post } as any, "t1")
    expect(getTicket("t1")?.id).toBe("t1")
    // The same notice landing after the load patches the row and keeps its id.
    handleTicketEvent("create", { ...notice, subject: "Renamed" })
    expect(getTicket("t1")?.id).toBe("t1")
    expect(getTicket("t1")?.subject).toBe("Renamed")
    expect(getTicket("t1")?.status).toBe("open")
  })

  it("a read in flight when a live summary event lands never puts the old summary back", async () => {
    // The page reads the ticket (and asks for its summary) while the summary
    // changes on the server: the live event arrives first, the older answers
    // after it. They used to overwrite the new summary with the old one.
    let releaseGet: (v: unknown) => void = () => {}
    const base = { id: "t-sum", subject: "Hi", status: "open", priority: "normal" }
    let gets = 0
    const post = vi.fn().mockImplementation(async (_path: string, body: any) => {
      if (body?.toolName !== "tickets:get") return null
      gets++
      if (gets === 1) return { ticket: { ...base, summaryText: null, summaryStatus: "idle" } }
      return new Promise((resolve) => {
        releaseGet = resolve
      })
    })
    const {
      applyTicketSummaryResult,
      handleTicketEvent,
      loadTicket,
      getTicket,
      resetTicketDetailStore,
      ticketSummaryVersion,
    } = await import("~/modules/tickets/ticket-detail-store")
    resetTicketDetailStore()
    await loadTicket({ post } as any, "t-sum")
    const before = ticketSummaryVersion("t-sum")
    const reload = loadTicket({ post } as any, "t-sum")
    await Promise.resolve()
    handleTicketEvent("summary_updated", {
      id: "t-sum",
      ticketId: "t-sum",
      summaryText: "The new summary",
      summaryStatus: "idle",
    })
    releaseGet({
      ticket: { ...base, subject: "Renamed", summaryText: null, summaryStatus: "error" },
    })
    await reload
    expect(getTicket("t-sum")?.summaryText).toBe("The new summary")
    expect(getTicket("t-sum")?.summaryStatus).toBe("idle")
    // The rest of the answer still lands.
    expect(getTicket("t-sum")?.subject).toBe("Renamed")
    // An ensureSummary answer started before the event is dropped too.
    expect(
      applyTicketSummaryResult("t-sum", { summary: null, summaryStatus: "error" }, before),
    ).toBe(false)
    expect(getTicket("t-sum")?.summaryText).toBe("The new summary")
    // One started after it applies.
    expect(
      applyTicketSummaryResult(
        "t-sum",
        { summary: "Later", summaryStatus: "idle" },
        ticketSummaryVersion("t-sum"),
      ),
    ).toBe(true)
    expect(getTicket("t-sum")?.summaryText).toBe("Later")
  })

  it("loadTicket fetches via tickets:get and stores the ticket", async () => {
    const post = vi.fn().mockImplementation(async (_path: string, body: any) => {
      if (body?.toolName === "tickets:get") {
        return {
          ticket: {
            id: "t1",
            handle: "ticket-1",
            subject: "Hi",
            status: "open",
            priority: "normal",
            unread: true,
            readByCount: 0,
            readByRecent: [],
          },
          messages: { items: [], nextCursor: null },
        }
      }
      return null
    })
    const api = { post } as any
    const { loadTicket, getTicket, resetTicketDetailStore } = await import(
      "~/modules/tickets/ticket-detail-store"
    )
    resetTicketDetailStore()
    await loadTicket(api, "t1")
    expect(getTicket("t1")?.subject).toBe("Hi")
  })

  it("loadTicket seeds the header from the inbox list cache instantly, then the fetch revalidates in place", async () => {
    vi.doMock("~/modules/tickets/ticket-list-store", () => ({
      getTicketFromList: (id: string) =>
        id === "t-seed"
          ? {
              id: "t-seed",
              handle: "ticket-7",
              subject: "From list",
              status: "open",
              priority: "normal",
            }
          : undefined,
    }))
    let resolvePost!: (v: unknown) => void
    const post = vi.fn(
      () =>
        new Promise((r) => {
          resolvePost = r
        }),
    )
    const api = { post } as any
    const { loadTicket, getTicket, resetTicketDetailStore } = await import(
      "~/modules/tickets/ticket-detail-store"
    )
    resetTicketDetailStore()
    const done = loadTicket(api, "t-seed")
    // The lazy list-store import settles on a microtask — the header row is
    // available BEFORE the tickets:get resolves.
    await new Promise((r) => setTimeout(r, 0))
    expect(getTicket("t-seed")?.subject).toBe("From list")
    resolvePost({
      ticket: { id: "t-seed", handle: "ticket-7", subject: "Fresh", status: "open" },
      messages: { items: [], nextCursor: null },
    })
    await done
    expect(getTicket("t-seed")?.subject).toBe("Fresh")
  })

  it("loadTicket marks not_found when tickets:get returns no ticket (RLS-hidden or deleted)", async () => {
    const post = vi
      .fn()
      .mockResolvedValue({ ticket: null, messages: { items: [], nextCursor: null } })
    const api = { post } as any
    const { loadTicket, resetTicketDetailStore, ticketDetailStore } = await import(
      "~/modules/tickets/ticket-detail-store"
    )
    resetTicketDetailStore()
    await loadTicket(api, "t-hidden")
    expect(ticketDetailStore.loadFailedById["t-hidden"]).toBe("not_found")
    expect(ticketDetailStore.loadingById["t-hidden"]).toBe(false)
  })

  it("loadTicket marks error when tickets:get throws, and a later success clears it", async () => {
    let fail = true
    const post = vi.fn().mockImplementation(async () => {
      if (fail) throw new Error("boom")
      return {
        ticket: {
          id: "t-retry",
          handle: "ticket-9",
          subject: "Recovered",
          status: "open",
          priority: "normal",
          unread: false,
          readByCount: 0,
          readByRecent: [],
        },
        messages: { items: [], nextCursor: null },
      }
    })
    const api = { post } as any
    const { loadTicket, getTicket, resetTicketDetailStore, ticketDetailStore } = await import(
      "~/modules/tickets/ticket-detail-store"
    )
    resetTicketDetailStore()
    await loadTicket(api, "t-retry")
    expect(ticketDetailStore.loadFailedById["t-retry"]).toBe("error")
    fail = false
    await loadTicket(api, "t-retry")
    expect(ticketDetailStore.loadFailedById["t-retry"]).toBeUndefined()
    expect(getTicket("t-retry")?.subject).toBe("Recovered")
  })

  it("markRead patches read state locally and never re-fetches the ticket", async () => {
    // Every mark-read (mount, focus, visibilitychange, inbound message) used
    // to chain a full tickets:get — a 5-10s sandbox tool call in prod. The
    // contract now: one tickets:markRead, ZERO tickets:get, local patch.
    vi.doMock("~/modules/auth/auth-store", async (importOriginal) => ({
      ...(await importOriginal<Record<string, unknown>>()),
      userFromToken: () => ({ userId: "me-1", name: "Me Myself" }),
    }))
    const post = vi.fn().mockImplementation(async (_path: string, body: any) => {
      if (body?.toolName === "tickets:markRead")
        return { readAt: new Date().toISOString(), lastReadMessageId: null }
      return null
    })
    const api = { post } as any
    const { markRead, handleTicketEvent, getTicket, resetTicketDetailStore } = await import(
      "~/modules/tickets/ticket-detail-store"
    )
    resetTicketDetailStore()
    handleTicketEvent("create", {
      id: "t1",
      subject: "s",
      status: "open",
      unread: true,
      readByCount: 1,
      readByRecent: [{ userId: "u1", name: "Agent", readAt: "2026-01-01T00:00:00Z" }],
    })
    await markRead(api, "t1")
    expect(post.mock.calls.filter((c) => c[1]?.toolName === "tickets:get")).toHaveLength(0)
    expect(post.mock.calls.filter((c) => c[1]?.toolName === "tickets:markRead")).toHaveLength(1)
    expect(getTicket("t1")?.unread).toBe(false)
    // The viewer joins the read-by stack locally (once — idempotent).
    expect(getTicket("t1")?.readByCount).toBe(2)
    expect(getTicket("t1")?.readByRecent?.[0]?.userId).toBe("me-1")
    await markRead(api, "t1")
    expect(getTicket("t1")?.readByCount).toBe(2)
    expect(post.mock.calls.filter((c) => c[1]?.toolName === "tickets:get")).toHaveLength(0)
  })

  it("a failed background markRead is logged, never raised as the global error toast", async () => {
    // markRead fires on mount, focus and visibilitychange: the viewer never
    // asked for it, so a 403 from it must not pop "You don't have permission".
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ error: { code: "FORBIDDEN", message: "denied" } }), {
        status: 403,
        headers: { "Content-Type": "application/json" },
      }),
    )
    vi.stubGlobal("fetch", fetchMock)
    try {
      const { createApiClient } = await import("~/lib/api-client")
      const { log } = await import("~/lib/logger")
      const warn = vi.spyOn(log, "warn").mockImplementation(() => undefined as never)
      const onError = vi.fn()
      const api = createApiClient({
        getAccessToken: () => "token",
        onUnauthorized: vi.fn(),
        onError,
      })
      const { markRead } = await import("~/modules/tickets/ticket-detail-store")
      await markRead(api, "t1")
      expect(fetchMock).toHaveBeenCalledTimes(1)
      expect(JSON.parse(fetchMock.mock.calls[0][1].body).toolName).toBe("tickets:markRead")
      expect(onError).not.toHaveBeenCalled()
      expect(warn).toHaveBeenCalledTimes(1)
      warn.mockRestore()
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it("resync reloads only the active ticket tab; background tabs are marked stale and reload on activation", async () => {
    let resyncCb: (() => void) | undefined
    vi.doMock("~/framework/resync", () => ({
      subscribeResync: (cb: () => void) => {
        resyncCb = cb
      },
    }))
    vi.doMock("~/modules/shell/tab-store", () => ({
      tabStore: { activeTabId: "tickets:ticket/t-active" },
      makeTabId: (type: string, id: string) => `${type}/${id}`,
    }))
    const post = vi.fn().mockImplementation(async (_path: string, body: any) => {
      if (body?.toolName === "tickets:get") {
        return {
          ticket: {
            id: body.params?.ticketId,
            handle: "h",
            subject: "s",
            status: "open",
            priority: "normal",
          },
          messages: { items: [], nextCursor: null },
        }
      }
      return null
    })
    const api = { post } as any
    const {
      loadTicket,
      subscribeTicketDetailResync,
      isTicketDetailStale,
      ticketDetailStore,
      resetTicketDetailStore,
    } = await import("~/modules/tickets/ticket-detail-store")
    resetTicketDetailStore()
    await loadTicket(api, "t-active")
    await loadTicket(api, "t-bg")
    subscribeTicketDetailResync()
    expect(resyncCb).toBeDefined()
    post.mockClear()
    resyncCb!()
    // Flush the lazy tab-store import + the loadTicket round-trip.
    await new Promise((r) => setTimeout(r, 0))
    await new Promise((r) => setTimeout(r, 0))
    const getFor = (id: string) =>
      post.mock.calls.filter(
        (c) => c[1]?.toolName === "tickets:get" && c[1]?.params?.ticketId === id,
      )
    // Pre-fix: EVERY loaded ticket refetched (2 x N calls per reconnect blip).
    expect(getFor("t-active").length).toBeGreaterThan(0)
    expect(getFor("t-bg")).toHaveLength(0)
    expect(isTicketDetailStale("t-bg")).toBe(true)
    expect(ticketDetailStore.staleById["t-active"]).toBeUndefined()
    // Activation catch-up path: loadTicket clears the stale flag.
    await loadTicket(api, "t-bg")
    expect(isTicketDetailStale("t-bg")).toBe(false)
  })

  it("setStatus / setPriority / reopenTicket call tools and update store", async () => {
    const calls: Array<{ tool: string; params: any }> = []
    const post = vi.fn().mockImplementation(async (_path: string, body: any) => {
      calls.push({ tool: body.toolName, params: body.params })
      if (body?.toolName === "tickets:get") {
        return {
          ticket: { id: "t1", handle: "h", subject: "s", status: "open", priority: "normal" },
          messages: { items: [], nextCursor: null },
        }
      }
      return {}
    })
    const api = { post } as any
    const { loadTicket, setStatus, setPriority, reopenTicket, getTicket, resetTicketDetailStore } =
      await import("~/modules/tickets/ticket-detail-store")
    resetTicketDetailStore()
    await loadTicket(api, "t1")
    await setStatus(api, "t1", "awaiting_customer")
    await setPriority(api, "t1", "high")
    await reopenTicket(api, "t1")
    expect(getTicket("t1")?.status).toBe("open")
    expect(getTicket("t1")?.closedReason).toBeNull()
    expect(getTicket("t1")?.priority).toBe("high")
    expect(calls.map((c) => c.tool)).toEqual(
      expect.arrayContaining(["tickets:setStatus", "tickets:setPriority", "tickets:reopen"]),
    )
  })

  it("handleTicketEvent merges update changes onto the cached row", async () => {
    const { handleTicketEvent, getTicket, resetTicketDetailStore } = await import(
      "~/modules/tickets/ticket-detail-store"
    )
    resetTicketDetailStore()
    handleTicketEvent("create", { id: "t9", subject: "first", status: "open" })
    handleTicketEvent("update", { id: "t9", changes: { subject: "second", priority: "urgent" } })
    expect(getTicket("t9")?.subject).toBe("second")
    expect(getTicket("t9")?.priority).toBe("urgent")
  })

  it("handleTicketEvent update->closed prunes the ticket from the open inbox list in real time", async () => {
    const { handleTicketEvent, resetTicketDetailStore } = await import(
      "~/modules/tickets/ticket-detail-store"
    )
    const {
      loadTickets,
      setListParams,
      paramsForSmartFilter,
      ticketListStore,
      resetTicketListStore,
    } = await import("~/modules/tickets/ticket-list-store")
    resetTicketDetailStore()
    resetTicketListStore()
    setListParams(paramsForSmartFilter("all-open"))
    await loadTickets({
      post: vi.fn().mockResolvedValue({
        items: [{ id: "t1", handle: "h1", subject: "A", status: "open", priority: "normal" }],
        nextCursor: null,
      }),
    } as any)
    expect(ticketListStore.ids).toEqual(["t1"])

    // The WS echo of a close (status -> closed) must remove the row from the
    // all-open list. Previously only merges pruned the list, so a plain close
    // left a stale open row until the next manual reload.
    handleTicketEvent("update", {
      id: "t1",
      changes: { status: "closed", closedReason: "resolved" },
    })
    await vi.waitFor(() => expect(ticketListStore.ids).toEqual([]))
  })

  it("handleTicketEvent reopened prunes the ticket from the closed filter in real time", async () => {
    const { handleTicketEvent, resetTicketDetailStore } = await import(
      "~/modules/tickets/ticket-detail-store"
    )
    const {
      loadTickets,
      setListParams,
      paramsForSmartFilter,
      ticketListStore,
      resetTicketListStore,
    } = await import("~/modules/tickets/ticket-list-store")
    resetTicketDetailStore()
    resetTicketListStore()
    setListParams(paramsForSmartFilter("closed"))
    await loadTickets({
      post: vi.fn().mockResolvedValue({
        items: [{ id: "c1", handle: "hc1", subject: "Closed", status: "closed", priority: "low" }],
        nextCursor: null,
      }),
    } as any)
    expect(ticketListStore.ids).toEqual(["c1"])

    handleTicketEvent("reopened", { id: "c1", reason: "manual" })
    await vi.waitFor(() => expect(ticketListStore.ids).toEqual([]))
  })

  it("handleTicketEvent dispatches tickets:attention-invalidated so the sidebar count refreshes reactively", async () => {
    const { handleTicketEvent, resetTicketDetailStore } = await import(
      "~/modules/tickets/ticket-detail-store"
    )
    resetTicketDetailStore()
    let invalidations = 0
    const onInvalidate = () => {
      invalidations += 1
    }
    window.addEventListener("tickets:attention-invalidated", onInvalidate)
    try {
      handleTicketEvent("create", { id: "t-attn", status: "open" })
      handleTicketEvent("update", { id: "t-attn", changes: { status: "awaiting_customer" } })
      // Mutation lens: a regression that drops the dispatch in handleTicketEvent
      // (see ticket-detail-store.ts) would zero this counter, leaving the
      // "Needs attention now" badge stale until manual reload.
      expect(invalidations).toBeGreaterThanOrEqual(2)
    } finally {
      window.removeEventListener("tickets:attention-invalidated", onInvalidate)
    }
  })

  it("[SC14] handleTicketEvent applies summary_updated payloads", async () => {
    const { handleTicketEvent, getTicket, resetTicketDetailStore } = await import(
      "~/modules/tickets/ticket-detail-store"
    )
    resetTicketDetailStore()
    handleTicketEvent("create", { id: "t9", subject: "first", status: "open" })
    handleTicketEvent("summary_updated", {
      ticketId: "t9",
      summary: "Updated summary",
      summaryAt: "2026-01-01T00:00:00.000Z",
      status: "idle",
      model: "test-model",
    })
    expect(getTicket("t9")?.summaryText).toBe("Updated summary")
    expect(getTicket("t9")?.summaryModel).toBe("test-model")
  })

  it("evictTicketDetail drops only the given ticket's detail record", async () => {
    const { handleTicketEvent, evictTicketDetail, getTicket, resetTicketDetailStore } =
      await import("~/modules/tickets/ticket-detail-store")
    resetTicketDetailStore()
    handleTicketEvent("create", { id: "t-evict", subject: "evict me", status: "open" })
    handleTicketEvent("create", { id: "t-keep", subject: "keep me", status: "open" })
    expect(getTicket("t-evict")).toBeTruthy()

    evictTicketDetail("t-evict")

    expect(getTicket("t-evict")).toBeUndefined()
    expect(getTicket("t-keep")).toBeTruthy()
  })

  it("[C1.2] loadTicket started, evicted mid-flight, then resolves -> entry stays absent", async () => {
    let resolvePost!: (v: any) => void
    const post = vi.fn().mockImplementation(
      () =>
        new Promise((r) => {
          resolvePost = r
        }),
    )
    const api = { post } as any
    const { loadTicket, evictTicketDetail, getTicket, resetTicketDetailStore } = await import(
      "~/modules/tickets/ticket-detail-store"
    )
    resetTicketDetailStore()

    const loadPromise = loadTicket(api, "t-race")
    // Evict before the in-flight tickets:get resolves.
    evictTicketDetail("t-race")
    expect(getTicket("t-race")).toBeUndefined()

    resolvePost({
      ticket: {
        id: "t-race",
        handle: "ticket-race",
        subject: "late arrival",
        status: "open",
        priority: "normal",
        unread: true,
        readByCount: 0,
        readByRecent: [],
      },
      messages: { items: [], nextCursor: null },
    })
    await loadPromise

    // The stale write-back must NOT resurrect the evicted ticket.
    expect(getTicket("t-race")).toBeUndefined()
  })

  it("assignTicket applies the assignee name optimistically before the server responds", async () => {
    let resolveAssign!: (v: any) => void
    const post = vi.fn().mockImplementation(async (_path: string, body: any) => {
      if (body?.toolName === "tickets:assign") {
        return new Promise((r) => {
          resolveAssign = r
        })
      }
      // refreshTicketHeader's tickets:get
      return {
        ticket: {
          id: "t-a",
          handle: "ticket-a",
          subject: "S",
          status: "open",
          priority: "normal",
          unread: false,
          readByCount: 0,
          readByRecent: [],
          assignedTo: "u-morgan",
          assigneeName: "Morgan Lee",
        },
        messages: { items: [], nextCursor: null },
      }
    })
    const api = { post } as any
    const store = await import("~/modules/tickets/ticket-detail-store")
    store.resetTicketDetailStore()
    await store.loadTicket(api, "t-a")
    // loadTicket used the same mock — force a clean baseline.
    const assignPromise = store.assignTicket(api, "t-a", "u-morgan", "Morgan Lee")
    // Optimistic: name visible immediately, before tickets:assign resolves.
    expect(store.getTicket("t-a")?.assignedTo).toBe("u-morgan")
    expect(store.getTicket("t-a")?.assigneeName).toBe("Morgan Lee")
    resolveAssign({ ticketId: "t-a", assignedTo: "u-morgan" })
    await assignPromise
    expect(store.getTicket("t-a")?.assigneeName).toBe("Morgan Lee")
  })

  it("assignTicket rolls back the optimistic assignee when the server rejects", async () => {
    const post = vi.fn().mockImplementation(async (_path: string, body: any) => {
      if (body?.toolName === "tickets:assign") throw new Error("conflict")
      return {
        ticket: {
          id: "t-b",
          handle: "ticket-b",
          subject: "S",
          status: "open",
          priority: "normal",
          unread: false,
          readByCount: 0,
          readByRecent: [],
          assignedTo: "u-prev",
          assigneeName: "Prev Owner",
        },
        messages: { items: [], nextCursor: null },
      }
    })
    const api = { post } as any
    const store = await import("~/modules/tickets/ticket-detail-store")
    store.resetTicketDetailStore()
    await store.loadTicket(api, "t-b")
    await expect(store.assignTicket(api, "t-b", "u-morgan", "Morgan Lee")).rejects.toThrow(
      "conflict",
    )
    expect(store.getTicket("t-b")?.assignedTo).toBe("u-prev")
    expect(store.getTicket("t-b")?.assigneeName).toBe("Prev Owner")
  })
  // vi.doMock survives vi.resetModules: a mock registered inside one case is
  // still registered for every case after it, so a partial stub of tab-store
  // or resync silently replaces the real module for the rest of the file and
  // one timing flake turns into a cascade of unrelated failures.
  it("module mocks registered by earlier cases do not leak into this one", async () => {
    const tabStore = await import("~/modules/shell/tab-store")
    expect(typeof tabStore.openTab).toBe("function")
    const resync = await import("~/framework/resync")
    expect(typeof resync.requestResync).toBe("function")
    const auth = await import("~/modules/auth/auth-store")
    expect(typeof auth.clearAuth).toBe("function")
    const list = await import("~/modules/tickets/ticket-list-store")
    expect(typeof list.paramsForSmartFilter).toBe("function")
  })
  it("an inactive ticket tab flagged stale reloads with a fresh load when activated, even while an old load hangs", async () => {
    const ticketId = "t-stale"
    let messageLoads = 0
    const note = {
      id: "note-2",
      ticketId,
      kind: "note",
      textBody: "written while the tab was in the background",
      sentAt: "2026-10-30T09:00:00Z",
    }
    const post = vi.fn(
      async (
        _path: string,
        body: { params?: { messagesLimit?: number } },
        init?: { signal?: AbortSignal },
      ) => {
        const ticket = { id: ticketId, handle: "T-2", subject: "Stale", status: "open" }
        if (body.params?.messagesLimit === undefined) return { ticket }
        messageLoads++
        if (messageLoads <= 2) {
          // The load from before the blip: it never answers.
          return new Promise((_resolve, reject) => {
            init?.signal?.addEventListener("abort", () =>
              reject(new DOMException("aborted", "AbortError")),
            )
          })
        }
        return { ticket, messages: { items: [note], nextCursor: null } }
      },
    )
    const api = { post, get: vi.fn() } as never
    const { loadTicket, resetTicketDetailStore } = await import(
      "~/modules/tickets/ticket-detail-store"
    )
    const { ticketMessageStore, resetTicketMessageStore } = await import(
      "~/modules/tickets/ticket-message-store"
    )
    resetTicketDetailStore()
    resetTicketMessageStore()
    const flush = async () => {
      for (let i = 0; i < 4; i++) await new Promise((resolve) => setTimeout(resolve, 0))
    }
    await loadTicket(api, ticketId)
    await flush()
    expect(messageLoads).toBe(2)
    // The tab is activated while flagged stale (TicketDetail): a restarting load.
    await loadTicket(api, ticketId, { restart: true })
    await flush()
    expect(messageLoads).toBe(4)
    expect(ticketMessageStore.threadsByTicketId[ticketId]?.ids).toEqual(["note-2"])
    expect(ticketMessageStore.threadsByTicketId[ticketId]?.loading).toBe(false)
  })
})
