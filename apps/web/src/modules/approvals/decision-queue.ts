// SPDX-License-Identifier: FSL-1.1-ALv2
/**
 * THE ONE PLACE A DECISION IS SENT (approvals and scope requests).
 *
 * Approve and Reject wait out an Undo window before they reach the server,
 * like an email client's send: the card hides at once, a decision toast names
 * what was decided ("Approving in 4s · ticket-10889") and offers Undo for eight
 * seconds, and only then is the decision posted. The same toast then says it
 * is being carried out and that it was; the card stays hidden throughout and
 * comes back only when the decision fails. Undo restores the card and sends
 * nothing. Several decisions group into one toast (DecisionToasts.tsx).
 *
 * The queue is module state, not a component's: a decision survives the card
 * unmounting (route change, Home reload). It is also kept in storage, and
 * flushed at once when the page may be going away (pagehide, the page hidden,
 * the phone app sent to the background) with `fetch` keepalive, so a decision
 * is never lost to a closed tab: anything still stored at the next boot is
 * sent then. A guard test forbids posting to a `/decide` route anywhere else.
 *
 * A decision carrying `mailboxFulfilment` (the mail and attachments the
 * mailbox owner's browser decrypted for a gated send) is NEVER stored: that
 * plaintext travels with the decision and nowhere else. It waits in memory
 * only; a page that dies inside the window loses it and the approval simply
 * stays pending.
 *
 * What is stored belongs to one account on one server: each entry carries the
 * user id and the server origin, and the boot resend sends only those of the
 * session it boots into (any other is discarded). A sign-out sends what is
 * queued first, while the session still authenticates it, and the key lives
 * in the `liaison:` namespace every sign-out (browser and phone) clears.
 * Fetch keepalive caps a body at 64 KB, so a larger one is sent without it;
 * either way an entry stays stored until the server has answered it.
 */
import { createSignal } from "solid-js"
import type { ApiClient } from "~/lib/api-client"
import { ApiError } from "~/lib/api-error"
import { absoluteApiBase } from "~/lib/env"
import { onBeforeSignOut, onSessionTeardown } from "~/lib/session-lifecycle"
import { postDecision } from "~/modules/approvals/decide-error"
import { userFromToken } from "~/modules/auth/auth-store"
import { tNow } from "~/modules/i18n/i18n-context"

export const UNDO_WINDOW_MS = 8_000
let undoWindowMs = UNDO_WINDOW_MS

const STORAGE_KEY = "liaison:pendingDecisions.v1"
/** Under fetch keepalive's 64 KB body cap, with room for the headers. */
const KEEPALIVE_BODY_LIMIT = 60_000

export type DecisionKind = "approval" | "scope-request"

interface StoredDecision {
  kind: DecisionKind
  id: string
  decision: "approve" | "deny"
  body: Record<string, unknown>
  queuedAt: number
  /** The account that decided, and the server it decided on. */
  userId: string | null
  origin: string
}

/** What the decision toast names: the row's own title, and what the action does. */
export interface DecisionLabel {
  title: string
  detail?: string | null
  /**
   * A sequence: every step's name, in the order they run. The title is then
   * the sequence's outcome, and the one decision (and its one Undo) covers
   * every step: nothing has run while the Undo window is open.
   */
  steps?: string[] | null
}

/** One decision as the toast shows it: waiting out its window, being sent, or done. */
export interface DecisionToastItem {
  key: string
  kind: DecisionKind
  id: string
  decision: "approve" | "deny"
  label: DecisionLabel | null
  phase: "queued" | "sending" | "done"
  queuedAt: number
  windowMs: number
}

/** How long a done decision stays in the toast before it leaves. */
export const DONE_LINGER_MS = 1_800

interface Entry {
  item: StoredDecision
  api: ApiClient
  label: DecisionLabel | null
  windowMs: number
  timer: ReturnType<typeof setTimeout> | null
  sending: boolean
  resolve: (value: unknown) => void
  reject: (err: unknown) => void
}

/** The caller's await rejects with this when the person pressed Undo. */
export class DecisionUndoneError extends Error {
  constructor() {
    super("decision undone")
    this.name = "DecisionUndoneError"
  }
}

export function isDecisionUndone(err: unknown): err is DecisionUndoneError {
  return err instanceof DecisionUndoneError
}

const keyOf = (kind: DecisionKind, id: string): string => `${kind}:${id}`
const pathOf = (item: { kind: DecisionKind; id: string }): string =>
  item.kind === "approval" ? `/approvals/${item.id}/decide` : `/scope-requests/${item.id}/decide`

const entries = new Map<string, Entry>()
const [queuedKeys, setQueuedKeys] = createSignal<ReadonlySet<string>>(new Set())
const [inFlightKeys, setInFlightKeys] = createSignal<ReadonlySet<string>>(new Set())
/** Decisions done and still shown in the toast for a moment, by key. */
const doneItems = new Map<string, DecisionToastItem>()
const doneTimers = new Map<string, ReturnType<typeof setTimeout>>()
const [toastItems, setToastItems] = createSignal<readonly DecisionToastItem[]>([])

function syncQueued(): void {
  setQueuedKeys(new Set([...entries].filter(([, e]) => !e.sending).map(([k]) => k)))
  // A done decision still counts: the row must not flash back between the
  // server's answer and the feed dropping it.
  setInFlightKeys(new Set([...entries.keys(), ...doneItems.keys()]))
  const live: DecisionToastItem[] = [...entries].map(([key, e]) => ({
    key,
    kind: e.item.kind,
    id: e.item.id,
    decision: e.item.decision,
    label: e.label,
    phase: e.sending ? "sending" : "queued",
    queuedAt: e.item.queuedAt,
    windowMs: e.windowMs,
  }))
  setToastItems(
    [...live, ...doneItems.values()].sort(
      (a, b) => a.queuedAt - b.queuedAt || (a.key < b.key ? -1 : 1),
    ),
  )
}

/** Reactive: a decision on this item is waiting out its Undo window. */
export function isDecisionQueued(kind: DecisionKind, id: string): boolean {
  return queuedKeys().has(keyOf(kind, id))
}

/**
 * Reactive: a decision on this item is waiting out its window OR being sent. A
 * Home row stays hidden for all of it (the toast shows the progress) and comes
 * back only when the decision failed.
 */
export function isDecisionInFlight(kind: DecisionKind, id: string): boolean {
  return inFlightKeys().has(keyOf(kind, id))
}

/** Reactive: what the decision toast shows, oldest first. */
export const decisionToastItems = toastItems

/** A decision that landed stays in the toast as done for a moment, then leaves. */
function showDone(key: string, entry: Entry): void {
  doneItems.set(key, {
    key,
    kind: entry.item.kind,
    id: entry.item.id,
    decision: entry.item.decision,
    label: entry.label,
    phase: "done",
    queuedAt: entry.item.queuedAt,
    windowMs: entry.windowMs,
  })
  const prior = doneTimers.get(key)
  if (prior) clearTimeout(prior)
  doneTimers.set(
    key,
    setTimeout(() => {
      doneTimers.delete(key)
      doneItems.delete(key)
      syncQueued()
    }, DONE_LINGER_MS),
  )
}

function readStored(): StoredDecision[] {
  try {
    const raw = globalThis.localStorage?.getItem(STORAGE_KEY)
    const parsed: unknown = raw ? JSON.parse(raw) : []
    return Array.isArray(parsed) ? (parsed as StoredDecision[]) : []
  } catch {
    return []
  }
}

function writeStored(items: StoredDecision[]): void {
  try {
    if (items.length === 0) globalThis.localStorage?.removeItem(STORAGE_KEY)
    else globalThis.localStorage?.setItem(STORAGE_KEY, JSON.stringify(items))
  } catch {
    // Storage refused (private mode): the in-memory queue still sends.
  }
}

/** The server this page talks to, as an origin. */
function serverOrigin(): string {
  try {
    return new URL(absoluteApiBase()).origin
  } catch {
    return ""
  }
}

/** Decrypted mail never reaches storage, nor does a decision with no account. */
function mayStore(item: StoredDecision): boolean {
  return item.userId !== null && !("mailboxFulfilment" in item.body)
}

/** The server answered: the decision landed or was refused for good. */
function serverAnswered(err: unknown): boolean {
  return err instanceof ApiError && err.status >= 400 && err.status < 500 && err.status !== 401
}

function bodyBytes(body: unknown): number {
  try {
    return new TextEncoder().encode(JSON.stringify(body)).length
  } catch {
    return Number.POSITIVE_INFINITY
  }
}

function store(item: StoredDecision): void {
  if (!mayStore(item)) return
  writeStored([
    ...readStored().filter((s) => keyOf(s.kind, s.id) !== keyOf(item.kind, item.id)),
    item,
  ])
}

function unstore(kind: DecisionKind, id: string): void {
  writeStored(readStored().filter((s) => keyOf(s.kind, s.id) !== keyOf(kind, id)))
}

async function send(key: string, keepalive: boolean): Promise<void> {
  const entry = entries.get(key)
  if (!entry || entry.sending) return
  entry.sending = true
  syncQueued()
  if (entry.timer) clearTimeout(entry.timer)
  entry.timer = null
  try {
    const result = await postDecision(entry.api, pathOf(entry.item), entry.item.body, {
      keepalive: keepalive && bodyBytes(entry.item.body) <= KEEPALIVE_BODY_LIMIT,
    })
    unstore(entry.item.kind, entry.item.id)
    showDone(key, entry)
    entry.resolve(result)
  } catch (err) {
    // Unstored only once the server has answered; a failed send stays for
    // the next boot. It leaves the toast at once: the surface that decided
    // shows why it failed and puts the item back.
    if (serverAnswered(err)) unstore(entry.item.kind, entry.item.id)
    entry.reject(err)
  } finally {
    entries.delete(key)
    syncQueued()
  }
}

/**
 * Queue a decision behind the Undo window. Resolves with the server's answer
 * once it is sent, rejects with the server's error, or with
 * {@link DecisionUndoneError} when the person pressed Undo.
 */
export function queueDecision<T>(
  api: ApiClient,
  kind: DecisionKind,
  id: string,
  body: { decision: "approve" | "deny" } & Record<string, unknown>,
  opts: { label?: DecisionLabel | null } = {},
): Promise<T> {
  const key = keyOf(kind, id)
  if (entries.has(key)) return Promise.reject(new Error(`a decision on ${key} is already queued`))
  const item: StoredDecision = {
    kind,
    id,
    decision: body.decision,
    body,
    queuedAt: Date.now(),
    userId: userFromToken()?.userId ?? null,
    origin: serverOrigin(),
  }
  return new Promise<T>((resolve, reject) => {
    const entry: Entry = {
      item,
      api,
      label: opts.label ?? {
        title: tNow(
          kind === "approval"
            ? "kernel.decisionToast.approvalFallback"
            : "kernel.decisionToast.scopeRequestFallback",
        ),
      },
      windowMs: undoWindowMs,
      timer: null,
      sending: false,
      resolve: resolve as (value: unknown) => void,
      reject,
    }
    // A decision on an item that was just done replaces its done line.
    doneItems.delete(key)
    entries.set(key, entry)
    syncQueued()
    store(item)
    if (undoWindowMs <= 0) void send(key, false)
    else entry.timer = setTimeout(() => void send(key, false), undoWindowMs)
  })
}

/** Undo a decision still inside its window: nothing is sent. False once it has gone. */
export function undoDecision(kind: DecisionKind, id: string): boolean {
  const key = keyOf(kind, id)
  const entry = entries.get(key)
  if (!entry || entry.sending) return false
  if (entry.timer) clearTimeout(entry.timer)
  entries.delete(key)
  unstore(kind, id)
  syncQueued()
  entry.reject(new DecisionUndoneError())
  return true
}

/** Send every queued decision now, with keepalive: the page may be going away. */
export function flushDecisions(): Promise<void> {
  return Promise.all([...entries.keys()].map((key) => send(key, true))).then(() => undefined)
}

interface CapacitorAppPlugin {
  addListener: (
    event: "appStateChange",
    handler: (state: { isActive: boolean }) => void,
  ) => Promise<{ remove: () => void }> | { remove: () => void }
}

/** The phone shell's App plugin, reachable from the web view when it is installed. */
function capacitorApp(): CapacitorAppPlugin | null {
  const cap = (globalThis as { Capacitor?: { Plugins?: { App?: unknown } } }).Capacitor
  const app = cap?.Plugins?.App as Partial<CapacitorAppPlugin> | undefined
  return app && typeof app.addListener === "function" ? (app as CapacitorAppPlugin) : null
}

/**
 * Flush when the page may be going away: pagehide, the page hidden (tab
 * switch, the phone locked), and the phone app leaving the foreground. Once,
 * at startup. Returns its own teardown.
 */
export function installDecisionFlush(): () => void {
  if (typeof window === "undefined") return () => {}
  const onPageHide = () => void flushDecisions()
  const onVisibility = () => {
    if (document.visibilityState === "hidden") void flushDecisions()
  }
  window.addEventListener("pagehide", onPageHide)
  document.addEventListener("visibilitychange", onVisibility)
  let removeAppListener: (() => void) | null = null
  const app = capacitorApp()
  if (app) {
    void Promise.resolve(
      app.addListener("appStateChange", (state) => {
        if (!state.isActive) void flushDecisions()
      }),
    ).then((handle) => {
      removeAppListener = () => handle.remove()
    })
  }
  return () => {
    window.removeEventListener("pagehide", onPageHide)
    document.removeEventListener("visibilitychange", onVisibility)
    removeAppListener?.()
  }
}

/**
 * At boot: send every decision a previous page queued but may not have
 * delivered (the tab closed inside the window, or the keepalive send never
 * came back). One the server already has answers 409 (decided) or 404
 * (gone): that is the decision having landed, not a failure. Only the
 * decisions of the session it boots into are sent: one another account or
 * another server left is discarded. With no one signed in yet, it waits.
 */
let resending = false
export async function resendStoredDecisions(api: ApiClient): Promise<void> {
  const userId = userFromToken()?.userId
  if (!userId || resending) return
  resending = true
  try {
    const origin = serverOrigin()
    for (const item of readStored()) {
      if (entries.has(keyOf(item.kind, item.id))) continue
      if (item.userId !== userId || item.origin !== origin || !mayStore(item)) {
        unstore(item.kind, item.id)
        continue
      }
      try {
        await postDecision(api, pathOf(item), item.body)
        unstore(item.kind, item.id)
      } catch (err) {
        if (serverAnswered(err)) unstore(item.kind, item.id)
        // A network failure or a server fault keeps it stored for the next boot.
      }
    }
  } finally {
    resending = false
  }
}

// A sign-out sends what this account queued FIRST, while the session still
// authenticates it (createAuthManager and the phone's sign-out both run this
// before signing out).
onBeforeSignOut(() => flushDecisions())

// And leaves nothing stored for whoever signs in next on this device.
onSessionTeardown(() => {
  void flushDecisions()
  writeStored([])
})

/** Test seams on the queue's private state. */
export const DecisionQueueTestAccess = {
  /**
   * Tests of a surface's own decide wiring (which endpoint, which payload) set
   * the window to 0; the window itself is covered by decision-queue.test.ts.
   */
  setUndoWindow(ms: number): void {
    undoWindowMs = ms
  },
  /** Forget every queued decision without sending. */
  reset(): void {
    undoWindowMs = UNDO_WINDOW_MS
    for (const entry of entries.values()) if (entry.timer) clearTimeout(entry.timer)
    entries.clear()
    for (const timer of doneTimers.values()) clearTimeout(timer)
    doneTimers.clear()
    doneItems.clear()
    writeStored([])
    syncQueued()
  },
}
