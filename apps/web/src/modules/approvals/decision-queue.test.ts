// SPDX-License-Identifier: FSL-1.1-ALv2
// S15 (iPhone walk 2026-10-19): approve and reject wait out an 8 s Undo window.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { ApiError } from "~/lib/api-error"
import { runBeforeSignOut } from "~/lib/session-lifecycle"
import { clearLiaisonStorage } from "~/lib/storage"
import {
  DecisionQueueTestAccess,
  DecisionUndoneError,
  DONE_LINGER_MS,
  decisionToastItems,
  flushDecisions,
  installDecisionFlush,
  isDecisionInFlight,
  isDecisionNotSent,
  isDecisionQueued,
  queueDecision,
  resendStoredDecisions,
  STORED_DECISION_MAX_AGE_MS,
  UNDO_WINDOW_MS,
  undoDecision,
} from "~/modules/approvals/decision-queue"
import { dismissToast, toasts } from "~/modules/shell/toast-store"

const session = vi.hoisted(() => ({ userId: "u-1" as string | null }))
vi.mock("~/modules/auth/auth-store", async (importOriginal) => ({
  ...(await importOriginal<typeof import("~/modules/auth/auth-store")>()),
  userFromToken: () => (session.userId ? { userId: session.userId } : null),
}))

const STORAGE_KEY = "liaison:pendingDecisions.v1"
const SERVER_GLOBAL = "__LIAISON_SERVER_ADDRESS__"

function makeApi(impl?: (path: string, body: unknown, init: unknown) => Promise<unknown>) {
  const post = vi.fn(impl ?? (async () => ({ status: "approved" })))
  return { api: { post } as never, post }
}

beforeEach(() => {
  session.userId = "u-1"
  vi.useFakeTimers()
  DecisionQueueTestAccess.reset()
  for (const t of toasts()) dismissToast(t.id)
})
afterEach(() => {
  delete (globalThis as Record<string, unknown>)[SERVER_GLOBAL]
  DecisionQueueTestAccess.reset()
  vi.useRealTimers()
})

describe("decision queue", () => {
  it("the Undo window is 8 seconds", () => {
    expect(UNDO_WINDOW_MS).toBe(8_000)
  })

  it("undo at 7999 ms: never sent", async () => {
    const { api, post } = makeApi()
    const done = queueDecision(api, "approval", "a1", { decision: "approve" }).catch((e) => e)
    await vi.advanceTimersByTimeAsync(7_999)
    expect(undoDecision("approval", "a1")).toBe(true)
    expect(await done).toBeInstanceOf(DecisionUndoneError)
    await vi.advanceTimersByTimeAsync(10_000)
    expect(post).not.toHaveBeenCalled()
  })

  // The decided-for audit row is written by the server's decide, which an undone decision never reaches.
  it("Undo inside 8 s leaves no decided-for audit", async () => {
    const { api, post } = makeApi()
    const done = queueDecision(api, "approval", "a1", { decision: "approve" }).catch((e) => e)
    await vi.advanceTimersByTimeAsync(4_000)
    undoDecision("approval", "a1")
    await done
    await vi.advanceTimersByTimeAsync(20_000)
    expect(post.mock.calls.filter(([path]) => String(path).endsWith("/decide"))).toEqual([])
  })

  it("at 8001 ms: sent once", async () => {
    const { api, post } = makeApi()
    const done = queueDecision(api, "approval", "a1", { decision: "approve" })
    await vi.advanceTimersByTimeAsync(7_999)
    expect(post).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(2)
    await done
    await vi.advanceTimersByTimeAsync(20_000)
    expect(post).toHaveBeenCalledTimes(1)
  })

  it("sends nothing inside the window, names the decision in the toast, then sends", async () => {
    const { api, post } = makeApi()
    const done = queueDecision(
      api,
      "approval",
      "a1",
      { decision: "approve", payloadHash: "h" },
      { label: { title: "ticket-10889: 2d slider", detail: "Reply" } },
    )
    expect(isDecisionQueued("approval", "a1")).toBe(true)
    expect(decisionToastItems()).toEqual([
      expect.objectContaining({
        id: "a1",
        decision: "approve",
        phase: "queued",
        label: { title: "ticket-10889: 2d slider", detail: "Reply" },
        windowMs: UNDO_WINDOW_MS,
      }),
    ])
    await vi.advanceTimersByTimeAsync(UNDO_WINDOW_MS - 1)
    expect(post).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    expect(post).toHaveBeenCalledWith(
      "/approvals/a1/decide",
      { decision: "approve", payloadHash: "h" },
      { suppressGlobalError: true },
    )
    await expect(done).resolves.toEqual({ status: "approved" })
    expect(isDecisionQueued("approval", "a1")).toBe(false)
  })

  it("an unlabelled decision still names what it decides", () => {
    const { api } = makeApi()
    void queueDecision(api, "scope-request", "s1", { decision: "approve" }).catch(() => {})
    expect(decisionToastItems()[0]?.label?.title).toBe("Access request")
  })

  // The Home row used to come back as "Approving…" the moment the window ended
  // (only the window counted as queued). It now stays hidden until the decision
  // is done, and the toast carries the progress.
  it("stays in flight while it is sent, shows done for a moment, then leaves", async () => {
    let answer: (v: unknown) => void = () => {}
    const { api } = makeApi(() => new Promise((r) => (answer = r)))
    const done = queueDecision(api, "approval", "a1", { decision: "approve" })
    await vi.advanceTimersByTimeAsync(UNDO_WINDOW_MS)
    expect(isDecisionQueued("approval", "a1")).toBe(false)
    expect(isDecisionInFlight("approval", "a1")).toBe(true)
    expect(decisionToastItems()[0]?.phase).toBe("sending")
    // Too late to undo once it is being sent.
    expect(undoDecision("approval", "a1")).toBe(false)
    answer({ status: "approved" })
    await done
    expect(decisionToastItems()[0]?.phase).toBe("done")
    expect(isDecisionInFlight("approval", "a1")).toBe(true)
    await vi.advanceTimersByTimeAsync(DONE_LINGER_MS)
    expect(decisionToastItems()).toEqual([])
    expect(isDecisionInFlight("approval", "a1")).toBe(false)
  })

  it("a failed decision leaves the toast at once, so its row comes back", async () => {
    const { api } = makeApi(async () => {
      throw new ApiError("handler failed", 422, "handler_failed")
    })
    const caught = queueDecision(api, "approval", "a1", { decision: "approve" }).catch((e) => e)
    await vi.advanceTimersByTimeAsync(UNDO_WINDOW_MS)
    expect(await caught).toBeInstanceOf(ApiError)
    expect(decisionToastItems()).toEqual([])
    expect(isDecisionInFlight("approval", "a1")).toBe(false)
  })

  it("Undo restores the item and sends nothing", async () => {
    const { api, post } = makeApi()
    const done = queueDecision(api, "approval", "a1", { decision: "deny", reason: "" })
    expect(decisionToastItems()[0]).toEqual(expect.objectContaining({ decision: "deny" }))
    expect(undoDecision("approval", "a1")).toBe(true)
    await expect(done).rejects.toBeInstanceOf(DecisionUndoneError)
    expect(isDecisionQueued("approval", "a1")).toBe(false)
    expect(isDecisionInFlight("approval", "a1")).toBe(false)
    expect(decisionToastItems()).toEqual([])
    await vi.advanceTimersByTimeAsync(UNDO_WINDOW_MS * 2)
    expect(post).not.toHaveBeenCalled()
    expect(localStorage.getItem(STORAGE_KEY)).toBeNull()
    // Too late once sent.
    expect(undoDecision("approval", "a1")).toBe(false)
  })

  it("two quick decisions are two lines, each on its own clock, and two sends", async () => {
    const { api, post } = makeApi()
    const a = queueDecision(api, "approval", "a1", { decision: "approve" })
    await vi.advanceTimersByTimeAsync(2_000)
    const b = queueDecision(api, "approval", "a2", { decision: "approve" })
    expect(decisionToastItems().map((i) => i.id)).toEqual(["a1", "a2"])
    await vi.advanceTimersByTimeAsync(UNDO_WINDOW_MS - 2_000)
    await a
    expect(post).toHaveBeenCalledTimes(1)
    expect(decisionToastItems().map((i) => i.phase)).toEqual(["done", "queued"])
    await vi.advanceTimersByTimeAsync(2_000)
    await b
    expect(post).toHaveBeenCalledTimes(2)
  })

  it("a server refusal after the window reaches the caller", async () => {
    const { api } = makeApi(async () => {
      throw new ApiError("already decided", 409, "already_decided")
    })
    const done = queueDecision(api, "approval", "a1", { decision: "approve" })
    const caught = done.catch((e: unknown) => e)
    await vi.advanceTimersByTimeAsync(UNDO_WINDOW_MS)
    expect(await caught).toBeInstanceOf(ApiError)
  })

  it("is kept in storage while it waits, and gone once sent", async () => {
    const { api } = makeApi()
    const done = queueDecision(api, "scope-request", "s1", { decision: "approve" })
    expect(JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "[]")).toEqual([
      expect.objectContaining({ kind: "scope-request", id: "s1", decision: "approve" }),
    ])
    await vi.advanceTimersByTimeAsync(UNDO_WINDOW_MS)
    await done
    expect(localStorage.getItem(STORAGE_KEY)).toBeNull()
  })

  it("flushes at once, with keepalive, on pagehide, on a hidden page and when the phone app backgrounds", async () => {
    let appListener: ((s: { isActive: boolean }) => void) | null = null
    ;(globalThis as Record<string, unknown>).Capacitor = {
      Plugins: {
        App: {
          addListener: (_e: string, h: (s: { isActive: boolean }) => void) => {
            appListener = h
            return { remove: () => {} }
          },
        },
      },
    }
    const teardown = installDecisionFlush()
    try {
      const { api, post } = makeApi()
      void queueDecision(api, "approval", "p1", { decision: "approve" })
      window.dispatchEvent(new Event("pagehide"))
      expect(post).toHaveBeenLastCalledWith("/approvals/p1/decide", expect.anything(), {
        suppressGlobalError: true,
        keepalive: true,
      })

      void queueDecision(api, "approval", "p2", { decision: "approve" })
      Object.defineProperty(document, "visibilityState", { configurable: true, value: "hidden" })
      document.dispatchEvent(new Event("visibilitychange"))
      Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" })
      expect(post).toHaveBeenLastCalledWith("/approvals/p2/decide", expect.anything(), {
        suppressGlobalError: true,
        keepalive: true,
      })

      await Promise.resolve()
      void queueDecision(api, "approval", "p3", { decision: "deny" })
      expect(appListener).not.toBeNull()
      appListener!({ isActive: false })
      expect(post).toHaveBeenLastCalledWith("/approvals/p3/decide", expect.anything(), {
        suppressGlobalError: true,
        keepalive: true,
      })
      expect(post).toHaveBeenCalledTimes(3)
    } finally {
      teardown()
      delete (globalThis as Record<string, unknown>).Capacitor
    }
  })

  it("flushDecisions sends each queued decision once", async () => {
    const { api, post } = makeApi()
    void queueDecision(api, "approval", "f1", { decision: "approve" })
    flushDecisions()
    flushDecisions()
    await vi.advanceTimersByTimeAsync(UNDO_WINDOW_MS)
    expect(post).toHaveBeenCalledTimes(1)
  })

  it("resends at boot what a closed page left stored; an already-decided one is dropped", async () => {
    ;(globalThis as Record<string, unknown>)[SERVER_GLOBAL] = "https://a.test"
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify([
        stored("b1", { body: { decision: "approve" } }),
        stored("b2", { decision: "deny", body: { decision: "deny", reason: "" } }),
      ]),
    )
    const { api, post } = makeApi(async (path) => {
      if (path === "/approvals/b2/decide")
        throw new ApiError("already decided", 409, "already_decided")
      return { status: "approved" }
    })
    await resendStoredDecisions(api)
    expect(post.mock.calls.map((c) => c[0])).toEqual([
      "/approvals/b1/decide",
      "/approvals/b2/decide",
    ])
    expect(localStorage.getItem(STORAGE_KEY)).toBeNull()
  })

  it("pagehide flushes with keepalive: a Dismiss 2.5 s into its window is sent as the tab closes", async () => {
    const teardown = installDecisionFlush()
    try {
      const { api, post } = makeApi()
      void queueDecision(api, "approval", "d1", { decision: "deny", reason: "" })
      await vi.advanceTimersByTimeAsync(2_500)
      expect(post).not.toHaveBeenCalled()
      window.dispatchEvent(new Event("pagehide"))
      // Issued in the pagehide task itself: nothing awaits before the fetch leaves.
      expect(post).toHaveBeenCalledTimes(1)
      expect(post).toHaveBeenLastCalledWith(
        "/approvals/d1/decide",
        { decision: "deny", reason: "" },
        { suppressGlobalError: true, keepalive: true },
      )
      await vi.advanceTimersByTimeAsync(UNDO_WINDOW_MS)
      expect(post).toHaveBeenCalledTimes(1)
    } finally {
      teardown()
    }
  })

  // Dismiss, then the tab closes 2.5 s into the window without pagehide.
  it("stored decision sent at next boot: a tab closed inside the window loses nothing", async () => {
    ;(globalThis as Record<string, unknown>)[SERVER_GLOBAL] = "https://a.test"
    const first = makeApi()
    void queueDecision(first.api, "approval", "s1", { decision: "deny", reason: "" }).catch(
      () => {},
    )
    await vi.advanceTimersByTimeAsync(2_500)
    expect(first.post).not.toHaveBeenCalled()
    DecisionQueueTestAccess.forgetInMemory()
    await vi.advanceTimersByTimeAsync(UNDO_WINDOW_MS)
    expect(first.post).not.toHaveBeenCalled()
    // The next boot: the row stays hidden while the stored decision goes out, then it is sent once.
    let answer: (v: unknown) => void = () => {}
    const next = makeApi(() => new Promise((r) => (answer = r)))
    const resent = resendStoredDecisions(next.api)
    expect(isDecisionInFlight("approval", "s1")).toBe(true)
    expect(next.post).toHaveBeenCalledTimes(1)
    expect(next.post.mock.calls[0]?.[0]).toBe("/approvals/s1/decide")
    expect(next.post.mock.calls[0]?.[1]).toEqual({ decision: "deny", reason: "" })
    answer({ status: "denied" })
    await resent
    expect(isDecisionInFlight("approval", "s1")).toBe(false)
    expect(localStorage.getItem(STORAGE_KEY)).toBeNull()
  })

  it("keeps a decision stored when the boot resend cannot reach the server", async () => {
    ;(globalThis as Record<string, unknown>)[SERVER_GLOBAL] = "https://a.test"
    localStorage.setItem(STORAGE_KEY, JSON.stringify([stored("n1")]))
    const { api } = makeApi(async () => {
      throw new ApiError("network", 0)
    })
    await resendStoredDecisions(api)
    expect(JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "[]")).toHaveLength(1)
  })

  // Decrypted mail rides the decision and nowhere else.
  it("never stores a decision carrying decrypted mail, and still sends it", async () => {
    const { api, post } = makeApi()
    const mailboxFulfilment = { textBody: "secret plaintext", attachments: [] }
    const done = queueDecision(api, "approval", "m1", {
      decision: "approve",
      mailboxFulfilment,
    })
    expect(isDecisionQueued("approval", "m1")).toBe(true)
    expect(localStorage.getItem(STORAGE_KEY)).toBeNull()
    expect(allStorage()).not.toContain("secret plaintext")
    await vi.advanceTimersByTimeAsync(UNDO_WINDOW_MS)
    await done
    expect(post).toHaveBeenCalledWith(
      "/approvals/m1/decide",
      { decision: "approve", mailboxFulfilment },
      { suppressGlobalError: true },
    )
  })

  it("keeps a decision with decrypted mail out of storage even next to stored ones", async () => {
    const { api } = makeApi()
    void queueDecision(api, "approval", "plain", { decision: "approve" })
    void queueDecision(api, "approval", "m2", {
      decision: "approve",
      mailboxFulfilment: { textBody: "secret plaintext" },
    })
    expect(allStorage()).not.toContain("secret plaintext")
    const raw = localStorage.getItem(STORAGE_KEY) ?? "[]"
    expect(JSON.parse(raw).map((s: { id: string }) => s.id)).toEqual(["plain"])
  })

  // A stored decision belongs to one account on one server.
  it("stores the user and the server with each decision", () => {
    ;(globalThis as Record<string, unknown>)[SERVER_GLOBAL] = "https://a.test"
    const { api } = makeApi()
    void queueDecision(api, "approval", "o1", { decision: "approve" })
    expect(JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "[]")).toEqual([
      expect.objectContaining({ id: "o1", userId: "u-1", origin: "https://a.test" }),
    ])
  })

  it("a stored decision lives 15 minutes: a fresh one is sent at boot, an older one is dropped and its row says it was not sent", async () => {
    expect(STORED_DECISION_MAX_AGE_MS).toBe(15 * 60_000)
    ;(globalThis as Record<string, unknown>)[SERVER_GLOBAL] = "https://a.test"
    const now = Date.now()
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify([
        stored("fresh", { queuedAt: now - STORED_DECISION_MAX_AGE_MS + 1_000 }),
        stored("old", { queuedAt: now - STORED_DECISION_MAX_AGE_MS - 1_000 }),
        stored("future", { queuedAt: now + 60 * 60_000 }),
        stored("undated", { queuedAt: undefined }),
      ]),
    )
    const { api, post } = makeApi()
    await resendStoredDecisions(api)
    expect(post.mock.calls.map((c) => c[0])).toEqual(["/approvals/fresh/decide"])
    expect(localStorage.getItem(STORAGE_KEY)).toBeNull()
    expect(isDecisionNotSent("approval", "fresh")).toBe(false)
    for (const id of ["old", "future", "undated"]) {
      expect(isDecisionNotSent("approval", id)).toBe(true)
    }
    // Deciding again clears the line.
    DecisionQueueTestAccess.setUndoWindow(0)
    await queueDecision(api, "approval", "old", { decision: "approve" })
    expect(isDecisionNotSent("approval", "old")).toBe(false)
  })

  it("discards at boot a decision another account or another server left, sending only this session's", async () => {
    ;(globalThis as Record<string, unknown>)[SERVER_GLOBAL] = "https://a.test"
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify([
        stored("mine"),
        stored("other-user", { userId: "u-2" }),
        stored("other-server", { origin: "https://b.test" }),
        { kind: "approval", id: "legacy", decision: "approve", body: { decision: "approve" } },
      ]),
    )
    const { api, post } = makeApi()
    await resendStoredDecisions(api)
    expect(post.mock.calls.map((c) => c[0])).toEqual(["/approvals/mine/decide"])
    expect(localStorage.getItem(STORAGE_KEY)).toBeNull()
  })

  it("resends nothing, and keeps it stored, while no one is signed in", async () => {
    ;(globalThis as Record<string, unknown>)[SERVER_GLOBAL] = "https://a.test"
    session.userId = null
    localStorage.setItem(STORAGE_KEY, JSON.stringify([stored("w1")]))
    const { api, post } = makeApi()
    await resendStoredDecisions(api)
    expect(post).not.toHaveBeenCalled()
    expect(JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "[]")).toHaveLength(1)
  })

  it("sends what is queued before the sign-out, and the sign-out waits for it", async () => {
    let answer: (v: unknown) => void = () => {}
    const { api, post } = makeApi(() => new Promise((r) => (answer = r)))
    void queueDecision(api, "approval", "s1", { decision: "approve" }).catch(() => {})
    let signedOut = false
    const before = runBeforeSignOut().then(() => (signedOut = true))
    await vi.advanceTimersByTimeAsync(0)
    expect(post).toHaveBeenCalledWith("/approvals/s1/decide", expect.anything(), {
      suppressGlobalError: true,
      keepalive: true,
    })
    expect(signedOut).toBe(false)
    answer({ status: "approved" })
    await before
    expect(signedOut).toBe(true)
  })

  it("lives under the session namespace every sign-out clears", () => {
    const { api } = makeApi()
    void queueDecision(api, "approval", "c1", { decision: "approve" })
    expect(localStorage.getItem(STORAGE_KEY)).not.toBeNull()
    clearLiaisonStorage()
    expect(localStorage.getItem(STORAGE_KEY)).toBeNull()
  })

  it("sends a body over the keepalive cap without keepalive, and keeps it stored until confirmed", async () => {
    const { api, post } = makeApi(async () => {
      throw new ApiError("network", 0)
    })
    const big = "x".repeat(70_000)
    void queueDecision(api, "approval", "k1", { decision: "approve", note: big }).catch(() => {})
    flushDecisions()
    expect(post).toHaveBeenCalledWith("/approvals/k1/decide", expect.anything(), {
      suppressGlobalError: true,
    })
    await vi.advanceTimersByTimeAsync(0)
    expect(JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "[]")).toEqual([
      expect.objectContaining({ id: "k1" }),
    ])
  })

  it("a send the server answered is unstored; a failed one stays for the next boot", async () => {
    const { api } = makeApi(async (path) => {
      if (path === "/approvals/f1/decide") throw new ApiError("gone", 404)
      throw new ApiError("Internal server error", 500)
    })
    const a = queueDecision(api, "approval", "f1", { decision: "approve" }).catch(() => {})
    const b = queueDecision(api, "approval", "f2", { decision: "approve" }).catch(() => {})
    await vi.advanceTimersByTimeAsync(UNDO_WINDOW_MS)
    await Promise.all([a, b])
    expect(
      JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "[]").map((s: { id: string }) => s.id),
    ).toEqual(["f2"])
  })
})

function stored(id: string, over: Record<string, unknown> = {}) {
  return {
    kind: "approval",
    id,
    decision: "approve",
    body: { decision: "approve" },
    queuedAt: Date.now(),
    userId: "u-1",
    origin: "https://a.test",
    ...over,
  }
}

/** Every value this page keeps in localStorage, whatever its key. */
function allStorage(): string {
  const values: string[] = []
  for (let i = 0; i < localStorage.length; i++) {
    const key = localStorage.key(i)
    if (key) values.push(localStorage.getItem(key) ?? "")
  }
  return values.join("\n")
}
